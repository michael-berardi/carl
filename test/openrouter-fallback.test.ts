// The real Carl stack against scripted providers: OpenRouter's Exacto route refuses with a 402 "insufficient
// credits" before writing anything. Pi does not retry that error class, so Carl must bench the route and answer the
// same turn on the next tier (OpenCode Go) without stalling. The fallback event and the log name the cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Brain } from "../src/brain.ts";
import { ensureHome, loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { Psyche } from "../src/psyche.ts";
import { OPENROUTER_EXACTO_MODEL } from "../src/providers/openrouter.ts";

const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_000 }] });

const modelDef = (id: string, name: string) => ({ id, name, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 });

/** A Carl home whose OpenRouter and OpenCode Go providers both point at the scripted api. */
function home(): string {
  const root = mkdtempSync(join(tmpdir(), "carl-openrouter-fallback-"));
  const carl = join(root, "carl"), agentDir = join(root, "agent");
  mkdirSync(carl); mkdirSync(agentDir);
  writeFileSync(join(carl, "carl.json"), JSON.stringify({
    model: "openrouter/deepseek/deepseek-v4.1-flash-1017:exacto",
    fallbackModels: ["opencode-go/deepseek-v4.1-flash"],
    agentDir, thinking: "medium", tools: [], claude: { enabled: false },
    ultracompress: "off", telegram: { enabled: false }, api: { enabled: false },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    openrouter: { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test",
      models: [modelDef(OPENROUTER_EXACTO_MODEL.id, "DeepSeek V4.1 Flash 1017 (Exacto)")] },
    "opencode-go": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test",
      models: [modelDef("deepseek-v4.1-flash", "DeepSeek V4.1 Flash")] },
  } }));
  return carl;
}

test("an OpenRouter 402 before output moves the turn to the next tier and names the cause", async (t) => {
  const carl = home();
  t.after(() => rmSync(join(carl, ".."), { recursive: true, force: true }));
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const warnings: { msg: string; data?: unknown }[] = [];
  const log = { info: () => {}, debug: () => {}, error: () => {},
    warn: (msg: string, data?: unknown) => warnings.push({ msg, data }) };
  const brain = new Brain(cfg, psyche, log as any, () => []);
  const fallbacks: any[] = [];
  brain.on("fallback", (e) => fallbacks.push(e));
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error",
      errorMessage: "OpenRouter error (402): insufficient credits to run deepseek/deepseek-v4.1-flash-1017:exacto" }),
    fauxAssistantMessage(fauxText("CARL-OR-OK")),
  ]);
  const result = await brain.ask("cli:openrouter", { text: "Reply with exactly: CARL-OR-OK", source: "cli" });
  assert.ok(result.ok, result.error);
  // The scripted api stamps its own provider id on messages; the model id shows which route answered.
  assert.equal(result.model, "faux/deepseek-v4.1-flash", "the OpenCode Go route answered the turn");
  assert.match(result.text, /CARL-OR-OK/);
  assert.equal(fallbacks.length, 1, "one fallback event");
  assert.equal(fallbacks[0].from, "openrouter/deepseek/deepseek-v4.1-flash-1017:exacto");
  assert.equal(fallbacks[0].to, "opencode-go/deepseek-v4.1-flash");
  assert.match(fallbacks[0].reason, /402|insufficient credits/, "the event names the provider's own words");
  assert.ok(warnings.some((w) => /next model in the fallback chain/.test(w.msg) && /insufficient credits/.test(JSON.stringify(w.data))),
    "the logged warning names the cause");
  // The refused route stays benched: the next turn starts on OpenCode Go without hitting OpenRouter again.
  const callsBefore = faux.state.callCount;
  faux.setResponses([fauxAssistantMessage(fauxText("second"))]);
  const second = await brain.ask("cli:openrouter", { text: "again", source: "cli" });
  assert.ok(second.ok, second.error);
  assert.equal(second.model, "faux/deepseek-v4.1-flash");
  assert.equal(faux.state.callCount - callsBefore, 1, "the benched route was not called again");
});

test("an OpenRouter 404 \"no endpoints available\" also moves to the next tier", async (t) => {
  const carl = home();
  t.after(() => rmSync(join(carl, ".."), { recursive: true, force: true }));
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const log = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
  const brain = new Brain(cfg, psyche, log as any, () => []);
  const fallbacks: any[] = [];
  brain.on("fallback", (e) => fallbacks.push(e));
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "OpenRouter error (404): no endpoints available for this model" }),
    fauxAssistantMessage(fauxText("CARL-OR-OK")),
  ]);
  const result = await brain.ask("cli:openrouter", { text: "Reply with exactly: CARL-OR-OK", source: "cli" });
  assert.ok(result.ok, result.error);
  assert.equal(result.model, "faux/deepseek-v4.1-flash");
  assert.equal(fallbacks.length, 1);
  assert.match(fallbacks[0].reason, /no endpoints available/);
});

test("a refusal after output is not retried on another model, but its route stays benched", async (t) => {
  const carl = home();
  t.after(() => rmSync(join(carl, ".."), { recursive: true, force: true }));
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const log = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
  const brain = new Brain(cfg, psyche, log as any, () => []);
  const fallbacks: any[] = [];
  brain.on("fallback", (e) => fallbacks.push(e));
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses([
    fauxAssistantMessage("half an answer", { stopReason: "error", errorMessage: "OpenRouter error (402): insufficient credits" }),
  ]);
  const result = await brain.ask("cli:openrouter", { text: "say something", source: "cli" });
  assert.equal(result.ok, false, "the turn ends on its own model when it already wrote something");
  assert.match(result.error ?? "", /402|insufficient credits/);
  assert.equal(fallbacks.length, 0, "no silent mid-turn model switch");
  assert.ok((brain.routerState.get("openrouter/deepseek/deepseek-v4.1-flash-1017:exacto") ?? 0) > Date.now(),
    "the failed route is benched for the next turn");
});
