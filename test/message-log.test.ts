// The UltraTerm message-log row `utp ultrabot audit` reads for the gateway's sends (hermes.jsonl).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryRow, MessageLog, recordDeliveries } from "../src/message-log.ts";
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

test("recording is off unless the installation is wired to UltraTerm (or a test points it elsewhere)", async (t) => {
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
