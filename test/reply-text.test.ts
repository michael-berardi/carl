import { test } from "node:test";
import assert from "node:assert/strict";
import { stripReasoningTags } from "../src/reply-text.ts";
import { assistantText } from "../src/brain.ts";

test("a stray reasoning close tag with an id is removed from the end of a reply", () => {
  // The exact fragment from the 0.16.6 probe: the reply was delivered as "PONG</think:6124c78e>".
  assert.equal(stripReasoningTags("PONG</think:6124c78e>"), "PONG");
  assert.equal(stripReasoningTags("Done.</think>"), "Done.");
  assert.equal(stripReasoningTags("<think:abc12>Answer"), "Answer");
  assert.equal(stripReasoningTags("<thinking>secret plan</thinking>Answer"), "Answer");
  assert.equal(stripReasoningTags("Before <think>hidden</think> after"), "Before  after");
});

test("text that is not a reasoning tag is left alone", () => {
  assert.equal(stripReasoningTags("I think the plan works."), "I think the plan works.");
  assert.equal(stripReasoningTags("a < b and c > d"), "a < b and c > d");
  assert.equal(stripReasoningTags("use <div> in HTML"), "use <div> in HTML");
});

test("a tag quoted inside a fenced code block or an inline code span survives", () => {
  const fenced = "Here is the fix:\n```html\n<think>example</think>\n```\nPONG</think:6124c78e>";
  assert.equal(stripReasoningTags(fenced), "Here is the fix:\n```html\n<think>example</think>\n```\nPONG");
  assert.equal(stripReasoningTags("Write `</think>` to close it."), "Write `</think>` to close it.");
  assert.equal(stripReasoningTags("~~~\n</think:9>\n~~~"), "~~~\n</think:9>\n~~~");
});

test("the model's final reply and the portal transcript both strip the fragment", () => {
  const msg = { role: "assistant", content: [{ type: "text", text: "PONG</think:6124c78e>" }] };
  assert.equal(assistantText(msg), "PONG");
  const split = { role: "assistant", content: [{ type: "text", text: "PONG" }, { type: "text", text: "</think:6124c78e>" }] };
  assert.equal(assistantText(split), "PONG");
});
