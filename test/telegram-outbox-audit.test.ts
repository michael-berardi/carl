// Exercise the real Telegram channel with a fake Brain module: no model dependencies, no sockets or Bot API traffic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
const channelURL = new URL("../src/channels/telegram.ts", import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === channelURL && specifier === "../brain.ts") return { url: "data:text/javascript,export function toolsRanAfter() { return false; }", shortCircuit: true };
  return next(specifier, context);
} });
const { TelegramChannel } = await import("../src/channels/telegram.ts");
hook.deregister();
const token = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz";

function channel(t: any, opts: { stream?: boolean; brain?: any } = {}) {
  const home = mkdtempSync(join(tmpdir(), "carl-outbox-audit-"));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [1], homeChat: 1, stream: opts.stream ?? false } }));
  const cfg = loadConfig(home);
  const make = () => new TelegramChannel(cfg, token, opts.brain ?? {} as any, new Log(undefined));
  const instance = make();
  t.after(async () => { await instance.stop(); rmSync(home, { recursive: true, force: true }); });
  return { instance, make, file: join(home, "state", "outbox.json") };
}

test("an ambiguous final reply is held across outbox flush and channel restart", async (t) => {
  const { instance, make, file } = channel(t);
  let requests = 0, notices = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (JSON.parse(init!.body as string).text.startsWith("A reply's delivery is unknown.")) notices++;
    else requests++;
    throw new Error("reply lost after acceptance");
  });
  const draft = { chunksSent: 0, finish: () => instance.api.sendMessage(1, "answer") };
  await (instance as any).deliverFinal(draft, 1, undefined, "answer");
  const [item] = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(item.status, "unknown");
  assert.ok(item.requestId);
  await instance.flushOutbox();
  const restarted = make();
  t.after(() => restarted.stop());
  await restarted.flushOutbox();
  assert.equal(requests, 1, "neither the gateway queue nor restart may replay an unknown send");
  assert.equal(notices, 1, "even an unknown notice is attempted once across restart");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))[0].requestId, item.requestId);
});

test("a refused queued reply becomes held if a later retry loses its response", async (t) => {
  const { instance, make, file } = channel(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error_code: 403, description: "refused" }, { status: 403 }));
  await (instance as any).deliverFinal({ chunksSent: 0, finish: () => instance.api.sendMessage(1, "answer") }, 1, undefined, "answer");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].status, undefined, "a refusal may be queued");
  let requests = 0, notices = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (JSON.parse(init!.body as string).text.startsWith("A reply's delivery is unknown.")) notices++;
    else requests++;
    throw new Error("reply lost");
  });
  await instance.flushOutbox();
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].status, "unknown");
  await instance.flushOutbox();
  const restarted = make();
  t.after(() => restarted.stop());
  await restarted.flushOutbox();
  assert.equal(requests, 1);
  assert.equal(notices, 1);
});

test("definite outbox refusals can still be retried and drained", async (t) => {
  const { instance, file } = channel(t);
  instance.enqueue(1, ["answer"], undefined, "definite refusal");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ ok: true, result: { message_id: 2 } }); });
  await instance.flushOutbox();
  assert.equal(requests, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});

test("an uncertain streaming draft cannot be followed by another draft or a final send", async (t) => {
  const brain = {
    routerState: new Map(),
    whenRegistered: async () => {},
    ask: async (_key: string, _input: unknown, callbacks: any) => {
      callbacks.onText("draft");
      await new Promise((r) => setTimeout(r, 1_300));
      return { ok: true, text: "final answer", aborted: false, toolCalls: 0 };
    },
  };
  const { instance, file } = channel(t, { stream: true, brain });
  let sends = 0, notices = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/sendMessage")) {
      if (JSON.parse(init!.body as string).text.startsWith("A reply's delivery is unknown.")) notices++;
      else sends++;
      throw new Error("draft response lost");
    }
    return Response.json({ ok: true, result: true });
  });
  await (instance as any).converseInner({ chat: { id: 1 }, message_id: 10 }, "test", { text: "ask" }, () => {});
  await instance.flushOutbox();
  assert.equal(sends, 1);
  assert.equal(notices, 1);
  const [item] = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(item.status, "unknown");
  assert.ok(item.requestId);
});
