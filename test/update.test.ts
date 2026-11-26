// Self-update: version compare, install detection, a full release install against a fake GitHub, rollback and pruning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksEnabled, detectInstall, install, isNewer, latestRelease, prune, repoSlug, rollback, UpdateError } from "../src/update.ts";
import { PI_PRIVATE_ENV, CLAUDE_PRIVATE_ENV } from "../src/privacy.ts";
import { VERSION } from "../src/version.ts";

/** Direct dependencies and shipped source must never gain a tracker package or a telemetry endpoint. */
const TRACKER_PACKAGE = /(?:^|\/)(?:@[^/]+\/)?[^/]*(?:telemetry|analytics|sentry|posthog|segment|mixpanel|amplitude|bugsnag|datadog|hotjar|plausible|umami|gtag)[^/]*$/i;
const TRACKER_ENDPOINT = /(?:report-install|latest-version|sentry\.io|api\.posthog\.com|api\.segment\.com|api\.mixpanel\.com|api\.amplitude\.com|bugsnag\.com|google-analytics\.com|googletagmanager\.com)/i;

function shippedSources(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? shippedSources(new URL(`${e.name}/`, dir)) : /\.(ts|js|mjs|sh)$/.test(e.name) ? [new URL(e.name, dir)] : []);
}

test("no telemetry package or endpoint may be reintroduced", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const group of ["dependencies", "devDependencies"]) {
    assert.deepEqual(Object.keys(pkg[group] ?? {}).filter((name) => TRACKER_PACKAGE.test(name)), [], `${group} must stay free of trackers`);
  }
  const sources = [...shippedSources(new URL("../src/", import.meta.url)), ...shippedSources(new URL("../bin/", import.meta.url)), ...shippedSources(new URL("../scripts/", import.meta.url))];
  const hits = sources.flatMap((url) => readFileSync(url, "utf8").split("\n").map((line, i) => [url.pathname, i + 1, line] as const))
    .filter(([, , line]) => TRACKER_ENDPOINT.test(line))
    .map(([path, n]) => `${path}:${n}`);
  assert.deepEqual(hits, [], "Carl's shipped code must not call a telemetry endpoint");
  for (const [file, pattern] of [["../src/update.ts", /DO_NOT_TRACK: "1"/], ["../scripts/install.sh", /DO_NOT_TRACK=1/]] as const) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), pattern, `${file} must keep dependency telemetry off`);
  }
});

test("the release check carries no identifier", async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((q, r) => {
    seen.push(q.headers as Record<string, string | string[] | undefined>);
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ tag_name: "v9.9.9" }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const previous = process.env.CARL_UPDATE_API;
  process.env.CARL_UPDATE_API = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await latestRelease("o/r");
    assert.equal(seen.length, 1);
    const h = seen[0];
    assert.equal(h["user-agent"], "carl-update-check");
    assert.equal(h.accept, "application/vnd.github+json");
    assert.ok(!h.authorization && !h.cookie, "no credentials are sent");
    assert.deepEqual(Object.keys(h).filter((k) => /^(x-|authorization|cookie|from|referer)/i.test(k)), [], "no identifying headers");
    assert.ok(!JSON.stringify(h).includes(VERSION), "the running version is not sent");
  } finally {
    if (previous === undefined) delete process.env.CARL_UPDATE_API;
    else process.env.CARL_UPDATE_API = previous;
    server.close();
  }
});

test("the README Privacy section stays short and PRIVACY.md carries the detail", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = /\n## Privacy\n([\s\S]*?)\n## /.exec(readme)?.[1] ?? "";
  const lines = section.split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 3 && lines.length <= 6, `README Privacy has ${lines.length} non-empty lines; keep 3 to 6`);
  assert.match(section, /No telemetry/);
  assert.match(section, /once a day/i);
  assert.match(section, /CARL_NO_UPDATE_CHECK=1/);
  assert.match(section, /\[PRIVACY\.md\]\(PRIVACY\.md\)/);
  const privacy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
  for (const detail of ["no install ID", "DO_NOT_TRACK=1", "PI_OFFLINE=1", "User-Agent: carl-update-check", "CARL_OFFLINE=1",
    "0600 files in 0700 directories", "~/.ultraterm/logs/ultrabot-messages", "local storage", "update-check.json", "auto-update.log"]) {
    assert.ok(privacy.includes(detail), `PRIVACY.md must state ${detail}`);
  }
});

// Every fixture uses its own cache so a fake release never leaks into another run or into the real cache dir.
process.env.CARL_UPDATE_CACHE_DIR = mkdtempSync(join(tmpdir(), "carl-upd-cache-"));
process.on("exit", () => rmSync(process.env.CARL_UPDATE_CACHE_DIR!, { recursive: true, force: true }));

test("versions compare as x.y.z", () => {
  assert.ok(isNewer("0.10.0", "0.9.3"));
  assert.ok(isNewer("v1.0.0", "0.99.99"));
  assert.ok(!isNewer("0.9.3", "0.9.3"));
  assert.ok(!isNewer("0.9.2", "0.9.3"));
  assert.ok(!isNewer("v1.2.3-rc.1", "0.9.3"), "prereleases are not newer");
});

test("the update source comes from package.json, not a built-in host", () => {
  assert.match(repoSlug(), /^[\w.-]+\/[\w.-]+$/);
  const dir = mkdtempSync(join(tmpdir(), "carl-upd-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ repository: { url: "https://example.com/x.git" } }));
    assert.throws(() => repoSlug(dir), /not a GitHub repository/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("checks can be turned off by config, CARL_OFFLINE or CARL_NO_UPDATE_CHECK", () => {
  assert.equal(checksEnabled({ update: { check: true, auto: false } }, {}), true);
  assert.equal(checksEnabled({ update: { check: false, auto: false } }, {}), false);
  assert.equal(checksEnabled({ update: { check: true, auto: false } }, { CARL_OFFLINE: "1" }), false);
  assert.equal(checksEnabled({ update: { check: true, auto: false } }, { CARL_NO_UPDATE_CHECK: "1" }), false);
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

/** A release bundle laid out like scripts/build-release.sh makes it (files at the root): bin/carl prints its version and the lockfile has no dependencies (npm ci runs offline). */
function tarball(version: string): Buffer {
  const src = mkdtempSync(join(tmpdir(), "carl-upd-src-"));
  try {
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "carl-gateway", version, repository: { url: "git+https://github.com/o/r.git" } }));
    writeFileSync(join(src, "package-lock.json"), JSON.stringify({ name: "carl-gateway", version, lockfileVersion: 3, requires: true, packages: { "": { name: "carl-gateway", version } } }));
    writeFileSync(join(src, "bin", "carl"), `#!/bin/sh\necho "${version} (test)"\n`);
    chmodSync(join(src, "bin", "carl"), 0o755);
    return spawnSync("/usr/bin/tar", ["-czf", "-", "-C", src, "package.json", "package-lock.json", "bin"]).stdout;
  } finally { rmSync(src, { recursive: true, force: true }); }
}

/** The release assets of tag v9.9.9 as GitHub serves them: SHA256SUMS and carl.tar.gz. */
function asset(url: string | undefined, tgz: Buffer): Buffer | string | undefined {
  if (url === "/o/r/releases/download/v9.9.9/SHA256SUMS") return `${createHash("sha256").update(tgz).digest("hex")}  carl.tar.gz\n`;
  if (url === "/o/r/releases/download/v9.9.9/carl.tar.gz") return tgz;
  return undefined;
}

test("a release install unpacks beside the current release, swaps the link, keeps one rollback and prunes the rest", async () => {
  const sha = "a".repeat(40);
  const tgz = tarball("9.9.9");
  const server = createServer((q, r) => {
    if (q.url === "/repos/o/r/releases/latest") return r.end(JSON.stringify({ tag_name: "v9.9.9", body: "- new things", html_url: "https://github.com/o/r/releases/v9.9.9" }));
    if (q.url === "/repos/o/r/commits/v9.9.9") return r.end(sha);
    const file = asset(q.url, tgz);
    if (file) return r.end(file);
    r.statusCode = 404; r.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.CARL_UPDATE_API = base;
  process.env.CARL_UPDATE_DOWNLOAD = base;
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
    delete process.env.CARL_UPDATE_DOWNLOAD;
    server.close();
    rmSync(app, { recursive: true, force: true });
  }
});

test("a release whose tarball holds another version is refused and nothing is switched", async () => {
  const sha = "b".repeat(40);
  const tgz = tarball("1.2.3");
  const server = createServer((q, r) => {
    if (q.url === "/repos/o/r/commits/v9.9.9") return r.end(sha);
    const file = asset(q.url, tgz);
    if (file) return r.end(file);
    r.statusCode = 404; r.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.CARL_UPDATE_API = base;
  process.env.CARL_UPDATE_DOWNLOAD = base;
  const app = realpathSync(mkdtempSync(join(tmpdir(), "carl-upd-app-")));
  try {
    const old = join(app, "release-0.9.3-c266fb42874e");
    mkdirSync(old);
    symlinkSync(old, join(app, "current"));
    const inst = detectInstall(old, join(app, "current", "bin", "carl"));
    await assert.rejects(install({ tag: "v9.9.9", version: "9.9.9", notes: "", url: "" }, inst, "o/r"), /contains version 1\.2\.3; nothing was switched/);
    assert.equal(readlinkSync(join(app, "current")), old);
    assert.deepEqual(readdirSync(app).sort(), ["current", "release-0.9.3-c266fb42874e"], "the unpacked download is removed on failure");
  } finally {
    delete process.env.CARL_UPDATE_API;
    delete process.env.CARL_UPDATE_DOWNLOAD;
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
  assert.equal(a.DO_NOT_TRACK, "1");
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
    symlinkSync(process.execPath, join(old, "node")); // this install's runtime link; the first install made none
    symlinkSync(next, join(app, "current"));
    symlinkSync(old, join(app, "second"));
    const done = await install({ tag: "v9.9.9", version: "9.9.9", notes: "", url: "" }, detectInstall(old, join(app, "second", "bin", "carl")), "o/r");
    assert.equal(done.path, next);
    assert.equal(readlinkSync(join(next, "node")), process.execPath, "a shared release gains the runtime link it was missing");
    assert.equal(readlinkSync(join(app, "second")), next);
    assert.equal(readlinkSync(join(app, "second.previous")), old);
  } finally {
    delete process.env.CARL_UPDATE_API;
    server.close();
    rmSync(app, { recursive: true, force: true });
  }
});

function gitExec(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function writeMinimalCarl(dir: string, version: string): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "carl-gateway", version, repository: { url: "git+https://github.com/o/r.git" } }, null, 2));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "carl-gateway", version, lockfileVersion: 3, requires: true, packages: { "": { name: "carl-gateway", version } } }, null, 2));
  writeFileSync(join(dir, "bin", "carl"), `#!/bin/sh\necho "${version} (test)"\n`);
  chmodSync(join(dir, "bin", "carl"), 0o755);
}

test("git-checkout update fetches rewritten tags without clobbering and reports a recovery command on rewritten history", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "carl-upd-git-")));
  try {
    const origin = join(tmp, "origin.git");
    const upstream = join(tmp, "upstream");
    const checkout = join(tmp, "checkout");
    mkdirSync(origin);
    gitExec(origin, "init", "--bare", "-q", "-b", "main");
    gitExec(tmp, "clone", "-q", origin, upstream);
    writeMinimalCarl(upstream, "1.0.0");
    gitExec(upstream, "add", "-A");
    gitExec(upstream, "commit", "-qm", "v1.0.0");
    gitExec(upstream, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    gitExec(upstream, "push", "-q", "origin", "main", "--tags");

    gitExec(tmp, "clone", "-q", origin, checkout);
    const inst = detectInstall(checkout, undefined);
    assert.equal(inst.kind, "git");

    // Rewrite upstream history and force-move v1.0.0, then tag v1.1.0 on the rewritten line.
    writeMinimalCarl(upstream, "1.0.0");
    writeFileSync(join(upstream, "rewritten.txt"), "clean\n");
    gitExec(upstream, "add", "-A");
    gitExec(upstream, "commit", "--amend", "-qm", "v1.0.0 rewritten");
    gitExec(upstream, "tag", "-fa", "v1.0.0", "-m", "v1.0.0 rewritten");
    writeMinimalCarl(upstream, "1.1.0");
    gitExec(upstream, "add", "-A");
    gitExec(upstream, "commit", "-qm", "v1.1.0");
    gitExec(upstream, "tag", "-a", "v1.1.0", "-m", "v1.1.0");
    gitExec(upstream, "push", "-q", "--force", "origin", "main", "refs/tags/v1.0.0", "refs/tags/v1.1.0");

    await assert.rejects(
      install({ tag: "v1.1.0", version: "1.1.0", notes: "", url: "" }, inst, "o/r"),
      (err: unknown) => {
        assert.ok(err instanceof UpdateError);
        assert.doesNotMatch(err.message, /would clobber existing tag/i);
        assert.match(err.message, /history diverged or was rewritten/i);
        assert.match(err.message, /git -C .* fetch --force --tags origin && git -C .* reset --hard v1\.1\.0 && npm --prefix .* ci --omit=dev/);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("git-checkout update fast-forwards cleanly even after an older tag on origin was force-moved", async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "carl-upd-git-ff-")));
  try {
    const origin = join(tmp, "origin.git");
    const upstream = join(tmp, "upstream");
    const checkout = join(tmp, "checkout");
    mkdirSync(origin);
    gitExec(origin, "init", "--bare", "-q", "-b", "main");
    gitExec(tmp, "clone", "-q", origin, upstream);
    writeMinimalCarl(upstream, "1.0.0");
    gitExec(upstream, "add", "-A");
    gitExec(upstream, "commit", "-qm", "v1.0.0");
    gitExec(upstream, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
    gitExec(upstream, "push", "-q", "origin", "main", "--tags");

    gitExec(tmp, "clone", "-q", origin, checkout);
    const inst = detectInstall(checkout, undefined);
    assert.equal(inst.kind, "git");

    // Add a fast-forwardable v1.0.1 commit AND re-tag v1.0.0 (same commit, new tag object) so plain `git fetch --tags` would fail.
    writeMinimalCarl(upstream, "1.0.1");
    gitExec(upstream, "add", "-A");
    gitExec(upstream, "commit", "-qm", "v1.0.1");
    gitExec(upstream, "tag", "-fa", "v1.0.0", "-m", "v1.0.0 re-annotated", "HEAD~1");
    gitExec(upstream, "tag", "-a", "v1.0.1", "-m", "v1.0.1");
    gitExec(upstream, "push", "-q", "--force", "origin", "main", "refs/tags/v1.0.0", "refs/tags/v1.0.1");

    const done = await install({ tag: "v1.0.1", version: "1.0.1", notes: "", url: "" }, inst, "o/r");
    assert.equal(done.to, "1.0.1");
    assert.equal(JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version, "1.0.1");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
