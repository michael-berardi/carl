import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerTerra, TERRA_MODEL } from "../src/providers/terra.ts";

test("Terra survives reload without retaining removed overlays and keeps native OAuth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-terra-reload-"));
  const modelsPath = join(dir, "models.json"), authPath = join(dir, "auth.json");
  const token = "synthetic-oauth-access";
  const custom = { id: TERRA_MODEL.id, name: "Custom Terra", contextWindow: 12345, maxTokens: 1024 };
  const writeModels = (config: object) => writeFileSync(modelsPath, JSON.stringify(config));
  writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "synthetic-refresh", expires: Date.now() + 3600000, accountId: "test-account" } }));
  writeModels({ providers: { "openai-codex": { apiKey: "stale-key", headers: { "X-Test": "stale-header" }, models: [custom, { ...custom, id: "stale-custom-model" }] } } });
  try {
    const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
    await registerTerra(runtime);
    assert.equal(runtime.getModel("openai-codex", TERRA_MODEL.id)?.name, "Custom Terra");
    assert.equal(runtime.getProvider("openai-codex")?.auth.oauth?.isSubscription, true);
    assert.equal(typeof runtime.getProvider("openai-codex")?.auth.oauth?.login, "function");
    assert.equal(typeof runtime.getProvider("openai-codex")?.auth.oauth?.refresh, "function");
    writeModels({});
    await runtime.refresh({ allowNetwork: false });
    assert.deepEqual(runtime.getModel("openai-codex", TERRA_MODEL.id), TERRA_MODEL);
    assert.equal(runtime.getModel("openai-codex", "stale-custom-model"), undefined);
    assert.equal(runtime.getProvider("openai-codex")?.auth.apiKey, undefined);
    const auth = await runtime.getAuth(TERRA_MODEL);
    assert.equal(auth?.auth.apiKey, token);
    assert.equal(runtime.isUsingOAuth("openai-codex"), true);
    assert.equal(runtime.isUsingSubscription("openai-codex"), true);
    assert.notEqual(auth?.auth.headers?.["X-Test"], "stale-header");
    writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "replacement-oauth-access", refresh: "replacement-refresh", expires: Date.now() + 3600000, accountId: "test-account" } }));
    await runtime.refresh({ allowNetwork: false });
    assert.equal((await runtime.getAuth(TERRA_MODEL))?.auth.apiKey, "replacement-oauth-access");
    writeFileSync(authPath, "{}");
    await runtime.refresh({ allowNetwork: false });
    assert.notEqual((await runtime.getAuth(TERRA_MODEL))?.auth.apiKey, "replacement-oauth-access");
    assert.equal(runtime.isUsingOAuth("openai-codex"), false);
    assert.equal(runtime.isUsingSubscription("openai-codex"), false);
    writeModels({ providers: { "openai-codex": { modelOverrides: { [TERRA_MODEL.id]: { contextWindow: 90000, maxTokens: 2048 } } } } });
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("openai-codex", TERRA_MODEL.id)?.contextWindow, 90000);
    assert.equal(runtime.getModel("openai-codex", TERRA_MODEL.id)?.maxTokens, 2048);
    writeModels({ providers: { "openai-codex": { models: [{ ...custom, name: "Reloaded Terra" }] } } });
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("openai-codex", TERRA_MODEL.id)?.name, "Reloaded Terra");
    writeModels({});
    await runtime.refresh({ allowNetwork: false });
    assert.deepEqual(runtime.getModel("openai-codex", TERRA_MODEL.id), TERRA_MODEL);
    await registerTerra(runtime);
    assert.equal(runtime.getModels().filter((m) => m.provider === "openai-codex" && m.id === TERRA_MODEL.id).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
