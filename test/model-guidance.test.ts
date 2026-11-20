// Per-model guidance: operator rules in carl.json add short system-prompt lines for the model a turn runs on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigError, loadConfig } from "../src/config.ts";
import { applyGuidance, GUIDANCE_SECTION, guidanceFor, modelGuidance, withGuidance } from "../src/model-guidance.ts";

const RULES = [{ match: "^example/fast-", text: "Return the named JSON shape." }, { match: "flash", text: "Second line." }];

function home(config: object): string {
  const dir = mkdtempSync(join(tmpdir(), "carl-guidance-"));
  writeFileSync(join(dir, "carl.json"), JSON.stringify({ model: "example/fast-1", ...config }));
  return dir;
}

test("no rules by default", () => {
  const dir = home({});
  try { assert.deepEqual(loadConfig(dir).modelGuidance, []); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("carl.json rules load, and a bad rule is a named config error", () => {
  const dir = home({ modelGuidance: RULES });
  try { assert.deepEqual(loadConfig(dir).modelGuidance, RULES); } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const [bad, msg] of [[{}, /must be a list/], [[{ match: "(", text: "x" }], /modelGuidance\[0\]\.match: bad regex/],
    [[{ match: "a", text: "" }], /modelGuidance\[0\]\.text must be non-empty/], [[{ match: "a", text: "x".repeat(601) }], /longer than 600/]] as const) {
    const d = home({ modelGuidance: bad });
    try { assert.throws(() => loadConfig(d), (e: unknown) => e instanceof ConfigError && msg.test((e as Error).message)); }
    finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test("matching follows provider/id, case-insensitive, every matching rule in order, once", () => {
  assert.equal(guidanceFor({ provider: "example", id: "fast-flash" }, RULES), "Return the named JSON shape.\nSecond line.");
  assert.equal(guidanceFor({ provider: "EXAMPLE", id: "fast-1" }, RULES), "Return the named JSON shape.");
  assert.equal(guidanceFor({ provider: "other", id: "slow" }, RULES), "");
  assert.equal(guidanceFor(undefined, RULES), "");
  const once = withGuidance("base", { provider: "example", id: "fast-1" }, RULES);
  assert.equal(once, "base\n\nReturn the named JSON shape.");
  assert.equal(withGuidance(once, { provider: "example", id: "fast-1" }, RULES), once);
});

const event = (sections: Record<string, string> = {}) => ({ systemPrompt: "base", systemPromptOptions: { sections: { ...sections } as Record<string, string>, forceSystemPrompt: undefined as string | undefined } });

test("the extension adds a named section for the running model and keeps every other section", () => {
  const handlers = new Map<string, (e: any, c: any) => any>();
  (modelGuidance(RULES) as any).factory({ on: (e: string, h: any) => handlers.set(e, h) });
  const start = handlers.get("before_agent_start")!;
  const ev = event({ mcp_servers: "server list" });
  assert.equal(start(ev, { model: { provider: "example", id: "fast-1" } }), undefined); // no forced prompt
  assert.equal(ev.systemPromptOptions.sections[GUIDANCE_SECTION], "Return the named JSON shape.");
  assert.equal(ev.systemPromptOptions.sections.mcp_servers, "server list");
  // a handler that runs later (the MCP extension) still adds its section, and both render
  ev.systemPromptOptions.sections.later = "added after";
  assert.deepEqual(Object.keys(ev.systemPromptOptions.sections).sort(), ["later", "mcp_servers", GUIDANCE_SECTION].sort());
  const other = event();
  assert.equal(start(other, { model: { provider: "other", id: "slow" } }), undefined);
  assert.equal(other.systemPromptOptions.sections[GUIDANCE_SECTION], undefined);
  const none = new Map();
  (modelGuidance([]) as any).factory({ on: (e: string, h: any) => none.set(e, h) });
  assert.equal(none.size, 0);
});

test("after an earlier handler forced a whole prompt, the text is appended to it once", () => {
  const ev = event();
  ev.systemPromptOptions.forceSystemPrompt = "forced";
  (ev as any).systemPrompt = "forced";
  assert.deepEqual(applyGuidance(ev, "Line."), { systemPrompt: "forced\n\nLine." });
  (ev as any).systemPrompt = "forced\n\nLine.";
  assert.equal(applyGuidance(ev, "Line."), undefined);
});

test("with fallbacks, the router model resolves to the chain link the turn starts on", async () => {
  const { createRouter } = await import("../src/router.ts");
  const resolve = (ref: string) => ({ provider: ref.split("/")[0], id: ref.split("/").slice(1).join("/") }) as any;
  const router = createRouter({ primary: "example/fast-1", fallbacks: ["other/slow"], resolve, events: { onFallback: () => {} } });
  const handlers = new Map<string, (e: any, c: any) => any>();
  const physical = (m: any) => (m?.provider === "carl" && m.id === "auto" ? resolve(router.current()) : m);
  (modelGuidance(RULES, physical) as any).factory({ on: (e: string, h: any) => handlers.set(e, h) });
  const start = handlers.get("before_agent_start")!;
  const auto = { model: { provider: "carl", id: "auto" } };
  const first = event();
  start(first, auto);
  assert.equal(first.systemPromptOptions.sections[GUIDANCE_SECTION], "Return the named JSON shape.");
  router.exhaustedUntil.set("example/fast-1", Date.now() + 60_000); // primary benched: turns start on the fallback
  const second = event();
  start(second, auto);
  assert.equal(second.systemPromptOptions.sections[GUIDANCE_SECTION], undefined);
  assert.equal(router.current(), "other/slow");
});
