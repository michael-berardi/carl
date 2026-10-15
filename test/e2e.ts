// End-to-end: real model (Pi credentials), fake Telegram, temp homes. Run: npm run test:e2e
// Exercises the gateway the way UltraTerm and an operator use it, and checks every side effect.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { loadPlugins } from "../src/plugins.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const OP = 4242; // allowed operator
const STRANGER = 777;
const KEY = "test-key-0123456789abcdef";

const results: { name: string; ok: boolean; ms: number; error?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: (e as Error).message });
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

const tg = new FakeTelegram();
await tg.start();
const root = mkdtempSync(join(process.env.CARL_E2E_DIR ?? tmpdir(), "carl-e2e-"));
const home = join(root, "carl");
const hermes = join(root, "hermes");
mkdirSync(home, { recursive: true });
mkdirSync(hermes, { recursive: true });
// A fake ut-overseer for decision buttons: echoes its arguments as the result.
const overseer = join(root, "ut-overseer");
writeFileSync(overseer, `#!/bin/sh\necho "{\\"ok\\":true,\\"accepted\\":true,\\"result\\":\\"Sent choice $5 for $3\\"}"\n`);
chmodSync(overseer, 0o755);
writeFileSync(join(home, ".env"), `TELEGRAM_BOT_TOKEN=123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz\nCARL_API_KEY=${KEY}\n`);
const port = 18_000 + Math.floor(Math.random() * 1_000);
writeFileSync(join(home, "carl.json"), JSON.stringify({
  model: process.env.CARL_E2E_MODEL ?? "openai-codex/gpt-6.1-sol",
  thinking: "low",
  tools: ["read", "bash"],
  telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: true },
  api: { port },
  ultraterm: { home: hermes, overseerBin: overseer },
}));
const workspaceProbe = join(root, "carl", "workspace", "doomed");

const cfg = loadConfig(home);
const gw = new Gateway(cfg);
const toolCalls: { conversation: string; name: string; args: any }[] = [];
gw.brain.on("transcript", (e: any) => { for (const c of e.toolCalls ?? []) toolCalls.push({ conversation: e.conversation, name: c.name, args: c.args }); });
for (const p of await loadPlugins(cfg)) gw.use(p);
await gw.start();
const idle = () => tg.waitFor(() => gw.brain.busyCount() === 0, 120_000, "the run to settle");
/** Send as the operator and wait for the run to settle; returns the texts shown since. */
async function say(text: string): Promise<string[]> {
  await idle();
  const t = Date.now();
  tg.message(OP, text);
  await tg.waitFor(() => gw.brain.busyCount() > 0, 10_000, "the run to start").catch(() => {});
  await idle();
  await new Promise((r) => setTimeout(r, 300));
  return tg.texts(OP, t);
}
const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers ?? {}) } });

await step("startup writes UltraTerm gateway_state.json", async () => {
  const s = JSON.parse(readFileSync(join(hermes, "gateway_state.json"), "utf8"));
  assert.equal(s.pid, process.pid);
  assert.equal(s.gateway_state, "running");
  assert.equal(s.platforms.telegram.state, "connected");
  assert.match(s.updated_at, /\+00:00$/);
  assert.equal(typeof s.active_agents, "number");
});

await step("strangers are ignored", async () => {
  tg.message(STRANGER, "hello?");
  await new Promise((r) => setTimeout(r, 3_000));
  assert.equal(tg.texts(STRANGER).length, 0);
  assert.ok(!gw.brain.activeConversations().some((c) => c.key.includes(String(STRANGER))), "no conversation was opened for a stranger");
});

await step("operator gets a correct reply", async () => {
  const shown = await say("What is 6 times 7? Reply with only the number.");
  assert.ok(shown.some((t) => /\b42\b/.test(t)), `reply: ${shown.join(" | ")}`);
});

await step("conversation is mirrored into state.db for the UltraTerm pane", async () => {
  const db = new DatabaseSync(join(hermes, "state.db"), { readOnly: true });
  const session = db.prepare("SELECT m.session_id AS id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.source='telegram' AND m.role IN ('user','assistant') ORDER BY m.id DESC LIMIT 1").get() as any;
  assert.ok(session?.id?.startsWith("carl_"));
  const roles = (db.prepare("SELECT role FROM messages WHERE session_id = ? ORDER BY id").all(session.id) as any[]).map((r) => r.role);
  assert.deepEqual(roles.slice(0, 2), ["user", "assistant"], roles.join(","));
  const usage = db.prepare("SELECT api_call_count, input_tokens FROM session_model_usage WHERE session_id = ?").get(session.id) as any;
  assert.ok(usage.api_call_count >= 1 && usage.input_tokens > 0);
  db.close();
});

await step("tool use: bash runs and the answer uses its output", async () => {
  const before = toolCalls.length;
  const shown = await say("Use bash to run: echo carl-$((40+2)). Reply with only the command output.");
  assert.ok(shown.some((t) => t.includes("carl-42")), `reply: ${shown.join(" | ")}`);
  assert.ok(toolCalls.slice(before).some((c) => c.name === "bash" && /echo/.test(c.args?.command ?? "")), "the answer came from a real bash call");
});

await step("dangerous command waits for approval, runs after Run once", async () => {
  mkdirSync(workspaceProbe, { recursive: true });
  await idle();
  const before = tg.calls.length;
  tg.message(OP, `Run this exact bash command: rm -rf ${workspaceProbe} . Then reply "removed".`);
  await tg.waitFor(() => tg.calls.slice(before).some((c) => c.method === "sendMessage" && c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("ca:")), 90_000, "approval card");
  const card = tg.calls.slice(before).find((c) => c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("ca:"))!;
  assert.ok(existsSync(workspaceProbe), "command ran before approval");
  tg.callback(OP, card.body.reply_markup.inline_keyboard[0][0].callback_data, { message_id: 1, chat: { id: OP, type: "private" }, text: card.body.text });
  await tg.waitFor(() => !existsSync(workspaceProbe), 60_000, "approved command to run");
});

await step("hardline command is refused without asking", async () => {
  const before = tg.calls.length;
  await say("Run exactly this with bash: sudo true. Then tell me what happened in one sentence.");
  assert.ok(!tg.calls.slice(before).some((c) => c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("ca:")), "hardline must not ask for approval");
  const shadow = readFileSync(join(home, "psyche", "shadow.jsonl"), "utf8");
  assert.match(shadow, /hardline: sudo/);
});

await step("/status and /new commands", async () => {
  await idle();
  const t = Date.now();
  const before = (await gw.brain.status(`telegram:dm:${OP}`)).sessionId;
  tg.message(OP, "/status");
  await tg.waitFor(() => tg.texts(OP, t).some((x) => x.includes("sessionId")), 10_000, "/status reply");
  tg.message(OP, "/new");
  await tg.waitFor(() => tg.texts(OP, t).some((x) => x.includes("Fresh conversation")), 15_000, "/new reply");
  const after = (await gw.brain.status(`telegram:dm:${OP}`)).sessionId;
  assert.ok(before && after && before !== after, `session id changed (${before} -> ${after})`);
});

await step("API: health, capabilities, jobs, skills, toolsets", async () => {
  assert.equal((await api("/v1/health")).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/health`)).status, 401, "API must require the key");
  const caps = await (await api("/api/intake/capabilities")).json();
  assert.equal(caps.contract, "hermes.canonical-intake.v1");
  assert.ok(caps.durable && caps.idempotent && caps.canonicalMessaging);
  const jobs = await (await api("/api/jobs?include_disabled=true")).json();
  assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.some((j: any) => j.name === "Individuation"));
  assert.ok(Array.isArray((await (await api("/v1/skills")).json()).data));
  assert.ok(Array.isArray((await (await api("/v1/toolsets")).json()).data));
});

await step("composer intake: idempotent, answered in the Telegram thread, mirrored", async () => {
  await say("Remember the word: periwinkle. Reply OK.");
  const db = new DatabaseSync(join(hermes, "state.db"), { readOnly: true });
  const sid = (db.prepare("SELECT m.session_id AS id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.source='telegram' ORDER BY m.id DESC LIMIT 1").get() as any).id;
  db.close();
  const body = JSON.stringify({ message: "Which word did I ask you to remember? One word.", mirror: true, recipient: String(OP) });
  const first = await api(`/api/sessions/${sid}/intake`, { method: "POST", headers: { "idempotency-key": "req-1" }, body });
  assert.equal(first.status, 202);
  const receipt = await first.json();
  assert.deepEqual([receipt.contract, receipt.requestId, receipt.sessionId, receipt.accepted], ["hermes.canonical-intake.v1", "req-1", sid, true]);
  const again = await api(`/api/sessions/${sid}/intake`, { method: "POST", headers: { "idempotency-key": "req-1" }, body });
  assert.equal(again.status, 202);
  const conflict = await api(`/api/sessions/${sid}/intake`, { method: "POST", headers: { "idempotency-key": "req-1" }, body: JSON.stringify({ message: "different" }) });
  assert.equal(conflict.status, 409);
  await tg.waitFor(() => tg.texts(OP).some((t) => t.includes("You (UltraTerm)")), 90_000, "mirrored composer reply");
  const mirrored = tg.texts(OP).find((t) => t.includes("You (UltraTerm)"))!;
  assert.match(mirrored, /periwinkle/i, mirrored);
  const db2 = new DatabaseSync(join(hermes, "state.db"), { readOnly: true });
  const runs = (db2.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND content LIKE 'Which word did I ask you to remember%'").get() as any).n;
  db2.close();
  assert.equal(runs, 1, "the idempotent request ran exactly once");
});

await step("steering: a message sent while a turn runs joins that turn", async () => {
  await idle();
  const t = Date.now();
  tg.message(OP, "Run this bash command exactly: sleep 6 && echo first-done. Then reply with the output and anything else I add meanwhile.");
  await tg.waitFor(() => gw.brain.busyCount() > 0, 10_000, "first run to start");
  await new Promise((r) => setTimeout(r, 1_500));
  const second = tg.message(OP, "Also include the word saffron in your reply.");
  await tg.waitFor(() => tg.calls.some((c) => c.method === "setMessageReaction" && c.body.message_id === second), 15_000, "the 👀 steer acknowledgment");
  await idle();
  const shown = tg.texts(OP, t).join(" | ");
  assert.match(shown, /first-done/, shown);
  assert.match(shown, /saffron/i, shown);
});

await step("/stop ends a running turn", async () => {
  await idle();
  const t = Date.now();
  tg.message(OP, "Run this bash command exactly and wait for it: sleep 25 && echo late");
  await tg.waitFor(() => toolCalls.some((c) => /sleep 25/.test(c.args?.command ?? "")), 60_000, "the sleep to start");
  tg.message(OP, "/stop");
  await tg.waitFor(() => tg.texts(OP, t).some((x) => /Stopping/.test(x)), 10_000, "/stop acknowledgment");
  await idle();
  const shown = tg.texts(OP, t).join(" | ");
  assert.doesNotMatch(shown, /\blate\b/, shown);
  assert.match(shown, /stopped/i, shown);
});

await step("Deny on an approval card means the command does not run", async () => {
  await idle();
  const probe = join(root, "carl", "workspace", "kept");
  mkdirSync(probe, { recursive: true });
  const before = tg.calls.length;
  tg.message(OP, `Run this exact bash command: rm -rf ${probe} . Then tell me what happened in one line.`);
  await tg.waitFor(() => tg.calls.slice(before).some((c) => c.body.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data?.startsWith("ca:")), 90_000, "approval card");
  const card = tg.calls.slice(before).find((c) => c.body.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data?.startsWith("ca:"))!;
  assert.match(card.body.text, /<pre>rm -rf /, "the card shows the exact command as code");
  tg.callback(OP, card.body.reply_markup.inline_keyboard[0][1].callback_data, { message_id: 1, chat: { id: OP, type: "private" }, text: card.body.text });
  await idle();
  assert.ok(existsSync(probe), "denied command must not run");
});

await step("model selection: read and refuse stale writes", async () => {
  const db = new DatabaseSync(join(hermes, "state.db"), { readOnly: true });
  const sid = (db.prepare("SELECT id FROM sessions WHERE source='telegram' ORDER BY started_at DESC LIMIT 1").get() as any).id;
  db.close();
  const status = await (await api(`/api/sessions/${sid}/model-selection`)).json();
  assert.equal(status.persisted, true);
  const options = await (await api("/api/model/options")).json();
  assert.ok(options.providers.length >= 1);
  const stale = await api(`/api/sessions/${sid}/model-selection`, { method: "POST", headers: { "idempotency-key": "m-1" }, body: JSON.stringify({ provider: "openai-codex", model: "gpt-6.1-sol", expectedProvider: "openai-codex", expectedModel: "something-else" }) });
  assert.equal(stale.status, 409);
});

await step("decision button runs ut-overseer and marks the message", async () => {
  const before = tg.calls.length;
  tg.callback(OP, "utd:D-17:2", { message_id: 555, chat: { id: OP, type: "private" }, text: "Approve the deploy?" });
  await tg.waitFor(() => tg.calls.slice(before).some((c) => c.method === "answerCallbackQuery" && /Sent choice 2 for D-17/.test(c.body.text ?? "")), 10_000, "decision toast");
  const edit = tg.calls.slice(before).find((c) => c.method === "editMessageText" && c.body.message_id === 555);
  assert.match(edit?.body.text ?? "", /Approve the deploy\?\n\n✅ Sent choice 2/);
});

await step("OpenAI-compatible chat completions (stream and plain)", async () => {
  const plain = await (await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Reply with exactly: pong" }], user: "e2e" }) })).json();
  assert.match(plain.choices[0].message.content, /pong/i);
  const res = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Reply with exactly: ping" }], user: "e2e" }) });
  const text = await res.text();
  assert.match(text, /data: \[DONE\]/);
  assert.match(text, /ping/i);
});

await step("schedule: command job delivers its output home", async () => {
  await idle();
  const job = gw.scheduler.add({ name: "echo-job", when: "@daily", command: "echo scheduled-output-ok", deliver: "home" });
  await gw.scheduler.runNow(job.id);
  await tg.waitFor(() => tg.texts(OP).some((t) => t.includes("scheduled-output-ok")), 10_000, "scheduled output");
  const jobs = await (await api("/api/jobs?include_disabled=true")).json();
  assert.equal(jobs.jobs.find((j: any) => j.id === job.id).last_status, "ok");
});

await step("clean stop marks UltraTerm state stopped", async () => {
  await gw.stop("e2e done");
  const s = JSON.parse(readFileSync(join(hermes, "gateway_state.json"), "utf8"));
  assert.equal(s.gateway_state, "stopped");
  assert.equal(s.pid, null);
});

await tg.stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed; home ${root}`);
process.exit(failed.length ? 1 : 0);
