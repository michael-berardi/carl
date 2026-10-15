import { test } from "node:test";
import assert from "node:assert/strict";
import { cooldownMs, createRouter, isExhaustion } from "../src/router.ts";

const err = (errorMessage: string) => ({ stopReason: "error" as const, errorMessage });

test("exhaustion is recognised only from the provider's own words", () => {
  assert.ok(isExhaustion(err("Claude upstream error (HTTP 429): You've hit your session limit · resets 3pm")));
  assert.ok(isExhaustion(err("insufficient_quota")));
  assert.ok(isExhaustion(err("HTTP 402: credit balance too low")));
  assert.ok(!isExhaustion(err("Claude Code is not logged in: run `claude auth login`")));
  assert.ok(!isExhaustion(err("Claude upstream error (HTTP 500): internal error")));
  assert.ok(!isExhaustion({ stopReason: "stop" as any, errorMessage: "429" }));
});

test("cooldown follows the provider's reset hint", () => {
  assert.equal(cooldownMs("resets in 2h"), 2 * 3_600_000);
  assert.equal(cooldownMs("resets in 45 minutes"), 45 * 60_000);
  const now = new Date("2026-10-15T10:00:00").getTime();
  assert.equal(cooldownMs("resets at 3pm", now), 5 * 3_600_000);
  assert.equal(cooldownMs("no hint"), 30 * 60_000);
});

test("router: primary, fallback on exhaustion, sticky continuations, recovery after cooldown", () => {
  const models: Record<string, any> = { "a/p": { provider: "a", id: "p" }, "b/f": { provider: "b", id: "f" } };
  const fell: string[] = [];
  const r = createRouter({ primary: "a/p", fallbacks: ["b/f"], resolve: (x) => models[x], events: { onFallback: (from, to) => fell.push(`${from}->${to}`) } });
  assert.equal(r.route({ reason: "user", thinkingLevel: "low" }).model.id, "p");
  const retry = r.route({ reason: "retry", thinkingLevel: "low", failed: { model: models["a/p"], message: err("HTTP 429 usage limit, resets in 1h") } });
  assert.equal(retry.model.id, "f");
  assert.deepEqual(fell, ["a/p->b/f"]);
  assert.equal(r.route({ reason: "user", thinkingLevel: "low" }).model.id, "f", "primary stays benched during its cooldown");
  assert.equal(r.route({ reason: "continuation", thinkingLevel: "low", previous: { model: models["b/f"] } }).model.id, "f");
  r.exhaustedUntil.set("a/p", Date.now() - 1);
  assert.equal(r.route({ reason: "user", thinkingLevel: "low" }).model.id, "p", "primary returns after cooldown");
  // A non-quota failure is retried on the same model, never silently moved.
  assert.equal(r.route({ reason: "retry", thinkingLevel: "low", failed: { model: models["a/p"], message: err("HTTP 503 overloaded") } }).model.id, "p");
});
