// The brain: one Pi AgentSession per conversation, created lazily, persisted as Pi JSONL, disposed when idle.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import type { CarlConfig } from "./config.ts";
import type { Log } from "./log.ts";
import { resultBudget } from "./budget.ts";
import { installProfile, sandboxSpawnHook, secretFiles, writablePaths } from "./sandbox.ts";
import { claudeCodeProviderConfig, PROVIDER as CLAUDE_PROVIDER } from "./providers/claude-code.ts";
import { createRouter } from "./router.ts";
import { type Approver, shellGuard } from "./guard.ts";
import { looksLikeCorrection, type Psyche } from "./psyche.ts";

export interface Inbound {
  text: string;
  images?: ImageContent[];
  /** Who sent it, for the transcript and the API mirror. */
  source: "telegram" | "api" | "schedule" | "cli";
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
  lastActivity: number;
  source: Inbound["source"];
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
  /** The model sessions select: the router when fallbacks are configured, else the primary. */
  sessionModelRef(): string {
    return this.cfg.fallbackModels.length ? "carl/auto" : this.cfg.model;
  }
  /** Asks the operator to approve a dangerous shell command for a conversation. Default: unattended (refuse). */
  approver: (key: string) => Approver = () => async () => "unattended";

  readonly cfg: CarlConfig;
  readonly psyche: Psyche;
  readonly log: Log;
  private readonly tools: () => ToolDefinition[];
  constructor(cfg: CarlConfig, psyche: Psyche, log: Log, tools: () => ToolDefinition[]) {
    super();
    this.cfg = cfg;
    this.psyche = psyche;
    this.log = log;
    this.tools = tools;
    this.piDir = join(cfg.home, "pi");
  }

  private fileTools(): ToolDefinition[] {
    const cwd = this.cfg.workspace;
    const make: Record<string, () => ToolDefinition> = {
      read: () => createReadToolDefinition(cwd) as ToolDefinition,
      bash: () => createBashToolDefinition(cwd, { spawnHook: sandboxSpawnHook(this.cfg, this.sandboxProfile) }) as ToolDefinition,
      edit: () => createEditToolDefinition(cwd) as ToolDefinition,
      write: () => createWriteToolDefinition(cwd) as ToolDefinition,
    };
    for (const t of this.cfg.tools) if (!make[t]) throw new Error(`tools: "${t}" is not one of read, bash, edit, write`);
    return this.cfg.tools.map((t) => make[t]());
  }

  /** Seatbelt profile for shell commands (macOS); undefined where the kernel sandbox is unavailable. */
  private sandboxProfile?: string;

  /** The vendored UltraCompress adapter, when its engine binary is installed (resolved once at init). */
  private ultracompressExt?: string;

  /** Pi's own validated mcp.json reader (not a public export; pinned SDK version). */
  private mcpLoader?: (o: { agentDir: string; cwd: string; projectTrusted: boolean }) => any;

  async init(): Promise<void> {
    mkdirSync(this.piDir, { recursive: true, mode: 0o700 });
    // Run from the workspace: tools and extensions that write relative to the process (UltraCompress snapshots,
    // MCP servers) then stay inside it instead of wherever Carl was launched.
    mkdirSync(this.cfg.workspace, { recursive: true, mode: 0o700 });
    process.chdir(this.cfg.workspace);
    const extraProtected = this.cfg.ultraterm ? [join(this.cfg.ultraterm.home, "gateway_state.json"), join(this.cfg.ultraterm.home, "state.db"), join(this.cfg.ultraterm.home, "state.db-wal"), join(this.cfg.ultraterm.home, ".env")] : [];
    this.sandboxProfile = installProfile(this.cfg, extraProtected);
    if (this.sandboxProfile) this.log.info("shell sandbox: Seatbelt", { profile: this.sandboxProfile });
    else this.log.warn("shell sandbox unavailable on this platform: the pattern guard and secret scrubbing still apply, but Carl's own files are not kernel-protected");
    if (this.cfg.ultracompress !== "off") {
      const bin = findUltraCompress();
      const ext = fileURLToPath(new URL("../vendor/ultracompress/index.ts", import.meta.url));
      if (bin && existsSync(ext)) {
        this.ultracompressExt = ext;
        this.log.info("compaction: UltraCompress", { bin });
      } else {
        this.log.info("compaction: Pi built-in summary (no ultracompress binary found)");
      }
    }
    if (this.cfg.mcp && existsSync(join(this.piDir, "mcp.json"))) {
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
      authPath: join(this.cfg.piAgentDir, "auth.json"),
      modelsPath: join(this.cfg.piAgentDir, "models.json"),
    });
    if (this.cfg.claude.enabled) {
      this.runtime.registerProvider(CLAUDE_PROVIDER, claudeCodeProviderConfig({
        command: this.cfg.claude.command,
        configDirs: () => this.claudeAccounts(),
        log: (level, msg, data) => this.log[level](msg, data),
      }) as any);
    }
    this.model(this.cfg.model); // fail fast, naming the model, when it is unknown
    for (const f of this.cfg.fallbackModels) this.model(f);
    if (this.cfg.fallbackModels.length) {
      const router = createRouter({
        primary: () => this.cfg.model, // read per request: a model switch (portal, UltraTerm picker) takes effect at once
        fallbacks: () => this.cfg.fallbackModels,
        resolve: (ref) => this.model(ref),
        events: {
          onFallback: (from, to, reason, until) => {
            this.log.warn("primary model out of quota; using fallback", { from, to, until: new Date(until).toISOString(), reason });
            this.emit("fallback", { from, to, reason, until });
          },
        },
      });
      this.routerState = router.exhaustedUntil;
      const primary = this.model(this.cfg.model);
      this.runtime.registerVirtualModel({
        provider: "carl",
        id: "auto",
        name: `${primary.name} (falls back to ${this.cfg.fallbackModels.join(", ")})`,
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
- Record operator decisions with decision_log when they make one that matters; record your own failures with shadow_note.
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
      out.push({ path, content: readFileSync(path, "utf8") });
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
      convo.session.dispose();
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
        {
          ...this.cfg.guard,
          // Carl's own control plane (everything in CARL_HOME but the working areas) and its secrets.
          protectedPaths: [this.cfg.home],
          writablePaths: writablePaths(this.cfg),
          secretPaths: secretFiles(this.cfg),
          cwd: this.cfg.workspace,
        }),
      resultBudget(join(this.cfg.home, "spill"), this.cfg.toolResultMaxChars),
    ];
    if (this.cfg.mcp && existsSync(join(this.piDir, "mcp.json")) && this.mcpLoader) {
      // MCP servers reach the model through codemode: one tool, scripts call servers in parallel and
      // filter large results before they enter the context.
      extensionFactories.push(
        createCodemodeExtension({ mode: "on" }) as InlineExtension,
        createToolSearchExtension() as InlineExtension,
        createMcpExtension({
          logPath: join(this.cfg.home, "logs", "mcp.log"),
          // Pi's default loader reads the global ~/.pi/agent/mcp.json; Carl's servers live in CARL_HOME/pi.
          loadConfig: (ctx: any) => this.mcpLoader!({ agentDir: this.piDir, cwd: ctx.cwd, projectTrusted: false }),
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
    const convo: Conversation = { key, session, busy: false, lastActivity: Date.now(), source };
    this.observe(convo);
    this.log.info("conversation opened", { key, sessionId: session.sessionId, fresh, messages: session.messages.length });
    return convo;
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
    while (convo.busy && input.source !== "telegram" && convo.pending) await convo.pending.catch(() => {});
    this.emitTranscript(convo, { role: "user", text: input.text, source: input.source });
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
    try {
      await convo.session.prompt(text, { images, source: "rpc" } as any);
    } catch (e) {
      thrown = e as Error;
    } finally {
      unsubscribe();
    }
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
    if (convo) {
      if (convo.busy) await convo.session.abort().catch(() => {});
      convo.session.dispose();
      this.conversations.delete(key);
    }
    const pending = this.createConversation(key, convo?.source ?? "cli", true).finally(() => this.creating.delete(key));
    this.creating.set(key, pending);
    this.conversations.set(key, await pending);
  }

  async compact(key: string): Promise<string> {
    const convo = await this.get(key, "cli");
    if (convo.busy) return "Busy; try again when the current run finishes.";
    const before = convo.session.getContextUsage()?.tokens;
    convo.busy = true;
    const job = convo.session.compact().then(() => undefined, (e: Error) => e);
    // Other callers wait on `pending` exactly as they would for a run.
    convo.pending = job.then(() => ({ text: "", ok: true, aborted: false, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, model: this.modelRef(convo), ms: 0 }));
    const failure = await job;
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
        convo.session.dispose();
        this.conversations.delete(key);
        this.log.info("conversation closed (idle)", { key });
      }
    }
  }

  /** Wait for running turns (bounded), then dispose everything. */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    const running = [...this.conversations.values()].filter((c) => c.pending).map((c) => c.pending!);
    if (running.length) {
      this.log.info("waiting for running turns before exit", { count: running.length });
      await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    for (const convo of this.conversations.values()) {
      if (convo.busy) await convo.session.abort().catch(() => {});
      convo.session.dispose();
    }
    this.conversations.clear();
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
      await session.prompt(prompt);
      const last = [...session.messages].reverse().find((m: any) => m.role === "assistant") as any;
      if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "model error");
      return last ? assistantText(last) : "";
    } finally {
      session.dispose();
    }
  }
}

/** Filesystem-safe directory for a conversation key (e.g. "telegram:dm:123"). */
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
export function findUltraCompress(): string | undefined {
  const home = homedir();
  const candidates = [process.env.ULTRACOMPRESS_BIN, join(home, ".ultraterm", "bin", "ultracompress"), join(home, ".local", "bin", "ultracompress"), join(home, ".cargo", "bin", "ultracompress"),
    ...(process.env.PATH ?? "").split(":").map((d) => join(d, "ultracompress"))];
  return candidates.find((c) => c && existsSync(c));
}
