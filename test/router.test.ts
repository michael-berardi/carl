import { test } from "node:test";
import assert from "node:assert/strict";
import { cooldownMs, createRouter, isContentFilter, isExhaustion, isOutage } from "../src/router.ts";

const err = (errorMessage: string) => ({ stopReason: "error" as const, errorMessage, content: [] });

test("exhaustion is recognised only from the provider's own words", () => {
  assert.ok(isExhaustion(err("Claude upstream error (HTTP 429): You've hit your session limit · resets 3pm")));
  assert.ok(isExhaustion(err("insufficient_quota")));
  assert.ok(isExhaustion(err("HTTP 402: credit balance too low")));
  // OpenRouter's credit refusal, outage and empty provider set each name their cause and all move the work on.
  assert.ok(isExhaustion(err("OpenRouter error (HTTP 402): insufficient credits to run deepseek/deepseek-v4.1-flash-1017:exacto")));
  assert.ok(isExhaustion(err("OpenRouter error (HTTP 502): upstream provider returned bad gateway")));
  assert.ok(isExhaustion(err("OpenRouter error (HTTP 503): service unavailable")));
  assert.ok(isExhaustion(err("OpenRouter error (HTTP 404): no endpoints available for this model")));
  assert.ok(!isExhaustion(err("Claude Code is not logged in: run `claude auth login`")));
  assert.ok(!isExhaustion(err("HTTP 400: messages must not be empty")));
  assert.ok(!isExhaustion({ stopReason: "stop" as any, errorMessage: "429" }));
});

test("a plan that cannot run the model moves the work on and benches that model for hours", () => {
  // A lapsed paid login that fell back to a free plan: every run failed instead of moving to the next model.
  const refusal = "Codex error: The 'gpt-6.1-terra' model is not supported when using Codex with a ChatGPT account.";
  assert.ok(isExhaustion(err(refusal)));
  assert.ok(!isOutage(err(refusal)));
  assert.equal(cooldownMs(refusal), 6 * 3_600_000);
  assert.ok(!isExhaustion(err("The model gpt-9 does not exist")));
});

test("outages bench for minutes and quota refusals for the provider's reset window", () => {
  assert.ok(!isOutage(err("HTTP 402: insufficient credits")));
  assert.ok(isOutage(err("OpenRouter error (HTTP 502): upstream provider returned bad gateway")));
  assert.ok(isOutage(err("OpenRouter error (HTTP 404): no endpoints available for this model")));
  assert.equal(cooldownMs("OpenRouter error (HTTP 503): service unavailable"), 2 * 60_000);
  assert.equal(cooldownMs("OpenRouter error (HTTP 404): no endpoints available"), 10 * 60_000);
  assert.equal(cooldownMs("HTTP 402: insufficient credits"), 30 * 60_000);
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
  // A failure the provider did not name as exhaustion is retried on the same model, never silently moved.
  assert.equal(r.route({ reason: "retry", thinkingLevel: "low", failed: { model: models["a/p"], message: err("HTTP 400: bad request") } }).model.id, "p");
});

test("router: an OpenRouter 402, 5xx or no-endpoints failure moves to the next tier before any output", () => {
  const models: Record<string, any> = {
    "openrouter/deepseek/deepseek-v4.1-flash-1017:exacto": { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017:exacto" },
    "opencode-go/deepseek-v4.1-flash": { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    "openai-codex/gpt-6.1-terra": { provider: "openai-codex", id: "gpt-6.1-terra" },
  };
  for (const [cause, message] of [
    ["402 credits", "OpenRouter error (HTTP 402): insufficient credits"],
    ["429 limit", "OpenRouter error (HTTP 429): rate limit exceeded, resets in 5m"],
    ["502", "OpenRouter error (HTTP 502): bad gateway"],
    ["no endpoints", "OpenRouter error (HTTP 404): no endpoints available for this model"],
  ] as const) {
    const fell: string[] = [];
    const r = createRouter({ primary: "openrouter/deepseek/deepseek-v4.1-flash-1017:exacto",
      fallbacks: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-6.1-terra"], resolve: (x) => models[x],
      events: { onFallback: (from, to, reason) => fell.push(`${from}->${to}: ${reason}`) } });
    const routed = r.route({ reason: "retry", thinkingLevel: "medium",
      failed: { model: models["openrouter/deepseek/deepseek-v4.1-flash-1017:exacto"], message: err(message) } });
    assert.equal(routed.model.provider, "opencode-go", cause);
    assert.equal(fell.length, 1, cause);
    assert.match(fell[0], /^openrouter\/deepseek\/deepseek-v4\.1-flash-1017:exacto->opencode-go\/deepseek-v4\.1-flash: /, cause);
    // The reason names the provider's own words, so the logged warning says why.
    assert.ok(fell[0].includes(message.slice(0, 20)), cause);
    // The next request stays on the fallback while the primary is benched.
    assert.equal(r.route({ reason: "user", thinkingLevel: "medium" }).model.provider, "opencode-go", cause);
  }
  // A failure after output finishes the turn where it started; the model is still benched for the next turn.
  const models2: Record<string, any> = { "a/p": { provider: "a", id: "p" }, "b/f": { provider: "b", id: "f" } };
  const r2 = createRouter({ primary: "a/p", fallbacks: ["b/f"], resolve: (x) => models2[x], events: { onFallback: () => {} } });
  const partial = { ...err("HTTP 402: insufficient credits"), content: [{ type: "text", text: "half an answer" }] };
  assert.equal(r2.route({ reason: "retry", thinkingLevel: "low", failed: { model: models2["a/p"], message: partial } }).model.id, "p");
  assert.ok((r2.exhaustedUntil.get("a/p") ?? 0) > Date.now(), "the failed model is benched even mid-turn");
  assert.equal(r2.route({ reason: "user", thinkingLevel: "low" }).model.id, "f", "the next turn starts on the fallback");
});

test("router: a model with no login is skipped, not routed to", () => {
  const models: Record<string, any> = { "a/p": { provider: "a", id: "p" }, "b/f": { provider: "b", id: "f" } };
  let signedIn = false;
  const r = createRouter({ primary: "a/p", fallbacks: ["b/f"], resolve: (x) => models[x], usable: (x) => x !== "a/p" || signedIn,
    events: { onFallback: () => {} } });
  assert.equal(r.route({ reason: "user", thinkingLevel: "low" }).model.id, "f");
  signedIn = true; // the primary signs in: it is used again at once
  assert.equal(r.route({ reason: "user", thinkingLevel: "low" }).model.id, "p");
  // A broken check never blocks routing.
  const broken = createRouter({ primary: "a/p", fallbacks: ["b/f"], resolve: (x) => models[x], usable: () => { throw new Error("x"); }, events: { onFallback: () => {} } });
  assert.equal(broken.route({ reason: "user", thinkingLevel: "low" }).model.id, "p");
});

test("a provider content-filter refusal (HTTP 400 naming a content-inspection code) is a fall-through cause, never a bench", () => {
  const refusal = '400: {"code":"data_inspection_failed","message":"Input text data may contain inappropriate content.","type":"data_inspection_failed"}';
  assert.ok(isContentFilter(refusal));
  assert.ok(isExhaustion(err(refusal)));
  assert.ok(!isOutage(err(refusal)));
  assert.equal(cooldownMs(refusal), 0);
  for (const message of ["HTTP 400: messages must not be empty", "400 context length exceeded", "data_inspection_failed without a status"]) {
    assert.ok(!isContentFilter(message), message);
  }
  assert.ok(!isExhaustion(err("HTTP 400: messages must not be empty")));
});

test("router: a content-filter refusal before output moves the turn to the next model and benches neither", () => {
  const models: Record<string, any> = { "a/p": { provider: "a", id: "p" }, "b/f": { provider: "b", id: "f" } };
  const fell: string[] = [];
  const r = createRouter({ primary: "a/p", fallbacks: ["b/f"], resolve: (x) => models[x], events: { onFallback: (from, to) => fell.push(`${from}->${to}`) } });
  const refusal = '400 {"error":{"code":"data_inspection_failed"}}';
  assert.equal(r.route({ reason: "retry", thinkingLevel: "low", failed: { model: models["a/p"], message: err(refusal) } }).model.id, "f");
  assert.deepEqual(fell, ["a/p->b/f"]);
  assert.equal(r.route({ reason: "user", thinkingLevel: "low" }).model.id, "p", "the primary is not benched by an input refusal");
});

test("router: a content-filter refusal after output never switches models mid-turn", () => {
  const models: Record<string, any> = { "a/p": { provider: "a", id: "p" }, "b/f": { provider: "b", id: "f" } };
  const fell: string[] = [];
  const r = createRouter({ primary: "a/p", fallbacks: ["b/f"], resolve: (x) => models[x], events: { onFallback: (from, to) => fell.push(`${from}->${to}`) } });
  const partial = { ...err('400 {"code":"content_policy_violation"}'), content: [{ type: "text", text: "partial answer" }] };
  assert.equal(r.route({ reason: "retry", thinkingLevel: "low", failed: { model: models["a/p"], message: partial } }).model.id, "p");
  assert.deepEqual(fell, []);
});
