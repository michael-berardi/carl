// The hard boundary under the pattern guard: every shell command runs inside a kernel sandbox (macOS Seatbelt)
// that keeps the agent out of Carl's own control plane and away from its secrets, however the command is written.
//
//   - no writes anywhere in CARL_HOME except the agent's working areas (workspace, memory, media, spill)
//   - no reads of credential files (CARL_HOME/.env, configured env files, Pi's auth.json, extra secret paths)
//   - no writes to anything else Carl runs or loads, no app launching (Apple Events, LaunchServices, launchd tools)
//   - the environment is an allowlist: Carl's secrets and keys exported in the operator's shell never reach it
//
// Everything else keeps the operator's normal permissions: Carl is an agent that does real work, not a toy box.
// Where Seatbelt is unavailable (Linux, Windows) the environment scrubbing still applies, and the gap is logged.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import type { CarlConfig } from "./config.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/** Seatbelt matches real paths (/var is /private/var on macOS): resolve the deepest existing ancestor. */
export function canonical(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (head !== "/" && !existsSync(head)) {
    tail.unshift(basename(head));
    head = dirname(head);
  }
  try { head = realpathSync(head); } catch {}
  return tail.length ? join(head, ...tail) : head;
}

const sbQuote = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const sbString = (p: string) => sbQuote(canonical(p));
/** Literal rules for a path that may itself be a symlink: the link (folder resolved, last step not) and its target. */
const sbLiterals = (p: string) => [...new Set([join(canonical(dirname(p)), basename(p)), canonical(p)])].map((x) => `(literal ${sbQuote(x)})`).join(" ");

export function writablePaths(cfg: CarlConfig): string[] {
  return [cfg.workspace, join(cfg.home, "memory"), join(cfg.home, "media"), join(cfg.home, "spill")];
}

export function secretFiles(cfg: CarlConfig): string[] {
  return [
    join(cfg.home, ".env"), join(cfg.piAgentDir, "auth.json"), join(cfg.home, "pi", "mcp-auth.json"), ...cfg.envFiles,
    ...(cfg.ultraterm ? [join(cfg.ultraterm.home, ".env"), join(cfg.ultraterm.home, "auth.json")] : []),
  ];
}

/** Every folder above a path (not "/"): renaming any of them would move the path somewhere unprotected. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = canonical(dirname(p)); d !== "/"; d = dirname(d)) out.push(d);
  return out;
}

/**
 * A program Carl starts by path: the path itself, every symlink hop to the real file, and the folders above each,
 * so none of them can be replaced or moved aside.
 */
export function executableChain(p: string): string[] {
  const out = new Set<string>();
  let cur = resolve(p);
  for (let hop = 0; hop < 16; hop++) {
    out.add(cur);
    for (const a of ancestors(cur)) out.add(a);
    let st;
    try { st = lstatSync(cur); } catch { break; }
    if (!st.isSymbolicLink()) break;
    cur = resolve(dirname(cur), readlinkSync(cur));
  }
  return [...out];
}

/** Environment names a sandboxed command may inherit from Carl (plus the operator's shellEnv list). */
const ENV_ALLOW = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TERM_PROGRAM", "COLORTERM", "LANG", "TZ", "TMPDIR",
  "PWD", "EDITOR", "VISUAL", "PAGER", "SSH_AUTH_SOCK", "TMUX", "TMUX_PANE", "CARL_HOME", "NO_COLOR", "FORCE_COLOR"]);
const ENV_ALLOW_PREFIX = ["LC_", "XDG_", "HOMEBREW_", "ULTRATERM_"];

/** The environment for anything the agent can influence: allowlisted names only, so no key reaches it by accident. */
export function cleanEnv(cfg: CarlConfig, env: NodeJS.ProcessEnv = process.env, keep: Record<string, string> = {}): Record<string, string> {
  const secret = new Set(secretEnvNames(cfg));
  const extra = new Set(cfg.shellEnv);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || secret.has(k)) continue;
    if (ENV_ALLOW.has(k) || extra.has(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return { ...out, ...keep };
}

/** Read a file Carl did not create safely: refuses a symlink at the last step and anything but a plain file. */
export function readNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** argv that runs a program under the profile (or as-is where Seatbelt is unavailable). */
export function sandboxArgv(profile: string | undefined, argv: string[]): string[] {
  return profile ? [SANDBOX_EXEC, "-f", profile, ...argv] : argv;
}

/** Programs that hand work to processes outside the sandbox (apps, launchd, cron). */
export const NO_EXEC = ["/usr/bin/osascript", "/usr/bin/open", "/bin/launchctl", "/usr/bin/crontab", "/usr/bin/at", "/usr/bin/batch",
  "/usr/bin/automator", "/usr/bin/shortcuts", "/usr/bin/sudo", "/usr/bin/su", "/usr/bin/login"];

const LAUNCH_SERVICES = ["com.apple.coreservices.launchservicesd", "com.apple.coreservices.quarantine-resolver", "com.apple.lsd.mapdb",
  "com.apple.lsd.modifydb", "com.apple.lsd.open"];

export interface ProfileInput {
  /** Files and directories Carl executes or loads (written only by the operator). */
  controlPlane: string[];
  /** Exact paths that must not be replaced or moved (program links and the folders above them). */
  pinned?: string[];
  /** Loopback ports of Carl's own API. */
  apiPorts: number[];
}

/** Seatbelt profile text. Later rules win, so the working areas are re-allowed after CARL_HOME is denied. */
export function buildProfile(cfg: CarlConfig, input: ProfileInput = { controlPlane: [], apiPorts: [] }): string {
  const secrets = secretFiles(cfg);
  const startup = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile"].map((f) => join(homedir(), f));
  // The working areas stay writable inside, but cannot themselves be renamed or swapped for a symlink.
  const roots = writablePaths(cfg);
  const pinned = [...new Set([...roots, ...roots.flatMap(ancestors), ...(input.pinned ?? [])])];
  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${sbString(cfg.home)}))`,
    `(allow file-write* ${writablePaths(cfg).map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
    // Code Carl itself runs or loads, wherever it lives; the workspace never holds Pi extensions.
    `(deny file-write* (subpath ${sbString(join(cfg.workspace, ".pi"))}) ${input.controlPlane.map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
    `(deny file-write* ${startup.map(sbLiterals).join(" ")})`,
    `(deny file-write* ${pinned.map(sbLiterals).join(" ")})`,
    `(deny file-write* (subpath ${sbString(join(homedir(), "Library", "LaunchAgents"))}) (subpath "/Library/LaunchAgents") (subpath "/Library/LaunchDaemons"))`,
    // Secrets: unreadable, and neither they nor any folder above them can be moved somewhere readable.
    `(deny file-read* ${secrets.map((p) => `(literal ${sbString(p)})`).join(" ")})`,
    `(deny file-write* ${[...secrets, ...secrets.flatMap(ancestors)].map(sbLiterals).join(" ")})`,
    `(deny process-exec ${NO_EXEC.map((p) => `(literal ${sbString(p)})`).join(" ")})`,
    "(deny appleevent-send)",
    // LaunchServices starts apps (and their helpers) outside the sandbox.
    `(deny mach-lookup ${LAUNCH_SERVICES.map((n) => `(global-name "${n}")`).join(" ")})`,
    ...(input.apiPorts.length ? [`(deny network-outbound ${input.apiPorts.map((p) => `(remote ip "*:${p}")`).join(" ")})`] : []),
  ];
  return lines.join("\n") + "\n";
}

/** Names of environment variables that hold Carl's own secrets. */
export function secretEnvNames(cfg: CarlConfig): string[] {
  return [
    cfg.telegram.tokenEnv, cfg.api.keyEnv, cfg.slack.appTokenEnv, cfg.slack.botTokenEnv, cfg.discord.tokenEnv,
    ...Object.values(cfg.hooks).map((h) => h.secretEnv).filter((x): x is string => !!x),
    "CARL_API_KEY", "TELEGRAM_BOT_TOKEN", "API_SERVER_KEY",
  ];
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A Pi bash spawn hook: allowlisted environment, then (on macOS) run the command inside the profile. */
export function sandboxSpawnHook(cfg: CarlConfig, profilePath: string | undefined): (ctx: BashSpawnContext) => BashSpawnContext {
  return (ctx) => {
    // Variables Pi itself set for the command are kept; everything inherited from Carl goes through the allowlist.
    const own = Object.fromEntries(Object.entries(ctx.env ?? {}).filter(([k, v]) => v !== undefined && process.env[k] !== v && !secretEnvNames(cfg).includes(k))) as Record<string, string>;
    const env = cleanEnv(cfg, ctx.env, own);
    if (!profilePath) return { ...ctx, env };
    return { ...ctx, env, command: `exec ${SANDBOX_EXEC} -f ${shQuote(profilePath)} /bin/bash -c ${shQuote(ctx.command)}` };
  };
}

/** Write the profile into CARL_HOME/state (itself write-protected from the agent) and return its path. */
export function installProfile(cfg: CarlConfig, input: ProfileInput): string | undefined {
  if (!sandboxAvailable()) return undefined;
  const path = join(cfg.home, "state", "sandbox.sb");
  writeFileSync(path, buildProfile(cfg, input), { mode: 0o600 });
  return path;
}

/**
 * Wrap an MCP stdio server so it runs under the same profile with only its own configured environment plus the
 * allowlist. `env -i` makes that hold however the MCP client merges environments.
 */
export function sandboxMcpServer(cfg: CarlConfig, profile: string | undefined, server: { command: string; args?: string[]; env?: Record<string, string> }) {
  const env = cleanEnv(cfg, process.env, server.env ?? {});
  const argv = ["/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...sandboxArgv(profile, [server.command, ...(server.args ?? [])])];
  return { ...server, command: argv[0], args: argv.slice(1), env };
}
