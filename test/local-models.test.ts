// Local models managed by an external local-model manager (a `local` provider on a loopback llama-server, leased on
// demand). Carl must (1) load a TypeScript Pi extension that imports sibling modules outside its own folder,
// (2) move a turn to the next fallback when the local server is dead or refuses to start, and (3) report in `carl doctor`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Brain } from "../src/brain.ts";
import { ensureHome, loadConfig } from "../src/config.ts";
import { Psyche } from "../src/psyche.ts";
import { cooldownMs, isExhaustion, isLocalUnavailable, isOutage } from "../src/router.ts";

const faux = registerFauxProvider({ provider: "local", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_000 }] });
const modelDef = (id: string) => ({ id, name: id, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 });

const REFUSED = "steak-pi local: REFUSED (on-hold): the local model is on hold until 18:00";
const err = (errorMessage: string) => ({ stopReason: "error" as const, errorMessage });

test("a loopback connection failure or a local-manager refusal is a named outage; other errors are not", () => {
  for (const code of ["on-hold", "quiet-day", "insufficient-memory", "other-server", "some-future-cause"])
    assert.ok(isLocalUnavailable(`steak-pi local: REFUSED (${code}): detail`), code);
  assert.ok(isLocalUnavailable("Connection error. (connect ECONNREFUSED 127.0.0.1:8123)"));
  assert.ok(isLocalUnavailable("fetch failed: connect ECONNREFUSED ::1:8123"));
  assert.ok(isLocalUnavailable("Connection error.", "http://localhost:8123/v1"));
  assert.ok(!isLocalUnavailable("Connection error.", "https://api.example.com/v1"), "a remote bare connection error is unknown");
  assert.ok(!isLocalUnavailable("connect ECONNREFUSED 203.0.113.5:443"), "a remote refusal is not a local-server outage");
  assert.ok(!isLocalUnavailable("connect ECONNREFUSED 2001:db8::1:443"), "::1 at the end of a remote IPv6 address is not loopback");
  assert.ok(!isLocalUnavailable("connect ECONNREFUSED 203.0.113.5:443 (via proxy localhost)"), "a loopback word later on the line is not the refused address");
  assert.ok(isLocalUnavailable("request to http://127.0.0.1:8089/v1 failed, reason: connect ECONNREFUSED 127.0.0.1:8089"));
  assert.ok(!isLocalUnavailable("401 invalid api key"));
  assert.ok(isExhaustion(err(REFUSED)) && isOutage(err(REFUSED)));
  assert.ok(isExhaustion(err("connect ECONNREFUSED 127.0.0.1:8123")));
  assert.ok(!isExhaustion(err("401 invalid api key")));
  assert.equal(cooldownMs(REFUSED), 2 * 60_000, "benched briefly");
  assert.equal(cooldownMs("connect ECONNREFUSED 127.0.0.1:8123"), 2 * 60_000);
});

function home(opts: { link?: boolean } = {}): { carl: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "carl-local-"));
  const carl = join(root, "carl"), agentDir = join(root, "agent"), pkg = join(root, "manager");
  mkdirSync(carl); mkdirSync(agentDir); mkdirSync(join(pkg, "extensions", "local"), { recursive: true }); mkdirSync(join(pkg, "src"));
  // Stand-in for the manager's extension: a .ts file importing a .ts module two levels up, as the real one does.
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "manager", type: "module" }));
  writeFileSync(join(pkg, "src", "marker.ts"), `export const mark = (n: string): string => "loaded:" + n;\n`);
  writeFileSync(join(pkg, "extensions", "local", "index.ts"), [
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
    `import { writeFileSync } from "node:fs";`,
    `import { mark } from "../../src/marker.ts";`,
    `export default function (pi: ExtensionAPI): void {`,
    `  pi.on("agent_start", async () => { writeFileSync(${JSON.stringify(join(root, "ran"))}, mark("ext")); });`,
    `}`, ``].join("\n"));
  if (opts.link) symlinkSync(join(pkg, "extensions", "local", "index.ts"), join(root, "ext-link.ts"));
  writeFileSync(join(carl, "carl.json"), JSON.stringify({
    model: "local/my-model", fallbackModels: ["plan-b/model-y"],
    extensions: [opts.link ? join(root, "ext-link.ts") : join(pkg, "extensions", "local", "index.ts")],
    modelsPath: join(agentDir, "models.json"),
    agentDir, thinking: "medium", tools: [], claude: { enabled: false },
    ultracompress: "off", telegram: { enabled: false }, api: { enabled: false },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    local: { api: faux.api, baseUrl: "http://127.0.0.1:9/v1", apiKey: "local", models: [modelDef("my-model")] },
    "plan-b": { api: faux.api, baseUrl: "http://127.0.0.1:9", apiKey: "test", models: [modelDef("model-y")] },
  } }));
  return { carl, root };
}

async function start(t: any, carl: string) {
  const cfg = loadConfig(carl);
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home);
  psyche.seed();
  const errors: any[] = [], warnings: any[] = [];
  const log = { info: () => {}, debug: () => {}, error: (m: string, d?: unknown) => errors.push({ m, d }), warn: (m: string, d?: unknown) => warnings.push({ m, d }) };
  const brain = new Brain(cfg, psyche, log as any, () => []);
  const fallbacks: any[] = [];
  brain.on("fallback", (e) => fallbacks.push(e));
  await brain.init();
  t.after(() => brain.shutdown());
  return { brain, errors, warnings, fallbacks };
}

test("a TypeScript extension that imports modules outside its folder loads through `extensions`", async (t) => {
  const { carl, root } = home();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { brain, errors } = await start(t, carl);
  faux.setResponses([fauxAssistantMessage(fauxText("hi"))]);
  const r = await brain.ask("cli:local-ext", { text: "hello", source: "cli" });
  assert.ok(r.ok, r.error);
  assert.deepEqual(errors, [], "no extension load error");
  assert.ok(existsSync(join(root, "ran")), "the extension's agent_start handler ran");
  assert.equal(readFileSync(join(root, "ran"), "utf8"), "loaded:ext");
  // The modules the extension imports are code Carl loads: the whole package is protected from the agent, not only the entry file.
  const protectedPaths: string[] = (brain as any).controlPlane();
  assert.ok(protectedPaths.some((p) => p === join(root, "manager") || p.endsWith("/manager")), "the extension's package folder is protected");
});

test("an extension listed through a symlink protects the package its target sits in", async (t) => {
  const { carl, root } = home({ link: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { brain } = await start(t, carl);
  const protectedPaths: string[] = (brain as any).controlPlane();
  const real = realpathSync(join(root, "manager"));
  assert.ok(protectedPaths.includes(real), "the target's package folder is protected");
});

for (const [name, message] of [
  ["a dead loopback server", "Connection error. (connect ECONNREFUSED 127.0.0.1:8123)"],
  ["a bare connection error from a loopback baseUrl", "Connection error."],
  ["a manager refusal", REFUSED],
] as const) {
  test(`${name} moves the turn to the next fallback, names the cause and benches the local model`, async (t) => {
    const { carl, root } = home();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { brain, warnings, fallbacks } = await start(t, carl);
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: message }),
      fauxAssistantMessage(fauxText("FALLBACK-OK")),
    ]);
    const r = await brain.ask("cli:local-down", { text: "hello", source: "cli" });
    assert.ok(r.ok, r.error);
    assert.match(r.text, /FALLBACK-OK/);
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].from, "local/my-model");
    assert.equal(fallbacks[0].to, "plan-b/model-y");
    assert.ok(fallbacks[0].until - Date.now() <= 2 * 60_000 + 1000 && fallbacks[0].until > Date.now(), "benched briefly");
    assert.ok(warnings.some((w) => /fallback chain/.test(w.m) && /ECONNREFUSED|REFUSED \(on-hold\)|local server at http:\/\/127\.0\.0\.1:9\/v1 is not answering/.test(JSON.stringify(w.d))), "the log names the cause");
    const before = faux.state.callCount;
    faux.setResponses([fauxAssistantMessage(fauxText("second"))]);
    const second = await brain.ask("cli:local-down", { text: "again", source: "cli" });
    assert.match(second.text, /second/);
    assert.equal(faux.state.callCount - before, 1, "the benched local model was not called again");
  });
}

import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyLocalCheck } from "../src/local-check.ts";

test("the local check classifier names fits, refusals, unknown ids, a missing manager and a timeout", () => {
  assert.deepEqual(classifyLocalCheck("my-model", { status: 0, stdout: "ok: local/my-model fits (needs 5.0 GiB, 12.0 GiB free)\n" }),
    { ok: true, detail: "local/my-model fits (needs 5.0 GiB, 12.0 GiB free)" });
  const refused = classifyLocalCheck("my-model", { status: 3, stderr: "steak-pi local: REFUSED (insufficient-memory): needs 5 GiB\n" });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /REFUSED \(insufficient-memory\).*fall through to fallbackModels/);
  assert.match(classifyLocalCheck("my-model", { status: 1, stderr: "steak-pi local: REFUSED (unknown-model): no profile\n" }).detail, /unknown-model.*steak-pi local add/);
  const crash = classifyLocalCheck("my-model", { status: 1, stderr: "steak-pi local: Cannot read properties of undefined\n" });
  assert.doesNotMatch(crash.detail, /steak-pi local add/, "a crash is not called an unknown model");
  assert.match(crash.detail, /failed: steak-pi local: Cannot read/);
  assert.match(classifyLocalCheck("my-model", { status: null, error: Object.assign(new Error("spawn steak-pi ENOENT"), { code: "ENOENT" }) }).detail, /not on PATH.*install Steak Pi/);
  assert.match(classifyLocalCheck("my-model", { status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }).detail, /did not answer/);
});

test("doctor reports what the local manager says for a local model, and warns when the manager is missing", (t) => {
  const { carl, root } = home();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const node = join(root, "nodebin");
  mkdirSync(node);
  const run = (path: string) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "doctor"], {
    env: { PATH: path, HOME: root, CARL_HOME: carl, CARL_OFFLINE: "1" }, encoding: "utf8", timeout: 60_000, cwd: root });
  const missing = run(node);
  assert.match(missing.stdout, /^warn  local local\/my-model: `steak-pi` is not on PATH.*install Steak Pi/m, missing.stdout + missing.stderr);
  const fake = (body: string) => { writeFileSync(join(bin, "steak-pi"), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, "steak-pi"), 0o755); };
  fake(`[ "$1 $2 $3" = "local check my-model" ] || exit 9\necho "ok: local/my-model fits (needs 5.0 GiB, 12.0 GiB free)"`);
  const fits = run(`${bin}:${node}`);
  assert.match(fits.stdout, /^ok    local local\/my-model: local\/my-model fits/m, fits.stdout);
  fake(`echo "steak-pi local: REFUSED (on-hold): held until 18:00" >&2\nexit 3`);
  const held = run(`${bin}:${node}`);
  assert.match(held.stdout, /^warn  local local\/my-model: steak-pi local: REFUSED \(on-hold\): held until 18:00; turns fall through/m, held.stdout);
  assert.doesNotMatch(held.stdout, /^FAIL  login local/m, held.stdout);
});
