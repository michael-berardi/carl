import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { adoptTrustedPath, cleanEnv, operatorPathDirs } from "../src/sandbox.ts";
import { runCommand } from "../src/scheduler.ts";

test("Carl's own children get a PATH of links resolved once; the agent keeps the operator's PATH", (t) => {
  const root = mkdtempSync(join(tmpdir(), "carl-path-"));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; rmSync(root, { recursive: true, force: true }); });
  const userBin = join(root, "user-bin");
  mkdirSync(userBin);
  writeFileSync(join(userBin, "tool"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
  process.env.PATH = `${userBin}:/usr/bin:/bin`;
  const found = adoptTrustedPath(join(root, "state-bin"), { tool: undefined, missing: undefined, node: process.execPath });
  assert.equal(found.tool, join(userBin, "tool"));
  assert.equal(found.missing, undefined);
  assert.equal(readlinkSync(join(root, "state-bin", "tool")), join(userBin, "tool"));
  assert.ok(!process.env.PATH!.includes(userBin), "user-writable folders are not on Carl's own PATH");
  assert.ok(process.env.PATH!.startsWith(join(root, "state-bin")));
  assert.deepEqual(operatorPathDirs(), [userBin, "/usr/bin", "/bin"]);
  const home = join(root, "carl");
  mkdirSync(home);
  assert.equal(cleanEnv(loadConfig(home)).PATH, `${userBin}:/usr/bin:/bin`, "the agent's commands keep the operator's PATH");
});

test("command schedules refuse to run outside the gateway's sandbox", async () => {
  await assert.rejects(runCommand("echo hi", 5_000), /only in the gateway/);
});
