// Real compaction: a tiny context budget forces auto-compaction; the fact from before it must survive
// (through the brief or ultracompress_recall). Model from CARL_E2E_MODEL (default GPT-6.1 Sol).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Brain } from "../src/brain.ts";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { Psyche } from "../src/psyche.ts";

const home = mkdtempSync(join(process.env.CARL_E2E_DIR ?? tmpdir(), "carl-compaction-"));
writeFileSync(join(home, "carl.json"), JSON.stringify({ model: process.env.CARL_E2E_MODEL ?? "openai-codex/gpt-6.1-sol", agentDir: process.env.CARL_E2E_AGENT_DIR ?? join(homedir(), ".pi", "agent"), thinking: "low", contextBudget: 12_000, keepRecentTokens: 2_000, tools: ["read", "bash"], toolResultMaxChars: 40_000, telegram: { enabled: false }, api: { enabled: false } }));
mkdirSync(join(home, "psyche"), { recursive: true });
mkdirSync(join(home, "workspace"), { recursive: true });
const cfg = loadConfig(home);
const psyche = new Psyche(home);
psyche.seed();
const brain = new Brain(cfg, psyche, new Log(join(home, "carl.log")), () => []);
await brain.init();
const key = "cli:compaction";
const say = async (text: string) => {
  const r = await brain.ask(key, { text, source: "cli" });
  assert.ok(r.ok, r.error);
  return r;
};
await say("Remember this codename for later: AMBER-HERON-7. Reply OK.");
for (let i = 0; i < 4; i++) await say(`Run: seq ${i * 4000} ${i * 4000 + 2500} | paste -sd, - and reply only with the count of numbers you saw.`);
const file = readdirSync(join(home, "sessions", "cli_compaction")).filter((f) => f.endsWith(".jsonl")).map((f) => join(home, "sessions", "cli_compaction", f))[0];
const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const compactions = entries.filter((e) => e.type === "compaction");
console.log(`compactions: ${compactions.length}; summary chars: ${compactions.map((c) => (c.summary ?? "").length).join(",")}`);
assert.ok(compactions.length >= 1, "no compaction happened");
const r = await say("What was the codename I asked you to remember at the start? Reply with just the codename.");
console.log("answer:", r.text, `(${r.ms} ms, tools ${r.toolCalls})`);
assert.match(r.text, /AMBER-HERON-7/);
const usedUltra = compactions.some((c) => /ultracompress|VCC|brief/i.test(JSON.stringify(c.details ?? c).slice(0, 4000)));
console.log("ultracompress compaction:", usedUltra);
await brain.shutdown();
console.log("PASS compaction keeps early facts");
