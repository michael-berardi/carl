// Posting is only as strong as the approval card if nothing the agent may run unasked can type into a terminal or start an
// unsandboxed worker: such a thing can run `carl post now`, read the approval key, or drive the browser relay directly.
// So while post.accounts is configured, guard.allowTools must not auto-allow any of these tools; config load refuses to
// enable posting (it stays off, `carl post status` says why) until they are removed from allowTools (they then ask).

/** Trusted-MCP tools that act outside the sandbox: type into a terminal, open or message a worker, queue or approve work that runs unsandboxed. */
export const UNSANDBOXED_TOOLS = [
  "overseer_send", "overseer_message", "overseer_open", "overseer_close",
  "overseer_job_add", "overseer_job_dispatch", "overseer_job_approve", "overseer_schedule_add",
];

/** The allowTools entries (regex source, note) that auto-allow an unsandboxed tool of any trusted server (or of "overseer"). */
export function unsafeAllowTools(allowTools: [string, string][], trustedMcp: string[]): { entry: string; tools: string[] }[] {
  const servers = [...new Set(["overseer", ...trustedMcp])];
  const out: { entry: string; tools: string[] }[] = [];
  for (const [src] of allowTools) {
    let re: RegExp;
    try { re = new RegExp(src); } catch { continue; }
    const tools = UNSANDBOXED_TOOLS.filter((t) => servers.some((s) => re.test(`${s}/${t}`)));
    if (tools.length) out.push({ entry: src, tools });
  }
  return out;
}

/** The refusal text, or undefined when posting may be enabled. */
export function postingBlockedReason(accounts: Record<string, unknown>, allowTools: [string, string][], trustedMcp: string[]): string | undefined {
  if (!Object.keys(accounts).length) return undefined;
  const bad = unsafeAllowTools(allowTools, trustedMcp);
  if (!bad.length) return undefined;
  const which = bad.map((b) => `${JSON.stringify(b.entry)} (allows ${b.tools.join(", ")})`).join("; ");
  return `Posting is OFF: guard.allowTools in carl.json auto-allows tools that can type into a terminal or run outside the sandbox, and anything they start could post without your card or read the approval key: ${which}. Remove ${bad.length === 1 ? "that entry" : "those entries"} from guard.allowTools (the tools then ask you each time), restart Carl, and posting turns on.`;
}
