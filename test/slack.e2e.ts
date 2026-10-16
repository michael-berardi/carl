// Slack channel end to end: real model, fake Slack (Web API + Socket Mode).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { FakeSlack } from "./fake-slack.ts";

const slack = new FakeSlack();
await slack.start();
const home = mkdtempSync(join(process.env.CARL_E2E_DIR ?? tmpdir(), "carl-slack-"));
writeFileSync(join(home, ".env"), "SLACK_APP_TOKEN=xapp-test\nSLACK_BOT_TOKEN=xoxb-test\n");
writeFileSync(join(home, "carl.json"), JSON.stringify({ model: process.env.CARL_E2E_MODEL ?? "openai-codex/gpt-6.1-sol", agentDir: process.env.CARL_E2E_AGENT_DIR ?? join(homedir(), ".pi", "agent"), thinking: "low", tools: ["read", "bash"],
  telegram: { enabled: false }, api: { enabled: false }, slack: { allowFrom: ["UOP"], homeChannel: "D1", apiBase: slack.base } }));
const gw = new Gateway(loadConfig(home));
await gw.start();
await slack.waitConnected();
const idle = async () => { const end = Date.now() + 120_000; await new Promise((r) => setTimeout(r, 300)); while (gw.brain.busyCount() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); };
let failed = 0;
const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message}`); } };

await step("events are acknowledged and strangers ignored", async () => {
  const env = slack.message("USTRANGER", "hello?");
  await new Promise((r) => setTimeout(r, 1_500));
  assert.ok(slack.acks.includes(env), "envelope acked");
  assert.equal(slack.texts("D1").length, 0);
});

await step("allowed user gets a reply", async () => {
  slack.message("UOP", "What is 9 times 9? Reply with only the number.");
  const end = Date.now() + 90_000;
  while (!slack.texts("D1").some((t) => /\b81\b/.test(t)) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  assert.ok(slack.texts("D1").some((t) => /\b81\b/.test(t)), slack.texts("D1").join(" | "));
});

await step("approval buttons gate a dangerous command (Deny keeps the file)", async () => {
  await idle();
  const { mkdirSync, existsSync } = await import("node:fs");
  const probe = join(home, "workspace", "keep-me");
  mkdirSync(probe, { recursive: true });
  const before = slack.calls.length;
  slack.message("UOP", `Run this exact bash command: rm -rf ${probe} . Then say what happened.`);
  const end = Date.now() + 90_000;
  let card: any;
  while (!card && Date.now() < end) { card = slack.calls.slice(before).find((c) => c.method === "chat.postMessage" && c.body.blocks); await new Promise((r) => setTimeout(r, 200)); }
  assert.ok(card, "approval card posted");
  const deny = card.body.blocks[1].elements[1].value;
  slack.push({ type: "interactive", envelope_id: "env-int", payload: { type: "block_actions", user: { id: "UOP" }, actions: [{ action_id: "carl_deny", value: deny }] } });
  await idle();
  assert.ok(existsSync(probe), "denied command must not run");
});

await step("deliver to slack:home", async () => {
  const r = await gw.send("slack:home", "**done** with [docs](https://example.com)");
  assert.match(r, /Delivered to Slack/);
  const last = slack.calls.filter((c) => c.method === "chat.postMessage").pop()!;
  assert.equal(last.body.text, "*done* with <https://example.com|docs>");
});

await gw.stop("test done");
await slack.stop();
console.log(failed ? `${failed} failed` : "PASS slack");
process.exit(failed ? 1 : 0);
