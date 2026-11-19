import { test } from "node:test";
import assert from "node:assert/strict";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";

// Reasoning models expect their earlier thinking back on every agent step. A harness that drops it on
// OpenAI-compatible endpoints makes the model redo work (OpenClaw's requiresReasoningContentOnAssistantMessages
// finding, 2026-11). Carl relies on pi-ai replaying it; this fails if a dependency upgrade stops doing so.

const THOUGHT = "Plan: read config.ts first, then patch the parser. ".repeat(80); // a long thought, ~4 KB

/** Build the next request body without any network call: onPayload captures it, then aborts the request. */
async function nextRequest(model: any, assistant: any) {
  let captured: any;
  const ev = stream(model, {
    systemPrompt: "",
    messages: [
      { role: "user", content: "fix the parser", timestamp: 1 },
      assistant,
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 3 },
    ],
    tools: [],
  } as any, { apiKey: "test", onPayload: (p: any) => { captured = p; throw new Error("captured"); } } as any);
  for await (const _ of ev) { /* drain until the aborted request ends the stream */ }
  assert.ok(captured, "request body was not built");
  return captured.messages.find((m: any) => m.role === "assistant");
}

function custom(provider: string, baseUrl: string, compat: Record<string, unknown> = {}) {
  // A user-defined OpenAI-compatible endpoint: no built-in compat, flag left unset (the OpenClaw failure case).
  return { provider, id: "reasoner", name: "reasoner", api: "openai-completions", baseUrl, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192, compat };
}

function turn(model: any, signature: string) {
  return {
    role: "assistant", api: "openai-completions", provider: model.provider, model: model.id,
    content: [{ type: "thinking", thinking: THOUGHT, thinkingSignature: signature }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 2,
  };
}

for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
  test(`a custom OpenAI-compatible endpoint gets its earlier ${field} back without any compat flag`, async () => {
    const model = custom("my-endpoint", "https://llm.example.test/v1");
    const sent = await nextRequest(model, turn(model, field));
    assert.equal(sent[field], THOUGHT, `${field} was not replayed in full`);
  });
}

test("thinking from a different model is not replayed (signatures are model-specific)", async () => {
  const model = custom("my-endpoint", "https://llm.example.test/v1");
  const sent = await nextRequest(model, { ...turn(model, "reasoning_content"), model: "another-model" });
  assert.equal(sent.reasoning_content, undefined);
});

test("structured reasoning_details (OpenRouter) are replayed verbatim", async () => {
  const model = custom("openrouter", "https://openrouter.ai/api/v1");
  const details = [{ type: "reasoning.text", text: THOUGHT, format: "unknown", index: 0 }];
  const sent = await nextRequest(model, turn(model, JSON.stringify(details)));
  assert.deepEqual(sent.reasoning_details, details);
});
