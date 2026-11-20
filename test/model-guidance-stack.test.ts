// The real Carl stack: with fallbacks (sessions run on the router model) and an MCP server configured, a matching
// modelGuidance rule reaches the prompt the model receives, and the MCP server list is still in it.
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

const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_000 }] });
const fixture = new URL("./fixtures-fake-mcp.mjs", import.meta.url).pathname;
const modelDef = (id: string) => ({ id, name: id, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 });
const LINE = "Return the JSON shape the task names.";

test("guidance reaches the routed model's prompt next to the MCP server list", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "carl-guidance-stack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "carl"), agentDir = join(root, "agent");
  mkdirSync(home); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "plan-a": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [modelDef("model-x")] },
    "plan-b": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [modelDef("model-y")] },
  } }));
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { helper: { command: process.execPath, args: [fixture, join(root, "calls.log")], exposure: "codemode" } } }));
  writeFileSync(join(home, "carl.json"), JSON.stringify({
    model: "plan-a/model-x", fallbackModels: ["plan-b/model-y"], agentDir, tools: ["read"], mcp: true, trustedMcp: ["helper"],
    modelGuidance: [{ match: "^plan-a/", text: LINE }],
    claude: { enabled: false }, ultracompress: "off", telegram: { enabled: false }, api: { enabled: false },
  }));
  const cfg = loadConfig(home);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const brain = new Brain(cfg, psyche, new Log(undefined), () => []);
  await brain.init();
  t.after(() => brain.shutdown());
  assert.equal(brain.sessionModelRef(), "carl/auto", "sessions select the router model");
  const prompts: string[] = [];
  const capture = (context: any) => {
    const system = (context.messages ?? []).filter((m: any) => m.role === "system");
    // Replay the system messages the way Pi does: later messages replace named sections, null removes one.
    const sections: Record<string, string> = {};
    for (const m of system) for (const [k, v] of Object.entries(m.sections ?? {})) {
      if (v === null) delete sections[k]; else sections[k] = String(v);
    }
    prompts.push(Object.values(sections).join("\n\n"));
    return fauxAssistantMessage(fauxText("ok"));
  };
  faux.setResponses([capture]);
  const first = await brain.ask("api:guidance", { text: "hello", source: "api" });
  assert.ok(first.ok, first.error);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(LINE), "the primary's guidance is in the prompt it received");
  assert.match(prompts[0], /<mcp_servers>[\s\S]*helper[\s\S]*<\/mcp_servers>/, "the MCP server list is still in the prompt");
  // Bench the primary: the next turn starts on the fallback, which has no rule, so the line is gone.
  (brain as any).routerState.set("plan-a/model-x", Date.now() + 60_000);
  faux.setResponses([capture]);
  const second = await brain.ask("api:guidance", { text: "again", source: "api" });
  assert.ok(second.ok, second.error);
  assert.ok(!prompts[1].includes(LINE), "the fallback's turn carries no primary-only guidance");
  assert.match(prompts[1], /<mcp_servers>[\s\S]*helper/);
});
