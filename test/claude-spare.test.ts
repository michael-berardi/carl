// Exercise spare adoption with a deterministic CLI fixture and loopback upstream; no login or network required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { disposeSpares, spareCount, streamClaude } from "../src/providers/claude-code.ts";

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

test("a tool round pre-starts the next call's process; a different request shape does not use it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carl-spare-test-"));
  const bin = join(dir, "claude-fixture.cjs");
  // A minimal CLI: acknowledge replay frames, then forward the fake upstream's SSE as stream-json.
  writeFileSync(bin, `#!${process.execPath}
const http = require("node:http");
const readline = require("node:readline");
const frames = [];
readline.createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  frames.push(frame);
  if (frame.shouldQuery === false) console.log(JSON.stringify({ type: "result", num_turns: 0, is_error: false }));
}).on("close", () => {
  const req = http.request(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST" }, res => {
    let pending = "";
    res.setEncoding("utf8");
    res.on("data", chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\\n\\n")) !== -1) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split("\\n").find(line => line.startsWith("data: "));
        if (data) console.log(JSON.stringify({ type: "stream_event", event: JSON.parse(data.slice(6)) }));
      }
    });
  });
  req.on("error", e => { console.error(e); process.exitCode = 1; });
  req.end(JSON.stringify({ messages: frames.map(f => f.message) }));
});
`, { mode: 0o755 });
  let n = 0;
  const srv = createServer((req, res) => {
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
    let final: any;
    for await (const e of streamClaude(model, { messages } as any, { reasoning } as any, { command: bin, workdir: dir, tmpRoot: dir, log: (_l, m) => logs.push(m) })) {
      if (e.type === "done") final = e.message;
      if (e.type === "error") throw new Error(e.error.errorMessage);
    }
    return { final };
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
    assert.ok(!logs.some((message) => message.includes("retrying with a fresh one")));
    assert.equal(n, 2);
    assert.equal(spareCount(), 0);
    // A different shape (effort) must not adopt a spare made for another one.
    n = 0;
    logs.length = 0;
    const m2: any[] = [{ role: "system", content: "sys", toolsAdded: tools, timestamp: 1 }, { role: "user", content: "again", timestamp: 2 }];
    const a = await call(m2, "medium");
    m2.push(a.final, { role: "toolResult", toolCallId: "tu1", toolName: "t", content: [{ type: "text", text: "r" }], isError: false, timestamp: 3 });
    await call(m2, "high");
    assert.ok(!logs.includes("claude call used a pre-started process"));
    assert.equal(spareCount(), 1);
    assert.equal(n, 2);
  } finally {
    disposeSpares();
    if (prev === undefined) delete process.env.CARL_CLAUDE_UPSTREAM;
    else process.env.CARL_CLAUDE_UPSTREAM = prev;
    await new Promise<void>((resolve, reject) => srv.close((err) => err ? reject(err) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
