// The download installer: scripts/install.sh against a fake release (no network): checksum, layout, relink, update-compatible names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstall } from "../src/update.ts";

const INSTALL = new URL("../scripts/install.sh", import.meta.url).pathname;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function fakeRelease(dir: string, version: string, tamper = false): string {
  const src = join(dir, `src-${version}`);
  mkdirSync(join(src, "bin"), { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "carl-gateway", version, dependencies: {} }, null, 2));
  writeFileSync(join(src, "package-lock.json"), JSON.stringify({ name: "carl-gateway", version, lockfileVersion: 3, requires: true, packages: { "": { name: "carl-gateway", version } } }));
  writeFileSync(join(src, "COMMIT"), COMMIT + "\n");
  writeFileSync(join(src, "bin", "carl"), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(src, "bin", "carl"), 0o755);
  const base = join(dir, `base-${version}`);
  mkdirSync(base);
  assert.equal(spawnSync("tar", ["-czf", join(base, "carl.tar.gz"), "-C", src, "."]).status, 0);
  const sum = createHash("sha256").update(readFileSync(join(base, "carl.tar.gz"))).digest("hex");
  writeFileSync(join(base, "SHA256SUMS"), `${tamper ? "0".repeat(64) : sum}  carl.tar.gz\n`);
  return base;
}

function run(base: string, home: string, bin: string) {
  const url = `file://${base}`;
  // curl reads file:// URLs; the installer only ever builds https URLs when no base is given.
  return spawnSync(process.env.CARL_TEST_SH ?? "sh", [INSTALL], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: home, TMPDIR: tmpdir(), CARL_HOME: join(home, ".carl"), CARL_BIN_DIR: bin, CARL_RELEASE_BASE: url } });
}

test("installs a release in the layout carl update maintains, and a second release keeps one rollback", () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-inst-"));
  try {
    const home = join(dir, "home"); const bin = join(dir, "bin"); mkdirSync(home);
    const a = run(fakeRelease(dir, "1.0.0"), home, bin);
    assert.equal(a.status, 0, a.stderr + a.stdout);
    const app = join(home, ".carl", "app");
    assert.equal(readlinkSync(join(app, "current")), join(app, "release-1.0.0-0123456789ab"));
    const out = spawnSync(join(bin, "carl"), ["--version"], { encoding: "utf8" });
    assert.equal(out.stdout.trim(), "1.0.0");
    // The running copy must be recognised as an updatable release install through the wrapper.
    const inst = detectInstall(realpathSync(join(app, "release-1.0.0-0123456789ab")), join(app, "current", "bin", "carl"));
    assert.equal(inst.kind, "release");

    const b = run(fakeRelease(dir, "1.1.0"), home, bin);
    assert.equal(b.status, 0, b.stderr + b.stdout);
    assert.equal(readlinkSync(join(app, "current")), join(app, "release-1.1.0-0123456789ab"));
    assert.equal(readlinkSync(join(app, "current.previous")), join(app, "release-1.0.0-0123456789ab"));
    assert.equal(spawnSync(join(bin, "carl"), ["--version"], { encoding: "utf8" }).stdout.trim(), "1.1.0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a checksum mismatch installs nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-inst-"));
  try {
    const home = join(dir, "home"); mkdirSync(home);
    const r = run(fakeRelease(dir, "1.0.0", true), home, join(dir, "bin"));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /checksum mismatch/);
    assert.ok(!existsSync(join(home, ".carl", "app", "current")));
    assert.ok(!existsSync(join(dir, "bin", "carl")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
