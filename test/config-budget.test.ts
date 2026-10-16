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

test("trusted MCP server names stay short enough for the guard to attribute their tools", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadConfig } = await import("../src/config.ts");
  const home = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ trustedMcp: ["x".repeat(40)] }));
  assert.throws(() => loadConfig(home), /trustedMcp/);
  writeFileSync(join(home, "carl.json"), JSON.stringify({ trustedMcp: ["overseer", "ultra-memory"] }));
  assert.deepEqual(loadConfig(home).trustedMcp, ["overseer", "ultra-memory"]);
});

test("model logins live in Carl's own folder unless agentDir (or the older piAgentDir) points elsewhere", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadConfig } = await import("../src/config.ts");
  const home = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(home, "carl.json"), "{}");
  assert.equal(loadConfig(home).agentDir, join(home, "agent"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ piAgentDir: "/opt/shared-agent" }));
  assert.equal(loadConfig(home).agentDir, "/opt/shared-agent");
  writeFileSync(join(home, "carl.json"), JSON.stringify({ agentDir: "/opt/a", piAgentDir: "/opt/b" }));
  assert.equal(loadConfig(home).agentDir, "/opt/a");
});

test("an older layout (CARL_HOME/pi with mcp.json inside) moves to mcp.json and engine/", async () => {
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureHome, loadConfig } = await import("../src/config.ts");
  const home = mkdtempSync(join(tmpdir(), "carl-layout-"));
  writeFileSync(join(home, "carl.json"), "{}");
  mkdirSync(join(home, "pi"));
  writeFileSync(join(home, "pi", "mcp.json"), '{"mcpServers":{}}');
  ensureHome(loadConfig(home));
  assert.equal(readFileSync(join(home, "mcp.json"), "utf8"), '{"mcpServers":{}}');
  assert.ok(existsSync(join(home, "engine")) && !existsSync(join(home, "pi")));
});

test("learning defaults to UltraTerm Dream/Nightmare with the UltraTerm module, else Carl's own pass", () => {
  const plain = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(plain, "carl.json"), "{}");
  assert.equal(loadConfig(plain).learning, "carl");
  const ut = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(ut, "carl.json"), JSON.stringify({ ultraterm: { home: ut } }));
  assert.equal(loadConfig(ut).learning, "ultraterm");
  const forced = mkdtempSync(join(tmpdir(), "carl-cfg-"));
  writeFileSync(join(forced, "carl.json"), JSON.stringify({ ultraterm: { home: forced }, learning: "carl" }));
  assert.equal(loadConfig(forced).learning, "carl");
  writeFileSync(join(forced, "carl.json"), JSON.stringify({ learning: "dreams" }));
  assert.throws(() => loadConfig(forced), /learning must be/);
});
