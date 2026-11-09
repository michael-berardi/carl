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
