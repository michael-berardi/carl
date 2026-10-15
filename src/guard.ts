// Tool guard: a tripwire against destructive mistakes, not a sandbox. Carl runs tools with the operator's own
// permissions; this gate makes the obviously destructive impossible ("hardline") and the risky explicit (the
// operator approves it in chat). Unattended runs (schedules, API without a chat) cannot ask, so they refuse.
//
// Commands are split into segments at ; && || | & newlines and $( ), and judged by their verb, so "rg shutdown"
// is a search, not a shutdown. Quoting and backslashes are removed before matching. Anything that hides the
// real command (eval, sh -c, interpreters with inline code, a variable as the verb, base64 decoding) asks first.
import { spawn } from "node:child_process";
import { constants as fsc, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { detectSupportedImageMimeTypeFromFile, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";

export type Verdict = { level: "ok" } | { level: "dangerous" | "hardline"; reason: string };

export interface GuardRules {
  /** Extra never-run patterns: [regex source, reason], matched against the normalised command. */
  hardline?: [string, string][];
  /** Extra ask-first patterns: [regex source, reason]. */
  dangerous?: [string, string][];
  /** Extra paths that write/edit must ask before touching. */
  protectedPaths?: string[];
  /** Extra files read must never open. */
  secretPaths?: string[];
  /** Inside protectedPaths, these stay writable (the agent's working areas). */
  writablePaths?: string[];
  /** Base for relative tool paths (the agent's working directory). */
  cwd?: string;
  /** Programs the kernel sandbox refuses to run: refused up front instead of asking for an approval that cannot help. */
  noExec?: string[];
  /** MCP servers that run outside the sandbox: their tools ask first unless they match a read-only pattern. */
  trustedMcp?: string[];
  /** Extra "server/tool" patterns of trusted servers that run without asking: [regex, reason]. */
  allowTools?: [string, string][];
}

/** Remove quoting so `"rm" -rf '~'` reads as `rm -rf ~`. */
export function normalise(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\\(.)/g, "$1").replace(/["']/g, "").replace(/\$\{?IFS\}?/g, " ");
}

/**
 * Split a shell command into simple commands, respecting quotes and skipping heredoc bodies. Separators are
 * ; && || | & newlines, $( ), backticks, ( ) and { }. Each segment's words come back unquoted.
 */
export function splitCommands(command: string): string[][] {
  const segs: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const pendingHeredocs: { delim: string; strip: boolean }[] = [];
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\") { if (command[i + 1] === "\n") { i++; continue; } word += command[++i] ?? ""; inWord = true; continue; }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      // Heredoc: remember the delimiter; its body (next lines) is data, not commands.
      endWord();
      let j = i + 2;
      const strip = command[j] === "-";
      if (strip) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      const m = command.slice(j).match(/^(['"]?)([A-Za-z0-9_.-]+)\1/);
      if (m) { pendingHeredocs.push({ delim: m[2], strip }); i = j + m[0].length - 1; continue; }
    }
    if (c === "\n") {
      endSeg();
      while (pendingHeredocs.length) {
        const { delim, strip } = pendingHeredocs.shift()!;
        let next = command.indexOf("\n", i + 1);
        for (;;) {
          const line = command.slice(i + 1, next === -1 ? undefined : next);
          i = next === -1 ? command.length : next;
          if ((strip ? line.trim() : line) === delim || next === -1) break;
          next = command.indexOf("\n", i + 1);
        }
      }
      continue;
    }
    if (c === "$" && command[i + 1] === "(") { endSeg(); i++; continue; }
    if (c === "$" && command[i + 1] === "{") {
      // ${VAR} and ${VAR:-x} stay one word (a brace here is not a command group).
      const close = command.indexOf("}", i + 2);
      if (close !== -1) { word += command.slice(i, close + 1); inWord = true; i = close; continue; }
    }
    if (";&|`(){}".includes(c)) { endSeg(); continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    word += c;
    inWord = true;
  }
  endSeg();
  return segs;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time", "coproc"]);
const NOT_COMMANDS = new Set(["for", "case", "select", "function", "done", "fi", "esac", "in"]);
const WRAPPERS = new Set(["command", "builtin", "nohup", "nice", "ionice", "exec", "env", "caffeinate", "timeout", "gtimeout", "setsid", "stdbuf", "arch", "chrt", "unbuffer", "script", "flock"]);

/** Command segments with their verb (first word after keywords, env assignments and transparent wrappers). */
export function segments(command: string): { verb: string; args: string; text: string }[] {
  const out: { verb: string; args: string; text: string }[] = [];
  for (let words of splitCommands(command)) {
    for (;;) {
      while (words.length && (KEYWORDS.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words = words.slice(1);
      if (!words.length || NOT_COMMANDS.has(words[0])) { words = []; break; }
      if (words[0] === "command" && /^-[vV]$/.test(words[1] ?? "")) { words = []; break; } // a lookup, not a run
      if (!WRAPPERS.has(words[0])) break;
      const wrapper = words[0];
      words = words.slice(1);
      while (words.length && (/^-/.test(words[0]) || /^\d+(\.\d+)?[smhd]?$/.test(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
        const flag = words[0];
        words = words.slice(1);
        if (wrapper === "flock" && !flag.startsWith("-")) break;
      }
      if (wrapper === "script" || wrapper === "flock") words = words.slice(1); // script FILE cmd / flock LOCK cmd
    }
    if (!words.length) continue;
    const verb = words[0].replace(/^.*\//, ""); // /bin/rm -> rm
    out.push({ verb, args: words.slice(1).join(" "), text: words.join(" ") });
  }
  return out;
}

const HOME = homedir();
const ROOTS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*", "${HOME}", "${HOME}/", "${HOME}/*", "${HOME}", "${HOME}/", "${HOME}/*", "/Users", "/Users/", "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt", "/private", HOME, HOME + "/", HOME + "/*"]);
const isRoot = (t: string) => ROOTS.has(t) || ROOTS.has(t.replace(/\/+$/, "")) || /^\/Users\/[^/]+\/?\*?$/.test(t);

function gitSub(args: string): { sub: string; rest: string } {
  // Skip git's global options (-C dir, -c k=v, --git-dir=..., --no-pager ...) to find the subcommand.
  const words = args.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(words[i]) ? 2 : 1;
  return { sub: words[i] ?? "", rest: words.slice(i + 1).join(" ") };
}

function judgeSegment(s: { verb: string; args: string; text: string }): Verdict {
  const { verb, args } = s;
  const words = args.split(/\s+/).filter(Boolean);
  const flags = words.filter((w) => w.startsWith("-")).join(" ");
  const targets = words.filter((w) => !w.startsWith("-"));
  if (["sudo", "doas", "su"].includes(verb)) return { level: "hardline", reason: `${verb} (privilege escalation)` };
  if (["shutdown", "halt", "reboot", "poweroff"].includes(verb)) return { level: "hardline", reason: "machine shutdown or reboot" };
  if (/^(mkfs|newfs)/.test(verb) || (verb === "diskutil" && /\b(erase\w*|zero\w*|secureErase|partitionDisk|reformat)\b/i.test(args))) return { level: "hardline", reason: "disk format or erase" };
  if (verb === "dd" && /\bof=\/dev\/(?!null\b|stdout\b|stderr\b)/.test(args)) return { level: "hardline", reason: "raw write to a device" };
  if (verb === "rm") {
    const recursive = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags);
    if (recursive && targets.some(isRoot)) return { level: "hardline", reason: "recursive delete of a root, system or home directory" };
    if (recursive || /(^|\s)-[a-zA-Z]*f|--force/.test(flags)) return { level: "dangerous", reason: "recursive or forced delete" };
  }
  if (verb === "git") {
    const { sub, rest } = gitSub(args);
    const force = /(^|\s)(-f|--force|--force-with-lease)(=\S*)?(\s|$)|(^|\s)\+\S/.test(rest);
    if (sub === "push" && force && /(^|[\s:/+])(main|master)(\s|$)/.test(rest)) return { level: "hardline", reason: "force push to main" };
    if (sub === "push") return { level: "dangerous", reason: force ? "force push" : "git push" };
    if (sub === "reset" && /--hard/.test(rest)) return { level: "dangerous", reason: "git reset --hard" };
    if (sub === "clean" && /(^|\s)(-[a-zA-Z]*f|--force)/.test(rest)) return { level: "dangerous", reason: "git clean" };
    if ((sub === "checkout" || sub === "restore") && /(^|\s)(-f\s+)?(--\s+)?\.(\s|$)/.test(rest)) return { level: "dangerous", reason: "discarding working-tree changes" };
    if (sub === "branch" && /(^|\s)-D(\s|$)/.test(rest)) return { level: "dangerous", reason: "force-deleting a branch" };
    if (sub === "stash" && /^(drop|clear)\b/.test(rest)) return { level: "dangerous", reason: "dropping stashes" };
  }
  if (["kill", "pkill", "killall"].includes(verb)) return { level: "dangerous", reason: "killing processes" };
  if (verb === "launchctl" && /\b(load|bootstrap|unload|bootout|remove|enable|disable)\b/.test(args)) return { level: "dangerous", reason: "background services" };
  if (verb === "crontab" && !/^-l\b/.test(args)) return { level: "dangerous", reason: "scheduled jobs" };
  if (verb === "chmod" && /(^|\s)-R\b|\b[0-7]?[0-7][0-7]7\b|\b[oa]\+w\b/.test(args)) return { level: "dangerous", reason: "permission changes" };
  if (verb === "chown" && /(^|\s)-R\b/.test(args)) return { level: "dangerous", reason: "recursive ownership change" };
  if (verb === "find" && /(^|\s)(-delete|-exec(dir)?\s+rm\b)/.test(args)) return { level: "dangerous", reason: "find that deletes" };
  if (verb === "rsync" && /--delete/.test(args)) return { level: "dangerous", reason: "rsync --delete" };
  if (verb === "xargs" && /(^|\s)(rm|kill|mv|sh|bash)(\s|$)/.test(args)) return { level: "dangerous", reason: "xargs running a destructive command" };
  // Driving other programs runs code outside Carl's sandbox: ask.
  if (verb === "osascript" || verb === "automator" || (verb === "shortcuts" && /^run\b/.test(args))) return { level: "dangerous", reason: `${verb} drives other apps outside the sandbox` };
  if (verb === "open") return { level: "dangerous", reason: "open hands a file, app or URL to another program" };
  if (verb === "tmux" && /\b(send-keys|send|new-window|neww|split-window|splitw|new-session|new|run-shell|run|respawn-pane|respawn-window|pipe-pane)\b/.test(args)) return { level: "dangerous", reason: "tmux driving another terminal" };
  if (verb === "screen" && /(^|\s)-X\b/.test(args)) return { level: "dangerous", reason: "screen driving another terminal" };
  // Indirection hides the real command: ask.
  if (verb === "eval" || verb === "source" || verb === ".") return { level: "dangerous", reason: `${verb} runs code the guard cannot see` };
  if (/^(ba|z|k|da|fi)?sh$/.test(verb) && /(^|\s)-[a-zA-Z]*c(\s|$)/.test(args)) return { level: "dangerous", reason: `${verb} -c runs code the guard cannot see` };
  // A shell or interpreter with no script file reads its code from stdin (a pipe or heredoc): unseen code.
  if (/^((ba|z|k|da|fi)?sh|python[0-9.]*|node|perl|ruby|php|osascript|deno|bun)$/.test(verb)) {
    const words = args.split(/\s+/).filter(Boolean);
    const script = words.find((w) => !w.startsWith("-") || w === "-");
    if (!script || script === "-" || /^\/dev\/stdin$/.test(script)) return { level: "dangerous", reason: `${verb} reading code from stdin` };
  }
  const inline: Record<string, RegExp> = {
    python: /(^|\s)-[a-zA-Z]*c/, node: /(^|\s)(-[a-zA-Z]*[ep]|--eval|--print)/, perl: /(^|\s)-[a-zA-Z]*[eE]/, ruby: /(^|\s)-[a-zA-Z]*e/,
    php: /(^|\s)-[a-zA-Z]*r/, osascript: /(^|\s)-e/, bun: /(^|\s)(-e|--eval|-p|--print)/, deno: /(^|\s)eval\b/,
  };
  const interp = verb.replace(/[0-9.]+$/, "");
  if (inline[interp]?.test(args)) return { level: "dangerous", reason: `${verb} with inline code` };
  if (verb.startsWith("$")) return { level: "dangerous", reason: "a variable used as the command" };
  if (verb === "base64" && /(^|\s)(-d|--decode|-D)(\s|$)/.test(args)) return { level: "dangerous", reason: "decoding hidden content" };
  // Publishing, deploys, production data, billing.
  if (["npm", "pnpm", "yarn"].includes(verb) && /\bpublish\b/.test(args)) return { level: "dangerous", reason: "publishing a package" };
  if (["npm", "pnpm", "yarn", "bun"].includes(verb) && /\brun\s+deploy\b/.test(args)) return { level: "dangerous", reason: "deploy" };
  if (verb === "gh" && /\b(repo\s+(create|delete|edit|rename)|release\s+(create|delete)|pr\s+merge|secret\s+set|workflow\s+run)\b/.test(args)) return { level: "dangerous", reason: "GitHub change" };
  if (/deploy/.test(verb)) return { level: "dangerous", reason: "deploy" };
  if (["wrangler", "cf"].includes(verb) && /\b(deploy|publish|(d1\s+.*\b(execute|migrations\s+apply))|(kv\s+.*\b(delete|put))|(r2\s+.*\bdelete)|(secret\s+(put|delete)))\b/.test(args)) return { level: "dangerous", reason: "production change" };
  if (verb === "stripe" && /\b(update|cancel|create|delete)\b/.test(args)) return { level: "dangerous", reason: "billing change" };
  return { level: "ok" };
}

/** Patterns that span segments (pipes into a shell, writes into or reads of sensitive files). */
function judgeWhole(normalised: string): Verdict {
  if (/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(normalised)) return { level: "dangerous", reason: "piping a download into a shell" };
  if (/(>|\btee\b\s+(-a\s+)?)\s*\S*\/(\.ssh|\.aws|\.gnupg|LaunchAgents|LaunchDaemons)\//.test(normalised)) return { level: "dangerous", reason: "writes to credential or service directories" };
  if (/(>|\btee\b\s+(-a\s+)?)\s*\S*(\.env\b|auth\.json|\.zshrc|\.bashrc|\.zprofile|\.bash_profile|\.profile)\b/.test(normalised)) return { level: "dangerous", reason: "writes to secrets or shell startup files" };
  if (/\b(cat|less|more|head|tail|strings|xxd|base64|cp|scp|grep|rg|sed|awk)\b[^\n|;]*(\/\.env\b|^\.env\b|\s\.env\b|auth\.json|id_rsa|id_ed25519|\.pem\b)/.test(normalised)) return { level: "dangerous", reason: "reading secrets" };
  return { level: "ok" };
}

export function classifyCommand(command: string, extra: GuardRules = {}): Verdict {
  const normalised = normalise(command);
  const own = (list?: [string, string][]) => (list ?? []).map(([src, why]) => [new RegExp(src, "i"), why] as [RegExp, string]);
  for (const [re, reason] of own(extra.hardline)) if (re.test(normalised)) return { level: "hardline", reason };
  let worst: Verdict = { level: "ok" };
  const blocked = new Set((extra.noExec ?? []).flatMap((p) => [p, basename(p)]));
  for (const seg of segments(command)) {
    if (blocked.has(seg.verb)) return { level: "hardline", reason: `${seg.verb} is blocked by the shell sandbox (it hands work to processes outside it)` };
    const v = judgeSegment(seg);
    if (v.level === "hardline") return v;
    if (v.level === "dangerous" && worst.level === "ok") worst = v;
  }
  const whole = judgeWhole(normalised);
  if (whole.level !== "ok" && worst.level === "ok") worst = whole;
  if (worst.level === "ok") for (const [re, reason] of own(extra.dangerous)) if (re.test(normalised)) return { level: "dangerous", reason };
  return worst;
}

/** Absolute, symlink-resolved path (the deepest existing ancestor is resolved; the rest is appended). */
function real(p: string, cwd?: string): string {
  const abs = p === "~" ? HOME : p.startsWith("~/") ? resolve(HOME, p.slice(2)) : resolve(cwd ?? process.cwd(), p);
  let head = abs;
  const tail: string[] = [];
  while (head !== "/" && !existsSync(head)) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try { head = realpathSync(head); } catch {}
  return tail.length ? join(head, ...tail) : head;
}
const expand = (p: string, cwd?: string) => real(p, cwd);
const under = (p: string, dir: string) => p === dir.replace(/\/+$/, "") || p.startsWith(dir.replace(/\/+$/, "") + "/");

/** Paths that write/edit must ask before changing. */
export function writeVerdict(path: string, rules: GuardRules = {}): Verdict {
  const p = expand(path, rules.cwd);
  const own = (rules.protectedPaths ?? []).map((d) => expand(d));
  const free = (rules.writablePaths ?? []).map((d) => expand(d));
  if (own.some((d) => under(p, d)) && !free.some((d) => under(p, d)) || /\/\.pi(\/|$)/.test(p))
    return { level: "hardline", reason: `writing ${path} (Carl's own configuration and state)` };
  const dirs = ["~/.ssh", "~/.aws", "~/.gnupg", "~/Library/LaunchAgents", "/Library/LaunchDaemons", "/etc"].map((d) => expand(d));
  if (dirs.some((d) => under(p, d))) return { level: "dangerous", reason: `writing ${path}` };
  if (/(^|\/)(\.zshrc|\.bashrc|\.zprofile|\.bash_profile|\.profile|\.env|auth\.json)$/.test(p)) return { level: "dangerous", reason: `writing ${path}` };
  if (/\/\.git\/hooks\//.test(p)) return { level: "dangerous", reason: `writing ${path} (code that runs later)` };
  return { level: "ok" };
}

/** Files read must never open: they hold credentials. */
export function readVerdict(path: string, rules: GuardRules = {}): Verdict {
  const p = expand(path, rules.cwd);
  const secret = (rules.secretPaths ?? []).map((s) => expand(s));
  if (secret.includes(p) || /(^|\/)(\.env|auth\.json|mcp-auth\.json|id_rsa|id_ed25519|id_ecdsa)$/.test(p) || (/\/\.ssh\/[^/]+$/.test(p) && !p.endsWith(".pub")))
    return { level: "hardline", reason: `reading ${path} (credentials)` };
  return { level: "ok" };
}

export type Approver = (command: string, reason: string) => Promise<"approved" | "denied" | "timeout" | "unattended">;

/** A Pi extension that gates bash, write, edit and read for one conversation. */
export function shellGuard(approve: Approver, onBlock: (command: string, why: string) => void, rules: GuardRules = {}): InlineExtension {
  return {
    name: "carl-guard",
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_call", async (event: any) => {
        let subject: string;
        let verdict: Verdict;
        const path = String(event.input?.path ?? event.input?.file_path ?? "");
        if (event.toolName === "bash") {
          subject = String(event.input?.command ?? "");
          verdict = classifyCommand(subject, rules);
        } else if (event.toolName === "write" || event.toolName === "edit") {
          const content = String(event.input?.content ?? event.input?.newText ?? event.input?.new_string ?? JSON.stringify(event.input?.edits ?? ""));
          // Never shortened: the operator approves exactly what is written (a card too long for the channel is refused).
          // The card names where the write really lands when any step of the path is a link (macOS's own
          // /var, /tmp and /etc links aside).
          const target = path ? real(path, rules.cwd) : "";
          const asWritten = path ? resolve(rules.cwd ?? process.cwd(), path.replace(/^~(?=\/|$)/, HOME)).replace(/^\/(var|tmp|etc)(?=\/|$)/, "/private/$1") : "";
          subject = `${event.toolName} ${path}${target && target !== asWritten ? ` (really ${target})` : ""}\n${content}`;
          verdict = writeVerdict(path, rules);
        } else if (event.toolName === "read") {
          subject = `read ${path}`;
          verdict = readVerdict(path, rules);
        } else if (event.toolName === "read_mcp_resource" && (rules.trustedMcp ?? []).includes(String(event.input?.server ?? ""))) {
          // Resources of a trusted server are read outside the sandbox (a file:// resource would bypass its read denies).
          subject = `read_mcp_resource\n${JSON.stringify(event.input ?? {}, null, 1)}`;
          verdict = { level: "dangerous", reason: `reads a resource of ${event.input?.server} outside the sandbox` };
        } else if (/^mcp__.+__.+$/.test(event.toolName)) {
          // Trusted MCP servers act outside the sandbox: everything but their read-only tools asks first, also when
          // a codemode script calls them.
          subject = `${event.toolName}\n${JSON.stringify(event.input ?? {}, null, 1)}`;
          verdict = mcpVerdict(event.toolName, rules);
        } else {
          return undefined;
        }
        if (verdict.level === "ok") return undefined;
        if (verdict.level === "hardline") {
          onBlock(subject, `hardline: ${verdict.reason}`);
          return { block: true, reason: `Blocked: ${verdict.reason}. Carl never does this; the operator can do it themselves.` };
        }
        let answer: Awaited<ReturnType<Approver>>;
        try {
          answer = await approve(subject, verdict.reason);
        } catch (e) {
          onBlock(subject, `${verdict.reason} (approval failed: ${(e as Error).message})`);
          return { block: true, reason: `Not run (${verdict.reason}): the approval request failed (${(e as Error).message}).` };
        }
        if (answer === "approved") return undefined;
        onBlock(subject, `${verdict.reason} (${answer})`);
        const why = answer === "unattended" ? "no operator is attached to this run to approve it" : answer === "timeout" ? "the operator did not answer within 5 minutes" : "the operator denied it";
        return { block: true, reason: `Not run (${verdict.reason}): ${why}.` };
      });
    },
  } as InlineExtension;
}

/**
 * Tools of trusted MCP servers that only read: they run without asking. Every other tool of a trusted server
 * (opening workers, typing into terminals, queueing or approving work, writing notes) asks first, also from a
 * codemode script, because it acts outside the sandbox with the operator's permissions.
 */
export const DEFAULT_TRUSTED_READONLY: [string, string][] = [
  ["^overseer/overseer_(status|digest|terminals|read|profiles|events|panel|policy|concurrency|job_list|job_get|job_receiver|cleanup_status|reap_status|reap_owner_status|schedule_list|proposals|decisions_pending|decisions_packet)$", "OverSeer reads"],
  ["^[^/]+/(list_notes|search_notes|read_note|query_records|recall_context|get_links|get_schema|get_stats|get_board|memory_context|memory_recall|memory_review)$", "Retex reads"],
];

/** Pi names MCP tools mcp__<server>__<tool> with everything but [A-Za-z0-9_] turned into "_". */
const mcpPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;

export function mcpVerdict(toolName: string, rules: GuardRules): Verdict {
  if (!toolName.startsWith("mcp__")) return { level: "ok" };
  const server = (rules.trustedMcp ?? []).find((s) => toolName.startsWith(mcpPrefix(s)));
  if (!server) return { level: "ok" }; // an untrusted server runs inside the sandbox, like the shell
  const tool = toolName.slice(mcpPrefix(server).length);
  for (const [src] of [...DEFAULT_TRUSTED_READONLY, ...(rules.allowTools ?? [])]) if (new RegExp(src).test(`${server}/${tool}`)) return { level: "ok" };
  // Unknown names (including Pi's hashed ones) ask: the list says what is safe, not what is dangerous.
  return { level: "dangerous", reason: `${server} ${tool} acts outside the sandbox with your permissions` };
}

/** Run a small file utility inside the shell sandbox; the kernel then judges the real path, whatever links it went through. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
function sandboxed(profile: string, argv: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, ...argv], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME } });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    // A device or endless file (/dev/zero) must not exhaust Carl's memory: bounded in size and time.
    const fail = (why: string) => { child.kill("SIGKILL"); reject(new Error(why)); };
    const timer = setTimeout(() => fail(`${basename(argv[0])} on ${argv[argv.length - 1]} took over 60 s`), 60_000);
    child.on("close", () => clearTimeout(timer));
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_FILE_BYTES) return fail(`${argv[argv.length - 1]} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
      out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => { if (err.length < 2_000) err += b; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const path = argv[argv.length - 1];
      if (code === 3) return reject(Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" }));
      if (code === 4) return reject(Object.assign(new Error(`EACCES: permission denied, '${path}'`), { code: "EACCES" }));
      reject(new Error(err.trim() || `${basename(argv[0])} exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

const ACCESS = 'test -e "$1" || exit 3; test -r "$1" || exit 4; [ -z "$2" ] || test -w "$1" || exit 4';

/**
 * File operations for Pi's write and edit tools. The guard's verdict is repeated at the moment of the operation
 * (after any approval), and where Seatbelt exists the operation itself runs inside the shell sandbox, so swapping a
 * file or folder for a symlink in between gains nothing. Without Seatbelt the last path step is never followed.
 */
export function guardedFileOps(rules: GuardRules & { sandboxProfile?: string }) {
  const check = (abs: string) => {
    for (const v of [writeVerdict(abs, rules), readVerdict(abs, rules)]) if (v.level === "hardline") throw new Error(`refused: ${v.reason}`);
  };
  const profile = rules.sandboxProfile;
  return {
    writeFile: async (abs: string, content: string) => {
      check(abs);
      if (profile) return void (await sandboxed(profile, ["/bin/sh", "-c", 'cat > "$1"', "sh", abs], content));
      const { open } = await import("node:fs/promises");
      const fh = await open(abs, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW, 0o644);
      try { await fh.writeFile(content, "utf8"); } finally { await fh.close(); }
    },
    mkdir: async (dir: string) => {
      check(dir);
      if (profile) return void (await sandboxed(profile, ["/bin/mkdir", "-p", dir]));
      await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    },
    readFile: async (abs: string) => {
      check(abs);
      return profile ? sandboxed(profile, ["/bin/cat", abs]) : (await import("node:fs/promises")).readFile(abs);
    },
    access: async (abs: string) => {
      check(abs);
      if (profile) return void (await sandboxed(profile, ["/bin/sh", "-c", ACCESS, "sh", abs, "w"]));
      await (await import("node:fs/promises")).access(abs, fsc.R_OK | fsc.W_OK);
    },
  };
}

/** File operations for Pi's read tool: the secret check repeated at the moment of reading, the read itself sandboxed. */
export function guardedReadOps(rules: GuardRules & { sandboxProfile?: string }) {
  const check = (abs: string) => {
    const v = readVerdict(abs, rules);
    if (v.level === "hardline") throw new Error(`refused: ${v.reason}`);
  };
  const profile = rules.sandboxProfile;
  return {
    readFile: async (abs: string) => {
      check(abs);
      return profile ? sandboxed(profile, ["/bin/cat", abs]) : (await import("node:fs/promises")).readFile(abs);
    },
    access: async (abs: string) => {
      check(abs);
      if (profile) return void (await sandboxed(profile, ["/bin/sh", "-c", ACCESS, "sh", abs, ""]));
      await (await import("node:fs/promises")).access(abs, fsc.R_OK);
    },
    // Only the type is learned (no content), after the same check; the content itself is read in the sandbox.
    detectImageMimeType: async (abs: string) => {
      check(abs);
      // Only plain files are sniffed in Carl's own process (a FIFO would block it). The check and the read use
      // one open descriptor, so the file cannot be swapped in between.
      const fh = await (await import("node:fs/promises")).open(abs, fsc.O_RDONLY | fsc.O_NONBLOCK).catch(() => undefined);
      if (!fh) return null;
      try {
        return (await fh.stat()).isFile() ? await detectSupportedImageMimeTypeFromFile(`/dev/fd/${fh.fd}`) : null;
      } finally {
        await fh.close();
      }
    },
  };
}
