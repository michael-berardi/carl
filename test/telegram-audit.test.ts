// Synthetic Bot API responses and private temporary directories only; no Telegram traffic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramApi } from "../src/channels/telegram-api.ts";
import { MessageLog, deliveryRow, recordDeliveries, sendLogOrigin } from "../src/message-log.ts";

const token = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz";
function scratch(t: any) {
  const root = mkdtempSync(join(tmpdir(), "carl-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "messages");
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
function wired(t: any, dir: string) {
  const old = process.env.CARL_MESSAGE_LOG_DIR;
  process.env.CARL_MESSAGE_LOG_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.CARL_MESSAGE_LOG_DIR; else process.env.CARL_MESSAGE_LOG_DIR = old; });
  const api = new TelegramApi(token);
  recordDeliveries(api, true, () => {});
  return api;
}
const rows = (dir: string) => readFileSync(join(dir, "hermes.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));

for (const failure of ["network", "5xx", "invalid-json"]) {
  test(`ambiguous ${failure} mutations are never replayed and are durably identified`, async (t) => {
    const dir = scratch(t);
    const api = wired(t, dir);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      if (failure === "network") throw new Error("response lost after acceptance");
      if (failure === "invalid-json") return new Response("not JSON", { status: 200 });
      return new Response(JSON.stringify({ ok: false, error_code: 503, description: "unavailable" }), { status: 503 });
    });
    const methods = ["sendMessage", "sendPhoto", "sendDocument", "copyMessage", "forwardMessage", "editMessageText", "editMessageReplyMarkup"];
    for (const method of methods) await assert.rejects(api.call(method, { chat_id: 1, message_id: 4, text: "attempt" }));
    assert.equal(requests, methods.length, "one request per ambiguous mutation");
    const recorded = rows(dir);
    assert.equal(recorded.length, methods.length);
    assert.ok(recorded.every((r) => r.status === "unknown" && r.ok === null && typeof r.requestId === "string" && r.requestId.length > 10));
    assert.equal(new Set(recorded.map((r) => r.requestId)).size, methods.length);
    assert.equal(recorded.find((r) => r.method === "copyMessage").messageId, null, "the source message is not the delivered copy");
  });
}

test("reads retry transient failures, but explicit 429 refusals alone permit mutation retry", async (t) => {
  const dir = scratch(t);
  const api = wired(t, dir);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    if (requests === 1) throw new Error("offline");
    return Response.json({ ok: true, result: { id: 1 } });
  });
  assert.deepEqual(await api.call("getMe", {}, { retries: 1 }), { id: 1 });
  assert.equal(requests, 2);
  assert.equal(existsSync(join(dir, "hermes.jsonl")), false, "reads are not message attempts");
  requests = 0;
  let firstAt = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    if (requests === 1) { firstAt = Date.now(); return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 }); }
    assert.ok(Date.now() - firstAt >= 1_000, "retry_after must elapse before the retry");
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  await api.sendMessage(1, "hi");
  assert.equal(requests, 2);
  assert.deepEqual(rows(dir).map((r) => r.status), ["delivered"]);
});

test("definite refusals and multipart failures are observed, including missing identities", async (t) => {
  const dir = scratch(t);
  const api = wired(t, dir);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error_code: 400, description: "bad chat" }, { status: 400 }));
  await assert.rejects(api.sendMessage(1, "hi"));
  await assert.rejects(api.call("sendMessage", { chat_id: "@channel", text: "hi" }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("lost multipart reply"); });
  await assert.rejects(api.sendDocument(1, "report.pdf", new Uint8Array([1]), "caption"));
  const recorded = rows(dir);
  assert.deepEqual(recorded.map((r) => r.status), ["failed", "failed", "unknown"]);
  assert.equal(recorded[0].ok, false);
  assert.equal(recorded[0].messageId, null);
  assert.equal(recorded[1].chatId, null);
  assert.equal(recorded[2].file, "report.pdf");
});

test("secret redaction covers persisted text, metadata, buttons and error reasons", (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  const secrets = ["123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "Bearer super-secret-value"];
  log.record("sendMessage", { chat_id: 1, text: secrets.join(" "), document: { file_name: secrets[0] }, reply_markup: { inline_keyboard: [[{ text: secrets[1] }]] } }, { message_id: 2 });
  const persisted = readFileSync(log.file, "utf8");
  for (const secret of secrets) assert.equal(persisted.includes(secret), false, "secret must be masked before persistence");
  assert.equal(rows(dir)[0].masked, true);
  assert.equal(rows(dir)[0].exact, false);
});

test("an explicit keyboard removal retires the observed keyboard while omitted markup preserves it", () => {
  const card = deliveryRow("sendMessage", { chat_id: 1, text: "ask", reply_markup: { inline_keyboard: [[{ text: "Yes" }]] } }, { message_id: 2 })!;
  const omitted = deliveryRow("editMessageText", { chat_id: 1, message_id: 2, text: "updated" }, true)!;
  if (omitted.buttons !== null) card.buttons = omitted.buttons;
  assert.deepEqual(card.buttons, ["Yes"]);
  const removed = deliveryRow("editMessageReplyMarkup", { chat_id: 1, message_id: 2, reply_markup: { inline_keyboard: [] } }, true)!;
  if (removed.buttons !== null) card.buttons = removed.buttons;
  assert.deepEqual(card.buttons, []);
});

test("carl send origin envelope survives in the sole receipt", (t) => {
  const dir = scratch(t);
  const expected = { source: "alert", kind: "blocked", job: "J-2807", alert: "a1" };
  for (const [key, value] of Object.entries(expected)) { const env = `ULTRABOT_LOG_${key.toUpperCase()}`; const previous = process.env[env]; process.env[env] = value; t.after(() => { if (previous === undefined) delete process.env[env]; else process.env[env] = previous; }); }
  const log = new MessageLog(dir, () => {}, sendLogOrigin());
  log.record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 });
  const row = rows(dir)[0];
  for (const [key, value] of Object.entries(expected)) assert.equal(row[key], value);
});

for (const planted of ["symlink", "fifo", "hardlink"]) {
  test(`the active log refuses a planted ${planted} without following or hanging`, (t) => {
    const dir = scratch(t);
    const log = new MessageLog(dir);
    const target = join(dir, "target");
    writeFileSync(target, "untouched", { mode: 0o644 });
    chmodSync(target, 0o644);
    if (planted === "symlink") symlinkSync(target, log.file);
    else if (planted === "hardlink") linkSync(target, log.file);
    else execFileSync("mkfifo", [log.file]);
    // A deadline in a separate process also guards against a blocking FIFO open in a regression.
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `import { MessageLog } from './src/message-log.ts'; new MessageLog(${JSON.stringify(dir)}).record('sendMessage', {chat_id:1,text:'hi'}, {message_id:2});`], { cwd: process.cwd(), timeout: 3_000, env: { ...process.env, CARL_MESSAGE_LOG_DIR: dir } });
    assert.equal(result.error, undefined, "the writer must not block");
    assert.equal(result.status, 0);
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.equal(statSync(target).mode & 0o777, 0o644, "no chmod through a planted name");
  });
}

test("directory, rotation and lock symlinks are refused", (t) => {
  const dir = scratch(t);
  const target = join(dir, "outside");
  mkdirSync(target, { mode: 0o755 });
  chmodSync(target, 0o755);
  const alias = join(dir, "alias");
  symlinkSync(target, alias);
  new MessageLog(alias).record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 });
  assert.equal(existsSync(join(target, "hermes.jsonl")), false);
  assert.equal(statSync(target).mode & 0o777, 0o755);
  symlinkSync(target, join(dir, "hermes.jsonl.lock"));
  new MessageLog(dir).record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 });
  assert.equal(existsSync(join(dir, "hermes.jsonl")), false);
  unlinkSync(join(dir, "hermes.jsonl.lock"));
  writeFileSync(join(dir, "hermes.jsonl"), "x".repeat(10 * 1024 * 1024));
  const privateFile = join(target, "private");
  writeFileSync(privateFile, "private", { mode: 0o644 });
  chmodSync(privateFile, 0o644);
  symlinkSync(privateFile, join(dir, "hermes.jsonl.1"));
  new MessageLog(dir).record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 });
  assert.equal(readFileSync(privateFile, "utf8"), "private");
  assert.equal(statSync(privateFile).mode & 0o777, 0o644);
  assert.equal(statSync(join(dir, "hermes.jsonl")).size, 10 * 1024 * 1024, "rotation must refuse planted paths");
});

test("contended and skipped rows survive writer restart as durable loss counts", (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  writeFileSync(join(dir, "hermes.jsonl.lock"), "held");
  log.record("sendMessage", { chat_id: 1, text: "lost1" }, { message_id: 2 });
  log.record("sendMessage", { chat_id: 1, text: "lost2" }, { message_id: 3 });
  unlinkSync(join(dir, "hermes.jsonl.lock"));
  new MessageLog(dir).record("sendMessage", { chat_id: 1, text: "next" }, { message_id: 4 });
  assert.equal(rows(dir)[0].writeErrors, 2, "loss survives MessageLog instances/process restarts");
});

test("HTML fallback never resends an ambiguous CLI send, but permits an explicit formatting refusal", async (t) => {
  const dir = scratch(t);
  const api = wired(t, dir);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("reply lost"); });
  await assert.rejects(api.sendHtmlMessage(1, "<b>hello</b>"));
  assert.equal(requests, 1);
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ ok: false, error_code: 400 }, { status: 503 }); });
  await assert.rejects(api.sendHtmlMessage(1, "<b>hello</b>"));
  assert.equal(requests, 2, "a 5xx cannot masquerade as a formatting refusal");
  requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests++;
    if (requests === 1) return Response.json({ ok: false, error_code: 400, description: "can't parse entities" }, { status: 400 });
    const body = JSON.parse(init?.body as string);
    assert.equal(body.text, "hello");
    assert.equal(body.parse_mode, undefined);
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  await api.sendHtmlMessage(1, "<b>hello</b>");
  assert.equal(requests, 2);
  assert.deepEqual(rows(dir).map((r) => r.status), ["unknown", "unknown", "failed", "delivered"]);
});

test("429 retries are bounded and never shorten an excessive retry_after", async (t) => {
  const api = new TelegramApi(token);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, { status: 429 }); });
  await assert.rejects(api.call("sendMessage", { chat_id: 1, text: "hi" }, { retries: 0 }));
  assert.equal(requests, 3);
  requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 61 } }, { status: 429 }); });
  await assert.rejects(api.sendMessage(1, "hi"), (e: any) => e.retryAfter === 61 && e.status === "failed");
  assert.equal(requests, 1, "a long refusal is returned to the caller, not retried early");
});

test("multipart uploads have the same bounded explicit-refusal retry and success observation", async (t) => {
  const dir = scratch(t);
  const api = wired(t, dir);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests++;
    assert.ok(init?.body instanceof FormData);
    if (requests === 1) return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, { status: 429 });
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  await api.sendDocument(1, "safe.pdf", new Uint8Array([1]), "caption");
  assert.equal(requests, 2);
  const [row] = rows(dir);
  assert.equal(row.status, "delivered");
  assert.equal(row.file, "safe.pdf");
  assert.equal(row.text, "caption");
});

test("cancellation before fetch is failed; cancellation after dispatch remains unknown", async (t) => {
  const dir = scratch(t);
  const api = wired(t, dir);
  let requests = 0;
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("aborted"); });
  await assert.rejects(api.call("sendMessage", { chat_id: 1 }, { signal: controller.signal }));
  assert.equal(requests, 0);
  await assert.rejects(api.call("sendMessage", { chat_id: 1 }));
  assert.equal(requests, 1);
  assert.deepEqual(rows(dir).map((r) => r.status), ["failed", "unknown"]);
});

test("an observer cannot change either the response or the mutation error", async (t) => {
  const api = new TelegramApi(token);
  api.onDelivered = () => { throw new Error("observer broken"); };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, result: { message_id: 42 } }));
  assert.equal((await api.sendMessage(1, "hi")).message_id, 42);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error_code: 400, description: "refused" }, { status: 400 }));
  await assert.rejects(api.sendMessage(1, "hi"), /refused/);
});

test("errors are redacted before the failure receipt is written", async (t) => {
  const dir = scratch(t);
  const api = wired(t, dir);
  const secret = "Bearer credential-that-must-not-land";
  t.mock.method(globalThis, "fetch", async () => { throw new Error(secret); });
  await assert.rejects(api.sendMessage(1, "hi"));
  assert.equal(readFileSync(join(dir, "hermes.jsonl"), "utf8").includes(secret), false);
  assert.equal(rows(dir)[0].masked, true);
});

test("unlocatable successful mutations are retained instead of silently skipped", (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  log.record("sendMessage", { chat_id: "@named", text: "hi" }, {});
  const row = rows(dir)[0];
  assert.equal(row.chatId, null);
  assert.equal(row.messageId, null);
  assert.equal(row.status, "delivered");
  assert.ok(row.requestId);
});

test("tail recovery preserves complete receipts and marks only recovered fragments", (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  const complete = JSON.stringify({ v: 1, messageId: 1 });
  writeFileSync(log.file, complete);
  log.record("sendMessage", { chat_id: 1, text: "next" }, { message_id: 2 });
  assert.equal(rows(dir)[0].messageId, 1, "missing newline alone is repaired without deleting valid JSON");
  const before = readFileSync(log.file, "utf8");
  writeFileSync(log.file, before + '{"incomplete":');
  log.record("sendMessage", { chat_id: 1, text: "next" }, { message_id: 3 });
  const result = rows(dir);
  assert.equal(result.length, 3);
  assert.equal(result[2].recoveredFragments, 1);
  assert.ok(readFileSync(log.file, "utf8").startsWith(before));
});

test("job and alert empty env fields become null, not fake identity strings", (t) => {
  const dir = scratch(t);
  for (const env of ["ULTRABOT_LOG_JOB", "ULTRABOT_LOG_ALERT"]) { const previous = process.env[env]; process.env[env] = ""; t.after(() => { if (previous === undefined) delete process.env[env]; else process.env[env] = previous; }); }
  new MessageLog(dir, () => {}, sendLogOrigin()).record("sendMessage", { chat_id: 1, text: "hi" }, { message_id: 2 });
  assert.equal(rows(dir)[0].job, null);
  assert.equal(rows(dir)[0].alert, null);
});

test("loss sidecars match the existing audit reader and acknowledge only persisted snapshots", (t) => {
  const dir = scratch(t);
  const counter = join(dir, "hermes.writeerrors");
  const lock = join(dir, "hermes.jsonl.lock");
  writeFileSync(lock, "held");
  new MessageLog(dir).record("sendMessage", { chat_id: 1 }, { message_id: 2 });
  assert.equal(JSON.parse(readFileSync(counter, "utf8")).count, 1, "pending loss is visible before another receipt lands");
  unlinkSync(lock);
  const log = new MessageLog(dir);
  const repair = (log as any).repairTail.bind(log);
  (log as any).repairTail = (fd: number, row: Record<string, unknown>) => {
    // Another process skips a row after the snapshot but before this row's acknowledgment.
    new MessageLog(dir).record("sendMessage", { chat_id: 1 }, { message_id: 3 });
    repair(fd, row);
  };
  log.record("sendMessage", { chat_id: 1 }, { message_id: 4 });
  assert.equal(rows(dir)[0].writeErrors, 1);
  assert.equal(JSON.parse(readFileSync(counter, "utf8")).count, 1, "a concurrent increment cannot be cleared by the earlier snapshot");
  new MessageLog(dir).record("sendMessage", { chat_id: 1 }, { message_id: 5 });
  assert.equal(rows(dir)[1].writeErrors, 1);
  assert.equal(JSON.parse(readFileSync(counter, "utf8")).count, 0);
});

test("a contended counter has durable fallback and never suppresses a writable receipt", (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "hermes.jsonl.lock"), "held");
  writeFileSync(join(dir, "hermes.writeerrors.lock"), "held");
  new MessageLog(dir).record("sendMessage", { chat_id: 1 }, { message_id: 2 });
  const marker = JSON.parse(readFileSync(join(dir, "hermes.writeerrors.pending"), "utf8"));
  assert.equal(marker.fragment, true, "the existing reader sees fallback loss even before the next row");
  unlinkSync(join(dir, "hermes.jsonl.lock"));
  new MessageLog(dir).record("sendMessage", { chat_id: 1 }, { message_id: 3 });
  const row = rows(dir)[0];
  assert.equal(row.writeErrors, 1);
  assert.equal(row.errorCounterUnacknowledged, true);
});

test("loss counts persist across actual process exits", (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "hermes.jsonl.lock"), "held");
  for (let i = 0; i < 2; i++) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `import {MessageLog} from './src/message-log.ts'; new MessageLog(${JSON.stringify(dir)}).record('sendMessage',{chat_id:1},{message_id:2});`], { timeout: 3_000, env: { ...process.env, CARL_MESSAGE_LOG_DIR: dir } });
    assert.equal(child.status, 0);
    assert.equal(child.error, undefined);
  }
  assert.equal(JSON.parse(readFileSync(join(dir, "hermes.writeerrors"), "utf8")).count, 2);
  unlinkSync(join(dir, "hermes.jsonl.lock"));
  new MessageLog(dir).record("sendMessage", { chat_id: 1 }, { message_id: 3 });
  assert.equal(rows(dir)[0].writeErrors, 2);
});

for (const planted of ["symlink", "fifo"]) {
  test(`a ${planted} loss sidecar cannot hang or suppress the receipt`, (t) => {
    const dir = scratch(t);
    const target = join(dir, "target");
    writeFileSync(target, "untouched"); chmodSync(target, 0o644);
    if (planted === "symlink") symlinkSync(target, join(dir, "hermes.writeerrors"));
    else execFileSync("mkfifo", [join(dir, "hermes.writeerrors.pending")]);
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `import {MessageLog} from './src/message-log.ts'; new MessageLog(${JSON.stringify(dir)}).record('sendMessage',{chat_id:1},{message_id:2});`], { timeout: 3_000, env: { ...process.env, CARL_MESSAGE_LOG_DIR: dir } });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.equal(rows(dir)[0].errorCounterUnacknowledged, true);
    assert.equal(rows(dir)[0].messageId, 2);
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.equal(statSync(target).mode & 0o777, 0o644);
  });
}

test("an HTTP 5xx is never retried even if its JSON body claims a 429 refusal", async (t) => {
  const api = new TelegramApi(token);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, { status: 503 }); });
  await assert.rejects(api.sendMessage(1, "hi"), (e: any) => e.status === "unknown");
  assert.equal(requests, 1);
});

test("multi-copy and forward receipts never borrow source message IDs", (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  for (const method of ["copyMessages", "forwardMessages"]) {
    log.record(method, { chat_id: 1, from_chat_id: 2, message_ids: [10, 11] }, undefined, { requestId: method, status: "unknown", error: "reply lost" });
    log.record(method, { chat_id: 1, from_chat_id: 2, message_ids: [10, 11] }, [{ message_id: 20 }, { message_id: 21 }]);
  }
  assert.deepEqual(rows(dir).map((r) => r.messageId), [null, [20, 21], null, [20, 21]]);
});

test("a failed newline repair never truncates an otherwise valid final receipt", (t) => {
  const dir = scratch(t);
  const log = new MessageLog(dir);
  const complete = JSON.stringify({ v: 1, messageId: 1 });
  writeFileSync(log.file, complete);
  const original = fs.writeSync;
  const mocked = t.mock.method(fs, "writeSync", ((...args: any[]) => {
    if (args[1] === "\n") throw new Error("synthetic newline write failure");
    return (original as any)(...args);
  }) as typeof fs.writeSync);
  syncBuiltinESMExports();
  try { log.record("sendMessage", { chat_id: 1 }, { message_id: 2 }); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(log.file, "utf8"), complete);
  new MessageLog(dir).record("sendMessage", { chat_id: 1 }, { message_id: 3 });
  assert.equal(rows(dir)[0].messageId, 1);
  assert.equal(rows(dir)[1].writeErrors, 1);
});
