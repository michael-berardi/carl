import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { installProfile, sandboxAvailable, sandboxSpawnHook } from "../src/sandbox.ts";

test("shell sandbox: control plane and secrets are out of reach, the workspace is not", { skip: !sandboxAvailable() && "needs macOS sandbox-exec" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-sbx-"));
  for (const d of ["state", "workspace", "pi"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "carl.json"), "{}");
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=1:secret\n");
  const cfg = loadConfig(home);
  const profile = installProfile(cfg)!;
  process.env.TELEGRAM_BOT_TOKEN = "1:secret-from-env";
  const bash = createBashToolDefinition(cfg.workspace, { spawnHook: sandboxSpawnHook(cfg, profile), exposeSessionEnvironment: false });
  const run = async (command: string) => {
    const r: any = await bash.execute("t", { command } as any, undefined, undefined, {} as any).catch((e: Error) => ({ content: [{ type: "text", text: e.message }] }));
    return (r.content ?? []).map((c: any) => c.text).join("\n");
  };
  const out = await run(`echo hacked >> ${join(home, "carl.json")}; cat ${join(home, ".env")}; echo "TOKEN=[$TELEGRAM_BOT_TOKEN]"; echo ext > ${join(home, "pi", "x.ts")}; echo fine > ${join(cfg.workspace, "ok.txt")} && echo wrote-workspace`);
  assert.equal(readFileSync(join(home, "carl.json"), "utf8"), "{}", "carl.json must be unchanged");
  assert.doesNotMatch(out, /1:secret/, "neither the .env file nor the env var may leak");
  assert.match(out, /TOKEN=\[\]/);
  assert.match(out, /Operation not permitted/);
  assert.match(out, /wrote-workspace/);
  assert.equal(readFileSync(join(cfg.workspace, "ok.txt"), "utf8"), "fine\n");
  delete process.env.TELEGRAM_BOT_TOKEN;
});
