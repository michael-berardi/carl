import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepSpillDir } from "../src/budget.ts";
import { sweepSessionsDir } from "../src/brain.ts";
import { isProviderAccessFailure } from "../src/provider-failure.ts";

test("sweepSpillDir removes expired files, respects minCapAgeMs on byte cap, and skips symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-spill-sweep-"));
  try {
    const now = Date.now();
    const oldFile = join(dir, "old.txt");
    const capCandidate = join(dir, "cap-old.txt");
    const freshFile = join(dir, "fresh.txt");
    const linkTarget = join(dir, "outside.dat");
    const link = join(dir, "linked.txt");
    writeFileSync(oldFile, "x".repeat(100));
    writeFileSync(capCandidate, "y".repeat(600));
    writeFileSync(freshFile, "z".repeat(600));
    writeFileSync(linkTarget, "secret");
    symlinkSync(linkTarget, link);

    const tenDaysAgo = (now - 10 * 86_400_000) / 1000;
    const twoHoursAgo = (now - 2 * 3_600_000) / 1000;
    const fiveMinsAgo = (now - 5 * 60_000) / 1000;
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
    utimesSync(capCandidate, twoHoursAgo, twoHoursAgo);
    utimesSync(freshFile, fiveMinsAgo, fiveMinsAgo);

    // Byte cap 500: oldFile removed by age, capCandidate removed by cap (>1h), freshFile protected by minCapAgeMs
    const res = sweepSpillDir(dir, { maxAgeMs: 7 * 86_400_000, maxBytes: 500, minCapAgeMs: 3_600_000, now });
    assert.equal(res.removed, 2);
    assert.equal(existsSync(oldFile), false);
    assert.equal(existsSync(capCandidate), false);
    assert.equal(existsSync(freshFile), true);
    assert.equal(existsSync(link), true);
    assert.equal(existsSync(linkTarget), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepSessionsDir keeps newest transcript per folder, prunes aged rotated transcripts and schedules", () => {
  const root = mkdtempSync(join(tmpdir(), "carl-sess-sweep-"));
  try {
    const now = Date.now();
    const fortyDaysAgo = (now - 40 * 86_400_000) / 1000;
    const twoHoursAgo = (now - 2 * 3_600_000) / 1000;
    const fiveMinsAgo = (now - 5 * 60_000) / 1000;

    // Idle DM with only one 40-day-old transcript: MUST keep it
    const dmOnly = join(root, "dm-only");
    mkdirSync(dmOnly);
    writeFileSync(join(dmOnly, "key"), "telegram:dm:1");
    const sole = join(dmOnly, "sole.jsonl");
    writeFileSync(sole, "{}\n");
    utimesSync(sole, fortyDaysAgo, fortyDaysAgo);

    // DM with old rotated + newest + active: removes only non-active aged rotated file
    const dmMulti = join(root, "dm-multi");
    mkdirSync(dmMulti);
    writeFileSync(join(dmMulti, "key"), "telegram:dm:2");
    const oldRot = join(dmMulti, "old.jsonl");
    const activeOld = join(dmMulti, "active.jsonl");
    const newest = join(dmMulti, "newest.jsonl");
    writeFileSync(oldRot, "{}\n");
    writeFileSync(activeOld, "{}\n");
    writeFileSync(newest, "{}\n");
    utimesSync(oldRot, fortyDaysAgo, fortyDaysAgo);
    utimesSync(activeOld, fortyDaysAgo, fortyDaysAgo);
    utimesSync(newest, fiveMinsAgo, fiveMinsAgo);

    // Schedule dir: keeps newest, prunes >1h rotated schedule runs
    const sched = join(root, "schedule-a");
    mkdirSync(sched);
    writeFileSync(join(sched, "key"), "schedule:job-a");
    const schedOld = join(sched, "run1.jsonl");
    const schedLatest = join(sched, "run2.jsonl");
    writeFileSync(schedOld, "{}\n");
    writeFileSync(schedLatest, "{}\n");
    utimesSync(schedOld, twoHoursAgo, twoHoursAgo);
    utimesSync(schedLatest, fiveMinsAgo, fiveMinsAgo);

    const removed = sweepSessionsDir(root, { activeFiles: new Set([activeOld]), now });
    assert.equal(removed, 2); // oldRot + schedOld
    assert.equal(existsSync(sole), true);
    assert.equal(existsSync(oldRot), false);
    assert.equal(existsSync(activeOld), true);
    assert.equal(existsSync(newest), true);
    assert.equal(existsSync(schedOld), false);
    assert.equal(existsSync(schedLatest), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isProviderAccessFailure matches auth/quota/status errors and rejects false positives", () => {
  assert.equal(isProviderAccessFailure("line 401 had a syntax error"), false);
  assert.equal(isProviderAccessFailure("processed 429 rows in batch 402"), false);
  assert.equal(isProviderAccessFailure("Error: processed 429 rows"), false);
  assert.equal(isProviderAccessFailure("401 invalid api key"), true);
  assert.equal(isProviderAccessFailure('401 {"type":"error","error":{"type":"authentication_error"}}'), true);
  assert.equal(isProviderAccessFailure("HTTP 429 Too Many Requests"), true);
  assert.equal(isProviderAccessFailure("status=401 unauthorized"), true);
  assert.equal(isProviderAccessFailure("402 Payment Required"), true);
});
