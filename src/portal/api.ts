// Portal API (/carl/*) and the static web app (/). The page is public; every API call needs the bearer key.
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantText, listSessionFiles, sessionDir, toolResultText } from "../brain.ts";
import type { Gateway } from "../gateway.ts";
import { readJsonl } from "../psyche.ts";
import { json, type ApiServer } from "../server.ts";

const STATIC = fileURLToPath(new URL("./static/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const PUBLIC = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"], ["/app.css", "app.css"], ["/icon.svg", "icon.svg"], ["/manifest.webmanifest", "manifest.webmanifest"], ["/sw.js", "sw.js"]]);

export function publicAsset(pathname: string): { body: Buffer; type: string } | undefined {
  const name = PUBLIC.get(pathname);
  if (!name) return undefined;
  const file = join(STATIC, name);
  if (!existsSync(file)) return undefined;
  return { body: readFileSync(file), type: TYPES[extname(file)] ?? "application/octet-stream" };
}

const KEY_RE = "([A-Za-z0-9_.:@-]{1,160})";

interface Line { role: "user" | "assistant" | "tool"; text: string; at: number; tool?: string; model?: string }

/** Read a Pi session file into display lines (newest last). */
function transcript(file: string, limit: number): Line[] {
  const out: Line[] = [];
  for (const e of readJsonl<any>(file)) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const at = Date.parse(e.timestamp ?? "") || m.timestamp || 0;
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      if (text) out.push({ role: "user", text, at });
    } else if (m.role === "assistant") {
      for (const c of m.content ?? []) if (c.type === "toolCall") out.push({ role: "tool", tool: c.name, text: JSON.stringify(c.arguments ?? {}).slice(0, 300), at });
      const text = assistantText(m);
      if (text || m.errorMessage) out.push({ role: "assistant", text: text || `(${m.stopReason}: ${m.errorMessage})`, at, model: `${m.provider}/${m.model}` });
    } else if (m.role === "toolResult" && m.isError) {
      out.push({ role: "tool", tool: m.toolName, text: `error: ${toolResultText(m).slice(0, 300)}`, at });
    }
  }
  return out.slice(-limit);
}

function latestFile(home: string, key: string): string | undefined {
  const dir = sessionDir(home, key);
  if (!existsSync(dir)) return undefined;
  const files = listSessionFiles(home).filter((f) => join(home, "sessions", f.dir) === dir);
  return files[0]?.file;
}

export function mountPortal(api: ApiServer, gw: Gateway): void {
  const { brain, scheduler, psyche, cfg } = gw;

  api.route("GET", /^\/carl\/status$/, (_q, res) =>
    json(res, 200, {
      ...gw.health(),
      primary: cfg.model,
      fallbacks: cfg.fallbackModels,
      limits: Object.fromEntries([...brain.routerState.entries()].filter(([, until]) => until > Date.now()).map(([ref, until]) => [ref, new Date(until).toISOString()])),
      conversationsOpen: brain.activeConversations(),
      schedules: scheduler.list().length,
      lessons: psyche.read("integrated.md").split("\n").filter((l) => l.trim().startsWith("-")).length,
    }));

  api.route("GET", /^\/carl\/conversations$/, (_q, res) => {
    const open = new Map(brain.activeConversations().map((c) => [c.key, c]));
    const seen = new Set<string>();
    const rows: any[] = [];
    for (const f of listSessionFiles(cfg.home)) {
      if (seen.has(f.key) || f.key === "inspect") continue;
      seen.add(f.key);
      rows.push({ key: f.key, updatedAt: new Date(f.mtime).toISOString(), busy: !!open.get(f.key)?.busy });
    }
    json(res, 200, { data: rows.slice(0, 100) });
  });

  api.route("GET", new RegExp(`^/carl/conversations/${KEY_RE}/messages$`), (_q, res, url) => {
    const key = decodeURIComponent(url.pathname.split("/")[3]);
    const file = latestFile(cfg.home, key);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 1_000);
    json(res, 200, { key, data: file ? transcript(file, limit) : [] });
  });

  // Send a message; the reply streams back as server-sent events: text, tool, done.
  api.route("POST", new RegExp(`^/carl/conversations/${KEY_RE}/messages$`), async (_q, res, url, body) => {
    const key = decodeURIComponent(url.pathname.split("/")[3]);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json(res, 400, { error: { message: "text is required" } });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const result = await brain.ask(key, { text, source: key.startsWith("telegram:") ? "telegram" : "api" }, {
        onText: (t) => send("text", { text: t }),
        onTool: (name, detail) => send("tool", { name, detail }),
      });
      send("done", result);
    } catch (e) {
      send("done", { ok: false, error: (e as Error).message, text: "", model: "", ms: 0 });
    }
    res.end();
  });

  api.route("POST", new RegExp(`^/carl/conversations/${KEY_RE}/(stop|new)$`), async (_q, res, url) => {
    const [, , , rawKey, action] = url.pathname.split("/");
    const key = decodeURIComponent(rawKey);
    if (action === "stop") return json(res, 200, { stopped: await brain.stop(key) });
    await brain.reset(key);
    json(res, 200, { reset: true });
  });

  api.route("GET", /^\/carl\/schedules$/, (_q, res) => json(res, 200, { data: scheduler.list() }));
  api.route("POST", /^\/carl\/schedules$/, (_q, res, _u, body) => {
    const job = scheduler.add({ name: String(body?.name ?? ""), when: String(body?.when ?? ""), prompt: body?.prompt || undefined, command: body?.command || undefined, deliver: String(body?.deliver ?? "home"), onlyIfOutput: !!body?.onlyIfOutput });
    json(res, 201, job);
  });
  api.route("POST", /^\/carl\/schedules\/[A-Za-z0-9_-]{1,64}\/(pause|resume|run|remove)$/, async (_q, res, url) => {
    const [, , , id, action] = url.pathname.split("/");
    if (action === "remove") return json(res, 200, { removed: scheduler.remove(id) });
    if (action === "run") {
      void scheduler.runNow(id).catch((e) => gw.log.error("schedule run failed", { id, error: (e as Error).message }));
      return json(res, 202, { started: true });
    }
    scheduler.setEnabled(id, action === "resume");
    json(res, 200, { ok: true });
  });

  api.route("GET", /^\/carl\/psyche$/, (_q, res) =>
    json(res, 200, {
      self: psyche.read("self.md"),
      persona: psyche.read("persona.md"),
      lessons: psyche.read("integrated.md"),
      lastIndividuation: psyche.lastIndividuation() ?? null,
      shadow: psyche.shadowSince(undefined, 60).reverse(),
      decisions: psyche.decisions(60).reverse(),
    }));
  api.route("PUT", /^\/carl\/psyche\/(self|persona)$/, (_q, res, url, body) => {
    const which = url.pathname.endsWith("self") ? "self.md" : "persona.md";
    if (typeof body?.text !== "string" || !body.text.trim()) return json(res, 400, { error: { message: "text is required" } });
    psyche.write(which, body.text);
    json(res, 200, { saved: which, note: "New conversations use it; open ones keep their prompt until /new." });
  });
  api.route("POST", /^\/carl\/reflect$/, async (_q, res) => json(res, 200, { report: (await gw.individuate()) || null, lessons: psyche.read("integrated.md") }));

  api.route("GET", /^\/carl\/models$/, (_q, res) => json(res, 200, { primary: cfg.model, fallbacks: cfg.fallbackModels, available: brain.listModels() }));

  api.route("GET", /^\/carl\/logs$/, (_q, res, url) => {
    const file = join(cfg.home, "logs", "carl.log");
    const n = Math.min(Number(url.searchParams.get("lines") ?? 200) || 200, 2_000);
    const lines = existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").slice(-n) : [];
    json(res, 200, { data: lines.map((l) => { try { return JSON.parse(l); } catch { return { msg: l }; } }) });
  });
}
