import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, parseEnvFile, secret } from "../src/config.ts";
import { capText } from "../src/budget.ts";

test("defaults load without a file", () => {
  const h = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  const c = loadConfig(h);
  assert.equal(c.model, "openai-codex/gpt-6.1-sol");
  assert.equal(c.api.port, 8642);
  assert.deepEqual(c.telegram.allowFrom, []);
});

test("bad config names the field", () => {
  const h = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(h, "carl.json"), JSON.stringify({ telegram: { allowFrom: ["me"] } }));
  assert.throws(() => loadConfig(h), (e: Error) => e instanceof ConfigError && /allowFrom\[0\]/.test(e.message));
});

test("env files: process env, then home .env, then extra files", () => {
  const h = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(h, ".env"), "A=home\n");
  const extra = join(h, "extra.env");
  writeFileSync(extra, "export B='extra'\nA=extra\n");
  assert.equal(secret(h, "A", [extra]), "home");
  assert.equal(secret(h, "B", [extra]), "extra");
  assert.deepEqual(parseEnvFile('# c\nX="1"\n bad line\n'), { X: "1" });
});

test("capText keeps head and tail and names the spill file", () => {
  const out = capText("a".repeat(5000) + "MIDDLE" + "b".repeat(5000), 1000, "/tmp/spill.txt");
  assert.ok(out.length < 1300);
  assert.match(out, /\/tmp\/spill\.txt/);
  assert.ok(out.startsWith("aaa") && out.endsWith("bbb"));
});
