// X adapter: drives an owned browser session in the operator's browser. X's own scheduling is a paid feature,
// so Carl owns scheduling. Text is pasted, then the composer is read back and must hold exactly that text (X's editor
// can double an insert); the signed-in account must be the configured one; a record that a click is under way is written
// before Post is clicked; and the live URL is found on the profile (full text, fresh, newer than the previous post)
// before anything is recorded. A failure after the click is never retried.
import type { AdapterContext, DraftContent, DryRunReport, PostAccount, PostAdapter, PostRun, Rendered, Runner } from "../types.ts";
import { BAD_CHARS, visible } from "../draft.ts";
import { PostError } from "../types.ts";

const LIMIT = 280;
const WEIGHTED_URL = 23; // X counts every URL as 23 characters
const BOX = "[data-testid=tweetTextarea_0][role=textbox]";
const HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const TWITTER_EPOCH = 1288834974657;
/** Slack between this machine's clock and X's snowflake clock when bounding "not older than the click". */
const SKEW_MS = 120_000;

/** X's weighted length: URLs count 23, characters outside the Latin ranges (CJK, emoji) count 2. */
export function xLength(text: string): number {
  let n = 0;
  for (const ch of text.normalize("NFC").replace(/https?:\/\/\S+/g, "\u0001".repeat(WEIGHTED_URL))) {
    const cp = ch.codePointAt(0)!;
    n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
  }
  return n;
}

/** The account handle from the profile URL (https, an X host), or throws. */
export function xHandle(profile: string): { handle: string; origin: string } {
  let u: URL;
  try { u = new URL(profile); } catch { throw new PostError(`profile "${profile}" is not a URL`, true); }
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) throw new PostError(`profile "${profile}" must be an https://x.com/<handle> URL`, true);
  const handle = u.pathname.split("/").filter(Boolean)[0] ?? "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new PostError(`profile "${profile}" must look like https://x.com/<handle>`, true);
  return { handle, origin: u.origin };
}

/** A status id from a URL of this account (`/<handle>/status/<id>`), or undefined. */
export function statusId(url: string, handle: string): bigint | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) return undefined;
  const m = u.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)\/?$/);
  return m && m[1].toLowerCase() === handle.toLowerCase() ? BigInt(m[2]) : undefined;
}
/** When X created a status, from its snowflake id. */
export const statusTime = (id: bigint) => Number(id >> 22n) + TWITTER_EPOCH;

/** A domain written without a scheme: X turns it into a link (so the live text reads URL) while the draft keeps it literal, and a live post could never be matched. */
const BARE_DOMAIN = /(?<![@\w./-])(?:[a-z0-9-]+\.)+(?:com|org|net|io|co|ai|app|dev|me|us|uk|ly|gg|tv|to|sh|xyz|info|biz|edu|gov|de|fr|es|ca|au|nl|ru|jp|cn|in|br|ch|se|no|it|eu|so|fm|cc|ink|page|link|site|online|store|tech)\b/i;
export const bareDomain = (text: string): string | undefined => text.replace(/https?:\/\/\S+/gi, " ").match(BARE_DOMAIN)?.[0];

/** Text as compared: whitespace collapsed, every link as URL. The page script produces the same form from the DOM. */
export const normText = (s: string) => s.replace(/https?:\/\/\S*[^\s.,;:!?)\]'"]/g, "URL").replace(/\s+/g, " ").trim();

export interface Candidate { url: string; text: string }

/**
 * The one post on the page that is this part, or undefined. All of these must hold: the whole normalised text is equal
 * (not a prefix); the status is the account's own; it is not one already recorded; its id is newer than the previous part
 * and than anything on the page before the click; X created it no earlier than `notBefore`. Two matches are an error.
 */
export function pickPart(cands: Candidate[], text: string, handle: string, o: { urls: string[]; prevId: bigint; baseline?: bigint; notBefore: number }): string | undefined {
  const want = normText(text);
  const hits = new Set<string>();
  for (const c of cands) {
    if (normText(c.text) !== want || o.urls.includes(c.url)) continue;
    const id = statusId(c.url, handle);
    if (id === undefined || id <= o.prevId || (o.baseline !== undefined && id <= o.baseline) || statusTime(id) < o.notBefore) continue;
    hits.add(c.url);
  }
  if (hits.size > 1) throw new PostError(`more than one fresh post on the profile has this exact text (${[...hits].join(", ")}); check the profile`, true);
  return [...hits][0];
}

/** The text of a node as the page shows it: emoji are images, so their alt text is restored; links are URL. */
export const PAGE_TEXT = `function pageText(n) {
  if (n.nodeType === 3) return n.textContent;
  if (n.nodeType !== 1) return '';
  const tag = n.tagName;
  if (tag === 'IMG') return n.getAttribute('alt') || '';
  if (tag === 'BR') return ' ';
  if (tag === 'A') { const t = n.textContent || ''; return /^[@#$]/.test(t) ? t : 'URL'; }
  let out = ''; for (const c of n.childNodes) out += pageText(c);
  return out;
}`;

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

const CLICK = (text: string) => `(async () => {
  const el = document.querySelector(${JSON.stringify(BOX)});
  if (!el) return JSON.stringify({error: 'composer gone before the click'});
  const norm = (s) => s.replace(/\\r/g, '').replace(/\\n+/g, '\\n').trim();
  if (norm(el.innerText) !== norm(${JSON.stringify(text)})) return JSON.stringify({error: 'composer text changed before the click'});
  let scope = el; let button = null;
  while (scope && !button) { scope = scope.parentElement; button = scope && scope.querySelector('[data-testid=tweetButton],[data-testid=tweetButtonInline]'); }
  if (!button) return JSON.stringify({error: 'post button not found'});
  if (button.getAttribute('aria-disabled') === 'true') return JSON.stringify({error: 'post button disabled'});
  button.click();
  return JSON.stringify({clicked: button.innerText});
})()`;

/** The signed-in account's profile link (the left menu), after waiting for the page to draw it. */
const WHO = () => `(async () => {
  const wait = (ms) => new Promise((f) => setTimeout(f, ms));
  for (let i = 0; i < 80 && !document.querySelector('[data-testid=AppTabBar_Profile_Link]'); i++) await wait(250);
  const a = document.querySelector('[data-testid=AppTabBar_Profile_Link]');
  return JSON.stringify({href: a ? a.getAttribute('href') : null});
})()`;

/** Every post on the page as {url, text}. The matching is done by the caller; `want` only ends the wait early. */
const LIST = (handle: string, want: string | null, tries: number) => `(async () => {
  const wait = (ms) => new Promise((f) => setTimeout(f, ms));
  ${PAGE_TEXT}
  const norm = (s) => s.replace(/https?:\\/\\/\\S*[^\\s.,;:!?)\\]'"]/g, 'URL').replace(/\\s+/g, ' ').trim();
  const want = ${JSON.stringify(want)};
  const own = new RegExp('/${handle}/status/\\\\d+$', 'i');
  const read = () => {
    const out = [];
    for (const article of document.querySelectorAll('article')) {
      const t = article.querySelector('[data-testid=tweetText]');
      if (!t) continue;
      const link = [...article.querySelectorAll('a[href*="/status/"]')].map((a) => a.href).find((h) => own.test(h));
      if (link) out.push({url: link, text: norm(pageText(t))});
    }
    return out;
  };
  for (let i = 0; i < ${tries}; i++) {
    const list = read();
    if (want === null ? list.length : list.some((c) => c.text === norm(want))) return JSON.stringify({items: list, empty: false});
    if (!list.length && document.querySelector('[data-testid="emptyState"]')) return JSON.stringify({items: [], empty: true});
    await wait(500);
  }
  return JSON.stringify({items: read(), empty: false});
})()`;

/** One browser-session call. The CLI's own request deadline is shorter than X's slow page loads, so --timeout is explicit. */
async function browser(ctx: AdapterContext, session: string, args: string[], timeoutSeconds = ctx.account.session.timeoutSeconds): Promise<any> {
  const r = await ctx.run(ctx.account.session.command, ["--session", session, "--timeout", String(timeoutSeconds), ...args, "--json"], { timeoutMs: (timeoutSeconds + 15) * 1000 });
  let data: any;
  try { data = JSON.parse(r.stdout || "{}"); } catch {
    throw new PostError(`browser session ${args[0]} returned non-JSON: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
  }
  if (!data?.ok) throw new PostError(`browser session ${args[0]} failed: ${JSON.stringify(data?.error ?? data).slice(0, 400)}${r.code === 127 ? ` (${r.stderr})` : ""}`);
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

/** The browser must be signed in to the configured account. A final refusal, before anything is filled. */
async function requireAccount(ctx: AdapterContext, session: string, handle: string, origin: string): Promise<void> {
  await browser(ctx, session, ["navigate", `${origin}/home`]);
  const r = await js(ctx, session, WHO());
  const href = r && typeof r === "object" && typeof r.href === "string" ? r.href : "";
  // No profile link drawn in time is a slow or logged-out page, not a different account: retryable. A different handle is final.
  if (!href) throw new PostError(`the page did not show the signed-in account's profile link in time; nothing was posted (not a different account). Is the browser signed in to @${handle}?`);
  let path = "";
  try { path = new URL(href, origin).pathname.replace(/\/+$/, ""); } catch {}
  if (path.toLowerCase() !== `/${handle}`.toLowerCase()) {
    throw new PostError(`the browser is not signed in to @${handle} (its profile link is ${JSON.stringify(href || null)}); nothing was posted. Sign in to the right account and run it again`, true);
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

async function click(ctx: AdapterContext, session: string, text: string, what: string): Promise<void> {
  const r = await js(ctx, session, CLICK(text));
  if (!r || typeof r !== "object" || r.error) throw new PostError(`could not post ${what}: ${JSON.stringify(r)}`);
}

/** Open a timeline page and read the posts on it. */
async function list(ctx: AdapterContext, session: string, handle: string, page: string, want: string | null, tries: number): Promise<Candidate[]> {
  return (await timelineOf(ctx, session, handle, page, want, tries)).items;
}

/** The posts on a page, and whether the page showed X's own "nothing here" state (an empty profile), as opposed to not drawing in time. */
async function timelineOf(ctx: AdapterContext, session: string, handle: string, page: string, want: string | null, tries: number): Promise<{ items: Candidate[]; empty: boolean }> {
  await browser(ctx, session, ["navigate", page]);
  const r = await js(ctx, session, LIST(handle, want, tries));
  const raw = Array.isArray(r) ? r : r && typeof r === "object" && Array.isArray(r.items) ? r.items : [];
  return { items: raw.filter((c: any) => c && typeof c.url === "string" && typeof c.text === "string"), empty: !!(r && typeof r === "object" && !Array.isArray(r) && r.empty === true) };
}

const newestId = (cands: Candidate[], handle: string) => cands.reduce<bigint | undefined>((m, c) => { const id = statusId(c.url, handle); return id !== undefined && (m === undefined || id > m) ? id : m; }, undefined);

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
      if (BAD_CHARS.test(t)) problems.push(`part ${i + 1} contains control or bidirectional characters (${visible(t).match(/\\u[0-9a-f]{4}/g)?.slice(0, 3).join(" ")}); a terminal could show different text from what is posted`);
      const bare = bareDomain(t);
      if (bare) problems.push(`part ${i + 1} has a link without a scheme (${bare}); X turns it into a link that Carl could not match on the profile. Write it as https://${bare}`);
      if (sizes[i] > LIMIT) problems.push(`${content.isThread ? `thread part ${i + 1}` : i === 0 ? "the post" : "the first reply"} is ${sizes[i]} characters (limit ${LIMIT})`);
    });
    return { sequence, sizes, problems };
  },

  async dryRun(ctx, rendered): Promise<DryRunReport> {
    const lines: string[] = [];
    const { handle, origin } = xHandle(ctx.account.profile);
    await withSession(ctx, async (session) => {
      await requireAccount(ctx, session, handle, origin);
      lines.push(`signed in as @${handle}`);
      await browser(ctx, session, ["navigate", `${origin}/compose/post`]);
      for (const [i, text] of rendered.sequence.entries()) {
        await fill(ctx, session, text);
        lines.push(`part ${i + 1}/${rendered.sequence.length}: composer holds the exact text (${rendered.sizes[i]} chars)`);
      }
    });
    lines.push("nothing posted");
    return { ok: true, lines };
  },

  checkLiveUrl(account, url, done) {
    const { handle, origin } = xHandle(account.profile);
    const id = statusId(url, handle);
    if (id === undefined) return `${JSON.stringify(url)} is not ${origin}/${handle}/status/<id>`;
    if (done.includes(url)) return "that URL is already recorded";
    const last = done.length ? statusId(done[done.length - 1], handle) : undefined;
    if (last !== undefined && id <= last) return "that status is not newer than the part before it (a thread's parts are posted in order)";
    return undefined;
  },

  async post(ctx, rendered, run: PostRun) {
    const { handle, origin } = xHandle(ctx.account.profile);
    const seq = rendered.sequence;
    const urls = [...run.done];
    // The recorded URLs are the parents of what comes next: each must be this account's own status, once.
    for (const u of urls) if (statusId(u, handle) === undefined) throw new PostError(`recorded URL ${JSON.stringify(u)} is not ${origin}/${handle}/status/<id>; refusing to reply to it`, true);
    if (new Set(urls).size !== urls.length) throw new PostError("the recorded URLs contain a duplicate; refusing to continue the thread", true);
    for (let i = 1; i < urls.length; i++) if (statusId(urls[i], handle)! <= statusId(urls[i - 1], handle)!) throw new PostError("the recorded URLs are not in posting order; refusing to continue the thread", true);
    if (urls.length >= seq.length) throw new PostError("every part is already posted", true);
    if (run.pending && run.pending.part !== urls.length) throw new PostError(`pending_part ${run.pending.part + 1} does not match the ${urls.length} part(s) recorded live; check the profile, then run \`carl post clear-pending\``, true);
    const timelineUrl = `${origin}/${handle}/with_replies`;
    return withSession(ctx, async (session) => {
      await requireAccount(ctx, session, handle, origin);
      for (let i = urls.length; i < seq.length; i++) {
        const text = seq[i];
        const prevId = urls.length ? statusId(urls[urls.length - 1], handle)! : 0n;
        if (run.pending?.part === i) {
          // A click on this part was started and not recorded. Look, never click.
          const cands = await list(ctx, session, handle, timelineUrl, text, 8);
          // With the baseline recorded before the click the clocks do not matter; without one, no earlier than the click (with slack).
          const baseline = run.pending.baseline ? BigInt(run.pending.baseline) : undefined;
          const notBefore = baseline !== undefined ? run.approvedAtMs - SKEW_MS : Math.max(run.approvedAtMs, run.pending.atMs) - SKEW_MS;
          const hit = pickPart(cands, text, handle, { urls, prevId, baseline, notBefore });
          if (!hit) throw new PostError(`part ${i + 1} was being posted when the last run stopped and is not on the profile (or not as the exact text). It may still appear: check @${handle}'s profile, and when part ${i + 1} is certainly not live run \`carl post clear-pending\` on the draft. Nothing was clicked`, true);
          urls.push(hit);
          try { await run.onPart([...urls]); } catch (e) { throw postClick(e, i); }
          continue;
        }
        // The exact text as `want`: the wait runs its full length, so a pinned post alone cannot end it early. An unreadable
        // (empty, not-drawn) timeline is a retryable refusal: only X's own empty-profile state lets a click go ahead on no posts.
        const look = await timelineOf(ctx, session, handle, timelineUrl, text, 20);
        const seen = look.items;
        if (!seen.length && !look.empty) throw new PostError(`part ${i + 1}: the profile timeline of @${handle} did not draw, so Carl cannot rule out that the text is already live; nothing was clicked. It will be tried again`);
        // Already on the profile (a mistaken `clear-pending`, a post made by hand): never click a second time.
        const already = pickPart(seen, text, handle, { urls, prevId, notBefore: run.approvedAtMs - SKEW_MS });
        if (already) throw new PostError(`part ${i + 1} is already live at ${already} (the exact text is on @${handle}'s profile, posted after the approval); nothing was clicked. Record it with \`carl post record-live\` on the draft`, true);
        const before = newestId(seen, handle);
        const baseline = before !== undefined && before > prevId ? before : prevId;
        if (i === 0) await browser(ctx, session, ["navigate", `${origin}/compose/post`]);
        else await browser(ctx, session, ["navigate", urls[i - 1]]);
        await fill(ctx, session, text);
        await run.onBeforeClick(i, baseline.toString()); // write-ahead: if this fails nothing is clicked
        try {
          await click(ctx, session, text, `part ${i + 1}`);
          await ctx.sleep(4000);
          let hit: string | undefined;
          for (let attempt = 0; attempt < 2 && !hit; attempt++) {
            hit = pickPart(await list(ctx, session, handle, timelineUrl, text, 40), text, handle, { urls, prevId, baseline, notBefore: run.approvedAtMs - SKEW_MS });
            if (!hit && attempt === 0) await ctx.sleep(5000);
          }
          if (!hit) throw new PostError(`part ${i + 1} was probably posted, but its exact text could not be found as a new post on ${timelineUrl}`);
          urls.push(hit);
          await run.onPart([...urls]);
        } catch (e) {
          throw postClick(e, i);
        }
      }
      return urls;
    });
  },
};

/** Any failure from the click on is final: the part may be live, so nothing retries it. */
function postClick(e: unknown, part: number): PostError {
  const msg = (e as Error).message;
  return new PostError(`${msg}\n  Part ${part + 1} may be live. Check the profile; the draft keeps a pending_part record, so a rerun only looks for it and never clicks again until you clear it with \`carl post clear-pending\`.`, true);
}

export type { Runner };
