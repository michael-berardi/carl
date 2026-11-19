// gateway_state.json start_time must be the kernel's process start, which survives `carl update`'s in-place execve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { processStartCentiseconds } from "../src/compat/ultraterm.ts";

test("start_time comes from ps, not Node's uptime (an execve restart keeps the kernel start)", () => {
  // A process the kernel started 20 minutes before this Node instance, as after `carl update` re-executes in place.
  const kernel = new Date(Date.now() - process.uptime() * 1000 - 20 * 60_000);
  kernel.setUTCMilliseconds(0);
  const lstart = kernel.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 $4");
  assert.equal(processStartCentiseconds(1, () => `${lstart}    \n`), kernel.getTime() / 10);
});

test("the live value matches ps for this process within 2 s", () => {
  const ps = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const expected = Date.parse(`${ps.trim().replace(/\s+/g, " ")} UTC`) / 10;
  assert.ok(Math.abs(processStartCentiseconds() - expected) <= 200);
});

test("an unreadable or nonsense ps falls back to uptime instead of throwing", () => {
  const fallback = (Date.now() - process.uptime() * 1000) / 10;
  assert.ok(Math.abs(processStartCentiseconds(1, () => { throw new Error("no ps"); }) - fallback) <= 200);
  assert.ok(Math.abs(processStartCentiseconds(1, () => "garbage") - fallback) <= 200);
});
