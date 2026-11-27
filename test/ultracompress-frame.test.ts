// The v0.7.1 CLI writes snap frames as `png_base64`. These tests drive the real
// vendored adapter through a hermetic fake CLI so a camelCase-only adapter,
// a wrong frame placement, or an unnecessary spawn fails without a binary or network.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { register } from "node:module";

// Pi resolves the adapter's extensionless imports itself; Node's stripper needs
// the suffix. The hook is test-local and leaves the vendored sources unchanged.
register(new URL("./ultracompress-ts-loader.mjs", import.meta.url), import.meta.url);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), data.length + 8);
  return out;
}

/** A real PNG whose tEXt chunk carries the archived tool text for an exact lossless assertion. */
function pngWithArchivedText(text: string): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", Buffer.from(`Comment\0${text}`, "utf8")),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))), // one scanline
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

// Over the adapter's stock 6000-char threshold. The stub also works as a
// negative control against the old adapter, which has no settings override.
const head = `HEAD_SENTINEL ${"a".repeat(6000)}`;
const archived = "ARCHIVED_SENTINEL_7F3A: warning from the real tool output";
const tail = `TAIL_SENTINEL ${"c".repeat(6000)}`;
const longText = `${head}\n${archived}\n${tail}`;
const plainText = `plain tool output PLAIN_SENTINEL ${"b".repeat(6000)}`;
const frame = pngWithArchivedText(archived);

const inlineMessages = () => [
  { role: "user", content: "run the build" },
  { role: "toolResult", content: [{ type: "text", text: longText }] },
  { role: "toolResult", content: [{ type: "text", text: plainText }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
];

// A later user message proves the default placement targets the *next* user
// turn, not merely the most recent one.
const nextUserMessages = () => [
  { role: "user", content: "run the build" },
  { role: "toolResult", content: [{ type: "text", text: longText }] },
  { role: "user", content: "what did the build say?" },
  { role: "toolResult", content: [{ type: "text", text: plainText }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
];

// The settings module reads its path once at import, so all cases share one
// temp path and rewrite the file before registering a fresh extension instance.
let root = "";
let settingsFile = "";
let calls = "";
let savedEnv: Record<string, string | undefined> = {};
let ultraCompressExtension: (pi: unknown) => void = () => { throw new Error("harness not initialized"); };

before(async () => {
  root = mkdtempSync(join(tmpdir(), "carl-uc-frames-"));
  savedEnv = {
    home: process.env.HOME,
    settings: process.env.ULTRACOMPRESS_SETTINGS_PATH,
    bin: process.env.ULTRACOMPRESS_BIN,
    state: process.env.ULTRACOMPRESS_STATE_ROOT,
  };
  settingsFile = join(root, "ultracompress.json");
  calls = join(root, "cli-calls.log");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });

  process.env.HOME = root; // isolated HOME; live operator settings are never read
  process.env.ULTRACOMPRESS_SETTINGS_PATH = settingsFile; // adapter never needs HOME
  const fakeBin = join(binDir, "ultracompress.mjs");
  process.env.ULTRACOMPRESS_BIN = fakeBin;
  process.env.ULTRACOMPRESS_STATE_ROOT = join(root, "state");

  // The stub is the CLI boundary: it emits the snake_case field, never the old
  // camelCase spelling, and deliberately omits `no_gain` like an older binary.
  writeFileSync(fakeBin, `#!/usr/bin/env node
import * as fs from "node:fs";
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const text = String(payload.messages?.[0]?.message?.content?.[0]?.text ?? "");
  fs.appendFileSync(${JSON.stringify(calls)}, text.slice(0, 32) + "\\n");
  const ops = text.includes(${JSON.stringify(archived)}) ? [{
    op: "snap", message_index: 0, block_index: 0,
    head: ${JSON.stringify(`${head}\n`)}, tail: ${JSON.stringify(`\n${tail}`)},
    frames: [{ id: "frame-1", width: 1, height: 1, png_base64: ${JSON.stringify(frame)} }],
    tokens_before: 500, tokens_after: 50,
  }] : [];
  process.stdout.write(JSON.stringify({ ops, stats: { blocks_scanned: 1, snap_ops: ops.length, tokens_before: 500, tokens_after: 500, savings_pct: 0 } }));
})().catch((error) => { console.error(error); process.exit(1); });
`, { mode: 0o755 });

  // A computed URL keeps Carl's strict typecheck on the test, not on Pi's vendored
  // extension style (which Pi resolves itself and Node loads through the hook).
  const adapterUrl = new URL("../vendor/ultracompress/index.ts", import.meta.url).href;
  const imported = (await import(adapterUrl)) as { default: (pi: unknown) => void };
  ultraCompressExtension = imported.default;
});

after(() => {
  if (savedEnv.home === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.home;
  if (savedEnv.settings === undefined) delete process.env.ULTRACOMPRESS_SETTINGS_PATH; else process.env.ULTRACOMPRESS_SETTINGS_PATH = savedEnv.settings;
  if (savedEnv.bin === undefined) delete process.env.ULTRACOMPRESS_BIN; else process.env.ULTRACOMPRESS_BIN = savedEnv.bin;
  if (savedEnv.state === undefined) delete process.env.ULTRACOMPRESS_STATE_ROOT; else process.env.ULTRACOMPRESS_STATE_ROOT = savedEnv.state;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Fresh extension state and call log; omitting `placement` exercises the shipped
 * default (nextUser) rather than writing it into the settings file.
 */
function registerContext(opts: { placement?: "inline" | "nextUser"; policy?: "auto" | "vcc"; provider?: string } = {}) {
  writeFileSync(settingsFile, JSON.stringify({
    policy: opts.policy ?? "auto",
    snap: {
      enabled: true,
      minChars: 64,
      ...(opts.placement ? { placement: opts.placement } : {}),
      providers: [opts.provider ?? "anthropic"],
    },
    snapshot: { enabled: false },
    debug: false,
  }));
  rmSync(calls, { force: true });
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  ultraCompressExtension({
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    registerCommand() {}, registerTool() {},
  } as never);
  return handlers.get("context")!;
}

function cliCallCount(): number {
  return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length;
}

test("Ultracompress frames carry png_base64 data, keep archived text and memoize a text decision (inline)", async () => {
  const context = registerContext({ placement: "inline" });
  const ctx = { model: { provider: "anthropic", input: ["text", "image"] } };

  const first = await context({ messages: inlineMessages() }, ctx);
  assert.ok(first, "the transform must produce a replacement");
  const framed = first.messages[1].content as Array<Record<string, unknown>>;
  const images = framed.filter((block) => block.type === "image");
  assert.equal(images.length, 1, "the snap must become an image block");
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(typeof images[0].data, "string");
  assert.ok((images[0].data as string).length > 0, "the image must carry data, not undefined");
  assert.ok(!("pngBase64" in images[0]), "PNG travels in data, never a camelCase payload field");
  const decoded = Buffer.from(images[0].data as string, "base64");
  assert.deepEqual([...decoded.subarray(0, 8)], [...PNG_SIGNATURE], "frame data is a real PNG");
  assert.ok(decoded.includes(Buffer.from(archived)), "the archived tool text is still reachable");

  const text = framed.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
  assert.match(text, /HEAD_SENTINEL/);
  assert.match(text, /TAIL_SENTINEL/);
  assert.ok(!text.includes(archived), "the archived middle is not left as plain text");
  assert.equal((first.messages[2].content as Array<{ text: string }>)[0].text, plainText, "a text-only block stays text");
  assert.equal(cliCallCount(), 1);

  const second = await context({ messages: inlineMessages() }, ctx);
  assert.deepEqual(second.messages, first.messages, "cached frames and text survive the next request");
  assert.equal(cliCallCount(), 1, "the CLI is not re-sent for a text decision");
});

test("the default placement sends snap frames to the next user message, not the tool result", async () => {
  const context = registerContext(); // no `placement` in settings: nextUser is the default
  const ctx = { model: { provider: "anthropic", input: ["text", "image"] } };

  const first = await context({ messages: nextUserMessages() }, ctx);
  assert.ok(first, "the transform must produce a replacement");
  const toolText = (first.messages[1].content as Array<Record<string, unknown>>)
    .filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
  assert.match(toolText, /HEAD_SENTINEL/);
  assert.match(toolText, /TAIL_SENTINEL/);
  assert.ok(!toolText.includes(archived), "the archived middle is not left as plain text");
  assert.ok(!(first.messages[1].content as Array<Record<string, unknown>>).some((b) => b.type === "image"),
    "the tool result stays text-only");

  const target = first.messages[2].content as Array<Record<string, unknown>>;
  assert.equal(target[0].text, "what did the build say?", "the next user turn keeps its own text");
  const images = target.filter((block) => block.type === "image");
  assert.equal(images.length, 1, "frames land on the next user message");
  assert.equal(images[0].mimeType, "image/png");
  const decoded = Buffer.from(images[0].data as string, "base64");
  assert.deepEqual([...decoded.subarray(0, 8)], [...PNG_SIGNATURE], "frame data is a real PNG");
  assert.ok(decoded.includes(Buffer.from(archived)), "the archived text is still reachable");
  assert.equal((first.messages[3].content as Array<{ text: string }>)[0].text, plainText, "a text-only block stays text");
  assert.equal(cliCallCount(), 1);

  const second = await context({ messages: nextUserMessages() }, ctx);
  assert.deepEqual(second.messages, first.messages, "cached frames survive the next request");
  assert.equal(cliCallCount(), 1, "the CLI is not re-sent on the next request");
});

test("a text-only model leaves the context alone and never starts the CLI", async () => {
  const context = registerContext();
  const ctx = { model: { provider: "anthropic", input: ["text"] } };
  const original = inlineMessages();

  assert.equal(await context({ messages: original }, ctx), undefined, "no transform is returned");
  assert.ok(!existsSync(calls), "the fake CLI was never spawned");
});

test("the text-only vcc policy never starts the CLI on the live path, even for a vision model", async () => {
  const context = registerContext({ policy: "vcc" });
  const ctx = { model: { provider: "anthropic", input: ["text", "image"] } };

  assert.equal(await context({ messages: inlineMessages() }, ctx), undefined, "no transform is returned");
  assert.ok(!existsSync(calls), "the fake CLI was never spawned");
});

test("a vision model on a provider outside snap.providers never starts the CLI", async () => {
  const context = registerContext({ provider: "google" });
  const ctx = { model: { provider: "anthropic", input: ["text", "image"] } };

  assert.equal(await context({ messages: inlineMessages() }, ctx), undefined, "no transform is returned");
  assert.ok(!existsSync(calls), "the fake CLI was never spawned");
});
