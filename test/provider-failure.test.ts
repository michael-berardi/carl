// Provider login, quota and unsupported-model refusals are infrastructure: they belong in the shadow ledger under a
// different kind so the nightly individuation pass cannot turn them into operator questions. Behavioural failures stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Brain } from "../src/brain.ts";
import { ensureHome, loadConfig } from "../src/config.ts";
import { isProviderAccessFailure } from "../src/provider-failure.ts";
import { ClaudeCodeError } from "../src/providers/claude-code.ts";
import { Psyche } from "../src/psyche.ts";

const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_000 }] });

test("provider refusals are classified from their own status and words, not from Carl's guess", () => {
  const provider = [
    new ClaudeCodeError("Claude Code is not logged in: run `claude auth login`", 401),
    new ClaudeCodeError("You've hit your session limit · resets 3pm", 429),
    new ClaudeCodeError("insufficient credits", 402),
    new Error("Claude Code is not logged in for /auth: OAuth session expired"),
    new Error("Your authentication token has expired; run `carl login openai-codex`"),
    new Error("The usage limit has been reached"),
    new Error("model gpt-x is not supported with this account"),
    "unsupported model: gpt-x",
    "HTTP 401: invalid API key",
  ];
  for (const e of provider) assert.equal(isProviderAccessFailure(e), true, String(e));
  const behavioural = [
    new ClaudeCodeError("a tool argument was malformed", 400),
    new Error("the model replied without checking the job id"),
    new Error("HTTP 500: service unavailable"),
    "I forgot to cite the record.",
    undefined,
  ];
  for (const e of behavioural) assert.equal(isProviderAccessFailure(e), false, String(e));
});

function home() {
  const root = mkdtempSync(join(tmpdir(), "carl-provider-shadow-"));
  const carl = join(root, "carl"), agentDir = join(root, "agent");
  mkdirSync(carl); mkdirSync(agentDir);
  writeFileSync(join(carl, "carl.json"), JSON.stringify({
    model: "plan-a/model-x", fallbackModels: [], agentDir, thinking: "medium", tools: [], claude: { enabled: false },
    ultracompress: "off", telegram: { enabled: false }, api: { enabled: false },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "plan-a": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [{
    id: "model-x", name: "model-x", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000,
  }] } } }));
  return carl;
}

async function failingRun(error: string) {
  const carl = home();
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const brain = new Brain(cfg, psyche, { info() {}, warn() {}, error() {}, debug() {} } as any, () => []);
  await brain.init();
  try {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: error }), fauxAssistantMessage(fauxText("unused"))]);
    const result = await brain.ask("cli:test", { text: "hello", source: "cli" });
    assert.equal(result.ok, false);
    return psyche.shadowSince();
  } finally {
    await brain.shutdown();
    rmSync(join(carl, ".."), { recursive: true, force: true });
  }
}

test("a run that dies on a provider login is recorded as provider_failed", async () => {
  const shadow = await failingRun("Claude Code is not logged in: run `claude auth login` (OAuth session expired)");
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].kind, "provider_failed");
  assert.match(shadow[0].summary, /not logged in/);
});

test("a behavioural run failure is still recorded as run_failed", async () => {
  const shadow = await failingRun("the report claimed the job was queued without checking the record");
  assert.equal(shadow.length, 1);
  assert.equal(shadow[0].kind, "run_failed");
});
