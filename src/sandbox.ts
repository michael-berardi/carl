// The hard boundary under the pattern guard: every shell command runs inside a kernel sandbox (macOS Seatbelt)
// that keeps the agent out of Carl's own control plane and away from its secrets, however the command is written.
//
//   - no writes anywhere in CARL_HOME except the agent's working areas (workspace, memory, media, spill)
//   - no reads of credential files (CARL_HOME/.env, configured env files, Pi's auth.json, extra secret paths)
//   - Carl's own secrets (bot tokens, the API key, webhook secrets) are removed from the command's environment
//
// Everything else keeps the operator's normal permissions: Carl is an agent that does real work, not a toy box.
// Where Seatbelt is unavailable (Linux, Windows) the environment scrubbing still applies, and the gap is logged.
import { existsSync, realpathSync, writeFileSync } from "node:fs";
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

const sbString = (p: string) => `"${canonical(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function writablePaths(cfg: CarlConfig): string[] {
  return [cfg.workspace, join(cfg.home, "memory"), join(cfg.home, "media"), join(cfg.home, "spill")];
}

export function secretFiles(cfg: CarlConfig): string[] {
  return [
    join(cfg.home, ".env"), join(cfg.piAgentDir, "auth.json"), join(cfg.home, "pi", "mcp-auth.json"), ...cfg.envFiles,
    ...(cfg.ultraterm ? [join(cfg.ultraterm.home, ".env"), join(cfg.ultraterm.home, "auth.json")] : []),
  ];
}

/** Ancestors of a path up to (not including) the home directory: renaming any of them would expose the file. */
function ancestors(p: string): string[] {
  const home = canonical(homedir());
  const out: string[] = [];
  for (let d = dirname(canonical(p)); d !== home && d !== "/" && d.startsWith(home + "/"); d = dirname(d)) out.push(d);
  return out;
}

/** Programs that hand work to processes outside the sandbox (apps, launchd, cron). */
export const NO_EXEC = ["/usr/bin/osascript", "/usr/bin/open", "/bin/launchctl", "/usr/bin/crontab", "/usr/bin/at", "/usr/bin/batch",
  "/usr/bin/automator", "/usr/bin/shortcuts", "/usr/bin/sudo", "/usr/bin/su", "/usr/bin/login"];

export interface ProfileInput {
  /** Files and directories Carl executes or loads (written only by the operator). */
  controlPlane: string[];
  /** Loopback ports of Carl's own API. */
  apiPorts: number[];
}

/** Seatbelt profile text. Later rules win, so the working areas are re-allowed after CARL_HOME is denied. */
export function buildProfile(cfg: CarlConfig, input: ProfileInput = { controlPlane: [], apiPorts: [] }): string {
  const secrets = secretFiles(cfg);
  const startup = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile"].map((f) => join(homedir(), f));
  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${sbString(cfg.home)}))`,
    `(allow file-write* ${writablePaths(cfg).map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
    // Code Carl itself runs or loads, wherever it lives; the workspace never holds Pi extensions.
    `(deny file-write* (subpath ${sbString(join(cfg.workspace, ".pi"))}) ${input.controlPlane.map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
    `(deny file-write* ${startup.map((p) => `(literal ${sbString(p)})`).join(" ")})`,
    `(deny file-write* (subpath ${sbString(join(homedir(), "Library", "LaunchAgents"))}) (subpath "/Library/LaunchAgents") (subpath "/Library/LaunchDaemons"))`,
    // Secrets: unreadable, and neither they nor any folder above them can be moved somewhere readable.
    `(deny file-read* ${secrets.map((p) => `(literal ${sbString(p)})`).join(" ")})`,
    `(deny file-write* ${[...secrets, ...secrets.flatMap(ancestors)].map((p) => `(literal ${sbString(p)})`).join(" ")})`,
    `(deny process-exec ${NO_EXEC.map((p) => `(literal ${sbString(p)})`).join(" ")})`,
    "(deny appleevent-send)",
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

/** A Pi bash spawn hook: scrub secrets, then (on macOS) run the command inside the profile. */
export function sandboxSpawnHook(cfg: CarlConfig, profilePath: string | undefined): (ctx: BashSpawnContext) => BashSpawnContext {
  const names = new Set(secretEnvNames(cfg));
  return (ctx) => {
    const env = { ...ctx.env };
    for (const n of names) delete env[n];
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

/** Wrap an MCP stdio server so it runs under the same profile with Carl's secrets blanked out. */
export function sandboxMcpServer(cfg: CarlConfig, profile: string | undefined, server: { command: string; args?: string[]; env?: Record<string, string> }) {
  const env = { ...(server.env ?? {}) };
  for (const n of secretEnvNames(cfg)) env[n] = "";
  if (!profile) return { ...server, env };
  return { ...server, command: SANDBOX_EXEC, args: ["-f", profile, server.command, ...(server.args ?? [])], env };
}
