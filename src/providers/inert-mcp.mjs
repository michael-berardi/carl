// Inventory-only MCP server for the Claude route: Claude Code sees Carl's tools here, but cannot run them.
// Carl executes every tool itself. Usage: node inert-mcp.mjs <tools.json>
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  let result = {};
  if (row.method === "initialize") {
    result = { protocolVersion: row.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "carl-inert-inventory", version: "1" } };
  } else if (row.method === "tools/list") {
    result = { tools };
  } else if (row.method === "tools/call") {
    result = { isError: true, content: [{ type: "text", text: "Denied: this inventory is inert; Carl executes tools." }] };
  }
  if (row.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\n");
});
