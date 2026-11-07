import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/setup.ts";
import { FakeTelegram } from "./fake-telegram.ts";

test("setup captures and acknowledges a Telegram user and preserves existing settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "carl-setup-"));
  const old = process.env.CARL_HOME;
  const originalFetch = globalThis.fetch;
  const polls: any[] = [];
  const fake = new FakeTelegram();
  await fake.start();
  process.env.CARL_HOME = home;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/getUpdates")) polls.push(JSON.parse(String(init?.body)));
    return originalFetch(input, init);
  };
  const token = "123456:abcdefghijklmnopqrstuvwxyz";
  try {
    writeFileSync(join(home, ".env"), "# keep this\nOTHER=value\n", { mode: 0o644 });
    fake.message(456, "hello");
    const init = () => {
      const file = join(home, "carl.json");
      try { readFileSync(file); } catch { writeFileSync(file, JSON.stringify({ model: "", telegram: { enabled: true, allowFrom: [], homeChat: 0 }, api: { enabled: true } })); }
      return 0;
    };
    const answers = ["", token, "", "", ""];
    const ask = async () => { assert.ok(answers.length, "unexpected prompt"); return answers.shift()!; };
    assert.equal(await setup({ init, doctor: async () => 0, ask, telegramBase: fake.base }), 0);
    const config = JSON.parse(readFileSync(join(home, "carl.json"), "utf8"));
    assert.deepEqual(config.telegram.allowFrom, [456]);
    assert.equal(config.telegram.homeChat, 456);
    const env = readFileSync(join(home, ".env"), "utf8");
    assert.match(env, /# keep this\nOTHER=value/);
    assert.ok(env.includes(`TELEGRAM_BOT_TOKEN=${token}`));
    assert.match(env, /CARL_API_KEY=[a-f0-9]{64}/);
    assert.equal(statSync(join(home, ".env")).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.ok(fake.calls.some((call) => call.method === "getMe"));
    assert.ok(polls.some((poll) => poll.offset === 2 && poll.timeout === 0));
    const again = ["", ""];
    assert.equal(await setup({ init, doctor: async () => 0, ask: async () => { assert.ok(again.length); return again.shift()!; }, telegramBase: fake.base }), 0);
    assert.equal(readFileSync(join(home, ".env"), "utf8"), env);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "carl.json"), "utf8")), config);
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.CARL_HOME; else process.env.CARL_HOME = old;
    await fake.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
