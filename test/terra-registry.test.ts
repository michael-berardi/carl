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
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerTerra, TERRA_MODEL } from "../src/providers/terra.ts";
import { OPENROUTER_EXACTO_MODEL, registerOpenRouter } from "../src/providers/openrouter.ts";

const sentinel = "synthetic-secret-not-for-logs";
const customModel = (id: string, name: string) => ({ id, name, reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 123456, maxTokens: 4096 });

// The SDK schedules untracked refreshes when providers are registered. Brain.shutdown()
// does not await those refreshes, so run each Brain in a child and wait for it to exit
// before removing its private directory (including on initialization failure).
async function scenario(model: string | undefined, models?: object, fallbackModels?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "carl-terra-test-"));
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "--scenario",
        root, JSON.stringify({ model, models, fallbackModels })]);
    return JSON.parse(stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runScenario(root: string, { model, models, fallbackModels }: {
  model?: string; models?: object; fallbackModels?: string[];
}) {
  const home = join(root, "home"), agentDir = join(root, "agent");
  mkdirSync(home); mkdirSync(agentDir);
  // An omitted fallbackModels key gets Carl's default chain; an explicit [] (or list) is written as given.
  const config = JSON.stringify({ ...(model ? { model } : {}), agentDir, ...(fallbackModels ? { fallbackModels } : {}),
    claude: { enabled: false }, ultracompress: "off", telegram: { enabled: false }, api: { enabled: false } });
  writeFileSync(join(home, "carl.json"), config);
  if (models) writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
  const output: unknown[] = [];
  const log = { info: (...args: unknown[]) => output.push(args), warn: (...args: unknown[]) => output.push(args),
    error: (...args: unknown[]) => output.push(args), debug: (...args: unknown[]) => output.push(args) };
  const cfg = loadConfig(home); ensureHome(cfg);
  const brain = new Brain(cfg, new Psyche(home), log as any, () => []);
  try {
    await brain.init();
    const openrouter = brain.model("openrouter/deepseek/deepseek-v4.1-flash-1017:exacto");
    return { selected: cfg.model, sessionModel: brain.sessionModelRef(), terra: brain.model("openai-codex/gpt-6.1-terra"),
      openrouter, explicit: brain.model(cfg.model), logs: JSON.stringify(output), configAfter: readFileSync(join(home, "carl.json"), "utf8"), config };
  } finally {
    await brain.shutdown();
  }
}

if (process.argv[2] === "--scenario") {
  const result = await runScenario(process.argv[3], JSON.parse(process.argv[4]));
  process.stdout.write(JSON.stringify(result));
} else {
test("Terra uses conservative SDK Codex 6.1 Sol capability metadata", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } });
  const sibling = runtime.getModel("openai-codex", "gpt-6.1-sol")!;
  assert.ok(sibling);
  for (const key of ["api", "baseUrl", "type", "reasoning", "input", "contextWindow", "maxTokens", "thinkingLevelMap", "compat", "inputLimits"] as const) {
    assert.deepEqual(TERRA_MODEL[key], sibling[key], key);
  }
  assert.equal(TERRA_MODEL.contextWindow, 272_000);
  assert.equal(TERRA_MODEL.thinkingLevelMap?.off, null);
  assert.deepEqual(TERRA_MODEL.cost, { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
    tiers: [{ inputTokensAbove: 272_000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }] });
});

test("an already registered native Terra takes precedence", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } });
  const base = runtime.getProvider("openai-codex")!;
  const nativeTerra = { ...TERRA_MODEL, name: "Native Terra", contextWindow: 64000 };
  const native = { ...base, getModels: () => [...base.getModels(), nativeTerra],
    getAllModels: () => [...base.getAllModels!(), nativeTerra] };
  runtime.registerNativeProvider(native);
  await registerTerra(runtime);
  assert.equal(runtime.getRegisteredNativeProvider("openai-codex"), native);
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(runtime.getModel("openai-codex", TERRA_MODEL.id), nativeTerra);
  assert.equal(runtime.getModels().filter(m => m.provider === "openai-codex" && m.id === TERRA_MODEL.id).length, 1);
});

test("Brain resolves Terra from the native Codex catalog with verified metadata when it is selected", async () => {
  const result = await scenario("openai-codex/gpt-6.1-terra", undefined, []);
  assert.equal(result.selected, "openai-codex/gpt-6.1-terra");
  assert.equal(result.sessionModel, result.selected, "an explicit empty fallback list keeps sessions on the primary");
  assert.deepEqual(result.terra, TERRA_MODEL);
  assert.equal(result.configAfter, result.config);
});

test("Brain preserves explicitly configured model and custom Terra metadata without leaking credentials", async () => {
  const models = { providers: { "openai-codex": { apiKey: sentinel,
    models: [customModel("gpt-6.1-sol", "Custom Sol"), customModel("gpt-6.1-terra", "Custom Terra")] } } };
  const result = await scenario("openai-codex/gpt-6.1-sol", models, ["openai-codex/gpt-6.1-terra"]);
  assert.equal(result.selected, "openai-codex/gpt-6.1-sol");
  assert.equal(result.sessionModel, "carl/auto");
  assert.equal(result.explicit.name, "Custom Sol");
  assert.equal(result.terra.name, "Custom Terra");
  assert.equal(result.terra.contextWindow, 123456);
  assert.ok(!result.logs.includes(sentinel));
  assert.ok(!JSON.stringify(result.terra).includes(sentinel));
  assert.equal(result.configAfter, result.config);
});

test("Brain adds Terra without removing a custom explicit Codex model", async () => {
  const models = { providers: { "openai-codex": { apiKey: sentinel, models: [customModel("gpt-6.1-sol", "Custom Sol")] } } };
  const result = await scenario("openai-codex/gpt-6.1-sol", models, ["openai-codex/gpt-6.1-terra"]);
  assert.equal(result.explicit.name, "Custom Sol");
  assert.equal(result.terra.id, TERRA_MODEL.id);
  assert.ok(!result.logs.includes(sentinel));
});

test("the OpenRouter Exacto route keeps the catalog's transport and sets its own text-only limits and price", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } });
  const sibling = runtime.getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;
  assert.ok(sibling, "the catalog lost its plain deepseek-v4.1-flash sibling");
  // Transport and thinking format are the catalog's; the Exacto variant only changes what it routes to and charges.
  for (const key of ["api", "baseUrl", "type", "reasoning", "thinkingLevelMap"] as const) {
    assert.deepEqual(OPENROUTER_EXACTO_MODEL[key], sibling[key], key);
  }
  assert.equal((OPENROUTER_EXACTO_MODEL.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, "openrouter");
  assert.equal(OPENROUTER_EXACTO_MODEL.id, "deepseek/deepseek-v4.1-flash-1017:exacto");
  assert.equal(OPENROUTER_EXACTO_MODEL.api, "openai-completions");
  assert.equal(OPENROUTER_EXACTO_MODEL.baseUrl, "https://openrouter.ai/api/v1");
  assert.deepEqual(OPENROUTER_EXACTO_MODEL.input, ["text"]);
  assert.equal(OPENROUTER_EXACTO_MODEL.contextWindow, 1_048_576);
  assert.equal(OPENROUTER_EXACTO_MODEL.maxTokens, 65_536);
  assert.deepEqual(OPENROUTER_EXACTO_MODEL.cost, { input: 0.15, output: 0.6, cacheRead: 0.013, cacheWrite: 0 });
  await registerOpenRouter(runtime);
  assert.deepEqual(runtime.getModel("openrouter", OPENROUTER_EXACTO_MODEL.id), OPENROUTER_EXACTO_MODEL);
  await registerOpenRouter(runtime); // idempotent: one entry, never two
  assert.equal(runtime.getModels("openrouter").filter((m: any) => m.id === OPENROUTER_EXACTO_MODEL.id).length, 1);
});

test("Brain resolves the default OpenRouter Exacto route and skips a fallback whose provider is off", async () => {
  const result = await scenario(undefined, undefined, undefined); // no model, no fallbackModels: Carl's defaults
  assert.equal(result.selected, "openrouter/deepseek/deepseek-v4.1-flash-1017:exacto");
  assert.equal(result.sessionModel, "carl/auto", "the default fallback chain turns the router on");
  assert.deepEqual(result.openrouter, OPENROUTER_EXACTO_MODEL);
  // claude.enabled is false in this scenario, so the Claude link of the default chain is skipped by name.
  assert.match(result.logs, /fallback model unavailable; skipping it/);
  assert.match(result.logs, /claude-code\/claude-sonnet-5-5/);
  assert.equal(result.configAfter, result.config, "defaults are read in memory, never written back");
});

}
