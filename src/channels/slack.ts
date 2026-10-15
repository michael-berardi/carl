// Slack channel over Socket Mode (no public URL needed): a WebSocket for events, the Web API for replies.
// Needs an app-level token (xapp-, connections:write) and a bot token (xoxb-, chat:write, reactions:write,
// plus the history scopes for the conversations it should hear). Only users in slack.allowFrom are answered.
import type { Brain } from "../brain.ts";
import { visibleControls } from "./format.ts";
import type { Log } from "../log.ts";
import { MIRROR_INSTRUCTION } from "../psyche.ts";

export interface SlackConfig {
  enabled: boolean;
  allowFrom: string[];
  appTokenEnv: string;
  botTokenEnv: string;
  /** Channel or DM that receives schedule results and alerts sent to "slack:home". */
  homeChannel?: string;
  apiBase: string;
}

export interface SlackEvent { type: string; user?: string; text?: string; channel?: string; ts?: string; thread_ts?: string; channel_type?: string; bot_id?: string; subtype?: string }

const EDIT_INTERVAL_MS = 1_500;
const CHUNK = 12_000;

/** Markdown -> Slack mrkdwn. Escapes &, <, > first so user text can never become a Slack link or mention. */
export function toMrkdwn(md: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2) return part.replace(/^```[\w+-]*\n?/, "```").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return esc(part)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => `<${url}|${label}>`)
        .replace(/^#{1,6}\s+(.*)$/gm, "*$1*")
        .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
        .replace(/~~([^~\n]+)~~/g, "~$1~")
        .replace(/^[-*]\s+/gm, "• ");
    })
    .join("");
}

export class SlackChannel {
  status: { state: "connecting" | "connected" | "retrying" | "stopped" | "fatal"; error?: string; updatedAt: string } = { state: "connecting", updatedAt: new Date().toISOString() };
  private ws?: WebSocket;
  private stopping = false;
  private readonly approvals = new Map<string, (a: "approved" | "denied") => void>();
  private readonly cfg: SlackConfig;
  private readonly appToken: string;
  private readonly botToken: string;
  private readonly brain: Brain;
  private readonly log: Log;
  private botUser = "";
  /** Channels an allowed user has talked in: the only places Carl may deliver to besides home. */
  readonly known = new Set<string>();

  constructor(cfg: SlackConfig, appToken: string, botToken: string, brain: Brain, log: Log) {
    this.cfg = cfg;
    this.appToken = appToken;
    this.botToken = botToken;
    this.brain = brain;
    this.log = log;
  }

  async api<T = any>(method: string, body: Record<string, unknown>, token = this.botToken): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.cfg.apiBase}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 1) * 1_000));
        continue;
      }
      const json: any = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`);
      return json as T;
    }
  }

  async start(): Promise<void> {
    const auth = await this.api<{ user_id: string }>("auth.test", {});
    this.botUser = auth.user_id;
    if (!this.cfg.allowFrom.length) this.log.warn("slack.allowFrom is empty: Carl will answer nobody on Slack");
    void this.connect();
  }

  private async connect(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        const { url } = await this.api<{ url: string }>("apps.connections.open", {}, this.appToken);
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          this.ws = ws;
          ws.onopen = () => {
            failures = 0;
            this.setStatus("connected");
            this.log.info("slack connected");
          };
          ws.onmessage = (m) => void this.onFrame(String(m.data)).catch((e) => this.log.error("slack frame failed", { error: (e as Error).message }));
          ws.onerror = () => reject(new Error("socket error"));
          ws.onclose = () => resolve();
        });
      } catch (e) {
        failures++;
        this.setStatus("retrying", (e as Error).message);
        if (/invalid_auth|not_authed|token_revoked/.test((e as Error).message)) {
          this.setStatus("fatal", (e as Error).message);
          this.log.error("slack token rejected; channel stopped", { error: (e as Error).message });
          return;
        }
      }
      if (!this.stopping) await new Promise((r) => setTimeout(r, Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6))));
    }
  }

  private setStatus(state: SlackChannel["status"]["state"], error?: string): void {
    this.status = { state, error, updatedAt: new Date().toISOString() };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ws?.close();
    this.setStatus("stopped");
  }

  private async onFrame(raw: string): Promise<void> {
    const frame = JSON.parse(raw);
    if (frame.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: frame.envelope_id })); // ack within 3 s
    if (frame.type === "disconnect") return void this.ws?.close();
    if (frame.type === "events_api") {
      const ev: SlackEvent = frame.payload?.event ?? {};
      // One post, one run: DMs arrive as "message", channel mentions as "app_mention" (Slack sends both for a mention).
      const wanted = ev.type === "message" ? ev.channel_type === "im" : ev.type === "app_mention";
      if (wanted && !ev.bot_id && !ev.subtype && ev.user !== this.botUser) await this.onMessage(ev);
    } else if (frame.type === "interactive") {
      const p = frame.payload;
      const action = p?.actions?.[0];
      if (!action || !this.cfg.allowFrom.includes(p.user?.id)) return;
      const [, id, choice] = String(action.value ?? "").split(":");
      this.approvals.get(id)?.(choice === "yes" ? "approved" : "denied");
    }
  }

  static conversationKey(ev: SlackEvent): string {
    if (ev.channel_type === "im") return `slack:dm:${ev.channel}`;
    return `slack:${ev.channel}${ev.thread_ts ? `:${ev.thread_ts}` : ""}`;
  }

  private async onMessage(ev: SlackEvent): Promise<void> {
    if (!ev.user || !this.cfg.allowFrom.includes(ev.user)) {
      this.log.warn("ignored Slack message from a user not in slack.allowFrom", { user: ev.user });
      return;
    }
    let text = (ev.text ?? "").replace(new RegExp(`<@${this.botUser}>`, "g"), "").trim();
    if (!text) return;
    const key = SlackChannel.conversationKey(ev);
    this.known.add(ev.channel!);
    const thread = ev.channel_type === "im" ? undefined : ev.thread_ts ?? ev.ts;
    if (/^stop$/i.test(text)) return void (await this.post(ev.channel!, (await this.brain.stop(key)) ? "Stopping." : "Nothing is running.", thread));
    if (/^new$/i.test(text)) { await this.brain.reset(key); return void (await this.post(ev.channel!, "Fresh conversation.", thread)); }
    let preface: string | undefined;
    const mirror = text.match(/^mirror\s+([\s\S]+)/i);
    if (mirror) { preface = MIRROR_INSTRUCTION; text = mirror[1]; }
    let draftTs: string | undefined;
    let shown = "";
    let last = 0;
    let timer: NodeJS.Timeout | undefined;
    const flush = async (t: string) => {
      const body = t.length > 3_500 ? "…" + t.slice(-3_500) : t;
      if (!body.trim() || body === shown) return;
      shown = body;
      last = Date.now();
      if (!draftTs) draftTs = (await this.api<{ ts: string }>("chat.postMessage", { channel: ev.channel, text: toMrkdwn(body), thread_ts: thread })).ts;
      else await this.api("chat.update", { channel: ev.channel, ts: draftTs, text: toMrkdwn(body) }).catch(() => {});
    };
    let latest = "";
    const result = await this.brain.ask(key, { text, preface, source: "api" }, {
      onText: (t) => {
        latest = t;
        if (timer) return;
        timer = setTimeout(() => { timer = undefined; void flush(latest).catch(() => {}); }, Math.max(0, EDIT_INTERVAL_MS - (Date.now() - last)));
      },
    });
    if (timer) clearTimeout(timer);
    if (result.steered) return void (await this.api("reactions.add", { channel: ev.channel, timestamp: ev.ts, name: "eyes" }).catch(() => {}));
    const final = result.aborted ? `${result.text ? result.text + "\n\n" : ""}_(stopped)_` : !result.ok ? `${result.text ? result.text + "\n\n" : ""}Run failed: ${result.error}` : result.text || "Done.";
    const chunks = splitChunks(toMrkdwn(final));
    if (draftTs) {
      await this.api("chat.update", { channel: ev.channel, ts: draftTs, text: chunks[0] });
      for (const c of chunks.slice(1)) await this.post(ev.channel!, c, thread, true);
    } else {
      for (const c of chunks) await this.post(ev.channel!, c, thread, true);
    }
  }

  async post(channel: string, text: string, thread?: string, formatted = false): Promise<string> {
    return (await this.api<{ ts: string }>("chat.postMessage", { channel, text: formatted ? text : toMrkdwn(text), thread_ts: thread })).ts;
  }

  /** Deliver Markdown to a channel id or "home". */
  async send(target: string, markdown: string): Promise<number> {
    const channel = target === "home" ? this.cfg.homeChannel : target;
    if (!channel) throw new Error("slack.homeChannel is not configured");
    if (channel !== this.cfg.homeChannel && !this.known.has(channel)) throw new Error(`Slack channel ${channel} is not the home channel or a conversation an allowed user started`);
    const chunks = splitChunks(toMrkdwn(markdown));
    for (const c of chunks) await this.post(channel, c, undefined, true);
    return chunks.length;
  }

  /** Ask in the conversation's channel with Block Kit buttons; fails closed after 5 minutes. */
  async requestApproval(channel: string, thread: string | undefined, command: string, reason: string): Promise<"approved" | "denied" | "timeout"> {
    // Shared channels never see commands or file contents: the card goes to the operator's home channel.
    if (!channel.startsWith("D") && this.cfg.homeChannel) {
      command = `${command}\n\n(from the conversation in ${channel})`;
      channel = this.cfg.homeChannel;
      thread = undefined;
    }
    if (command.length > 2_900) {
      await this.post(channel, `Refused without asking: a ${reason} command of ${command.length} characters is too long to review here.`, thread).catch(() => {});
      return "denied";
    }
    const id = Math.random().toString(36).slice(2, 10);
    const code = visibleControls(command).replace(/```/g, "`\u200b``").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    reason = reason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const { ts } = await this.api<{ ts: string }>("chat.postMessage", {
      channel,
      thread_ts: thread,
      text: `Approve? ${reason}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Approve?* ${reason}\n\`\`\`${code}\`\`\`` } },
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "Run once" }, style: "primary", action_id: "carl_approve", value: `ca:${id}:yes` },
          { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: "carl_deny", value: `ca:${id}:no` },
        ] },
      ],
    });
    const answer = await new Promise<"approved" | "denied" | "timeout">((resolve) => {
      const timer = setTimeout(() => { this.approvals.delete(id); resolve("timeout"); }, 300_000);
      this.approvals.set(id, (a) => { clearTimeout(timer); this.approvals.delete(id); resolve(a); });
    });
    const mark = answer === "approved" ? "approved" : answer === "denied" ? "denied" : "expired (not run)";
    await this.api("chat.update", { channel, ts, text: `${reason}: ${mark}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${mark}* ${reason}\n\`\`\`${code}\`\`\`` } }] }).catch(() => {});
    return answer;
  }
}

function splitChunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf("\n", CHUNK);
    if (cut < CHUNK / 2) cut = CHUNK;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}
