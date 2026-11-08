import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { adoptTrustedPath, cleanEnv, operatorPathDirs, operatorPathFrom } from "../src/sandbox.ts";
import { runCommand } from "../src/scheduler.ts";

test("Carl's own children get a PATH of links resolved once; the agent keeps the operator's PATH", (t) => {
  const root = mkdtempSync(join(tmpdir(), "carl-path-"));
  const saved = process.env.PATH;
  delete process.env.CARL_OPERATOR_PATH;
  t.after(() => { process.env.PATH = saved; delete process.env.CARL_OPERATOR_PATH; rmSync(root, { recursive: true, force: true }); });
  const userBin = join(root, "user-bin");
  mkdirSync(userBin);
  writeFileSync(join(userBin, "tool"), "#!/bin/sh\necho tool\n", { mode: 0o755 });
  process.env.PATH = `${userBin}:/usr/bin:/bin`;
  const found = adoptTrustedPath(join(root, "state-bin"), { tool: undefined, missing: undefined, node: process.execPath });
  assert.equal(found.tool, join(userBin, "tool"));
  assert.equal(found.missing, undefined);
  assert.equal(readlinkSync(join(root, "state-bin", "tool")), realpathSync(join(userBin, "tool")));
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

test("a restart in place keeps every program reachable: links never point at themselves", (t) => {
  // 2026-11-08: `carl update` re-executed the gateway with its trusted PATH; `claude` was found through Carl's own
  // bin folder, the folder was rebuilt, and the link pointed at itself, so every Claude call failed "not installed".
  const root = mkdtempSync(join(tmpdir(), "carl-restart-"));
  const saved = { PATH: process.env.PATH, op: process.env.CARL_OPERATOR_PATH };
  t.after(() => { process.env.PATH = saved.PATH; if (saved.op === undefined) delete process.env.CARL_OPERATOR_PATH; else process.env.CARL_OPERATOR_PATH = saved.op; rmSync(root, { recursive: true, force: true }); });
  const userBin = join(root, "user-bin"), stateBin = join(root, "state-bin");
  mkdirSync(userBin);
  writeFileSync(join(userBin, "claude"), "#!/bin/sh\necho claude\n", { mode: 0o755 });
  // First start from the operator's shell.
  delete process.env.CARL_OPERATOR_PATH;
  process.env.PATH = `${userBin}:/usr/bin:/bin`;
  adoptTrustedPath(stateBin, { claude: undefined });
  assert.equal(realpathSync(join(stateBin, "claude")), realpathSync(join(userBin, "claude")));
  // The restarted process starts with the trusted PATH and resolves `claude` through the bin folder it is about to rebuild.
  const inherited = process.env.CARL_OPERATOR_PATH;
  assert.equal(operatorPathFrom({ PATH: process.env.PATH, CARL_OPERATOR_PATH: inherited }, stateBin), `${userBin}:/usr/bin:/bin`);
  assert.equal(operatorPathFrom({ PATH: process.env.PATH }, stateBin).split(":").includes(stateBin), false);
  adoptTrustedPath(stateBin, { claude: join(stateBin, "claude") });
  assert.notEqual(readlinkSync(join(stateBin, "claude")), join(stateBin, "claude"));
  assert.equal(realpathSync(join(stateBin, "claude")), realpathSync(join(userBin, "claude")));
});
