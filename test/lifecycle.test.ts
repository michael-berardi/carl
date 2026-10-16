import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
