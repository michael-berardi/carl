import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramChannel } from "../src/channels/telegram.ts";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const OP = 4242, GROUP = -10001, MEMBER = 10003;

test("a failed run shows its cause only in the operator's own chat; a shared chat gets a plain retry and the operator gets the cause", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-gw-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false, groups: [{ chat: GROUP, members: { [String(MEMBER)]: "Member" } }] }, api: { enabled: false } }));
  let asked = 0;
  const brain: any = { ask: async () => { asked++; return { ok: false, error: "provider says: usage limit reached", text: "", aborted: false, toolCalls: 0 }; }, whenRegistered: async () => {}, status: () => ({}), routerState: new Map() };
  const ch = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await ch.start();
  t.after(async () => { await ch.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });

  tg.groupMessage(GROUP, MEMBER, "@carl_test_bot please do the thing", { firstName: "Member" });
  await tg.waitFor(() => tg.texts(GROUP).length >= 1 && tg.texts(OP).length >= 1, 10_000, "group reply and operator notice");
  const group = tg.texts(GROUP).join("\n");
  assert.match(group, /I could not answer that just now/);
  assert.doesNotMatch(group, /Run failed|usage limit/);
  const notice = tg.texts(OP).join("\n");
  assert.match(notice, /Team/);
  assert.match(notice, /provider says: usage limit reached/);
  assert.match(notice, /please do the thing/);

  const before = tg.texts(OP).length;
  tg.message(OP, "hello from the operator");
  await tg.waitFor(() => tg.texts(OP).length > before, 10_000, "operator reply");
  assert.ok(tg.texts(OP).some((x) => x.includes("Run failed: provider says: usage limit reached")));
  assert.equal(asked, 2);
});
