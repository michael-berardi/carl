// Every model call, not only chat turns, follows the configured fallback chain: a one-shot run (individuation,
// titles) whose model refuses with a usage limit before any output moves to the next model, benches the refused
// one and logs it. With no fallback configured the run fails naming the provider's own words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Brain } from "../src/brain.ts";
import { ensureHome, loadConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { Psyche } from "../src/psyche.ts";

const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_000 }] });
const LIMIT = "The usage limit has been reached";
const modelDef = (id: string) => ({ id, name: id, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 });

function home(extra: Record<string, unknown> = {}, fallbacks: string[] = ["plan-b/model-y"]): string {
  const root = mkdtempSync(join(tmpdir(), "carl-oneshot-fallback-"));
  const carl = join(root, "carl"), agentDir = join(root, "agent");
  mkdirSync(carl); mkdirSync(agentDir);
  writeFileSync(join(carl, "carl.json"), JSON.stringify({
    model: "plan-a/model-x", fallbackModels: fallbacks, agentDir, thinking: "medium", tools: [], claude: { enabled: false },
    ultracompress: "off", telegram: { enabled: false }, api: { enabled: false }, ...extra,
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "plan-a": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [modelDef("model-x")] },
    "plan-b": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [modelDef("model-y")] },
  } }));
  return carl;
}

const refusal = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: LIMIT });

test("oneShot: a usage-limit refusal moves to the fallback model and returns its answer", async (t) => {
  const carl = home();
  t.after(() => rmSync(join(carl, ".."), { recursive: true, force: true }));
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const warnings: { msg: string; data?: any }[] = [];
  const log = { info: () => {}, debug: () => {}, error: () => {}, warn: (msg: string, data?: unknown) => warnings.push({ msg, data }) };
  const brain = new Brain(cfg, psyche, log as any, () => []);
  const fallbacks: any[] = [];
  brain.on("fallback", (e) => fallbacks.push(e));
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses([refusal(), fauxAssistantMessage(fauxText("FALLBACK-ANSWER"))]);
  const out = await brain.oneShot("summarise");
  assert.equal(out, "FALLBACK-ANSWER");
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].from, "plan-a/model-x");
  assert.equal(fallbacks[0].to, "plan-b/model-y");
  assert.ok(warnings.some((w) => /fallback chain/.test(w.msg) && /usage limit/.test(JSON.stringify(w.data))), "logged with the cause");
  assert.ok((brain.routerState.get("plan-a/model-x") ?? 0) > Date.now(), "the refused model is benched");
  // Benched: the next one-shot goes straight to the fallback.
  const before = faux.state.callCount;
  faux.setResponses([fauxAssistantMessage(fauxText("again"))]);
  assert.equal(await brain.oneShot("again"), "again");
  assert.equal(faux.state.callCount - before, 1);
});

test("oneShot: the side model falls back too when it is a link of the chain", async (t) => {
  const carl = home({ sideModel: "plan-a/model-x", model: "plan-b/model-y" }, ["plan-a/model-x", "plan-b/model-y"]);
  t.after(() => rmSync(join(carl, ".."), { recursive: true, force: true }));
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const log = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
  const brain = new Brain(cfg, psyche, log as any, () => []);
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses([refusal(), fauxAssistantMessage(fauxText("SIDE-FALLBACK"))]);
  assert.equal(await brain.oneShot("title"), "SIDE-FALLBACK");
});

test("individuation completes on the fallback model when the primary hits its usage limit", async (t) => {
  const carl = home();
  t.after(() => rmSync(join(carl, ".."), { recursive: true, force: true }));
  const cfg = loadConfig(carl);
  const gw = new Gateway(cfg);
  await gw.brain.init();
  t.after(() => gw.brain.shutdown());
  gw.psyche.recordShadow({ kind: "tool_error", conversation: "cli:x", summary: "a tool failed", evidence: "boom" });
  faux.setResponses([refusal(), fauxAssistantMessage(fauxText("### Lessons\n- Check the tool result before replying.\n\n### Contradictions\nNone.\n\n### Proposals\nNone."))]);
  await gw.individuate();
  assert.match(gw.psyche.read("integrated.md"), /Check the tool result/);
});

test("oneShot with no fallback configured fails and names the cause", async (t) => {
  const carl = home({}, []);
  t.after(() => rmSync(join(carl, ".."), { recursive: true, force: true }));
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const log = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
  const brain = new Brain(cfg, psyche, log as any, () => []);
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses([refusal()]);
  await assert.rejects(() => brain.oneShot("summarise"), /usage limit has been reached/);
});
