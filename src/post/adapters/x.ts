// X adapter: drives an owned overseer-browser session in the operator's browser. X's own scheduling is a paid feature,
// so Carl owns scheduling. Text is pasted, then the composer is read back and must hold exactly that text (X's editor
// can double an insert); Post is clicked; the live URL is found on the profile before anything is recorded.
import type { AdapterContext, DraftContent, DryRunReport, PostAccount, PostAdapter, Rendered, Runner } from "../types.ts";
import { PostError } from "../types.ts";

const LIMIT = 280;
const WEIGHTED_URL = 23; // X counts every URL as 23 characters
const BOX = "[data-testid=tweetTextarea_0][role=textbox]";

export function xLength(text: string): number {
  return [...text.replace(/https?:\/\/\S+/g, "x".repeat(WEIGHTED_URL))].length;
}

/** The account handle from the profile URL, or throws. */
export function xHandle(profile: string): { handle: string; origin: string } {
  let u: URL;
  try { u = new URL(profile); } catch { throw new PostError(`profile "${profile}" is not a URL`, true); }
  const handle = u.pathname.split("/").filter(Boolean)[0] ?? "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new PostError(`profile "${profile}" must look like https://x.com/<handle>`, true);
  return { handle, origin: u.origin };
}

const FILL = (text: string) => `(async () => {
  const wait = (ms) => new Promise((f) => setTimeout(f, ms));
  for (let i = 0; i < 40 && !document.querySelector(${JSON.stringify(BOX)}); i++) await wait(250);
  const el = document.querySelector(${JSON.stringify(BOX)});
  if (!el) return JSON.stringify({error: 'composer not found'});
  el.focus();
  const sel = getSelection(); const range = document.createRange();
  range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
  el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
  el.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true, key: 'Shift'}));
  await wait(100);
  const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  await wait(400);
  let scope = el; let button = null;
  while (scope && !button) { scope = scope.parentElement; button = scope && scope.querySelector('[data-testid=tweetButton],[data-testid=tweetButtonInline]'); }
  return JSON.stringify({text: document.querySelector(${JSON.stringify(BOX)}).innerText,
    button: button ? {label: button.innerText, disabled: button.getAttribute('aria-disabled') === 'true' || button.disabled} : null});
})()`;

const CLICK = () => `(async () => {
  const el = document.querySelector(${JSON.stringify(BOX)});
  let scope = el; let button = null;
  while (scope && !button) { scope = scope.parentElement; button = scope && scope.querySelector('[data-testid=tweetButton],[data-testid=tweetButtonInline]'); }
  if (!button) return JSON.stringify({error: 'post button not found'});
  if (button.getAttribute('aria-disabled') === 'true') return JSON.stringify({error: 'post button disabled'});
  button.click();
  return JSON.stringify({clicked: button.innerText});
})()`;

const FIND = (text: string, handle: string, tries: number) => `(async () => {
  const wait = (ms) => new Promise((f) => setTimeout(f, ms));
  const want = ${JSON.stringify(text)}.replace(/\\s+/g, ' ').trim();
  for (let i = 0; i < ${tries}; i++) {
    for (const article of document.querySelectorAll('article')) {
      const t = article.querySelector('[data-testid=tweetText]');
      if (!t) continue;
      const got = t.innerText.replace(/\\s+/g, ' ').trim();
      const short = (s) => s.replace(/https?:\\/\\/\\S+/g, 'URL');
      if (short(got).startsWith(short(want).slice(0, 80))) {
        const link = [...article.querySelectorAll('a[href*="/status/"]')].map((a) => a.href).find((h) => /\\/${handle}\\/status\\/\\d+$/i.test(h));
        if (link) return JSON.stringify({url: link});
      }
    }
    await wait(500);
  }
  return JSON.stringify({error: 'post not found on the page'});
})()`;

/** One overseer-browser call. The CLI's own request deadline is shorter than X's slow page loads, so --timeout is explicit. */
async function browser(ctx: AdapterContext, session: string, args: string[], timeoutSeconds = ctx.account.session.timeoutSeconds): Promise<any> {
  const r = await ctx.run(ctx.account.session.command, ["--session", session, "--timeout", String(timeoutSeconds), ...args, "--json"], { timeoutMs: (timeoutSeconds + 15) * 1000 });
  let data: any;
  try { data = JSON.parse(r.stdout || "{}"); } catch {
    throw new PostError(`overseer-browser ${args[0]} returned non-JSON: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
  }
  if (!data?.ok) throw new PostError(`overseer-browser ${args[0]} failed: ${JSON.stringify(data?.error ?? data).slice(0, 400)}`);
  return data;
}

async function js(ctx: AdapterContext, session: string, source: string): Promise<any> {
  const res = (await browser(ctx, session, ["eval", source], Math.max(120, ctx.account.session.timeoutSeconds))).result;
  if (typeof res === "string" && (res[0] === "[" || res[0] === "{")) {
    try { return JSON.parse(res); } catch { return res; }
  }
  return res;
}

async function withSession<T>(ctx: AdapterContext, fn: (session: string) => Promise<T>): Promise<T> {
  const session = `${ctx.account.session.namePrefix}-${ctx.id()}`;
  await browser(ctx, session, ["sessions", "start", session]);
  try {
    return await fn(session);
  } finally {
    await ctx.run(ctx.account.session.command, ["--session", session, "sessions", "stop", "--json"], { timeoutMs: 60_000 }).catch(() => {});
  }
}

async function fill(ctx: AdapterContext, session: string, text: string): Promise<void> {
  const r = await js(ctx, session, FILL(text));
  if (!r || typeof r !== "object" || r.error) throw new PostError(`could not fill the composer: ${JSON.stringify(r)}`);
  const got = String(r.text ?? "").replace(/\r/g, "");
  // The editor renders a blank line between paragraphs as an extra newline.
  const norm = (s: string) => s.replace(/\n+/g, "\n").trim();
  if (norm(got) !== norm(text)) throw new PostError(`composer text differs from the draft; nothing was posted.\n  expected: ${JSON.stringify(text)}\n  got:      ${JSON.stringify(got)}`, true);
  if (!r.button || r.button.disabled) throw new PostError(`post button unavailable: ${JSON.stringify(r.button)}`);
}

async function click(ctx: AdapterContext, session: string, what: string): Promise<void> {
  const r = await js(ctx, session, CLICK());
  if (!r || typeof r !== "object" || r.error) throw new PostError(`could not post ${what}: ${JSON.stringify(r)}`);
}

/** Find a part on a profile page. `tries` is the in-page wait (each 0.5 s). */
async function findOnPage(ctx: AdapterContext, session: string, text: string, handle: string, page: string, tries: number): Promise<string | undefined> {
  await browser(ctx, session, ["navigate", page]);
  const r = await js(ctx, session, FIND(text, handle, tries));
  return r && typeof r === "object" && typeof r.url === "string" ? r.url : undefined;
}

export const xAdapter: PostAdapter = {
  platform: "x",

  render(content: DraftContent, account: PostAccount): Rendered {
    const problems: string[] = [];
    try { xHandle(account.profile); } catch (e) { problems.push((e as Error).message); }
    const sequence = content.isThread ? content.parts : [...content.parts.slice(0, 1), ...(content.reply ? [content.reply] : [])];
    if (!sequence.length || !sequence[0]?.trim()) problems.push("the draft has no text");
    const sizes = sequence.map(xLength);
    sequence.forEach((t, i) => {
      if (!t.trim()) problems.push(`part ${i + 1} is empty`);
      if (sizes[i] > LIMIT) problems.push(`${content.isThread ? `thread part ${i + 1}` : i === 0 ? "the post" : "the first reply"} is ${sizes[i]} characters (limit ${LIMIT})`);
    });
    return { sequence, sizes, problems };
  },

  async dryRun(ctx, rendered): Promise<DryRunReport> {
    const lines: string[] = [];
    await withSession(ctx, async (session) => {
      await browser(ctx, session, ["navigate", `${xHandle(ctx.account.profile).origin}/compose/post`]);
      for (const [i, text] of rendered.sequence.entries()) {
        await fill(ctx, session, text);
        lines.push(`part ${i + 1}/${rendered.sequence.length}: composer holds the exact text (${rendered.sizes[i]} chars)`);
      }
    });
    lines.push("nothing posted");
    return { ok: true, lines };
  },

  async post(ctx, rendered, done, onPart) {
    const { handle, origin } = xHandle(ctx.account.profile);
    const urls = [...done];
    const seq = rendered.sequence;
    if (urls.length >= seq.length) throw new PostError("every part is already posted", true);
    return withSession(ctx, async (session) => {
      for (let i = urls.length; i < seq.length; i++) {
        const text = seq[i];
        // Idempotency: this part may have gone live in a run that died before recording it. Look first, never repost.
        const hit = await findOnPage(ctx, session, text, handle, `${origin}/${handle}/with_replies`, 8);
        if (hit && !urls.includes(hit)) {
          urls.push(hit);
          await onPart([...urls]);
          continue;
        }
        if (i === 0) {
          await browser(ctx, session, ["navigate", `${origin}/compose/post`]);
        } else {
          await browser(ctx, session, ["navigate", urls[i - 1]]);
        }
        await fill(ctx, session, text);
        await click(ctx, session, `part ${i + 1}`);
        await ctx.sleep(4000);
        const page = i === 0 ? `${origin}/${handle}` : `${origin}/${handle}/with_replies`;
        let url: string | undefined;
        for (let attempt = 0; attempt < 2 && !url; attempt++) {
          url = await findOnPage(ctx, session, text, handle, page, 40);
          if (!url) await ctx.sleep(5000);
        }
        // Never repost: a missing URL stops the run, and the rerun's profile check finds the part.
        if (!url) throw new PostError(`part ${i + 1} was posted, but could not be found on ${page} to record its URL; check the profile before rerunning (a rerun looks there first and will not repost)`);
        urls.push(url);
        await onPart([...urls]);
      }
      return urls;
    });
  },
};

export type { Runner };
