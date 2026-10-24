// The trusted decision-answer child inherits launch identity; no real authorities or overseer are used here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UltraTermCompat } from "../src/compat/ultraterm.ts";

function compat(t: any) {
  const home = mkdtempSync(join(tmpdir(), "carl-decision-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "ut-overseer");
  // An arbitrary synthetic authority-shaped value ensures no allowlist silently strips future launcher identity.
  writeFileSync(bin, `#!${process.execPath}\nconst expected = ["decision-answer", "--id", "D-test", "--choice", "2", "--user", "42", "--callback", "synthetic-callback"];\nif (process.env.CARL_TEST_AUTHORITY !== "synthetic-launch-identity" || JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(4);\nconsole.log(JSON.stringify({accepted:true,result:"Synthetic answer accepted"}));\n`);
  chmodSync(bin, 0o700);
  const plugin = new UltraTermCompat({ home, overseerBin: bin });
  const edits: string[] = [];
  (plugin as any).gw = { telegram: { api: { editMessageText: async (_chat: number, _id: number, text: string) => edits.push(text) } }, log: { warn: () => {} } };
  return { plugin, edits };
}

const query = { id: "synthetic-callback", from: { id: 42 }, message: { message_id: 7, chat: { id: 42, type: "private" }, text: "Decision" } };

test("decision-answer inherits the gateway environment without inventing UltraBot authority", async (t) => {
  const { plugin, edits } = compat(t);
  const old = process.env.CARL_TEST_AUTHORITY;
  process.env.CARL_TEST_AUTHORITY = "synthetic-launch-identity";
  t.after(() => { if (old === undefined) delete process.env.CARL_TEST_AUTHORITY; else process.env.CARL_TEST_AUTHORITY = old; });
  const result = await (plugin as any).decision(query, "utd:D-test:2");
  assert.equal(result, "Synthetic answer accepted");
  assert.equal(edits.length, 1);
  assert.match(edits[0], /✅ Synthetic answer accepted/);
  delete process.env.CARL_TEST_AUTHORITY;
  const refused = await (plugin as any).decision(query, "utd:D-test:2");
  assert.match(refused, /UltraTerm refused/);
  assert.doesNotMatch(edits.at(-1)!, /✅/);
});

test("decision-answer still refuses malformed buttons and non-private chats before spawning", async (t) => {
  const { plugin, edits } = compat(t);
  assert.match(await (plugin as any).decision(query, "utd:D-test:not-a-choice"), /malformed/);
  assert.match(await (plugin as any).decision({ ...query, message: { ...query.message, chat: { id: -42, type: "group" } } }, "utd:D-test:2"), /direct chat/);
  assert.deepEqual(edits, []);
});
