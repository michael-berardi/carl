// The brain: one Pi AgentSession per conversation, created lazily, persisted as Pi JSONL, disposed when idle.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type CarlConfig, mcpFile, ConfigError, MODEL_REQUIRED } from "./config.ts";
import type { Log } from "./log.ts";
import { resultBudget } from "./budget.ts";
import { sessionPrograms } from "./post/key.ts";
import { readOnlyCache, writeReadOnlyCache } from "./post/safety.ts";
import { adoptTrustedPath, executableChain, installProfile, NO_EXEC, operatorPath, operatorPathDirs, readSandboxed, CREDENTIAL_NAME, sandboxMcpServer, secretEnvNames, sandboxSpawnHook, secretDirs, secretFiles, writablePaths } from "./sandbox.ts";
import { resolveClaude } from "./providers/claude-code.ts";
import { cooldownMs, isExhaustion } from "./router.ts";
import { claudeCodeProviderConfig, closeSpares, PROVIDER as CLAUDE_PROVIDER, sweepCallFolders } from "./providers/claude-code.ts";
import { createRouter } from "./router.ts";
import { type Approver, guardedFileOps, guardedReadOps, shellGuard } from "./guard.ts";
import { looksLikeCorrection, type Psyche } from "./psyche.ts";

export interface Inbound {
  text: string;
  images?: ImageContent[];
  /** Who sent it, for the transcript and the API mirror. */
  source: "telegram" | "api" | "schedule" | "cli";
  /** A team member in a group, not the operator: their words never count as the operator's approval. */
  member?: string;
  /** Extra instruction for this message only (e.g. mirror mode). Sent as a hidden preface. */
  preface?: string;
}

export interface ReplySink {
  /** The caller's run started with this id (not called when the message was steered into another run). */
  onRunStart?(runId: number): void;
  /** A new assistant message starts (after tools the visible text restarts). */
  onMessageStart?(): void;
  /** Streaming text of the assistant message being written. */
  onText?(text: string): void;
  /** A tool started; `detail` is a one-line summary of its arguments. */
  onTool?(name: string, detail: string): void;
  /** The run settled. */
  onDone?(result: RunResult): void;
}

export interface RunResult {
  text: string;
  ok: boolean;
  error?: string;
  aborted: boolean;
  toolCalls: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  model: string;
  ms: number;
  /** True when the message was steered into a run that was already going. */
  steered?: boolean;
}

/** Transcript events for observers (UltraTerm state.db mirror, message log). */
export interface TranscriptEvent {
  conversation: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };
  source: Inbound["source"];
  at: number;
}

interface Conversation {
  key: string;
  session: AgentSession;
  busy: boolean;
  /** A compaction is running: there is no turn to steer into, so every caller waits. */
  compacting?: boolean;
  lastActivity: number;
  source: Inbound["source"];
  /** The operator's latest message when this is their attended chat (telegram or the local CLI); never set by schedules or the API. */
  operatorText?: string;
  pending?: Promise<RunResult>;
  /** Set by stop(): an abort the operator asked for is "stopped", not "failed". */
  stopRequested?: boolean;
  /** Increments per run, so a caller can stop its own run and nobody else's. */
  runId?: number;
}

const IDLE_DISPOSE_MS = 30 * 60_000;

export class Brain extends EventEmitter {
  private runtime!: ModelRuntime;
  private readonly conversations = new Map<string, Conversation>();
  private readonly creating = new Map<string, Promise<Conversation>>();
  private sweeper?: NodeJS.Timeout;
  readonly startedAt = Date.now();
  readonly piDir: string;
  /** Claude login order. A host plugin (UltraTerm) may replace this to balance accounts by live usage. */
  claudeAccounts: () => string[] = () => this.cfg.claude.configDirs;
  /** Models currently cooling down after a quota refusal (ref -> until epoch ms). */
  routerState = new Map<string, number>();
  /** Fallbacks that resolve in this runtime. One that does not (its provider is off or unregistered) is skipped with
   *  a named warning instead of blocking startup: a configured Claude link is skipped when claude.enabled is false. */
  private fallbackRefs: string[] = [];
  /** True once the carl/auto router is registered. */
  private routerReady = false;
  /** The model sessions select: the router when fallbacks are configured and resolvable, else the primary. */
  sessionModelRef(): string {
    return this.routerReady ? "carl/auto" : this.cfg.model;
  }
  /** Whether a model can be called at all: its provider has a login. Claude Code's login lives in the CLI. */
  private usableModel(ref: string): boolean {
    const provider = this.model(ref).provider;
    if (provider === CLAUDE_PROVIDER) return this.cfg.claude.enabled && !!resolveClaude(this.cfg.claude.command, process.env);
    return this.runtime.hasConfiguredAuth(provider);
  }
  /** Which chain link a failed message came from. A provider that reports another id in its message (a proxy, a
   *  test double) is matched on the model id alone; undefined when no link matches. */
  private failedRef(m: any): string | undefined {
    const chain = [this.cfg.model, ...this.fallbackRefs];
    const exact = chain.find((r) => { const x = this.model(r); return x.provider === m?.provider && x.id === m?.model; });
    return exact ?? chain.find((r) => this.model(r).id === m?.model);
  }
  /** The next chain link after `failed` that is not benched and has a login; undefined when none is left. */
  private nextFallback(failed: string): string | undefined {
    for (const ref of [this.cfg.model, ...this.fallbackRefs]) {
      if (ref === failed) continue;
      if ((this.routerState.get(ref) ?? 0) > Date.now()) continue;
      if (!this.usableModel(ref)) continue;
      return ref;
    }
    return undefined;
  }
  /** Asks the operator to approve a dangerous shell command for a conversation. Default: unattended (refuse). */
  approver: (key: string) => Approver = () => async () => "unattended";

  readonly cfg: CarlConfig;
  readonly psyche: Psyche;
  readonly log: Log;
  private readonly tools: () => ToolDefinition[];
  /**
   * `shared`: this is the gateway, which owns CARL_HOME/state/bin and state/sandbox.sb. Other commands (ask, doctor,
   * prompt) keep theirs in state/run/<pid>, removed at shutdown, so they never rewrite a running gateway's.
   */
  constructor(cfg: CarlConfig, psyche: Psyche, log: Log, tools: () => ToolDefinition[], opts: { shared?: boolean } = {}) {
    super();
    this.opts = opts;
    this.cfg = cfg;
    this.psyche = psyche;
    this.log = log;
    this.tools = tools;
    // The SDK's own folder (settings it may write); Carl's MCP servers live in CARL_HOME/mcp.json.
    this.piDir = join(cfg.home, "engine");
  }

  /** Everything Carl executes or loads, outside the agent's working areas: the agent must not be able to change it. */
  private controlPlane(forSandbox = true): string[] {
    const out = new Set<string>();
    const add = (p: string | undefined) => { if (p) out.add(p); };
    const realOf = (p: string) => { try { return realpathSync(p); } catch { return p; } };
    add(fileURLToPath(new URL("..", import.meta.url))); // Carl's own code and node_modules
    add(this.cfg.agentDir);
    add(dirname(dirname(realOf(process.execPath)))); // the Node install running Carl
    if (this.claudeBin) add(dirname(dirname(realOf(this.claudeBin))));
    const uc = findUltraCompress();
    if (uc) add(realOf(uc));
    for (const p of this.cfg.extensions) if (!p.includes(":")) add(p);
    for (const p of this.cfg.skills) add(p); // skills reach the prompt
    if (this.cfg.ultraterm) {
      // UltraTerm's helpers (the control binary and its sibling helpers) run outside the sandbox: their whole folder is protected.
      const bin = this.cfg.ultraterm.controlBin;
      if (bin) {
        add(dirname(bin));
        add(dirname(realOf(bin)));
        // ...and the Python runtime they run on.
        const runtime = join(dirname(dirname(bin)), "runtime");
        add(runtime);
        add(realOf(runtime));
      }
      for (const f of ["gateway_state.json", "state.db", "state.db-wal", "state.db-shm"]) add(join(this.cfg.ultraterm.home, f));
    }
    add(join(homedir(), "Applications", "Carl.app"));
    // Context files are protected too, except the agent's own notes inside its working areas.
    const free = writablePaths(this.cfg).map((w) => w.replace(/\/+$/, "") + "/");
    for (const p of this.cfg.contextFiles) if (!free.some((w) => (p + "/").startsWith(w))) add(p);
    // A protected folder that holds a working area would lock the agent out of it (denies come after the allows):
    // such folders are left out, and the programs in them are still pinned one by one (pinnedPaths).
    // Compared as given and resolved: /var and /private/var (or a linked home) name the same folder.
    const freeReal = writablePaths(this.cfg).map((w) => realOf(w).replace(/\/+$/, "") + "/");
    // The file-tool guard gets every folder: there, working areas already win over protected paths.
    if (!forSandbox) return [...out];
    return [...out].filter((p) => {
      const inside = free.some((w) => w.startsWith(p.replace(/\/+$/, "") + "/")) || freeReal.some((w) => w.startsWith(realOf(p).replace(/\/+$/, "") + "/"));
      if (inside) this.log.warn("not protecting a folder that contains a working area; its programs are pinned individually", { path: p });
      return !inside;
    });
  }

  /**
   * Program paths Carl starts outside the sandbox: they, every link on the way and every folder above them cannot be
   * replaced. Also `node` in each folder of the operator's PATH, which Carl's launcher resolves at the next start.
   */
  private pinnedPaths(): string[] {
    const ut = this.cfg.ultraterm?.controlBin;
    const bins = [...Object.values(this.trusted), ut, ut && join(dirname(ut), "ut-provider-accounts"), process.argv[1]];
    return [...new Set([
      ...bins.filter((b): b is string => !!b).flatMap(executableChain),
      ...operatorPathDirs().map((d) => join(d, "node")),
    ])];
  }

  /** Path rules for the file tools: Carl's control plane (CARL_HOME minus working areas, plus what it loads) and secrets. */
  private guardRules() {
    return {
      ...this.cfg.guard,
      protectedPaths: [this.cfg.home, ...this.controlPlane(false)],
      writablePaths: writablePaths(this.cfg),
      secretPaths: [...secretFiles(this.cfg), ...secretDirs(this.cfg)],
      denyBrowserCommand: this.browserCommandPattern(),
      isReadOnly: (name: string) => this.cfg.guard.readOnlyTools.includes(name) || (this.hintedReadOnly(name) ?? readOnlyCache(this.cfg.home).readOnly.has(name)),
      cwd: this.cfg.workspace,
      noExec: this.sandboxProfile ? NO_EXEC : [],
      sandboxed: !!this.sandboxProfile,
      trustedMcp: this.cfg.trustedMcp,
      sandboxProfile: this.sandboxProfile,
    };
  }

  /** Whenever post.browser.commandPattern is set (or accounts name session commands): shell commands that name the browser tooling are refused (post.browser.commandPattern, else the session commands' names). */
  private browserCommandPattern(): string | undefined {
    const accounts = Object.values(this.cfg.post.accounts);
    if (this.cfg.post.browser.commandPattern) return this.cfg.post.browser.commandPattern;
    if (!accounts.length) return undefined;
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...new Set(accounts.map((a) => esc(basename(a.session.command))))].join("|");
  }

  private fileTools(): ToolDefinition[] {
    const cwd = this.cfg.workspace;
    const make: Record<string, () => ToolDefinition> = {
      read: () => createReadToolDefinition(cwd, { operations: guardedReadOps(this.guardRules()) }) as ToolDefinition,
      // A fixed outer shell: a login shell like zsh would source startup files outside the sandbox first.
      bash: () => createBashToolDefinition(cwd, { shellPath: "/bin/bash", spawnHook: sandboxSpawnHook(this.cfg, this.sandboxProfile) }) as ToolDefinition,
      edit: () => createEditToolDefinition(cwd, { operations: guardedFileOps(this.guardRules()) }) as ToolDefinition,
      write: () => createWriteToolDefinition(cwd, { operations: guardedFileOps(this.guardRules()) }) as ToolDefinition,
    };
    for (const t of this.cfg.tools) if (!make[t]) throw new Error(`tools: "${t}" is not one of read, bash, edit, write`);
    return this.cfg.tools.map((t) => make[t]());
  }

  /** Seatbelt profile for shell commands (macOS); undefined where the kernel sandbox is unavailable. */
  private sandboxProfile?: string;
  private claudeBin?: string;
  private trusted: Record<string, string> = {};
  /** Programs the gateway resolved from the operator's PATH at init (for the post primitive's session-command check). */
  get resolvedPrograms(): Record<string, string> { return this.trusted; }
  private readonly opts: { shared?: boolean };
  private get stateDir(): string { return this.opts.shared ? join(this.cfg.home, "state") : join(this.cfg.home, "state", "run", String(process.pid)); }
  /** The shell sandbox profile, for helpers that run agent-influenced programs (undefined without Seatbelt). */
  get shellSandbox(): string | undefined { return this.sandboxProfile; }

  /** The vendored UltraCompress adapter, when its engine binary is installed (resolved once at init). */
  private ultracompressExt?: string;

  /** Pi's own validated mcp.json reader (not a public export; pinned SDK version). */
  private mcpLoader?: (o: { agentDir: string; cwd: string; projectTrusted: boolean }) => any;

  async init(): Promise<void> {
    mkdirSync(this.piDir, { recursive: true, mode: 0o700 });
    // Carl itself runs from a folder only it can write: its unsandboxed children (UltraTerm helpers, trusted MCP
    // servers, UltraCompress) never start in the agent's workspace, where a planted config file would be read.
    // Sessions, tools and sandboxed MCP servers get the workspace explicitly.
    mkdirSync(this.cfg.workspace, { recursive: true, mode: 0o700 });
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    process.chdir(this.stateDir);
    // Programs Carl (or its unsandboxed helpers) start by name are resolved once, now, from the operator's PATH;
    // from here on those children see only a private bin folder of links to them plus system folders, so a program
    // the agent plants later in a user-writable folder (~/.local/bin, Homebrew) is never picked up.
    const opEnv = { ...process.env, PATH: operatorPath() };
    this.claudeBin = this.cfg.claude.enabled ? resolveClaude(this.cfg.claude.command, opEnv) : undefined;
    const uc = findUltraCompress(opEnv);
    if (uc) process.env.ULTRACOMPRESS_BIN = uc; // the UltraCompress adapter's first candidate: no second lookup
    process.env.ULTRACOMPRESS_STATE_ROOT = join(this.cfg.home, "state", "ultracompress");
    process.env.ULTRACOMPRESS_SESSION_ROOT = join(this.cfg.home, "sessions");
    mkdirSync(process.env.ULTRACOMPRESS_SESSION_ROOT, { recursive: true, mode: 0o700 });
    const ut = this.cfg.ultraterm?.controlBin;
    this.trusted = adoptTrustedPath(join(this.stateDir, "bin"),
      { node: process.execPath, claude: this.claudeBin, ultracompress: uc, tmux: undefined, git: undefined, ...sessionPrograms(this.cfg.post.accounts) }, ut ? [dirname(ut)] : []);
    const leaked = Object.keys(process.env).filter((n) => secretEnvNames(this.cfg).includes(n) || CREDENTIAL_NAME.test(n));
    if (leaked.length) this.log.warn("credentials are in Carl's process environment; on macOS any program of this user can read another's startup environment, so keep them in files (CARL_HOME/.env) instead", { names: leaked.join(",") });
    this.sandboxProfile = installProfile(this.cfg, { controlPlane: this.controlPlane(), pinned: this.pinnedPaths(), apiPorts: this.cfg.api.enabled ? [this.cfg.api.port] : [] }, join(this.stateDir, "sandbox.sb"));
    if (this.sandboxProfile) this.log.info("shell sandbox: Seatbelt", { profile: this.sandboxProfile });
    else this.log.warn("shell sandbox unavailable on this platform: the pattern guard and secret scrubbing still apply, but Carl's own files are not kernel-protected");
    if (this.cfg.ultracompress !== "off") {
      const bin = findUltraCompress();
      const ext = fileURLToPath(new URL("../vendor/ultracompress/index.ts", import.meta.url));
      if (bin && existsSync(ext)) {
        this.ultracompressExt = ext;
        this.log.info("compaction: UltraCompress", { bin });
        // UltraCompress keeps up to ~25k tokens of the newest turns verbatim; below about 40k there is often nothing
        // left to condense, it declines every time, and the context grows past the budget.
        if (this.cfg.contextBudget < 40_000)
          this.log.warn("contextBudget is below 40k tokens: UltraCompress keeps up to 25k tokens of recent turns verbatim and may find nothing to compact", { contextBudget: this.cfg.contextBudget });
      } else {
        this.log.info("compaction: Pi built-in summary (no ultracompress binary found)");
      }
    }
    if (this.cfg.mcp && existsSync(mcpFile(this.cfg))) {
      try {
        const url = new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
        this.mcpLoader = (await import(url.href)).loadMcpConfig;
        if (typeof this.mcpLoader !== "function") throw new Error("loadMcpConfig is not exported by this Pi SDK version");
      } catch (e) {
        this.mcpLoader = undefined;
        this.log.error("MCP disabled: cannot load Pi's MCP config reader", { error: (e as Error).message });
      }
    }
    this.runtime = await ModelRuntime.create({
      authPath: join(this.cfg.agentDir, "auth.json"),
      modelsPath: join(this.cfg.agentDir, "models.json"),
    });
    if (this.cfg.claude.enabled) {
      const swept = sweepCallFolders(join(this.cfg.home, "state", "claude-tmp"));
      if (swept) this.log.info("removed per-call Claude folders left by an earlier process", { count: swept });
      this.runtime.registerProvider(CLAUDE_PROVIDER, claudeCodeProviderConfig({
        command: this.claudeBin ?? this.cfg.claude.command,
        // Carl-only folders: the sandboxed agent cannot plant a CLAUDE.md or swap the per-call settings file.
        workdir: join(this.cfg.home, "state", "claude-cwd"),
        tmpRoot: join(this.cfg.home, "state", "claude-tmp"),
        configDirs: () => this.claudeAccounts(),
        log: (level, msg, data) => this.log[level](msg, data),
      }) as any);
    }
    if (!this.cfg.model) throw new ConfigError(MODEL_REQUIRED); // Carl ships no model choice: the operator names one
    this.model(this.cfg.model); // fail fast, naming the model, when it is unknown
    this.fallbackRefs = this.cfg.fallbackModels.filter((f) => {
      try {
        this.model(f);
        return true;
      } catch (e) {
        this.log.warn("fallback model unavailable; skipping it", { model: f, error: (e as Error).message });
        return false;
      }
    });
    if (this.fallbackRefs.length) {
      const router = createRouter({
        primary: () => this.cfg.model, // read per request: a model switch (portal, UltraTerm picker) takes effect at once
        fallbacks: () => this.fallbackRefs,
        resolve: (ref) => this.model(ref),
        usable: (ref) => this.usableModel(ref),
        events: {
          onFallback: (from, to, reason, until) => {
            this.log.warn("primary model unavailable; using the next model in the fallback chain", { from, to, until: new Date(until).toISOString(), reason });
            this.emit("fallback", { from, to, reason, until });
          },
        },
      });
      this.routerState = router.exhaustedUntil;
      this.routerReady = true;
      const primary = this.model(this.cfg.model);
      this.runtime.registerVirtualModel({
        provider: "carl",
        id: "auto",
        name: `${primary.name} (falls back to ${this.fallbackRefs.join(", ")})`,
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        contextWindow: primary.contextWindow,
        maxTokens: primary.maxTokens,
        route: (request) => router.route(request) as any,
      });
    }
    this.sweeper = setInterval(() => this.disposeIdle(), 60_000);
    this.sweeper.unref();
  }

  /** Resolve "provider/model" through Pi's registry. */
  model(ref: string) {
    const at = ref.indexOf("/");
    const provider = ref.slice(0, at);
    const id = ref.slice(at + 1);
    const m = this.runtime.getModel(provider, id);
    if (!m) {
      const known = this.runtime.getModels(provider).map((x) => x.id).slice(0, 12).join(", ");
      throw new Error(`model "${ref}" is not in Pi's registry${known ? ` (provider ${provider} has: ${known})` : ` (unknown provider ${provider})`}`);
    }
    return m;
  }

  listModels(): string[] {
    return this.runtime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`);
  }

  private systemPrompt(): string {
    const parts = this.psyche.promptSections();
    parts.push(`# Operating rules

- You run inside ${this.cfg.name}, a gateway: replies go to chat (Telegram or an API client). Keep them short; long output goes in a file you name.
- You cannot see the operator's screen. Never claim you did something you did not do in a tool call.
- Delegate long or parallel work instead of doing it all in this conversation, when a delegation tool or CLI is available.
- Load a skill (read its SKILL.md) before specialised work that matches its description.
- Record operator decisions with decision_log when they make one that matters; record your own failures with shadow_note.${this.cfg.asks ? "\n- You have open asks (ask_open) when people owe answers. A group message that answers one: record each answer with ask_answer, ask a short follow-up for anything unclear or missing, and once all are answered run ask_finish and tell them the work is starting." : ""}
- Current date: ${new Date().toISOString().slice(0, 10)}.${this.cfg.skills.length ? `\n- More skills than those listed live in ${this.cfg.skills.join(", ")} (one directory per skill, SKILL.md inside); look there when a task needs specialised know-how.` : ""}`);
    return parts.join("\n\n");
  }

  private contextFiles(): { path: string; content: string }[] {
    const out: { path: string; content: string }[] = [];
    for (const path of this.cfg.contextFiles) {
      if (!existsSync(path)) {
        this.log.warn("context file missing", { path });
        continue;
      }
      // Every context file is read the way the agent would read it (inside the sandbox): a link planted in the
      // agent's areas, or anywhere on the way to the file, cannot pull a secret into the system prompt.
      try {
        out.push({ path, content: this.sandboxProfile ? readSandboxed(this.sandboxProfile, path) : readFileSync(path, "utf8") });
      } catch (e) {
        this.log.warn("context file not loaded", { path, error: (e as Error).message });
      }
    }
    return out;
  }

  /** The exact system prompt and tool set a new conversation gets (for `carl prompt`). */
  async inspect(): Promise<{ systemPrompt: string; tools: { name: string; chars: number }[] }> {
    const convo = await this.createConversation("inspect", "cli", true, true);
    try {
      const all = (convo.session as any).agent?.state?.tools ?? [];
      const active = new Set(convo.session.getActiveToolNames());
      const tools = all
        .filter((t: any) => active.has(t.name))
        .map((t: any) => ({ name: t.name, chars: JSON.stringify({ n: t.name, d: t.description, p: t.parameters }).length }));
      return { systemPrompt: convo.session.systemPrompt, tools };
    } finally {
      await this.closeSession(convo.session);
    }
  }

  private async createConversation(key: string, source: Inbound["source"], fresh: boolean, inMemory = false): Promise<Conversation> {
    const dir = sessionDir(this.cfg.home, key);
    if (!inMemory) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "key"), key, { mode: 0o600 }); // the original key, for listings (the dir name is sanitised)
    }
    const model = this.model(this.sessionModelRef());
    const budget = Math.min(this.cfg.contextBudget, model.contextWindow || this.cfg.contextBudget);
    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        // Pi compacts when context > window - reserve. Reserve the gap so Carl compacts at its own budget.
        reserveTokens: Math.max((model.contextWindow || budget * 2) - budget, 8_000),
        keepRecentTokens: this.cfg.keepRecentTokens,
      },
      retry: { enabled: true, maxRetries: 3 },
    } as any);
    const extensionFactories: InlineExtension[] = [
      shellGuard(this.approver(key), (command, why) =>
        this.psyche.recordShadow({ kind: "tool_error", conversation: key, summary: `blocked: ${why}`, evidence: command.slice(0, 500) }),
        { ...this.guardRules(), operatorText: () => this.conversations.get(key)?.operatorText }),
      resultBudget(join(this.cfg.home, "spill"), this.cfg.toolResultMaxChars),
    ];
    if (this.cfg.mcp && existsSync(mcpFile(this.cfg)) && this.mcpLoader) {
      // MCP servers reach the model through codemode: one tool, scripts call servers in parallel and
      // filter large results before they enter the context.
      extensionFactories.push(
        createCodemodeExtension({ mode: "on" }) as InlineExtension,
        createToolSearchExtension() as InlineExtension,
        createMcpExtension({
          logPath: join(this.cfg.home, "logs", "mcp.log"),
          // The SDK's default loader reads ~/.pi/agent/mcp.json; Carl's servers live in CARL_HOME/mcp.json.
          loadConfig: (ctx: any) => {
            const loaded = this.mcpLoader!({ agentDir: this.cfg.home, cwd: ctx.cwd, projectTrusted: false }); // reads CARL_HOME/mcp.json
            // Stdio servers run under the shell sandbox too, with Carl's secrets blanked in their environment.
            // ...except the operator's own control tools named in trustedMcp, which enforce their own policy.
            for (const s of loaded.servers ?? []) {
              if (!s.config?.command) continue;
              if (this.cfg.trustedMcp.includes(s.name)) s.config = { ...s.config, cwd: s.config.cwd ?? this.stateDir };
              else s.config = sandboxMcpServer(this.cfg, this.sandboxProfile, { ...s.config, cwd: s.config.cwd ?? this.cfg.workspace });
            }
            return loaded;
          },
        }) as InlineExtension,
      );
    }
    const loader = new DefaultResourceLoader({
      cwd: this.cfg.workspace,
      agentDir: this.piDir,
      settingsManager,
      additionalExtensionPaths: [...(this.ultracompressExt ? [this.ultracompressExt] : []), ...this.cfg.extensions],
      additionalSkillPaths: this.cfg.skills,
      // Only configured skill directories count (Pi would also pick up user-global ones), and an allowlist
      // keeps even the name+description index small.
      skillsOverride: (base) => ({
        skills: base.skills.filter(
          (s) => this.cfg.skills.some((d) => s.filePath.startsWith(d.endsWith("/") ? d : d + "/")) && (!this.cfg.skillAllow.length || this.cfg.skillAllow.includes(s.name)),
        ),
        diagnostics: base.diagnostics,
      }),
      extensionFactories,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: this.systemPrompt(),
      appendSystemPrompt: [],
      agentsFilesOverride: () => ({ agentsFiles: this.contextFiles() }),
    });
    await loader.reload();
    const sessionManager = inMemory
      ? SessionManager.inMemory(this.cfg.workspace)
      : fresh ? SessionManager.create(this.cfg.workspace, dir) : SessionManager.continueRecent(this.cfg.workspace, dir);
    const { session, extensionsResult } = await createAgentSession({
      cwd: this.cfg.workspace,
      agentDir: this.piDir,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: this.cfg.thinking,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      // Pi's default built-ins are read, bash, edit, write; switch off the ones the config leaves out.
      // (An allowlist would also switch off extension tools, so Carl excludes instead.)
      // Pi's built-ins are switched off and Carl supplies its own definitions of the configured ones: the same
      // tools, with bash wrapped in the sandbox. (Excluding a built-in by name would also exclude a replacement.)
      noTools: "builtin",
      customTools: [...this.fileTools(), ...this.tools()] as ToolDefinition[],
    });
    for (const err of extensionsResult.errors ?? []) this.log.error("extension failed to load", { error: String((err as any).error ?? err), path: (err as any).path });
    await session.bindExtensions({});
    this.cacheMcpAnnotations(session);
    const convo: Conversation = { key, session, busy: false, lastActivity: Date.now(), source };
    this.observe(convo);
    this.log.info("conversation opened", { key, sessionId: session.sessionId, fresh, messages: session.messages.length });
    return convo;
  }

  /** The live readOnlyHint of this "server/tool" in any open conversation: true if any listing says true and none says false, false if a live listing says false (it overrides a cached true), undefined if it is not listed now. */
  private hintedReadOnly(name: string): boolean | undefined {
    let seen: boolean | undefined;
    for (const convo of this.conversations.values()) {
      try {
        for (const t of (convo.session as any).getAllTools?.() ?? []) {
          const server = this.cfg.trustedMcp.find((s) => String(t.name).startsWith(`mcp__${s.replace(/[^A-Za-z0-9_]/g, "_")}__`));
          if (!server || `${server}/${String(t.name).slice(`mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`.length)}` !== name) continue;
          if (t.annotations?.readOnlyHint !== true) return false;
          seen = true;
        }
      } catch { /* a session being torn down: not a hint */ }
    }
    return seen;
  }

  /** Remember which trusted-server tools publish readOnlyHint: true; kept in state/mcp-readonly.json (post/safety.ts) for the guard. */
  private cacheMcpAnnotations(session: any): void {
    if (!this.cfg.trustedMcp.length) return;
    try {
      const listed: Record<string, boolean> = {};
      for (const t of session.getAllTools?.() ?? []) {
        const server = this.cfg.trustedMcp.find((s) => String(t.name).startsWith(`mcp__${s.replace(/[^A-Za-z0-9_]/g, "_")}__`));
        if (!server) continue;
        listed[`${server}/${String(t.name).slice(`mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`.length)}`] = t.annotations?.readOnlyHint === true;
      }
      if (Object.keys(listed).length) writeReadOnlyCache(this.cfg.home, listed);
    } catch (e) { this.log.warn("could not cache MCP tool annotations", { error: (e as Error).message }); }
  }

  private async get(key: string, source: Inbound["source"]): Promise<Conversation> {
    const existing = this.conversations.get(key);
    if (existing) {
      const idleMs = this.cfg.idleResetMinutes * 60_000;
      if (idleMs > 0 && !existing.busy && Date.now() - existing.lastActivity > idleMs) {
        await this.reset(key);
        return this.conversations.get(key)!;
      }
      return existing;
    }
    let pending = this.creating.get(key);
    if (!pending) {
      pending = this.createConversation(key, source, false).finally(() => this.creating.delete(key));
      this.creating.set(key, pending);
    }
    const convo = await pending;
    this.conversations.set(key, convo);
    return convo;
  }

  /** Send a message. While a run is going it is steered into that run; the steered call resolves immediately. */
  async ask(key: string, input: Inbound, sink: ReplySink = {}): Promise<RunResult> {
    const convo = await this.get(key, input.source);
    convo.lastActivity = Date.now();
    const text = input.preface ? `${input.preface}\n\n---\n\n${input.text}` : input.text;
    if (looksLikeCorrection(input.text)) {
      const prev = convo.session.getLastAssistantText() ?? "";
      this.psyche.recordShadow({ kind: "correction", conversation: key, summary: input.text.replace(/\s+/g, " ").slice(0, 300), evidence: prev.slice(-1_000) });
    }
    // API clients expect an answer to each request: wait for the running turn, then run. Chat steers.
    while (convo.busy && convo.pending && (input.source !== "telegram" || convo.compacting)) await convo.pending.catch(() => {});
    this.emitTranscript(convo, { role: "user", text: input.text, source: input.source });
    convo.operatorText = (input.source === "telegram" || input.source === "cli") && !input.member ? input.text : undefined;
    if (convo.busy) {
      await convo.session.steer(text, input.images);
      this.log.info("steered into running turn", { key });
      return { text: "", ok: true, aborted: false, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, model: this.modelRef(convo), ms: 0, steered: true };
    }
    convo.busy = true;
    convo.source = input.source;
    const run = this.run(convo, text, input.images, sink).finally(() => {
      convo.busy = false;
      convo.lastActivity = Date.now();
      convo.pending = undefined;
    });
    convo.pending = run;
    return run;
  }

  private async run(convo: Conversation, text: string, images: ImageContent[] | undefined, sink: ReplySink): Promise<RunResult> {
    const started = Date.now();
    convo.stopRequested = false;
    convo.runId = (convo.runId ?? 0) + 1;
    sink.onRunStart?.(convo.runId);
    let live = "";
    let toolCalls = 0;
    /** Tool calls in the attempt that is running now, so a failed attempt with side effects is never repeated. */
    let attemptTools = 0;
    const errors: string[] = [];
    // Collected from events, not by slicing session.messages: a compaction mid-run rewrites that list.
    let lastAssistant: any;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const unsubscribe = convo.session.subscribe((e: AgentSessionEvent) => {
      if (e.type === "message_start" && (e.message as any).role === "assistant") {
        live = "";
        sink.onMessageStart?.();
      }
      if (e.type === "message_end" && (e.message as any).role === "assistant") {
        const m = e.message as any;
        lastAssistant = m;
        usage.input += m.usage?.input ?? 0;
        usage.output += m.usage?.output ?? 0;
        usage.cacheRead += m.usage?.cacheRead ?? 0;
        usage.cacheWrite += m.usage?.cacheWrite ?? 0;
        usage.cost += m.usage?.cost?.total ?? 0;
      }
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        live += e.assistantMessageEvent.delta;
        sink.onText?.(live);
      }
      if (e.type === "tool_execution_start") {
        toolCalls++;
        attemptTools++;
        sink.onTool?.(e.toolName, summarizeArgs(e.args));
      }
      if (e.type === "tool_execution_end" && e.isError) {
        const msg = toolResultText(e.result).slice(0, 600);
        const sig = `${e.toolName}:${msg.slice(0, 80)}`;
        if (!errors.includes(sig)) {
          errors.push(sig);
          this.psyche.recordShadow({ kind: "tool_error", conversation: convo.key, summary: `${e.toolName} failed`, evidence: msg });
        }
      }
    });
    let thrown: Error | undefined;
    // Pi retries the failures it classifies as transient. A refusal it does not retry (OpenRouter's 402
    // "insufficient credits" and its 404 "no endpoints available" are not in that set) would end the turn as a
    // stall, so Carl benches the failed model and runs the same turn again on the next link of the chain. Only
    // while nothing was written and no tool ran: a partial answer or a started tool call belongs to its model.
    let attempt = 0;
    for (;;) {
      thrown = undefined;
      lastAssistant = undefined;
      live = "";
      attemptTools = 0;
      try {
        // Never run Pi extension /commands from message text: a schedule or webhook prompt is data, not a command.
        await convo.session.prompt(text, { images, source: "rpc", expandPromptTemplates: false } as any);
      } catch (e) {
        thrown = e as Error;
      }
      if (convo.stopRequested || !this.routerReady) break;
      const failed = lastAssistant?.stopReason === "error"
        ? { stopReason: "error" as const, errorMessage: lastAssistant.errorMessage ?? "" }
        : undefined;
      if (!failed || !isExhaustion(failed)) break;
      const failedRef = this.failedRef(lastAssistant);
      if (!failedRef) break;
      const until = Date.now() + cooldownMs(failed.errorMessage ?? "");
      this.routerState.set(failedRef, until); // benched either way: the next turn starts elsewhere
      // The failure came after output or after a tool ran: finish this turn on its own model (its words and tool
      // calls belong to it), never switch mid-turn and duplicate them. The next turn moves on.
      if (assistantText(lastAssistant).trim() || attemptTools > 0) break;
      const next = attempt < this.fallbackRefs.length ? this.nextFallback(failedRef) : undefined;
      if (!next) break;
      const reason = (failed.errorMessage ?? "").slice(0, 200);
      this.log.warn("primary model unavailable; retrying the turn on the next model in the fallback chain",
        { from: failedRef, to: next, until: new Date(until).toISOString(), reason });
      this.emit("fallback", { from: failedRef, to: next, reason, until });
      attempt++;
    }
    unsubscribe();
    const operatorStop = !!convo.stopRequested;
    const aborted = lastAssistant?.stopReason === "aborted" || operatorStop;
    convo.stopRequested = false;
    const error = aborted
      ? undefined
      : thrown
      ? thrown.message || String(thrown) || "the run failed without a message"
      : lastAssistant?.stopReason === "error"
        ? lastAssistant.errorMessage || "the model returned an error without a message"
        : !lastAssistant
          ? "the model produced no reply"
          : undefined;
    let replyText = lastAssistant ? assistantText(lastAssistant) : "";
    if (lastAssistant?.stopReason === "length") replyText += "\n\n(cut off: the reply hit the output limit)";
    const result: RunResult = {
      text: replyText,
      ok: !error && !aborted,
      error,
      aborted,
      toolCalls,
      usage,
      // The physical model that answered (a router selection names the model it routed to).
      model: lastAssistant?.provider ? `${lastAssistant.provider}/${lastAssistant.model}` : this.modelRef(convo),
      ms: Date.now() - started,
    };
    if (error) this.psyche.recordShadow({ kind: "run_failed", conversation: convo.key, summary: `run failed: ${error.slice(0, 200)}`, evidence: text.slice(0, 500) });
    if (aborted && operatorStop) this.psyche.recordShadow({ kind: "aborted", conversation: convo.key, summary: "run stopped by the operator", evidence: text.slice(0, 300) });
    this.log.info("run settled", { key: convo.key, ok: result.ok, ms: result.ms, toolCalls, in: usage.input, out: usage.output, cached: usage.cacheRead, error });
    sink.onDone?.(result);
    return result;
  }

  private modelRef(convo: Conversation): string {
    const m = convo.session.model;
    return m ? `${m.provider}/${m.id}` : this.cfg.model;
  }

  private observe(convo: Conversation): void {
    convo.session.subscribe((e: AgentSessionEvent) => {
      const ev = e as any;
      if (ev.type === "compaction_start") this.log.info("compaction started", { key: convo.key, reason: ev.reason });
      if (ev.type === "compaction_end") {
        const fields = { key: convo.key, reason: ev.reason, aborted: !!ev.aborted, willRetry: !!ev.willRetry, tokensBefore: ev.result?.tokensBefore };
        if (ev.errorMessage) this.log.error("compaction failed", { ...fields, error: ev.errorMessage });
        else this.log.info(ev.result ? "compaction finished" : "compaction ended without a result", fields);
      }
      if (e.type !== "message_end") return;
      const m = e.message as any;
      if (m.role === "assistant") {
        const calls = (m.content ?? []).filter((c: any) => c.type === "toolCall").map((c: any) => ({ id: c.id, name: c.name, args: c.arguments }));
        const u = m.usage ?? {};
        this.emitTranscript(convo, {
          role: "assistant",
          text: assistantText(m),
          toolCalls: calls.length ? calls : undefined,
          model: `${m.provider}/${m.model}`,
          usage: { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, reasoning: u.reasoning ?? 0, cost: u.cost?.total ?? 0 },
          source: convo.source,
        });
      } else if (m.role === "toolResult") {
        this.emitTranscript(convo, { role: "tool", text: toolResultText(m).slice(0, 4_000), toolName: m.toolName, toolCallId: m.toolCallId, source: convo.source });
      }
    });
  }

  private emitTranscript(convo: Conversation, e: Omit<TranscriptEvent, "conversation" | "sessionId" | "at">): void {
    this.emit("transcript", { ...e, conversation: convo.key, sessionId: convo.session.sessionId, at: Date.now() } satisfies TranscriptEvent);
  }

  /** Stop the running turn; with runId, only if that run is still the one running. */
  async stop(key: string, runId?: number): Promise<boolean> {
    const convo = this.conversations.get(key);
    if (!convo?.busy) return false;
    if (runId !== undefined && convo.runId !== runId) return false;
    convo.stopRequested = true;
    await convo.session.abort();
    return true;
  }

  /** Start a fresh session for this conversation; the old one stays on disk. */
  async reset(key: string): Promise<void> {
    const inflight = this.creating.get(key);
    if (inflight) await inflight.catch(() => {});
    const convo = this.conversations.get(key);
    // The fresh conversation is registered before anything is awaited: a message arriving while the old one closes
    // waits for the fresh one instead of resuming the old transcript.
    this.conversations.delete(key);
    const pending = (async () => {
      if (convo) {
        if (convo.busy) await convo.session.abort().catch(() => {});
        await this.closeSession(convo.session);
      }
      return this.createConversation(key, convo?.source ?? "cli", true);
    })().finally(() => this.creating.delete(key));
    this.creating.set(key, pending);
    this.conversations.set(key, await pending);
  }

  async compact(key: string): Promise<string> {
    const convo = await this.get(key, "cli");
    if (convo.busy) return "Busy; try again when the current run finishes.";
    const before = convo.session.getContextUsage()?.tokens;
    convo.busy = true;
    convo.compacting = true;
    const job = convo.session.compact().then(() => undefined, (e: Error) => e);
    // Other callers wait on `pending` exactly as they would for a run.
    convo.pending = job.then(() => ({ text: "", ok: true, aborted: false, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, model: this.modelRef(convo), ms: 0 }));
    const failure = await job;
    convo.compacting = false;
    convo.busy = false;
    convo.pending = undefined;
    convo.stopRequested = false;
    if (failure) return `Not compacted: ${failure.message}`;
    const after = convo.session.getContextUsage()?.tokens;
    return `Compacted${before ? ` from ~${before} tokens` : ""}${after ? ` to ~${after}` : ""}.`;
  }

  async setModel(key: string, ref: string): Promise<string> {
    const convo = await this.get(key, "cli");
    await convo.session.setModel(this.model(ref));
    return `${ref} for this conversation.`;
  }

  async status(key: string): Promise<Record<string, unknown>> {
    const convo = this.conversations.get(key);
    if (!convo) return { open: false };
    const stats = convo.session.getSessionStats();
    const ctx = convo.session.getContextUsage();
    return {
      open: true,
      busy: convo.busy,
      model: this.modelRef(convo),
      thinking: convo.session.thinkingLevel,
      sessionId: stats.sessionId,
      messages: stats.totalMessages,
      toolCalls: stats.toolCalls,
      tokens: stats.tokens,
      context: ctx ? { tokens: ctx.tokens, budget: Math.min(this.cfg.contextBudget, ctx.contextWindow) } : undefined,
    };
  }

  /** Resolves once a message for this conversation has reached a session (busy), or after 5 s. */
  async whenRegistered(key: string): Promise<void> {
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      if (this.conversations.get(key)?.busy) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Conversation keys and their state, for /v1/health and the status file. */
  activeConversations(): { key: string; busy: boolean; lastActivity: number }[] {
    return [...this.conversations.values()].map((c) => ({ key: c.key, busy: c.busy, lastActivity: c.lastActivity }));
  }

  busyCount(): number {
    return [...this.conversations.values()].filter((c) => c.busy).length;
  }

  private disposeIdle(): void {
    for (const [key, convo] of this.conversations) {
      if (!convo.busy && Date.now() - convo.lastActivity > Math.max(IDLE_DISPOSE_MS, this.cfg.idleResetMinutes * 60_000 + 60_000)) {
        void this.closeSession(convo.session);
        this.conversations.delete(key);
        this.log.info("conversation closed (idle)", { key });
      }
    }
  }

  /** Wait for running turns (bounded), then dispose everything. */
  /**
   * Dispose a session the way Pi's own runtime does: extensions get session_shutdown first, so MCP servers and
   * other extension resources are closed instead of outliving the conversation.
   */
  private async closeSession(session: AgentSession): Promise<void> {
    try {
      const runner = (session as any).extensionRunner;
      // Bounded: a stuck MCP server must not hang /new or shutdown.
      if (runner?.hasHandlers?.("session_shutdown")) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise((_, no) => { timer = setTimeout(() => no(new Error("extensions took over 5 s to shut down")), 5_000); })]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      this.log.warn("extension shutdown failed", { error: (e as Error).message });
    }
    session.dispose();
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    closeSpares(); // turns finishing below must not pre-start processes nobody will use
    const running = [...this.conversations.values()].filter((c) => c.pending).map((c) => c.pending!);
    if (running.length) {
      this.log.info("waiting for running turns before exit", { count: running.length });
      await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    // All at once: each close is bounded at 5 s, so shutdown stays inside UltraTerm's grace period.
    await Promise.allSettled([...this.conversations.values()].map(async (convo) => {
      if (convo.busy) await Promise.race([convo.session.abort().catch(() => {}), new Promise((r) => setTimeout(r, 3_000).unref())]);
      await this.closeSession(convo.session);
    }));
    this.conversations.clear();
    if (!this.opts.shared) rmSync(this.stateDir, { recursive: true, force: true });
  }

  /** One-off run in a throwaway in-memory session (individuation, titles). No tools unless given. */
  async oneShot(prompt: string, opts: { model?: string; system?: string; tools?: string[] } = {}): Promise<string> {
    const model = this.model(opts.model ?? this.cfg.sideModel ?? this.cfg.model);
    const loader = new DefaultResourceLoader({
      cwd: this.cfg.workspace,
      agentDir: this.piDir,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: opts.system ?? "You are a careful, honest analyst. Follow the requested output format exactly.",
      appendSystemPrompt: [],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.cfg.workspace,
      agentDir: this.piDir,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: "medium",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.cfg.workspace),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } } as any),
      tools: opts.tools ?? [],
    });
    try {
      await session.prompt(prompt, { expandPromptTemplates: false } as any);
      const last = [...session.messages].reverse().find((m: any) => m.role === "assistant") as any;
      if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "model error");
      return last ? assistantText(last) : "";
    } finally {
      await this.closeSession(session);
    }
  }
}

/** Filesystem-safe directory for a conversation key (e.g. "telegram:dm:123"). */
/**
 * Did a tool run after this user message in the conversation's latest transcript? false when none did, or the
 * message never reached the transcript (the turn can be rerun without repeating any action).
 */
export function toolsRanAfter(home: string, key: string, text: string): boolean {
  const dir = sessionDir(home, key);
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  if (!files.length) return false;
  const needle = text.slice(0, 200);
  const messages = readFileSync(join(dir, files[files.length - 1]), "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line).message; } catch { return undefined; } }).filter(Boolean) as any[];
  const contentText = (m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("\n");
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && contentText(messages[i]).includes(needle)) { at = i; break; }
  if (at < 0) return false;
  return messages.slice(at + 1).some((m) => m.role === "toolResult" || (m.role === "assistant" && (m.content ?? []).some?.((c: any) => c.type === "toolCall")));
}

export function sessionDir(home: string, key: string): string {
  return join(home, "sessions", key.replace(/[^A-Za-z0-9_.-]+/g, "_"));
}

/** Most recent session file per conversation, for listing past conversations without opening them. */
export function listSessionFiles(home: string): { key: string; dir: string; file: string; mtime: number }[] {
  const root = join(home, "sessions");
  if (!existsSync(root)) return [];
  const out: { key: string; dir: string; file: string; mtime: number }[] = [];
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    let key = dir;
    let files: string[];
    try {
      if (!statSync(full).isDirectory()) continue;
      const keyFile = join(full, "key");
      if (existsSync(keyFile)) key = readFileSync(keyFile, "utf8").trim();
      files = readdirSync(full);
    } catch {
      continue; // a dangling link or a directory removed while listing
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        out.push({ key, dir, file: join(full, f), mtime: statSync(join(full, f)).mtimeMs });
      } catch {
        // a file removed while listing
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function assistantText(m: any): string {
  return (m.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .trim();
}

export function toolResultText(r: any): string {
  if (!r) return "";
  if (typeof r === "string") return r;
  const content = r.content ?? r.result?.content;
  if (Array.isArray(content)) return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  return JSON.stringify(r).slice(0, 2_000);
}

export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.command ?? a.path ?? a.file_path ?? a.query ?? a.url ?? a.name ?? Object.values(a).find((v) => typeof v === "string");
  const s = typeof pick === "string" ? pick : JSON.stringify(a);
  return s.replace(/\s+/g, " ").slice(0, 120);
}

/** The UltraCompress engine, found the same way its adapter looks: env, UltraTerm, ~/.local, ~/.cargo, PATH. */
export function findUltraCompress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = homedir();
  const candidates = [env.ULTRACOMPRESS_BIN, join(home, ".ultraterm", "bin", "ultracompress"), join(home, ".local", "bin", "ultracompress"), join(home, ".cargo", "bin", "ultracompress"),
    ...(env.PATH ?? "").split(":").map((d) => join(d, "ultracompress"))];
  return candidates.find((c) => c && existsSync(c));
}
