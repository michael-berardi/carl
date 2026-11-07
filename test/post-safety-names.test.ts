import { test } from "node:test";
import assert from "node:assert/strict";
import { builtInReadNames, expandNames, unsafeAllowTools } from "../src/post/safety.ts";

const bad = (entry: string) => unsafeAllowTools([[entry, ""]], ["vault"]).flatMap((b) => b.tools);

test("exact read-only names pass, including an alternation of them", () => {
  assert.deepEqual(bad("^overseer/coordinator_job_get$"), []);
  assert.deepEqual(bad("^overseer/(coordinator_job_list|coordinator_status)$"), []);
  assert.deepEqual(bad("^overseer/(?:coordinator)_(job_get|status)$"), []);
  assert.deepEqual(bad("^vault/read_note$"), []);
});

test("an unknown exact name fails closed, even hidden in a list of reads", () => {
  assert.deepEqual(bad("^overseer/coordinator_mystery$"), ["coordinator_mystery"]);
  assert.deepEqual(bad("^overseer/(coordinator_job_get|coordinator_mystery)$"), ["coordinator_mystery"]);
});

test("broad patterns and dangerous verbs are refused under both prefixes", () => {
  for (const entry of [".*", "^overseer/coordinator_.*", "^overseer/overseer_.*"]) assert.ok(bad(entry).some((t) => t.startsWith("any future tool")), entry);
  assert.deepEqual(bad("^overseer/coordinator_relay$"), ["coordinator_relay"]);
  assert.deepEqual(bad("^overseer/overseer_send$"), ["overseer_send"]);
});

test("the built-in read list expands to concrete names; wildcards do not expand", () => {
  assert.ok(builtInReadNames("overseer").includes("overseer/coordinator_job_get"));
  assert.ok(builtInReadNames("vault").includes("vault/read_note"));
  assert.equal(expandNames("^overseer/coordinator_.*$", "overseer"), undefined);
  assert.equal(expandNames("overseer/coordinator_job_get", "overseer"), undefined); // unanchored
});
