// Discord channel over the Gateway (WebSocket) and REST API. Needs a bot token with the MESSAGE CONTENT intent
// enabled in the developer portal. Only users in discord.allowFrom are answered.
import type { Brain } from "../brain.ts";
import { visibleControls } from "./format.ts";
import type { Log } from "../log.ts";
import { MIRROR_INSTRUCTION } from "../psyche.ts";

export interface DiscordConfig {
  enabled: boolean;
  allowFrom: string[];
  tokenEnv: string;
  /** Channel id for "discord:home" deliveries. */
  homeChannel?: string;
  apiBase: string;
}

const INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // guild messages, direct messages, message content
const LIMIT = 1_900;
const EDIT_INTERVAL_MS = 1_500;

export class DiscordChannel {
  status: { state: "connecting" | "connected" | "retrying" | "stopped" | "fatal"; error?: string; updatedAt: string } = { state: "connecting", updatedAt: new Date().toISOString() };
  private ws?: WebSocket;
  private seq: number | null = null;
  private heartbeat?: NodeJS.Timeout;
  private stopping = false;
  private botId = "";
  /** Channels an allowed user has talked in, and which of them are DMs. */
  readonly known = new Set<string>();
  readonly dms = new Set<string>();
  private ready = false;
  private readonly approvals = new Map<string, (a: "approved" | "denied") => void>();
  private readonly cfg: DiscordConfig;
  private readonly token: string;
  private readonly brain: Brain;
  private readonly log: Log;

  constructor(cfg: DiscordConfig, token: string, brain: Brain, log: Log) {
    this.cfg = cfg;
    this.token = token;
    this.brain = brain;
    this.log = log;
  }

  async rest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.cfg.apiBase}${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 3) {
        const j: any = await res.json().catch(() => ({}));
        await new Promise((r) => setTimeout(r, Math.ceil((j.retry_after ?? 1) * 1_000)));
        continue;
      }
      if (res.status === 204) return undefined as T;
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Discord ${method} ${path.split("?")[0]} failed (${res.status}): ${json.message ?? "error"}`);
      return json as T;
    }
  }

  async start(): Promise<void> {
    if (!this.cfg.allowFrom.length) this.log.warn("discord.allowFrom is empty: Carl will answer nobody on Discord");
    void this.connect();
  }

  private async connect(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        const { url } = await this.rest<{ url: string }>("GET", "/gateway/bot");
        await new Promise<void>((resolve) => {
          const ws = new WebSocket(`${url}?v=10&encoding=json`);
          this.ws = ws;
          ws.onmessage = (m) => void this.onFrame(JSON.parse(String(m.data))).catch((e) => this.log.error("discord frame failed", { error: (e as Error).message }));
          ws.onclose = (e) => {
            if (this.heartbeat) clearInterval(this.heartbeat);
            const fatal: Record<number, string> = {
              4004: "Discord rejected the bot token (4004)", 4010: "invalid shard (4010)", 4011: "sharding required (4011)",
              4012: "invalid gateway version (4012)", 4013: "invalid intents (4013)", 4014: "the MESSAGE CONTENT intent is not enabled for this bot (4014)",
            };
            if (fatal[e.code]) this.setStatus("fatal", fatal[e.code]);
            resolve();
          };
          ws.onerror = () => {};
        });
        if (this.status.state === "fatal") return void this.log.error("discord stopped", { error: this.status.error });
        // Only a session that reached READY counts as healthy; otherwise back off (Discord limits session starts).
        if (this.ready) failures = 0; else failures++;
        this.ready = false;
      } catch (e) {
        failures++;
        this.setStatus("retrying", (e as Error).message);
        if (/\(401\)/.test((e as Error).message)) return void this.setStatus("fatal", "Discord rejected the bot token (401)");
      }
      if (!this.stopping) await new Promise((r) => setTimeout(r, Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6))));
    }
  }

  private setStatus(state: DiscordChannel["status"]["state"], error?: string): void {
    this.status = { state, error, updatedAt: new Date().toISOString() };
  }

  private send(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private async onFrame(f: { op: number; d: any; s?: number; t?: string }): Promise<void> {
    if (typeof f.s === "number") this.seq = f.s;
    if (f.op === 10) {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send(1, this.seq), f.d.heartbeat_interval);
      this.send(2, { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: "carl", device: "carl" } });
    } else if (f.op === 1) {
      this.send(1, this.seq);
    } else if (f.op === 7 || f.op === 9) {
      this.ws?.close(); // reconnect with a fresh identify
    } else if (f.op === 0 && f.t === "READY") {
      this.botId = f.d.user?.id ?? "";
      this.ready = true;
      this.setStatus("connected");
      this.log.info("discord connected", { bot: f.d.user?.username });
    } else if (f.op === 0 && f.t === "MESSAGE_CREATE") {
      await this.onMessage(f.d);
    } else if (f.op === 0 && f.t === "INTERACTION_CREATE") {
      const user = f.d.member?.user?.id ?? f.d.user?.id;
      const [, id, choice] = String(f.d.data?.custom_id ?? "").split(":");
      await this.rest("POST", `/interactions/${f.d.id}/${f.d.token}/callback`, { type: 6 }).catch(() => {});
      if (user && this.cfg.allowFrom.includes(user)) this.approvals.get(id)?.(choice === "yes" ? "approved" : "denied");
    }
  }

  private async onMessage(d: any): Promise<void> {
    if (d.author?.bot || d.author?.id === this.botId) return;
    if (!this.cfg.allowFrom.includes(d.author?.id)) {
      this.log.warn("ignored Discord message from a user not in discord.allowFrom", { user: d.author?.id });
      return;
    }
    const isDm = !d.guild_id;
    if (!isDm && !(d.mentions ?? []).some((m: any) => m.id === this.botId)) return; // in servers, only when mentioned
    let text = String(d.content ?? "").replace(new RegExp(`<@!?${this.botId}>`, "g"), "").trim();
    if (!text) return;
    const key = `discord:${isDm ? "dm:" : ""}${d.channel_id}`;
    this.known.add(d.channel_id);
    if (isDm) this.dms.add(d.channel_id);
    if (/^stop$/i.test(text)) return void (await this.post(d.channel_id, (await this.brain.stop(key)) ? "Stopping." : "Nothing is running."));
    if (/^new$/i.test(text)) { await this.brain.reset(key); return void (await this.post(d.channel_id, "Fresh conversation.")); }
    let preface: string | undefined;
    const mirror = text.match(/^mirror\s+([\s\S]+)/i);
    if (mirror) { preface = MIRROR_INSTRUCTION; text = mirror[1]; }
    void this.rest("POST", `/channels/${d.channel_id}/typing`).catch(() => {});
    let draft: string | undefined;
    let shown = "";
    let latest = "";
    let last = 0;
    let timer: NodeJS.Timeout | undefined;
    const flush = async () => {
      const body = latest.length > LIMIT ? "…" + latest.slice(-LIMIT) : latest;
      if (!body.trim() || body === shown) return;
      shown = body;
      last = Date.now();
      if (!draft) draft = (await this.rest<{ id: string }>("POST", `/channels/${d.channel_id}/messages`, { content: body, message_reference: { message_id: d.id, fail_if_not_exists: false }, allowed_mentions: { parse: [] } })).id;
      else await this.rest("PATCH", `/channels/${d.channel_id}/messages/${draft}`, { content: body, allowed_mentions: { parse: [] } }).catch(() => {});
    };
    const result = await this.brain.ask(key, { text, preface, source: "api" }, {
      onText: (t) => {
        latest = t;
        if (timer) return;
        timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}); }, Math.max(0, EDIT_INTERVAL_MS - (Date.now() - last)));
      },
    });
    if (timer) clearTimeout(timer);
    if (result.steered) return void (await this.rest("PUT", `/channels/${d.channel_id}/messages/${d.id}/reactions/${encodeURIComponent("👀")}/@me`).catch(() => {}));
    const final = result.aborted ? `${result.text ? result.text + "\n\n" : ""}*(stopped)*` : !result.ok ? `${result.text ? result.text + "\n\n" : ""}Run failed: ${result.error}` : result.text || "Done.";
    const chunks = splitDiscord(final);
    if (draft) {
      await this.rest("PATCH", `/channels/${d.channel_id}/messages/${draft}`, { content: chunks[0], allowed_mentions: { parse: [] } });
      for (const c of chunks.slice(1)) await this.post(d.channel_id, c);
    } else {
      for (const c of chunks) await this.post(d.channel_id, c);
    }
  }

  async post(channel: string, content: string, components?: unknown[]): Promise<string> {
    return (await this.rest<{ id: string }>("POST", `/channels/${channel}/messages`, { content, components, allowed_mentions: { parse: [] } })).id;
  }

  async deliver(target: string, markdown: string): Promise<number> {
    const channel = target === "home" ? this.cfg.homeChannel : target;
    if (!channel) throw new Error("discord.homeChannel is not configured");
    if (channel !== this.cfg.homeChannel && !this.known.has(channel)) throw new Error(`Discord channel ${channel} is not the home channel or a conversation an allowed user started`);
    const chunks = splitDiscord(markdown);
    for (const c of chunks) await this.post(channel, c);
    return chunks.length;
  }

  async requestApproval(channel: string, command: string, reason: string): Promise<"approved" | "denied" | "timeout"> {
    if (!this.dms.has(channel) && this.cfg.homeChannel && channel !== this.cfg.homeChannel) {
      command = `${command}\n\n(from the conversation in ${channel})`;
      channel = this.cfg.homeChannel;
    }
    if (command.length > 1_700) {
      await this.post(channel, `Refused without asking: a ${reason} command of ${command.length} characters is too long to review here.`).catch(() => {});
      return "denied";
    }
    const id = Math.random().toString(36).slice(2, 10);
    const fenced = "```\n" + visibleControls(command).replace(/```/g, "`\u200b``") + "\n```";
    const msg = await this.post(channel, `**Approve?** ${reason.replace(/[`*_~|<>@]/g, "")}\n${fenced}`, [{ type: 1, components: [
      { type: 2, style: 3, label: "Run once", custom_id: `ca:${id}:yes` },
      { type: 2, style: 4, label: "Deny", custom_id: `ca:${id}:no` },
    ] }]);
    const answer = await new Promise<"approved" | "denied" | "timeout">((resolve) => {
      const timer = setTimeout(() => { this.approvals.delete(id); resolve("timeout"); }, 300_000);
      this.approvals.set(id, (a) => { clearTimeout(timer); this.approvals.delete(id); resolve(a); });
    });
    const mark = answer === "approved" ? "approved" : answer === "denied" ? "denied" : "expired (not run)";
    await this.rest("PATCH", `/channels/${channel}/messages/${msg}`, { content: `**${mark}** ${reason}\n${fenced}`, components: [] }).catch(() => {});
    return answer;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
    this.setStatus("stopped");
  }
}

export function splitDiscord(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf("\n", LIMIT);
    if (cut < LIMIT / 2) cut = LIMIT;
    let head = rest.slice(0, cut);
    let tail = rest.slice(cut).replace(/^\n/, "");
    if ((head.match(/```/g) ?? []).length % 2) { head += "\n```"; tail = "```\n" + tail; } // keep code fences balanced
    out.push(head);
    rest = tail;
  }
  if (rest.trim()) out.push(rest);
  return out;
}
