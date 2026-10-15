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
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { type CarlConfig, secret as secret_ } from "./config.ts";

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

/**
 * Scratch space: devices and the agent's own temp and cache folders under spill/. The shared temp folders and
 * caches (/tmp, the user temp dir, ~/.npm) stay closed: other programs read and run what is there.
 */
export function scratchPaths(): string[] {
  return ["/dev"];
}

/** The agent's own temp and cache folders (inside spill, so already writable), handed to tools through the env. */
export function agentScratchEnv(cfg: CarlConfig): Record<string, string> {
  const base = join(cfg.home, "spill");
  const dirs = { TMPDIR: join(base, "tmp"), XDG_CACHE_HOME: join(base, "cache"), npm_config_cache: join(base, "cache", "npm"), PIP_CACHE_DIR: join(base, "cache", "pip") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return dirs;
}

export function secretFiles(cfg: CarlConfig): string[] {
  return [
    join(cfg.home, ".env"), join(cfg.piAgentDir, "auth.json"), join(cfg.home, "pi", "mcp-auth.json"), ...cfg.envFiles,
    ...(cfg.ultraterm ? [join(cfg.ultraterm.home, ".env"), join(cfg.ultraterm.home, "auth.json"),
      // OverSeer's local HTTP token: with it a command could ask OverSeer to act outside the sandbox.
      join(dirname(dirname(cfg.ultraterm.overseerBin)), "overseer", "http-token")] : []),
  ];
}

/** Unix sockets of programs that run commands outside the sandbox on request (tmux servers, Docker). */
function controlSockets(cfg: CarlConfig): string[] {
  const uid = process.getuid?.() ?? 0;
  const out = [join(homedir(), ".ultraterm"), `/private/tmp/tmux-${uid}`, join(homedir(), ".colima"), join(homedir(), ".docker", "run"), "/private/var/run/docker.sock"];
  for (const sock of [process.env.TMUX?.split(",")[0], process.env.ULTRATERM_TMUX_SOCKET]) if (sock) out.push(dirname(sock));
  if (cfg.ultraterm) out.push(cfg.ultraterm.home);
  return out;
}

/**
 * Every folder above a path (not "/"), both as written and as resolved: renaming any of them, or swapping a
 * symlinked folder on the way, would move the path somewhere unprotected.
 */
export function ancestors(p: string): string[] {
  const out = new Set<string>();
  for (let d = dirname(resolve(p)); d !== "/"; d = dirname(d)) out.add(d);
  for (let d = canonical(dirname(p)); d !== "/"; d = dirname(d)) out.add(d);
  return [...out];
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
  "PWD", "EDITOR", "VISUAL", "PAGER", "CARL_HOME", "NO_COLOR", "FORCE_COLOR"]);
const ENV_ALLOW_PREFIX = ["LC_", "XDG_", "HOMEBREW_", "ULTRATERM_"];
const ENV_ALLOW_NETWORK = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"];
for (const n of ENV_ALLOW_NETWORK) ENV_ALLOW.add(n);
/** Names that look like credentials never pass on a prefix match (HOMEBREW_GITHUB_API_TOKEN, say); only shellEnv admits them. */
export const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|AUTH|CRED|COOKIE|SESSION)/i;

/** The PATH the operator's shell had: the agent's commands keep it, while Carl's own children use a trusted one. */
let agentPath: string | undefined;

/**
 * Give Carl's unsandboxed children (Claude Code, UltraTerm helpers, UltraCompress) a PATH made only of folders the
 * agent cannot write: a private bin folder of links to programs resolved once now, UltraTerm's helper folder and the
 * system folders. Returns the resolved programs so their link chains can be pinned.
 */
export function adoptTrustedPath(binDir: string, programs: Record<string, string | undefined>, extraDirs: string[] = []): Record<string, string> {
  agentPath ??= process.env.PATH ?? "";
  rmSync(binDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const found: Record<string, string> = {};
  for (const [name, given] of Object.entries(programs)) {
    const path = given ?? agentPath.split(delimiter).filter(Boolean).map((d) => join(d, name)).find((c) => existsSync(c));
    if (!path) continue;
    found[name] = path;
    symlinkSync(path, join(binDir, name));
  }
  process.env.PATH = [binDir, ...extraDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  return found;
}

/** The operator's PATH (Carl's own PATH once adoptTrustedPath ran is the trusted one). */
export function operatorPath(): string {
  return agentPath ?? process.env.PATH ?? "";
}

/** Folders of the operator's PATH (where a planted `node` would win at Carl's next start). */
export function operatorPathDirs(): string[] {
  return operatorPath().split(delimiter).filter((d) => d.startsWith("/"));
}

/** The environment for anything the agent can influence: allowlisted names only, so no key reaches it by accident. */
export function cleanEnv(cfg: CarlConfig, env: NodeJS.ProcessEnv = process.env, keep: Record<string, string> = {}): Record<string, string> {
  const secret = new Set(secretEnvNames(cfg));
  const extra = new Set(cfg.shellEnv);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || secret.has(k)) continue;
    if (extra.has(k) || ENV_ALLOW.has(k) || (ENV_ALLOW_PREFIX.some((p) => k.startsWith(p)) && !SECRET_NAME.test(k))) out[k] = v;
  }
  // Names the operator chose to hand the agent may live in the env files rather than Carl's environment.
  for (const k of extra) if (out[k] === undefined && !secret.has(k)) { const v = secret_(cfg.home, k, cfg.envFiles); if (v !== undefined) out[k] = v; }
  out.PATH = operatorPath();
  return { ...out, ...agentScratchEnv(cfg), ...keep };
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

/** Read a file inside the sandbox (for files in the agent's areas that Carl itself loads): links resolve as the agent's would. */
export function readSandboxed(profile: string, path: string, maxBytes = 1 << 20): string {
  const r = spawnSync(SANDBOX_EXEC, ["-f", profile, "/bin/cat", path], { maxBuffer: maxBytes, timeout: 3_000, env: { PATH: "/usr/bin:/bin" } });
  if (r.error) throw new Error(`cannot read ${path}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`cannot read ${path}: ${String(r.stderr).trim() || `exit ${r.status}`}`);
  return String(r.stdout);
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
  // Folders above protected paths cannot be renamed either (that would swap in a folder the agent wrote).
  const pinned = [...new Set([...roots, ...roots.flatMap(ancestors), ...(input.pinned ?? []), ...input.controlPlane.flatMap(ancestors)])];
  const lines = [
    "(version 1)",
    "(allow default)",
    // Writes go only to the working areas, scratch space and folders the operator adds; everything else (Carl's own
    // files, programs on PATH, shell startup files, other projects) is read-only to the agent.
    "(deny file-write*)",
    `(allow file-write* ${[...scratchPaths(), ...cfg.agentWritable].map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
    // CARL_HOME stays closed even when it sits inside one of those folders; then its working areas open again.
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
    // No signals to processes outside this command (Carl itself, the operator's programs); its own children are fine.
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    `(deny network-outbound ${controlSockets(cfg).map((p) => `(remote unix-socket (subpath ${sbString(p)}))`).join(" ")})`,
    // ...and their socket folders cannot be changed (a socket swapped for the agent's own would answer real clients).
    `(deny file-write* ${controlSockets(cfg).map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
    // LaunchServices starts apps (and their helpers) outside the sandbox; the Keychain holds the operator's
    // credentials (HTTPS certificate checks use trustd, which stays reachable).
    `(deny mach-lookup ${[...LAUNCH_SERVICES, "com.apple.SecurityServer", "com.apple.securityd.xpc"].map((n) => `(global-name "${n}")`).join(" ")})`,
    // The operator's SSH agent (its keys reach every server the operator can log in to).
    `(deny network-outbound (remote unix-socket (path-regex #"^/private/(var/run|tmp)/com\\.apple\\.launchd\\.[^/]+/Listeners$")))`,
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
    // PATH is the operator's (Pi prefixes its own tool folder to Carl's trusted PATH, which the agent should not get).
    const own = Object.fromEntries(Object.entries(ctx.env ?? {}).filter(([k, v]) => k !== "PATH" && v !== undefined && process.env[k] !== v && !secretEnvNames(cfg).includes(k))) as Record<string, string>;
    const env = cleanEnv(cfg, ctx.env, own);
    if (!profilePath) return { ...ctx, env };
    return { ...ctx, env, command: `exec ${SANDBOX_EXEC} -f ${shQuote(profilePath)} /bin/bash -c ${shQuote(ctx.command)}` };
  };
}

/** Write the profile into CARL_HOME/state (itself write-protected from the agent) and return its path. */
export function installProfile(cfg: CarlConfig, input: ProfileInput, path = join(cfg.home, "state", "sandbox.sb")): string | undefined {
  if (!sandboxAvailable()) return undefined;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, buildProfile(cfg, input), { mode: 0o600 });
  return path;
}

/**
 * Wrap an MCP stdio server so it runs under the same profile with only its own configured environment plus the
 * allowlist. `env -i` makes that hold however the MCP client merges environments.
 */
export function sandboxMcpServer(cfg: CarlConfig, profile: string | undefined, server: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }) {
  const env = cleanEnv(cfg, process.env, server.env ?? {});
  const argv = ["/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...sandboxArgv(profile, [server.command, ...(server.args ?? [])])];
  return { ...server, command: argv[0], args: argv.slice(1), env };
}
