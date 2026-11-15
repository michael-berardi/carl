import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const commands = ["gateway", "setup", "update", "init", "status", "doctor", "ask", "send", "ask-post", "reflect", "schedules", "post", "prompt", "app", "login", "logout", "version"];
const nested = ["update --rollback", "update --check", "reflect pending", "reflect --pending", "reflect --revert", ...["dry-run", "now", "schedule", "approve", "clear-pending", "record-live", "status"].map(s => `post ${s}`)];

test("help never starts a command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-help-"));
  let dummy: ReturnType<typeof spawn> | undefined;
  try {
    const home = join(dir, "home"), bin = join(dir, "bin"), marker = join(dir, "marker");
    mkdirSync(home); mkdirSync(bin);
    for (const name of ["npm", "curl", "git", "node-download"]) writeFileSync(join(bin, name), `#!/bin/sh\necho action >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    const state = join(home, "state"), signal = join(dir, "signal"), ready = join(dir, "ready");
    mkdirSync(state);
    dummy = spawn(process.execPath, ["-e", `const fs = require('node:fs'); process.on('SIGUSR2', () => fs.writeFileSync(${JSON.stringify(signal)}, 'signal')); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`, "main.ts", "gateway"], { stdio: "ignore" });
    for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(existsSync(ready), "dummy gateway started");
    writeFileSync(join(state, "gateway.pid"), String(dummy.pid));
    writeFileSync(join(state, "status.json"), JSON.stringify({ version: "999.0.0", pid: dummy.pid }));
    const baseline = readdirSync(state).sort();
    const env = { ...process.env, HOME: home, CARL_HOME: home, CARL_UPDATE_API: "http://127.0.0.1:1", PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
    for (const cmd of [...commands, ...nested]) for (const flag of ["--help", "-h"]) {
      const r = spawnSync(resolve("bin/carl"), [...cmd.split(" "), flag], { env, encoding: "utf8", timeout: 10000 });
      assert.equal(r.status, 0, `${cmd} ${flag}: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`carl ${cmd.split(" ")[0]}\\b`));
      assert.equal(existsSync(marker), false, cmd);
      assert.deepEqual(readdirSync(home), ["state"], cmd);
      assert.deepEqual(readdirSync(state).sort(), baseline, cmd);
      assert.equal(existsSync(signal), false, cmd);
    }
  } finally { dummy?.kill("SIGTERM"); rmSync(dir, { recursive: true, force: true }); }
});


test("top-level help lists commands and typos are named", () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-top-help-"));
  try {
    const env = { ...process.env, HOME: dir, CARL_HOME: dir };
    for (const flag of ["--help", "help"]) {
      const r = spawnSync(resolve("bin/carl"), [flag], { env, encoding: "utf8" });
      assert.equal(r.status, 0);
      for (const cmd of commands) assert.match(r.stdout, new RegExp(`carl ${cmd}\\b`));
    }
    const r = spawnSync(resolve("bin/carl"), ["updat"], { env, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown command "updat".*update/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--help inside a message is data, not a help request", async () => {
  const { helpRequested } = await import("../src/cli-help.ts");
  assert.equal(helpRequested("send", ["-t", "telegram:1", "use --help to see options"]), false);
  assert.equal(helpRequested("send", ["-t", "telegram:1", "--help"]), false, "a bare --help after the target is the message text");
  assert.equal(helpRequested("ask", ["--", "--help"]), false);
  assert.equal(helpRequested("ask", ["what does -h mean"]), false);
  assert.equal(helpRequested("send", ["--help"]), true);
  assert.equal(helpRequested("update", ["-h"]), true);
  assert.equal(helpRequested("update", ["--rollback", "--help"]), true);
  assert.equal(helpRequested("post", ["schedule", "--help"]), true);
  assert.equal(helpRequested("reflect", ["--revert", "--help"]), true);
  assert.equal(helpRequested("gateway", ["--verbose", "--help"]), false, "help is the first argument or follows a nested verb");
});
