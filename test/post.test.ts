// The post primitive: contract steps, the approval gate, scheduling with a missed-slot policy, idempotent resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";
import { defaultRegistry } from "../src/post/registry.ts";
import { approvalProblem } from "../src/post/service.ts";
import { readDraft, setFields } from "../src/post/draft.ts";
import { PostService } from "../src/post/service.ts";
import { postCommand, type PostCliIo } from "../src/post/cli.ts";
import { xLength } from "../src/post/adapters/x.ts";
import { carlTools } from "../src/tools.ts";
import { loadConfig } from "../src/config.ts";
import { type FakeX, fakeX } from "./post-fake.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} } as any;
const T0 = Date.parse("2026-03-10T12:00:00Z");
const ACCOUNT = { platform: "x", profile: "https://x.com/example", session: { command: "overseer-browser", timeoutSeconds: 75, namePrefix: "carl-post" } };

function rig(opts: { retex?: FakeX["retex"]; now?: number; window?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "carl-post-"));
  process.env.HOME = home;
  const draftsDir = join(home, "posts");
  mkdirSync(draftsDir, { recursive: true });
  const x = fakeX({ retex: opts.retex });
  const clock = { now: opts.now ?? T0 };
  const scheduler = new Scheduler(home, log, { prompt: async () => "", builtin: {}, deliver: async () => {} } as any);
  const svc = new PostService({
    home, run: x.run, registry: defaultRegistry(), scheduler, now: () => clock.now, sleep: async () => {}, id: () => "t1",
    config: { draftsDir, missedWindowMinutes: opts.window ?? 180, retex: "auto", accounts: { main: ACCOUNT } },
  });
  const write = (name: string, front: string, body = "") => { const p = join(draftsDir, `${name}.md`); writeFileSync(p, `---\nplatform: x\naccount: main\n${front}\n---\n${body}`); return p; };
  return { home, draftsDir, x, clock, scheduler, svc, write };
}
const approve = (r: ReturnType<typeof rig>, name: string) => r.svc.approve(name, "alice");
const posted = (x: FakeX) => x.live.length;

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
  assert.equal(approvalProblem(readDraft(p)), undefined);
  for (const [from, to] of [['text: "original"', 'text: "changed"'], ['text: "original"', 'text: "original"\nreply: "new reply"'], ['text: "original"', 'thread:\n  - "a"\n  - "b"']] as const) {
    const before = readFileSync(p, "utf8");
    writeFileSync(p, before.replace(from, to));
    assert.match(approvalProblem(readDraft(p))!, /edited after it was approved/);
    await assert.rejects(r.svc.postNow("edit"), /edited after it was approved/);
    await assert.rejects(r.svc.schedule("edit", "2026-03-11T12:00:00Z"), /edited after it was approved/);
    writeFileSync(p, before);
    assert.equal(approvalProblem(readDraft(p)), undefined, "restoring the text restores the approval");
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

test("a thread that died mid-way resumes from the profile check and never double-posts", async () => {
  const r = rig();
  const p = r.write("thr", 'thread:\n  - "Part one."\n  - "Part two."\n  - "Part three."');
  await approve(r, "thr");
  // Part 2 goes live, then the call that would find its URL fails: the run dies before recording it.
  r.x.failFind = (n) => n === 4; // finds: p1 check, p1 url, p2 check, p2 url (4th)
  await assert.rejects(r.svc.postNow("thr"), /overseer-browser eval failed/);
  assert.deepEqual(r.x.live.map((l) => l.text), ["Part one.", "Part two."]);
  let d = readDraft(p);
  assert.equal(d.threadUrls.length, 1, "only part 1 was recorded");
  assert.equal(d.status, "Ready");
  // The rerun finds part 2 on the profile, records it, and posts only part 3.
  r.x.failFind = undefined;
  const out = await r.svc.postNow("thr");
  assert.deepEqual(r.x.live.map((l) => l.text), ["Part one.", "Part two.", "Part three."]);
  assert.equal(r.x.clicks, 3, "each part was clicked exactly once across both runs");
  d = readDraft(p);
  assert.equal(d.status, "Posted");
  assert.deepEqual(d.threadUrls, r.x.live.map((l) => l.url));
  assert.match(out, /resumed after 1 part/);
  // The same draft rerun after a part is live but before it was recorded, from scratch on part 1:
  const q = r.write("thr2", 'thread:\n  - "Alpha."\n  - "Beta."');
  await approve(r, "thr2");
  r.x.live.push({ url: "https://x.com/example/status/1", text: "Alpha." });
  await r.svc.postNow("thr2");
  assert.equal(r.x.live.filter((l) => l.text === "Alpha.").length, 1, "part 1 was already live and not posted again");
  assert.equal(readDraft(q).threadUrls[0], "https://x.com/example/status/1");
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
  const { job } = await r.svc.schedule("miss", "2026-03-10T14:00:00Z");
  r.clock.now = Date.parse("2026-03-10T18:30:00Z"); // 4 h 30 min late; the window is 3 h
  const delivered: string[] = [];
  const s = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any) => r.svc.runScheduled(j) }, deliver: async (_j: any, t: string) => { delivered.push(t); } } as any);
  await s.runNow(job.id);
  assert.equal(posted(r.x), 0);
  assert.equal(r.x.calls.filter((c) => !c.startsWith("retex")).length, 0, "the platform was never contacted");
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
  r.x.failFind = (n) => n === 4;
  const s = new Scheduler(r.home, log, { prompt: async () => "", builtin: { post: (j: any) => r.svc.runScheduled(j) }, deliver: async () => {} } as any);
  await s.runNow(job.id);
  assert.equal(s.get(job.id).lastStatus, "error");
  assert.ok(s.get(job.id).nextRunAt! > Date.now(), "a failed post is retried, not dropped");
  assert.equal(s.get(job.id).enabled, true);
  r.x.failFind = undefined;
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
  assert.doesNotMatch(props, /approv/i);
  assert.deepEqual((tool.parameters.properties.action.anyOf as { const: string }[]).map((a) => a.const).sort(), ["draft", "dry_run", "schedule", "status"]);
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
  assert.match((await run({ action: "schedule", name: "agent-one", at: "2026-03-11T12:00:00Z" })).content[0].text, /Scheduled agent-one/);
  assert.match((await run({ action: "status" })).content[0].text, /agent-one/);
  assert.equal(carlTools({} as any, r.scheduler, { send: async () => "" }).some((t) => t.name === "post_draft"), false, "no accounts, no tool");
});

test("the CLI: approve is operator-only (needs a terminal and a yes), now/schedule/dry-run/status work", async () => {
  const r = rig();
  r.write("cli", 'text: "From the CLI"');
  const out: string[] = []; const err: string[] = [];
  let tty = false; let yes = true;
  const io: PostCliIo = { isTTY: () => tty, confirm: async () => yes, out: (s) => out.push(s), err: (s) => err.push(s) };
  const run = (...a: string[]) => postCommand(a, io, () => r.svc);
  assert.equal(await run("approve", "cli"), 2);
  assert.match(err.join("\n"), /operator-only/);
  assert.equal(await run("now", "cli"), 2);
  assert.match(err.join("\n"), /no operator approval/);
  tty = true; yes = false;
  assert.equal(await run("approve", "cli"), 1);
  assert.equal(readDraft(join(r.draftsDir, "cli.md")).approved, undefined);
  yes = true;
  assert.equal(await run("approve", "cli", "--by", "alice"), 0);
  assert.match(readDraft(join(r.draftsDir, "cli.md")).approved!, /^alice 2026-03-10T12:00:00/);
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
