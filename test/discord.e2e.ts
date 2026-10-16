// Discord channel end to end: real model, fake Discord (REST + Gateway).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { FakeDiscord } from "./fake-discord.ts";

const dc = new FakeDiscord();
await dc.start();
const home = mkdtempSync(join(process.env.CARL_E2E_DIR ?? tmpdir(), "carl-discord-"));
writeFileSync(join(home, ".env"), "DISCORD_BOT_TOKEN=test-token\n");
writeFileSync(join(home, "carl.json"), JSON.stringify({ model: process.env.CARL_E2E_MODEL ?? "openai-codex/gpt-6.1-sol", agentDir: process.env.CARL_E2E_AGENT_DIR ?? join(homedir(), ".pi", "agent"), thinking: "low", tools: ["read", "bash"],
  telegram: { enabled: false }, api: { enabled: false }, discord: { allowFrom: ["42"], homeChannel: "100", apiBase: dc.base } }));
const gw = new Gateway(loadConfig(home));
await gw.start();
const until = async (pred: () => boolean, ms: number, what: string) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 150)); } };
const idle = async () => { await new Promise((r) => setTimeout(r, 300)); await until(() => gw.brain.busyCount() === 0, 120_000, "idle"); };
let failed = 0;
const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message}`); } };

await step("identifies and connects", async () => { await until(() => dc.identified && gw.discord?.status.state === "connected", 5_000, "READY"); });
await step("strangers ignored", async () => {
  dc.message("7", "hello?");
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(dc.texts("100").length, 0);
});
await step("allowed user gets a reply", async () => {
  dc.message("42", "What is 7 times 8? Reply with only the number.");
  await until(() => dc.texts("100").some((t) => /\b56\b/.test(t)), 90_000, "reply 56");
});
await step("Deny button keeps the file", async () => {
  await idle();
  const probe = join(home, "workspace", "keep");
  mkdirSync(probe, { recursive: true });
  const before = dc.calls.length;
  dc.message("42", `Run this exact bash command: rm -rf ${probe} . Then say what happened.`);
  await until(() => dc.calls.slice(before).some((c) => c.body?.components?.length), 90_000, "approval card");
  const card = dc.calls.slice(before).find((c) => c.body?.components?.length)!;
  dc.dispatch("INTERACTION_CREATE", { id: "i1", token: "t1", user: { id: "42" }, data: { custom_id: card.body.components[0].components[1].custom_id } });
  await idle();
  assert.ok(existsSync(probe), "denied command must not run");
});
await step("deliver to discord:home", async () => {
  assert.match(await gw.send("discord:home", "**done**"), /Delivered to Discord/);
});
await gw.stop("test done");
await dc.stop();
console.log(failed ? `${failed} failed` : "PASS discord");
process.exit(failed ? 1 : 0);
