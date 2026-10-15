import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { installProfile, sandboxAvailable, sandboxSpawnHook } from "../src/sandbox.ts";

// Under the user's home (macOS temp dirs sit outside it, and secret-ancestor rules stop at the home directory).
const base = join(homedir(), ".cache", "carl-test-sandbox");

test("shell sandbox: control plane and secrets are out of reach, the workspace is not", { skip: !sandboxAvailable() && "needs macOS sandbox-exec" }, async (t) => {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "run-"));
  const home = join(root, "carl");
  for (const d of ["state", "workspace", "pi"]) mkdirSync(join(home, d), { recursive: true });
  const outside = join(root, "elsewhere-ext");
  mkdirSync(outside);
  writeFileSync(join(outside, "ext.ts"), "// operator code\n");
  writeFileSync(join(home, "carl.json"), JSON.stringify({ extensions: [join(outside, "ext.ts")], envFiles: [join(root, "secrets", "extra.env")], api: { port: 18_765 } }));
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=1:secret\n");
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "secrets", "extra.env"), "OTHER=2:secret\n");
  const cfg = loadConfig(home);
  const api = createServer((_q, r) => r.end("api")).listen(18_765, "127.0.0.1");
  const profile = installProfile(cfg, { controlPlane: [outside], apiPorts: [18_765] })!;
  process.env.TELEGRAM_BOT_TOKEN = "1:secret-from-env";
  const bash = createBashToolDefinition(cfg.workspace, { spawnHook: sandboxSpawnHook(cfg, profile), exposeSessionEnvironment: false });
  const run = async (command: string) => {
    const r: any = await bash.execute("t", { command } as any, undefined, undefined, {} as any).catch((e: Error) => ({ content: [{ type: "text", text: e.message }] }));
    return (r.content ?? []).map((c: any) => c.text).join("\n");
  };
  const ws = cfg.workspace;
  const out = await run([
    `echo hacked >> ${join(home, "carl.json")}`,
    `cat ${join(home, ".env")}`,
    `echo "TOKEN=[$TELEGRAM_BOT_TOKEN]"`,
    `echo ext > ${join(home, "pi", "x.ts")}`,
    `mkdir -p ${join(ws, ".pi")} && echo y > ${join(ws, ".pi", "y.ts")}`,
    `ln ${join(home, ".env")} ${join(ws, "env-link")}`,
    `mv ${join(home, ".env")} ${join(ws, "env-moved")}`,
    `ln ${join(home, "carl.json")} ${join(ws, "config-link")}`,
    `mv ${join(root, "secrets")} ${join(ws, "secrets-moved")}`,
    `cat ${join(root, "secrets", "extra.env")}`,
    `echo pwned >> ${join(outside, "ext.ts")}`,
    `osascript -e 'return 1'`,
    `curl -s -m 3 http://127.0.0.1:18765/ ; echo curl=$?`,
    `echo fine > ${join(ws, "ok.txt")} && echo wrote-workspace`,
  ].join(" ; "));
  api.close();
  delete process.env.TELEGRAM_BOT_TOKEN;
  const { rmSync } = await import("node:fs");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(readFileSync(join(home, "carl.json"), "utf8").includes("hacked"), false, "carl.json must be unchanged");
  assert.doesNotMatch(out, /1:secret|2:secret/, "neither the .env files nor the env var may leak");
  assert.ok(!existsSync(join(ws, "config-link")), "control files cannot be hardlinked into the workspace");
  assert.ok(existsSync(join(root, "secrets", "extra.env")) && !existsSync(join(ws, "secrets-moved")), "a folder holding a secret cannot be moved somewhere readable");
  assert.match(out, /TOKEN=\[\]/);
  assert.ok(!existsSync(join(home, "pi", "x.ts")), "no writes into Carl's Pi dir");
  assert.ok(!existsSync(join(ws, ".pi", "y.ts")), "no Pi extension dir inside the workspace");
  assert.ok(!existsSync(join(ws, "env-link")) && !existsSync(join(ws, "env-moved")), "secrets cannot be linked or moved out");
  assert.equal(readFileSync(join(outside, "ext.ts"), "utf8"), "// operator code\n", "control-plane code outside CARL_HOME is protected");
  assert.doesNotMatch(out, /\bapi\b/, "Carl's own API port is unreachable from the shell");
  assert.match(out, /curl=7|curl=28/);
  assert.match(out, /wrote-workspace/);
});
