import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramChannel } from "../src/channels/telegram.ts";
import { loadConfig, ConfigError } from "../src/config.ts";
import { GroupArchive, groupHistoryTool, readableScope } from "../src/group-archive.ts";
import { Log } from "../src/log.ts";
import { WorkLedger, filesForMessages, workTools } from "../src/work.ts";
import { FakeTelegram } from "./fake-telegram.ts";

const OP = 4242, GROUP = -10001, OTHER = -10002, MEMBER = 10003, STRANGER = 77;
const ctx = (dir: string) => ({ sessionManager: { getSessionDir: () => dir } });
const text = (r: any) => r.content.map((c: any) => c.text).join("");

test("every group message is archived, addressed or not, member or not; Carl still answers only members it was addressed by", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-gw-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false, groups: [{ chat: GROUP, members: { [String(MEMBER)]: "Member" } }] }, api: { enabled: false } }));
  const asked: string[] = [];
  const brain: any = { ask: async (_k: string, i: any) => { asked.push(i.text); return { ok: true, text: "ok", aborted: false, toolCalls: 0 }; }, whenRegistered: async () => {}, status: () => ({}), routerState: new Map() };
  const ch = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await ch.start();
  t.after(async () => { await ch.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });

  tg.groupMessage(GROUP, MEMBER, "Eat Example: add casual eats", { firstName: "Member" });
  tg.groupMessage(GROUP, STRANGER, "random chatter", { firstName: "Visitor" });
  tg.groupMessage(GROUP, MEMBER, "@carl_test_bot queue it", { firstName: "Member" });
  await tg.waitFor(() => asked.length >= 1, 10_000, "addressed message");
  await new Promise((r) => setTimeout(r, 300));

  const rows = ch.archive.read(GROUP);
  assert.deepEqual(rows.map((r) => r.text), ["Eat Example: add casual eats", "random chatter", "@carl_test_bot queue it"]);
  assert.equal(rows[1].from, "Visitor", "non-members are archived too (Carl can read the whole chat it is in)");
  assert.equal(asked.length, 1, "only the addressed member message reaches the brain");
  assert.equal(statSync(ch.archive.file(GROUP)).mode & 0o777, 0o600, "the archive is private");
  assert.equal(tg.calls.filter((c) => c.method === "forwardMessage" || c.method === "copyMessage").length, 0, "reading never forwards anything");
});

test("group_history is scoped: a group reads only itself, the operator reads any group, others none", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-gw-"));
  const a = new GroupArchive(home);
  a.append({ id: 1, chat: GROUP, at: new Date().toISOString(), from: "Member", text: "beach pass feedback" });
  a.append({ id: 2, chat: OTHER, at: new Date().toISOString(), from: "Guest", text: "private legal note" });
  a.append({ id: 3, chat: GROUP, at: new Date().toISOString(), from: "Member", text: "commute feedback" });
  const tool = groupHistoryTool(a, [OP], () => 1);
  const groupDir = join(home, "sessions", `telegram_group_${GROUP}`);
  assert.match(text(await tool.execute("x", {}, undefined, undefined, ctx(groupDir) as any)), /beach pass feedback/);
  await assert.rejects(tool.execute("x", { chat: OTHER }, undefined, undefined, ctx(groupDir) as any), /only this group/);
  assert.match(text(await tool.execute("x", { chat: OTHER }, undefined, undefined, ctx(join(home, "sessions", `telegram_dm_${OP}`)) as any)), /private legal note/);
  await assert.rejects(tool.execute("x", { chat: GROUP }, undefined, undefined, ctx(join(home, "sessions", `telegram_dm_${MEMBER}`)) as any), /not available/);
  const unq = text(await tool.execute("x", { unqueued_only: true }, undefined, undefined, ctx(groupDir) as any));
  assert.doesNotMatch(unq, /beach pass/, "unqueued_only skips messages already turned into work");
  assert.match(unq, /commute feedback/);
  assert.deepEqual(readableScope(undefined, [OP]), {});
  rmSync(home, { recursive: true, force: true });
});

test("work_queue runs the operator's fixed command with the group and project from config, and records what was queued", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-gw-"));
  const got = join(home, "got.json");
  const cmd = join(home, "queue.sh");
  writeFileSync(cmd, `#!/bin/sh\ncat > ${JSON.stringify(got)}\necho "queued J-4242"\n`);
  chmodSync(cmd, 0o755);
  writeFileSync(join(home, "carl.json"), JSON.stringify({ work: { command: [cmd] }, telegram: { allowFrom: [OP], groups: [{ chat: GROUP, members: { [String(MEMBER)]: "Member" }, work: { project: "example-project" } }, { chat: OTHER, members: {} }] }, api: { enabled: false } }));
  const cfg = loadConfig(home);
  const [tool] = workTools(cfg);
  const groupDir = join(home, "sessions", `telegram_group_${GROUP}`);
  mkdirSync(join(home, "media"));
  writeFileSync(join(home, "media", `${GROUP}-6562-0a1b2c3d.jpg`), "img");
  writeFileSync(join(home, "media", `${OTHER}-6562-0a1b2c3d.jpg`), "other chat");
  writeFileSync(join(home, "secret.txt"), "secret");
  symlinkSync(join(home, "secret.txt"), join(home, "media", `${GROUP}-6561-deadbeef.txt`));
  const r = text(await tool.execute("x", { title: "Example: Member's feedback", request: "Eat Example: add casual eats (#6561)", message_ids: [6561, 6562], requested_by: "Member", chat: GROUP }, undefined, undefined, ctx(groupDir) as any));
  assert.match(r, /J-4242/);
  const sent = JSON.parse(readFileSync(got, "utf8"));
  assert.equal(sent.chat, GROUP);
  assert.equal(sent.project, "example-project");
  assert.deepEqual(sent.messageIds, [6561, 6562]);
  assert.deepEqual(sent.files, [join(home, "media", `${GROUP}-6562-0a1b2c3d.jpg`)], "only the regular file saved for a queued id is passed along");
  assert.deepEqual(filesForMessages(join(home, "nowhere"), GROUP, [1]), []);
  assert.equal(new WorkLedger(home).lastQueued(GROUP), 6562);
  await assert.rejects(tool.execute("x", { title: "t", request: "r", message_ids: [], requested_by: "Member", chat: OTHER }, undefined, undefined, ctx(groupDir) as any), /only for that group/);
  await assert.rejects(tool.execute("x", { title: "t", request: "r", message_ids: [], requested_by: "x" }, undefined, undefined, ctx(join(home, "sessions", "telegram_dm_99")) as any), /team group or by the operator/);
  await assert.rejects(tool.execute("x", { title: "t", request: "r", message_ids: [], requested_by: "Operator", chat: OTHER }, undefined, undefined, ctx(join(home, "sessions", `telegram_dm_${OP}`)) as any), /no work set up/);
  rmSync(home, { recursive: true, force: true });
});

test("work config is validated with errors that name the cause", () => {
  for (const [raw, why] of [[{ work: { command: "x" } }, /argv/], [{ telegram: { groups: [{ chat: -1, members: {}, work: { project: "Bad Name" } }] } }, /project/]] as const) {
    const home = mkdtempSync(join(tmpdir(), "carl-gw-"));
    writeFileSync(join(home, "carl.json"), JSON.stringify({ api: { enabled: false }, ...raw }));
    assert.throws(() => loadConfig(home), (e: Error) => e instanceof ConfigError && why.test(e.message));
    rmSync(home, { recursive: true, force: true });
  }
});

test("saying the bot's name addresses it like an @mention; a longer word that contains the name does not", async (t) => {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-gw-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ name: "Carl", telegram: { allowFrom: [OP], homeChat: OP, apiBase: tg.base, stream: false, groups: [{ chat: GROUP, members: { [String(MEMBER)]: "Member" } }] }, api: { enabled: false } }));
  const asked: string[] = [];
  const brain: any = { ask: async (_k: string, i: any) => { asked.push(i.text); return { ok: true, text: "ok", aborted: false, toolCalls: 0 }; }, whenRegistered: async () => {}, status: () => ({}), routerState: new Map() };
  const ch = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  await ch.start();
  t.after(async () => { await ch.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });

  tg.groupMessage(GROUP, MEMBER, "we drove past Carlton", { firstName: "Member" });
  tg.groupMessage(GROUP, MEMBER, "Carl, queue the Example feedback", { firstName: "Member" });
  tg.groupMessage(GROUP, OP, "hey carl can you queue it", { firstName: "Operator" });
  await tg.waitFor(() => asked.length >= 2, 10_000, "name mentions");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(asked.length, 2, `only real name mentions reach the brain: ${JSON.stringify(asked)}`);
  assert.match(asked[0], /queue the Example feedback/);
});
