import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { isOwnChat, refuseUnconfiguredChat } from "../src/send-target.ts";

const OP = 4242;
const GROUP = -1001234567890;
const OTHER_GROUP = -1009876543210; // a group this bot is not configured for (for example, a client group of another home)
const CARL = fileURLToPath(new URL("../bin/carl", import.meta.url));

function setup(extra: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "carl-send-target-"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({
    telegram: { allowFrom: [OP], homeChat: OP, tokenEnv: "CARL_SEND_TEST_TOKEN", apiBase: "http://127.0.0.1:1", stream: false, groups: [{ chat: GROUP, members: { "111111111": "Member" } }] },
    api: { enabled: false },
    ...extra,
  }));
  return home;
}

test("only the home chat, allowed users and configured groups are own chats", () => {
  const home = setup();
  try {
    const cfg = loadConfig(home);
    assert.equal(isOwnChat(cfg, OP), true);
    assert.equal(isOwnChat(cfg, GROUP), true);
    assert.equal(isOwnChat(cfg, OTHER_GROUP), false);
    assert.equal(refuseUnconfiguredChat(cfg, OTHER_GROUP) === undefined, false);
    assert.equal(refuseUnconfiguredChat(cfg, GROUP), undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the refusal names the chat and points at the reporting route when UltraTerm is configured", () => {
  const home = setup({ ultraterm: { home: "~/.hermes", secretFiles: [] } });
  try {
    const msg = refuseUnconfiguredChat(loadConfig(home), OTHER_GROUP) ?? "";
    assert.match(msg, /chat -1009876543210 is not the home chat, an allowed user or a configured group/);
    assert.match(msg, /utp report --route client --project <project>/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("carl send refuses an unconfigured chat before reading the token or making any request", () => {
  const home = setup();
  try {
    // The token is set and the API points at a closed port: if the guard did not run first, the send would fail with a
    // connection error instead of the named refusal, so the refusal text proves no request was attempted.
    const r = spawnSync(CARL, ["send", "--json", "-t", `telegram:${OTHER_GROUP}`, "Test text"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CARL_HOME: home, CARL_SEND_TEST_TOKEN: "123:fake" },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    assert.equal(out.success, false);
    assert.match(out.error, /is not the home chat, an allowed user or a configured group/);
    assert.doesNotMatch(out.error, /fetch|ECONNREFUSED|127\.0\.0\.1/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
