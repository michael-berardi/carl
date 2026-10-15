import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, parseSchedule } from "../src/cron.ts";

const at = (s: string) => new Date(s).getTime();

test("every N minutes anchors on the last run", () => {
  const s = parseSchedule("every 30m");
  assert.equal(nextRun(s, at("2026-10-15T10:00:00"), at("2026-10-15T09:50:00")), at("2026-10-15T10:20:00"));
  assert.equal(nextRun(s, at("2026-10-15T10:00:00")), at("2026-10-15T10:30:00"));
});

test("cron fields", () => {
  const s = parseSchedule("0 9 * * 1-5");
  assert.equal(nextRun(s, at("2026-10-16T09:00:00")), at("2026-10-19T09:00:00")); // Friday 9:00 -> Monday 9:00
  assert.equal(nextRun(parseSchedule("*/15 * * * *"), at("2026-10-15T10:07:00")), at("2026-10-15T10:15:00"));
  assert.equal(nextRun(parseSchedule("@daily"), at("2026-10-15T10:07:00")), at("2026-10-16T00:00:00"));
});

test("day-of-month OR day-of-week when both are restricted", () => {
  const s = parseSchedule("0 8 1 * 0"); // 1st of month or Sunday
  assert.equal(nextRun(s, at("2026-10-15T12:00:00")), at("2026-10-18T08:00:00"));
});

test("bad schedules name the problem", () => {
  assert.throws(() => parseSchedule("61 * * * *"), /minute/);
  assert.throws(() => parseSchedule("every soon"), /expected 5 cron fields/);
});

test("DST: results are always strictly after the reference time", () => {
  const s = parseSchedule("*/10 * * * *");
  let t = new Date("2026-11-01T00:55:00").getTime(); // US fall-back night (when TZ observes it)
  for (let i = 0; i < 30; i++) {
    const n = nextRun(s, t);
    assert.ok(n > t, `step ${i}: ${new Date(n).toISOString()} <= ${new Date(t).toISOString()}`);
    assert.ok(n - t <= 11 * 60_000 + 3_600_000, "no gap longer than an interval plus one DST hour");
    t = n;
  }
});

test("month-end and leap day", () => {
  assert.equal(nextRun(parseSchedule("0 0 31 * *"), new Date("2026-04-15T00:00:00").getTime()), new Date("2026-05-31T00:00:00").getTime());
  assert.equal(nextRun(parseSchedule("0 0 29 2 *"), new Date("2026-03-01T00:00:00").getTime()), new Date("2028-02-29T00:00:00").getTime());
});
