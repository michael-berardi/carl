// Claude as a native Carl model route, through the official Claude Code CLI and the user's own login.
//
// Design (after NousResearch's claude-subscription-directsdk Hermes plugin, MIT):
//   - Every model call starts a fresh `claude -p` with stream-json in and out. Claude Code builds the request
//     itself and authenticates with its own login; Carl never reads, copies or refreshes Claude credentials.
//   - Carl supplies content only through the CLI's documented inputs: a system prompt file, history frames
//     (earlier user frames with shouldQuery:false), an inert MCP inventory naming Carl's tools, and generation
//     fields through CLAUDE_CODE_EXTRA_BODY in a private settings file. Native tools, skills, settings sources,
//     slash commands, auto-compaction and session persistence are off.
//   - ANTHROPIC_BASE_URL points at a request-scoped loopback relay that forwards exactly one Messages request
//     upstream (headers and body as the CLI built them) and refuses the CLI's own retries, so one Carl call is
//     one upstream request. The relay captures the streamed response, which is authoritative.
//   - Carl runs the agent loop, executes tools, compacts and persists; Claude Code is only the model client.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export const PROVIDER = "claude-code";
export const API = "claude-code-cli";
const PREFIX = "mcp__carl__";
const INERT_MCP = fileURLToPath(new URL("./inert-mcp.mjs", import.meta.url));

/** Pinned routes. Carl ids are the plain model names; the CLI gets the explicit long-context form. */
export const CLAUDE_MODELS: { id: string; name: string; native: string; contextWindow: number; maxTokens: number; mandatoryThinking: boolean; adaptive: boolean }[] = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", native: "claude-sonnet-5-5[1m]", contextWindow: 1_000_000, maxTokens: 64_000, mandatoryThinking: true, adaptive: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", native: "claude-opus-5-5[1m]", contextWindow: 1_000_000, maxTokens: 64_000, mandatoryThinking: true, adaptive: true },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", native: "claude-fable-5-1[1m]", contextWindow: 1_000_000, maxTokens: 64_000, mandatoryThinking: true, adaptive: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", native: "claude-sonnet-5[1m]", contextWindow: 1_000_000, maxTokens: 64_000, mandatoryThinking: false, adaptive: true },
  { id: "claude-opus-5", name: "Claude Opus 5", native: "claude-opus-5[1m]", contextWindow: 1_000_000, maxTokens: 64_000, mandatoryThinking: false, adaptive: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", native: "claude-haiku-4-5-20251001", contextWindow: 200_000, maxTokens: 32_000, mandatoryThinking: false, adaptive: false },
];

export interface ClaudeCodeOptions {
  /** claude executable; default: PATH, then the usual install directories. */
  command?: string;
  /** Claude Code config directories (one per login), in preference order; called per request so a host can rebalance.
   *  Another login is tried only when one refuses (401/402/429) before any output. */
  configDirs?: () => string[];
  /** Read-idle timeout per call, ms. */
  idleTimeoutMs?: number;
  /** Stable private working directory (Claude Code writes its cwd into the prompt; a stable one keeps the cache). */
  workdir: string;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
}

export class ClaudeCodeError extends Error {
  override name = "ClaudeCodeError";
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Registration input for ModelRuntime.registerProvider / pi.registerProvider. */
export function claudeCodeProviderConfig(opts: ClaudeCodeOptions) {
  return {
    name: "Claude (Claude Code login)",
    api: API,
    baseUrl: "process://claude-code", // no HTTP endpoint: each call runs the official CLI
    apiKey: "claude-code-login", // keyless: auth belongs to the CLI; this only marks the provider usable
    streamSimple: (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => streamClaude(model, context, options, opts),
    models: CLAUDE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      api: API,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // subscription-included: no per-token spend is implied
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  };
}

// ---- History: Pi transcript -> Claude Code stream-json frames ------------------------------------------------

type Block = Record<string, any>;
interface Frame { type: "user" | "assistant"; message: { role: "user" | "assistant"; content: Block[] } }

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";

function imageBlock(img: { data: string; mimeType: string }): Block {
  return { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } };
}

export function buildFrames(context: TranscriptContext, dropThinking = false): { system: string; frames: Frame[]; tools: { name: string; description: string; inputSchema: any }[] } {
  const system = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages).map((t) => {
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(t.name)) throw new ClaudeCodeError(`tool name "${t.name}" is not a 1-50 character ASCII identifier, which the Claude route requires`);
    return { name: t.name, description: t.description, inputSchema: normalizeSchema(t.parameters) };
  });
  const offered = new Set(tools.map((t) => t.name));
  const frames: Frame[] = [];
  const push = (role: "user" | "assistant", content: Block[]) => {
    if (!content.length) return;
    const last = frames[frames.length - 1];
    if (last && last.type === role && role === "user") last.message.content.push(...content);
    else frames.push({ type: role, message: { role, content } });
  };
  // Tool calls that never got a result (an aborted turn) would make the request invalid: drop them.
  const answered = new Set<string>();
  for (const m of context.messages as any[]) if (m.role === "toolResult") answered.add(safeId(m.toolCallId));
  const called = new Set<string>();
  for (const m of context.messages as any[]) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const content = typeof m.content === "string" ? (m.content ? [{ type: "text", text: m.content }] : []) : m.content.map((c: any) => (c.type === "text" ? { type: "text", text: c.text } : imageBlock(c)));
      push("user", content);
    } else if (m.role === "assistant") {
      const native = m.provider === PROVIDER && !dropThinking; // signed thinking only replays to the family that signed it
      const content: Block[] = [];
      for (const c of m.content ?? []) {
        if (c.type === "thinking" && native && c.thinkingSignature) {
          content.push(c.redacted ? { type: "redacted_thinking", data: c.thinkingSignature } : { type: "thinking", thinking: c.thinking, signature: c.thinkingSignature });
        } else if (c.type === "text" && c.text) {
          content.push({ type: "text", text: c.text });
        } else if (c.type === "toolCall" && answered.has(safeId(c.id))) {
          called.add(safeId(c.id));
          content.push({ type: "tool_use", id: safeId(c.id), name: offered.has(c.name) ? PREFIX + c.name : c.name, input: c.arguments ?? {} });
        }
      }
      // A reply that is only signed thinking cannot end an assistant turn; keep at least visible text.
      if (content.length && content.every((b) => b.type === "thinking" || b.type === "redacted_thinking")) continue;
      push("assistant", content);
    } else if (m.role === "toolResult") {
      if (!called.has(safeId(m.toolCallId))) continue;
      const parts = (m.content ?? []).map((c: any) => (c.type === "text" ? { type: "text", text: c.text } : imageBlock(c)));
      push("user", [{ type: "tool_result", tool_use_id: safeId(m.toolCallId), content: parts.length ? parts : [{ type: "text", text: "(no output)" }], is_error: !!m.isError }]);
    }
  }
  const last = frames[frames.length - 1];
  if (!last || last.type !== "user") throw new ClaudeCodeError("the conversation must end with a user message or tool results (assistant prefill is not supported)");
  return { system, frames, tools };
}

function normalizeSchema(schema: any): any {
  const s = schema && typeof schema === "object" ? JSON.parse(JSON.stringify(schema)) : { type: "object" };
  for (const k of ["oneOf", "allOf", "anyOf"]) delete s[k];
  if (!s.type) s.type = "object";
  if (s.type === "object" && (typeof s.properties !== "object" || s.properties === null)) s.properties = {};
  return s;
}

// ---- The admission relay -------------------------------------------------------------------------------------

/** Rebuilds the Messages API response from its SSE stream. */
export class Capture {
  message: any = null;
  complete = false;
  private pending = "";
  private args = new Map<number, string>();

  feed(chunk: string): void {
    this.pending += chunk;
    let m: RegExpExecArray | null;
    while ((m = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, m.index);
      this.pending = this.pending.slice(m.index + m[0].length);
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) this.event(JSON.parse(data));
    }
  }

  event(e: any): void {
    switch (e.type) {
      case "message_start":
        this.message = structuredClone(e.message);
        break;
      case "content_block_start":
        this.message.content.push(structuredClone(e.content_block));
        break;
      case "content_block_delta": {
        const block = this.message.content[e.index];
        const d = e.delta;
        if (d.type === "text_delta") block.text = (block.text ?? "") + d.text;
        else if (d.type === "thinking_delta") block.thinking = (block.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") block.signature = (block.signature ?? "") + d.signature;
        else if (d.type === "input_json_delta") this.args.set(e.index, (this.args.get(e.index) ?? "") + d.partial_json);
        break;
      }
      case "content_block_stop":
        if (this.args.has(e.index)) {
          const raw = this.args.get(e.index)!;
          this.args.delete(e.index);
          this.message.content[e.index].input = raw.trim() ? JSON.parse(raw) : {};
        }
        break;
      case "message_delta":
        Object.assign(this.message, e.delta ?? {});
        Object.assign(this.message.usage, e.usage ?? {});
        break;
      case "message_stop":
        this.complete = !!(this.message?.stop_reason && this.args.size === 0);
        break;
    }
  }
}

export class Admission {
  readonly prefix = "/admit/" + randomBytes(24).toString("base64url");
  readonly capture = new Capture();
  used = false;
  denied = 0;
  status?: number;
  requestId?: string;
  failure?: string;
  errorBody = "";
  private server!: Server;
  private sockets = new Set<any>();
  url = "";
  private readonly upstream: URL;
  private readonly idleMs: number;

  constructor(upstream = "https://api.anthropic.com", idleMs = 180_000) {
    this.upstream = new URL(upstream);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(this.upstream.hostname);
    if (this.upstream.protocol !== "https:" && !(this.upstream.protocol === "http:" && loopback)) throw new ClaudeCodeError("the Claude upstream must be HTTPS (or a loopback HTTP test fixture)");
    this.idleMs = idleMs;
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => {
      this.url = `http://127.0.0.1:${(this.server.address() as any).port}${this.prefix}`;
      resolve();
    }));
  }

  errorText(): string {
    try {
      return JSON.parse(this.errorBody).error.message ?? this.errorBody;
    } catch {
      return this.errorBody;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== this.prefix + "/v1/messages" || req.headers.origin) {
      res.writeHead(404).end();
      return;
    }
    if (this.used) {
      this.denied++;
      const body = '{"type":"error","error":{"type":"invalid_request_error","message":"CARL_MODEL_ADMISSION_CONSUMED"}}';
      res.writeHead(400, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
      return;
    }
    this.used = true;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const payload = Buffer.concat(chunks);
    const headers: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "proxy-connection", "accept-encoding"].includes(k)) headers[k] = v;
    }
    headers["accept-encoding"] = "identity";
    headers["content-length"] = payload.length;
    await new Promise<void>((resolve) => {
      const send = this.upstream.protocol === "http:" ? httpRequest : httpsRequest;
      const up = send(
        { host: this.upstream.hostname.replace(/^\[|\]$/g, ""), port: this.upstream.port || (this.upstream.protocol === "http:" ? 80 : 443), method: "POST", path: this.upstream.pathname.replace(/\/$/, "") + "/v1/messages" + url.search, headers },
        (upRes) => {
          this.status = upRes.statusCode;
          this.requestId = (upRes.headers["request-id"] ?? upRes.headers["x-request-id"]) as string | undefined;
          const out: Record<string, any> = {};
          for (const [k, v] of Object.entries(upRes.headers)) if (!["connection", "transfer-encoding", "server", "date"].includes(k)) out[k] = v;
          out.connection = "close";
          res.writeHead(upRes.statusCode ?? 502, out);
          upRes.setEncoding("utf8");
          upRes.setTimeout(this.idleMs, () => {
            this.failure = `no upstream bytes for ${this.idleMs / 1000}s`;
            upRes.destroy();
          });
          upRes.on("data", (chunk: string) => {
            try {
              if (upRes.statusCode === 200) this.capture.feed(chunk);
              else if (this.errorBody.length < 65_536) this.errorBody += chunk;
            } catch (e) {
              this.failure = `bad upstream stream: ${(e as Error).message}`;
            }
            res.write(chunk);
          });
          upRes.on("end", () => { res.end(); resolve(); });
          upRes.on("error", (e) => { this.failure ??= e.message; res.destroy(); resolve(); });
        },
      );
      up.on("error", (e) => {
        this.failure = e.message;
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } }));
        else res.destroy();
        resolve();
      });
      up.end(payload);
    });
  }

  close(): void {
    for (const s of this.sockets) s.destroy();
    this.server?.close();
  }
}

// ---- One model call ------------------------------------------------------------------------------------------

const NATIVE_STATUS: Record<string, number> = { rate_limit: 429, billing_error: 402, authentication_failed: 401, overloaded: 529, server_error: 503 };

export function resolveClaude(command: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const head = command ?? env.CARL_CLAUDE_COMMAND ?? "claude";
  if (head.includes("/")) return existsSync(head) ? head : undefined;
  const home = env.HOME ?? homedir();
  const dirs = [...(env.PATH ?? "").split(delimiter), ...[".local/bin", ".claude/local", "bin", ".npm-global/bin", ".bun/bin", ".volta/bin"].map((p) => join(home, p)), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) if (d && existsSync(join(d, head))) return join(d, head);
  return undefined;
}

function effortFor(level: string | undefined): string | undefined {
  if (!level || level === "off") return undefined;
  return ({ minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } as Record<string, string>)[level] ?? "medium";
}

export function streamClaude(model: Model<any>, context: TranscriptContext, options: SimpleStreamOptions | undefined, opts: ClaudeCodeOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const route = CLAUDE_MODELS.find((m) => m.id === model.id);
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: API,
    provider: PROVIDER,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending" as any,
    timestamp: Date.now(),
  };
  const fail = (reason: "error" | "aborted", message: string) => {
    const err = { ...partial, stopReason: reason, errorMessage: message, timestamp: Date.now() } as AssistantMessage;
    stream.push({ type: "error", reason, error: err });
    stream.end(err);
  };
  queueMicrotask(async () => {
    const configured = opts.configDirs?.() ?? [];
    const dirs: (string | undefined)[] = configured.length ? configured : [undefined];
    let lastError: ClaudeCodeError | undefined;
    for (let i = 0; i < dirs.length; i++) {
      try {
        try {
          await attempt(model, route, context, options, opts, dirs[i], partial, stream, false);
        } catch (e) {
          // Thinking signatures are bound to the login that produced them; after a switch, replay without them.
          if (!(e instanceof ClaudeCodeError && e.status === 400 && /signature/i.test(e.message)) || partial.content.length) throw e;
          opts.log?.("warn", "claude rejected replayed thinking signatures; retrying without them", { configDir: dirs[i] ?? "default" });
          await attempt(model, route, context, options, opts, dirs[i], partial, stream, true);
        }
        return;
      } catch (e) {
        const err = e instanceof ClaudeCodeError ? e : new ClaudeCodeError((e as Error).message);
        lastError = err;
        if (options?.signal?.aborted) return fail("aborted", "Request was aborted");
        // Only an account-level refusal before any output may move to the next login.
        const accountRefusal = err.status === 401 || err.status === 402 || err.status === 429;
        if (!accountRefusal || partial.content.length || i === dirs.length - 1) break;
        opts.log?.("warn", "claude login refused before output; trying the next one", { status: err.status, configDir: dirs[i] ?? "default" });
      }
    }
    fail("error", lastError?.message ?? "Claude call failed");
  });
  return stream;
}

async function attempt(
  model: Model<any>,
  route: (typeof CLAUDE_MODELS)[number] | undefined,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  opts: ClaudeCodeOptions,
  configDir: string | undefined,
  partial: AssistantMessage,
  stream: AssistantMessageEventStream,
  dropThinking: boolean,
): Promise<void> {
  const signal = options?.signal;
  const { system, frames, tools } = buildFrames(context, dropThinking);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The Claude route is the subscription login. API keys or other backends in the environment would silently
  // turn it into paid API use; they are removed for the child, and the removal is logged by name.
  const removed = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_EFFORT_LEVEL"].filter((k) => env[k]);
  for (const k of removed) delete env[k];
  if (removed.some((k) => !k.startsWith("CLAUDE_CODE_E"))) opts.log?.("warn", "claude route ignores API-key/backend overrides from the environment", { removed });
  // Claude Code's auto-updater replaces the binary in place; during the swap it briefly does not exist.
  let bin = resolveClaude(opts.command, env);
  for (let waited = 0; !bin && waited < 15_000 && !signal?.aborted; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    bin = resolveClaude(opts.command, env);
  }
  if (!bin) throw new ClaudeCodeError("Claude Code is not installed (no `claude` on PATH). Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude auth login`.", 503);
  // The default login (~/.claude) lives in the keychain under a name that changes when CLAUDE_CONFIG_DIR is set,
  // so the default account is selected by unsetting it, never by naming ~/.claude.
  const defaultDir = join(env.HOME ?? homedir(), ".claude");
  if (configDir && configDir.replace(/\/+$/, "") !== defaultDir) env.CLAUDE_CONFIG_DIR = configDir;
  else if (configDir) delete env.CLAUDE_CONFIG_DIR;
  Object.assign(env, {
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1",
    DISABLE_COMPACT: "1",
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
  });

  const body: Record<string, any> = {
    tools: tools.map((t) => ({ name: PREFIX + t.name, description: t.description, input_schema: t.inputSchema })),
  };
  const effort = effortFor(options?.reasoning);
  if (!effort) {
    if (route && !route.mandatoryThinking) {
      body.thinking = { type: "disabled" };
      body.context_management = { edits: [] };
    }
  } else {
    if (!route || route.adaptive) body.thinking = { type: "adaptive" };
    body.output_config = { effort };
  }
  if (options?.maxTokens) body.max_tokens = options.maxTokens;

  mkdirSync(opts.workdir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(tmpdir(), "carl-claude-"));
  // CARL_CLAUDE_UPSTREAM exists for loopback test fixtures only (the Admission constructor refuses anything else but HTTPS).
  const admission = new Admission(process.env.CARL_CLAUDE_UPSTREAM ?? "https://api.anthropic.com", opts.idleTimeoutMs ?? 180_000);
  let child: ChildProcess | undefined;
  const kill = () => {
    if (child?.pid && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
  };
  const onAbort = () => { kill(); admission.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    writeFileSync(join(tmp, "tools.json"), JSON.stringify(tools), { mode: 0o600 });
    writeFileSync(join(tmp, "system.md"), system, { mode: 0o600 });
    writeFileSync(join(tmp, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(body) } }), { mode: 0o600 });
    if (body.max_tokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(body.max_tokens);
    await admission.start();
    env.ANTHROPIC_BASE_URL = admission.url;
    const mcp = { mcpServers: { carl: { command: process.execPath, args: [INERT_MCP, join(tmp, "tools.json")] } } };
    const args = [
      "-p", "--model", route?.native ?? model.id,
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--tools", "", "--system-prompt-file", join(tmp, "system.md"), "--settings", join(tmp, "settings.json"),
      "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--max-turns", "1",
      "--permission-mode", "dontAsk", "--no-session-persistence", "--mcp-config", JSON.stringify(mcp),
      ...(effort ? ["--effort", effort] : []),
    ];
    if (signal?.aborted) throw new ClaudeCodeError("aborted");
    child = spawn(bin, args, { cwd: opts.workdir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stderr = "";
    child.stderr!.on("data", (b) => { if (stderr.length < 8_000) stderr += b; });
    const exited = new Promise<number | null>((resolve) => child!.on("close", (code) => resolve(code)));
    const spawnError = new Promise<never>((_, reject) => child!.on("error", (e) => reject(new ClaudeCodeError(`could not start claude: ${e.message}`, 503))));
    spawnError.catch(() => {});

    const lines = createInterface({ input: child.stdout! });
    const queue: any[] = [];
    let waiter: (() => void) | undefined;
    let ended = false;
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        queue.push(JSON.parse(line));
      } catch {
        queue.push({ type: "__invalid", line: line.slice(0, 300) });
      }
      waiter?.();
    });
    lines.on("close", () => { ended = true; waiter?.(); });
    const idle = opts.idleTimeoutMs ?? 180_000;
    const next = async (): Promise<any | null> => {
      const deadline = Date.now() + idle;
      while (!queue.length) {
        if (ended) return null;
        if (signal?.aborted) throw new ClaudeCodeError("aborted");
        if (Date.now() > deadline) throw new ClaudeCodeError(`Claude Code sent nothing for ${idle / 1000}s`);
        await Promise.race([new Promise<void>((r) => { waiter = r; setTimeout(r, 250); }), spawnError]);
      }
      const e = queue.shift();
      if (e.type === "__invalid") throw new ClaudeCodeError(`Claude Code printed non-JSON output: ${JSON.stringify(e.line)}`);
      return e;
    };

    // Replay history: every user frame but the last is recorded without a model call (a zero-turn result).
    for (let i = 0; i < frames.length; i++) {
      const frame: any = structuredClone(frames[i]);
      const replay = frame.type === "user" && i < frames.length - 1;
      if (replay) frame.shouldQuery = false;
      child.stdin!.write(JSON.stringify(frame) + "\n");
      if (replay) {
        for (;;) {
          const ack = await next();
          if (!ack) throw new ClaudeCodeError(`Claude Code exited during history replay${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`);
          if (ack.type === "result") {
            if (ack.num_turns !== 0 || ack.is_error) throw new ClaudeCodeError("Claude Code did not accept the history replay (expected a zero-turn acknowledgment)");
            break;
          }
        }
      }
    }
    child.stdin!.end();

    // Stream the answer.
    let started = false;
    const indexMap = new Map<number, number>(); // native block index -> Pi content index
    const toolArgs = new Map<number, string>();
    let nativeError: { code?: string; text: string } | undefined;
    let result: any;
    for (;;) {
      const e = await next();
      if (!e) break;
      if (e.type === "result") { result = e; continue; }
      if (e.type === "assistant" && (e.error || e.message?.error)) {
        const text = (e.message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        nativeError = { code: e.error ?? e.message?.error, text: text || String(e.error ?? e.message?.error) };
        continue;
      }
      if (e.type !== "stream_event") continue;
      const ev = e.event;
      await options?.onProviderStreamEvent?.(ev, model);
      if (!started && ev.type === "message_start") {
        started = true;
        stream.push({ type: "start", partial: { ...partial } });
      }
      if (!started) continue;
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        const idx = partial.content.length;
        indexMap.set(ev.index, idx);
        if (b.type === "text") {
          partial.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: idx, partial: { ...partial } });
        } else if (b.type === "thinking" || b.type === "redacted_thinking") {
          partial.content.push({ type: "thinking", thinking: "", ...(b.type === "redacted_thinking" ? { redacted: true, thinkingSignature: b.data } : {}) });
          stream.push({ type: "thinking_start", contentIndex: idx, partial: { ...partial } });
        } else if (b.type === "tool_use") {
          partial.content.push({ type: "toolCall", id: b.id, name: String(b.name).replace(PREFIX, ""), arguments: {} });
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: { ...partial } });
        } else {
          indexMap.delete(ev.index);
        }
      } else if (ev.type === "content_block_delta") {
        const idx = indexMap.get(ev.index);
        if (idx === undefined) continue;
        const block: any = partial.content[idx];
        const d = ev.delta;
        if (d.type === "text_delta") {
          block.text += d.text;
          stream.push({ type: "text_delta", contentIndex: idx, delta: d.text, partial: { ...partial } });
        } else if (d.type === "thinking_delta") {
          block.thinking += d.thinking;
          stream.push({ type: "thinking_delta", contentIndex: idx, delta: d.thinking, partial: { ...partial } });
        } else if (d.type === "signature_delta") {
          block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
        } else if (d.type === "input_json_delta") {
          toolArgs.set(ev.index, (toolArgs.get(ev.index) ?? "") + d.partial_json);
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: d.partial_json, partial: { ...partial } });
        }
      } else if (ev.type === "content_block_stop") {
        const idx = indexMap.get(ev.index);
        if (idx === undefined) continue;
        const block: any = partial.content[idx];
        if (block.type === "text") stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: { ...partial } });
        else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: { ...partial } });
        else if (block.type === "toolCall") {
          const raw = toolArgs.get(ev.index) ?? "";
          block.arguments = raw.trim() ? JSON.parse(raw) : {};
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: { ...partial } });
        }
      }
    }
    const code = await exited;
    if (signal?.aborted) throw new ClaudeCodeError("aborted");

    if (admission.used && (admission.status !== 200 || !admission.capture.complete)) {
      const why = admission.errorText() || admission.failure || (admission.capture.complete ? "" : "the response stream ended early");
      const status = admission.status && admission.status >= 400 ? admission.status : nativeError?.code ? NATIVE_STATUS[nativeError.code] : undefined;
      throw new ClaudeCodeError(`Claude upstream error${admission.status ? ` (HTTP ${admission.status})` : ""}: ${why}`.trim(), status);
    }
    if (!admission.used) {
      if (nativeError?.code === "authentication_failed") throw new ClaudeCodeError(`Claude Code is not logged in${configDir ? ` for ${configDir}` : ""}: run \`claude auth login\` (${nativeError.text})`, 401);
      if (nativeError) throw new ClaudeCodeError(`Claude Code error: ${nativeError.text}`, nativeError.code ? NATIVE_STATUS[nativeError.code] : undefined);
      throw new ClaudeCodeError(`Claude Code made no model request (exit ${code})${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`);
    }

    // The relay's capture of the one upstream response is authoritative.
    const msg = admission.capture.message;
    const content: AssistantMessage["content"] = [];
    for (const b of msg.content ?? []) {
      if (b.type === "text") content.push({ type: "text", text: b.text ?? "" });
      else if (b.type === "thinking") content.push({ type: "thinking", thinking: b.thinking ?? "", thinkingSignature: b.signature });
      else if (b.type === "redacted_thinking") content.push({ type: "thinking", thinking: "", redacted: true, thinkingSignature: b.data });
      else if (b.type === "tool_use") content.push({ type: "toolCall", id: b.id, name: String(b.name).replace(PREFIX, ""), arguments: b.input ?? {} });
    }
    const u = msg.usage ?? {};
    const usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const stop = msg.stop_reason;
    const final: AssistantMessage = {
      ...partial,
      content,
      usage,
      responseId: msg.id,
      stopReason: stop === "tool_use" ? "toolUse" : stop === "max_tokens" || stop === "model_context_window_exceeded" ? "length" : "stop",
      timestamp: Date.now(),
    } as AssistantMessage;
    if (stop === "refusal") {
      const reason = msg.stop_details?.explanation || msg.stop_details?.category || "no reason given";
      final.content = content.filter((c) => c.type !== "toolCall");
      final.stopReason = "error";
      final.errorMessage = `Claude declined: ${reason}`;
      stream.push({ type: "error", reason: "error", error: final });
      stream.end(final);
      return;
    }
    if (!started) stream.push({ type: "start", partial: { ...partial } });
    void result;
    stream.push({ type: "done", reason: final.stopReason as "stop" | "length" | "toolUse", message: final });
    stream.end(final);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    kill();
    admission.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
