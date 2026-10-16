/**
 * The one plain sentence an approval card leads with, so the operator reads what the bot wants to do before the exact call
 * (which the card still shows in full, never truncated). An MCP call reads "add a job to the OverSeer queue: “Title”"; anything
 * else falls back to the guard's reason. Pure: no I/O.
 */
const VERBS: Record<string, string> = {
  add: "add", create: "create", propose: "propose", approve: "approve", cancel: "cancel", close: "close", open: "open",
  send: "send", run: "run", update: "update", set: "set", delete: "delete", remove: "remove", report: "report", decide: "decide",
};
const SERVER_NAMES: Record<string, string> = { overseer: "the OverSeer queue", ultramemory: "UltraTerm memory", vault: "the vault" };
const TITLE_KEYS = ["title", "name", "subject", "id", "summary"] as const;

export function approvalSummary(command: string, reason: string): string {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(command.trim());
  if (!match) return reason;
  const [, server, tool, rest] = match;
  // overseer_job_add -> ["job", "add"]: drop the server prefix, then read "<noun> <verb>" or "<verb> <noun>".
  const words = tool.replace(new RegExp(`^${server}_`), "").split("_").filter(Boolean);
  const verbAt = words.findIndex((w) => w in VERBS);
  const verb = verbAt >= 0 ? VERBS[words[verbAt]] : "run";
  const noun = words.filter((_, i) => i !== verbAt).join(" ");
  let title = "";
  try {
    const args = JSON.parse(rest || "{}");
    if (args && typeof args === "object") {
      const key = TITLE_KEYS.find((k) => typeof args[k] === "string" && args[k].trim());
      if (key) title = String(args[key]).trim().replace(/\s+/g, " ").slice(0, 160);
    }
  } catch {
    // not JSON: the exact text below the sentence still shows everything
  }
  const where = SERVER_NAMES[server] ?? server;
  const what = noun ? `${verb} ${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}` : verb;
  return `UltraBot wants to ${what} ${verb === "add" || verb === "propose" ? "to" : "in"} ${where}${title ? `: “${title}”` : ""}`;
}
