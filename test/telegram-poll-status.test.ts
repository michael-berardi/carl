import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLL_FAILURES_BEFORE_RETRYING, TelegramChannel } from "../src/channels/telegram.ts";
import { loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { FakeTelegram } from "./fake-telegram.ts";

async function setup(t: any, drops: number) {
  const tg = new FakeTelegram();
  await tg.start();
  const home = mkdtempSync(join(tmpdir(), "carl-tg-poll-"));
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "carl.json"), JSON.stringify({ telegram: { allowFrom: [1], homeChat: 1, apiBase: tg.base, stream: false }, api: { enabled: false } }));
  const brain: any = { ask: async () => ({ ok: true, text: "", aborted: false, toolCalls: 0 }), whenRegistered: async () => {}, status: () => ({}), routerState: new Map(), shellSandbox: undefined };
  const channel = new TelegramChannel(loadConfig(home), "123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz", brain, new Log(undefined));
  const states: string[] = [];
  const set = (channel as any).setStatus.bind(channel);
  (channel as any).setStatus = (s: string, ...rest: any[]) => { states.push(s); return set(s, ...rest); };
  await channel.start();
  tg.dropPolls = drops;
  t.after(async () => { await channel.stop(); await tg.stop(); rmSync(home, { recursive: true, force: true }); });
  return { tg, channel, states };
}

test("one dropped Telegram poll does not report the channel as retrying", async (t) => {
  assert.equal(POLL_FAILURES_BEFORE_RETRYING, 2);
  const { tg, channel, states } = await setup(t, 1);
  const start = tg.polls;
  await tg.waitFor(() => tg.polls >= start + 3, 15_000, "polling resumed after one drop");
  assert.ok(!states.includes("retrying"), `states: ${states.join(",")}`);
  assert.equal(channel.status.state, "connected");
});

test("two dropped polls in a row report retrying, then connected again", async (t) => {
  const { tg, channel, states } = await setup(t, 2);
  const start = tg.polls;
  await tg.waitFor(() => tg.polls >= start + 4, 20_000, "polling resumed after two drops");
  assert.ok(states.includes("retrying"), `states: ${states.join(",")}`);
  assert.equal(channel.status.state, "connected");
});
