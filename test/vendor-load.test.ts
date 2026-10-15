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
