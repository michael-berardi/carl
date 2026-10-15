import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

test("the vendored UltraCompress sources parse (a syntax error silently disables compaction)", () => {
  const root = new URL("../vendor/ultracompress/", import.meta.url).pathname;
  const files = ["index.ts", ...readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).map((f) => join("src", f))];
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(join(root, f), "utf8"), ts.ScriptTarget.Latest, true);
    const errors = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    assert.deepEqual(errors, [], f);
  }
});

test("UltraCompress recall reads only Carl's own session transcripts (the engine runs outside the sandbox)", async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { recallArgs } = await import("../vendor/ultracompress/src/recall.ts");
  const root = mkdtempSync(join(tmpdir(), "carl-recall-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); delete process.env.ULTRACOMPRESS_SESSION_ROOT; });
  mkdirSync(join(root, "sessions", "k"), { recursive: true });
  writeFileSync(join(root, "sessions", "k", "s.jsonl"), "{}\n");
  writeFileSync(join(root, ".env"), "TOKEN=secret\n");
  symlinkSync(join(root, ".env"), join(root, "sessions", "k", "evil.jsonl"));
  process.env.ULTRACOMPRESS_SESSION_ROOT = join(root, "sessions");
  const session = { getSessionFile: () => join(root, "sessions", "k", "s.jsonl"), getLeafId: () => null };
  assert.ok(recallArgs({ query: "x" }, session).includes(join(root, "sessions", "k", "s.jsonl")));
  assert.throws(() => recallArgs({ query: "x", sessionFile: join(root, ".env") }, session), /session transcript under/);
  assert.throws(() => recallArgs({ query: "x", sessionFile: join(root, "sessions", "k", "evil.jsonl") }, session), /session transcript under/, "a link out of the folder is refused");
});
