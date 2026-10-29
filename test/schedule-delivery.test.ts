import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, isSilentReply } from "../src/scheduler.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} } as any;

test("silence markers are recognised (synthetic)", () => {
  for (const text of ["[SILENT]", " [silent] ", "NO_REPLY", "HEARTBEAT_OK.", "[ SILENT ]\n"]) assert.equal(isSilentReply(text), true, text);
  for (const text of ["", "Nothing needs Mike, but J-1 is stuck.", "[SILENT] except J-2 failed"]) assert.equal(isSilentReply(text), false, text);
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
