// The v0.7.1 CLI writes snap frames as `png_base64`. This test drives the real
// vendored adapter through a hermetic fake CLI so a camelCase-only adapter,
// or one that memoizes nothing, fails without a binary or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("Ultracompress frames carry png_base64 data, keep archived text and memoize a text decision", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "carl-uc-frames-"));
  const saved = {
    home: process.env.HOME,
    settings: process.env.ULTRACOMPRESS_SETTINGS_PATH,
    bin: process.env.ULTRACOMPRESS_BIN,
    state: process.env.ULTRACOMPRESS_STATE_ROOT,
  };
  t.after(() => {
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.settings === undefined) delete process.env.ULTRACOMPRESS_SETTINGS_PATH; else process.env.ULTRACOMPRESS_SETTINGS_PATH = saved.settings;
    if (saved.bin === undefined) delete process.env.ULTRACOMPRESS_BIN; else process.env.ULTRACOMPRESS_BIN = saved.bin;
    if (saved.state === undefined) delete process.env.ULTRACOMPRESS_STATE_ROOT; else process.env.ULTRACOMPRESS_STATE_ROOT = saved.state;
    rmSync(root, { recursive: true, force: true });
  });

  const binDir = join(root, "bin");
  const settingsFile = join(root, "ultracompress.json");
  const homeSettings = join(root, ".pi", "agent", "ultracompress.json");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  const settings = JSON.stringify({
    policy: "auto",
    snap: { enabled: true, minChars: 64, placement: "inline", providers: ["anthropic"] },
    snapshot: { enabled: false },
    debug: false,
  });
  writeFileSync(settingsFile, settings);
  // The second copy is only for the old-adapter negative control; the new
  // adapter reads the explicit path and never touches live ~/.pi state.
  writeFileSync(homeSettings, settings);
  // .mjs keeps the stub's module type independent of where TMPDIR points.
  const fakeBin = join(binDir, "ultracompress.mjs");
  const calls = join(root, "cli-calls.log");
  process.env.HOME = root; // isolated HOME for the negative control
  process.env.ULTRACOMPRESS_SETTINGS_PATH = settingsFile; // new adapter never needs HOME
  process.env.ULTRACOMPRESS_BIN = fakeBin;
  process.env.ULTRACOMPRESS_STATE_ROOT = join(root, "state");

  // Over the adapter's stock 6000-char threshold: the stub also works as a
  // negative control against the old adapter, which has no settings override.
  const head = `HEAD_SENTINEL ${"a".repeat(6000)}`;
  const archived = "ARCHIVED_SENTINEL_7F3A: warning from the real tool output";
  const tail = `TAIL_SENTINEL ${"c".repeat(6000)}`;
  const longText = `${head}\n${archived}\n${tail}`;
  const plainText = `plain tool output PLAIN_SENTINEL ${"b".repeat(6000)}`;
  const frame = pngWithArchivedText(archived);

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
  const ops = text.includes(${JSON.stringify("ARCHIVED_SENTINEL_7F3A")}) ? [{
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
  const { default: ultraCompressExtension } = (await import(adapterUrl)) as {
    default: (pi: unknown) => void;
  };
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  ultraCompressExtension({
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, handler); },
    registerCommand() {}, registerTool() {},
  } as never);
  const context = handlers.get("context")!;
  const ctx = { model: { provider: "anthropic", input: ["text", "image"] } };
  const messages = () => [
    { role: "user", content: "run the build" },
    { role: "toolResult", content: [{ type: "text", text: longText }] },
    { role: "toolResult", content: [{ type: "text", text: plainText }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];

  const first = await context({ messages: messages() }, ctx);
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
  assert.ok(!text.includes("ARCHIVED_SENTINEL_7F3A"), "the archived middle is not left as plain text");
  assert.equal((first.messages[2].content as Array<{ text: string }>)[0].text, plainText, "a text-only block stays text");
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);

  const second = await context({ messages: messages() }, ctx);
  assert.deepEqual(second.messages, first.messages, "cached frames and text survive the next request");
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1, "the CLI is not re-sent for a text decision");
});
