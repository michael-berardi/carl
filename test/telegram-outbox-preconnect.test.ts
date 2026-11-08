// A send that never left this machine is a plain failure (retried), not an "unknown delivery" held for the operator;
// a held reply expires after 24 h instead of nagging forever. (Regression: a stale held reply was resent days later.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { TelegramApi, TelegramError, preConnectCause } from "../src/channels/telegram-api.ts";
const channelURL = new URL("../src/channels/telegram.ts", import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === channelURL && specifier === "../brain.ts") return { url: "data:text/javascript,export function toolsRanAfter() { return false; }", shortCircuit: true };
  return next(specifier, context);
} });
const { TelegramChannel, HELD_REPLY_TTL_MS } = await import("../src/channels/telegram.ts");
hook.deregister();
const token = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz";

/** A localhost port that nothing listens on (bound, then closed). */
async function closedPort(): Promise<number> {
  const s = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as any).port;
  await new Promise((r) => s.close(r));
  return port;
}

test("preConnectCause: refused/DNS are pre-connect, a reset after connect is not", async () => {
  const refused = await fetch(`http://127.0.0.1:${await closedPort()}/`).catch((e) => e);
  assert.equal(preConnectCause(refused), "ECONNREFUSED");
  assert.equal(preConnectCause({ cause: { code: "ENOTFOUND" } }), "ENOTFOUND");
  assert.equal(preConnectCause({ cause: { errors: [{ code: "EHOSTUNREACH" }] } }), "EHOSTUNREACH");
  const server = createServer((c) => c.destroy()).listen(0);
  await new Promise((r) => server.once("listening", r));
  const reset = await fetch(`http://127.0.0.1:${(server.address() as any).port}/`).catch((e) => e);
  server.close();
  assert.equal(preConnectCause(reset), undefined, "a reset after connect may have been delivered");
});

test("sendMessage that cannot connect fails plainly (status failed), so the outbox retries instead of holding it", async () => {
  const api = new TelegramApi(token) as any;
  api.base = `http://127.0.0.1:${await closedPort()}/bot`;
  const err = await api.call("sendMessage", { chat_id: 1, text: "x" }).catch((e: unknown) => e);
  assert.ok(err instanceof TelegramError);
  assert.equal(err.status, "failed");
  assert.match(err.message, /ECONNREFUSED: not sent/);
});

test("a held reply older than 24 h is dropped without resending and without another notice", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "carl-held-ttl-"));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [1], homeChat: 1, stream: false } }));
  const file = join(home, "state", "outbox.json");
  const old = Date.now() - HELD_REPLY_TTL_MS - 60_000;
  writeFileSync(file, JSON.stringify([
    { id: "stale", chatId: 1, chunks: ["old answer"], firstAt: old, attempts: 1, status: "unknown", unknownNoticeAttempted: true },
    { id: "fresh", chatId: 1, chunks: ["new answer"], firstAt: Date.now(), attempts: 1, status: "unknown", unknownNoticeAttempted: true },
  ]));
  const ch = new TelegramChannel(loadConfig(home), token, {} as any, new Log(undefined));
  t.after(async () => { await ch.stop(); rmSync(home, { recursive: true, force: true }); });
  const sent: string[] = [];
  t.mock.method(ch.api, "sendMessage", async (_c: number, text: string) => { sent.push(text); return { message_id: 1 }; });
  await ch.flushOutbox();
  assert.deepEqual(sent, [], "nothing resent, no repeat notice");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).map((i: any) => i.id), ["fresh"]);
});
