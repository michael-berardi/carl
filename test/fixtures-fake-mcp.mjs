// A minimal MCP stdio server for tests: two tools, every call appended to the log file given as argv[2].
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.argv[2];
const tools = [
  { name: "overseer_status", description: "Read the status.", inputSchema: { type: "object", properties: {} } },
  { name: "overseer_send", description: "Type text into a terminal.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") return reply(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-overseer", version: "1" } });
  if (m.method === "tools/list") return reply(m.id, { tools });
  if (m.method === "tools/call") {
    appendFileSync(log, `${m.params.name}\n`);
    return reply(m.id, { content: [{ type: "text", text: `ran ${m.params.name}` }] });
  }
  if (m.method === "ping") return reply(m.id, {});
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } }) + "\n");
});
