// The warm spare: a tool round pre-starts the next `claude -p`, and the next call with the same shape adopts it.
// Runs the real Claude Code CLI against a loopback fake upstream; skipped when the CLI is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { disposeSpares, resolveClaude, spareCount, streamClaude } from "../src/providers/claude-code.ts";

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

// This test drives the real CLI, so it needs one that is installed *and* logged in: an expired OAuth session would
// otherwise fail the suite for a reason that has nothing to do with Carl. `auth status` is a local check (no network,
// no quota); a CLI too old to answer it keeps the old behaviour and runs the test.
function claudeSkip(): string | false {
  const bin = resolveClaude(undefined, process.env);
  if (!bin) return "claude CLI not installed";
  let out = "";
  try {
    out = execFileSync(bin, ["auth", "status"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // A logged-out CLI exits non-zero and still prints its status JSON on stdout.
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  try {
    const status = JSON.parse(out) as { loggedIn?: boolean };
    if (status?.loggedIn === false) return "claude CLI is installed but not logged in (run `claude auth login`)";
  } catch {
    // No usable `auth status` output: run the test as before rather than hiding a real failure.
  }
  return false;
}

test("a tool round pre-starts the next call's process; a different request shape does not use it", { skip: claudeSkip() }, async () => {
  let n = 0;
  let reqAt = 0;
  const srv = createServer((req, res) => {
    reqAt = performance.now();
    n++;
    req.resume();
    req.on("end", () => {
      const tool = n === 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }));
      if (tool) {
        res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "mcp__carl__t", input: {} } }));
        res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }));
      } else {
        res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
      }
      res.write(sse({ type: "content_block_stop", index: 0 }));
      res.write(sse({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } }));
      res.write(sse({ type: "message_stop" }));
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const prev = process.env.CARL_CLAUDE_UPSTREAM;
  process.env.CARL_CLAUDE_UPSTREAM = `http://127.0.0.1:${(srv.address() as any).port}`;
  const logs: string[] = [];
  const model = { id: "claude-sonnet-5-5", maxTokens: 64000 } as any;
  const tools = [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }];
  const call = async (messages: any[], reasoning = "medium") => {
    const t0 = performance.now();
    let final: any;
    for await (const e of streamClaude(model, { messages } as any, { reasoning } as any, { log: (_l, m) => logs.push(m) })) {
      if (e.type === "done") final = e.message;
      if (e.type === "error") throw new Error(e.error.errorMessage);
    }
    return { final, toRequest: reqAt - t0 };
  };
  try {
    const messages: any[] = [{ role: "system", content: "sys", toolsAdded: tools, timestamp: 1 }, { role: "user", content: "hi", timestamp: 2 }];
    const first = await call(messages);
    assert.equal(first.final.stopReason, "toolUse");
    assert.equal(spareCount(), 1);
    messages.push(first.final, { role: "toolResult", toolCallId: "tu1", toolName: "t", content: [{ type: "text", text: "r" }], isError: false, timestamp: 3 });
    const second = await call(messages);
    assert.equal(second.final.content[0].text, "ok");
    assert.ok(logs.includes("claude call used a pre-started process"));
    assert.equal(spareCount(), 0);
    assert.ok(second.toRequest < first.toRequest, `adopted call reached the API in ${second.toRequest.toFixed(0)} ms vs ${first.toRequest.toFixed(0)} ms cold`);
    // A different shape (effort) must not adopt a spare made for another one.
    n = 0;
    logs.length = 0;
    const m2: any[] = [{ role: "system", content: "sys", toolsAdded: tools, timestamp: 1 }, { role: "user", content: "again", timestamp: 2 }];
    const a = await call(m2, "medium");
    m2.push(a.final, { role: "toolResult", toolCallId: "tu1", toolName: "t", content: [{ type: "text", text: "r" }], isError: false, timestamp: 3 });
    await call(m2, "high");
    assert.ok(!logs.includes("claude call used a pre-started process"));
  } finally {
    disposeSpares();
    if (prev === undefined) delete process.env.CARL_CLAUDE_UPSTREAM;
    else process.env.CARL_CLAUDE_UPSTREAM = prev;
    srv.close();
  }
});
