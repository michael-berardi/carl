// Opus sign-off regressions: synthetic credentials and isolated log directories only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageLog } from "../src/message-log.ts";

function scratch(t: any) {
  const root = mkdtempSync(join(tmpdir(), "carl-signoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "logs");
  mkdirSync(parent, { mode: 0o700 });
  return { parent, dir: join(parent, "ultrabot-messages") };
}

for (const mode of [0o755, 0o750, 0o705]) {
  test(`sign-off: owned ${mode.toString(8)} UltraTerm logs parent permits a private receipt directory`, (t) => {
    const { parent, dir } = scratch(t);
    chmodSync(parent, mode);
    const warnings: string[] = [];
    new MessageLog(dir, (msg) => warnings.push(msg)).record("sendMessage", { chat_id: 1, text: "receipt" }, { message_id: 2 });
    assert.deepEqual(warnings, []);
    assert.equal(JSON.parse(readFileSync(join(dir, "hermes.jsonl"), "utf8")).text, "receipt");
    assert.equal(statSync(parent).mode & 0o777, mode, "do not chmod UltraTerm's shared logs directory");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "hermes.jsonl")).mode & 0o777, 0o600);
  });
}

for (const mode of [0o775, 0o707, 0o777]) {
  test(`sign-off: group/world-writable ${mode.toString(8)} logs parent is refused`, (t) => {
    const { parent, dir } = scratch(t);
    chmodSync(parent, mode);
    const warnings: string[] = [];
    new MessageLog(dir, (msg) => warnings.push(msg)).record("sendMessage", { chat_id: 1, text: "unsafe" }, { message_id: 2 });
    assert.equal(existsSync(join(dir, "hermes.jsonl")), false);
    assert.match(warnings[0], /immediate parent/);
    assert.equal(statSync(parent).mode & 0o777, mode);
  });
}

for (const credential of [
  "xoxe-" + "1-0123456789-SyntheticRefreshValue",
  "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd",
  "sk-proj-SyntheticSynthetic0123456789",
  `ghp_${"A".repeat(35)}1`,
  "xoxb-" + "0000000000-1111111111-SyntheticSynth",
]) {
  for (const prefix of ["", "a", "9"]) {
    test(`sign-off: ${credential.split(/[-_:]/)[0]} credential after ${prefix || "a boundary"} is masked across receipt fields`, (t) => {
      const { dir } = scratch(t);
      const text = `${prefix}${credential}`;
      new MessageLog(dir).record("sendMessage", { chat_id: 1, text, document: { file_name: text }, reply_markup: { inline_keyboard: [[{ text }]] } }, undefined, { requestId: "test", status: "unknown", error: text });
      const persisted = readFileSync(join(dir, "hermes.jsonl"), "utf8");
      assert.equal(persisted.includes(credential), false, "synthetic credential is not persisted");
      const row = JSON.parse(persisted);
      assert.equal(row.masked, true);
      assert.equal(row.exact, false);
      if (prefix && !(prefix === "9" && credential.includes(":"))) assert.ok(row.text.startsWith(prefix), "adjacent prose is preserved (a leading digit is part of a numeric bot identity)");
    });
  }
}

test("sign-off: ordinary words, short prefixes and times are not masked", (t) => {
  const { dir } = scratch(t);
  const text = "ask-questions-about-scheduling; task-management-is-important; xoxe-short; foxoxb-ordinarywords; sunghp_SyntheticSyntheticSynthetic0123456789; 12:30:45";
  new MessageLog(dir).record("sendMessage", { chat_id: 1, text }, { message_id: 2 });
  const row = JSON.parse(readFileSync(join(dir, "hermes.jsonl"), "utf8"));
  assert.equal(row.text, text);
  assert.equal(row.exact, true);
});
