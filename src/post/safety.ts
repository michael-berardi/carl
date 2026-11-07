// What Carl knows about which tools of a trusted MCP server only read: the tools whose listing carried `readOnlyHint: true`.
// The gateway caches that (state/mcp-readonly.json) each time it lists a server's tools; the guard reads it so those tools run
// without asking. The operator can add names in carl.json guard.readOnlyTools. Carl hardcodes no server or tool name.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const cachePath = (home: string) => join(home, "state", "mcp-readonly.json");

/** The "server/tool" names whose MCP listing carried readOnlyHint: true (written by the gateway; empty when never listed). */
export function readOnlyCache(home: string): { readOnly: Set<string>; listed: string[] } {
  try {
    const entries = Object.entries(JSON.parse(readFileSync(cachePath(home), "utf8"))?.readOnly ?? {});
    return { readOnly: new Set(entries.filter(([, ok]) => ok === true).map(([k]) => k)), listed: entries.map(([k]) => k) };
  } catch { return { readOnly: new Set(), listed: [] }; }
}

/** Record the listing's annotations: `listed` is every "server/tool" seen, `readOnly` the ones hinted read-only. */
export function writeReadOnlyCache(home: string, listed: Record<string, boolean>): void {
  const file = cachePath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ readOnly: listed }, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
}

