// End-to-end for the asks module: real model, fake Telegram group. Run:
//   CARL_E2E_MODEL=openai-codex/gpt-6.1-terra node --experimental-strip-types test/asks.e2e.ts
// A team member answers an ask in a group with one reply; the agent must record every answer and finish it,
// which writes the answers file and runs onComplete.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const OP = 4242, GROUP = -5269168638, KATE = 1523575779;
const tg = new FakeTelegram();
await tg.start();
const root = mkdtempSync(join(tmpdir(), "carl-asks-e2e-"));
process.env.CARL_MESSAGE_LOG_DIR = join(root, "messages");
const home = join(root, "carl");
mkdirSync(join(home, "asks"), { recursive: true });
writeFileSync(join(home, ".env"), `TELEGRAM_BOT_TOKEN=123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz\nCARL_API_KEY=${randomBytes(18).toString("base64url")}\n`);
writeFileSync(join(home, "carl.json"), JSON.stringify({
  model: process.env.CARL_E2E_MODEL ?? "openai-codex/gpt-6.1-terra",
  agentDir: process.env.CARL_E2E_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  thinking: "low", tools: ["read"], asks: true, api: { enabled: false },
  telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false, groups: [{ chat: GROUP, members: { [String(KATE)]: "Kate" } }] },
}));
const marker = join(root, "released");
const done = join(root, "done.sh");
writeFileSync(done, `#!/bin/sh\necho "$1" > ${JSON.stringify(marker)}\n`);
chmodSync(done, 0o755);
const answersFile = join(root, "answers.md");
writeFileSync(join(home, "asks", "pub.json"), JSON.stringify({
  id: "pub", chat: GROUP, askee: "Kate", title: "Before the new pages go live",
  questions: [{ n: 1, text: "Is USD 185 still the B1/B2 visa fee?" }, { n: 2, text: "Is the CEMLA certificate apostilled directly, or notarized first?" }, { n: 3, text: "Approve the author page text?" }],
  answersFile, onComplete: [done, "J-GATE"], status: "open", postedMessageId: 500,
}));

const gw = new Gateway(loadConfig(home));
await gw.start();
const started = Date.now();
try {
  tg.groupMessage(GROUP, KATE, "1) yes, 185 is right\n2) it needs a notary first, then Cancillería\n3) approved", {
    firstName: "Kate",
    replyTo: { message_id: 500, date: 0, chat: { id: GROUP, type: "group" }, from: { id: 1, is_bot: true }, text: "Before the new pages go live" },
  });
  await tg.waitFor(() => existsSync(marker), 240_000, "the ask to finish and run onComplete");
  assert.equal(readFileSync(marker, "utf8").trim(), "J-GATE");
  const md = readFileSync(answersFile, "utf8");
  assert.match(md, /185/);
  assert.match(md, /notar/i);
  assert.match(md, /approv/i);
  const ask = JSON.parse(readFileSync(join(home, "asks", "pub.json"), "utf8"));
  assert.equal(ask.status, "done");
  assert.equal(Object.keys(ask.answers).length, 3);
  for (const a of Object.values<any>(ask.answers)) assert.match(a.by, /Kate/);
  await tg.waitFor(() => tg.texts(GROUP).length > 0, 60_000, "a reply in the group");
  console.log(`ok   asks e2e (${Date.now() - started} ms). Reply: ${tg.texts(GROUP).at(-1)?.slice(0, 200)}`);
} finally {
  await gw.stop();
  await tg.stop();
}
