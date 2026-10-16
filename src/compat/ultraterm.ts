// UltraTerm compatibility: lets UltraTerm supervise Carl exactly where it supervised the Hermes-based UltraBot.
//
// UltraTerm (custom mode) reads a fixed home (~/.hermes): gateway_state.json for liveness, state.db for the
// conversation pane and usage, and a loopback API for the composer, sessions, schedules and model picker.
// This plugin writes those files and serves those routes from Carl's own state. Nothing here changes how
// Carl itself works; remove the plugin and Carl runs standalone.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TranscriptEvent } from "../brain.ts";
import type { Gateway, GatewayPlugin } from "../gateway.ts";
import { json } from "../server.ts";
import { VERSION } from "../version.ts";

const INTAKE_CONTRACT = "hermes.canonical-intake.v1";
const MODEL_CONTRACT = "hermes.canonical-model-selection.v1";
/**
 * UltraTerm's picker only offers fixed routes (PICKER_ROUTES in ultrabot_chat.rs). Carl maps its own model ids
 * onto them, so the picker works unchanged: [UltraTerm provider, UltraTerm model, Carl model].
 */
const PICKER_MAP: [string, string, string][] = [
  ["claude-subscription-directsdk-experimental", "claude-sonnet-5-5[1m]", "claude-code/claude-sonnet-5-5"],
  ["openai-codex", "gpt-6.1-sol", "openai-codex/gpt-6.1-sol"],
];
const toPicker = (ref: string) => PICKER_MAP.find((r) => r[2] === ref);
const fromPicker = (provider: string, model: string) => PICKER_MAP.find((r) => r[0] === provider && (r[1] === model || (model === "sonnet" && r[1].startsWith("claude-sonnet"))));

export interface UltraTermCompatOptions {
  /** HERMES_HOME UltraTerm reads (custom mode: ~/.hermes). */
  home: string;
  /** ut-overseer binary for Telegram decision buttons. */
  overseerBin: string;
}

interface SessionRow { id: string; key: string; source: string }

export class UltraTermCompat implements GatewayPlugin {
  readonly name = "ultraterm";
  private db!: DatabaseSync;
  private gw!: Gateway;
  private readonly sessions = new Map<string, SessionRow>(); // Pi session id -> compat row
  private readonly startTime = Math.round((Date.now() - process.uptime() * 1000) / 10); // centiseconds since epoch
  private intake!: DatabaseSync;

  private readonly opts: UltraTermCompatOptions;
  private accountCache?: { at: number; order: string[] };
  private preferred?: string;

  /**
   * Claude logins in the order UltraTerm's account router recommends: eligible, signed in, not cooling down,
   * least used first, with hysteresis so a conversation keeps its prompt cache unless the gap grows large.
   * Read-only (`ut-provider-accounts status`); cached for a minute; on any failure the configured order stands.
   */
  private claudeAccountOrder(fallback: string[]): string[] {
    if (this.accountCache && Date.now() - this.accountCache.at < 60_000) return this.accountCache.order;
    let order = fallback;
    try {
      const bin = join(this.opts.overseerBin, "..", "ut-provider-accounts");
      const out = execText(bin, ["status"]);
      const accounts = (JSON.parse(out).providers?.claude?.accounts ?? []) as any[];
      const usable = accounts.filter((a) => a.configured && a.eligible && !a.signedOut && !a.cooldown && typeof a.configDir === "string");
      if (usable.length) {
        usable.sort((a, b) => (a.usedPercent ?? 100) - (b.usedPercent ?? 100));
        let first = usable[0];
        const current = usable.find((a) => a.configDir === this.preferred);
        if (current && (current.usedPercent ?? 100) - (first.usedPercent ?? 100) < 25) first = current;
        this.preferred = first.configDir;
        order = [first.configDir, ...usable.filter((a) => a !== first).map((a) => a.configDir)];
      }
    } catch (e) {
      this.gw?.log.warn("claude account order unavailable; using configured order", { error: (e as Error).message.slice(0, 200) });
    }
    this.accountCache = { at: Date.now(), order };
    return order;
  }

  constructor(opts: UltraTermCompatOptions) {
    this.opts = opts;
  }

  start(gw: Gateway): void {
    this.gw = gw;
    mkdirSync(this.opts.home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.opts.home, "state.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    ensureSchema(this.db);
    // Transcripts and tool output live here: owner-only.
    for (const f of ["state.db", "state.db-wal", "state.db-shm"]) {
      try { chmodSync(join(this.opts.home, f), 0o600); } catch {}
    }
    this.intake = new DatabaseSync(join(gw.cfg.home, "state", "intake.db"));
    this.intake.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS intake (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, created_at REAL NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS model_selection (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, receipt TEXT);`);

    this.resumeIntake();
    gw.emitStatus = (s) => this.writeGatewayState(s);
    const configured = gw.cfg.claude.configDirs;
    gw.brain.claudeAccounts = () => this.claudeAccountOrder(configured);
    gw.brain.on("transcript", (e: TranscriptEvent) => {
      try {
        this.mirror(e);
      } catch (err) {
        gw.log.error("state.db mirror failed", { error: (err as Error).message });
      }
    });
    if (gw.telegram) gw.telegram.callbacks.set("utd", (q, data) => this.decision(q, data));
    if (gw.api) this.routes();
    gw.log.info("ultraterm compatibility on", { home: this.opts.home });
  }

  stop(): void {
    if (!this.gw) return; // never started
    this.writeGatewayState({ ...this.gw.health(), state: "stopped" });
    try { this.db?.close(); } catch {}
    try { this.intake?.close(); } catch {}
  }

  // ---- gateway_state.json -------------------------------------------------------------------------------------

  private writeGatewayState(s: Record<string, any>): void {
    const now = new Date().toISOString().replace("Z", "+00:00");
    const tg = s.telegram ?? {};
    const api = s.api ?? {};
    const stopped = s.state === "stopped";
    const platform = (p: any) => ({
      state: p.state === "connected" ? "connected" : p.state === "fatal" ? "fatal" : p.state === "off" ? "disabled" : p.state === "stopped" ? "disconnected" : "retrying",
      error_code: p.state === "connected" ? null : p.error ? "carl_error" : null,
      error_message: p.error ?? null,
      updated_at: p.updatedAt ?? now,
      needs_attention: p.state === "fatal",
      retrying_since: p.state === "retrying" ? p.updatedAt ?? now : null,
    });
    const body = {
      pid: stopped ? null : process.pid,
      kind: "carl-gateway",
      argv: process.argv,
      start_time: this.startTime,
      hermes_home: this.opts.home,
      gateway_state: stopped ? "stopped" : "running",
      exit_reason: stopped ? s.reason ?? "stopped" : null,
      restart_requested: false,
      active_agents: s.activeRuns ?? 0,
      platforms: {
        telegram: platform(tg),
        api_server: { ...platform(api), listener_base: `http://127.0.0.1:${this.gw.cfg.api.port}` },
      },
      updated_at: now,
      code_version: `carl ${VERSION}`,
      code_sha: VERSION,
    };
    const file = join(this.opts.home, "gateway_state.json");
    const tmp = `${file}.carl-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, file);
  }

  // ---- state.db mirror ----------------------------------------------------------------------------------------

  private sessionFor(e: Pick<TranscriptEvent, "sessionId" | "conversation" | "source">): SessionRow {
    let row = this.sessions.get(e.sessionId);
    if (row) return row;
    const source = e.source === "telegram" ? "telegram" : e.source === "schedule" ? "cron" : e.source === "api" ? "api_server" : "cli";
    const telegram = e.conversation.match(/^telegram:(dm|group):(-?\d+)/);
    row = {
      id: `carl_${e.sessionId}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128),
      key: telegram ? `agent:main:telegram:${telegram[1]}:${telegram[2]}` : `carl:${e.conversation}`,
      // The conversation's channel decides the pane: a composer message into the Telegram thread stays Telegram.
      source: telegram ? "telegram" : source,
    };
    const cols = columns(this.db, "sessions");
    const values: Record<string, unknown> = { id: row.id, source: row.source, started_at: Date.now() / 1000 };
    if (cols.has("session_key")) values.session_key = row.key;
    if (cols.has("chat_id") && telegram) values.chat_id = telegram[2];
    if (cols.has("chat_type") && telegram) values.chat_type = telegram[1];
    if (cols.has("title")) values.title = null;
    if (cols.has("billing_provider")) values.billing_provider = this.gw.cfg.model.split("/")[0];
    if (cols.has("model")) values.model = this.gw.cfg.model.split("/").slice(1).join("/");
    if (cols.has("cwd")) values.cwd = this.gw.cfg.workspace;
    const keys = Object.keys(values);
    this.db.prepare(`INSERT OR IGNORE INTO sessions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...(Object.values(values) as any[]));
    this.sessions.set(e.sessionId, row);
    return row;
  }

  /** Carl conversation key for a compat session id (the composer posts to these). */
  private conversationFor(sessionId: string): string | undefined {
    for (const [, row] of this.sessions) if (row.id === sessionId) return keyToConversation(row.key);
    const r = this.db.prepare("SELECT session_key FROM sessions WHERE id = ?").get(sessionId) as { session_key?: string } | undefined;
    return r?.session_key ? keyToConversation(r.session_key) : undefined;
  }

  private mirror(e: TranscriptEvent): void {
    const s = this.sessionFor(e);
    const at = e.at / 1000;
    const toolCalls = e.toolCalls?.length ? JSON.stringify(e.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }))) : null;
    this.db
      .prepare("INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, e.role, e.text || null, e.toolCallId ?? null, toolCalls, e.toolName ?? null, at);
    const cols = columns(this.db, "sessions");
    const sets = ["message_count = COALESCE(message_count,0) + 1"];
    const args: (number | string)[] = [];
    const add = (sql: string, ...v: (number | string)[]) => { sets.push(sql); args.push(...v); };
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    if (cols.has("last_activity_at")) add("last_activity_at = ?", at);
    if (e.toolCalls?.length && cols.has("tool_call_count")) add("tool_call_count = COALESCE(tool_call_count,0) + ?", e.toolCalls.length);
    if (e.usage && cols.has("input_tokens")) {
      add("input_tokens = COALESCE(input_tokens,0) + ?", n(e.usage.input));
      add("output_tokens = COALESCE(output_tokens,0) + ?", n(e.usage.output));
      add("cache_read_tokens = COALESCE(cache_read_tokens,0) + ?", n(e.usage.cacheRead));
      add("cache_write_tokens = COALESCE(cache_write_tokens,0) + ?", n(e.usage.cacheWrite));
      if (cols.has("api_call_count")) add("api_call_count = COALESCE(api_call_count,0) + 1");
    }
    if (e.model && cols.has("model")) {
      const [provider, ...rest] = e.model.split("/");
      this.db.prepare("UPDATE sessions SET model = ?, billing_provider = ? WHERE id = ?").run(rest.join("/"), provider, s.id);
    }
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args, s.id);
    if (e.role === "assistant" && e.usage && e.model && hasTable(this.db, "session_model_usage")) {
      const [provider, ...rest] = e.model.split("/");
      const u = e.usage;
      this.db
        .prepare(`INSERT INTO session_model_usage (session_id, model, billing_provider, billing_base_url, billing_mode, task, api_call_count,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source, first_seen, last_seen)
          VALUES (?, ?, ?, '', 'subscription_included', 'main', 1, ?, ?, ?, ?, ?, ?, 0, 'included', 'carl', ?, ?)
          ON CONFLICT(session_id, model, billing_provider, billing_base_url, billing_mode, task) DO UPDATE SET
            api_call_count = api_call_count + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
            cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
            reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens, estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd, last_seen = excluded.last_seen`)
        .run(s.id, rest.join("/"), provider, u.input, u.output, u.cacheRead, u.cacheWrite, u.reasoning, u.cost, at, at);
    }
  }

  /** Newest Telegram session id: the same rule UltraTerm uses to pick the conversation. */
  private latestTelegramSession(): string | undefined {
    const r = this.db
      .prepare("SELECT m.session_id AS id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.source = 'telegram' AND m.role IN ('user','assistant') ORDER BY m.id DESC LIMIT 1")
      .get() as { id?: string } | undefined;
    return r?.id;
  }

  // ---- HTTP routes ---------------------------------------------------------------------------------------------

  private routes(): void {
    const api = this.gw.api!;
    const gw = this.gw;
    api.route("GET", /^\/health\/detailed$/, (_q, res) => json(res, 200, { status: "ok", platform: "carl", ...gw.health() }));
    api.route("GET", /^\/v1\/capabilities$/, (_q, res) =>
      json(res, 200, { object: "carl.capabilities", platform: "carl", model: gw.cfg.model, features: { chat_completions: true, sessions: true, jobs: true, intake: true } }));

    // Composer: durable, idempotent intake into the operator's Telegram conversation.
    api.route("GET", /^\/api\/intake\/capabilities$/, (_q, res) =>
      json(res, 200, { contract: INTAKE_CONTRACT, durable: true, idempotent: true, canonicalMessaging: true, modelSelection: { contract: MODEL_CONTRACT, persisted: true, idempotent: true } }));
    api.route("POST", /^\/api\/sessions\/[^/]+\/intake$/, async (req, res, url, body) => {
      const sessionId = segment(url, 3);
      const requestId = String(req.headers["idempotency-key"] ?? "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return json(res, 400, { error: { message: "Idempotency-Key header is required ([A-Za-z0-9_-]{1,128})" } });
      const message = typeof body?.message === "string" ? body.message : "";
      if (!message.trim() || message.length > 8_000) return json(res, 400, { error: { message: "message must be 1-8000 characters" } });
      const payload = JSON.stringify({ message, mirror: !!body.mirror, recipient: String(body.recipient ?? "") });
      const prior = this.intake.prepare("SELECT session_id, payload, state FROM intake WHERE request_id = ?").get(requestId) as { session_id: string; payload: string; state: string } | undefined;
      const receipt = { contract: INTAKE_CONTRACT, requestId, sessionId, accepted: true };
      if (prior) {
        if (prior.payload !== payload || prior.session_id !== sessionId) return json(res, 409, { error: { code: "intake_request_conflict", message: "this Idempotency-Key was used with a different message" } });
        return json(res, 202, prior.state === "route_changed" ? { ...receipt, execution: "route_changed" } : receipt);
      }
      const conversation = this.conversationFor(sessionId);
      if (!conversation) return json(res, 404, { error: { message: `no Carl conversation for session ${sessionId}` } });
      const current = this.latestTelegramSession();
      this.intake.prepare("INSERT INTO intake (request_id, session_id, payload, state, created_at) VALUES (?, ?, ?, 'accepted', ?)").run(requestId, sessionId, payload, Date.now() / 1000);
      if (current && current !== sessionId) {
        this.intake.prepare("UPDATE intake SET state = 'route_changed' WHERE request_id = ?").run(requestId);
        return json(res, 202, { ...receipt, execution: "route_changed" });
      }
      json(res, 202, receipt);
      void this.runIntake(requestId, conversation, message, !!body.mirror, String(body.recipient ?? ""));
    });

    // Model picker.
    api.route("GET", /^\/api\/model\/options$/, (_q, res) => {
      const available = new Set(gw.brain.listModels());
      const current = toPicker(this.currentModel());
      const providers = PICKER_MAP.map(([slug, model, ref]) => ({ slug, models: [model], authenticated: available.has(ref) }));
      json(res, 200, { provider: current?.[0] ?? this.currentModel().split("/")[0], model: current?.[1] ?? this.currentModel().split("/").slice(1).join("/"), providers });
    });
    api.route("GET", /^\/api\/sessions\/[^/]+\/model-selection$/, (_q, res, url) => {
      const sessionId = segment(url, 3);
      const current = toPicker(this.currentModel());
      // A Carl model outside the picker's routes: the UI falls back to a read-only label.
      if (!current) return json(res, 404, { error: { code: "model_selection_route_unavailable", message: `${this.currentModel()} is not one of UltraTerm's picker routes` } });
      json(res, 200, { contract: MODEL_CONTRACT, sessionId, provider: current[0], model: current[1], resolvedModel: current[1], persisted: true });
    });
    api.route("POST", /^\/api\/sessions\/[^/]+\/model-selection$/, async (req, res, url, body) => this.selectModel(req.headers, res, segment(url, 3), body));

    // Schedules.
    const jobView = (j: ReturnType<typeof gw.scheduler.list>[number]) => ({
      id: j.id, name: j.name, prompt: j.prompt ?? null, script: j.command ?? j.builtin ?? null, schedule_display: j.when, schedule: { display: j.when },
      state: j.enabled ? (j.lastStatus === "running" ? "running" : "scheduled") : "paused", enabled: j.enabled,
      next_run_at: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null, last_run_at: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
      last_status: j.lastStatus ?? null, last_error: j.lastError ?? null, last_delivery_error: null, failure_streak: j.lastStatus === "error" ? 1 : 0,
      deliver: j.deliver, no_agent: !j.prompt, paused_reason: j.enabled ? null : "paused", repeat: { completed: null },
    });
    api.route("GET", /^\/api\/jobs$/, (_q, res, url) => {
      const all = url.searchParams.get("include_disabled") === "true";
      json(res, 200, { jobs: gw.scheduler.list().filter((j) => all || j.enabled).map(jobView) });
    });
    api.route("POST", /^\/api\/jobs\/[A-Za-z0-9_-]{1,64}\/(pause|resume|run)$/, async (_q, res, url) => {
      const [, , , id, action] = url.pathname.split("/");
      if (action === "run") void gw.scheduler.runNow(id).catch((e) => gw.log.error("job run failed", { id, error: (e as Error).message }));
      else gw.scheduler.setEnabled(id, action === "resume");
      json(res, 200, { ok: true, job: gw.scheduler.list().filter((j) => j.id === id).map(jobView)[0] ?? null });
    });

    // Sessions and transcripts (read from the mirror).
    api.route("GET", /^\/api\/sessions$/, (_q, res, url) => {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 200);
      const rows = this.db
        .prepare(`SELECT id, source, title, model, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, actual_cost_usd, parent_session_id, last_activity_at FROM sessions
            WHERE id LIKE 'carl\\_%' ESCAPE '\\' ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ?`)
        .all(limit) as any[];
      json(res, 200, { object: "list", data: rows.map((r) => ({ ...r, last_active: r.last_activity_at, preview: null, pinned: false })) });
    });
    api.route("GET", /^\/api\/sessions\/[^/]+\/messages$/, (_q, res, url) => {
      const id = segment(url, 3);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 500);
      const rows = (this.db.prepare("SELECT id, role, content, tool_name, tool_call_id, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(id, limit) as any[]).reverse();
      json(res, 200, { object: "list", session_id: id, data: rows.map((r) => ({ ...r, tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : null })) });
    });

    // Tools and skills panes.
    api.route("GET", /^\/v1\/toolsets$/, (_q, res) =>
      json(res, 200, { object: "list", platform: "carl", data: [
        { name: "pi", label: "Pi built-ins", description: "Pi's own tools", enabled: true, configured: true, tools: gw.cfg.tools },
        { name: "carl", label: "Carl", description: "Psyche, messaging and schedules", enabled: true, configured: true, tools: ["decision_log", "shadow_note", "send_message", "schedule"] },
        { name: "mcp", label: "MCP via codemode", description: "MCP servers reached through codemode scripts", enabled: gw.cfg.mcp, configured: existsSync(join(gw.cfg.home, "mcp.json")), tools: mcpServers(gw.cfg.home) },
      ] }));
    api.route("GET", /^\/v1\/skills$/, (_q, res) => json(res, 200, { object: "list", data: listSkills(gw.cfg.skills) }));
  }

  private currentModel(): string {
    return this.gw.cfg.model;
  }

  /** Durable intake: requests accepted but never started run now; ones cut off by a restart are reported. */
  private resumeIntake(): void {
    const rows = this.intake.prepare("SELECT request_id, session_id, payload, state FROM intake WHERE state IN ('accepted', 'running')").all() as any[];
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      const conversation = this.conversationFor(r.session_id);
      if (r.state === "running" || !conversation) {
        this.intake.prepare("UPDATE intake SET state = 'failed', result = ? WHERE request_id = ?").run("interrupted by a restart", r.request_id);
        void this.gw.send(p.recipient || "home", `Carl restarted while answering your UltraTerm message: "${String(p.message).slice(0, 160)}". Send it again if it still matters.`)
          .catch((e) => this.gw.log.warn("cannot report an interrupted composer request", { error: (e as Error).message }));
        continue;
      }
      this.gw.log.info("resuming accepted composer request", { requestId: r.request_id });
      void this.runIntake(r.request_id, conversation, p.message, !!p.mirror, String(p.recipient ?? ""));
    }
  }

  private async runIntake(requestId: string, conversation: string, message: string, mirror: boolean, recipient: string): Promise<void> {
    this.intake.prepare("UPDATE intake SET state = 'running' WHERE request_id = ?").run(requestId);
    try {
      const result = await this.gw.brain.ask(conversation, { text: message, source: "telegram" });
      const reply = result.steered ? "(added to the running turn)" : result.ok ? result.text : `Run failed: ${result.error ?? "stopped"}`;
      this.intake.prepare("UPDATE intake SET state = 'done', result = ? WHERE request_id = ?").run(reply.slice(0, 20_000), requestId);
      if (mirror && recipient && !result.steered) {
        await this.gw.send(recipient, `You (UltraTerm): ${message}\n\n${this.gw.cfg.name}: ${reply}`).catch((e) =>
          this.gw.log.error("composer mirror failed", { error: (e as Error).message }));
      }
    } catch (e) {
      this.intake.prepare("UPDATE intake SET state = 'failed', result = ? WHERE request_id = ?").run((e as Error).message, requestId);
      this.gw.log.error("composer intake failed", { requestId, error: (e as Error).message });
    }
  }

  private async selectModel(headers: Record<string, any>, res: any, sessionId: string, body: any): Promise<void> {
    if (headers.origin) return json(res, 403, { error: { code: "model_selection_permission_denied", message: "browser origins are refused" } });
    const requestId = String(headers["idempotency-key"] ?? "");
    const keys = body && typeof body === "object" ? Object.keys(body).sort().join(",") : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || keys !== "expectedModel,expectedProvider,model,provider")
      return json(res, 400, { error: { code: "model_selection_invalid", message: "Idempotency-Key and exactly provider, model, expectedProvider, expectedModel are required" } });
    const payload = JSON.stringify(body);
    const prior = this.intake.prepare("SELECT payload, state, receipt FROM model_selection WHERE request_id = ?").get(requestId) as any;
    if (prior) {
      if (prior.payload !== payload) return json(res, 409, { error: { code: "model_selection_request_conflict", message: "request id reused with a different body" } });
      if (prior.state === "committed") return json(res, 200, JSON.parse(prior.receipt));
      return json(res, 409, { error: { code: "model_selection_unknown", message: "an earlier attempt with this id did not finish" } });
    }
    const expected = fromPicker(String(body.expectedProvider), String(body.expectedModel));
    if (!expected || expected[2] !== this.currentModel())
      return json(res, 409, { error: { code: "model_selection_stale", message: `current model is ${this.currentModel()}` } });
    const target = fromPicker(String(body.provider), String(body.model));
    if (!target) return json(res, 422, { error: { code: "model_selection_route_denied", message: `${body.provider}/${body.model} is not a Carl route` } });
    const ref = target[2];
    try {
      this.gw.brain.model(ref);
    } catch (e) {
      return json(res, 422, { error: { code: "model_selection_rejected", message: (e as Error).message } });
    }
    this.intake.prepare("INSERT INTO model_selection (request_id, session_id, payload, state) VALUES (?, ?, ?, 'claimed')").run(requestId, sessionId, payload);
    persistModel(this.gw.cfg.home, ref);
    // The router reads the primary per request; with no router, sessions pick it up at their next start.
    this.gw.cfg.model = ref;
    if (!this.gw.cfg.fallbackModels.length) {
      const conversation = this.conversationFor(sessionId);
      if (conversation) await this.gw.brain.setModel(conversation, ref).catch(() => {});
    }
    const receipt = { contract: MODEL_CONTRACT, requestId, sessionId, state: "committed", provider: target[0], model: target[1], persisted: true, resolvedModel: target[1] };
    this.intake.prepare("UPDATE model_selection SET state = 'committed', receipt = ? WHERE request_id = ?").run(JSON.stringify(receipt), requestId);
    this.gw.log.info("model switched from UltraTerm", { model: ref });
    json(res, 200, receipt);
  }

  // ---- Telegram decision buttons (utd:<D-id>:<choice>) --------------------------------------------------------

  private async decision(q: any, data: string): Promise<string | void> {
    const parts = data.split(":");
    if (parts.length !== 3 || !parts[1].startsWith("D-") || !/^\d+$/.test(parts[2])) return "That button is malformed; nothing was sent.";
    if (q.message?.chat?.type !== "private") return "Answer UltraTerm questions in your direct chat with the bot.";
    const out = await run(this.opts.overseerBin, ["decision-answer", "--id", parts[1], "--choice", parts[2], "--user", String(q.from.id), "--callback", q.id], 60_000);
    let text: string;
    let accepted = false;
    let replay = false;
    if (out.error) {
      text = `UltraTerm could not take the answer (${out.error}); nothing was sent.`;
    } else if (out.code !== 0) {
      let reason = out.stderr.trim().slice(0, 160);
      try { reason = JSON.parse(out.stderr).error ?? reason; } catch {}
      text = `UltraTerm refused the answer: ${reason}. Nothing was sent.`;
    } else {
      try {
        const r = JSON.parse(out.stdout);
        text = String(r.result ?? "Done.");
        accepted = !!r.accepted;
        replay = !!r.replay;
      } catch {
        text = "UltraTerm answered in an unexpected format.";
      }
    }
    if (!replay && !/^Only .{1,40} can answer/.test(text) && q.message) {
      const original = q.message.text ?? "";
      await this.gw.telegram!.api.editMessageText(q.message.chat.id, q.message.message_id, `${original}\n\n${accepted ? "✅" : "⛔"} ${text}`)
        .catch((e) => this.gw.log.warn("decision message edit failed", { error: (e as Error).message }));
    }
    return text.slice(0, 190);
  }
}

function keyToConversation(sessionKey: string): string {
  const m = sessionKey.match(/^agent:main:telegram:(dm|group):(-?\d+)/);
  if (m) return `telegram:${m[1]}:${m[2]}`;
  return sessionKey.replace(/^carl:/, "");
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** A fresh home gets the subset of the Hermes schema UltraTerm reads; an existing database is left as it is. */
function ensureSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, session_key TEXT, chat_id TEXT, chat_type TEXT,
      model TEXT, billing_provider TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, title TEXT, cwd TEXT,
      message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, actual_cost_usd REAL,
      api_call_count INTEGER DEFAULT 0, last_activity_at REAL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);
    CREATE TABLE IF NOT EXISTS session_model_usage (session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',
      billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task));`);
}

function persistModel(home: string, ref: string): void {
  const file = join(home, "carl.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  raw.model = ref;
  writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function mcpServers(home: string): string[] {
  const file = join(home, "mcp.json");
  if (!existsSync(file)) return [];
  try {
    return Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {});
  } catch {
    return [];
  }
}

function listSkills(dirs: string[]): { name: string; description: string; category: string }[] {
  const out: { name: string; description: string; category: string }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSafe(dir)) {
      const file = join(dir, entry, "SKILL.md");
      if (!existsSync(file)) continue;
      const head = readFileSync(file, "utf8").slice(0, 2_000);
      const desc = head.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
      out.push({ name: head.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry, description: desc.slice(0, 300), category: "shared" });
    }
  }
  return out;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, error: e.message }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, error: signal ? `timed out after ${timeoutMs / 1000}s` : undefined });
    });
  });
}

function execText(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** A decoded path segment; bad percent-encoding is a 400, not a 500. */
function segment(url: URL, i: number): string {
  try {
    return decodeURIComponent(url.pathname.split("/")[i] ?? "");
  } catch {
    throw Object.assign(new Error("bad URL encoding in the path"), { status: 400 });
  }
}
