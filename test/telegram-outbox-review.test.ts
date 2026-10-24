// Exercise the real Telegram channel with a fake Brain module: no model dependencies, no sockets or Bot API traffic.
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

test("review: unknown replies get one durable notice, status visibility and chat-scoped resend/discard", async (t) => {
  const { instance, make, file } = channel(t, { brain: { status: async () => ({ model: "test" }) } });
  const calls: { chat: number; text: string }[] = [];
  t.mock.method(instance.api, "sendMessage", async (chat: number, text: string) => { calls.push({ chat, text }); return { message_id: calls.length }; });
  const { TelegramError } = await import("../src/channels/telegram-api.ts");
  const err = new TelegramError("sendMessage", 0, "reply lost"); err.requestId = "request-1";
  await (instance as any).deliverFinal({ chunksSent: 0, finish: async () => { throw err; } }, 1, 7, "answer");
  await instance.flushOutbox();
  const [item] = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(calls.length, 1, "one notice, never a replay of the answer");
  assert.match(calls[0].text, /delivery is unknown/i);
  assert.ok(calls[0].text.includes(item.id));
  const restarted = make(); t.after(() => restarted.stop());
  t.mock.method(restarted.api, "sendMessage", async (chat: number, text: string) => { calls.push({ chat, text }); return { message_id: calls.length }; });
  await restarted.flushOutbox();
  assert.equal(calls.length, 1, "notice does not repeat after restart");
  const m = { chat: { id: 1 }, message_id: 10, message_thread_id: 7 };
  await (restarted as any).command("status", "", m, "test");
  assert.match(calls.at(-1)!.text, /1.*unknown/i);
  assert.ok(calls.at(-1)!.text.includes(item.id));
  await (restarted as any).command("outbox", `discard ${item.id}`, { chat: { id: 2 }, message_id: 11 }, "other");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1, "another chat cannot resolve this reply");
  await (restarted as any).command("outbox", `resend ${item.id}`, m, "test");
  assert.equal(calls.filter((c) => c.text === "answer").length, 1, "only explicit resend replays");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  restarted.enqueue(1, ["discarded"], 7, err);
  await restarted.flushOutbox();
  const [second] = JSON.parse(readFileSync(file, "utf8"));
  await (restarted as any).command("outbox", `discard ${second.id}`, m, "test");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  assert.equal(calls.some((c) => c.text === "discarded"), false);
});

for (const failure of ["stream-edit", "final-edit", "delete"]) {
  test(`review: own-draft ${failure} timeout does not park a final answer as an unknown send`, async (t) => {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const brain = {
      routerState: new Map(), whenRegistered: async () => {},
      ask: async (_key: string, _input: unknown, callbacks: any) => {
        callbacks.onText("draft one");
        await new Promise((r) => setTimeout(r, 1_300));
        if (failure === "stream-edit") {
          clock += 2_000; callbacks.onText("draft two");
          await new Promise((r) => setTimeout(r, 50));
        }
        if (failure === "delete") clock += 16_000;
        return { ok: true, text: "final answer", aborted: false, toolCalls: 0 };
      },
    };
    const { instance, file } = channel(t, { stream: true, brain });
    const sent: string[] = [], edited: string[] = [];
    const { TelegramError } = await import("../src/channels/telegram-api.ts");
    let failed = false;
    t.mock.method(instance.api, "sendChatAction", async () => true);
    t.mock.method(instance.api, "sendMessage", async (_chat: number, text: string) => { sent.push(text); return { message_id: sent.length }; });
    t.mock.method(instance.api, "editMessageText", async (_chat: number, _id: number, text: string) => {
      edited.push(text);
      if (failure !== "delete" && !failed) { failed = true; throw new TelegramError("editMessageText", 0, "edit response lost"); }
      return true;
    });
    t.mock.method(instance.api, "deleteMessage", async () => { throw new TelegramError("deleteMessage", 0, "delete response lost"); });
    await (instance as any).converseInner({ chat: { id: 1 }, message_id: 10 }, "test", { text: "ask" }, () => {});
    if (existsSync(file)) assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [], "idempotent mutation cannot hold an entire reply unknown");
    if (failure === "delete") assert.ok(sent.includes("final answer"));
    else assert.ok(edited.includes("final answer"), "the final reply still reaches the known draft");
  });
}


test("review: persistent unknown own-draft edits retry the same target durably, never a new message", async (t) => {
  const brain = {
    routerState: new Map(), whenRegistered: async () => {},
    ask: async (_key: string, _input: unknown, callbacks: any) => {
      callbacks.onText("draft");
      await new Promise((r) => setTimeout(r, 1_300));
      return { ok: true, text: "final answer", aborted: false, toolCalls: 0 };
    },
  };
  const { instance, file, make } = channel(t, { stream: true, brain });
  const { TelegramError } = await import("../src/channels/telegram-api.ts");
  let sends = 0;
  t.mock.method(instance.api, "sendChatAction", async () => true);
  t.mock.method(instance.api, "sendMessage", async () => { sends++; return { message_id: 42 }; });
  t.mock.method(instance.api, "editMessageText", async () => { throw new TelegramError("editMessageText", 0, "edit response lost"); });
  await (instance as any).converseInner({ chat: { id: 1 }, message_id: 10 }, "test", { text: "ask" }, () => {});
  const [item] = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(item.status, undefined, "safe own-draft edits are not held for operator reconciliation");
  assert.equal(item.editMessageId, 42);
  assert.deepEqual(item.chunks, ["final answer"]);
  const restarted = make(); t.after(() => restarted.stop());
  t.mock.method(restarted.api, "sendMessage", async () => { sends++; throw new Error("must not duplicate a draft edit"); });
  t.mock.method(restarted.api, "editMessageText", async (chat: number, id: number, text: string) => {
    assert.deepEqual([chat, id, text], [1, 42, "final answer"]);
    throw new TelegramError("editMessageText", 400, "message is not modified");
  });
  await restarted.flushOutbox();
  assert.equal(sends, 1, "only the original draft was a non-idempotent send");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
});


test("review: a held notice cannot be sent until its one-time attempt marker persists", async (t) => {
  const { instance } = channel(t);
  const { TelegramError } = await import("../src/channels/telegram-api.ts");
  const persist = t.mock.method(instance as any, "saveOutbox", () => false);
  let notices = 0;
  t.mock.method(instance.api, "sendMessage", async () => { notices++; return { message_id: 1 }; });
  instance.enqueue(1, ["answer"], undefined, new TelegramError("sendMessage", 0, "reply lost"));
  await instance.flushOutbox();
  assert.equal(notices, 0, "do not risk repeating notices after restart when the marker cannot be persisted");
  persist.mock.restore();
  await instance.flushOutbox();
  await instance.flushOutbox();
  assert.equal(notices, 1);
});

for (const outcome of ["delivered", "refused", "unknown"] as const) {
  test(`sign-off: explicit resend starts a fresh retry window for an old held reply (${outcome})`, async (t) => {
    const { instance, file, make } = channel(t);
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    writeFileSync(file, JSON.stringify([{ id: "old-held", chatId: 1, chunks: ["old answer"], firstAt: now - 25 * 3_600_000, attempts: 27, status: "unknown", unknownNoticeAttempted: true }]));
    const { TelegramError } = await import("../src/channels/telegram-api.ts");
    const sent: string[] = [];
    t.mock.method(instance.api, "sendMessage", async (_chat: number, text: string) => {
      sent.push(text);
      if (text === "old answer") {
        const [persisted] = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(persisted.firstAt, now, "the fresh window is durable before replay");
        assert.equal(persisted.attempts, 0, "old attempts do not carry into explicit replay");
        if (outcome !== "delivered") throw new TelegramError("sendMessage", outcome === "unknown" ? 0 : 403, "refused or lost");
      }
      return { message_id: sent.length };
    });
    await (instance as any).command("outbox", "resend old-held", { chat: { id: 1 }, message_id: 10 }, "test");
    assert.ok(sent.includes("old answer"), "an old held reply is actually retried, not silently expired");
    const queue = JSON.parse(readFileSync(file, "utf8"));
    if (outcome === "delivered") {
      assert.deepEqual(queue, []);
      assert.match(sent.at(-1)!, /Resent held reply/);
    } else {
      assert.equal(queue[0].firstAt, now);
      assert.equal(queue[0].attempts, 1);
      assert.equal(queue[0].status, outcome === "unknown" ? "unknown" : undefined);
      assert.doesNotMatch(sent.at(-1)!, /Resent held reply/);
      const restarted = make(); t.after(() => restarted.stop());
      t.mock.method(restarted.api, "sendMessage", async () => ({ message_id: 99 }));
      await restarted.flushOutbox();
      assert.equal(JSON.parse(readFileSync(file, "utf8")).length, outcome === "unknown" ? 1 : 0, "restart preserves the new window or unknown hold");
    }
  });
}

test("sign-off: a resend that expires before the flush is reported as dropped, never resent", async (t) => {
  const { instance, file } = channel(t);
  const now = Date.now();
  writeFileSync(file, JSON.stringify([{ id: "expired", chatId: 1, chunks: ["must not send"], firstAt: now, attempts: 1, status: "unknown", unknownNoticeAttempted: true }]));
  t.mock.method(Date, "now", () => now);
  const flush = instance.flushOutbox.bind(instance);
  t.mock.method(instance, "flushOutbox", () => {
    t.mock.method(Date, "now", () => now + 25 * 3_600_000);
    return flush();
  });
  const sent: string[] = [];
  t.mock.method(instance.api, "sendMessage", async (_chat: number, text: string) => { sent.push(text); return { message_id: 1 }; });
  await (instance as any).command("outbox", "resend expired", { chat: { id: 1 }, message_id: 10 }, "test");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [], "normal retry retention still applies");
  assert.equal(sent.length, 1, "only the command result was sent");
  assert.match(sent[0], /dropped/i);
  assert.doesNotMatch(sent[0], /Resent held reply/);
});
