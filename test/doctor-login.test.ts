import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeProvider } from "../src/login.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("doctor skips an unset primary login and names configured fallback providers", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-doctor-"));
  try {
    const run = (command: string) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, command], {
      env: { PATH: process.env.PATH, HOME: home, CARL_HOME: home }, encoding: "utf8", timeout: 30000,
    });
    assert.equal(run("init").status, 0);
    const first = run("doctor");
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stdout, /^FAIL  model: .*needs "model"/m);
    assert.match(first.stdout, /^skip  login: set "model" first; then sign in with `carl login <provider>`$/m);
    assert.doesNotMatch(first.stdout, /login :|no credentials for  |carl login `/);

    const file = join(home, "carl.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.fallbackModels = ["provider-b/model", ""];
    writeFileSync(file, JSON.stringify(config));
    const fallback = run("doctor");
    assert.match(fallback.stdout, /^skip  login: set "model" first/m);
    assert.match(fallback.stdout, /^warn  login provider-b: no credentials for provider-b .*`carl login provider-b`/m);
    assert.match(fallback.stdout, /^warn  login: fallbackModels\[1\] has no provider$/m);
    assert.doesNotMatch(fallback.stdout, /login :|no credentials for  |carl login `/);

    config.model = "provider-a/model";
    writeFileSync(file, JSON.stringify(config));
    const configured = run("doctor");
    assert.equal(configured.status, 1, configured.stderr);
    assert.match(configured.stdout, /^FAIL  login provider-a: no credentials for provider-a .*`carl login provider-a`/m);
    assert.match(configured.stdout, /^warn  login provider-b: no credentials for provider-b .*`carl login provider-b`/m);
    assert.doesNotMatch(configured.stdout, /^skip  login:/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor credential probe fails a dead Codex grant instead of trusting listModels", async () => {
  const cfg = { agentDir: "/synthetic/carl-agent", modelsPath: "/synthetic/models.json" } as any;
  await assert.rejects(
    () => probeProvider(cfg, "openai-codex", async () => ({
      getAuth: async () => { throw new Error("invalid_grant"); },
      getProviderAuthStatus: () => ({ configured: true }) as any,
    })),
    /openai-codex credential refresh failed.*carl login openai-codex/,
  );
  await assert.rejects(
    () => probeProvider(cfg, "openai-codex", async () => ({
      getAuth: async () => undefined,
      getProviderAuthStatus: () => ({ configured: false }) as any,
    })),
    /openai-codex grant is expired or revoked.*carl login openai-codex/,
  );
  await assert.doesNotReject(
    () => probeProvider(cfg, "openai-codex", async () => ({
      getAuth: async () => ({}) as any,
      getProviderAuthStatus: () => ({ configured: true }) as any,
    })),
  );
  let forced: { minOAuthValidityMs?: number } | undefined;
  await assert.doesNotReject(
    () => probeProvider(cfg, "openai-codex", async () => ({
      getAuth: async (_provider: any, options: any) => {
        forced = options;
        throw new Error("OAuth refresh returned a token that expires too soon for openai-codex");
      },
      getProviderAuthStatus: () => ({ configured: true }) as any,
    })),
  );
  assert.ok((forced?.minOAuthValidityMs ?? 0) > 5 * 60_000, "doctor forces a real refresh");
});
