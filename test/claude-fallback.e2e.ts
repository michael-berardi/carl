// The real claude CLI against a loopback fake Anthropic upstream that answers "session limit" (429):
// Carl must name the cause, then answer the same turn on the fallback model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Brain } from "../src/brain.ts";
import { Log } from "../src/log.ts";
import { Psyche } from "../src/psyche.ts";

let hits = 0;
const fake = createServer((req, res) => {
  hits++;
  let body = "";
  req.on("data", (b) => (body += b));
  req.on("end", () => {
    const msg = '{"type":"error","error":{"type":"rate_limit_error","message":"You\'ve hit your session limit · resets in 2h"}}';
    res.writeHead(429, { "content-type": "application/json", "request-id": "req_fake" }).end(msg);
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
process.env.CARL_CLAUDE_UPSTREAM = `http://127.0.0.1:${(fake.address() as any).port}`;

const home = mkdtempSync(join(process.env.CARL_E2E_DIR ?? tmpdir(), "carl-fallback-"));
writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "claude-code/claude-sonnet-5-5", fallbackModels: ["openai-codex/gpt-6.1-sol"], agentDir: process.env.CARL_E2E_AGENT_DIR ?? join(homedir(), ".pi", "agent"), thinking: "low", tools: [], telegram: { enabled: false }, api: { enabled: false } }));
const cfg = loadConfig(home);
const psyche = new Psyche(home);
const log = new Log(join(home, "carl.log"));
const { mkdirSync } = await import("node:fs");
mkdirSync(join(home, "psyche"), { recursive: true });
mkdirSync(join(home, "workspace"), { recursive: true });
psyche.seed();
const brain = new Brain(cfg, psyche, log, () => []);
const fallbacks: any[] = [];
brain.on("fallback", (e) => fallbacks.push(e));
await brain.init();
const result = await brain.ask("cli:fallback", { text: "Reply with exactly: fallback-ok", source: "cli" });
console.log(JSON.stringify({ ok: result.ok, model: result.model, text: result.text, error: result.error, hits, fallbacks }, null, 1));
assert.ok(hits >= 1, "the claude CLI never reached the fake upstream");
assert.equal(fallbacks.length, 1);
assert.equal(fallbacks[0].from, "claude-code/claude-sonnet-5-5");
assert.equal(fallbacks[0].to, "openai-codex/gpt-6.1-sol");
assert.match(fallbacks[0].reason, /session limit/);
assert.ok(result.ok, result.error);
assert.match(result.text, /fallback-ok/);
await brain.shutdown();
fake.close();
console.log("PASS claude quota fallback");
