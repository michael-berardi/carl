import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createRouter } from "../src/router.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const err = (errorMessage: string) => ({ stopReason: "error" as const, errorMessage, content: [] });

function homeWith(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "carl-metered-"));
  writeFileSync(join(home, "carl.json"), JSON.stringify(config));
  return home;
}

test("meteredFallbackModels defaults to none and names models of the chain", () => {
  const plain = homeWith({ model: "provider-a/plan-model", fallbackModels: ["provider-b/metered-model"] });
  try {
    assert.deepEqual(loadConfig(plain).meteredFallbackModels, [], "a file without the key behaves as before");
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
  const marked = homeWith({ model: "provider-a/plan-model", fallbackModels: ["provider-b/metered-model"],
    meteredFallbackModels: ["provider-b/metered-model"] });
  try {
    assert.deepEqual(loadConfig(marked).meteredFallbackModels, ["provider-b/metered-model"]);
  } finally {
    rmSync(marked, { recursive: true, force: true });
  }
});

test("a metered model that is not in the chain is a named config error, not a silent no-op", () => {
  const home = homeWith({ model: "provider-a/plan-model", fallbackModels: [], meteredFallbackModels: ["provider-b/metered-model"] });
  try {
    assert.throws(() => loadConfig(home), (e: unknown) => e instanceof ConfigError
      && /meteredFallbackModels names "provider-b\/metered-model", which is not in "model" or "fallbackModels"/.test((e as Error).message));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const primaryMetered = homeWith({ model: "provider-a/metered-model", meteredFallbackModels: ["provider-a/metered-model"] });
  try {
    assert.deepEqual(loadConfig(primaryMetered).meteredFallbackModels, ["provider-a/metered-model"], "the primary may be the metered one");
  } finally {
    rmSync(primaryMetered, { recursive: true, force: true });
  }
});

test("doctor warns without failing when no model in the chain is pay-per-use, and labels a metered login", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-metered-doctor-"));
  try {
    const run = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "doctor"], {
      env: { PATH: process.env.PATH, HOME: home, CARL_HOME: home, CARL_OFFLINE: "1" }, encoding: "utf8", timeout: 60000,
    });
    const file = join(home, "carl.json");
    writeFileSync(file, JSON.stringify({ model: "provider-a/plan-model", fallbackModels: ["provider-b/plan-model"] }));
    const plansOnly = run();
    assert.match(plansOnly.stdout, /^warn  fallbacks: every model is a subscription plan; when all are used up Carl stops answering\. Add a pay-per-use fallback last \(`carl login <provider> --api-key`\)/m);
    assert.doesNotMatch(plansOnly.stdout, /pay-per-use\)/);

    writeFileSync(file, JSON.stringify({ model: "provider-a/plan-model", fallbackModels: ["provider-b/metered-model"],
      meteredFallbackModels: ["provider-b/metered-model"] }));
    const metered = run();
    assert.doesNotMatch(metered.stdout, /every model is a subscription plan/);
    assert.match(metered.stdout, /^warn  login provider-b \(pay-per-use\): no credentials for provider-b/m, "each fallback's login state is reported");
    assert.equal(metered.status, 1, "the missing primary login still fails the check; the fallback warning never does");
    assert.match(metered.stdout, /^FAIL  login provider-a: /m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("init prints the plan-first, pay-per-use-last recommendation as step 3b and seeds meteredFallbackModels", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-metered-init-"));
  try {
    const init = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "init"], {
      env: { PATH: process.env.PATH, HOME: home, CARL_HOME: home }, encoding: "utf8", timeout: 60000,
    });
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /^  3b\. Recommended: plan first, pay-per-use last\./m);
    assert.match(init.stdout, /carl login <provider> --api-key/);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "carl.json"), "utf8")).meteredFallbackModels, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("router event: a turn handed to a metered fallback says so; a plan fallback does not", () => {
  const models: Record<string, any> = { "a/p": { provider: "a", id: "p" }, "b/plan": { provider: "b", id: "plan" }, "c/metered": { provider: "c", id: "metered" } };
  const events: Array<{ from: string; to: string; metered: boolean }> = [];
  const onFallback = (from: string, to: string, _reason: string, _until: number, metered: boolean) => events.push({ from, to, metered });
  const r = createRouter({ primary: "a/p", fallbacks: ["b/plan", "c/metered"], resolve: (x) => models[x],
    metered: (x) => x === "c/metered", events: { onFallback } });
  const retry = (model: any) => ({ reason: "retry", thinkingLevel: "low", failed: { model, message: err("HTTP 429 usage limit, resets in 1h") } });
  assert.equal(r.route(retry(models["a/p"])).model.id, "plan");
  assert.equal(events.at(-1)?.metered, false, "a plan fallback is not metered");
  // The plan is now benched too: the next failure moves the work to the metered model, flagged as paid.
  assert.equal(r.route(retry(models["b/plan"])).model.id, "metered");
  assert.deepEqual(events.at(-1), { from: "b/plan", to: "c/metered", metered: true });
});
