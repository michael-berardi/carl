import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramChannel } from "../src/channels/telegram.ts";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const OP = 4242;

/** A brain that records what it was asked and answers with a fixed text. */
function fakeBrain(extra: Record<string, any> = {}): any {
  return {
    ask: async (_k: string, i: any) => ({ ok: true, text: "here it is", aborted: false, toolCalls: 0, turn: 1 }),
    whenRegistered: async () => {}, status: () => ({}), routerState: new Map(), shellSandbox: undefined,
    currentTurn: () => 0, recentDuplicate: async () => undefined,
    ...extra,
  };
}

test("after a restart, a message whose turn ran no tool is picked up again; one that ran a tool is continued", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-restart-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  // Three messages were in flight when Carl stopped.
  writeFileSync(join(home, "state", "inflight.json"), JSON.stringify({
    [`${OP}:10`]: { chatId: OP, text: "what is on my calendar today", at: new Date().toISOString() },
    [`${OP}:11`]: { chatId: OP, text: "deploy the site now", at: new Date().toISOString() },
    [`${OP}:12`]: { chatId: OP, text: "summarise my inbox", at: new Date().toISOString(), resumed: true },
  }));
  // The second one had already run a tool when Carl stopped: the tool call is in the transcript, its result is not.
  const dir = join(home, "sessions", `telegram_dm_${OP}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-15T00-00-00-000Z_x.jsonl"), [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "deploy the site now" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "npm run deploy" } }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  const asked: string[] = [];
  const resumed: string[] = [];
  const brain = fakeBrain({
    ask: async (_k: string, i: any) => { asked.push(i.text); return { ok: true, text: "here it is", aborted: false, toolCalls: 0, turn: 1 }; },
    // The turn that ran a tool is continued from the transcript; the tool is not run again.
    resumeTurn: async (_k: string, text: string, opts: any) => {
      resumed.push(text);
      if (text.includes("calendar")) return { status: "restart", turn: 1 }; // nothing had run yet
      await opts.onPlan?.({ turn: 1, calls: [{ id: "1", name: "bash", answered: false }], pending: [{ id: "1", name: "bash", answered: false }], state: "waiting" });
      return { status: "resumed", text: "the deploy finished", turn: 1, uncertain: [{ id: "1", name: "bash" }] };
    },
  });
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  await tg.waitFor(() => asked.length >= 1 && tg.calls.filter((c) => c.method === "sendMessage").length >= 4, 15_000, "resume and notices");
  const texts = tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
  assert.deepEqual(asked, ["what is on my calendar today"], "only the message that ran no tool is rerun");
  assert.deepEqual(resumed.sort(), ["deploy the site now", "what is on my calendar today"], "every message is looked at, only the one with a tool is continued");
  assert.ok(texts.some((s) => /picking it up again/.test(s) && s.includes("calendar")));
  assert.ok(texts.some((s) => /picking it up again/.test(s) && s.includes("deploy")), "the resumed turn is announced");
  assert.ok(texts.some((s) => /may or may not have taken effect/.test(s)), "the operator is told what was uncertain");
  assert.ok(texts.some((s) => s.trim() === "the deploy finished"), "the answer of the continued turn is delivered");
  assert.ok(texts.some((s) => /did not finish/.test(s) && s.includes("summarise my inbox")), "a message already resumed once is reported, not resumed again");
});

test("an answer that was already delivered is not delivered again after a restart", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-restart-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  writeFileSync(join(home, "state", "inflight.json"), JSON.stringify({
    [`${OP}:20`]: { chatId: OP, text: "deploy the site now", at: new Date().toISOString() },
  }));
  // The turn already produced its answer before the crash; the answer was sent (the ledger says so).
  const dir = join(home, "sessions", `telegram_dm_${OP}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-15T00-00-00-000Z_x.jsonl"), [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "deploy the site now" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "the deploy finished" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(home, "state", "deliveries.json"), JSON.stringify({
    "telegram:dm:4242#20#answer": { phase: "sent", at: new Date().toISOString() },
  }));

  const brain = fakeBrain({
    resumeTurn: async () => ({ status: "answered", text: "the deploy finished", turn: 1 }),
  });
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  await tg.waitFor(() => tg.calls.filter((c) => c.method === "sendMessage").length >= 1, 15_000, "the notice");
  await new Promise((r) => setTimeout(r, 500));
  const texts = tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
  assert.equal(texts.filter((s) => s.trim() === "the deploy finished").length, 0, "the answer is not sent a second time");
  assert.ok(texts.some((s) => /already gone out/.test(s)), "the operator is told the answer had already been sent");
});

test("an answer whose send was never confirmed is described as uncertain, not as sent", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-restart-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  writeFileSync(join(home, "state", "inflight.json"), JSON.stringify({
    [`${OP}:21`]: { chatId: OP, text: "deploy the site now", at: new Date().toISOString() },
  }));
  // The answer was being sent when Carl died: it may or may not have gone out.
  writeFileSync(join(home, "state", "deliveries.json"), JSON.stringify({
    "telegram:dm:4242#21#answer": { phase: "sending", at: new Date().toISOString() },
  }));

  const brain = fakeBrain({
    resumeTurn: async () => ({ status: "answered", text: "the deploy finished", turn: 1 }),
  });
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  await tg.waitFor(() => tg.calls.filter((c) => c.method === "sendMessage").length >= 1, 15_000, "the notice");
  await new Promise((r) => setTimeout(r, 500));
  const texts = tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
  assert.equal(texts.filter((s) => s.trim() === "the deploy finished").length, 0, "the answer is not sent a second time");
  assert.ok(texts.some((s) => /may already have gone out/.test(s)), "the operator is told it may already have gone out");
  assert.ok(!texts.some((s) => /had already gone out/.test(s)), "an unconfirmed send is not described as sent");
});

test("a message that arrives while a resumed turn runs waits for it, and a verbatim resend is answered", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-race-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  writeFileSync(join(home, "state", "inflight.json"), JSON.stringify({
    [`${OP}:30`]: { chatId: OP, text: "deploy the site now", at: new Date().toISOString() },
  }));

  const events: string[] = [];
  const asked: string[] = [];
  let resumed = false;
  const brain = fakeBrain({
    ask: async (_k: string, i: any) => { asked.push(i.text); events.push(`ask:${i.text}`); return { ok: true, text: "here it is", aborted: false, toolCalls: 0, turn: 1 }; },
    resumeTurn: async (_k: string, text: string, opts: any) => {
      events.push("resume:start");
      await opts.onPlan?.({ turn: 1, calls: [], pending: [], state: "waiting" });
      await new Promise((r) => setTimeout(r, 500));
      resumed = true;
      events.push("resume:end");
      return { status: "resumed", text: "the deploy finished", turn: 1 };
    },
    // The transcript holds the interrupted turn: a verbatim resend is answered, not run again.
    recentDuplicate: async (_k: string, text: string) => {
      events.push(`duplicate:${text}`);
      return resumed ? { text: "the deploy finished", at: Date.now() } : undefined;
    },
  });
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });

  // While the resume runs, the operator sends the very same words again.
  await new Promise((r) => setTimeout(r, 150));
  tg.message(OP, "deploy the site now");
  await tg.waitFor(() => events.some((e) => e.startsWith("duplicate:")), 15_000, "the resend");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(events, ["resume:start", "resume:end", "duplicate:deploy the site now"],
    "the resend waits for the resumed turn instead of racing it");
  assert.deepEqual(asked, [], "the request is not run again");
  const texts = tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
  assert.equal(texts.filter((s) => s.trim() === "the deploy finished").length, 1, "the answer goes out once");
  assert.ok(texts.some((s) => /I already did that/.test(s)), "the verbatim resend is answered, not run again");
});

test("a re-armed approval card keeps no live buttons, and an unsettled card does not block a new one", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-approval-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  // A card that was sent and never answered (a crash): it is in the chat with live buttons.
  // A second card whose send was never confirmed: it may never have reached the chat at all.
  writeFileSync(join(home, "state", "deliveries.json"), JSON.stringify({
    "approval:telegram:dm:4242#1#abc": { phase: "sent", at: new Date().toISOString(), messageIds: [77] },
    "approval:telegram:dm:4242#2#def": { phase: "sending", at: new Date().toISOString() },
  }));
  const brain = fakeBrain();
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });

  const stable = "approval:telegram:dm:4242#1#abc";
  const cardId = createHash("sha256").update(stable).digest("hex").slice(0, 12);
  const answered = channel.requestApproval(OP, "rm -rf /tmp/carl-test", "a dangerous command", stable);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tg.calls.filter((c) => c.method === "sendMessage" && c.body.reply_markup?.inline_keyboard?.length).length, 0, "no second card is sent");
  // The operator answers the card that is in the chat.
  tg.callback(OP, `ca:${cardId}:yes`, { message_id: 77, chat: { id: OP } });
  assert.equal(await answered, "approved");
  const edits = tg.calls.filter((c) => c.method === "editMessageReplyMarkup");
  assert.ok(edits.some((e) => e.body.message_id === 77 && !(e.body.reply_markup?.inline_keyboard ?? []).length),
    "the settled card keeps no live buttons");

  // A card whose send was never confirmed may never have reached the chat: a new approval is not blocked by it.
  const unsettled = "approval:telegram:dm:4242#2#def";
  const unsettledId = createHash("sha256").update(unsettled).digest("hex").slice(0, 12);
  const asked = channel.requestApproval(OP, "ls /tmp", "another command", unsettled);
  await tg.waitFor(() => tg.calls.some((c) => c.method === "sendMessage" && c.body.reply_markup?.inline_keyboard?.length), 10_000, "the new card");
  const card = [...tg.sent.entries()].reverse().find(([, m]) => m.text.includes("Approve?"))!;
  tg.callback(OP, `ca:${unsettledId}:yes`, { message_id: card[0], chat: { id: OP } });
  assert.equal(await asked, "approved", "the new card is asked and answered");
});
