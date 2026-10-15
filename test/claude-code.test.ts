import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrames, Capture, normalizeSchema, pinMessageBreakpoint, signatureTag } from "../src/providers/claude-code.ts";

const ctx = (messages: any[]) => ({ messages }) as any;

test("buildFrames: merges user turns, pairs tools, drops orphans and blanks, ends with a user frame", () => {
  const tag = signatureTag(undefined, "claude-sonnet-5-5");
  const { frames } = buildFrames(ctx([
    { role: "system", content: "SYS", toolsAdded: [{ name: "bash", description: "d", parameters: { type: "object" } }], timestamp: 0 },
    { role: "user", content: "hi", timestamp: 1 },
    { role: "assistant", provider: "claude-code", content: [
      { type: "thinking", thinking: "t", thinkingSignature: tag + "SIG" },
      { type: "thinking", thinking: "foreign", thinkingSignature: "carl1:other:X" },
      { type: "text", text: "   " },
      { type: "toolCall", id: "call|1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "orphan", name: "bash", arguments: {} },
    ], timestamp: 2 },
    { role: "toolResult", toolCallId: "call|1", toolName: "bash", content: [{ type: "text", text: "" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "image", data: "x".repeat(10), mimeType: "image/heic" }], timestamp: 4 },
  ]), false, tag);
  assert.equal(frames.length, 3);
  const assistant = frames[1].message.content;
  assert.deepEqual(assistant.map((b: any) => b.type), ["thinking", "tool_use"]);
  assert.equal(assistant[0].signature, "SIG", "own signature replayed without the tag");
  assert.equal(assistant[1].id, "call_1", "tool ids sanitised");
  const lastUser = frames[2].message.content;
  assert.equal(lastUser[0].type, "tool_result");
  assert.equal(lastUser[0].tool_use_id, "call_1");
  assert.deepEqual(lastUser[0].content, [{ type: "text", text: "(no output)" }], "blank tool output never sent as an empty block");
  assert.match(lastUser[1].text, /image omitted: image\/heic/);
});

test("buildFrames: signatures from another login or model are dropped", () => {
  const ownTag = signatureTag("/a", "claude-sonnet-5-5");
  const { frames } = buildFrames(ctx([
    { role: "user", content: "q", timestamp: 1 },
    { role: "assistant", provider: "claude-code", content: [{ type: "thinking", thinking: "t", thinkingSignature: ownTag + "S" }, { type: "text", text: "a" }], timestamp: 2 },
    { role: "user", content: "q2", timestamp: 3 },
  ]), false, signatureTag("/b", "claude-sonnet-5-5"));
  assert.deepEqual(frames[1].message.content.map((b: any) => b.type), ["text"]);
});

test("Capture rebuilds the message, guards cut-off tool arguments, records stream errors", () => {
  const c = new Capture();
  const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  c.feed(sse({ type: "message_start", message: { id: "m", content: [], usage: { input_tokens: 5 } } }));
  c.feed(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  c.feed(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } }) + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }));
  c.feed(sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "mcp__carl__bash", input: {} } }));
  c.feed(sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"l' } }));
  c.feed(sse({ type: "content_block_stop", index: 1 }));
  c.feed(sse({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } }));
  c.feed(sse({ type: "message_stop" }));
  assert.equal(c.message.content[0].text, "hello");
  assert.deepEqual(c.message.content[1].input, {});
  assert.ok(c.truncatedArgs);
  assert.equal(c.message.usage.output_tokens, 9);
  assert.ok(c.complete);
  const e = new Capture();
  e.feed(sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  assert.equal(e.streamError?.type, "overloaded_error");
});

test("normalizeSchema strips null branches anywhere and top-level combinators", () => {
  const s = normalizeSchema({ anyOf: [{ type: "object" }], properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] }, b: { type: ["number", "null"] } } });
  assert.equal(s.anyOf, undefined);
  assert.deepEqual(s.properties.a, { type: "string" });
  assert.equal(s.properties.b.type, "number");
});

test("pinMessageBreakpoint moves a trailing mark onto the replayed prefix and is fail-open", () => {
  const queried = [{ type: "tool_result", tool_use_id: "t1", content: "out" }];
  const body = { system: [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }], messages: [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }, { type: "text", text: "<reminder date>", cache_control: { type: "ephemeral" } }] },
  ] };
  const out = JSON.parse(pinMessageBreakpoint(Buffer.from(JSON.stringify(body)), queried as any).toString());
  assert.equal(out.messages[2].content[1].cache_control, undefined, "mark removed from per-request context");
  assert.ok(out.messages[2].content[0].cache_control, "mark now on the replayed tool result (the stable prefix)");
  assert.ok(out.system[0].cache_control, "system marks untouched");
  const junk = Buffer.from("not json");
  assert.equal(pinMessageBreakpoint(junk, queried as any), junk);
});
