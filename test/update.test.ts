// Self-update: version compare, install detection, a full release install against a fake GitHub, rollback and pruning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksEnabled, detectInstall, install, isNewer, latestRelease, prune, repoSlug, rollback } from "../src/update.ts";
import { PI_PRIVATE_ENV, CLAUDE_PRIVATE_ENV } from "../src/privacy.ts";

test("versions compare as x.y.z", () => {
  assert.ok(isNewer("0.10.0", "0.9.3"));
  assert.ok(isNewer("v1.0.0", "0.99.99"));
  assert.ok(!isNewer("0.9.3", "0.9.3"));
  assert.ok(!isNewer("0.9.2", "0.9.3"));
});

test("the update source comes from package.json, not a built-in host", () => {
  assert.match(repoSlug(), /^[\w.-]+\/[\w.-]+$/);
  const dir = mkdtempSync(join(tmpdir(), "carl-upd-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ repository: { url: "https://example.com/x.git" } }));
    assert.throws(() => repoSlug(dir), /not a GitHub repository/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("checks can be turned off by config or CARL_OFFLINE", () => {
  assert.equal(checksEnabled({ update: { check: true, auto: false } }, {}), true);
  assert.equal(checksEnabled({ update: { check: false, auto: false } }, {}), false);
  assert.equal(checksEnabled({ update: { check: true, auto: false } }, { CARL_OFFLINE: "1" }), false);
});

test("private defaults: the Pi SDK is offline with telemetry off, and the Claude CLI sends no telemetry", () => {
  assert.equal(process.env.PI_OFFLINE, PI_PRIVATE_ENV.PI_OFFLINE);
  assert.equal(PI_PRIVATE_ENV.PI_TELEMETRY, "0");
  for (const k of ["DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) assert.equal((CLAUDE_PRIVATE_ENV as any)[k], "1");
  const src = readFileSync(new URL("../src/providers/claude-code.ts", import.meta.url), "utf8");
  assert.match(src, /\.\.\.CLAUDE_PRIVATE_ENV/);
  const brain = readFileSync(new URL("../src/brain.ts", import.meta.url), "utf8");
  assert.equal(brain.match(/SettingsManager\.inMemory\(/g)?.length, brain.match(/SettingsManager\.inMemory\(\{ enableInstallTelemetry: false/g)?.length, "every SDK settings object turns attribution off");
});

/** A release tarball whose bin/carl prints its version and whose lockfile has no dependencies (npm ci runs offline). */
function tarball(version: string): Buffer {
  const src = mkdtempSync(join(tmpdir(), "carl-upd-src-"));
  try {
    const top = join(src, "carl-abc");
    mkdirSync(join(top, "bin"), { recursive: true });
    writeFileSync(join(top, "package.json"), JSON.stringify({ name: "carl-gateway", version, repository: { url: "git+https://github.com/o/r.git" } }));
    writeFileSync(join(top, "package-lock.json"), JSON.stringify({ name: "carl-gateway", version, lockfileVersion: 3, requires: true, packages: { "": { name: "carl-gateway", version } } }));
    writeFileSync(join(top, "bin", "carl"), `#!/bin/sh\necho "${version} (test)"\n`);
    chmodSync(join(top, "bin", "carl"), 0o755);
    return spawnSync("/usr/bin/tar", ["-czf", "-", "-C", src, "carl-abc"]).stdout;
  } finally { rmSync(src, { recursive: true, force: true }); }
}

test("a release install unpacks beside the current release, swaps the link, keeps one rollback and prunes the rest", async () => {
  const sha = "a".repeat(40);
  const tgz = tarball("9.9.9");
  const server = createServer((q, r) => {
    if (q.url === "/repos/o/r/releases/latest") return r.end(JSON.stringify({ tag_name: "v9.9.9", body: "- new things", html_url: "https://github.com/o/r/releases/v9.9.9" }));
    if (q.url === "/repos/o/r/commits/v9.9.9") return r.end(sha);
    if (q.url === `/o/r/tar.gz/${sha}`) return r.end(tgz);
    r.statusCode = 404; r.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.CARL_UPDATE_API = base;
  process.env.CARL_UPDATE_CODELOAD = base;
  const app = realpathSync(mkdtempSync(join(tmpdir(), "carl-upd-app-")));
  try {
    const old = join(app, "release-0.9.3-c266fb42874e");
    const stale = join(app, "release-0.9.1-000000000000");
    const bundled = join(app, "bundled-0.4.4-ad0dc5973089");
    for (const d of [old, stale, bundled]) mkdirSync(join(d, "bin"), { recursive: true });
    symlinkSync(process.execPath, join(old, "node"));
    symlinkSync(old, join(app, "current"));
    symlinkSync(old, join(app, "other-current"));
    const inst = detectInstall(old, join(app, "current", "bin", "carl"));
    assert.equal(inst.kind, "release");
    const rel = await latestRelease("o/r");
    assert.equal(rel.version, "9.9.9");
    const done = await install(rel, inst, "o/r");
    assert.equal(done.to, "9.9.9");
    const target = join(app, `release-9.9.9-${sha.slice(0, 12)}`);
    assert.equal(readlinkSync(join(app, "current")), target);
    assert.equal(readlinkSync(join(app, "current.previous")), old);
    assert.equal(readlinkSync(join(target, "node")), process.execPath, "the release's runtime link carries over");
    assert.equal(readFileSync(join(target, "COMMIT"), "utf8").trim(), sha);
    assert.ok(existsSync(old), "the previous release is kept for rollback");
    assert.ok(!existsSync(stale), "an unlinked old release is removed");
    assert.ok(existsSync(bundled), "folders Carl did not create are never touched");
    assert.equal(readlinkSync(join(app, "other-current")), old, "another link on the same release is left alone");
    // Roll back: the links trade places.
    const back = rollback(detectInstall(target, join(app, "current", "bin", "carl")));
    assert.equal(back, old);
    assert.equal(readlinkSync(join(app, "current")), old);
    assert.equal(readlinkSync(join(app, "current.previous")), target);
    assert.deepEqual(prune(app), []);
  } finally {
    delete process.env.CARL_UPDATE_API;
    delete process.env.CARL_UPDATE_CODELOAD;
    server.close();
    rmSync(app, { recursive: true, force: true });
  }
});

test("a release whose tarball holds another version is refused and nothing is switched", async () => {
  const sha = "b".repeat(40);
  const tgz = tarball("1.2.3");
  const server = createServer((q, r) => {
    if (q.url === "/repos/o/r/commits/v9.9.9") return r.end(sha);
    if (q.url === `/o/r/tar.gz/${sha}`) return r.end(tgz);
    r.statusCode = 404; r.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.CARL_UPDATE_API = base;
  process.env.CARL_UPDATE_CODELOAD = base;
  const app = realpathSync(mkdtempSync(join(tmpdir(), "carl-upd-app-")));
  try {
    const old = join(app, "release-0.9.3-c266fb42874e");
    mkdirSync(old);
    symlinkSync(old, join(app, "current"));
    const inst = detectInstall(old, join(app, "current", "bin", "carl"));
    await assert.rejects(install({ tag: "v9.9.9", version: "9.9.9", notes: "", url: "" }, inst, "o/r"), /contains version 1\.2\.3; nothing was switched/);
    assert.equal(readlinkSync(join(app, "current")), old);
  } finally {
    delete process.env.CARL_UPDATE_API;
    delete process.env.CARL_UPDATE_CODELOAD;
    server.close();
    rmSync(app, { recursive: true, force: true });
  }
});

test("an install that is neither a release link nor a git checkout says how to reinstall", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-upd-x-"));
  try {
    const inst = detectInstall(dir, undefined);
    assert.equal(inst.kind, "other");
    await assert.rejects(install({ tag: "v9.9.9", version: "9.9.9", notes: "", url: "" }, inst, "o/r"), /cannot update in place.*Reinstall from https:\/\/github.com\/o\/r/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PI_OFFLINE=0 lets an operator put the SDK online; any other value or none keeps it offline", async () => {
  const { applyPrivateDefaults } = await import("../src/privacy.ts");
  const a: NodeJS.ProcessEnv = { PI_OFFLINE: "0" };
  applyPrivateDefaults(a);
  assert.equal(a.PI_OFFLINE, undefined);
  assert.equal(a.PI_TELEMETRY, "0");
  const b: NodeJS.ProcessEnv = {};
  applyPrivateDefaults(b);
  assert.equal(b.PI_OFFLINE, "1");
  const c: NodeJS.ProcessEnv = { PI_TELEMETRY: "1" };
  applyPrivateDefaults(c);
  assert.equal(c.PI_TELEMETRY, "1", "an explicit opt-in is respected");
});

test("a second link on the same app folder shares a release the first already installed", async () => {
  const sha = "c".repeat(40);
  const server = createServer((q, r) => {
    if (q.url === "/repos/o/r/commits/v9.9.9") return r.end(sha);
    r.statusCode = 404; r.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  process.env.CARL_UPDATE_API = `http://127.0.0.1:${(server.address() as any).port}`;
  const app = realpathSync(mkdtempSync(join(tmpdir(), "carl-upd-app-")));
  try {
    const old = join(app, "release-0.9.3-c266fb42874e");
    const next = join(app, `release-9.9.9-${sha.slice(0, 12)}`);
    mkdirSync(old); mkdirSync(next);
    writeFileSync(join(next, "COMMIT"), sha);
    symlinkSync(next, join(app, "current"));
    symlinkSync(old, join(app, "second"));
    const done = await install({ tag: "v9.9.9", version: "9.9.9", notes: "", url: "" }, detectInstall(old, join(app, "second", "bin", "carl")), "o/r");
    assert.equal(done.path, next);
    assert.equal(readlinkSync(join(app, "second")), next);
    assert.equal(readlinkSync(join(app, "second.previous")), old);
  } finally {
    delete process.env.CARL_UPDATE_API;
    server.close();
    rmSync(app, { recursive: true, force: true });
  }
});
