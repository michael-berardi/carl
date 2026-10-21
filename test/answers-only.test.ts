// Answers only, by default: an inbound message gets one final reply, no draft and no tool line, unless the operator
// turns streaming on. The delivered message is also recorded where `utp ultrabot audit` reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramChannel } from "../src/channels/telegram.ts";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const OP = 4242;
const TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz";
const ANSWER = "Hello <Mike>: the answer is **42** & that is all.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Turn {
  texts: string[];
  messages: { method: string; body: any }[];
  rows: any[];
}

/**
 * One inbound message through the real channel against the fake Bot API. Every run is paced the same way
 * (`toolAtMs`/`endAtMs`): the brain writes a line at once, reports a tool at 1 s and answers at 3 s, so a draft has
 * time to show up (drafts flush at 900 ms and then at most every 1.2 s). Without that pacing a test could not tell
 * "streaming is off" from "the answer came back too fast to stream".
 */
async function turn(t: any, opts: { stream?: boolean; toolAtMs?: number; endAtMs?: number; ultraterm?: boolean }): Promise<Turn> {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-answers-only-"));
  const logDir = join(home, "messages");
  const previousLogDir = process.env.CARL_MESSAGE_LOG_DIR;
  process.env.CARL_MESSAGE_LOG_DIR = logDir;
  mkdirSync(join(home, "state"), { recursive: true });
  const telegram: any = { allowFrom: [OP], homeChat: OP, apiBase: tg.base };
  if (opts.stream !== undefined) telegram.stream = opts.stream;
  const config: any = { telegram, api: { enabled: false } };
  // An installation that is not wired to UltraTerm must not write into UltraTerm's log at all.
  if (opts.ultraterm !== false) config.ultraterm = { home: join(home, "ultraterm") };
  writeFileSync(join(home, "carl.json"), JSON.stringify(config));
  const brain: any = {
    ask: async (_k: string, _i: any, h: any) => {
      const started = Date.now();
      const until = async (at = 0) => { const wait = at - (Date.now() - started); if (wait > 0) await sleep(wait); };
      h?.onText?.("Half a sentence, still working");
      await until(opts.toolAtMs ?? 1_000);
      h?.onTool?.("bash", "ls -la");
      await until(opts.endAtMs ?? 3_000);
      return { ok: true, text: ANSWER, aborted: false, toolCalls: 1, model: "test/model" };
    },
    whenRegistered: async () => {},
    status: () => ({}),
    routerState: new Map(),
    shellSandbox: undefined,
  };
  const channel = new TelegramChannel(loadConfig(home), TOKEN, brain, new Log(undefined));
  await channel.start();
  t.after(async () => {
    await channel.stop();
    await tg.stop();
    rmSync(home, { recursive: true, force: true });
    if (previousLogDir === undefined) delete process.env.CARL_MESSAGE_LOG_DIR;
    else process.env.CARL_MESSAGE_LOG_DIR = previousLogDir;
  });
  tg.message(OP, "what is the answer");
  await tg.waitFor(() => tg.texts(OP).some((text) => text.includes("42")), 20_000, "the final answer");
  // The row is written after the call that delivered the answer, so wait for it instead of reading too early.
  const logFile = join(logDir, "hermes.jsonl");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(logFile)) await sleep(25);
  const rows = existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return {
    texts: tg.texts(OP),
    messages: tg.calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map(({ method, body }) => ({ method, body })),
    rows,
  };
}

test("without telegram.stream, an inbound message gets one final answer and no tool line", async (t) => {
  const answered = await turn(t, {});
  assert.equal(answered.messages.length, 1, `one message in the chat, not a draft plus a reply: ${JSON.stringify(answered.texts)}`);
  assert.equal(answered.messages[0].method, "sendMessage", "the answer is posted once and never edited");
  assert.ok(answered.texts[0].includes("42"), "the final answer is what was delivered");
  assert.ok(!answered.texts[0].includes("⚙"), "no tool line");
  assert.ok(!answered.texts[0].includes("Half a sentence"), "no interim answer");
});

test("telegram.stream false is the same: one answer, no draft frame", async (t) => {
  const answered = await turn(t, { stream: false });
  assert.equal(answered.messages.length, 1, `one message, not a draft plus a reply: ${JSON.stringify(answered.messages)}`);
  assert.ok(!answered.texts[0].includes("⚙") && answered.texts[0].includes("42"));
});

test("a missing telegram.stream key means answers only: the shipped default", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "carl-default-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP } }));
  assert.equal(loadConfig(home).telegram.stream, false, "a fresh install or a reseeded config gets answers only");
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, stream: true } }));
  assert.equal(loadConfig(home).telegram.stream, true, "the operator can still turn streaming on");
});

test("contradiction check: stream true still streams, tool line included (the opt-in keeps working)", async (t) => {
  const answered = await turn(t, { stream: true, toolAtMs: 1_000, endAtMs: 3_000 });
  assert.equal(answered.messages[0].method, "sendMessage", "a streaming reply starts as a draft");
  assert.ok(String(answered.messages[0].body.text).includes("Half a sentence"), "the draft shows the answer as it is written");
  assert.ok(
    answered.messages.some((m) => m.method === "editMessageText" && String(m.body.text).includes("⚙ bash")),
    `the tool line only ever appears inside a draft, when streaming is on: ${JSON.stringify(answered.messages.map((m) => [m.method, m.body.text]))}`,
  );
});

test("the delivered answer is recorded for `utp ultrabot audit` as one plain-text gateway row", async (t) => {
  const answered = await turn(t, {});
  assert.equal(answered.rows.length, 1, `one delivered message recorded: ${JSON.stringify(answered.rows)}`);
  const row = answered.rows[0];
  assert.equal(row.v, 1);
  assert.equal(row.writer, "hermes");
  assert.equal(row.gateway, "carl");
  assert.equal(row.method, "sendMessage");
  assert.equal(row.chatId, String(OP));
  assert.equal(typeof row.messageId, "number");
  assert.equal(row.status, "delivered");
  assert.equal(row.ok, true);
  assert.ok(row.ts && !Number.isNaN(Date.parse(row.ts)), "a timestamp the audit can order");
  assert.ok(row.text.includes("42") && row.text.includes("Hello <Mike>"), "the text the chat shows");
  assert.ok(!row.text.includes("<b>") && !row.text.includes("**"), "HTML and markdown turned back into plain text");
});

test("an installation that is not wired to UltraTerm writes no log at all", async (t) => {
  const answered = await turn(t, { ultraterm: false });
  assert.equal(answered.messages.length, 1, "the answer is still delivered");
  assert.equal(answered.rows.length, 0, "no row is written for an installation that is not wired to UltraTerm");
});

test("a streamed reply's draft frames are recorded too, so an edited answer is visible to the audit", async (t) => {
  const answered = await turn(t, { stream: true, toolAtMs: 1_000, endAtMs: 3_000 });
  const frames = answered.rows.filter((row) => typeof row.text === "string" && row.text.includes("Half a sentence"));
  assert.ok(frames.length >= 2, `draft and its edit are separate rows: ${JSON.stringify(answered.rows.map((r) => [r.method, r.text]))}`);
  assert.ok(answered.rows.some((row) => typeof row.text === "string" && row.text.includes("⚙ bash")), "the tool line is recorded where the audit reads it");
});
