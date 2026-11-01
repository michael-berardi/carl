// The outbox gap found in the dsh-superagent comparison (2026-11-01): a refusal no retry can fix (403 blocked, chat or topic gone)
// was retried every 30 s for 24 h, nobody could see the queue, and the agent was told "retried every 30 s".
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
const channelURL = new URL("../src/channels/telegram.ts", import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === channelURL && specifier === "../brain.ts") return { url: "data:text/javascript,export function toolsRanAfter() { return false; }", shortCircuit: true };
  return next(specifier, context);
} });
const { TelegramChannel, outboxRetryDelayMs, permanentSendFailure } = await import("../src/channels/telegram.ts");
const { TelegramError } = await import("../src/channels/telegram-api.ts");
hook.deregister();
const token = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz";
const queued = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];

function channel(t: any) {
  const home = mkdtempSync(join(tmpdir(), "carl-outbox-backoff-"));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "p/m", telegram: { allowFrom: [1], homeChat: 1, stream: false } }));
  const instance = new TelegramChannel(loadConfig(home), token, { status: async () => ({ model: "test" }) } as any, new Log(undefined));
  t.after(async () => { await instance.stop(); rmSync(home, { recursive: true, force: true }); });
  return { instance, file: join(home, "state", "outbox.json") };
}

test("retry spacing doubles from 30 s and caps at 5 min", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(outboxRetryDelayMs), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test("only refusals no retry can fix are permanent", () => {
  assert.equal(permanentSendFailure(new TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user")), true);
  assert.equal(permanentSendFailure(new TelegramError("sendMessage", 400, "Bad Request: chat not found")), true);
  assert.equal(permanentSendFailure(new TelegramError("sendMessage", 400, "Bad Request: message thread not found")), true);
  assert.equal(permanentSendFailure(new TelegramError("sendMessage", 429, "Too Many Requests")), false);
  assert.equal(permanentSendFailure(new TelegramError("sendMessage", 400, "Bad Request: can't parse entities")), false);
  assert.equal(permanentSendFailure(new TelegramError("sendMessage", 502, "Bad Gateway")), false, "a 5xx is an unknown outcome, held, not dropped");
});

test("a permanent refusal is never queued; a queued reply that turns permanent is dropped after one attempt", async (t) => {
  const { instance, file } = channel(t);
  instance.enqueue(1, ["hello"], undefined, new TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user"));
  assert.deepEqual(queued(file), [], "never queued");
  let calls = 0;
  t.mock.method(instance.api, "sendMessage", async () => { calls++; throw new TelegramError("sendMessage", 400, "Bad Request: chat not found"); });
  instance.enqueue(1, ["hello"], undefined, new TelegramError("sendMessage", 429, "Too Many Requests"));
  const [item] = queued(file);
  item.nextAt = 0; writeFileSync(file, JSON.stringify([item]));
  (instance as any).outbox = undefined;
  await instance.flushOutbox();
  const afterFirst = calls; // one delivery attempt (the markdown send plus its plain-text fallback on a 400)
  assert.ok(afterFirst >= 1 && afterFirst <= 2, `one delivery attempt, got ${afterFirst} API calls`);
  assert.deepEqual(queued(file), [], "dropped after the first permanent answer, not retried for 24 h");
  await instance.flushOutbox();
  assert.equal(calls, afterFirst, "nothing left to retry");
});

test("a transient refusal backs off, is not retried before it is due, and shows in /status", async (t) => {
  const { instance, file } = channel(t);
  let attempts = 0; const sent: string[] = [];
  t.mock.method(instance.api, "sendMessage", async (_chat: number, text: string) => {
    if (text !== "hello") { sent.push(text); return { message_id: 9 }; } // the /status reply itself goes through
    attempts++; throw new TelegramError("sendMessage", 429, "Too Many Requests");
  });
  instance.enqueue(1, ["hello"], undefined, new TelegramError("sendMessage", 429, "Too Many Requests"));
  await instance.flushOutbox(); // the first retry (the scheduled 30 s pass in production)
  assert.equal(attempts, 1);
  const [item] = queued(file);
  assert.ok(item.nextAt - Date.now() > 55_000, "after the second failed attempt the next retry waits about 60 s");
  await instance.flushOutbox();
  assert.equal(attempts, 1, "not retried before it is due");
  item.nextAt = 0; writeFileSync(file, JSON.stringify([item])); (instance as any).outbox = undefined;
  await instance.flushOutbox();
  assert.equal(attempts, 2);
  const [after] = queued(file);
  assert.ok(after.nextAt - Date.now() > 115_000, "third retry waits about 120 s");
  assert.equal(instance.pendingCount(), 1);
  await (instance as any).command("status", "", { chat: { id: 1 }, message_id: 1 }, "test");
  assert.match(sent.at(-1)!, /1 replies queued for retry \(last error: Telegram sendMessage failed \(429\)/);
});
