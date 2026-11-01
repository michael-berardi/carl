import assert from "node:assert/strict";
import { test } from "node:test";
import { getMeWithRetry } from "../src/channels/telegram.ts";
import { TelegramError } from "../src/channels/telegram-api.ts";

const noSleep = async () => {};

test("a transient getMe failure (502) is retried and startup continues", async () => {
  let calls = 0; const retries: number[] = [];
  const me = await getMeWithRetry(async () => {
    calls++;
    if (calls < 3) throw new TelegramError("getMe", 502, "Bad Gateway");
    return { id: 1, username: "UltraLDSBot" };
  }, (attempt) => retries.push(attempt), [1, 1, 1], noSleep);
  assert.deepEqual(me, { id: 1, username: "UltraLDSBot" });
  assert.deepEqual(retries, [1, 2]);
});

test("a network error is retried too", async () => {
  let calls = 0;
  await getMeWithRetry(async () => { if (calls++ === 0) throw new TelegramError("getMe", 0, "network or response error"); return {}; }, () => {}, [1], noSleep);
  assert.equal(calls, 2);
});

test("a rejected token (401) fails at once with its cause", async () => {
  let calls = 0;
  await assert.rejects(getMeWithRetry(async () => { calls++; throw new TelegramError("getMe", 401, "Unauthorized"); }, () => {}, [1, 1], noSleep),
    /getMe failed \(401\): Unauthorized/);
  assert.equal(calls, 1);
});

test("retries are bounded: the last transient error is reported", async () => {
  let calls = 0;
  await assert.rejects(getMeWithRetry(async () => { calls++; throw new TelegramError("getMe", 502, "Bad Gateway"); }, () => {}, [1, 1], noSleep),
    /getMe failed \(502\): Bad Gateway/);
  assert.equal(calls, 3);
});
