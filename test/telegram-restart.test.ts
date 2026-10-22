import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    "telegram:dm:4242#20#1#answer": { phase: "sent", at: new Date().toISOString() },
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
