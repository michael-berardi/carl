// The post primitive: contract steps, the approval gate, scheduling with a missed-slot policy, idempotent resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";
import { defaultRegistry } from "../src/post/registry.ts";
import { DraftStore, parseDraft, parseFront, readDraft, setFields, sha256, visible } from "../src/post/draft.ts";
import { browserControlDirs, canon, sessionProblems } from "../src/post/key.ts";
import { sessionPrograms } from "../src/post/key.ts";
import { childEnv, realRunner } from "../src/post/runner.ts";
import { adoptTrustedPath, buildProfile, canonical, secretDirs, secretFiles } from "../src/sandbox.ts";
import { classifyCommand, readVerdict } from "../src/guard.ts";
import { PostService } from "../src/post/service.ts";
import { CardDesk, CardStore, type CardKind } from "../src/post/cards.ts";
import { postCommand, type PostCliIo } from "../src/post/cli.ts";
import { normText, PAGE_TEXT, pickPart, statusTime, xHandle, xLength } from "../src/post/adapters/x.ts";
import { carlTools } from "../src/tools.ts";
import { loadConfig } from "../src/config.ts";
import { postingBlockedReason, readOnlyCache, UNSANDBOXED_TOOLS, writeReadOnlyCache } from "../src/post/safety.ts";
import { DEFAULT_TRUSTED_READONLY, mcpVerdict } from "../src/guard.ts";
import { splitCard } from "../src/channels/telegram.ts";
import { type FakeX, fakeX } from "./post-fake.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} } as any;
const T0 = Date.parse("2026-03-10T12:00:00Z");
const ACCOUNT = { platform: "x", profile: "https://x.com/example", session: { command: "overseer-browser", timeoutSeconds: 75, namePrefix: "carl-post" } };

function rig(opts: { retex?: FakeX["retex"]; now?: number; window?: number; skew?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "carl-post-"));
  process.env.HOME = home;
  const draftsDir = join(home, "posts");
  mkdirSync(draftsDir, { recursive: true });
  const clock = { now: opts.now ?? T0 };
  const x = fakeX({ retex: opts.retex, clock: () => clock.now - (opts.skew ?? 0) }); // skew: X's clock runs behind this machine's
  const scheduler = new Scheduler(home, log, { prompt: async () => "", builtin: {}, deliver: async () => {} } as any);
  const svc = new PostService({
    home, run: x.run, registry: defaultRegistry(), scheduler, now: () => clock.now, sleep: async () => {}, id: () => "t1",
    config: { draftsDir, missedWindowMinutes: opts.window ?? 180, retex: "auto", accounts: { main: ACCOUNT }, agentWritable: [] },
  });
  const write = (name: string, front: string, body = "") => { const p = join(draftsDir, `${name}.md`); writeFileSync(p, `---\nplatform: x\naccount: main\n${front}\n---\n${body}`); return p; };
  return { home, draftsDir, x, clock, scheduler, svc, write };
}
/** What the operator does before anything can post: approve the exact text, and a live dry run of it. */
const approve = async (r: ReturnType<typeof rig>, name: string) => { await r.svc.approve(name, "alice"); await r.svc.dryRun(name); };
const posted = (x: FakeX) => x.live.length;
/** The operator's side: the card a request made is shown, and the operator answers it (as the gateway's Telegram buttons do). */
async function operator(r: ReturnType<typeof rig>, kind: CardKind, name: string, o: { answer?: "approved" | "denied" | "timeout"; url?: string; between?: () => void } = {}) {
  const asked = r.svc.requestCard(kind, name, { by: "operator", url: o.url });
  const shown: string[] = []; const told: string[] = [];
  const desk = new CardDesk(r.svc, (text) => { shown.push(text); o.between?.(); return Promise.resolve({ answer: o.answer ?? "approved", by: "4242" }); }, (m) => told.push(m));
  await desk.pump();
  return { asked, shown, told };
}

test("contract: a draft renders and validates with no side effects, and a dry run fills the composer then posts nothing", async () => {
  const r = rig();
  r.write("one", 'text: "Hello there"\nreply: "More: https://example.org/a/very/long/path/that/counts/as/23"');
  const out = await r.svc.dryRun("one", { offline: true });
  assert.match(out, /sizes 11, /);
  assert.equal(r.x.calls.length, 0, "an offline dry run never touches the platform");
  const live = await r.svc.dryRun("one");
  assert.match(live, /composer holds the exact text/);
  assert.match(live, /nothing posted/);
  assert.deepEqual(r.x.filled, ["Hello there", "More: https://example.org/a/very/long/path/that/counts/as/23"]);
  assert.equal(r.x.clicks, 0);
  assert.equal(posted(r.x), 0);
  // overseer-browser is always told its own deadline, and the session is stopped.
  assert.ok(r.x.calls.some((c) => c.includes("--timeout 75")));
  assert.ok(r.x.calls.some((c) => c.includes("sessions stop")));
  assert.match(out, /approval: not ready/, "a dry run needs no approval and says so");
});

test("contract: validation names every problem (length counts a URL as 23, empty parts, unknown account)", async () => {
  const r = rig();
  assert.equal(xLength("a https://example.org/" + "x".repeat(200)), 2 + 23);
  r.write("long", `text: "${"y".repeat(281)}"`);
  await assert.rejects(r.svc.dryRun("long", { offline: true }), /281 characters \(limit 280\)/);
  r.write("none", 'account: ghost\ntext: "hi"');
  await assert.rejects(r.svc.dryRun("none", { offline: true }), /account "main" is not|account "ghost" is not in carl.json/);
  r.write("empty", "status: Draft");
  await assert.rejects(r.svc.dryRun("empty", { offline: true }), /no text/);
});

test("contract: approve, post, verify the live URL, record the outcome (body sections and front matter both read)", async () => {
  const r = rig();
  const p = r.write("body", "status: Draft", "\n## Post\n\nFirst line.\n\nSecond line.\n\n## First reply\n\nSee the repo.\n");
  assert.equal(readDraft(p).parts[0], "First line.\n\nSecond line.");
  await approve(r, "body");
  const out = await r.svc.postNow("body");
  assert.match(out, /Posted body/);
  const d = readDraft(p);
  assert.equal(d.status, "Posted");
  assert.equal(d.postUrl, r.x.live[0].url);
  assert.deepEqual(d.threadUrls, r.x.live.map((l) => l.url));
  assert.equal(d.threadUrls.length, 2, "the post, then the first reply");
  assert.equal(d.fields.reply_url, r.x.live[1].url);
  assert.match(String(d.fields.posted_at), /^2026-03-10T12:00:00/);
  assert.equal(r.x.live[1].text, "See the repo.");
  await assert.rejects(r.svc.postNow("body"), /already marked Posted/);
  assert.equal(r.x.live.length, 2, "a second attempt posts nothing");
});

test("records go through `retex set --if-hash` when retex is available, else an atomic write", async () => {
  const r = rig({ retex: { hash: "abc123" } });
  const p = r.write("rt", 'text: "via retex"');
  await r.svc.approve("rt", "alice");
  assert.ok(r.x.retexSets.length >= 1);
  const set = r.x.retexSets[0];
  assert.equal(set[set.indexOf("--if-hash") + 1], "abc123");
  assert.ok(set.some((a) => a.startsWith("approved=alice ")));
  assert.ok(set.some((a) => a.startsWith("approved_hash=")));
  assert.doesNotMatch(readFileSync(p, "utf8"), /approved:/, "the fake retex wrote nothing itself");
  const bare = rig();
  const q = bare.write("plain", 'text: "no retex"');
  await bare.svc.approve("plain", "alice");
  assert.match(readFileSync(q, "utf8"), /^approved: alice 2026-03-10T12:00:00\.000Z$/m);
  assert.match(readFileSync(q, "utf8"), /^text: "no retex"$/m, "other lines are untouched");
  assert.equal(setFields("---\na: 1\nb: 2\n---\nbody", { a: "x y", c: "z" }), "---\na: x y\nb: 2\nc: z\n---\nbody");
});

test("approval gate: every refusal, live and scheduled, and nothing reaches the platform", async () => {
  const r = rig();
  const refuse = async (name: string, why: RegExp) => {
    await assert.rejects(r.svc.postNow(name), why, `${name} live`);
    await assert.rejects(r.svc.schedule(name, "2026-03-11T12:00:00Z"), why, `${name} scheduled`);
  };
  r.write("none", 'text: "hello"');
  await refuse("none", /no operator approval/);
  r.write("blank", 'text: "hello"\napproved: "   "');
  await refuse("blank", /no operator approval/);
  r.write("true", 'text: "hello"\napproved: true');
  await refuse("true", /name who and when/);
  r.write("nowho", 'text: "hello"\napproved: 2026-03-10T11:00:00Z');
  await refuse("nowho", /name who and when/);
  r.write("nowhen", 'text: "hello"\napproved: alice');
  await refuse("nowhen", /name who and when/);
  r.write("nohash", 'text: "hello"\napproved: alice 2026-03-10T11:00:00Z');
  await refuse("nohash", /does not record which text/);
  r.write("forged", 'text: "hello"\napproved: alice 2026-03-10T11:00:00Z\napproved_hash: deadbeef');
  await refuse("forged", /edited after it was approved/);
  assert.equal(r.x.calls.length, 0, "no refusal opened a browser");
  assert.equal(r.scheduler.list().length, 0);
});

test("approval gate: an edit after approval, to the text, the reply, the thread or the account, needs fresh approval", async () => {
  const r = rig();
  const p = r.write("edit", 'text: "original"');
  await approve(r, "edit");
  assert.equal(r.svc.problem(readDraft(p)), undefined);
  for (const [from, to] of [['text: "original"', 'text: "changed"'], ['text: "original"', 'text: "original"\nreply: "new reply"'], ['text: "original"', 'thread:\n  - "a"\n  - "b"']] as const) {
    const before = readFileSync(p, "utf8");
    writeFileSync(p, before.replace(from, to));
    assert.match(r.svc.problem(readDraft(p))!, /edited after it was approved/);
    await assert.rejects(r.svc.postNow("edit"), /edited after it was approved/);
    await assert.rejects(r.svc.schedule("edit", "2026-03-11T12:00:00Z"), /edited after it was approved/);
    writeFileSync(p, before);
    assert.equal(r.svc.problem(readDraft(p)), undefined, "restoring the text restores the approval");
  }
  assert.equal(posted(r.x), 0);
  await r.svc.postNow("edit");
  assert.equal(posted(r.x), 1);
});

test("composer text that differs from the draft is refused and nothing is posted", async () => {
  const r = rig();
  r.write("dbl", 'text: "Exactly this"');
  await approve(r, "dbl");
  r.x.mangle = (t) => t + t; // the editor doubled the insert
  await assert.rejects(r.svc.postNow("dbl"), /composer text differs from the draft/);
  assert.equal(r.x.clicks, 0);
  assert.equal(r.x.live.length, 0);
  await assert.rejects(r.svc.dryRun("dbl"), /composer text differs/);
  assert.ok(r.x.calls.some((c) => c.includes("sessions stop")), "the session is stopped after a failure");
  assert.equal(readDraft(join(r.draftsDir, "dbl.md")).status, "Ready");
});

test("a thread that died after a click is final, asks the operator to check, and resumes only by finding the part", async () => {
  const r = rig();
  const p = r.write("thr", 'thread:\n  - "Part one."\n  - "Part two."\n  - "Part three."');
  await approve(r, "thr");
  // Part 2 goes live, then the read that would find its URL fails: the run dies before recording it.
  r.x.failList = (n) => n === 4; // reads: p1 baseline, p1 find, p2 baseline, p2 find (4th)
  await assert.rejects(r.svc.postNow("thr"), (e: any) => e.final === true && /overseer-browser eval failed/.test(e.message) && /Part 2 may be live/.test(e.message));
  assert.deepEqual(r.x.live.map((l) => l.text), ["Part one.", "Part two."]);
  let d = readDraft(p);
  assert.equal(d.threadUrls.length, 1, "only part 1 was recorded");
  assert.equal(d.pendingPart, 1, "the write-ahead record names the part that was clicked");
  assert.equal(d.status, "Ready");
  // The rerun only looks for part 2 (never clicks it), records it, and posts part 3.
  r.x.failList = undefined;
  const out = await r.svc.postNow("thr");
  assert.deepEqual(r.x.live.map((l) => l.text), ["Part one.", "Part two.", "Part three."]);
  assert.equal(r.x.clicks, 3, "each part was clicked exactly once across both runs");
  d = readDraft(p);
  assert.equal(d.status, "Posted");
  assert.equal(d.pendingPart, undefined);
  assert.deepEqual(d.threadUrls, r.x.live.map((l) => l.url));
  assert.match(out, /resumed after 1 part/);
});

test("C1: a click whose post is not found is final, never retried, and a rerun refuses until the operator clears it", async () => {
  const r = rig();
  const p = r.write("miss1", 'text: "Goes live but is not found"');
  await approve(r, "miss1");
  r.x.hideNew = true; // X accepted the click, but the timeline does not show it (an emoji the matcher cannot read, say)
  await assert.rejects(r.svc.postNow("miss1"), (e: any) => e.final === true && /probably posted/.test(e.message));
  assert.equal(r.x.clicks, 1);
  assert.equal(readDraft(p).pendingPart, 0);
  assert.match(readDraft(p).fields.last_error as string, /probably posted/);
  // Reruns (as a scheduler retry or an operator's `now` would) only look; the part is not on the profile: refuse, no click.
  for (let i = 0; i < 3; i++) await assert.rejects(r.svc.postNow("miss1"), (e: any) => e.final === true && /check @example's profile/.test(e.message));
  assert.equal(r.x.clicks, 1, "no rerun clicked again");
  assert.match(r.svc.status(), /PENDING part 1/);
  // Only the operator clears it (after looking). Then it posts again.
  r.x.hideNew = false;
  assert.match((await operator(r, "clear-pending", "miss1")).told.join(), /Cleared the pending record for part 1/);
  assert.equal(readDraft(p).pendingPart, undefined);
  await r.svc.postNow("miss1");
  assert.equal(r.x.clicks, 2);
  // A click call that fails (a timeout) is also final and leaves the record.
  const q = r.write("clk", 'text: "Click times out"');
  await approve(r, "clk");
  r.x.failClick = true;
  await assert.rejects(r.svc.postNow("clk"), (e: any) => e.final === true);
  assert.equal(readDraft(q).pendingPart, 0);
});

test("C1: the write-ahead record is written before the click, and if it cannot be written nothing is clicked", async () => {
  const r = rig();
  const p = r.write("wa", 'text: "Write ahead"');
  await approve(r, "wa");
  const real = r.x.run;
  // The draft changes just before the pending record is written (the compare-and-set refuses), at the moment of the fill.
  const svc = new PostService({ ...r.svc.deps, run: async (cmd, args, o) => {
    const res = await real(cmd, args, o);
    if (args.some((a) => a.includes("composer not found"))) writeFileSync(p, readFileSync(p, "utf8") + "\n");
    return res;
  } });
  await assert.rejects(svc.postNow("wa"), /changed while it was being updated/);
  assert.equal(r.x.clicks, 0);
  assert.equal(r.x.live.length, 0);
});

test("C1 retries: a failure before any click is retried by the scheduler, a failure after it is not", async () => {
  const r = rig();
  r.write("pre", 'text: "Fails before the click"');
  await approve(r, "pre");
  const { job } = await r.svc.schedule("pre", "2026-03-10T14:00:00Z");
  r.clock.now = Date.parse("2026-03-10T14:00:05Z");
  r.x.failList = (n) => n === 1;
  const s = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any, o: any) => r.svc.runScheduled(j, o) }, deliver: async () => {} } as any);
  await s.runNow(job.id);
  assert.equal(s.get(job.id).lastStatus, "error");
  assert.equal(s.get(job.id).noRetry, undefined, "nothing was clicked: retry");
  assert.equal(s.get(job.id).enabled, true);
  assert.equal(r.x.clicks, 0);
  r.x.failList = (n) => n === 3; // the next run: baseline (1) is read, click, then the find (2) ... fails on the 3rd read
  r.x.hideNew = true;
  await s.runNow(job.id);
  assert.equal(s.get(job.id).noRetry, true, "a click happened: final");
  assert.equal(s.get(job.id).enabled, false);
  assert.equal(r.x.clicks, 1);
});

test("C2/H5: an older or different post is never recorded as this one", async () => {
  const r = rig();
  const old = (id: number, text: string) => r.x.live.push({ url: `https://x.com/example/status/${id}`, text });
  // An old post with the same text (before approval) is not this post; it is posted anew.
  old(1, "Alpha.");
  const q = r.write("alpha", 'text: "Alpha."');
  await approve(r, "alpha");
  await r.svc.postNow("alpha");
  assert.equal(r.x.clicks, 1);
  assert.notEqual(readDraft(q).postUrl, "https://x.com/example/status/1");
  // An old post that merely starts with the approved text ("Yes." vs "Yes. I agree…") is not it either, even if fresh by id.
  const r2 = rig();
  r2.x.live.push({ url: `https://x.com/example/status/${((BigInt(T0 + 1000) - 1288834974657n) << 22n)}`, text: "Yes. I agree with all of it, and here is why." });
  const y = r2.write("yes", 'text: "Yes."');
  await approve(r2, "yes");
  r2.clock.now += 10_000; // time passes between approval and the click
  await r2.svc.postNow("yes");
  assert.equal(r2.x.clicks, 1, "a prefix is not a match");
  assert.equal(r2.x.live.at(-1)!.text, "Yes.");
  assert.equal(readDraft(y).postUrl, r2.x.live.at(-1)!.url);
  // Two release notes that differ only after character 80: the second is not satisfied by the first.
  const r3 = rig();
  const stem = "Release notes for version 2.0 are out now and they include a long list of changes to read: ";
  r3.x.live.push({ url: "https://x.com/example/status/5", text: stem + "alpha" });
  r3.write("rel", `text: "${stem}beta"`);
  await approve(r3, "rel");
  await r3.svc.postNow("rel");
  assert.equal(r3.x.live.at(-1)!.text, stem + "beta");
  // X rejects a repeat ("You already said that"): the click does nothing new, the identical OLD post is not recorded.
  const r4 = rig();
  r4.x.live.push({ url: `https://x.com/example/status/${((BigInt(T0 + 5000) - 1288834974657n) << 22n)}`, text: "Same again." }); // newer than approval, though not from this run
  r4.write("dup", 'text: "Same again."');
  await approve(r4, "dup");
  r4.x.hideNew = true;
  await assert.rejects(r4.svc.postNow("dup"), (e: any) => e.final === true && /already live at/.test(e.message), "R4: found before the click, so it is never clicked a second time");
  assert.equal(r4.x.clicks, 0);
  assert.equal(readDraft(join(r4.draftsDir, "dup.md")).status, "Ready", "not recorded as Posted");
  // Parts: an earlier part's post cannot stand in for a later part (strictly increasing ids, no duplicates).
  const r5 = rig();
  const t = r5.write("rep", 'thread:\n  - "Same."\n  - "Same."');
  await approve(r5, "rep");
  await r5.svc.postNow("rep");
  const urls = readDraft(t).threadUrls;
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1]);
  assert.ok(BigInt(urls[1].split("/").pop()!) > BigInt(urls[0].split("/").pop()!));
});

test("C2: the match is the whole text with emoji alt restored and links as URL; the page reader does that", () => {
  assert.equal(normText("Fire \u{1F525} see https://example.org/a/b."), "Fire \u{1F525} see URL.");
  assert.equal(normText("a\n\n  b"), "a b");
  // The in-page reader, run on a tiny DOM: an <img alt> is emoji text, a link is URL, a mention stays.
  const text = (s: string) => ({ nodeType: 3, textContent: s });
  const el = (tagName: string, childNodes: any[] = [], extra: any = {}) => ({ nodeType: 1, tagName, childNodes, textContent: extra.textContent ?? "", getAttribute: (k: string) => extra[k] ?? null });
  const dom = el("SPAN", [text("Fire "), el("IMG", [], { alt: "\u{1F525}" }), text(" ship it "), el("A", [], { textContent: "example.org/a/b\u2026" }), text(" cc "), el("A", [], { textContent: "@example" })]);
  const pageText = new Function(`${PAGE_TEXT}; return pageText;`)();
  assert.equal(normText(pageText(dom)), "Fire \u{1F525} ship it URL cc @example");
  const cands = [{ url: "https://x.com/example/status/9", text: normText(pageText(dom)) }];
  assert.equal(pickPart(cands, "Fire \u{1F525} ship it https://example.org/a/b cc @example", "example", { urls: [], prevId: 0n, notBefore: statusTime(9n) + 1 }), undefined, "id 9 is older than notBefore");
  assert.equal(pickPart(cands, "Fire \u{1F525} ship it https://example.org/a/b cc @example", "example", { urls: [], prevId: 0n, notBefore: statusTime(9n) }), "https://x.com/example/status/9");
});

test("H4: the browser must be signed in to the configured account; the profile is part of what approval covers", async () => {
  const r = rig();
  r.write("who", 'text: "Right account only"');
  await approve(r, "who");
  r.x.signedIn = "someone_else";
  await assert.rejects(r.svc.postNow("who"), (e: any) => e.final === true && /not signed in to @example/.test(e.message));
  await assert.rejects(r.svc.dryRun("who"), /not signed in to @example/);
  assert.equal(r.x.filled.length, 1, "only the dry run before the switch filled anything");
  assert.equal(r.x.clicks, 0);
  // Remapping an account key to another profile voids the approval.
  r.x.signedIn = "example";
  const other = new PostService({ ...r.svc.deps, config: { ...r.svc.deps.config, accounts: { main: { ...ACCOUNT, profile: ["https://x", "com/another"].join(".") } } } });
  await assert.rejects(other.postNow("who"), /edited after it was approved/);
  assert.throws(() => xHandle("http://x.com/example"), /https/);
  assert.throws(() => xHandle("https://evil.example/example"), /https:\/\/x\.com/);
  assert.equal(xHandle("https://twitter.com/example").handle, "example");
});

test("H5: recorded parent URLs must be this account's own status URLs, once each, in order", async () => {
  const r = rig();
  const p = r.write("par", 'thread:\n  - "One."\n  - "Two."\n  - "Three."');
  await approve(r, "par");
  for (const bad of ["https://evil.example/example/status/5", ["https://x", "com/other/status/5"].join("."), "https://x.com/example/status/5/photo/1"]) {
    writeFileSync(p, setFields(readFileSync(p, "utf8"), { thread_urls: bad }));
    await assert.rejects(r.svc.postNow("par"), /not https:\/\/x\.com\/example\/status|is not /, bad);
  }
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { thread_urls: "https://x.com/example/status/5,https://x.com/example/status/5" }));
  await assert.rejects(r.svc.postNow("par"), /duplicate/);
  assert.equal(r.x.clicks, 0);
});

test("H2/H3: approval covers exactly what was shown, and control characters cannot fake the prompt", async () => {
  const r = rig();
  const p = r.write("shown", 'text: "What you read"');
  const shown = readDraft(p).textHash;
  writeFileSync(p, readFileSync(p, "utf8").replace("What you read", "Something else"));
  await assert.rejects(r.svc.approve("shown", "alice", shown), /changed after it was shown to you/);
  assert.equal(readDraft(p).approved, undefined);
  await r.svc.approve("shown", "alice", readDraft(p).textHash);
  // The card binds the answer to what it showed: an edit while the card is open means nothing is approved.
  r.write("race", 'text: "Displayed"');
  const raced = await operator(r, "approve", "race", { between: () => writeFileSync(join(r.draftsDir, "race.md"), readFileSync(join(r.draftsDir, "race.md"), "utf8").replace("Displayed", "Swapped")) });
  assert.match(raced.shown[0], /Displayed/);
  assert.match(raced.told.join(), /changed after the card was shown/);
  assert.equal(readDraft(join(r.draftsDir, "race.md")).approved, undefined);
  // Control and bidi characters are refused when the draft is rendered; the agent cannot even create such a draft.
  for (const bad of ["\u001b[2Kfake", "a\rb", "x\u202eevil", "tab\there", "\u0085next"]) {
    r.write("ctl", `text: ${JSON.stringify(bad)}`);
    await assert.rejects(r.svc.dryRun("ctl", { offline: true }), /control or bidirectional/, JSON.stringify(bad));
    await assert.rejects(r.svc.approve("ctl", "alice"), /control or bidirectional/);
  }
  assert.throws(() => r.svc.createDraft({ name: "bad-ctl", platform: "x", account: "main", text: "hi\u202ethere" }), /control or bidirectional/);
  assert.equal(existsSync(join(r.draftsDir, "bad-ctl.md")), false);
  assert.equal(visible("a\u001bb\n"), "a\\u001bb\n");
});

test("H6: a skipped slot never claims NOT posted when a click was started", async () => {
  const r = rig();
  const p = r.write("h6", 'text: "Crash after the click"');
  await approve(r, "h6");
  const { job } = await r.svc.schedule("h6", "2026-03-10T14:00:00Z");
  // A crash after the click but before the URL was recorded: the write-ahead record is all that is left.
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { pending_part: "0", pending_at: "2026-03-10T14:00:01.000Z" }));
  r.clock.now = Date.parse("2026-03-10T20:00:00Z"); // far past the 3 h window
  const out = await r.svc.runScheduled(r.scheduler.get(job.id)).catch((e) => e.message);
  assert.doesNotMatch(out, /NOT posted/);
  assert.doesNotMatch(out, /Skipped/);
  assert.match(out, /check @example's profile/);
  assert.equal(r.x.clicks, 0);
});

test("M1: a part that is live cannot be edited and re-approved", async () => {
  const r = rig();
  const p = r.write("live", 'thread:\n  - "First."\n  - "Second."');
  await approve(r, "live");
  r.x.failList = (n) => n === 3; // part 1 posted and recorded; part 2 fails before its click
  await assert.rejects(r.svc.postNow("live"));
  assert.equal(readDraft(p).threadUrls.length, 1);
  assert.equal(readDraft(p).partHashes.length, 1);
  writeFileSync(p, readFileSync(p, "utf8").replace('"First."', '"First, edited."'));
  await assert.rejects(r.svc.approve("live", "alice"), /part 1 is already live and its text was edited/);
  writeFileSync(p, readFileSync(p, "utf8").replace('"First, edited."', '"First."').replace('"Second."', '"Second, edited."'));
  await r.svc.approve("live", "alice"); // editing a part that is not yet live is fine
  await r.svc.dryRun("live");
  r.x.failList = undefined;
  await r.svc.postNow("live");
  assert.deepEqual(r.x.live.map((l) => l.text), ["First.", "Second, edited."]);
});

test("M2: a draft whose every part is live but was never marked Posted is just marked Posted", async () => {
  const r = rig();
  const p = r.write("done", 'text: "All live"');
  await approve(r, "done");
  await r.svc.postNow("done");
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { status: "Ready" }));
  const callsBefore = r.x.calls.length;
  assert.match(await r.svc.postNow("done"), /Posted done/);
  assert.equal(readDraft(p).status, "Posted");
  assert.equal(r.x.calls.length, callsBefore, "the platform was not contacted");
  assert.equal(r.x.clicks, 1);
});

test("M3/M4: compare-and-set against the file as read; retex failures are not swallowed; a temp file never lingers; real retex round trip", async () => {
  const r = rig();
  const p = r.write("cas", 'text: "cas"');
  const d = readDraft(p);
  writeFileSync(p, readFileSync(p, "utf8") + "\nnotes added by someone else\n");
  const store = new DraftStore(r.x.run, false);
  await assert.rejects(store.set(p, { status: "Ready" }, d.fileHash), /changed while it was being updated/);
  assert.doesNotMatch(readFileSync(p, "utf8"), /status: Ready/);
  assert.deepEqual(readdirSync(r.draftsDir).filter((f) => f.includes(".tmp-")), []);
  // A retex that is present but failing is an error, not a silent fallback; absent (127) falls back.
  const failing = new DraftStore(async (cmd) => ({ code: 3, stdout: "", stderr: `${cmd} broke` }), true);
  await assert.rejects(failing.set(p, { status: "Ready" }), /retex show failed/);
  const absent = new DraftStore(async () => ({ code: 127, stdout: "", stderr: "not found" }), true);
  await absent.set(p, { status: "Ready" });
  assert.match(readFileSync(p, "utf8"), /^status: Ready$/m);
  // Clearing keys is one atomic write, not retex then a second write.
  const calls: string[] = [];
  const spy = new DraftStore(async (cmd, args) => { calls.push(args[0]); return { code: 0, stdout: JSON.stringify({ contentHash: "h" }), stderr: "" }; }, true);
  await spy.set(p, { status: "Ready", last_error: undefined });
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(p, "utf8").includes("last_error"), false);
});

test("M4: a real retex set keeps the approval valid (skipped where retex is not installed)", { skip: spawnSync("retex", ["--help"]).error ? "retex not installed" : false }, async () => {
  const r = rig();
  const p = r.write("real", 'text: "Real retex"');
  const real = new PostService({ ...r.svc.deps, run: realRunner, config: { ...r.svc.deps.config, retex: "auto" } });
  await real.approve("real", "alice");
  assert.equal(real.problem(readDraft(p)), undefined, `approval survives retex's write:\n${readFileSync(p, "utf8")}`);
  assert.match(readFileSync(p, "utf8"), /approved: "?alice/);
});

test("M5: schedules.json is locked; a job the CLI removes is dropped by the gateway; the CLI does not rewrite live job state", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-"));
  const runners = { prompt: async () => "", builtin: {}, deliver: async () => {} } as any;
  const gateway = new Scheduler(home, log, runners);
  const j = gateway.add({ name: "post one", when: "once 2030-01-01T00:00:00Z", post: { draft: "/tmp/d.md" }, deliver: "home" });
  const keep = gateway.add({ name: "keep", when: "every 1h", prompt: "x", deliver: "none" });
  // The gateway marks a job running, as it does while a post is in flight.
  (gateway as any).find(keep.id).lastStatus = "running";
  (gateway as any).save();
  const cli = new Scheduler(home, log, runners, { passive: true });
  assert.equal(cli.get(keep.id).lastStatus, "running", "the CLI did not mark it interrupted");
  cli.remove(j.id);
  cli.add({ name: "cli job", when: "every 2h", prompt: "y", deliver: "none" });
  const onDisk = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8")).jobs;
  assert.equal(onDisk.find((x: any) => x.id === keep.id).lastStatus, "running", "the CLI's save kept the gateway's live state");
  assert.equal(onDisk.some((x: any) => x.id === j.id), false);
  // The gateway's next save neither resurrects the removed job nor loses the CLI's.
  (gateway as any).save();
  assert.deepEqual(gateway.list().map((x) => x.name).sort(), ["cli job", "keep"]);
  assert.equal(existsSync(join(home, "schedules.json.lock")), false);
  // A removed post job does not fire.
  const r = rig();
  r.write("gone", 'text: "Removed before the slot"');
  await approve(r, "gone");
  const { job } = await r.svc.schedule("gone", "2026-03-10T14:00:00Z");
  const gw = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (x: any, o: any) => r.svc.runScheduled(x, o) }, deliver: async () => {} } as any);
  new Scheduler(r.home, log, runners, { passive: true }).remove(job.id);
  r.clock.now = Date.parse("2026-03-10T14:00:10Z");
  await gw.runNow(job.id).catch(() => {});
  assert.equal(r.x.clicks, 0);
});

test("M6: drafts under a folder the agent can write are refused, at config load and at fire time", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-cfg-"));
  const acct = { main: { platform: "x", profile: "https://x.com/example" } };
  for (const dir of ["workspace/posts", "memory/notes", "spill", "shared/vault"]) {
    writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", agentWritable: [join(home, "shared")], post: { draftsDir: join(home, dir), accounts: acct } }));
    assert.throws(() => loadConfig(home), /a folder the agent can write/, dir);
  }
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { draftsDir: join(home, "safe"), accounts: acct } }));
  assert.ok(loadConfig(home).post.agentWritable.length >= 4);
  // And at fire time: a draft path inside such a folder is refused whatever the config said.
  const r = rig();
  const shared = join(r.home, "shared");
  mkdirSync(shared);
  const svc = new PostService({ ...r.svc.deps, config: { ...r.svc.deps.config, agentWritable: [shared] } });
  writeFileSync(join(shared, "x.md"), "---\nplatform: x\naccount: main\ntext: hi\n---\n");
  await assert.rejects(svc.dryRun(join(shared, "x.md"), { offline: true }), /a folder the agent can write/);
});

test("M7/C3: the agent cannot post at once, change a slot, post late, or run or resume a scheduled post", async () => {
  const r = rig();
  const tools = carlTools({} as any, r.scheduler, { send: async () => "" }, r.svc);
  const post: any = tools.find((t) => t.name === "post_draft");
  const sched: any = tools.find((t) => t.name === "schedule");
  const w = r.write("ag", 'text: "Agent timing"');
  await approve(r, "ag");
  assert.equal(JSON.stringify(post.parameters).includes("late"), false, "late is not in the agent's schema");
  await assert.rejects(post.execute("id", { action: "schedule", name: "ag", at: "2026-03-11T12:00:00Z", late: "post" }), /cannot choose late/);
  const first = await post.execute("id", { action: "schedule", name: "ag", at: "2026-03-11T12:00:00Z" });
  assert.match(first.content[0].text, /Scheduled ag/);
  const jobId = r.scheduler.list().find((j) => j.post)!.id;
  // A second slot, or an earlier one, is the operator's to set.
  await assert.rejects(post.execute("id", { action: "schedule", name: "ag", at: "2026-03-10T12:00:01Z" }), /already has a slot/);
  // run / resume of a post job through the agent's schedule tool.
  await assert.rejects(sched.execute("id", { action: "run", id: jobId }), /only the operator can run it early/);
  await assert.rejects(sched.execute("id", { action: "resume", id: jobId }), /only the operator can pause or resume it/);
  assert.equal(r.x.clicks, 0);
  // runScheduled before the slot refuses unless the operator forces it.
  await assert.rejects(r.svc.runScheduled(r.scheduler.get(jobId)), /has not arrived/);
  assert.equal(r.x.clicks, 0);
  assert.match(await r.svc.runScheduled(r.scheduler.get(jobId), { force: true }), /Posted ag/);
  assert.equal(r.x.clicks, 1);
  assert.equal(readDraft(w).status, "Posted");
});

test("M8: a live dry run of the exact text is required to post or schedule; the operator can skip it", async () => {
  const r = rig();
  const p = r.write("dry", 'text: "Dry first"');
  await r.svc.approve("dry", "alice");
  await assert.rejects(r.svc.postNow("dry"), /no live dry run covers this exact text/);
  await assert.rejects(r.svc.schedule("dry", "2026-03-11T12:00:00Z"), /no live dry run/);
  await r.svc.dryRun("dry", { offline: true });
  await assert.rejects(r.svc.postNow("dry"), /no live dry run/, "an offline dry run does not count");
  await r.svc.dryRun("dry");
  assert.ok(readDraft(p).dryRunHash);
  writeFileSync(p, readFileSync(p, "utf8").replace("Dry first", "Dry changed"));
  await r.svc.approve("dry", "alice");
  await assert.rejects(r.svc.postNow("dry"), /no live dry run/, "an edit voids the dry run");
  await r.svc.postNow("dry", { skipDryRun: true });
  assert.equal(r.x.clicks, 1);
});

test("C4(b): approved_hash is keyed; the old unkeyed hash is refused; the key file is 0600 and created once", async () => {
  const r = rig();
  const p = r.write("hm", 'text: "Keyed"');
  const d = readDraft(p);
  // Anyone who can write the draft can compute an unkeyed hash; it is not an approval.
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { approved: "mallory 2026-03-10T11:00:00Z", approved_hash: sha256(JSON.stringify({ platform: "x", account: "main", parts: ["Keyed"], thread: false, reply: null })), dry_run_hash: d.textHash }));
  await assert.rejects(r.svc.postNow("hm"), /edited after it was approved/);
  assert.equal(r.x.calls.length, 0);
  await r.svc.approve("hm", "alice");
  const key = join(r.home, "post-approval.key");
  assert.equal(statSync(key).mode & 0o777, 0o600);
  const before = readFileSync(key, "utf8");
  assert.match(before.trim(), /^[0-9a-f]{64}$/);
  assert.match(readDraft(p).approvedHash!, /^[0-9a-f]{64}$/);
  // A second service reuses the key (the approval stays valid); a different key voids it.
  const again = new PostService(r.svc.deps);
  assert.equal(again.problem(readDraft(p)), undefined);
  assert.equal(readFileSync(key, "utf8"), before);
  rmSync(key);
  assert.match(new PostService(r.svc.deps).problem(readDraft(p))!, /edited after it was approved/, "a new key voids every approval");
});

test("C4(a): the sandbox profile denies the browser control directory, its socket and the approval key whenever posting is configured", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-sb-"));
  process.env.HOME = home;
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { accounts: { main: { platform: "x", profile: "https://x.com/example" } } } }));
  const cfg = loadConfig(home);
  const dir = join(canonical(home), "Library", "Application Support", "OverSeer", "browser");
  const profile = buildProfile(cfg);
  assert.ok(profile.split("\n").some((l) => l.startsWith("(deny file-read* (subpath") && l.includes(`(subpath "${dir}")`)), "the browser control folder is unreadable");
  assert.ok(profile.includes(`(remote unix-socket (subpath "${dir}"))`), "the control socket is unreachable");
  assert.ok(new RegExp(`\\(deny file-write\\* [^\n]*\\(subpath "${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`).test(profile), "and cannot be replaced");
  assert.ok(profile.includes(`(literal "${join(canonical(home), "post-approval.key")}")`), "the approval key is unreadable");
  assert.ok(secretFiles(cfg).includes(join(home, "post-approval.key")));
  assert.ok(secretDirs(cfg).includes(join(home, "Library", "Application Support", "OverSeer", "browser")));
  assert.ok(secretDirs(cfg).includes(join(home, ".config", "overseer-browser")));
  // Without accounts nothing about the browser is added (the general tooling is untouched).
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b" }));
  assert.ok(!buildProfile(loadConfig(home)).includes("OverSeer"));
  // The guard: the CLI is a hardline refusal for the agent's shell and its files are unreadable to its file tools.
  const rules = { denyBrowserCli: true, secretPaths: secretDirs(cfg) };
  const managed = join(home, "Library", "Application Support", "OverSeer", "browser");
  for (const c of ["overseer-browser --session x eval 1", "~/.local/bin/overseer-browser sessions list", 'cat "$HOME/Library/Application Support/OverSeer/browser/agent-v1/token"']) assert.equal(classifyCommand(c, rules).level, "hardline", c);
  assert.equal(classifyCommand("overseer-browser --help", {}).level, "ok", "unaffected when posting is not configured");
  assert.equal(readVerdict(join(managed, "agent-v1", "token"), rules).level, "hardline");
});

test("H1: the gateway's trusted PATH finds the session command (resolved from the operator's PATH at init)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "carl-post-path-"));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; rmSync(root, { recursive: true, force: true }); });
  const userBin = join(root, "user-bin");
  mkdirSync(userBin);
  writeFileSync(join(userBin, "overseer-browser"), "#!/bin/sh\necho '{\"ok\":true,\"from\":\"user-bin\"}'\n", { mode: 0o755 });
  process.env.PATH = `${userBin}:/usr/bin:/bin`;
  const accounts = { main: ACCOUNT };
  // Without the fix the gateway's PATH (bin folder + system folders) cannot see ~/.local/bin and the call is ENOENT.
  adoptTrustedPath(join(root, "state-bin"), { node: process.execPath });
  assert.equal((await realRunner("overseer-browser", ["--json"])).code, 127);
  const found = adoptTrustedPath(join(root, "state-bin"), { node: process.execPath, ...sessionPrograms(accounts) });
  assert.equal(found["overseer-browser"], join(userBin, "overseer-browser"));
  const r = await realRunner("overseer-browser", ["--json"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /user-bin/);
  assert.ok(!process.env.PATH!.includes(userBin), "the agent's writable folder is still not on Carl's PATH");
  // Absolute commands are pinned by name too.
  assert.deepEqual(sessionPrograms({ a: { session: { command: "/opt/x/browser" } } }), { browser: "/opt/x/browser" });
});

test("Low: media and a thread's reply are refused; inline lists parse; X length weights; the child environment is scrubbed; locks", async () => {
  const r = rig();
  r.write("med", 'text: "pic"\nmedia: ["a.png"]');
  await assert.rejects(r.svc.dryRun("med", { offline: true }), /media is not supported/);
  r.write("tr", 'thread:\n  - "a"\n  - "b"\nreply: "lost"');
  await assert.rejects(r.svc.dryRun("tr", { offline: true }), /`reply` would not be posted/);
  const parsed = parseDraft('---\ntext: [beta] note [x]\nthread_urls: ["https://a/1", "https://a/2"]\n---\n', "/x.md");
  assert.equal(parsed.parts[0], "[beta] note [x]");
  assert.deepEqual(parseFront(["thread: [\"one, two\", 'three', four]"]).thread, ["one, two", "three", "four"]);
  assert.equal(xLength("hello"), 5);
  assert.equal(xLength("\u{1F525}"), 2);
  assert.equal(xLength("\u65e5\u672c"), 4);
  assert.equal(xLength("a https://example.org/" + "x".repeat(50)), 2 + 23);
  r.write("cjk", `text: "${"\u65e5".repeat(141)}"`);
  await assert.rejects(r.svc.dryRun("cjk", { offline: true }), /282 characters/);
  const env = childEnv({ PATH: "/bin", HOME: "/h", CARL_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", OPENAI_API_KEY: "o", LANG: "C" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", LANG: "C" });
  // Locks: the same file by two paths is one lock; a stale lock (dead pid) is taken over once.
  const p = r.write("lk", 'text: "lock"');
  await approve(r, "lk");
  const lockDir = join(r.home, "state", "post-locks");
  let release!: () => void;
  const hold = new Promise<void>((res) => { release = res; });
  const slow = r.svc.deps.run;
  let entered!: () => void;
  const inside = new Promise<void>((res) => { entered = res; });
  const svc = new PostService({ ...r.svc.deps, run: async (c, a, o) => { if (a.includes("start")) { entered(); await hold; } return slow(c, a, o); } });
  const first = svc.postNow("lk");
  await inside;
  const alias = join(r.home, "alias");
  symlinkSync(r.draftsDir, alias);
  await assert.rejects(r.svc.postNow(join(alias, "lk.md")), /being posted by another run/);
  release();
  await first;
  assert.deepEqual(readdirSync(lockDir), []);
  // Stale lock from a dead process: taken over, no leftovers.
  const q = r.write("lk2", 'text: "lock two"');
  await approve(r, "lk2");
  const name = readdirSync(lockDir);
  assert.deepEqual(name, []);
  const lockFile = join(lockDir, `${sha256(canon(q)).slice(0, 16)}.lock`);
  writeFileSync(lockFile, "999999 1\n");
  await r.svc.postNow("lk2");
  assert.deepEqual(readdirSync(lockDir), []);
  assert.equal(readDraft(q).status, "Posted");
  void p;
});

test("Low: the composer is re-read at click time; a changed composer is not posted", async () => {
  const r = rig();
  r.write("tm", 'text: "Original text"');
  await approve(r, "tm");
  r.x.tamper = () => "Something the page swapped in";
  await assert.rejects(r.svc.postNow("tm"), /composer text changed before the click/);
  assert.equal(r.x.clicks, 0);
});

test("the CLI: clear-pending only asks; the pending record goes when the operator answers the card", async () => {
  const r = rig();
  const p = r.write("cp", 'text: "pending"');
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { pending_part: "0", pending_at: "2026-03-10T11:00:00.000Z" }));
  const out: string[] = []; const err: string[] = [];
  const io: PostCliIo = { out: (s) => out.push(s), err: (s) => err.push(s) };
  assert.equal(await postCommand(["clear-pending", "cp"], io, () => r.svc), 0);
  assert.match(out.join(), /waits for your answer/);
  assert.equal(readDraft(p).pendingPart, 0, "the CLI cleared nothing");
  const denied = new CardDesk(r.svc, () => Promise.resolve({ answer: "denied" }), () => {});
  await denied.pump();
  assert.equal(readDraft(p).pendingPart, 0, "denied");
  assert.equal(new CardStore(r.home, () => r.clock.now).list().length, 0, "an answered card is gone");
  await operator(r, "clear-pending", "cp");
  assert.equal(readDraft(p).pendingPart, undefined);
});
test("a schedule is durable: it survives a restart, fires on time, and posts once", async () => {
  const r = rig();
  const p = r.write("sch", 'text: "On schedule"');
  await approve(r, "sch");
  const { job } = await r.svc.schedule("sch", "2026-03-10T14:00:00Z");
  assert.equal(job.builtin, "post");
  assert.equal(readDraft(p).status, "Scheduled");
  assert.equal(readDraft(p).scheduledAt, "2026-03-10T14:00:00.000Z");
  const disk = JSON.parse(readFileSync(join(r.home, "schedules.json"), "utf8"));
  assert.equal(disk.jobs[0].post.draft, p);
  // A restart: a new Scheduler reads schedules.json and the runner posts at the slot.
  const delivered: string[] = [];
  r.clock.now = Date.parse("2026-03-10T14:00:30Z");
  const again = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any) => r.svc.runScheduled(j) }, deliver: async (_j: any, t: string) => { delivered.push(t); } } as any);
  assert.equal(again.list()[0].nextRunAt, Date.parse("2026-03-10T14:00:00Z"));
  await again.runNow(job.id);
  assert.match(delivered[0], /Posted sch/);
  assert.equal(posted(r.x), 1);
  assert.equal(readDraft(p).status, "Posted");
  assert.equal(again.list()[0].enabled, false, "a posted slot does not fire again");
  await again.runNow(job.id);
  assert.equal(posted(r.x), 1);
  assert.match(delivered[1], /already Posted/);
});

test("missed slot: skipped past the window, the draft stays Scheduled, and the delivered message says so", async () => {
  const r = rig();
  const p = r.write("miss", 'text: "Too late"');
  await approve(r, "miss");
  const callsBefore = r.x.calls.filter((c) => !c.startsWith("retex")).length;
  const { job } = await r.svc.schedule("miss", "2026-03-10T14:00:00Z");
  r.clock.now = Date.parse("2026-03-10T18:30:00Z"); // 4 h 30 min late; the window is 3 h
  const delivered: string[] = [];
  const s = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any) => r.svc.runScheduled(j) }, deliver: async (_j: any, t: string) => { delivered.push(t); } } as any);
  await s.runNow(job.id);
  assert.equal(posted(r.x), 0);
  assert.equal(r.x.calls.filter((c) => !c.startsWith("retex")).length, callsBefore, "the platform was never contacted");
  assert.equal(readDraft(p).status, "Scheduled");
  assert.match(String(readDraft(p).fields.schedule_note), /missed by 4 h 30 min/);
  assert.match(delivered[0], /Skipped miss/);
  assert.match(delivered[0], /NOT posted/);
  assert.match(delivered[0], /still Scheduled/);
  assert.match(delivered[0], /4 h 30 min/);
  // Inside the window it posts: 2 h 59 min late.
  const q = r.write("near", 'text: "Just in time"');
  await approve(r, "near");
  r.clock.now = Date.parse("2026-03-11T08:00:00Z");
  const near = await r.svc.schedule("near", "2026-03-11T10:00:00Z");
  r.clock.now = Date.parse("2026-03-11T12:59:00Z");
  await new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any) => r.svc.runScheduled(j) }, deliver: async () => {} } as any).runNow(near.job.id);
  assert.equal(readDraft(q).status, "Posted");
});

test("late: post posts a missed slot late and says how late; the window is configurable", async () => {
  const r = rig();
  const p = r.write("late", 'text: "Better late"');
  await approve(r, "late");
  const { job, text } = await r.svc.schedule("late", "2026-03-10T14:00:00Z", { late: "post" });
  assert.match(text, /posts late/);
  assert.equal(r.scheduler.get(job.id).post?.late, "post");
  r.clock.now = Date.parse("2026-03-10T20:00:00Z");
  const out = await r.svc.runScheduled(r.scheduler.get(job.id));
  assert.match(out, /Posted late/);
  assert.match(out, /6 h 0 min late/);
  assert.equal(readDraft(p).status, "Posted");
  const tight = rig({ window: 30 });
  tight.write("t", 'text: "x"');
  await approve(tight, "t");
  const t = await tight.svc.schedule("t", "2026-03-10T13:00:00Z");
  tight.clock.now = Date.parse("2026-03-10T13:45:00Z");
  assert.match(await tight.svc.runScheduled(tight.scheduler.get(t.job.id)), /Skipped t/);
});

test("a thread already partly live is finished even when the slot is long past, with no double post", async () => {
  const r = rig();
  const p = r.write("half", 'thread:\n  - "One."\n  - "Two."');
  await approve(r, "half");
  const { job } = await r.svc.schedule("half", "2026-03-10T14:00:00Z");
  r.clock.now = Date.parse("2026-03-10T14:00:05Z");
  r.x.failList = (n) => n === 3; // part 1 is posted and recorded; part 2 fails before its click
  const s = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any, o: any) => r.svc.runScheduled(j, o) }, deliver: async () => {} } as any);
  await s.runNow(job.id);
  assert.equal(s.get(job.id).lastStatus, "error");
  assert.ok(s.get(job.id).nextRunAt! > Date.now(), "a failure before any click is retried, not dropped");
  assert.equal(s.get(job.id).enabled, true);
  r.x.failList = undefined;
  r.clock.now = Date.parse("2026-03-10T23:00:00Z"); // far past the window
  await s.runNow(job.id);
  assert.deepEqual(r.x.live.map((l) => l.text), ["One.", "Two."]);
  assert.equal(readDraft(p).status, "Posted");
  assert.equal(s.get(job.id).enabled, false);
});

test("a draft edited after scheduling is refused when the slot fires, with no retry", async () => {
  const r = rig();
  const p = r.write("ed", 'text: "approved text"');
  await approve(r, "ed");
  const { job } = await r.svc.schedule("ed", "2026-03-10T14:00:00Z");
  writeFileSync(p, readFileSync(p, "utf8").replace("approved text", "sneaky text"));
  r.clock.now = Date.parse("2026-03-10T14:00:10Z");
  const delivered: string[] = [];
  const s = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any) => r.svc.runScheduled(j) }, deliver: async (_j: any, t: string) => { delivered.push(t); } } as any);
  await s.runNow(job.id);
  assert.equal(posted(r.x), 0);
  assert.match(delivered[0], /edited after it was approved/);
  assert.equal(s.get(job.id).noRetry, true);
  assert.equal(s.get(job.id).enabled, false);
});

test("a job another process added (carl post schedule) is adopted by a running scheduler and not lost on its next save", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-"));
  const runners = { prompt: async () => "", builtin: {}, deliver: async () => {} } as any;
  const gateway = new Scheduler(home, log, runners);
  gateway.add({ name: "other", when: "every 1h", prompt: "x", deliver: "none" });
  const cli = new Scheduler(home, log, runners);
  const added = cli.add({ name: "post one", when: "once 2030-01-01T00:00:00Z", post: { draft: "/tmp/d.md" }, deliver: "home" });
  gateway.add({ name: "later", when: "every 2h", prompt: "y", deliver: "none" });
  assert.deepEqual(gateway.list().map((j) => j.name).sort(), ["later", "other", "post one"]);
  assert.ok(gateway.get(added.id).post);
  const fresh = new Scheduler(home, log, runners);
  assert.equal(fresh.list().length, 3);
  assert.throws(() => gateway.add({ name: "bad", when: "every 1h", post: { draft: "/x" }, deliver: "home" }), /fires once/);
});

test("the agent's tool can draft, dry-run and schedule, and has no way to approve or post now", async () => {
  const r = rig();
  const tools = carlTools({} as any, r.scheduler, { send: async () => "" }, r.svc);
  const tool: any = tools.find((t) => t.name === "post_draft");
  assert.ok(tool);
  const props = JSON.stringify(tool.parameters);
  assert.doesNotMatch(props, /approved|approved_hash/i);
  assert.deepEqual((tool.parameters.properties.action.anyOf as { const: string }[]).map((a) => a.const).sort(), ["draft", "dry_run", "request_approval", "schedule", "status"]);
  const run = (p: object) => tool.execute("id", p);
  const made = await run({ action: "draft", name: "agent-one", platform: "x", account: "main", text: "Drafted by the agent", approved: "mallory 2026-03-10T00:00:00Z", approved_hash: "x" });
  assert.match(made.content[0].text, /needs the operator's approval/);
  const file = readFileSync(join(r.draftsDir, "agent-one.md"), "utf8");
  assert.doesNotMatch(file, /approved/);
  assert.match(file, /^status: Draft$/m);
  await assert.rejects(run({ action: "draft", name: "agent-one", platform: "x", account: "main", text: "again" }), /already exists/);
  await assert.rejects(run({ action: "draft", name: "../escape", platform: "x", account: "main", text: "t" }), /draft names are/);
  await assert.rejects(run({ action: "draft", name: "bad-acct", platform: "x", account: "nope", text: "t" }), /not configured/);
  await assert.rejects(run({ action: "schedule", name: "agent-one", at: "2026-03-11T12:00:00Z" }), /no operator approval/);
  await assert.rejects(run({ action: "approve", name: "agent-one" }), /unknown action/);
  await assert.rejects(run({ action: "now", name: "agent-one" }), /unknown action/);
  await assert.rejects(run({ action: "dry_run", name: "/etc/passwd" }), /draft names are/);
  assert.match((await run({ action: "dry_run", name: "agent-one" })).content[0].text, /offline/);
  assert.equal(r.x.calls.length, 0);
  // After the operator approves, the agent can schedule it.
  await r.svc.approve("agent-one", "alice");
  await assert.rejects(run({ action: "schedule", name: "agent-one", at: "2026-03-11T12:00:00Z" }), /no live dry run/);
  assert.match((await run({ action: "dry_run", name: "agent-one", offline: false })).content[0].text, /dry run recorded/);
  assert.match((await run({ action: "schedule", name: "agent-one", at: "2026-03-11T12:00:00Z" })).content[0].text, /Scheduled agent-one/);
  assert.match((await run({ action: "status" })).content[0].text, /agent-one/);
  assert.equal(carlTools({} as any, r.scheduler, { send: async () => "" }).some((t) => t.name === "post_draft"), false, "no accounts, no tool");
});

test("the CLI: approve only creates a card (no terminal, no yes); now/schedule/dry-run/status work", async () => {
  const r = rig();
  r.write("cli", 'text: "From the CLI"');
  const out: string[] = []; const err: string[] = [];
  const io: PostCliIo = { out: (s) => out.push(s), err: (s) => err.push(s) };
  const run = (...a: string[]) => postCommand(a, io, () => r.svc);
  assert.equal(await run("now", "cli"), 2);
  assert.match(err.join("\n"), /no operator approval/);
  assert.equal(await run("approve", "cli"), 0);
  assert.match(out.join("\n"), /waits for your answer on the operator channel/);
  assert.equal(readDraft(join(r.draftsDir, "cli.md")).approved, undefined, "asking is not approving");
  assert.equal(await run("now", "cli"), 2, "still refused");
  const answered = await new CardDesk(r.svc, (text) => Promise.resolve({ answer: "approved", by: "4242" }), () => {}).pump();
  assert.match(readDraft(join(r.draftsDir, "cli.md")).approved!, /^operator 4242 2026-03-10T12:00:00/);
  assert.equal(await run("dry-run", "cli"), 0);
  assert.equal(await run("schedule", "cli"), 2);
  assert.equal(await run("schedule", "cli", "--at", "2026-03-09T00:00:00Z"), 2);
  assert.match(err.join("\n"), /in the past/);
  assert.equal(await run("schedule", "cli", "--at", "2026-03-10T15:00:00Z", "--late", "post"), 0);
  assert.equal(await run("status"), 0);
  assert.match(out.join("\n"), /cli\s+Scheduled\s+x\/main approved at 2026-03-10T15:00:00.000Z/);
  assert.equal(await run("now", "cli"), 0);
  assert.equal(posted(r.x), 1);
  assert.equal(await run("bogus"), 64);
});

test("config: post accounts are validated and live only in carl.json", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-cfg-"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { accounts: { main: { platform: "x", profile: "https://x.com/example" } } } }));
  const cfg = loadConfig(home);
  assert.equal(cfg.post.missedWindowMinutes, 180);
  assert.equal(cfg.post.draftsDir, join(home, "posts"));
  assert.deepEqual(cfg.post.accounts.main.session, { command: "overseer-browser", timeoutSeconds: 60, namePrefix: "carl-post" });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { accounts: { main: { platform: "x", profile: "nope" } } } }));
  assert.throws(() => loadConfig(home), /profile must be a URL/);
  assert.equal(existsSync(join(home, "posts")), false);
});

// ===================== Round 3: the second review (R1-R10 and the Lows) =====================

test("R1: the relay's runtime root, the descriptor folder and the socket name are closed to the agent's shell", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-r1-"));
  process.env.HOME = home;
  const saved = { c: process.env.OVERSEER_BROWSER_CONNECTION, r: process.env.OVERSEER_BROWSER_RUNTIME };
  delete process.env.OVERSEER_BROWSER_CONNECTION; delete process.env.OVERSEER_BROWSER_RUNTIME;
  try {
    // A descriptor fixture shaped like overseer-browser's runtime discovery reads it: version 1, operator-relay, an absolute runtime_root.
    const root = join(home, ".osr-relay");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, ".config", "overseer-browser"), { recursive: true });
    writeFileSync(join(home, ".config", "overseer-browser", "active-connection.json"), JSON.stringify({ version: 1, mode: "operator-relay", runtime_root: root, token_sha256: "0".repeat(64) }));
    const accounts = { main: ACCOUNT };
    const dirs = browserControlDirs(accounts, {}, home);
    assert.ok(dirs.includes(root) || dirs.includes(canon(root)), `runtime_root is denied: ${dirs}`);
    assert.ok(dirs.includes(join(home, ".config", "overseer-browser")), "the descriptor folder is denied");
    assert.ok(dirs.includes(join(home, "Library", "Application Support", "OverSeer", "browser")), "the managed runtime stays denied");
    // OVERSEER_BROWSER_RUNTIME and an OVERSEER_BROWSER_CONNECTION descriptor elsewhere are followed too.
    const other = join(home, "elsewhere"); mkdirSync(other);
    writeFileSync(join(other, "conn.json"), JSON.stringify({ version: 1, mode: "operator-relay", runtime_root: join(home, ".osr-two") }));
    const env = { OVERSEER_BROWSER_CONNECTION: join(other, "conn.json"), OVERSEER_BROWSER_RUNTIME: join(home, ".osr-three") };
    const more = browserControlDirs(accounts, env, home);
    for (const d of [".osr-two", ".osr-three"]) assert.ok(more.some((m) => m.endsWith(d)), d);
    assert.ok(more.includes(other));
    assert.deepEqual(browserControlDirs({}, {}, home), [], "nothing without accounts");
    // A descriptor that is garbage, or whose runtime_root is relative, adds nothing and breaks nothing.
    writeFileSync(join(home, ".config", "overseer-browser", "active-connection.json"), JSON.stringify({ runtime_root: "relative/path" }));
    assert.ok(!browserControlDirs(accounts, {}, home).some((d) => d.endsWith("relative/path")));
    // The profile: the root is read-denied and its sockets unreachable; any overseer-browser socket is refused by name.
    writeFileSync(join(home, ".config", "overseer-browser", "active-connection.json"), JSON.stringify({ version: 1, mode: "operator-relay", runtime_root: root }));
    writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { accounts: { main: { platform: "x", profile: "https://x.com/example" } } } }));
    const profile = buildProfile(loadConfig(home));
    assert.ok(profile.includes(`(subpath "${canonical(root)}")`), "runtime_root in the profile");
    assert.ok(profile.includes(`(remote unix-socket (subpath "${canonical(root)}"))`), "and its socket");
    assert.ok(profile.includes('(deny network-outbound (remote unix-socket (path-regex #"overseer-browser[^/]*\\.sock$")))'), "the socket name is refused wherever it lives");
    writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b" }));
    assert.ok(!buildProfile(loadConfig(home)).includes("overseer-browser"), "unchanged without posting");
  } finally {
    if (saved.c !== undefined) process.env.OVERSEER_BROWSER_CONNECTION = saved.c;
    if (saved.r !== undefined) process.env.OVERSEER_BROWSER_RUNTIME = saved.r;
  }
});

test("R1: under the rendered profile a client cannot connect to an overseer-browser socket, wherever it is", { skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") ? "needs macOS sandbox-exec" : false }, async () => {
  const { execFile } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const home = mkdtempSync(join(tmpdir(), "carl-post-sbx-"));
  process.env.HOME = home;
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { accounts: { main: { platform: "x", profile: "https://x.com/example" } } } }));
  const profile = join(home, "p.sb");
  writeFileSync(profile, buildProfile(loadConfig(home)));
  const dir = mkdtempSync("/tmp/cpsb-"); // short: unix socket paths are limited to ~104 bytes
  const client = join(home, "client.cjs");
  writeFileSync(client, "const s=require('net').connect(process.argv[2]);s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('REFUSED '+e.code);process.exit(0)});");
  const servers: { close: () => void }[] = [];
  const listen = (path: string) => new Promise<void>((ok) => { const s = createServer(() => {}); servers.push(s); s.listen(path, ok); });
  const tryConnect = (path: string) => new Promise<string>((ok) => execFile("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, client, path], { timeout: 20_000 }, (_e, out) => ok(out.trim())));
  try {
    await listen(join(dir, "ordinary.sock"));
    mkdirSync(join(dir, "relay"));
    await listen(join(dir, "relay", "overseer-browser.sock"));
    assert.equal(await tryConnect(join(dir, "ordinary.sock")), "CONNECTED", "control: an ordinary socket is reachable, so the profile runs and refuses selectively");
    assert.match(await tryConnect(join(dir, "relay", "overseer-browser.sock")), /REFUSED/, "the relay's socket is refused");
  } finally {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: asking never approves; only the operator's answer to the card does, bound to what the card showed", async () => {
  const r = rig();
  const p = r.write("card", 'text: "Exactly this"');
  // The CLI, the agent's tool and a hand-written card file can all only ask.
  const out: string[] = [];
  assert.equal(await postCommand(["approve", "card"], { out: (s) => out.push(s), err: (s) => out.push(s) }, () => r.svc), 0);
  const tools = carlTools({} as any, r.scheduler, { send: async () => "" }, r.svc);
  const tool: any = tools.find((t) => t.name === "post_draft");
  assert.match((await tool.execute("id", { action: "request_approval", name: "card" })).content[0].text, /Already asked|waits for your answer/);
  assert.equal(new CardStore(r.home, () => r.clock.now).list().length, 1, "asking twice is one card");
  const file = readdirSync(new CardStore(r.home, () => r.clock.now).dir).find((f) => f.endsWith(".json"))!;
  const forged = JSON.parse(readFileSync(join(new CardStore(r.home, () => r.clock.now).dir, file), "utf8"));
  writeFileSync(join(new CardStore(r.home, () => r.clock.now).dir, file), JSON.stringify({ ...forged, status: "approved", approved: true, answer: "approved", by: "mallory" }));
  assert.equal(readDraft(p).approved, undefined);
  // No operator channel: the card waits, nothing is approved. Denied or expired: dropped, nothing approved.
  const shown: string[] = [];
  await new CardDesk(r.svc, () => undefined, () => {}).pump();
  assert.equal(readDraft(p).approved, undefined);
  assert.equal(new CardStore(r.home, () => r.clock.now).list().length, 1);
  for (const answer of ["denied", "timeout"] as const) {
    await new CardDesk(r.svc, (text) => { shown.push(text); return Promise.resolve({ answer }); }, () => {}).pump();
    assert.equal(readDraft(p).approved, undefined, answer);
    r.svc.requestCard("approve", "card", { by: "operator" });
  }
  // The card carries the exact text, account, profile URL and text hash.
  assert.match(shown[0], /Exactly this/);
  assert.match(shown[0], /x\/main \(https:\/\/x\.com\/example\)/);
  assert.ok(shown[0].includes(readDraft(p).textHash.slice(0, 12)));
  const told: string[] = [];
  await new CardDesk(r.svc, () => Promise.resolve({ answer: "approved", by: "4242" }), (m) => told.push(m)).pump();
  assert.match(readDraft(p).approved!, /^operator 4242 /);
  assert.equal(r.svc.problem(readDraft(p)), undefined);
  // There is no tool action and no CLI flag that answers a card, and no TTY path left.
  assert.equal(JSON.stringify(tool.parameters).includes("answer"), false);
  assert.equal(readFileSync(new URL("../src/post/cli.ts", import.meta.url), "utf8").includes("isTTY"), false);
  // A card for an invalid draft is refused when asked, not later.
  r.write("toolong", `text: "${"x".repeat(300)}"`);
  assert.throws(() => r.svc.requestCard("approve", "toolong", { by: "agent" }), /limit 280/);
  assert.throws(() => r.svc.requestCard("approve", "../etc", { named: true, by: "agent" }), /draft names are/);
});

test("R3: a dry run's hash is not an approval, and the approved stamp is signed", async () => {
  const r = rig();
  const p = r.write("copy", 'text: "Copy attack"');
  await r.svc.dryRun("copy"); // no approval at all: the agent can do this
  const dry = readDraft(p).dryRunHash!;
  assert.ok(dry);
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { approved: "mallory 2026-03-10T11:00:00Z", approved_hash: dry }));
  assert.match(r.svc.problem(readDraft(p))!, /edited after it was approved/);
  await assert.rejects(r.svc.postNow("copy"), /edited after it was approved|no operator approval/);
  assert.equal(r.x.clicks, 0);
  // A real approval, then the stamp altered (a name or a date): void.
  await r.svc.approve("copy", "alice");
  assert.equal(r.svc.problem(readDraft(p)), undefined);
  const good = readFileSync(p, "utf8");
  writeFileSync(p, good.replace(/approved: "?alice 2026-03-10T12:00:00\.000Z"?/, "approved: bob 2026-03-10T12:00:00.000Z"));
  assert.match(r.svc.problem(readDraft(p))!, /edited after it was approved/);
  writeFileSync(p, good.replace("2026-03-10T12:00:00.000Z", "2026-03-10T11:59:00.000Z"));
  assert.match(r.svc.problem(readDraft(p))!, /edited after it was approved/);
  // And an approval hash is not a dry-run hash.
  writeFileSync(p, setFields(good, { dry_run_hash: readDraft(p).approvedHash! }));
  await assert.rejects(r.svc.postNow("copy"), /no live dry run/);
});

test("R4: a part already on the profile is never clicked again; record-live records it by card; bare domains are refused", async () => {
  const r = rig();
  const p = r.write("known", 'text: "Posted by hand"');
  await approve(r, "known");
  const id = ((BigInt(T0 + 5000) - 1288834974657n) << 22n);
  r.x.live.push({ url: `https://x.com/example/status/${id}`, text: "Posted by hand" });
  await assert.rejects(r.svc.postNow("known"), (e: any) => e.final === true && /already live at .*record-live/.test(e.message));
  assert.equal(r.x.clicks, 0);
  // record-live: the URL must be this account's status; the operator answers the card.
  assert.throws(() => r.svc.requestCard("record-live", "known", { by: "operator", url: `https://x.com/${"someone"}/status/123` }), /not https:\/\/x\.com\/example\/status/);
  assert.throws(() => r.svc.requestCard("record-live", "known", { by: "operator", url: "https://evil.example/example/status/123" }), /is not/);
  const url = `https://x.com/example/status/${id}`;
  const denied = await operator(r, "record-live", "known", { url, answer: "denied" });
  assert.equal(readDraft(p).status, "Ready");
  assert.match(denied.shown[0], new RegExp(url.replace(/[./]/g, "\\$&")));
  assert.match(denied.shown[0], /Posted by hand/);
  const done = await operator(r, "record-live", "known", { url });
  assert.match(done.told.join(), /Recorded part 1/);
  const d = readDraft(p);
  assert.equal(d.status, "Posted");
  assert.equal(d.postUrl, url);
  await assert.rejects(r.svc.postNow("known"), /already marked Posted/);
  // A thread: a record older than the part before it is refused, and a half-recorded thread continues from the next part.
  const t = r.write("thr", 'thread:\n  - "One"\n  - "Two"');
  await approve(r, "thr");
  await operator(r, "record-live", "thr", { url: `https://x.com/example/status/${id + 10n}` });
  assert.equal(readDraft(t).threadUrls.length, 1);
  assert.equal(readDraft(t).status, "Ready");
  assert.throws(() => r.svc.requestCard("record-live", "thr", { by: "operator", url: `https://x.com/example/status/${id}` }), /not newer/);
  // Bare domains cannot be matched on a live post (X turns them into links): refused at render.
  r.write("bare", 'text: "Read example.org/story today"');
  await assert.rejects(r.svc.dryRun("bare", { offline: true }), /link without a scheme \(example\.org\)/);
  r.write("scheme", 'text: "Read https://example.org/story today, mail me@example.org, see v2.0 and file.txt"');
  assert.match(await r.svc.dryRun("scheme", { offline: true }), /sizes/);
});

test("R5: a session command that does not resolve is reported (status flag), ~ expands, an absolute command works", async () => {
  const root = mkdtempSync(join(tmpdir(), "carl-post-r5-"));
  const bin = join(root, "ob"); writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  const acc = (command: string) => ({ main: { session: { command } } });
  assert.equal(sessionProblems(acc("overseer-browser"), {}).length, 1);
  assert.match(sessionProblems(acc("overseer-browser"), {})[0], /was not found on the PATH Carl started with.*absolute path/);
  assert.deepEqual(sessionProblems(acc("overseer-browser"), { "overseer-browser": bin }), []);
  assert.match(sessionProblems(acc(join(root, "missing")), {})[0], /not an executable file/);
  assert.deepEqual(sessionProblems(acc(bin), {}), []);
  writeFileSync(join(root, "plain"), "x", { mode: 0o644 });
  assert.equal(sessionProblems(acc(join(root, "plain")), {}).length, 1, "not executable");
  // ~ is expanded when the configuration loads.
  const home = mkdtempSync(join(tmpdir(), "carl-post-cfg5-"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { accounts: { main: { platform: "x", profile: "https://x.com/example", session: { command: "~/.local/bin/overseer-browser" } } } } }));
  assert.equal(loadConfig(home).post.accounts.main.session.command, join(homedir(), ".local", "bin", "overseer-browser"));
  assert.deepEqual(sessionPrograms({ a: { session: { command: "~/.local/bin/ob" } } }), { ob: join(homedir(), ".local", "bin", "ob") });
  // `carl post status` flags it.
  const r = rig();
  const svc = new PostService({ ...r.svc.deps, sessionProblems: () => sessionProblems(acc("overseer-browser"), {}) });
  assert.match(svc.status(), /^SESSION COMMAND PROBLEM: account "main"/);
  assert.doesNotMatch(r.svc.status(), /SESSION COMMAND PROBLEM/);
});

test("R6: a few seconds of clock difference between this machine and X does not reject a live post, and a rerun does not depend on clocks", async () => {
  // X's clock is 30 s behind this machine: the post's snowflake time is before the approval time.
  const r = rig({ skew: 30_000 });
  const p = r.write("skew", 'text: "Clocks differ"');
  await approve(r, "skew");
  await r.svc.postNow("skew");
  assert.equal(readDraft(p).status, "Posted", "the normal path accepts it");
  // The write-ahead record carries the profile's newest id before the click; the ledger keeps it too.
  const q = r.write("base", 'text: "Baseline"');
  await approve(r, "base");
  r.x.hideNew = true;
  await assert.rejects(r.svc.postNow("base"), /probably posted/);
  assert.match(String(readDraft(q).fields.pending_baseline), /^\d+$/);
  // The post then appears (X was slow); X's stamp is 30 s behind the click: the rerun finds it by the baseline.
  const id = ((BigInt(r.clock.now - 30_000) - 1288834974657n) << 22n) + 99n;
  r.x.live.push({ url: `https://x.com/example/status/${id}`, text: "Baseline" });
  r.x.hideNew = false;
  await r.svc.postNow("base");
  assert.equal(readDraft(q).postUrl, `https://x.com/example/status/${id}`);
  assert.equal(r.x.clicks, 2, "the rerun only looked");
});

test("R7: the agent cannot schedule inside 15 minutes, and the operator is told when it schedules", async () => {
  const r = rig();
  const notes: string[] = [];
  const svc = new PostService({ ...r.svc.deps, notify: (m) => { notes.push(m); } });
  r.write("lead", 'text: "Soon"');
  await svc.approve("lead", "alice"); await svc.dryRun("lead");
  const tool: any = carlTools({} as any, r.scheduler, { send: async () => "" }, svc).find((t) => t.name === "post_draft");
  await assert.rejects(tool.execute("id", { action: "schedule", name: "lead", at: new Date(T0 + 1000).toISOString() }), /at least 15 minutes away/);
  await assert.rejects(tool.execute("id", { action: "schedule", name: "lead", at: new Date(T0 + 14 * 60_000).toISOString() }), /at least 15 minutes away/);
  assert.equal(notes.length, 0);
  assert.match((await tool.execute("id", { action: "schedule", name: "lead", at: new Date(T0 + 16 * 60_000).toISOString() })).content[0].text, /Scheduled lead/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /agent scheduled lead/);
  // The operator is not held to the lead time.
  r.write("op", 'text: "Operator soon"');
  await svc.approve("op", "alice"); await svc.dryRun("op");
  await svc.schedule("op", new Date(T0 + 1000).toISOString());
});

test("R8: running a post job before its slot without force does nothing and changes no state; forced, it posts", async () => {
  const r = rig();
  r.write("early", 'text: "Not yet"');
  await approve(r, "early");
  const { job } = await r.svc.schedule("early", "2099-01-01T00:00:00Z");
  const s = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any, o: any) => r.svc.runScheduled(j, o) }, deliver: async () => { throw new Error("nothing should be delivered"); } } as any);
  for (let i = 0; i < 7; i++) await s.runNow(job.id); // more than the five attempts a failing job gets
  const j = s.get(job.id);
  assert.equal(j.enabled, true);
  assert.equal(j.attempts, undefined);
  assert.equal(j.lastStatus, undefined);
  assert.equal(j.lastRunAt, undefined);
  assert.equal(j.nextRunAt, Date.parse("2099-01-01T00:00:00Z"));
  assert.equal(r.x.clicks, 0);
  await s.runNow(job.id, { force: true });
  assert.equal(r.x.clicks, 1);
});

test("R9: a profile link that never drew is retryable; a different handle is final", async () => {
  const r = rig();
  r.write("slow", 'text: "Slow page"');
  await approve(r, "slow");
  r.x.noProfileLink = true;
  await assert.rejects(r.svc.postNow("slow"), (e: any) => e.final !== true && /did not show the signed-in account's profile link/.test(e.message));
  assert.equal(r.x.clicks, 0);
  r.x.noProfileLink = false; r.x.signedIn = "someone";
  await assert.rejects(r.svc.postNow("slow"), (e: any) => e.final === true && /not signed in to @example/.test(e.message));
});

test("R10: Carl's own ledger survives a stale editor save of the draft (no second click, no lost post)", async () => {
  const r = rig();
  const p = r.write("led", 'text: "Ledger"');
  await approve(r, "led");
  r.x.hideNew = true;
  await assert.rejects(r.svc.postNow("led"), /probably posted/);
  const ledger = join(r.home, "state", "post-ledger.jsonl");
  assert.match(readFileSync(ledger, "utf8"), /"event":"click"/);
  // An editor saves an older copy: the pending record is gone from the draft.
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { pending_part: undefined, pending_at: undefined, pending_baseline: undefined, last_error: undefined }));
  assert.equal(readDraft(p).pendingPart, undefined);
  await assert.rejects(r.svc.postNow("led"), /check @example's profile/);
  assert.equal(r.x.clicks, 1, "still only looked");
  // After a real post, a stale save drops the live record and the Posted status: the ledger puts them back, with no click.
  const q = r.write("led2", 'text: "Ledger two"');
  await approve(r, "led2");
  r.x.hideNew = false;
  await r.svc.postNow("led2");
  const url = readDraft(q).postUrl!;
  writeFileSync(q, setFields(readFileSync(q, "utf8"), { status: "Ready", thread_urls: undefined, post_url: undefined, part_hashes: undefined, posted_at: undefined }));
  const clicks = r.x.clicks;
  assert.match(await r.svc.postNow("led2"), /Posted led2/);
  assert.equal(r.x.clicks, clicks, "not posted twice");
  assert.equal(readDraft(q).postUrl, url);
  assert.equal(readDraft(q).status, "Posted");
});

test("Low: an adopted job is tracked, so a later removal by the CLI is noticed", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-adopt-"));
  const runners = { prompt: async () => "", builtin: {}, deliver: async () => {} } as any;
  const gateway = new Scheduler(home, log, runners);
  const cli = new Scheduler(home, log, runners, { passive: true });
  const job = cli.add({ name: "post a", when: "once 2099-01-01T00:00:00Z", post: { draft: "/tmp/a.md" }, deliver: "home" });
  (gateway as any).adoptExternal();
  assert.ok(gateway.list().some((j) => j.id === job.id), "adopted");
  cli.remove(job.id);
  (gateway as any).adoptExternal(); // before the gateway's own next save
  assert.equal(gateway.list().some((j) => j.id === job.id), false, "the removal is noticed, not undone");
});

test("Low: a lock is taken over only when its owner is dead, however old it is", async () => {
  const r = rig();
  const p = r.write("lock", 'text: "Locked"');
  await approve(r, "lock");
  const dir = join(r.home, "state", "post-locks"); mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${sha256(canon(p)).slice(0, 16)}.lock`);
  const { utimesSync } = await import("node:fs");
  writeFileSync(lock, `${process.pid} 0\n`);
  utimesSync(lock, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
  await assert.rejects(r.svc.postNow("lock"), /being posted by another run/);
  assert.equal(r.x.clicks, 0);
  // A dead owner's lock (any age) is taken over.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  writeFileSync(lock, `${dead} 0\n`);
  await r.svc.postNow("lock");
  assert.equal(r.x.clicks, 1);
});

test("Low: invisible characters are refused; a ZWJ emoji is not", async () => {
  const r = rig();
  for (const [name, ch] of [["ls", " "], ["ps", " "], ["zws", "​"], ["zwnj", "‌"], ["bom", "﻿"], ["word", "⁠"], ["shy", "­"], ["tag", "\u{e0041}"]] as const) {
    r.write(name, `text: ${JSON.stringify(`a${ch}b`).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)}`); // JSON-escaped: a raw U+2028 ends a "line" for the YAML reader's .
    await assert.rejects(r.svc.dryRun(name, { offline: true }), /control or bidirectional/, name);
  }
  assert.equal(visible("a b\u{e0041}"), "a\\u2028b\\ue0041");
  r.write("family", `text: ${JSON.stringify("Family \u{1F468}‍\u{1F469}‍\u{1F467}")}`);
  assert.match(await r.svc.dryRun("family", { offline: true }), /sizes/);
});

test("Low: a pending part cannot be re-approved with edited text; dropped thread text and a second skip flag are handled", async () => {
  const r = rig();
  const p = r.write("pend", 'text: "Original"');
  await approve(r, "pend");
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { pending_part: "0", pending_at: "2026-03-10T12:00:00.000Z" }).replace("Original", "Edited"));
  await assert.rejects(r.svc.approve("pend", "alice"), /settle it first/);
  assert.throws(() => r.svc.requestCard("approve", "pend", { by: "agent" }), /settle it first/);
  // A thread's first_reply, `## First reply` section or text would be dropped silently: refused.
  r.write("t1", 'thread:\n  - "One"\n  - "Two"\nfirst_reply: "Lost"');
  await assert.rejects(r.svc.dryRun("t1", { offline: true }), /`first_reply` would not be posted/);
  r.write("t2", 'thread:\n  - "One"\n  - "Two"', "## First reply\n\nLost");
  await assert.rejects(r.svc.dryRun("t2", { offline: true }), /First reply` section would not be posted/);
  r.write("t3", 'thread:\n  - "One"\n  - "Two"\ntext: "Lost"');
  await assert.rejects(r.svc.dryRun("t3", { offline: true }), /`text` .* would not be posted/);
  // A re-approval ends an earlier --skip-dry-run on the scheduled job.
  r.write("skip", 'text: "Skip"');
  await r.svc.approve("skip", "alice");
  const { job } = await r.svc.schedule("skip", "2026-03-10T14:00:00Z", { skipDryRun: true });
  assert.equal(r.scheduler.get(job.id).post!.skipDryRun, true);
  await r.svc.approve("skip", "alice");
  assert.equal(r.scheduler.get(job.id).post!.skipDryRun, undefined);
});

// ===================== Round 4: the third review (F1-F6 and the Lows) =====================

test("F1/B1: posting is refused unless every allowTools and operatorTools entry matches only verifiably read-only tools", async () => {
  const blocked = (allow: string[], op: string[] = [], extra: Record<string, unknown> = {}) =>
    postingBlockedReason({ accounts: { main: {} }, allowTools: allow.map((a) => [a, "x"] as [string, string]), operatorTools: op.map((a) => [a, "x"] as [string, string]), trustedMcp: ["overseer"], ...extra });
  for (const verb of ["send", "relay", "message", "job_add", "job_dispatch", "job_approve", "schedule_add", "open", "close", "decide", "job_note", "job_wake", "job_redrive", "job_reroute", "job_switch", "job_correct"])
    for (const prefix of ["overseer_", "coordinator_"]) assert.match(blocked([`^overseer/${prefix}${verb}$`])!, /Posting is OFF/, prefix + verb);
  // Broad patterns match a canary and fail closed, including the real server's prefix.
  for (const broad of [".*", "^overseer/.*", "^overseer/coordinator_.*", "^overseer/coordinator_(send|job_add)$|^overseer/coordinator_.*"]) assert.match(blocked([broad])!, /Posting is OFF/, broad);
  assert.match(blocked([".*"])!, /any future tool/);
  // operatorTools count (the quoted-words shortcut runs them unasked).
  assert.match(blocked([], ["^overseer/coordinator_job_add$"])!, /guard\.operatorTools/);
  // Read-only names pass; so does an empty config.
  assert.equal(blocked(["^overseer/coordinator_job_list$", "^overseer/coordinator_status$"]), undefined);
  assert.equal(blocked([], []), undefined);
  assert.equal(postingBlockedReason({ accounts: {}, allowTools: [[".*", "x"]], trustedMcp: [] }), undefined, "no accounts, nothing to refuse");
  // A listed tool without readOnlyHint is not verifiably read-only; with the hint it is.
  assert.match(blocked(["^overseer/coordinator_widget$"], [], { listed: ["overseer/coordinator_widget"], readOnly: new Set() })!, /coordinator_widget/);
  assert.equal(blocked(["^overseer/coordinator_widget$"], [], { listed: ["overseer/coordinator_widget"], readOnly: new Set(["overseer/coordinator_widget"]) }), undefined);
  // The hint cache round-trips and loadConfig reads it.
  const home = mkdtempSync(join(tmpdir(), "carl-post-f1-"));
  process.env.HOME = home;
  const acct = { platform: "x", profile: "https://x.com/example" };
  const conf = (guard: object, extra: object = {}) => writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", trustedMcp: ["overseer"], guard, post: { accounts: { main: acct } }, ...extra }));
  conf({ allowTools: [["^overseer/coordinator_(send|job_add)$", "queued work"]] });
  const cfg = loadConfig(home);
  assert.match(cfg.post.blocked!, /Posting is OFF/);
  assert.match(cfg.post.blocked!, /Remove that entry/);
  assert.match(cfg.post.blocked!, /coordinator_send/);
  mkdirSync(join(home, "state"), { recursive: true });
  writeReadOnlyCache(home, { "overseer/coordinator_widget": true, "overseer/coordinator_gadget": false });
  assert.deepEqual(readOnlyCache(home).listed.sort(), ["overseer/coordinator_gadget", "overseer/coordinator_widget"]);
  conf({ allowTools: [["^overseer/coordinator_widget$", "r"]] });
  assert.equal(loadConfig(home).post.blocked, undefined);
  conf({ allowTools: [["^overseer/coordinator_gadget$", "r"]] });
  assert.match(loadConfig(home).post.blocked!, /coordinator_gadget/);
  // B2: operatorTools in the real config, and the work module.
  conf({ operatorTools: [["^overseer/coordinator_(job_add|job_approve|job_dispatch)$", "x"]] });
  assert.match(loadConfig(home).post.blocked!, /guard\.operatorTools/);
  conf({}, { work: { command: ["/bin/true"] }, telegram: { enabled: true, token: "t", allowFrom: [1], groups: [{ chat: -5, work: { project: "p" } }] } });
  assert.match(loadConfig(home).post.blocked!, /work module/);
  conf({}, { work: { command: ["/bin/true"], sandboxed: true }, telegram: { enabled: true, token: "t", allowFrom: [1], groups: [{ chat: -5, work: { project: "p" } }] } });
  assert.equal(loadConfig(home).post.blocked, undefined);
  conf({}, { work: { command: ["/bin/true"] } });
  assert.equal(loadConfig(home).post.blocked, undefined, "no work group, no work_queue tool");
  // Every operation refuses, `status` says why, and the agent gets no post tool.
  const r = rig();
  const svc = new PostService({ ...r.svc.deps, config: { ...r.svc.deps.config, blocked: cfg.post.blocked } });
  r.write("off", 'text: "Hi"');
  for (const f of [() => svc.dryRun("off", { offline: true }), () => svc.postNow("off"), () => svc.approve("off", "alice"), () => svc.schedule("off", "2026-03-11T12:00:00Z")]) await assert.rejects(f(), /Posting is OFF/);
  assert.throws(() => svc.requestCard("approve", "off", { by: "operator" }), /Posting is OFF/);
  assert.match(svc.status(), /^POSTING IS OFF: Posting is OFF/);
  assert.equal(r.x.calls.length, 0);
});

test("B1: the built-in read-only list covers the real coordinator_ reads and the old overseer_ ones, and no dangerous verb", () => {
  const ro = (n: string) => DEFAULT_TRUSTED_READONLY.some(([src]) => new RegExp(src).test(`overseer/${n}`));
  for (const n of ["status", "job_list", "job_get", "events", "terminals", "digest", "schedule_list", "decisions_pending"])
    for (const p of ["coordinator_", "overseer_"]) assert.ok(ro(p + n), p + n);
  for (const t of UNSANDBOXED_TOOLS) assert.equal(ro(t), false, `${t} must not be read-only`);
  const rules = { trustedMcp: ["overseer"] };
  assert.equal(mcpVerdict("mcp__overseer__coordinator_job_list", rules).level, "ok");
  assert.equal(mcpVerdict("mcp__overseer__coordinator_relay", rules).level, "dangerous");
});

test("F1: the approval key is a 0600 file; the docs say plainly that an unsandboxed process of the user can read it", () => {
  const doc = readFileSync(new URL("../docs/POSTING.md", import.meta.url), "utf8");
  assert.match(doc, /unsandboxed process of the same user can read/i);
  assert.match(doc, /Keychain/);
});

test("F2: a failed write-ahead does not wedge the draft: the rerun clicks, and a lost pending record can be cleared by card", async () => {
  const r = rig();
  const p = r.write("wedge", 'text: "Wedge"');
  await approve(r, "wedge");
  const real = r.x.run;
  let tamper = true;
  const svc = new PostService({ ...r.svc.deps, run: async (cmd, args, o) => {
    const res = await real(cmd, args, o);
    if (tamper && args.some((a) => a.includes("composer not found"))) { tamper = false; writeFileSync(p, readFileSync(p, "utf8") + "\n"); }
    return res;
  } });
  await assert.rejects(svc.postNow("wedge"), /changed while it was being updated/);
  assert.equal(r.x.clicks, 0);
  assert.match(readFileSync(join(r.home, "state", "post-ledger.jsonl"), "utf8"), /"event":"cleared"/);
  // The edit voided nothing that matters (a blank line is not text): approve again and the rerun posts, with no clear-pending needed.
  await approve(r, "wedge");
  assert.match(await svc.postNow("wedge"), /Posted wedge/);
  assert.equal(r.x.clicks, 1);
  // A click whose pending record a stale save lost: the card still shows it and clear-pending works from the ledger alone.
  const q = r.write("lost", 'text: "Lost pending"');
  await approve(r, "lost");
  r.x.hideNew = true;
  await assert.rejects(r.svc.postNow("lost"), /probably posted/);
  writeFileSync(q, setFields(readFileSync(q, "utf8"), { pending_part: undefined, pending_at: undefined, pending_baseline: undefined, last_error: undefined }));
  assert.equal(readDraft(q).pendingPart, undefined);
  assert.match(r.svc.status(), /PENDING part 1/);
  const cleared = await operator(r, "clear-pending", "lost");
  assert.match(cleared.shown[0], /click on part 1 of lost\.md was started/);
  assert.match(cleared.told.join(), /Cleared the pending record/);
  r.x.hideNew = false;
  assert.match(await r.svc.postNow("lost"), /Posted lost/);
});

test("F2: a live dry run takes the draft's lock, so it cannot land in the middle of a post", async () => {
  const r = rig();
  r.write("busy", 'text: "Busy"');
  await approve(r, "busy");
  const real = r.x.run;
  let inner: Promise<string> | undefined;
  const svc = new PostService({ ...r.svc.deps, run: async (cmd, args, o) => {
    if (!inner && args.some((a) => a.includes("composer not found"))) inner = r.svc.dryRun("busy").catch((e) => String(e.message));
    return real(cmd, args, o);
  } });
  await svc.dryRun("busy");
  inner = undefined;
  await svc.postNow("busy");
  assert.match(String(await inner), /being posted by another run/);
});

test("F3: the pre-click look waits for the exact text, and an undrawn timeline refuses (retryable) instead of clicking", async () => {
  const r = rig();
  r.write("blind", 'text: "Blind"');
  await approve(r, "blind");
  r.x.unreadable = true;
  await assert.rejects(r.svc.postNow("blind"), (e: any) => e.final !== true && /did not draw.*nothing was clicked/.test(e.message));
  assert.equal(r.x.clicks, 0);
  r.x.unreadable = false; // an empty profile shown as X's own empty state is fine
  assert.match(await r.svc.postNow("blind"), /Posted blind/);
  const src = readFileSync(new URL("../src/post/adapters/x.ts", import.meta.url), "utf8");
  assert.match(src, /timelineOf\(ctx, session, handle, timelineUrl, text, 20\)/, "the pre-click look passes the text as `want`");
});

test("F4: a post card is not collapsed, shows who asked, is never dropped when long, and an agent's denied card is not asked again at once", async () => {
  const r = rig();
  r.write("who", 'text: "Who asked"');
  const asked = await operator(r, "approve", "who", { answer: "denied" });
  assert.match(asked.shown[0], /Asked by: you/);
  r.svc.requestCard("approve", "who", { by: "agent" });
  const agent = new CardDesk(r.svc, (text) => { agent.seen.push(text); return Promise.resolve({ answer: "denied" as const }); }, () => {}) as CardDesk & { seen: string[] };
  agent.seen = [];
  await agent.pump();
  assert.match(agent.seen[0], /Asked by: THE AGENT/);
  assert.throws(() => r.svc.requestCard("approve", "who", { by: "agent" }), /denied this request .* not asked again/);
  r.clock.now += 7 * 3600_000;
  assert.match(r.svc.requestCard("approve", "who", { by: "agent" }), /Asked/);
  const tg = readFileSync(new URL("../src/channels/telegram.ts", import.meta.url), "utf8");
  const card = tg.slice(tg.indexOf("async requestCard("), tg.indexOf("private async requestApprovalSetup"));
  assert.doesNotMatch(card, /expandable/);
  assert.doesNotMatch(card, /too long to review/);
  const long = Array.from({ length: 40 }, (_, i) => `[${i + 1}] ${"word ".repeat(40)}`).join("\n\n");
  const pieces = splitCard(long, 3000);
  assert.ok(pieces.length > 1 && pieces.every((x) => x.length <= 3000));
  assert.equal(pieces.join("\n\n").replace(/\s+/g, ""), long.replace(/\s+/g, ""), "nothing is lost");
});

test("F5: a card whose message could not be sent is shown again after a back-off, not stranded", async () => {
  const r = rig();
  r.write("flaky", 'text: "Flaky"');
  r.svc.requestCard("approve", "flaky", { by: "operator" });
  let sends = 0; const told: string[] = [];
  const desk = new CardDesk(r.svc, () => { sends++; return sends === 1 ? Promise.reject(new Error("telegram down")) : Promise.resolve({ answer: "approved" as const, by: "4242" }); }, (m) => { told.push(m); });
  await desk.pump();
  assert.equal(sends, 1);
  assert.match(told[0], /could not be shown/);
  await desk.pump();
  assert.equal(sends, 1, "backed off");
  r.clock.now += 61_000;
  await desk.pump();
  assert.equal(sends, 2);
  assert.match(readDraft(join(r.draftsDir, "flaky.md")).approved!, /^operator 4242 /);
});

test("F6: the ledger's hashes are checked: a part live with other text is refused everywhere, and a repost of the same text is not 'Posted'", async () => {
  const r = rig();
  const p = r.write("thr6", 'thread:\n  - "One"\n  - "Two"\n  - "Three"');
  await approve(r, "thr6");
  r.x.failList = undefined;
  // Parts 1 and 2 go live; then the run stops at part 3.
  const real = r.x.run;
  let clicks = 0;
  const svc = new PostService({ ...r.svc.deps, run: async (c, a, o) => { if (a.some((x) => x.includes("clicked: button")) && ++clicks === 3) return { code: 1, stdout: JSON.stringify({ ok: false, error: "timeout" }), stderr: "" }; return real(c, a, o); } });
  await assert.rejects(svc.postNow("thr6"), /may be live/);
  // A stale save drops part_hashes and the pending record, then part 2 is edited and approved again.
  writeFileSync(p, setFields(readFileSync(p, "utf8"), { part_hashes: undefined, pending_part: undefined, pending_at: undefined, pending_baseline: undefined }));
  let text = readFileSync(p, "utf8").replace('"Two"', '"Two edited"');
  writeFileSync(p, text);
  await assert.rejects(r.svc.approve("thr6", "alice"), /part 2 went live with different text/);
  assert.throws(() => r.svc.requestCard("approve", "thr6", { by: "operator" }), /part 2 went live with different text/);
  await assert.rejects(r.svc.postNow("thr6"), /edited after it was approved/);
  // Reposting identical text from the same path under a new approval is refused, not marked Posted with the old URL.
  const q = r.write("again", 'text: "Same text"');
  await approve(r, "again");
  await r.svc.postNow("again");
  const clicksBefore = r.x.clicks;
  writeFileSync(q, `---\nplatform: x\naccount: main\ntext: "Same text"\n---\n`);
  r.clock.now += 60_000;
  await r.svc.approve("again", "alice"); await r.svc.dryRun("again");
  await assert.rejects(r.svc.postNow("again"), /earlier approval.*save the draft under a new name/s);
  assert.equal(r.x.clicks, clicksBefore);
  assert.equal(readDraft(q).status, "Ready");
});

test("Low: approve is bound to the hash the card was described with, not a fresh read", () => {
  const src = readFileSync(new URL("../src/post/service.ts", import.meta.url), "utf8");
  assert.match(src, /this\.approve\(path, by, now\.hash\)/);
  assert.doesNotMatch(src, /this\.approve\(path, by, readDraft/);
});

test("Low: an unreadable ledger is an error, not an empty ledger", async () => {
  const r = rig();
  r.write("badled", 'text: "Bad ledger"');
  await approve(r, "badled");
  mkdirSync(join(r.home, "state", "post-ledger.jsonl"), { recursive: true }); // reading a directory fails with EISDIR
  await assert.rejects(r.svc.postNow("badled"), /cannot be read/);
  assert.equal(r.x.clicks, 0);
});

test("Low: the approval is bound to the draft's path", async () => {
  const r = rig();
  const p = r.write("orig", 'text: "Bound"');
  await r.svc.approve("orig", "alice");
  const copy = join(r.draftsDir, "copy.md");
  writeFileSync(copy, readFileSync(p, "utf8"));
  assert.match(r.svc.problem(readDraft(copy))!, /edited after it was approved/);
  assert.equal(r.svc.problem(readDraft(p)), undefined);
});

test("Low: the agent cannot remove or pause an operator's post job, and cannot schedule without the operator being told", async () => {
  const r = rig();
  const tools = carlTools({} as any, r.scheduler, { send: async () => "" }, r.svc);
  const sched: any = tools.find((t) => t.name === "schedule");
  r.write("keep", 'text: "Keep"');
  await approve(r, "keep");
  await r.svc.schedule("keep", "2026-03-11T12:00:00Z");
  const id = r.scheduler.list().find((j) => j.post)!.id;
  await assert.rejects(sched.execute("id", { action: "remove", id }), /only the operator can remove it/);
  await assert.rejects(sched.execute("id", { action: "pause", id }), /only the operator can pause or resume it/);
  assert.equal(r.scheduler.list().filter((j) => j.post && j.enabled).length, 1);
  // A notice that cannot be delivered means no slot.
  r.write("tell", 'text: "Tell"');
  await approve(r, "tell");
  const svc = new PostService({ ...r.svc.deps, notify: async () => { throw new Error("telegram down"); } });
  await assert.rejects(svc.schedule("tell", "2026-03-11T12:00:00Z", { agent: true }), /could not be told.*not kept/);
  assert.equal(r.scheduler.list().filter((j) => j.post && j.enabled && j.post.draft.endsWith("tell.md")).length, 0);
  assert.notEqual(readDraft(join(r.draftsDir, "tell.md")).status, "Scheduled");
});

test("Low: a relay descriptor that changed since Carl started refuses posting; the default descriptor is closed even when the environment names another", async () => {
  const r = rig();
  r.write("relay", 'text: "Relay"');
  await approve(r, "relay");
  mkdirSync(join(r.home, ".config", "overseer-browser"), { recursive: true });
  writeFileSync(join(r.home, ".config", "overseer-browser", "active-connection.json"), JSON.stringify({ version: 1, runtime_root: join(r.home, ".osr-new") }));
  await assert.rejects(r.svc.postNow("relay"), /relay descriptor changed since Carl started/);
  await assert.rejects(r.svc.dryRun("relay"), /relay descriptor changed/);
  assert.equal(r.x.clicks, 0);
  const home = mkdtempSync(join(tmpdir(), "carl-post-env-"));
  mkdirSync(join(home, ".config", "overseer-browser"), { recursive: true });
  writeFileSync(join(home, ".config", "overseer-browser", "active-connection.json"), JSON.stringify({ version: 1, runtime_root: join(home, ".osr-default") }));
  writeFileSync(join(home, "other.json"), JSON.stringify({ version: 1, runtime_root: join(home, ".osr-env") }));
  const dirs = browserControlDirs({ main: ACCOUNT }, { OVERSEER_BROWSER_CONNECTION: join(home, "other.json") }, home);
  assert.ok(dirs.some((d) => d.endsWith(".osr-default")), "what the posting child sees (no OVERSEER_* in its environment) is closed");
  assert.ok(dirs.some((d) => d.endsWith(".osr-env")));
});

test("Low: the sandbox refuses the approval key by name anywhere and the loopback debug port while posting is configured", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-post-sb-"));
  process.env.HOME = home;
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b", post: { accounts: { main: { platform: "x", profile: "https://x.com/example" } } } }));
  const profile = buildProfile(loadConfig(home));
  assert.ok(profile.includes('(deny file-read* (regex #"/post-approval\\.key$"))'));
  assert.ok(profile.includes('(deny network-outbound (remote ip "localhost:9222"))'));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/b" }));
  assert.ok(!buildProfile(loadConfig(home)).includes("9222"));
});

// ===================== Round 5: the fourth review (B1-B3 and the F2-F6 leftovers) =====================

test("B3: the operator notice goes straight to Telegram with no queue, so a failing channel leaves no slot", async () => {
  const { Gateway } = await import("../src/gateway.ts");
  const queued: unknown[] = [];
  const failing = { sendMarkdown: async () => { throw new Error("Telegram sendMessage failed (500): down"); }, enqueue: (...a: unknown[]) => { queued.push(a); } };
  const fake = { telegram: failing, cfg: { telegram: { homeChat: 77 } } };
  const sendDirect = (Gateway.prototype as any).sendDirect;
  await assert.rejects(sendDirect.call(fake, "home", "notice"), /down/);
  assert.equal(queued.length, 0, "a failed notice is never queued behind the slot");
  await assert.rejects(sendDirect.call({ ...fake, cfg: { telegram: {} } }, "home", "n"), /homeChat/);
  // ...and the service removes the slot when that notice throws.
  const r = rig();
  r.write("b3", 'text: "B3"');
  await approve(r, "b3");
  const svc = new PostService({ ...r.svc.deps, notify: (m) => sendDirect.call(fake, "home", m) });
  await assert.rejects(svc.schedule("b3", "2026-03-11T12:00:00Z", { agent: true }), /could not be told.*not kept/);
  assert.equal(r.scheduler.list().filter((j) => j.post && j.enabled).length, 0);
});

test("F5: a permanent Telegram refusal of a card stops the retries and says so once", async () => {
  const { TelegramError } = await import("../src/channels/telegram-api.ts");
  const r = rig();
  r.write("perm", 'text: "Perm"');
  await approve(r, "perm");
  r.svc.requestCard("approve", "perm", { by: "operator" });
  const told: string[] = []; let tries = 0;
  const desk = new CardDesk(r.svc, () => { tries++; return Promise.reject(new TelegramError("sendMessage", 400, "Bad Request: chat not found")); }, (m) => told.push(m));
  await desk.pump();
  await desk.pump();
  assert.equal(tries, 1, "no retry");
  assert.equal(told.length, 1);
  assert.match(told[0], /could not be delivered and will not be retried/);
  assert.equal(new CardStore(r.home).list().length, 0, "the card is dropped");
});

test("F6: the clear-pending card does not promise a re-click; the recoverBlock message names a way out", async () => {
  const svc = readFileSync(new URL("../src/post/service.ts", import.meta.url), "utf8");
  assert.match(svc, /looks for the part on the profile first and clicks Post for it only if it is not there/);
  assert.doesNotMatch(svc, /Clearing lets Carl click Post for it again/);
  assert.match(svc, /thread_urls \(comma-separated, in order\)/);
});

test("docs: POSTING.md states the structural rule, names the real tools and has one agent-permissions paragraph", () => {
  const doc = readFileSync(new URL("../docs/POSTING.md", import.meta.url), "utf8");
  assert.match(doc, /readOnlyHint: true/);
  assert.match(doc, /coordinator_/);
  assert.match(doc, /guard\.operatorTools/);
  assert.match(doc, /work\.command/);
  assert.equal(doc.split("request** an approval card").length, 2, "the duplicate paragraph is gone");
  assert.doesNotMatch(doc, /never clicked\./);
  assert.doesNotMatch(doc, /OverSeer\s+MCP server/);
});
