// Carl's configuration: one JSON file (carl.json) in CARL_HOME, secrets from the environment or CARL_HOME/.env.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface TelegramConfig {
  enabled: boolean;
  /** Telegram user ids allowed to talk to Carl. Empty = nobody (Carl never runs open). */
  allowFrom: number[];
  /** Env var holding the bot token. */
  tokenEnv: string;
  /** Chat that receives schedule results and alerts by default. */
  homeChat?: number;
  /** Stream replies by editing a draft message. Off by default: the chat shows one final answer and no tool line. */
  stream: boolean;
  /** Bot API base URL (a relay can stand in for api.telegram.org). */
  apiBase: string;
  /**
   * Team groups Carl serves besides the operator. In a listed group Carl answers the listed members (and the
   * operators in allowFrom) only when addressed: an @mention, a reply to Carl, or a /command. Every message
   * there names its sender, so the agent knows who is speaking. Empty = groups only for operators.
   */
  groups: TelegramGroup[];
}

export interface TelegramGroup {
  /** The group's chat id (negative). */
  chat: number;
  /** Member Telegram user id -> the name the agent sees. Operators in allowFrom need no entry. */
  members: Record<string, string>;
  /** Also answer messages that are not addressed to the bot (default false: mentions, replies and commands only). */
  listenAll: boolean;
}

export interface ApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Env var holding the bearer key. The API refuses to start without one. */
  keyEnv: string;
}

export interface CarlConfig {
  home: string;
  name: string;
  /** "provider/model", resolved through Pi's model registry. */
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Models used, in order, only while the primary is provably out of quota. */
  fallbackModels: string[];
  /** Cheaper model for reflection, titles and schedule runs that ask for it. Defaults to `model`. */
  sideModel?: string;
  /** Working context ceiling in tokens: Carl compacts once a conversation passes it, whatever the model's window. */
  contextBudget: number;
  /** Recent tokens kept verbatim through a compaction. */
  keepRecentTokens: number;
  /** Pi agent dir: auth.json and models.json come from here, so Carl shares Pi's logins. */
  agentDir: string;
  /** Agent working directory (tools run here). */
  workspace: string;
  /** Extra instruction files appended to the system prompt, in order (e.g. a team AGENTS.md). */
  contextFiles: string[];
  /** Skill directories (Pi skill format: loaded on demand, only names and descriptions sit in the prompt). */
  skills: string[];
  /** Skill names listed in the prompt. Empty = every discovered skill. */
  skillAllow: string[];
  /** Tool results longer than this are cut to head + tail; the full text is spilled to a file. */
  toolResultMaxChars: number;
  /** Pi extension files or packages to load (custom tools, MCP bridges, delegation). */
  extensions: string[];
  /** Load Pi's MCP extension (servers from mcp.json in CARL_HOME, deferred behind tool search). */
  mcp: boolean;
  /** Pi built-in tools to enable. */
  tools: string[];
  telegram: TelegramConfig;
  discord: { enabled: boolean; allowFrom: string[]; tokenEnv: string; homeChannel?: string; apiBase: string };
  slack: { enabled: boolean; allowFrom: string[]; appTokenEnv: string; botTokenEnv: string; homeChannel?: string; apiBase: string };
  api: ApiConfig;
  /** Speech-to-text command for voice notes: "{file}" is the audio path; the transcript is "{output}" when given, else stdout. */
  stt?: string[];
  /** Idle minutes after which a chat starts a fresh session on its next message (0 = never). */
  idleResetMinutes: number;
  /** UltraTerm compatibility (the UltraBot slot): home UltraTerm reads, and the ut-overseer binary. */
  ultraterm?: { home: string; overseerBin: string };
  /** Who turns the shadow into lessons: "carl" (the daily individuation pass and psyche/integrated.md) or "ultraterm"
   *  (UltraTerm Dream and Nightmare read the shadow and decision ledgers; lessons arrive through shared memory).
   *  Default: "ultraterm" when the UltraTerm module is on, else "carl". */
  learning: "carl" | "ultraterm";
  /** Claude route through the official Claude Code CLI: binary and login config dirs (first preferred). */
  claude: { enabled: boolean; command?: string; configDirs: string[] };
  /** Inbound webhooks by name (POST /v1/hooks/<name>). */
  hooks: Record<string, { prompt: string; deliver: string; secretEnv?: string }>;
  /** The asks module (src/asks.ts): put questions to people in a chat and hand their answers on. Off by default. */
  asks: boolean;
  /** Extra shell-guard patterns on top of the built-in ones. */
  guard: { hardline: [string, string][]; dangerous: [string, string][]; allowTools: [string, string][]; operatorTools: [string, string][] };
  /** UltraCompress compaction (deterministic brief, no model call, plus recall): "auto" = on when the binary is installed. */
  ultracompress: "auto" | "off";
  /** Extra KEY=VALUE files read for secrets after the environment and CARL_HOME/.env (values are never copied). */
  envFiles: string[];
  /** Extra environment names passed to shell commands, MCP servers and command schedules (all others are dropped);
   *  values come from Carl's environment or, failing that, the env files. */
  shellEnv: string[];
  /** Extra folders the agent may write (it may write only its working areas, temp folders and the npm cache). */
  agentWritable: string[];
  /** MCP servers (by name in pi/mcp.json) that run outside the sandbox: the operator's own control tools. */
  trustedMcp: string[];
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function abs(p: string, base: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(base, e);
}

export function carlHome(): string {
  return abs(process.env.CARL_HOME ?? "~/.carl", process.cwd());
}

/** Parse KEY=VALUE lines. Values are never logged. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Secrets: process env wins, then CARL_HOME/.env, then each configured env file in order. */
export function secret(home: string, name: string, envFiles: string[] = []): string | undefined {
  if (process.env[name]) return process.env[name];
  for (const file of [join(home, ".env"), ...envFiles]) {
    if (!existsSync(file)) continue;
    const value = parseEnvFile(readFileSync(file, "utf8"))[name];
    if (value) return value;
  }
  return undefined;
}

export const DEFAULT_MODEL = "openai-codex/gpt-6.1-terra";

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function loadConfig(home = carlHome()): CarlConfig {
  const file = join(home, "carl.json");
  let raw: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const tg = raw.telegram ?? {};
  const api = raw.api ?? {};
  const cfg: CarlConfig = {
    home,
    name: str(raw.name, "Carl", "name"),
    model: str(raw.model, DEFAULT_MODEL, "model"),
    thinking: (raw.thinking ?? "medium") as CarlConfig["thinking"],
    fallbackModels: strList(raw.fallbackModels, "fallbackModels"),
    sideModel: raw.sideModel === undefined ? undefined : str(raw.sideModel, "", "sideModel"),
    contextBudget: int(raw.contextBudget, 96_000, "contextBudget", 8_000),
    keepRecentTokens: int(raw.keepRecentTokens, 16_000, "keepRecentTokens", 1_000),
    // Model logins (auth.json) and custom models (models.json). Carl's own folder by default; point it at another
    // Pi-SDK app's folder (e.g. ~/.pi/agent) to share its logins. "piAgentDir" is the older name.
    agentDir: abs(raw.agentDir ?? raw.piAgentDir ?? join(home, "agent"), home),
    workspace: abs(raw.workspace ?? "workspace", home),
    contextFiles: strList(raw.contextFiles, "contextFiles").map((p) => abs(p, home)),
    skills: strList(raw.skills, "skills").map((p) => abs(p, home)),
    skillAllow: strList(raw.skillAllow, "skillAllow"),
    toolResultMaxChars: int(raw.toolResultMaxChars, 12_000, "toolResultMaxChars", 1_000),
    extensions: strList(raw.extensions, "extensions").map((p) => (p.startsWith("npm:") || p.startsWith("git:") ? p : abs(p, home))),
    mcp: raw.mcp === undefined ? true : bool(raw.mcp, "mcp"),
    tools: raw.tools === undefined ? ["read", "bash", "edit", "write"] : strList(raw.tools, "tools"),
    telegram: {
      enabled: tg.enabled === undefined ? true : bool(tg.enabled, "telegram.enabled"),
      allowFrom: (tg.allowFrom ?? []).map((v: unknown, i: number) => {
        const n = Number(v);
        if (!Number.isSafeInteger(n)) throw new ConfigError(`telegram.allowFrom[${i}] must be a numeric Telegram user id`);
        return n;
      }),
      tokenEnv: str(tg.tokenEnv, "TELEGRAM_BOT_TOKEN", "telegram.tokenEnv"),
      homeChat: tg.homeChat === undefined ? undefined : int(tg.homeChat, 0, "telegram.homeChat", Number.MIN_SAFE_INTEGER),
      // Answers, not progress: off unless the operator opts in. A draft is only ever shown when this is true, and
      // the tool line is only rendered inside a draft, so streaming off means one final message and nothing else.
      stream: tg.stream === undefined ? false : bool(tg.stream, "telegram.stream"),
      apiBase: str(tg.apiBase, "https://api.telegram.org", "telegram.apiBase").replace(/\/+$/, ""),
      groups: groupsOf(tg.groups),
    },
    discord: {
      enabled: raw.discord?.enabled === undefined ? !!raw.discord : bool(raw.discord.enabled, "discord.enabled"),
      allowFrom: strList(raw.discord?.allowFrom, "discord.allowFrom"),
      tokenEnv: str(raw.discord?.tokenEnv, "DISCORD_BOT_TOKEN", "discord.tokenEnv"),
      homeChannel: raw.discord?.homeChannel ? str(raw.discord.homeChannel, "", "discord.homeChannel") : undefined,
      apiBase: str(raw.discord?.apiBase, "https://discord.com/api/v10", "discord.apiBase").replace(/\/+$/, ""),
    },
    slack: {
      enabled: raw.slack?.enabled === undefined ? !!raw.slack : bool(raw.slack.enabled, "slack.enabled"),
      allowFrom: strList(raw.slack?.allowFrom, "slack.allowFrom"),
      appTokenEnv: str(raw.slack?.appTokenEnv, "SLACK_APP_TOKEN", "slack.appTokenEnv"),
      botTokenEnv: str(raw.slack?.botTokenEnv, "SLACK_BOT_TOKEN", "slack.botTokenEnv"),
      homeChannel: raw.slack?.homeChannel ? str(raw.slack.homeChannel, "", "slack.homeChannel") : undefined,
      apiBase: str(raw.slack?.apiBase, "https://slack.com/api", "slack.apiBase").replace(/\/+$/, ""),
    },
    api: {
      enabled: api.enabled === undefined ? true : bool(api.enabled, "api.enabled"),
      host: str(api.host, "127.0.0.1", "api.host"),
      port: int(api.port, 8642, "api.port", 1),
      keyEnv: str(api.keyEnv, "CARL_API_KEY", "api.keyEnv"),
    },
    stt: raw.stt === undefined ? undefined : strList(raw.stt, "stt").map((p, i) => (i === 0 ? expandHome(p) : p)),
    idleResetMinutes: int(raw.idleResetMinutes, 0, "idleResetMinutes", 0),
    ultraterm: raw.ultraterm
      ? { home: abs(str(raw.ultraterm.home, "~/.hermes", "ultraterm.home"), home), overseerBin: abs(str(raw.ultraterm.overseerBin, "~/.ultraterm/bin/ut-overseer", "ultraterm.overseerBin"), home) }
      : undefined,
    learning: learningMode(raw.learning, !!raw.ultraterm),
    envFiles: strList(raw.envFiles, "envFiles").map((p) => abs(p, home)),
    shellEnv: strList(raw.shellEnv, "shellEnv"),
    agentWritable: strList(raw.agentWritable, "agentWritable").map((p) => abs(p, home)),
    trustedMcp: strList(raw.trustedMcp, "trustedMcp"),
    ultracompress: raw.ultracompress === "off" || raw.ultracompress === false ? "off" : "auto",
    hooks: hooksOf(raw.hooks),
    asks: raw.asks === undefined ? false : bool(raw.asks, "asks"),
    guard: { hardline: pairs(raw.guard?.hardline, "guard.hardline"), dangerous: pairs(raw.guard?.dangerous, "guard.dangerous"), allowTools: pairs(raw.guard?.allowTools, "guard.allowTools"), operatorTools: pairs(raw.guard?.operatorTools, "guard.operatorTools") },
    claude: {
      enabled: raw.claude?.enabled === undefined ? true : bool(raw.claude.enabled, "claude.enabled"),
      command: raw.claude?.command ? abs(str(raw.claude.command, "claude", "claude.command"), home) : undefined,
      configDirs: strList(raw.claude?.configDirs, "claude.configDirs").map((p) => abs(p, home)),
    },
  };
  for (const n of cfg.trustedMcp) if (!/^[A-Za-z0-9_-]{1,32}$/.test(n))
    throw new ConfigError(`trustedMcp: "${n}" must be 1-32 letters, digits, - or _ (longer names get shortened tool names the guard could not attribute)`);
  if ((cfg.home + "/").startsWith(cfg.workspace.replace(/\/+$/, "") + "/"))
    throw new ConfigError(`workspace (${cfg.workspace}) must not contain CARL_HOME (${cfg.home}): the agent would be able to rewrite Carl's own configuration`);
  if (!THINKING.has(cfg.thinking)) throw new ConfigError(`thinking must be one of ${[...THINKING].join(", ")}`);
  if (!cfg.model.includes("/")) throw new ConfigError(`model "${cfg.model}" must be "provider/model"`);
  if (cfg.keepRecentTokens >= cfg.contextBudget) throw new ConfigError("keepRecentTokens must be below contextBudget");
  return cfg;
}

function groupsOf(raw: unknown): TelegramGroup[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError("telegram.groups must be a list of {chat, members}");
  return raw.map((g: any, i: number) => {
    const chat = Number(g?.chat);
    if (!Number.isSafeInteger(chat) || chat >= 0) throw new ConfigError(`telegram.groups[${i}].chat must be a negative Telegram group id`);
    const members: Record<string, string> = {};
    for (const [id, name] of Object.entries(g?.members ?? {})) {
      if (!/^\d+$/.test(id)) throw new ConfigError(`telegram.groups[${i}].members: "${id}" must be a numeric Telegram user id`);
      if (typeof name !== "string" || !name.trim()) throw new ConfigError(`telegram.groups[${i}].members.${id} must be a name`);
      members[id] = name.trim();
    }
    return { chat, members, listenAll: g?.listenAll === undefined ? false : bool(g.listenAll, `telegram.groups[${i}].listenAll`) };
  });
}

/** Carl's MCP server list. */
export function mcpFile(cfg: CarlConfig): string {
  return join(cfg.home, "mcp.json");
}

/** Earlier versions kept the SDK folder at CARL_HOME/pi with mcp.json inside it: move both to their current places. */
function migrateLayout(home: string): void {
  const old = join(home, "pi");
  if (!existsSync(old)) return;
  if (existsSync(join(old, "mcp.json")) && !existsSync(join(home, "mcp.json"))) renameSync(join(old, "mcp.json"), join(home, "mcp.json"));
  if (!existsSync(join(home, "engine"))) renameSync(old, join(home, "engine"));
}

export function ensureHome(cfg: CarlConfig): void {
  migrateLayout(cfg.home);
  for (const dir of [cfg.home, cfg.workspace, join(cfg.home, "sessions"), join(cfg.home, "psyche"), join(cfg.home, "logs"), join(cfg.home, "state"), join(cfg.home, "media")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function str(v: unknown, def: string, name: string): string {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string" || (!v && def)) throw new ConfigError(`${name} must be a non-empty string`);
  return v;
}
function int(v: unknown, def: number, name: string, min: number): number {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return n;
}
function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new ConfigError(`${name} must be true or false`);
  return v;
}
function strList(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(`${name} must be a list of strings`);
  return v as string[];
}

function pairs(v: unknown, name: string): [string, string][] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((x) => typeof x !== "string")))
    throw new ConfigError(`${name} must be a list of [regex, reason] pairs`);
  for (const [src] of v as [string, string][]) {
    try { new RegExp(src); } catch (e) { throw new ConfigError(`${name}: bad regex ${JSON.stringify(src)}: ${(e as Error).message}`); }
  }
  return v as [string, string][];
}

function hooksOf(v: unknown): Record<string, { prompt: string; deliver: string; secretEnv?: string }> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError("hooks must be an object of name -> {prompt, deliver, secretEnv}");
  const out: Record<string, { prompt: string; deliver: string; secretEnv?: string }> = {};
  for (const [name, h] of Object.entries(v as Record<string, any>)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new ConfigError(`hooks.${name}: names use letters, digits, _ and - (max 64)`);
    if (typeof h?.prompt !== "string" || !h.prompt.trim()) throw new ConfigError(`hooks.${name}.prompt is required`);
    out[name] = { prompt: h.prompt, deliver: typeof h.deliver === "string" ? h.deliver : "home", secretEnv: typeof h.secretEnv === "string" ? h.secretEnv : undefined };
  }
  return out;
}

function learningMode(v: unknown, ultraterm: boolean): "carl" | "ultraterm" {
  if (v === undefined) return ultraterm ? "ultraterm" : "carl";
  if (v === "carl" || v === "ultraterm") return v;
  throw new ConfigError(`learning must be "carl" or "ultraterm" (got ${JSON.stringify(v)})`);
}
