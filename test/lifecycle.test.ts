import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";
import { Log } from "../src/log.ts";
import { sweepCallFolders } from "../src/providers/claude-code.ts";
import { ConfigError, loadConfig } from "../src/config.ts";

test("a built-in paused for UltraTerm learning keeps its edits and comes back when Carl learns again", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-sched-"));
  const runners = { prompt: async () => "", builtin: { individuation: async () => "" }, deliver: async () => {} };
  const s = new Scheduler(home, new Log(join(home, "log")), runners);
  s.ensureBuiltin("individuation", "Individuation", "40 5 * * *");
  s.pauseBuiltin("individuation", "learning");
  let job = s.list().find((j) => j.builtin === "individuation")!;
  assert.equal(job.enabled, false);
  assert.equal(job.when, "40 5 * * *");
  const again = new Scheduler(home, new Log(join(home, "log")), runners); // persisted
  again.ensureBuiltin("individuation", "Individuation", "40 5 * * *");
  job = again.list().find((j) => j.builtin === "individuation")!;
  assert.equal(job.enabled, true);
  assert.equal(job.pausedBy, undefined);
});

test("only per-call Claude folders older than an hour are swept", () => {
  const root = mkdtempSync(join(tmpdir(), "carl-sweep-"));
  const old = join(root, "carl-claude-old"), fresh = join(root, "carl-claude-new"), other = join(root, "keep-me");
  for (const d of [old, fresh, other]) { mkdirSync(d); writeFileSync(join(d, "system.md"), "x"); }
  const past = (Date.now() - 2 * 3_600_000) / 1000;
  utimesSync(old, past, past);
  utimesSync(other, past, past);
  assert.equal(sweepCallFolders(root), 1);
  assert.ok(!existsSync(old) && existsSync(fresh) && existsSync(other));
  assert.equal(sweepCallFolders(join(root, "missing")), 0);
});

test("a bad learning value is a config error (exit 78), not a crash", () => {
  const h = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(h, "carl.json"), JSON.stringify({ learning: "dreams" }));
  assert.throws(() => loadConfig(h), (e: Error) => e instanceof ConfigError);
});

test("a built-in resumed after a learning pause waits for its next slot instead of running at once", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-sched-"));
  const runners = { prompt: async () => "", builtin: { individuation: async () => "" }, deliver: async () => {} };
  const s = new Scheduler(home, new Log(join(home, "log")), runners);
  s.ensureBuiltin("individuation", "Individuation", "40 5 * * *");
  s.pauseBuiltin("individuation", "learning");
  const raw = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8"));
  raw.jobs[0].nextRunAt = Date.now() - 86_400_000; // a slot that passed while paused
  writeFileSync(join(home, "schedules.json"), JSON.stringify(raw));
  const again = new Scheduler(home, new Log(join(home, "log")), runners);
  again.ensureBuiltin("individuation", "Individuation", "40 5 * * *");
  assert.ok(again.list()[0].nextRunAt! > Date.now());
});

test("an operator's unsandboxed command schedule skips the shell sandbox but keeps the clean environment; others stay wrapped", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-sched-"));
  const delivered = new Map<string, string>();
  const runners = {
    prompt: async () => "", builtin: {}, deliver: async (job: { name: string }, text: string) => { delivered.set(job.name, text); },
    commandSandbox: () => ({ wrap: (argv: string[]) => ["/usr/bin/env", "WRAPPED=1", ...argv], env: { PATH: "/usr/bin:/bin", ONLY: "clean", HOME: home } }),
  };
  const s = new Scheduler(home, new Log(join(home, "log")), runners as never);
  const cmd = 'echo "wrapped=${WRAPPED:-0} only=${ONLY:-}"';
  const plain = s.add({ name: "plain", when: "@daily", command: cmd, deliver: "home" });
  const operator = s.add({ name: "operator", when: "@daily", command: cmd, deliver: "home" });
  // Only the operator sets the flag (schedules.json or the portal); add() has no way to.
  const file = join(home, "schedules.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.jobs.find((j: { id: string }) => j.id === operator.id).unsandboxed = true;
  writeFileSync(file, JSON.stringify(raw));
  const again = new Scheduler(home, new Log(join(home, "log")), runners as never);
  await again.runNow(plain.id);
  await again.runNow(operator.id);
  assert.equal(delivered.get("plain"), "wrapped=1 only=clean");
  assert.equal(delivered.get("operator"), "wrapped=0 only=clean");
  assert.equal(again.get(operator.id).lastStatus, "ok");
});

test("a run a restart cut short is reported once, and its command is stopped instead of finishing unobserved", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-sched-"));
  // A command that is running in its own process group, like a command schedule.
  const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  const pid = child.pid!;
  const delivered: { name: string; text: string; id?: string }[] = [];
  const runners = {
    prompt: async () => "", builtin: {},
    deliver: async (job: { name: string }, text: string, id?: string) => { delivered.push({ name: job.name, text, id }); },
  };
  writeFileSync(join(home, "schedules.json"), JSON.stringify({
    jobs: [{
      id: "j-run", name: "marker job", when: "every 1m", command: "sleep 30", deliver: "home", enabled: true,
      createdAt: new Date().toISOString(), lastStatus: "running", lastRunAt: Date.now() - 5_000,
      runStartedAt: Date.now() - 5_000, runPid: pid, runKind: "command",
    }],
  }, null, 2));

  // A plain command (carl schedules) must not touch the running job.
  const cli = new Scheduler(home, new Log(join(home, "log")), runners as never);
  assert.equal(cli.get("j-run").lastStatus, "error");
  assert.equal(JSON.parse(readFileSync(join(home, "schedules.json"), "utf8")).jobs[0].lastStatus, "running", "the file is left alone");
  assert.ok(process.kill(-pid, 0) === undefined || true); // the group is still there

  // The gateway comes back: it stops the command and tells the operator.
  const gw = new Scheduler(home, new Log(join(home, "log")), runners as never, { recover: true });
  const onDisk = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8")).jobs[0];
  assert.equal(onDisk.lastStatus, "error", "the interrupted run is marked on disk");
  assert.equal(onDisk.lastError, "interrupted by a restart");
  assert.equal(onDisk.runPid, undefined, "the run is over");
  await new Promise((r) => setTimeout(r, 500));
  let alive = true;
  try { process.kill(-pid, 0); } catch { alive = false; }
  assert.equal(alive, false, "the command of the interrupted run was stopped");

  gw.start();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(delivered.length, 1, "the operator is told once");
  assert.match(delivered[0].text, /interrupted by a restart/);
  assert.match(delivered[0].text, /was still running and has been stopped/);
  assert.ok(delivered[0].id, "the notice has a delivery id, so a second restart does not repeat it");

  // A second restart has nothing to report: the run is not "running" any more.
  const again = new Scheduler(home, new Log(join(home, "log")), runners as never, { recover: true });
  again.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(delivered.length, 1, "the notice is not repeated");
  gw.stop();
});
