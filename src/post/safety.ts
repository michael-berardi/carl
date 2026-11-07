// Posting is only as strong as the approval card if nothing the agent may run unasked can type into a terminal or start an
// unsandboxed worker: such a thing can run `carl post now`, read the approval key, or drive the browser relay directly.
// The rule is structural, not a list of names that goes stale: while post.accounts is configured, posting is OFF unless
// every guard.allowTools and guard.operatorTools entry can only match tools that are verifiably read-only. A tool is
// verifiably read-only when it is on the built-in read-only list (DEFAULT_TRUSTED_READONLY) or its MCP listing carried
// `readOnlyHint: true` (cached by the gateway in state/mcp-readonly.json). An entry that matches a made-up future tool
// name (a canary) is refused, which catches `.*` and `^overseer/coordinator_.*`. The known-dangerous verbs are a second check.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TRUSTED_READONLY } from "../guard.ts";

/** Verbs that type into a terminal, open or message a worker, queue/approve/redirect work, or write what workers read. */
export const DANGEROUS_VERBS = [
  "send", "relay", "message", "job_add", "job_dispatch", "job_approve", "schedule_add", "open", "close", "decide",
  "job_note", "job_wake", "job_redrive", "job_reroute", "job_switch", "job_correct",
];
/** The tool-name prefixes of the OverSeer/UltraTerm control server (the installed one uses coordinator_; older ones overseer_). */
export const CONTROL_PREFIXES = ["overseer_", "coordinator_"];
/** Kept for callers: every dangerous tool name under both prefixes. */
export const UNSANDBOXED_TOOLS = CONTROL_PREFIXES.flatMap((p) => DANGEROUS_VERBS.map((v) => p + v));

/** Names that no server has today: an entry matching one would also match a tool added later, unreviewed. */
const CANARIES = [...CONTROL_PREFIXES.map((p) => p + "brand_new_tool"), "brand_new_tool"];

const cachePath = (home: string) => join(home, "state", "mcp-readonly.json");

/** Concrete "server/tool" names the built-in read-only patterns allow on `server` (each pattern is `^prefix(?:a|b)_(x|y)$`). */
export function builtInReadNames(server: string): string[] {
  return DEFAULT_TRUSTED_READONLY.flatMap(([src]) => expandNames(src, server) ?? []);
}

/** The concrete "server/tool" names an anchored pattern built only from literals and (a|b) groups matches, or undefined when it
 * has any wildcard or class beyond a leading [^/]+ server (it can then match names nobody listed). */
export function expandNames(src: string, server: string): string[] | undefined {
  if (!/^\^.*\$$/.test(src)) return undefined;
  {
    const body = src.replace(/^\^/, "").replace(/\$$/, "");
    // Expand every (?:...) / (...) group; a [^/]+ server wildcard becomes this server.
    let names = [body.replace(/^\[\^\/\]\+/, server).replace(/\\\//g, "/")];
    for (;;) {
      const next: string[] = [];
      let grew = false;
      for (const n of names) {
        const m = /\((?:\?:)?([^()]*)\)/.exec(n);
        if (!m) { next.push(n); continue; }
        grew = true;
        for (const alt of m[1].split("|")) next.push(n.slice(0, m.index) + alt + n.slice(m.index + m[0].length));
      }
      names = next;
      if (!grew) break;
    }
    if (names.some((n) => !/^[\w.-]+\/[\w.-]+$/.test(n) || !new RegExp(src).test(n))) return undefined;
    return names.filter((n) => n.startsWith(`${server}/`));
  }
}

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

export interface SafetyInput {
  accounts: Record<string, unknown>;
  allowTools: [string, string][];
  operatorTools?: [string, string][];
  trustedMcp: string[];
  /** "server/tool" names the cache holds as read-only, and every name the cache has seen (for matching). */
  readOnly?: Set<string>;
  listed?: string[];
  /** cfg.work is set and a telegram group has a work project. */
  workGroup?: boolean;
  /** The operator states work.command runs under a sandbox (work.sandboxed: true); Carl cannot tell. */
  workSandboxed?: boolean;
}

/** The entries (regex source, note) that can match something that is not verifiably read-only. */
export function unsafeAllowTools(entries: [string, string][], trustedMcp: string[], readOnly: Set<string> = new Set(), listed: string[] = []): { entry: string; tools: string[] }[] {
  const servers = [...new Set(["overseer", ...trustedMcp])];
  const out: { entry: string; tools: string[] }[] = [];
  for (const [src] of entries) {
    let re: RegExp;
    try { re = new RegExp(src); } catch { out.push({ entry: src, tools: ["(not a valid pattern)"] }); continue; }
    const hits = new Set<string>();
    let verified = false;
    for (const s of servers) {
      for (const t of CANARIES) if (re.test(`${s}/${t}`)) hits.add(`any future tool (${t})`);
      for (const t of UNSANDBOXED_TOOLS) if (re.test(`${s}/${t}`)) hits.add(t);
      for (const full of listed) {
        const [srv, ...rest] = full.split("/");
        const tool = rest.join("/");
        if (srv !== s || !re.test(full)) continue;
        const known = readOnly.has(full) || DEFAULT_TRUSTED_READONLY.some(([r]) => new RegExp(r).test(full));
        if (!known) hits.add(tool); else verified = true;
      }
      // The built-in read-only patterns, expanded to concrete names: an entry that matches one of them is a verified read.
      for (const name of builtInReadNames(s)) if (re.test(name)) verified = true;
    }
    // An entry that spells out exact names: every one of them must be a known read (a mixed list hides a write behind a read).
    for (const s of servers) {
      for (const name of expandNames(src, s) ?? []) {
        const known = readOnly.has(name) || builtInReadNames(s).includes(name);
        if (!known) hits.add(name.slice(s.length + 1));
      }
    }
    // Fail closed: an entry that matches no tool known to be read-only (an exact name the listing never showed, say) is refused.
    if (!hits.size && !verified) hits.add("a tool not known to be read-only");
    if (hits.size) out.push({ entry: src, tools: [...hits] });
  }
  return out;
}

/** The refusal text, or undefined when posting may be enabled. */
export function postingBlockedReason(input: SafetyInput): string | undefined {
  if (!Object.keys(input.accounts).length) return undefined;
  const reasons: string[] = [];
  const bad = [
    ...unsafeAllowTools(input.allowTools, input.trustedMcp, input.readOnly, input.listed).map((b) => ({ ...b, where: "guard.allowTools" })),
    ...unsafeAllowTools(input.operatorTools ?? [], input.trustedMcp, input.readOnly, input.listed).map((b) => ({ ...b, where: "guard.operatorTools" })),
  ];
  if (bad.length) {
    const which = bad.map((b) => `${b.where} ${JSON.stringify(b.entry)} (could run ${b.tools.join(", ")})`).join("; ");
    reasons.push(`these entries can match tools that type into a terminal, run outside the sandbox or are not known to be read-only, and anything they start could post without your card or read the approval key: ${which}. Remove ${bad.length === 1 ? "that entry" : "those entries"} (the tools then ask you each time, with no quoted-words shortcut) or narrow ${bad.length === 1 ? "it" : "them"} to named read-only tools, restart Carl, and posting turns on`);
  }
  if (input.workGroup && !input.workSandboxed)
    reasons.push(`the work module is on (work.command with a group work project): work_queue runs with no ask and the job it starts may run outside the sandbox, where it can post or read the approval key. Carl cannot tell whether work.command is sandboxed; remove "work" or set "work": {"command": [...], "sandboxed": true} only if your queue script's jobs run in a sandbox that closes the approval key and the browser relay`);
  return reasons.length ? `Posting is OFF: ${reasons.join(". Also: ")}.` : undefined;
}
