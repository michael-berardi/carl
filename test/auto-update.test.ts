// Regression: gateway auto-update scheduling must be owned by the gateway, not by CLI checks or restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gateway } from "../src/gateway.ts";
import { UpdatePlugin } from "../src/update.ts";
import { VERSION } from "../src/version.ts";

const DAY_MS = 24 * 3600_000;
const LATEST = "9.9.9";

// A private cache per test process: a gateway tick must never read a real check or another fixture's answer.
process.env.CARL_UPDATE_CACHE_DIR = mkdtempSync(join(tmpdir(), "carl-autoupdate-cache-"));
process.on("exit", () => rmSync(process.env.CARL_UPDATE_CACHE_DIR!, { recursive: true, force: true }));

function home(): string {
  return mkdtempSync(join(tmpdir(), "carl-autoupdate-"));
}

function stateFile(homeDir: string): string {
  return join(homeDir, "state", "update.json");
}

function putState(homeDir: string, state: Record<string, unknown>): void {
  mkdirSync(join(homeDir, "state"), { recursive: true });
  writeFileSync(stateFile(homeDir), JSON.stringify(state));
}

function getState(homeDir: string): Record<string, any> {
  return JSON.parse(readFileSync(stateFile(homeDir), "utf8"));
}

/** A deterministic clock: `now` is fixed, scheduled timers are recorded instead of firing. */
function fakeClock(nowMs: number) {
  const delays: number[] = [];
  return {
    now: () => nowMs,
    after: (_fn: () => void, ms: number) => { delays.push(ms); return { unref() {} } as NodeJS.Timeout; },
    delays,
  };
}

function fakeGateway(homeDir: string, auto: boolean, busy = 0) {
  const entries: { level: string; msg: string; data?: any }[] = [];
  const record = (level: string) => (msg: string, data?: any) => { entries.push({ level, msg, data }); };
  const gw = {
    cfg: { home: homeDir, update: { check: true, auto } },
    log: { info: record("info"), warn: record("warn"), error: record("error") },
    brain: { busyCount: () => busy },
    scheduler: { runningCount: () => 0 },
  };
  return { gw: gw as unknown as Gateway, entries };
}

/** A fake GitHub releases endpoint so no test depends on a real network or on a published version. */
async function withFakeGitHub<T>(run: () => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/releases/latest")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ tag_name: `v${LATEST}`, body: "- synthetic release", html_url: "https://example.test/release" }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const prev = process.env.CARL_UPDATE_API;
  process.env.CARL_UPDATE_API = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    return await run();
  } finally {
    if (prev === undefined) delete process.env.CARL_UPDATE_API;
    else process.env.CARL_UPDATE_API = prev;
    server.close();
  }
}

/** Drive one gateway check without letting the test install a release on this machine. */
async function tickOnce(homeDir: string, auto: boolean, busy: number, state: Record<string, unknown>) {
  putState(homeDir, { checkedAt: Date.now(), ...state });
  const clock = fakeClock(Date.now());
  const { gw, entries } = fakeGateway(homeDir, auto, busy);
  const plugin = new UpdatePlugin(clock as any);
  plugin.start(gw);
  const applied: string[] = [];
  (plugin as any).apply = async (rel: { version: string }) => { applied.push(rel.version); return "synthetic install"; };
  await (plugin as any).tick();
  return { clock, entries, applied, state: getState(homeDir) };
}

test("a CLI check does not postpone the gateway's next check, and a restart keeps the gateway's own deadline", () => {
  const dir = home();
  const now = Date.now();
  try {
    // External checks touch checkedAt every few hours; the gateway's own deadline is already due.
    putState(dir, { checkedAt: now, latest: LATEST, nextGatewayCheckAt: now - 1_000 });
    const { gw } = fakeGateway(dir, true);
    const first = fakeClock(now);
    new UpdatePlugin(first as any).start(gw);
    assert.equal(first.delays.length, 1);
    assert.ok(first.delays[0] <= 60_000, `an overdue gateway check waited ${first.delays[0]} ms`);

    // With a future gateway deadline, a CLI check and a restart must only shorten the remaining wait.
    putState(dir, { checkedAt: now, latest: LATEST, nextGatewayCheckAt: now + 3 * 3600_000 });
    const scheduled = fakeClock(now);
    new UpdatePlugin(scheduled as any).start(gw);
    assert.equal(scheduled.delays[0], 3 * 3600_000);
    putState(dir, { ...getState(dir), checkedAt: now, latest: LATEST });
    const second = fakeClock(now + 10_000);
    new UpdatePlugin(second as any).start(gw);
    assert.equal(second.delays.length, 1);
    assert.ok(second.delays[0] < scheduled.delays[0] && second.delays[0] > 2 * 3600_000,
      `a restart after a CLI check waited ${second.delays[0]} ms instead of resuming the gateway deadline`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed earlier attempt does not stop a later auto-install, even after a CLI saw the same release", async () => {
  const dir = home();
  try {
    const r = await withFakeGitHub(() => tickOnce(dir, true, 0, {
      latest: LATEST,
      notified: LATEST, // a previous gateway attempt failed; the CLI also already saw this release
    }));
    assert.deepEqual(r.applied, [LATEST], "auto-install retries instead of trusting a stale notified marker");
    assert.equal(r.state.latest, LATEST);
    assert.ok(r.state.checkedAt > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-install is skipped while runs are active, with a named cause and a short retry", async () => {
  const dir = home();
  try {
    const r = await withFakeGitHub(() => tickOnce(dir, true, 1, { latest: LATEST }));
    assert.deepEqual(r.applied, [], "nothing is installed while a run is active");
    const skip = r.entries.find((e) => e.level === "info" && e.msg === "auto-update skipped");
    assert.equal(skip?.data?.reason, "runs active");
    const next = r.clock.delays.at(-1);
    assert.ok(next !== undefined && next < DAY_MS, "a busy gateway checks again soon");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-install is skipped when the release is installed but the gateway has not restarted yet", async () => {
  const dir = home();
  try {
    const r = await withFakeGitHub(() => tickOnce(dir, true, 0, {
      installed: { from: VERSION, to: LATEST, at: Date.now() },
    }));
    assert.deepEqual(r.applied, [], "an installed release is not installed twice before the deferred restart");
    const skip = r.entries.find((e) => e.level === "info" && e.msg === "auto-update skipped");
    assert.equal(skip?.data?.reason, "installed, waiting for restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
