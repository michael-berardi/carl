// A gateway stop or restart never fails a running schedule: the job is recorded as interrupted (not an error, nothing
// delivered), and runs once more at the next start. A signal death is named, never "exit null".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} } as any;
const sandbox = (home: string) => ({ wrap: (a: string[]) => a, env: { PATH: "/usr/bin:/bin", HOME: home } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(home: string, sent: string[], extra: Record<string, unknown> = {}) {
  return new Scheduler(home, log, {
    prompt: async () => "", builtin: {}, deliver: async (_j: unknown, t: string) => { sent.push(t); },
    commandSandbox: () => sandbox(home), ...extra,
  } as any);
}

test("a command job stopped by the gateway shutting down is interrupted, not failed, and nothing is delivered", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const sent: string[] = [];
  const s = make(home, sent);
  const job = s.add({ name: "render", when: "@daily", command: "sleep 30", deliver: "home" });
  const run = s.runNow(job.id);
  await wait(300);
  await s.stop("SIGTERM", 500);
  await run;
  const j = s.get(job.id);
  assert.equal(j.lastStatus, "interrupted");
  assert.match(j.lastError ?? "", /interrupted by restart/);
  assert.doesNotMatch(j.lastError ?? "", /exit null/);
  assert.deepEqual(sent, []);
  const saved = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8")).jobs[0];
  assert.equal(saved.lastStatus, "interrupted");
});

test("a command that finishes inside the grace completes normally", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const sent: string[] = [];
  const s = make(home, sent);
  const job = s.add({ name: "quick", when: "@daily", command: "sleep 0.5; echo done", deliver: "home" });
  const run = s.runNow(job.id);
  await wait(200);
  await s.stop("SIGTERM", 5_000);
  await run;
  assert.equal(s.get(job.id).lastStatus, "ok");
  assert.deepEqual(sent, ["done"]);
});

test("an interrupted job runs once at the next start, even when its slot is far off", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const s = make(home, []);
  const job = s.add({ name: "render", when: "30 8 * * *", command: "true", deliver: "home" });
  const file = join(home, "schedules.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(raw.jobs[0], { lastStatus: "interrupted", lastRunAt: Date.now() - 60_000, nextRunAt: Date.now() + 20 * 3_600_000 });
  writeFileSync(file, JSON.stringify(raw));
  const again = make(home, []);
  assert.ok(again.get(job.id).nextRunAt! <= Date.now() + 1_000);
});

test("a job found 'running' after a hard kill is also rerun once, and not a failure", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const s = make(home, []);
  const job = s.add({ name: "render", when: "30 8 * * *", command: "true", deliver: "home" });
  const file = join(home, "schedules.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(raw.jobs[0], { lastStatus: "running", lastRunAt: Date.now() - 60_000 });
  writeFileSync(file, JSON.stringify(raw));
  const again = make(home, []);
  const j = again.get(job.id);
  assert.equal(j.lastStatus, "interrupted");
  assert.ok(j.nextRunAt! <= Date.now() + 1_000);
});

test("a prompt job aborted by the shutdown is interrupted and rerun, not reported failed", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const sent: string[] = [];
  let release!: (e: Error) => void;
  const s = make(home, sent, { prompt: () => new Promise<string>((_, no) => { release = no; }) });
  const job = s.add({ name: "check", when: "every 20m", prompt: "go", deliver: "home" });
  const run = s.runNow(job.id);
  await wait(100);
  const stopping = s.stop("SIGTERM", 200);
  release(new Error("aborted"));
  await stopping; await run;
  assert.equal(s.get(job.id).lastStatus, "interrupted");
  assert.deepEqual(sent, []);
  const again = make(home, []);
  assert.ok(again.get(job.id).nextRunAt! <= Date.now() + 1_000);
});

test("a command killed by a signal names the signal, never 'exit null'", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const sent: string[] = [];
  const s = make(home, sent);
  const job = s.add({ name: "boom", when: "@daily", command: "kill -TERM $$", deliver: "home" });
  await s.runNow(job.id);
  const j = s.get(job.id);
  assert.equal(j.lastStatus, "error");
  assert.match(j.lastError ?? "", /SIGTERM/);
  assert.doesNotMatch(j.lastError ?? "", /null/);
});

test("an interrupted job that is interrupted again on its rerun is not rerun forever", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const s = make(home, []);
  const job = s.add({ name: "render", when: "30 8 * * *", command: "true", deliver: "home" });
  const file = join(home, "schedules.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(raw.jobs[0], { lastStatus: "interrupted", resumed: true, lastRunAt: Date.now() - 60_000 });
  writeFileSync(file, JSON.stringify(raw));
  const again = make(home, []);
  assert.ok(again.get(job.id).nextRunAt! > Date.now() + 60_000);
});

test("a restart note is not a failure: the rerun clears it, and only an error carries last_error to UltraTerm", async () => {
  // Live 2026-11-19: a Carl update interrupted the queue check; its rerun kept "interrupted by restart (SIGTERM)" in
  // lastError while running, and UltraTerm's rail counted any last_error as "1 schedule failed".
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const s = make(home, []);
  const job = s.add({ name: "check", when: "@daily", command: "sleep 1", deliver: "home" });
  const file = join(home, "schedules.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(raw.jobs[0], { lastStatus: "interrupted", lastError: "interrupted by restart (SIGTERM)" });
  writeFileSync(file, JSON.stringify(raw));
  const again = make(home, []);
  const run = again.runNow(job.id);
  await wait(200);
  assert.equal(again.get(job.id).lastStatus, "running");
  assert.equal(again.get(job.id).lastError, undefined);
  await run;
  assert.equal(again.get(job.id).lastStatus, "ok");
  await again.stop("SIGTERM", 500);
  const src = readFileSync(new URL("../src/compat/ultraterm.ts", import.meta.url), "utf8");
  assert.match(src, /last_error: j\.lastStatus === "error" \? \(j\.lastError \?\? null\) : null/);
});

test("a running job's next run is the following slot, never the slot it already started", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const s = make(home, []);
  const job = s.add({ name: "render", when: "every 1h", command: "sleep 30", deliver: "home" });
  // The slot came due a minute ago and the tick picks it up now, as at 08:30 every day.
  const slot = Date.now() - 60_000;
  const file = join(home, "schedules.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(raw.jobs[0], { nextRunAt: slot, lastRunAt: slot - 3_600_000, lastStatus: "ok" });
  writeFileSync(file, JSON.stringify(raw));
  const fresh = make(home, []);
  const started = Date.now();
  const run = fresh.runNow(job.id);
  await wait(300);
  const during = fresh.get(job.id);
  assert.equal(during.lastStatus, "running");
  assert.ok((during.nextRunAt ?? 0) > started, `next run ${during.nextRunAt} is after the run started (${started}), not the slot it took (${slot})`);
  const saved = JSON.parse(readFileSync(file, "utf8")).jobs[0];
  assert.ok(saved.nextRunAt > started, "the saved file, which UltraTerm reads, has the following slot too");
  await fresh.stop("SIGTERM", 200);
  await run;
});

test("a one-time job still disables itself after its run", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const s = make(home, []);
  const job = s.add({ name: "once", when: `once ${new Date(Date.now() + 3_600_000).toISOString()}`, command: "true", deliver: "none" });
  await s.runNow(job.id);
  const j = s.get(job.id);
  assert.equal(j.lastStatus, "ok");
  assert.equal(j.enabled, false);
  assert.equal(j.nextRunAt, undefined);
});

test("a run that outlasts its interval moves its next run on instead of leaving a past slot", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-int-"));
  const s = make(home, []);
  const job = s.add({ name: "slow", when: "every 1m", command: "sleep 30", deliver: "none" });
  const run = s.runNow(job.id);
  await wait(300);
  // The run is still going when its next slot comes due (a minute passes): simulate that slot being in the past.
  (s as any).find(job.id).nextRunAt = Date.now() - 20 * 60_000;
  await (s as any).tick();
  const after = s.get(job.id);
  assert.equal(after.lastStatus, "running", "still the one run; the passed slot did not start a second one");
  assert.ok((after.nextRunAt ?? 0) > Date.now(), "the next run is ahead again");
  const saved = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8")).jobs[0];
  assert.ok(saved.nextRunAt > Date.now(), "and UltraTerm, reading the file, sees it ahead");
  await s.stop("SIGTERM", 200);
  await run;
});
