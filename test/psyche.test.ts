import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { individuationPrompt, looksLikeCorrection, parseIndividuation, Psyche } from "../src/psyche.ts";

function home() {
  const h = mkdtempSync(join(tmpdir(), "carl-psyche-"));
  mkdirSync(join(h, "psyche"));
  return h;
}

test("self outranks persona in the prompt; lessons follow", () => {
  const p = new Psyche(home());
  p.seed();
  p.writeIntegrated("- When X, I Y; instead I Z.");
  const sections = p.promptSections();
  assert.match(sections[0], /^# Self/);
  assert.match(sections[1], /^# Persona/);
  assert.match(sections[2], /Lessons from your own shadow/);
});

test("shadow and decisions round-trip; outcomes merge", () => {
  const p = new Psyche(home());
  p.recordShadow({ kind: "correction", conversation: "c", summary: "no, wrong file" });
  assert.equal(p.shadowSince().length, 1);
  const d = p.recordDecision({ decision: "ship Carl", expected: "fewer tokens" });
  p.recordOutcome(d.id, "6k vs 30k tokens");
  const [only] = p.decisions();
  assert.equal(only.outcome, "6k vs 30k tokens");
  assert.equal(p.decisions().length, 1);
});

test("correction heuristic", () => {
  assert.ok(looksLikeCorrection("No, I said the other repo"));
  assert.ok(looksLikeCorrection("why did you deploy that"));
  assert.ok(!looksLikeCorrection("Nobody uses that feature"));
  assert.ok(!looksLikeCorrection("ship it"));
});

test("individuation prompt and parse", () => {
  const prompt = individuationPrompt("# Self", "", [{ at: "2026-10-15T00:00:00Z", kind: "tool_error", conversation: "c", summary: "bash failed" }], [], "- reply");
  assert.match(prompt, /bash failed/);
  const parsed = parseIndividuation("### Lessons\n- a\n\n### Contradictions\nNone found\n\n### Proposals\n- p");
  assert.equal(parsed.lessons, "- a");
  assert.equal(parsed.contradictions, "None found");
  assert.equal(parsed.proposals, "- p");
});

test("under UltraTerm learning the private lessons layer stays out of the prompt; ledgers still record", () => {
  const p = new Psyche(home(), "ultraterm");
  p.seed();
  p.writeIntegrated("- When X, I Y; instead I Z.");
  const sections = p.promptSections();
  assert.equal(sections.length, 2);
  assert.ok(!sections.some((s) => /Lessons from your own shadow/.test(s)));
  p.recordShadow({ kind: "tool_error", conversation: "c", summary: "codemode failed" });
  assert.equal(p.shadowSince().length, 1);
});

test("a night with no new lessons is a no-op, not an error", () => {
  const p = new Psyche(home());
  assert.equal(p.writeIntegrated("- Keep replies short."), 1);
  assert.equal(p.writeIntegrated("None."), 0);
  assert.equal(p.writeIntegrated(""), 0);
  assert.equal(p.read("integrated.md"), "- Keep replies short.");
});

test("a no-op night still moves the reflection window", () => {
  const p = new Psyche(home());
  assert.equal(p.lastIndividuation(), undefined);
  p.writeIntegrated("None.");
  assert.ok(p.lastIndividuation());
  assert.equal(p.promptSections().some((s) => /Lessons from your own shadow/.test(s)), false);
});
