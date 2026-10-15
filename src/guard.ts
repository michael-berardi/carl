// Tool guard: a tripwire against destructive mistakes, not a sandbox. Carl runs tools with the operator's own
// permissions; this gate makes the obviously destructive impossible ("hardline") and the risky explicit (the
// operator approves it in chat). Unattended runs (schedules, API without a chat) cannot ask, so they refuse.
//
// Commands are split into segments at ; && || | & newlines and $( ), and judged by their verb, so "rg shutdown"
// is a search, not a shutdown. Quoting and backslashes are removed before matching. Anything that hides the
// real command (eval, sh -c, interpreters with inline code, a variable as the verb, base64 decoding) asks first.
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

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
}

/** Remove quoting so `"rm" -rf '~'` reads as `rm -rf ~`. */
export function normalise(command: string): string {
  return command.replace(/\\\n/g, " ").replace(/\\(.)/g, "$1").replace(/["']/g, "").replace(/\$\{?IFS\}?/g, " ");
}

/** Command segments with their verb (first word after env assignments and transparent wrappers). */
export function segments(command: string): { verb: string; args: string; text: string }[] {
  const parts = normalise(command).split(/\|\||&&|[;|&\n]|\$\(|`|\)/);
  const out: { verb: string; args: string; text: string }[] = [];
  for (const raw of parts) {
    let words = raw.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    while (words.length && ["command", "builtin", "nohup", "time", "nice", "exec", "env", "caffeinate", "timeout", "gtimeout"].includes(words[0])) {
      words = words.slice(1);
      while (words.length && (/^-/.test(words[0]) || /^\d+[smh]?$/.test(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words = words.slice(1);
    }
    if (!words.length) continue;
    const verb = words[0].replace(/^.*\//, ""); // /bin/rm -> rm
    out.push({ verb, args: words.slice(1).join(" "), text: words.join(" ") });
  }
  return out;
}

const HOME = homedir();
const ROOTS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*", "/Users", "/Users/", "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt", "/private", HOME, HOME + "/", HOME + "/*"]);
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
  // Indirection hides the real command: ask.
  if (verb === "eval" || verb === "source" || verb === ".") return { level: "dangerous", reason: `${verb} runs code the guard cannot see` };
  if (/^(ba|z|k|da|fi)?sh$/.test(verb) && /(^|\s)-[a-zA-Z]*c(\s|$)/.test(args)) return { level: "dangerous", reason: `${verb} -c runs code the guard cannot see` };
  if (/^(python[0-9.]*|node|perl|ruby|php|osascript|deno|bun)$/.test(verb) && /(^|\s)-(c|e|E|-eval)(\s|$)/.test(args)) return { level: "dangerous", reason: `${verb} with inline code` };
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
  for (const seg of segments(command)) {
    const v = judgeSegment(seg);
    if (v.level === "hardline") return v;
    if (v.level === "dangerous" && worst.level === "ok") worst = v;
  }
  const whole = judgeWhole(normalised);
  if (whole.level !== "ok" && worst.level === "ok") worst = whole;
  if (worst.level === "ok") for (const [re, reason] of own(extra.dangerous)) if (re.test(normalised)) return { level: "dangerous", reason };
  return worst;
}

const expand = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? resolve(HOME, p.slice(2)) : resolve(p));
const under = (p: string, dir: string) => p === dir.replace(/\/+$/, "") || p.startsWith(dir.replace(/\/+$/, "") + "/");

/** Paths that write/edit must ask before changing. */
export function writeVerdict(path: string, rules: GuardRules = {}): Verdict {
  const p = expand(path);
  const dirs = ["~/.ssh", "~/.aws", "~/.gnupg", "~/Library/LaunchAgents", "/Library/LaunchDaemons", "/etc", ...(rules.protectedPaths ?? [])].map(expand);
  if (dirs.some((d) => under(p, d))) return { level: "dangerous", reason: `writing ${path}` };
  if (/(^|\/)(\.zshrc|\.bashrc|\.zprofile|\.bash_profile|\.profile|\.env|auth\.json)$/.test(p)) return { level: "dangerous", reason: `writing ${path}` };
  if (/\/\.git\/hooks\//.test(p) || /\/\.pi\//.test(p)) return { level: "dangerous", reason: `writing ${path} (code that runs later)` };
  return { level: "ok" };
}

/** Files read must never open: they hold credentials. */
export function readVerdict(path: string, rules: GuardRules = {}): Verdict {
  const p = expand(path);
  const secret = (rules.secretPaths ?? []).map(expand);
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
          subject = `${event.toolName} ${path}`;
          verdict = writeVerdict(path, rules);
        } else if (event.toolName === "read") {
          subject = `read ${path}`;
          verdict = readVerdict(path, rules);
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
