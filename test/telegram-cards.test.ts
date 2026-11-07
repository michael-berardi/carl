// F4: two long cards requested at once are sent one after the other, and every piece carries its card id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
const channelURL = new URL("../src/channels/telegram.ts", import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === channelURL && specifier === "../brain.ts") return { url: "data:text/javascript,export function toolsRanAfter() { return false; }", shortCircuit: true };
  return next(specifier, context);
} });
const { TelegramChannel } = await import("../src/channels/telegram.ts");
hook.deregister();

test("F4: long cards are sent serialized, each piece carries the card id, buttons on each card's last piece", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "carl-cards-"));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [1], homeChat: 1 } }));
  const ch = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", {} as any, new Log(undefined));
  t.after(async () => { await ch.stop(); rmSync(home, { recursive: true, force: true }); });
  const sent: { text: string; buttons: boolean }[] = [];
  let n = 0;
  t.mock.method(ch.api, "sendMessage", async (_chat: number, text: string, o: any) => {
    await new Promise((r) => setTimeout(r, 5 + (n % 2) * 10)); // uneven delays would interleave unserialized sends
    sent.push({ text, buttons: !!o?.buttons }); n++;
    return { message_id: n };
  });
  const long = (c: string) => Array.from({ length: 60 }, (_, i) => `${c}${i} ${c.repeat(80)}`).join("\n");
  const a = ch.requestCard(1, long("A"), "Allow");
  const b = ch.requestCard(1, long("B"), "Allow");
  for (let i = 0; i < 200 && sent.filter((s) => s.buttons).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const ids = [...new Set(sent.map((s) => /Post approval (\w+)/.exec(s.text)![1]))];
  assert.equal(ids.length, 2, "every piece names its card");
  const order = sent.map((s) => ids.indexOf(/Post approval (\w+)/.exec(s.text)![1]));
  assert.deepEqual(order, [...order].sort(), "all pieces of one card precede the other card's");
  assert.ok(order.length > 2);
  assert.equal(sent.filter((s) => s.buttons).length, 2);
  for (const id of ids) (ch as any).approvals.get(id)("denied", "1");
  await Promise.all([a, b]);
});
