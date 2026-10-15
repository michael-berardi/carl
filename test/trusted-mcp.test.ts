import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Brain } from "../src/brain.ts";
import { ensureHome, loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { Psyche } from "../src/psyche.ts";

// The real stack: Carl's Brain, Pi's MCP and codemode extensions, a stdio MCP server named like OverSeer, and a
// scripted model. A trusted server's read tool runs; its acting tool asks, and when denied never reaches the server.
const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_000 }] });
const fixture = new URL("./fixtures-fake-mcp.mjs", import.meta.url).pathname;

async function scenario(t: any, exposure: "direct" | "codemode", steps: any[]) {
  const root = mkdtempSync(join(tmpdir(), "carl-trusted-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "carl");
  const piAgent = join(root, "pi-agent");
  mkdirSync(join(home, "pi"), { recursive: true });
  mkdirSync(piAgent, { recursive: true });
  writeFileSync(join(piAgent, "models.json"), JSON.stringify({ providers: { faux: { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [{ id: "faux-1", name: "Faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }] } } }));
  const calls = join(root, "calls.log");
  writeFileSync(join(home, "pi", "mcp.json"), JSON.stringify({ mcpServers: { overseer: { command: process.execPath, args: [fixture, calls], exposure } } }));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "faux/faux-1", piAgentDir: piAgent, tools: ["read", "bash"], mcp: true, trustedMcp: ["overseer"],
    claude: { enabled: false }, ultracompress: "off", telegram: { enabled: false }, api: { enabled: false } }));
  const cfg = loadConfig(home);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const brain = new Brain(cfg, psyche, new Log(undefined), () => []);
  const asked: { subject: string; reason: string }[] = [];
  brain.approver = () => async (subject: string, reason: string) => { asked.push({ subject, reason }); return "denied"; };
  await brain.init();
  t.after(() => brain.shutdown());
  faux.setResponses(steps);
  const result = await brain.ask("api:trusted-mcp", { text: "go", source: "api" });
  return { result, asked, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
}

test("trusted MCP, direct tools: a read runs, an acting tool asks and is not run when denied", async (t) => {
  const { asked, calls } = await scenario(t, "direct", [
    fauxAssistantMessage(fauxToolCall("mcp__overseer__overseer_status", {})),
    fauxAssistantMessage(fauxToolCall("mcp__overseer__overseer_send", { text: "rm -rf ~" })),
    fauxAssistantMessage(fauxText("done")),
  ]);
  assert.deepEqual(calls, ["overseer_status"], "only the read reached the server");
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /overseer overseer_send acts outside the sandbox/);
  assert.match(asked[0].subject, /rm -rf ~/, "the card shows the exact arguments");
});

test("trusted MCP from a codemode script: the same rule applies to nested calls", async (t) => {
  const code = [
    "await tools.mcp__overseer__overseer_status({});",
    "try { await tools.mcp__overseer__overseer_send({ text: 'echo pwned' }); text('send ran'); } catch (e) { text('send blocked: ' + e.message); }",
  ].join("\n");
  const { asked, calls } = await scenario(t, "codemode", [
    fauxAssistantMessage(fauxToolCall("codemode", { code })),
    fauxAssistantMessage(fauxText("done")),
  ]);
  assert.deepEqual(calls, ["overseer_status"], "only the read reached the server");
  assert.equal(asked.length, 1, `asked: ${JSON.stringify(asked)}`);
  assert.match(asked[0].reason, /overseer overseer_send/);
});
