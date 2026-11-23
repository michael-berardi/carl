import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, isSilentReply } from "../src/scheduler.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} } as any;

test("silence markers are recognised (synthetic)", () => {
  for (const text of ["[SILENT]", " [silent] ", "NO_REPLY", "HEARTBEAT_OK.", "[ SILENT ]\n"]) assert.equal(isSilentReply(text), true, text);
  for (const text of ["", "Nothing needs the operator, but J-1 is stuck.", "[SILENT] except J-2 failed"]) assert.equal(isSilentReply(text), false, text);
});

async function runOnce(reply: string, onlyIfOutput: boolean) {
  const home = mkdtempSync(join(tmpdir(), "carl-sched-"));
  const sent: string[] = [];
  const s = new Scheduler(home, log, { prompt: async () => reply, builtin: {}, deliver: async (_job: unknown, text: string) => { sent.push(text); } } as any);
  const job = s.add({ name: "ultrabot-queue-check", when: "every 20m", prompt: "check", deliver: "home", onlyIfOutput });
  await s.runNow(job.id);
  return sent;
}

test("a [SILENT] reply is never delivered, with or without onlyIfOutput (synthetic)", async () => {
  assert.deepEqual(await runOnce("[SILENT]", true), []);
  assert.deepEqual(await runOnce("[SILENT]", false), []);
});

test("a real reply is still delivered (synthetic)", async () => {
  assert.deepEqual(await runOnce("J-3016 needs a credential.", true), ["J-3016 needs a credential."]);
});

async function runBuiltin(result: () => Promise<string> | string) {
  const home = mkdtempSync(join(tmpdir(), "carl-builtin-sched-"));
  const sent: string[] = [];
  const errors: { msg: string; data?: unknown }[] = [];
  const s = new Scheduler(home, { ...log, error: (msg: string, data?: unknown) => errors.push({ msg, data }) }, {
    prompt: async () => "", builtin: { individuation: result }, deliver: async (_job: unknown, text: string) => { sent.push(text); },
  } as any);
  const job = s.add({ name: "Individuation", when: "40 5 * * *", builtin: "individuation", deliver: "home" });
  await s.runNow(job.id);
  return { sent, errors, job: s.get(job.id), home };
}

test("a failed built-in schedule is logged and kept in lastError, but never sent to chat (regression)", async () => {
  // Live 2026-11-23: Individuation failed on a signed-out Claude login and Carl messaged the operator.
  const { sent, errors, job, home } = await runBuiltin(() => { throw new Error("Claude Code is not logged in: run `claude auth login`"); });
  assert.deepEqual(sent, [], "no failure is delivered from a built-in job");
  assert.equal(job.lastStatus, "error");
  assert.match(job.lastError ?? "", /not logged in/);
  assert.ok(errors.some((e) => e.msg === "schedule failed" && /not logged in/.test(JSON.stringify(e.data))), "cause is still logged");
  const saved = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8")).jobs[0];
  assert.equal(saved.lastStatus, "error");
  assert.match(saved.lastError, /not logged in/, "carl status, /schedules and doctor still see the cause");
});

test("a built-in's successful output is still delivered, and a user schedule still reports failures (regression)", async () => {
  const ok = await runBuiltin(() => "### Lessons\n- Check the tool result.");
  assert.deepEqual(ok.sent, ["### Lessons\n- Check the tool result."]);
  assert.equal(ok.job.lastStatus, "ok");

  const home = mkdtempSync(join(tmpdir(), "carl-user-sched-"));
  const sent: string[] = [];
  const s = new Scheduler(home, log, { prompt: async () => { throw new Error("the model rejected the request"); }, builtin: {}, deliver: async (_j: unknown, t: string) => { sent.push(t); } } as any);
  const job = s.add({ name: "My check", when: "every 20m", prompt: "check", deliver: "home" });
  await s.runNow(job.id);
  assert.deepEqual(sent, ['Schedule "My check" failed: the model rejected the request']);
});
