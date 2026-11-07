import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, readSandboxedBytes, sandboxAvailable } from "../src/sandbox.ts";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { TelegramChannel } from "../src/channels/telegram.ts";
import { SlackChannel } from "../src/channels/slack.ts";
import { DiscordChannel } from "../src/channels/discord.ts";
import { carlTools, type FileOutput } from "../src/tools.ts";
import { parseSendTarget } from "../src/gateway.ts";
import { FakeTelegram } from "./fake-telegram.ts";
import { FakeSlack } from "./fake-slack.ts";
import { FakeDiscord } from "./fake-discord.ts";

const TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz";

test("bounded binary file reads preserve bytes and name failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-media-"));
  try {
    const file = join(dir, "data");
    const bytes = Buffer.from([0, 255, 128, 10]);
    writeFileSync(file, bytes);
    assert.deepEqual(readSandboxedBytes(undefined, file, 4), bytes);
    assert.throws(() => readSandboxedBytes(undefined, file, 3), /exceeds 3 byte limit/);
    assert.throws(() => readSandboxedBytes(undefined, join(dir, "missing"), 4), /cannot read .*missing/);
    if (sandboxAvailable()) {
      const profile = join(dir, "profile.sb");
      writeFileSync(profile, `(version 1)\n(allow default)\n(deny file-read* (literal "${canonical(file)}"))\n`);
      assert.throws(() => readSandboxedBytes(profile, file, 4), /cannot read/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function brain(asked: { key: string; input: any }[]): any {
  return {
    ask: async (key: string, input: any) => { asked.push({ key, input }); return { ok: true, text: "ok", aborted: false, toolCalls: 0 }; },
    whenRegistered: async () => {},
    status: () => ({}),
    routerState: new Map(),
    shellSandbox: undefined,
  };
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- Telegram outbound ----

test("outbound: Telegram sends a photo; a refused photo falls back to sendDocument", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-out-"));
  t.after(async () => { await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [1], homeChat: 1, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  const channel = new TelegramChannel(loadConfig(home), TOKEN, brain([]), new Log(undefined));
  const file: FileOutput = { name: "pic.png", data: Buffer.from("PNG") };
  const sent = await channel.sendFile(1, file, "look");
  assert.equal(sent.length, 1);
  const photo = tg.calls.find((c) => c.method === "sendPhoto");
  assert.ok(photo, "sendPhoto called");
  assert.equal(photo.body.fields.caption, "look");
  assert.equal((photo.body.fields.photo as any).filename, "pic.png");
  tg.refusePhoto = true;
  await channel.sendFile(1, file, "look");
  const docs = tg.calls.filter((c) => c.method === "sendDocument");
  assert.equal(docs.length, 1, "photo refusal falls back to sendDocument");
  assert.equal(docs[0].body.fields.caption, "look");
  assert.equal((docs[0].body.fields.document as any).filename, "pic.png");
  // a non-image always goes as a document
  await channel.sendFile(1, { name: "notes.txt", data: Buffer.from("hi") }, "text");
  const docs2 = tg.calls.filter((c) => c.method === "sendDocument");
  assert.equal(docs2.length, 2);
  assert.equal(docs2[1].body.fields.caption, "text");
});

test("outbound: a Telegram caption over 1024 chars spills into a normal message first", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-cap-"));
  t.after(async () => { await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [1], homeChat: 1, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  const channel = new TelegramChannel(loadConfig(home), TOKEN, brain([]), new Log(undefined));
  const long = "x".repeat(2000);
  await channel.sendFile(1, { name: "a.png", data: Buffer.from("P") }, long);
  const order = tg.calls.filter((c) => c.method === "sendMessage" || c.method === "sendPhoto").map((c) => c.method);
  assert.equal(order[0], "sendMessage", "the long text goes first, whole");
  assert.equal(order[order.length - 1], "sendPhoto");
  const photo = tg.calls.filter((c) => c.method === "sendPhoto").pop()!;
  assert.equal(photo.body.fields.caption, undefined, "no truncated caption on the photo");
});

// ---- Slack outbound ----

test("outbound: Slack uploads via getUploadURLExternal -> bytes -> completeUploadExternal", async (t) => {
  const slack = new FakeSlack();
  await slack.start();
  const home = mkdtempSync(join(tmpdir(), "carl-sk-out-"));
  t.after(async () => { await slack.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { enabled: false }, api: { enabled: false }, slack: { allowFrom: ["UOP"], homeChannel: "D1", apiBase: slack.base } }));
  const cfg = loadConfig(home);
  const channel = new SlackChannel(cfg.slack, "xapp-test", "xoxb-test", brain([]), new Log(undefined), join(home, "media"));
  await channel.start();
  t.after(() => channel.stop());
  await slack.waitConnected();
  channel.known.add("C1");
  const data = Buffer.from("PDF-BYTES");
  const n = await channel.send("C1", "hello", undefined, { name: "report.pdf", data });
  assert.equal(n, 1);
  const getUrl = slack.calls.find((c) => c.method === "files.getUploadURLExternal")!;
  assert.ok(getUrl, "getUploadURLExternal called");
  assert.equal(getUrl.body.filename, "report.pdf");
  assert.equal(getUrl.body.length, data.byteLength);
  assert.equal(slack.uploads.length, 1);
  assert.deepEqual(slack.uploads[0].data, data);
  const complete = slack.calls.find((c) => c.method === "files.completeUploadExternal")!;
  assert.deepEqual(complete.body.files, [{ id: "F1", title: "report.pdf" }]);
  assert.equal(complete.body.channel_id, "C1");
  assert.equal(complete.body.initial_comment, "hello");
  // thread variant
  await channel.send("C1", "hi", "1234.5678", { name: "x.txt", data: Buffer.from("X") });
  const complete2 = slack.calls.filter((c) => c.method === "files.completeUploadExternal")[1];
  assert.equal(complete2.body.thread_ts, "1234.5678");
});

// ---- Slack inbound ----

test("inbound: Slack file_share saves files (0600) and turns images into model images", async (t) => {
  const slack = new FakeSlack();
  await slack.start();
  const home = mkdtempSync(join(tmpdir(), "carl-sk-in-"));
  t.after(async () => { await slack.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { enabled: false }, api: { enabled: false }, slack: { allowFrom: ["UOP"], homeChannel: "D1", apiBase: slack.base } }));
  const cfg = loadConfig(home);
  const asked: { key: string; input: any }[] = [];
  const channel = new SlackChannel(cfg.slack, "xapp-test", "xoxb-test", brain(asked), new Log(undefined), join(home, "media"));
  await channel.start();
  t.after(() => channel.stop());
  await slack.waitConnected();
  slack.attach("doc.txt", Buffer.from("hello file"));
  slack.fileShare("UOP", [{ url_private_download: slack.downloadUrl("doc.txt"), mimetype: "text/plain", name: "doc.txt", size: 9 }]);
  await waitFor(() => asked.length >= 1, 5_000, "slack file ask");
  const input1 = asked[0].input;
  assert.match(input1.text, /\[file received: .*doc\.txt\]/);
  const saved = input1.text.match(/\[file received: ([^\]]+)\]/)![1];
  assert.equal(readFileSync(saved, "utf8"), "hello file");
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  slack.attach("pic.png", Buffer.from("IMG"));
  slack.fileShare("UOP", [{ url_private_download: slack.downloadUrl("pic.png"), mimetype: "image/png", name: "pic.png", size: 3 }]);
  await waitFor(() => asked.length >= 2, 5_000, "slack image ask");
  const input2 = asked[1].input;
  assert.equal(input2.images.length, 1);
  assert.equal(input2.images[0].mimeType, "image/png");
  assert.equal(input2.images[0].data, Buffer.from("IMG").toString("base64"));
  slack.fileShare("UOP", [{ url_private_download: slack.downloadUrl("missing.bin"), mimetype: "application/octet-stream", name: "missing.bin", size: 4 }]);
  await waitFor(() => asked.length >= 3, 5_000, "slack failure note");
  assert.match(asked[2].input.text, /\[attachment could not be fetched: .*HTTP 404\]/);
});

// ---- Discord outbound ----

test("outbound: Discord sends a file as multipart with files[0] and payload_json", async (t) => {
  const dc = new FakeDiscord();
  await dc.start();
  const home = mkdtempSync(join(tmpdir(), "carl-dc-out-"));
  t.after(async () => { await dc.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { enabled: false }, api: { enabled: false }, discord: { allowFrom: ["42"], homeChannel: "100", apiBase: dc.base } }));
  const cfg = loadConfig(home);
  const channel = new DiscordChannel(cfg.discord, "test-token", brain([]), new Log(undefined), join(home, "media"));
  await channel.start();
  t.after(() => channel.stop());
  await waitFor(() => dc.identified && channel.status.state === "connected", 5_000, "discord ready");
  channel.known.add("100");
  const n = await channel.deliver("100", "content here", { name: "x.txt", data: Buffer.from("hi") });
  assert.equal(n, 1);
  const call = dc.calls.find((c) => c.method === "POST" && c.path === "/channels/100/messages" && (c as any).files);
  assert.ok(call, "multipart message call");
  const multipart = call as any;
  assert.equal(multipart.files.length, 1);
  assert.equal(multipart.files[0].name, "x.txt");
  assert.equal(multipart.files[0].data.toString(), "hi");
  assert.equal(multipart.body.content, "content here");
  assert.deepEqual(multipart.body.allowed_mentions, { parse: [] });
});

// ---- Discord inbound + threads ----

test("inbound: Discord attachments are saved (0600) or turned into images; failures are noted", async (t) => {
  const dc = new FakeDiscord();
  await dc.start();
  const home = mkdtempSync(join(tmpdir(), "carl-dc-in-"));
  t.after(async () => { await dc.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { enabled: false }, api: { enabled: false }, discord: { allowFrom: ["42"], homeChannel: "100", apiBase: dc.base } }));
  const cfg = loadConfig(home);
  const asked: { key: string; input: any }[] = [];
  const channel = new DiscordChannel(cfg.discord, "test-token", brain(asked), new Log(undefined), join(home, "media"));
  await channel.start();
  t.after(() => channel.stop());
  await waitFor(() => dc.identified && channel.status.state === "connected", 5_000, "discord ready");
  dc.attach("doc.txt", Buffer.from("discord file"));
  dc.fileMessage("42", "100", [{ url: dc.attachmentUrl("doc.txt"), filename: "doc.txt", content_type: "text/plain", size: 12 }]);
  await waitFor(() => asked.length >= 1, 5_000, "discord file ask");
  const input1 = asked[0].input;
  assert.match(input1.text, /\[file received: .*doc\.txt\]/);
  const saved = input1.text.match(/\[file received: ([^\]]+)\]/)![1];
  assert.equal(readFileSync(saved, "utf8"), "discord file");
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  dc.attach("pic.png", Buffer.from("DIMG"));
  dc.fileMessage("42", "100", [{ url: dc.attachmentUrl("pic.png"), filename: "pic.png", content_type: "image/png", size: 4 }]);
  await waitFor(() => asked.length >= 2, 5_000, "discord image ask");
  const input2 = asked[1].input;
  assert.equal(input2.images.length, 1);
  assert.equal(input2.images[0].mimeType, "image/png");
  assert.equal(input2.images[0].data, Buffer.from("DIMG").toString("base64"));
  dc.fileMessage("42", "100", [{ url: dc.attachmentUrl("gone.bin"), filename: "gone.bin", content_type: "application/octet-stream", size: 4 }]);
  await waitFor(() => asked.length >= 3, 5_000, "discord failure note");
  assert.match(asked[2].input.text, /\[attachment could not be fetched: .*HTTP 404\]/);
});

test("Discord threads keep their own conversation key and replies post into the thread channel", async (t) => {
  const dc = new FakeDiscord();
  await dc.start();
  const home = mkdtempSync(join(tmpdir(), "carl-dc-thread-"));
  t.after(async () => { await dc.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { enabled: false }, api: { enabled: false }, discord: { allowFrom: ["42"], homeChannel: "100", apiBase: dc.base } }));
  const cfg = loadConfig(home);
  const asked: { key: string; input: any }[] = [];
  const channel = new DiscordChannel(cfg.discord, "test-token", brain(asked), new Log(undefined), join(home, "media"));
  await channel.start();
  t.after(() => channel.stop());
  await waitFor(() => dc.identified && channel.status.state === "connected", 5_000, "discord ready");
  const threadId = "999";
  dc.fileMessage("42", threadId, [], "hello thread", "5"); // guild 5, channel id is the thread id
  await waitFor(() => asked.some((a) => a.key === `discord:${threadId}`), 5_000, "thread conversation");
  await waitFor(() => dc.texts(threadId).includes("ok"), 5_000, "thread reply");
  assert.equal(dc.texts("100").length, 0, "nothing posted to the main channel");
});

// ---- send_message tool ----

test("send_message: \"here\" resolves to the current conversation key", async () => {
  const sent: { t: string; x: string; f?: FileOutput }[] = [];
  const tools = carlTools({} as any, {} as any, { send: async (t: string, x: string, f?: FileOutput) => { sent.push({ t, x, f }); return "sent"; } });
  const sm: any = tools.find((tl) => tl.name === "send_message")!;
  const dir = mkdtempSync(join(tmpdir(), "carl-sess-"));
  writeFileSync(join(dir, "key"), "telegram:group:-42:7");
  const ctx: any = { sessionManager: { getSessionDir: () => dir } };
  const file = join(dir, "out.txt");
  writeFileSync(file, "hello");
  const r = await sm.execute("id", { target: "here", text: "hi", file }, undefined, undefined, ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "telegram:group:-42:7");
  assert.equal(sent[0].x, "hi");
  assert.equal(sent[0].f?.name, "out.txt");
  assert.equal(Buffer.from(sent[0].f!.data).toString(), "hello");
  assert.match((r.content[0] as any).text, /sent/);
});

test("send_message: \"here\" without a session fails with a named error", async () => {
  const tools = carlTools({} as any, {} as any, { send: async () => "" });
  const sm: any = tools.find((tl) => tl.name === "send_message")!;
  await assert.rejects(sm.execute("id", { target: "here", text: "x" }), /no active conversation/);
});

test("send_message: a path the sandbox denies fails with a named error", async (t) => {
  if (!sandboxAvailable()) { t.skip("kernel sandbox unavailable"); return; }
  const dir = mkdtempSync(join(tmpdir(), "carl-denied-"));
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "carl-secret");
  const profile = join(dir, "profile.sb");
  writeFileSync(profile, `(version 1)\n(allow default)\n(deny file-read* (literal "${canonical(secret)}"))\n`);
  const tools = carlTools({} as any, {} as any, { send: async () => "" }, undefined, profile);
  const sm: any = tools.find((tl) => tl.name === "send_message")!;
  await assert.rejects(sm.execute("id", { target: "home", text: "x", file: secret }), /cannot read .*secret/);
});

// ---- target parsing ----

test("send targets resolve per channel key", () => {
  assert.deepEqual(parseSendTarget("telegram:dm:42"), { kind: "telegram", chatId: 42, threadId: undefined });
  assert.deepEqual(parseSendTarget("telegram:group:-7"), { kind: "telegram", chatId: -7, threadId: undefined });
  assert.deepEqual(parseSendTarget("telegram:group:-7:9"), { kind: "telegram", chatId: -7, threadId: 9 });
  assert.deepEqual(parseSendTarget("slack:dm:D1"), { kind: "slack", channel: "D1", thread: undefined });
  assert.deepEqual(parseSendTarget("slack:C1:1234.5678"), { kind: "slack", channel: "C1", thread: "1234.5678" });
  assert.deepEqual(parseSendTarget("slack:home"), { kind: "slack", channel: "home", thread: undefined });
  assert.deepEqual(parseSendTarget("discord:100"), { kind: "discord", channel: "100" });
  assert.deepEqual(parseSendTarget("discord:dm:100"), { kind: "discord", channel: "100" });
  assert.deepEqual(parseSendTarget("discord:home"), { kind: "discord", channel: "home" });
  assert.deepEqual(parseSendTarget("none"), { kind: "none" });
  assert.throws(() => parseSendTarget("telegram:dm:abc"), /bad/);
  assert.throws(() => parseSendTarget("slack:C!"), /bad/);
  assert.throws(() => parseSendTarget("discord:abc"), /bad/);
});
