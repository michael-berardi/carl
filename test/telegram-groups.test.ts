import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramChannel } from "../src/channels/telegram.ts";
import { loadConfig, ConfigError } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const OP = 4242;
const GROUP = -5269168638;
const KATE = 1523575779;
const STRANGER = 99;
const NICO = 7186526571;

function setup(groups: unknown) {
  const home = mkdtempSync(join(tmpdir(), "carl-groups-"));
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: "http://127.0.0.1:1", stream: false, groups }, api: { enabled: false } }));
  return home;
}

test("telegram.groups is validated with errors that name the cause", () => {
  for (const [bad, why] of [[{ chat: 5, members: {} }, /negative/], [{ chat: -1, members: { kate: "Kate" } }, /numeric/], [{ chat: -1, members: { "1": " " } }, /name/]] as const) {
    const home = setup([bad]);
    assert.throws(() => loadConfig(home), (e: Error) => e instanceof ConfigError && why.test(e.message));
    rmSync(home, { recursive: true, force: true });
  }
});

test("in a listed group Carl answers listed members only when addressed, names the sender, and never treats them as the operator", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-groups-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false, groups: [{ chat: GROUP, members: { [String(KATE)]: "Kate (attorney)", [String(NICO)]: "Nico" } }] }, api: { enabled: false } }));
  const asked: { text: string; member?: string }[] = [];
  const brain: any = {
    ask: async (_k: string, i: any) => { asked.push({ text: i.text, member: i.member }); return { ok: true, text: "noted", aborted: false, toolCalls: 0 }; },
    whenRegistered: async () => {}, status: () => ({}), routerState: new Map(), shellSandbox: undefined,
  };
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });

  tg.groupMessage(GROUP, KATE, "just chatting with the team");              // not addressed: ignored
  tg.groupMessage(GROUP, NICO, "plain message from Nico");                   // not addressed: ignored
  tg.groupMessage(GROUP, STRANGER, "@carl_test_bot hello", { firstName: "X" });   // not a member: ignored
  tg.groupMessage(GROUP, KATE, "@carl_test_bot the fee is USD 185", { firstName: "Kate" }); // addressed: answered
  tg.groupMessage(-1, KATE, "@carl_test_bot other group");                         // member, but not in this group: ignored
  tg.groupMessage(GROUP, KATE, "/model claude", { firstName: "Kate" });       // operator command: refused
  tg.groupMessage(GROUP, OP, "@carl_test_bot status please", { firstName: "Mike" }); // operator in the group: answered
  tg.groupMessage(GROUP, KATE, "2) notary first", { firstName: "Kate", replyTo: { message_id: 1, date: 0, chat: { id: GROUP, type: "group" }, from: { id: 1, is_bot: true }, text: "Questions for Kate" } }); // reply to the bot: answered
  await tg.waitFor(() => asked.length >= 3 && tg.texts(GROUP).some((x) => /Only the operator/.test(x)), 10_000, "group answers");
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(asked.length, 3, `only addressed member/operator messages reach the brain: ${JSON.stringify(asked)}`);
  assert.match(asked[0].text, /^\[from Kate \(attorney\) \(Kate\)\]/);
  assert.match(asked[0].text, /the fee is USD 185/);
  assert.equal(asked[0].member, "Kate (attorney)", "a member's words are marked, so they never approve operator-only tools");
  assert.match(asked[1].text, /^\[from the operator/);
  assert.equal(asked[1].member, undefined);
  assert.match(asked[2].text, /\[replying to: "Questions for Kate"\]/, "a reply to the bot counts as addressed and carries its context");
  assert.ok(tg.texts(GROUP).some((x) => /Only the operator/.test(x)), "member slash commands other than help are refused");
});

test("while an ask waits on a member, their plain messages in that chat reach Carl; others' still need addressing", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-groups-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false, groups: [{ chat: GROUP, members: { [String(KATE)]: "Kate (attorney)", [String(NICO)]: "Nico" } }] }, api: { enabled: false } }));
  const asked: string[] = [];
  const brain: any = { ask: async (_k: string, i: any) => { asked.push(i.text); return { ok: true, text: "ok", aborted: false, toolCalls: 0 }; }, whenRegistered: async () => {}, status: () => ({}), routerState: new Map() };
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  channel.expecting = (chat, member) => chat === GROUP && member.startsWith("Kate");
  await channel.start();
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  tg.groupMessage(GROUP, NICO, "unrelated chatter");
  tg.groupMessage(GROUP, KATE, "1 yes 2 notary 3 approved", { firstName: "Kate" });
  await tg.waitFor(() => asked.length >= 1, 10_000, "Kate's plain answer");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /1 yes 2 notary 3 approved/);
});
