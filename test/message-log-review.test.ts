// Regression coverage for Sonnet audit review run-aa04ebb7; synthetic credentials only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as audit from "../src/message-log.ts";

function scratch(t: any) {
  const root = mkdtempSync(join(tmpdir(), "carl-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "private", "messages");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { root, dir };
}
const row = (dir: string) => JSON.parse(readFileSync(join(dir, "hermes.jsonl"), "utf8").trim().split("\n").at(-1)!);

test("review: redaction covers URL bot tokens, vendor keys, headers and secret fields without hiding prose", (t) => {
  const { dir } = scratch(t);
  const secrets = ["123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd", "ghp_SyntheticSyntheticSynthetic0123456789", "github_pat_SyntheticSyntheticSynthetic0123456789", "xoxb-" + "0000000000-1111111111-SyntheticSynth", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"];
  const text = `https://api.telegram.org/bot${secrets[0]}/getMe ${secrets.slice(1).join(" ")} Authorization: Basic dTpw Proxy-Authorization: Bearer c3ludGhldGlj ACCESS_TOKEN="synthetic secret tail" {"password":"synthetic-json-secret", "token": "unterminated-secret`;
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text, document: { file_name: text }, reply_markup: { inline_keyboard: [[{ text }]] } }, undefined, { requestId: "test", status: "unknown", error: text });
  const persisted = readFileSync(join(dir, "hermes.jsonl"), "utf8");
  for (const secret of [...secrets, "dTpw", "c3ludGhldGlj", "synthetic secret tail", "synthetic-json-secret", "unterminated-secret"]) assert.equal(persisted.includes(secret), false, "credential must not be persisted");
  assert.equal(row(dir).masked, true);
  const plain = `Basic configuration failed; Authorization failed; Authorization: Basic; sk-short and 12345:abc; ghp_short and xoxb-short; sunghp_SyntheticSyntheticSynthetic0123456789; {"status":"ok","token":null,"tokens_used":42}; don't panic: it's the user's "token" words; exit status 1 at 12:30:45`;
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: plain }, { message_id: 2 });
  assert.equal(row(dir).text, plain);
  assert.equal(row(dir).exact, true);
});

test("review: only explicit carl-send provenance reads validated bounded environment values", (t) => {
  const { dir } = scratch(t);
  for (const [key, value] of Object.entries({ SOURCE: "alert", KIND: "blocked", JOB: "J-2807", ALERT: "a1" })) {
    const name = `ULTRABOT_LOG_${key}`; const old = process.env[name]; process.env[name] = value;
    t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
  }
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: "gateway" }, { message_id: 1 });
  assert.deepEqual([row(dir).source, row(dir).kind, row(dir).job, row(dir).alert], ["telegram", "sendMessage", null, null]);
  const previous = process.env.CARL_MESSAGE_LOG_DIR;
  process.env.CARL_MESSAGE_LOG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CARL_MESSAGE_LOG_DIR; else process.env.CARL_MESSAGE_LOG_DIR = previous; });
  const gateway: Parameters<typeof audit.recordDeliveries>[0] = {};
  audit.recordDeliveries(gateway, true, () => {});
  gateway.onDelivered!("sendMessage", { chat_id: 1, text: "gateway hook" }, { message_id: 2 });
  assert.deepEqual([row(dir).source, row(dir).kind, row(dir).job, row(dir).alert], ["telegram", "sendMessage", null, null]);
  const read = (audit as any).sendLogOrigin;
  assert.equal(typeof read, "function");
  const origin = read();
  process.env.ULTRABOT_LOG_JOB = "later-env-change";
  new audit.MessageLog(dir, () => {}, origin).record("sendMessage", { chat_id: 1, text: "cli" }, { message_id: 2 });
  assert.deepEqual([row(dir).source, row(dir).kind, row(dir).job, row(dir).alert], ["alert", "blocked", "J-2807", "a1"]);
  for (const key of ["SOURCE", "KIND", "JOB", "ALERT"]) {
    for (const value of ["x".repeat(129), "bad\nvalue", "../unsafe", "<html>"]) {
      const warnings: string[] = [];
      const invalid = read({ [`ULTRABOT_LOG_${key}`]: value }, (msg: string) => warnings.push(msg));
      assert.equal(invalid[key.toLowerCase()], undefined);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].includes(value), false, "diagnostic must not echo unsafe metadata");
    }
  }
  assert.equal(read({ ULTRABOT_LOG_KIND: "invented-kind" }).kind, undefined);
  assert.deepEqual(read({ ULTRABOT_LOG_JOB: "", ULTRABOT_LOG_ALERT: "" }), { job: null, alert: null });
});

test("review: reused live PID locks are reclaimed and skipped receipts remain counted", (t) => {
  const { dir } = scratch(t);
  const lock = join(dir, "hermes.jsonl.lock");
  const start = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
  const age = () => utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  writeFileSync(lock, `${process.pid}-${Date.now()}-active`); age();
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: "lost" }, { message_id: 1 });
  assert.equal(existsSync(join(dir, "hermes.jsonl")), false, "a live owner of the same birth is not stolen");
  writeFileSync(lock, `${process.pid}-1-reused`); age();
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: "next" }, { message_id: 2 });
  assert.equal(row(dir).messageId, 2);
  assert.ok(row(dir).writeErrors >= 1, "the skipped receipt remains counted after takeover");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start, nonce: "active" })); age();
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: "held" }, { message_id: 3 });
  assert.equal(row(dir).messageId, 2, "new-format locks compare the actual start identity too");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start: "different-process-birth", nonce: "reused" })); age();
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: "reclaimed" }, { message_id: 4 });
  assert.equal(row(dir).messageId, 4);
});

test("review: a 775 owned ancestor permits private logs but an unsafe immediate parent explains refusal", (t) => {
  const { root, dir } = scratch(t);
  chmodSync(root, 0o775);
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: "safe" }, { message_id: 1 });
  assert.equal(row(dir).messageId, 1);
  assert.equal(statSync(root).mode & 0o777, 0o775, "do not chmod a user's home ancestor");
  chmodSync(join(root, "private"), 0o775);
  const warnings: string[] = [];
  new audit.MessageLog(dir, (msg) => warnings.push(msg)).record("sendMessage", { chat_id: 1, text: "unsafe" }, { message_id: 2 });
  assert.equal(row(dir).messageId, 1);
  assert.match(warnings[0], /immediate parent.*owner-only/);
});


for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", "xapp-"]) {
  test(`review: ${prefix} credential family is masked only at a token boundary`, (t) => {
    const { dir } = scratch(t);
    const credential = `${prefix}SyntheticSyntheticSynthetic0123456789`;
    new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: `(${credential})`, document: { file_name: credential } }, { message_id: 1 });
    assert.equal(readFileSync(join(dir, "hermes.jsonl"), "utf8").includes(credential), false);
    const plain = `sun${credential}`;
    new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text: plain }, { message_id: 2 });
    assert.equal(row(dir).text, plain);
  });
}

test("review: escaped, single-quoted and unquoted secret assignments are masked without changing unrelated JSON", (t) => {
  const { dir } = scratch(t);
  const text = String.raw`{"token":"secret-one","error":"boom","tokens_used":42} {'client_secret':'secret-two with spaces'} {\"refresh_token\": \"secret-three\", \"ok\": true} API_KEY=secret-four PASSWORD = 'secret-five with spaces'`;
  new audit.MessageLog(dir).record("sendMessage", { chat_id: 1, text }, { message_id: 1 });
  for (const value of ["secret-one", "secret-two", "secret-three", "secret-four", "secret-five"]) assert.equal(row(dir).text.includes(value), false);
  assert.ok(row(dir).text.includes('"error":"boom"') && row(dir).text.includes('"tokens_used":42') && row(dir).text.includes(String.raw`\"ok\": true`));
});
