// Loopback HTTP API: OpenAI-compatible chat completions (stateful per conversation) plus health and admin routes.
// Extra routes (e.g. the Hermes compatibility surface UltraTerm reads) are mounted with `route()`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Brain } from "./brain.ts";
import type { CarlConfig } from "./config.ts";
import type { Log } from "./log.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: any) => Promise<void> | void;

const MAX_BODY = 8 * 1024 * 1024;

export class ApiServer {
  private server?: Server;
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  /** Static files served without the key (the web app shell); everything else needs it. */
  publicAsset?: (pathname: string) => { body: Buffer; type: string } | undefined;
  metrics = { requests: 0, messages: 0, lastRequestAt: undefined as string | undefined };
  status: { state: "connecting" | "connected" | "fatal" | "stopped"; error?: string; updatedAt: string } = { state: "connecting", updatedAt: new Date().toISOString() };

  private readonly cfg: CarlConfig;
  private readonly key: string;
  private readonly brain: Brain;
  private readonly log: Log;
  private readonly health: () => Record<string, unknown>;
  constructor(cfg: CarlConfig, key: string, brain: Brain, log: Log, health: () => Record<string, unknown>) {
    this.cfg = cfg;
    this.key = key;
    this.brain = brain;
    this.log = log;
    this.health = health;
    if (key.length < 16) throw new Error(`${cfg.api.keyEnv} must be at least 16 characters`);
    this.route("GET", /^\/(v1\/)?health$/, (_q, res) => json(res, 200, { status: "ok", ...this.health() }));
    this.route("GET", /^\/v1\/models$/, (_q, res) =>
      json(res, 200, { object: "list", data: [{ id: this.cfg.model, object: "model", owned_by: "carl" }, ...this.brain.listModels().filter((m) => m !== this.cfg.model).map((id) => ({ id, object: "model", owned_by: "carl" }))] }));
    this.route("POST", /^\/v1\/chat\/completions$/, (q, res, _u, body) => this.chat(q, res, body));
  }

  /** Routes that authenticate themselves (signed webhooks): they get the raw body and whether the key was valid. */
  private readonly publicRoutes: { method: string; pattern: RegExp; handler: (req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, authorized: boolean) => Promise<void> | void }[] = [];
  publicRoute(method: string, pattern: RegExp, handler: (req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, authorized: boolean) => Promise<void> | void): void {
    this.publicRoutes.push({ method, pattern, handler });
  }

  route(method: string, pattern: RegExp, handler: Handler): void {
    this.routes.push({ method, pattern, handler });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      this.server.on("error", (e) => {
        this.status = { state: "fatal", error: `cannot listen on ${this.cfg.api.host}:${this.cfg.api.port}: ${e.message}`, updatedAt: new Date().toISOString() };
        reject(new Error(this.status.error));
      });
      this.server.listen(this.cfg.api.port, this.cfg.api.host, () => {
        this.status = { state: "connected", updatedAt: new Date().toISOString() };
        this.log.info("api listening", { host: this.cfg.api.host, port: this.cfg.api.port });
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.status = { state: "stopped", updatedAt: new Date().toISOString() };
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(this.key);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.metrics.requests++;
    this.metrics.lastRequestAt = new Date().toISOString();
    let url = new URL("http://localhost/");
    try {
      url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && this.publicAsset) {
        const asset = this.publicAsset(url.pathname);
        if (asset) {
          res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
          return void res.end(asset.body);
        }
      }
      const open = this.publicRoutes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (open) {
        const declared = Number(req.headers["content-length"] ?? 0);
        if (declared > 64_000) return json(res, 413, { error: { message: "payload over 64000 bytes" } });
        return void (await open.handler(req, res, url, await readRaw(req, 64_000), this.authorized(req)));
      }
      if (!this.authorized(req)) return json(res, 401, { error: { message: "missing or wrong bearer key", type: "unauthorized" } });
      const route = this.routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) return json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}`, type: "not_found" } });
      const body = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" ? await readBody(req) : undefined;
      await route.handler(req, res, url, body);
    } catch (e) {
      const err = e as Error & { status?: number };
      this.log.error("api request failed", { path: url.pathname, error: err.message });
      // Client errors name their cause; server errors are logged in full and summarised here.
      if (!res.headersSent) json(res, err.status ?? 500, { error: { message: err.status ? err.message : `internal error (see carl.log at ${new Date().toISOString()})`, type: err.status ? "invalid_request" : "server_error" } });
      else res.end();
    }
  }

  /**
   * OpenAI chat completions. Carl keeps the history itself, so only the newest user message is sent to the agent.
   * Conversation: header X-Carl-Conversation, else body.user, else "api:default".
   */
  private async chat(req: IncomingMessage, res: ServerResponse, body: any): Promise<void> {
    const messages = Array.isArray(body?.messages) ? body.messages.filter((m: any) => m && typeof m === "object") : [];
    const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
    if (lastUser && typeof lastUser.content !== "string" && !Array.isArray(lastUser.content))
      throw Object.assign(new Error("message content must be a string or an array of parts"), { status: 400 });
    if (!lastUser) throw Object.assign(new Error("messages must contain a user message"), { status: 400 });
    const text = typeof lastUser.content === "string" ? lastUser.content : (lastUser.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const conversation = String(req.headers["x-carl-conversation"] ?? body.user ?? "default");
    const key = conversation.includes(":") ? conversation : `api:${conversation}`;
    this.metrics.messages++;
    const id = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      let sent = 0;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: this.cfg.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant" });
      // A client that hangs up stops its own run (never another caller's) instead of leaving tools running for nobody.
      let myRun: number | undefined;
      res.on("close", () => { if (!res.writableEnded && myRun !== undefined) void this.brain.stop(key, myRun); });
      let messages = 0;
      try {
        const result = await this.brain.ask(key, { text, source: "api" }, {
          onRunStart: (id) => { myRun = id; },
          onMessageStart: () => {
            if (messages++ > 0 && sent > 0) chunk({ content: "\n\n" });
            sent = 0;
          },
          onText: (t) => {
            if (t.length > sent) chunk({ content: t.slice(sent) }), (sent = t.length);
          },
        });
        if (!result.ok) chunk({ content: `\n\n[${result.aborted ? "stopped" : `error: ${result.error}`}]` });
        chunk({}, result.ok ? "stop" : "error");
      } catch (e) {
        chunk({ content: `\n\n[error: ${(e as Error).message}]` }, "error");
        this.log.error("streamed chat failed", { key, error: (e as Error).message });
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    let myRun: number | undefined;
    res.on("close", () => { if (!res.writableEnded && myRun !== undefined) void this.brain.stop(key, myRun); });
    const result = await this.brain.ask(key, { text, source: "api" }, { onRunStart: (id) => { myRun = id; } });
    json(res, result.ok ? 200 : 502, {
      id,
      object: "chat.completion",
      created,
      model: result.model,
      choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.ok ? "stop" : "error" }],
      usage: {
        prompt_tokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        completion_tokens: result.usage.output,
        total_tokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite + result.usage.output,
        prompt_tokens_details: { cached_tokens: result.usage.cacheRead },
      },
      ...(result.ok ? {} : { error: { message: result.error ?? "stopped" } }),
    });
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function readRaw(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (b: Buffer) => {
      size += b.length;
      if (size > max) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(b);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(b);
    });
    req.on("end", () => {
      if (!parts.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("body is not valid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}
