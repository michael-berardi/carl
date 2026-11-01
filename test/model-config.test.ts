// Carl ships no model choice: it resolves exactly the model and fallbacks the operator names in carl.json, from the
// operator's own models.json and logins, and never writes a choice back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Brain } from "../src/brain.ts";
import { ensureHome, loadConfig } from "../src/config.ts";
import { Psyche } from "../src/psyche.ts";

const sentinel = "synthetic-secret-not-for-logs";
const modelDef = (id: string, name: string) => ({ id, name, reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 123456, maxTokens: 4096 });
const MODELS = { providers: { "router-a": { api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: sentinel,
  models: [modelDef("vendor/model-x:variant", "Model X")] } } };

// The SDK schedules untracked refreshes when providers are registered; run each Brain in a child and wait for it to exit.
async function scenario(config: object, models?: object): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "carl-model-config-"));
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "--scenario", root, JSON.stringify({ config, models })]);
    return JSON.parse(stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runScenario(root: string, { config, models }: { config: object; models?: object }) {
  const home = join(root, "home"), agentDir = join(root, "agent");
  mkdirSync(home); mkdirSync(agentDir);
  const text = JSON.stringify({ ...config, agentDir, claude: { enabled: false }, ultracompress: "off",
    telegram: { enabled: false }, api: { enabled: false } });
  writeFileSync(join(home, "carl.json"), text);
  if (models) writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
  const output: unknown[] = [];
  const log = { info: (...a: unknown[]) => output.push(a), warn: (...a: unknown[]) => output.push(a),
    error: (...a: unknown[]) => output.push(a), debug: (...a: unknown[]) => output.push(a) };
  const cfg = loadConfig(home); ensureHome(cfg);
  const brain = new Brain(cfg, new Psyche(home), log as any, () => []);
  try {
    await brain.init();
    return { ok: true, sessionModel: brain.sessionModelRef(), selected: brain.model(cfg.model), logs: JSON.stringify(output),
      configAfter: readFileSync(join(home, "carl.json"), "utf8"), config: text };
  } catch (e) {
    return { ok: false, error: (e as Error).message, logs: JSON.stringify(output) };
  } finally {
    await brain.shutdown();
  }
}

if (process.argv[2] === "--scenario") {
  process.stdout.write(JSON.stringify(await runScenario(process.argv[3], JSON.parse(process.argv[4]))));
} else {
  test("without a configured model Carl refuses to start and says how to choose one", async () => {
    const result = await scenario({});
    assert.equal(result.ok, false);
    assert.match(result.error, /carl\.json needs "model": "provider\/model"/);
  });

  test("Carl resolves exactly the configured model from the operator's models.json, nested id included", async () => {
    const result = await scenario({ model: "router-a/vendor/model-x:variant", fallbackModels: [] }, MODELS);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.selected.id, "vendor/model-x:variant");
    assert.equal(result.selected.name, "Model X");
    assert.equal(result.sessionModel, "router-a/vendor/model-x:variant", "no fallbacks: sessions stay on the model");
    assert.ok(!result.logs.includes(sentinel));
    assert.equal(result.configAfter, result.config, "the configuration is never written back");
  });

  test("a configured fallback whose provider is off is skipped by name; the rest of the chain stays", async () => {
    const models = { providers: { ...MODELS.providers, "plan-b": { api: "openai-completions", baseUrl: "http://127.0.0.1:9",
      apiKey: "test", models: [modelDef("model-y", "Model Y")] } } };
    const result = await scenario({ model: "router-a/vendor/model-x:variant",
      fallbackModels: ["claude-code/some-claude-model", "plan-b/model-y"] }, models);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sessionModel, "carl/auto", "a resolvable fallback turns the router on");
    assert.match(result.logs, /fallback model unavailable; skipping it/);
    assert.match(result.logs, /claude-code\/some-claude-model/);
  });
}
