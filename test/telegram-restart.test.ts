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

test("after a restart, a message whose turn ran no tool is picked up again; one that ran a tool is reported", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-restart-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  // Two messages were in flight when Carl stopped.
  writeFileSync(join(home, "state", "inflight.json"), JSON.stringify({
    [`${OP}:10`]: { chatId: OP, text: "what is on my calendar today", at: new Date().toISOString() },
    [`${OP}:11`]: { chatId: OP, text: "deploy the site now", at: new Date().toISOString() },
    [`${OP}:12`]: { chatId: OP, text: "summarise my inbox", at: new Date().toISOString(), resumed: true },
  }));
  // The second one had already run a tool when Carl stopped.
  const dir = join(home, "sessions", `telegram_dm_${OP}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-15T00-00-00-000Z_x.jsonl"), [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "deploy the site now" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "npm run deploy" } }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");

  const asked: string[] = [];
  const brain: any = {
    ask: async (_k: string, i: any) => { asked.push(i.text); return { ok: true, text: "here it is", aborted: false, toolCalls: 0 }; },
    whenRegistered: async () => {}, status: () => ({}), routerState: new Map(), shellSandbox: undefined,
  };
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  await tg.waitFor(() => asked.length >= 1 && tg.calls.filter((c) => c.method === "sendMessage").length >= 4, 15_000, "resume and notices");
  const texts = tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
  assert.deepEqual(asked, ["what is on my calendar today"], "only the message that ran no tool is rerun");
  assert.ok(texts.some((s) => /picking it up again/.test(s) && s.includes("calendar")));
  assert.ok(texts.some((s) => /did not finish/.test(s) && s.includes("deploy the site")), "the one that ran a tool is reported, not rerun");
  assert.ok(texts.some((s) => /did not finish/.test(s) && s.includes("summarise my inbox")), "a message already resumed once is reported, not resumed again");
});
