import test from "node:test";
import assert from "node:assert/strict";
import { approvalSummary } from "../src/approval-text.ts";

test("an MCP call reads as one plain sentence with its title", () => {
  const command = 'mcp__overseer__overseer_job_add\n{"title": "Spam-filter Excellent Webworld cold outreach", "prompt": "Goal: ..."}';
  assert.equal(approvalSummary(command, "overseer overseer_job_add acts outside the sandbox"),
    "UltraBot wants to add a job to the OverSeer queue: “Spam-filter Excellent Webworld cold outreach”");
  assert.equal(approvalSummary('mcp__overseer__overseer_job_cancel\n{"id": "J-0042"}', "r"), "UltraBot wants to cancel a job in the OverSeer queue: “J-0042”");
  assert.equal(approvalSummary('mcp__vault__note_create\n{"name": "Call notes"}', "r"), "UltraBot wants to create a note in the vault: “Call notes”");
});

test("anything that is not an MCP call keeps the guard's own reason", () => {
  assert.equal(approvalSummary("rm -rf build/", "deletes files"), "deletes files");
  assert.equal(approvalSummary("mcp__x__tool_run\nnot json", "r"), "UltraBot wants to run a tool in x");
});
