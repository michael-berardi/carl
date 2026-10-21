// The UltraTerm message-log row `utp ultrabot audit` reads for the gateway's sends (hermes.jsonl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { deliveryRow, MessageLog, messageLogDir, recordDeliveries } from "../src/message-log.ts";
import { TelegramApi } from "../src/channels/telegram-api.ts";

function scratch(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), "carl-message-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a delivered sendMessage becomes one gateway row with the text the chat shows", async (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  log.record("sendMessage", { chat_id: 8506070724, text: "Hello &lt;Mike&gt; &amp; <b>friends</b>", parse_mode: "HTML" }, { message_id: 4901, chat: { id: 8506070724 } });
  const row = JSON.parse(readFileSync(join(dir, "hermes.jsonl"), "utf8").trim());
  assert.equal(statSync(join(dir, "hermes.jsonl")).mode & 0o777, 0o600, "the log is owner-only");
  assert.deepEqual(
    { v: row.v, writer: row.writer, gateway: row.gateway, method: row.method, chatId: row.chatId, messageId: row.messageId, status: row.status, ok: row.ok },
    { v: 1, writer: "hermes", gateway: "carl", method: "sendMessage", chatId: "8506070724", messageId: 4901, status: "delivered", ok: true },
  );
  assert.equal(row.text, "Hello <Mike> & friends", "HTML turned back into plain text");
  assert.equal(row.buttons, null);
  assert.equal(row.job, null);
});

test("edits, deletions and documents are recorded; typing, polls and callbacks are not messages", async (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  log.record("editMessageText", { chat_id: "-100200", message_id: 7, text: "longer answer" }, { message_id: 7 });
  log.record("deleteMessage", { chat_id: "-100200", message_id: 7 }, true);
  log.record("sendDocument", { chat_id: 42, document: { file_name: "report.pdf" } }, { message_id: 9 });
  for (const method of ["sendChatAction", "getUpdates", "answerCallbackQuery", "getMe"]) log.record(method, { chat_id: 42 }, true);
  const rows = readFileSync(join(dir, "hermes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => [r.method, r.messageId]), [["editMessageText", 7], ["deleteMessage", 7], ["sendDocument", 9]]);
  assert.equal(rows[2].file, "report.pdf");
});

test("a call with no usable chat or message identity is not recorded", () => {
  assert.equal(deliveryRow("sendMessage", { chat_id: "@channel", text: "hi" }, { message_id: 3 }), undefined, "no numeric chat: the audit could not scope it");
  assert.equal(deliveryRow("sendMessage", { chat_id: 1, text: "hi" }, {}), undefined, "a send with no message id proves nothing");
  assert.equal(deliveryRow("sendChatAction", { chat_id: 1 }, true), undefined);
  assert.deepEqual(deliveryRow("deleteMessages", { chat_id: 1, message_ids: [4, 5] }, true)?.messageId, [4, 5]);
  assert.deepEqual(deliveryRow("sendMessage", { chat_id: 1, text: "pick one", reply_markup: { inline_keyboard: [[{ text: "Yes" }, { text: "No" }]] } }, { message_id: 2 })?.buttons, ["Yes", "No"]);
});

test("hermes.jsonl rotates at 10 MiB and keeps five files, as `utp` expects", async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "hermes.jsonl"), "x".repeat(10 * 1024 * 1024));
  writeFileSync(join(dir, "hermes.jsonl.1"), "one\n");
  const log = new MessageLog(dir);
  log.record("sendMessage", { chat_id: 1, text: "after rotation" }, { message_id: 2 });
  assert.ok(statSync(join(dir, "hermes.jsonl")).size < 1_000, "the active file starts over");
  assert.equal(readFileSync(join(dir, "hermes.jsonl.1"), "utf8").length, 10 * 1024 * 1024, "the old file is now .1");
  assert.equal(readFileSync(join(dir, "hermes.jsonl.2"), "utf8"), "one\n", "the previous .1 moved to .2");
});

test("a log that cannot be written never breaks a send and says so once", async (t) => {
  const dir = scratch(t);
  const warnings: string[] = [];
  const log = new MessageLog(join(dir, "not-a-directory"), (msg) => warnings.push(msg));
  writeFileSync(join(dir, "not-a-directory"), "a file, not a folder");
  assert.doesNotThrow(() => log.record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 }));
  assert.doesNotThrow(() => log.record("sendMessage", { chat_id: 1, text: "hi again" }, { message_id: 3 }));
  assert.equal(warnings.length, 1, "one line per process, never one per send");
});

test("recording is off unless the installation is wired to UltraTerm (and the switch only says where)", async (t) => {
  const dir = scratch(t);
  const plain = new TelegramApi("123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz");
  assert.equal(recordDeliveries(plain, false, () => {}), false, "a plain Carl install does not write UltraTerm's log");
  assert.equal(plain.onDelivered, undefined);
  const wired = new TelegramApi("123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz");
  assert.equal(recordDeliveries(wired, true, () => {}), true);
  process.env.CARL_MESSAGE_LOG_DIR = dir;
  t.after(() => delete process.env.CARL_MESSAGE_LOG_DIR);
  recordDeliveries(wired, true, () => {});
  wired.onDelivered?.("sendMessage", { chat_id: 5, text: "hi" }, { message_id: 6 });
  assert.equal(readFileSync(join(dir, "hermes.jsonl"), "utf8").includes('"messageId":6'), true, "the wired API writes rows");
});

test("a send Telegram did not accept is not recorded", async (t) => {
  const dir = scratch(t);
  const server = createServer((req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const api = new TelegramApi("123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", `http://127.0.0.1:${(server.address() as any).port}`);
  const previous = process.env.CARL_MESSAGE_LOG_DIR;
  process.env.CARL_MESSAGE_LOG_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.CARL_MESSAGE_LOG_DIR;
    else process.env.CARL_MESSAGE_LOG_DIR = previous;
  });
  recordDeliveries(api, true, () => {});
  await assert.rejects(() => api.call("sendMessage", { chat_id: 1, text: "hi" }));
  assert.equal(existsSync(join(dir, "hermes.jsonl")), false, "a failed send is not a delivered message");
});

test("the log folder is owner-only and the file stays owner-only when it already existed", async (t) => {
  const dir = scratch(t);
  const logDir = join(dir, "logs");
  const log = new MessageLog(logDir);
  log.record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 });
  assert.equal(statSync(logDir).mode & 0o777, 0o700, "the folder is owner-only");
  chmodSync(join(logDir, "hermes.jsonl"), 0o644);
  log.record("sendMessage", { chat_id: 1, text: "again" }, { message_id: 3 });
  assert.equal(statSync(join(logDir, "hermes.jsonl")).mode & 0o777, 0o600, "a loose file is tightened again");
});

test("what was .5 is dropped, so the log keeps five rotated files", async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "hermes.jsonl"), "x".repeat(10 * 1024 * 1024));
  for (let n = 1; n <= 5; n++) writeFileSync(join(dir, `hermes.jsonl.${n}`), `file ${n}\n`);
  const log = new MessageLog(dir);
  log.record("sendMessage", { chat_id: 1, text: "after rotation" }, { message_id: 2 });
  assert.equal(readFileSync(join(dir, "hermes.jsonl.5"), "utf8"), "file 4\n", "the oldest rotated file is dropped and the rest move up");
  assert.equal(readFileSync(join(dir, "hermes.jsonl.1"), "utf8").length, 10 * 1024 * 1024, "the old file is now .1");
});

test("a warning that itself fails never escapes into the send path", async (t) => {
  const dir = scratch(t);
  const log = new MessageLog(join(dir, "not-a-directory"), () => {
    throw new Error("the log file is gone");
  });
  writeFileSync(join(dir, "not-a-directory"), "a file, not a folder");
  assert.doesNotThrow(() => log.record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 }));
});

test("a copy or a forward records the message Telegram created, not the source message", () => {
  assert.equal(deliveryRow("copyMessage", { chat_id: 1, from_message_id: 7 }, { message_id: 42 })?.messageId, 42);
  assert.equal(deliveryRow("forwardMessage", { chat_id: 1, from_message_id: 7 }, { message_id: 43 })?.messageId, 43);
  assert.equal(deliveryRow("editMessageText", { chat_id: 1, message_id: 7, text: "longer" }, { message_id: 7 })?.messageId, 7);
});

test("the write lock keeps two processes from writing at once and is left behind only by a crash", async (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  log.record("sendMessage", { chat_id: 1, text: "first" }, { message_id: 2 });
  assert.equal(existsSync(join(dir, "hermes.jsonl.lock")), false, "the lock is released after the write");
  // A lock left behind by a killed process is taken over, not waited on.
  writeFileSync(join(dir, "hermes.jsonl.lock"), "stale");
  const old = Date.now() - 60_000;
  utimesSync(join(dir, "hermes.jsonl.lock"), old / 1000, old / 1000);
  log.record("sendMessage", { chat_id: 1, text: "after the stale lock" }, { message_id: 3 });
  const rows = readFileSync(join(dir, "hermes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 2, "the row after the stale lock was written");
  // A lock that is held right now is not taken over: the write is skipped, not faked.
  const warnings: string[] = [];
  const held = new MessageLog(dir, (msg) => warnings.push(msg));
  writeFileSync(join(dir, "hermes.jsonl.lock"), "held");
  held.record("sendMessage", { chat_id: 1, text: "while the lock is held" }, { message_id: 4 });
  const after = readFileSync(join(dir, "hermes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(after.length, 2, "no row is written while another process holds the lock");
  assert.equal(existsSync(join(dir, "hermes.jsonl.lock")), true, "the lock of the other process is left alone");
  assert.equal(warnings.length, 1, "a skipped row is reported once");
});

test("a lock that another process took over during the write is not removed", async (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  // While the row is written, another process takes the lock over: our release must not remove its lock.
  (log as any).rotate = () => {
    writeFileSync(join(dir, "hermes.jsonl.lock"), "another-process");
  };
  log.record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 });
  assert.equal(readFileSync(join(dir, "hermes.jsonl.lock"), "utf8"), "another-process", "the other process keeps its lock");
  assert.equal(readFileSync(join(dir, "hermes.jsonl"), "utf8").includes('"messageId":2'), true, "the row was still written");
});

test("a failed append leaves the log exactly as it was", async (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  log.record("sendMessage", { chat_id: 1, text: "first" }, { message_id: 2 });
  const before = readFileSync(join(dir, "hermes.jsonl"), "utf8");
  // The file cannot be appended to (read-only file, writable folder): the append fails and the rollback runs.
  chmodSync(join(dir, "hermes.jsonl"), 0o400);
  try {
    assert.doesNotThrow(() => log.record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 3 }));
    assert.equal(readFileSync(join(dir, "hermes.jsonl"), "utf8"), before, "the log still holds only the row that was delivered");
  } finally {
    chmodSync(join(dir, "hermes.jsonl"), 0o600);
  }
});

test("a folder that cannot be written to leaves the log untouched", async (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  log.record("sendMessage", { chat_id: 1, text: "first" }, { message_id: 2 });
  const before = readFileSync(join(dir, "hermes.jsonl"), "utf8");
  chmodSync(dir, 0o500);
  try {
    assert.doesNotThrow(() => log.record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 3 }));
    assert.equal(readFileSync(join(dir, "hermes.jsonl"), "utf8"), before, "the log still holds only the row that was delivered");
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("a test that forgets the switch still cannot write into the operator's real log", { skip: !process.env.NODE_TEST_CONTEXT }, async (t) => {
  const dir = scratch(t);
  const previous = process.env.CARL_MESSAGE_LOG_DIR;
  delete process.env.CARL_MESSAGE_LOG_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.CARL_MESSAGE_LOG_DIR;
    else process.env.CARL_MESSAGE_LOG_DIR = previous;
  });
  const where = messageLogDir();
  assert.ok(where.includes("carl-message-log-"), `a scratch folder under the temp dir, not the real log: ${where}`);
  assert.ok(!where.includes(".ultraterm"), "the operator's real log is never the target");
});

test("a channel that is not wired to UltraTerm records nothing at all", async (t) => {
  const dir = scratch(t);
  const home = mkdtempSync(join(tmpdir(), "carl-unwired-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [4242], homeChat: 4242 } }));
  const cfg = loadConfig(home);
  assert.equal(!!cfg.ultraterm, false, "this installation is not wired to UltraTerm");
  const api = new TelegramApi("123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz");
  assert.equal(recordDeliveries(api, !!cfg.ultraterm, () => {}), false);
  assert.equal(api.onDelivered, undefined, "the channel never hooks the logger for a plain install");
});
