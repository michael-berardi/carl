// Telegram channel: long polling, allowlist, media in, commands, and replies that are answers by default.
// A reply is one final message. Streaming (one draft message edited as the answer grows, with the tool line inside
// it) is opt-in: telegram.stream must be true. Approval cards and a long answer split by Telegram's size limit are
// separate messages either way.
import { approvalSummary } from "../approval-text.ts";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cleanEnv, readNoFollow, sandboxArgv } from "../sandbox.ts";
import { type Brain, type RunResult, toolsRanAfter } from "../brain.ts";
import type { CarlConfig } from "../config.ts";
import type { Log } from "../log.ts";
import { recordDeliveries } from "../message-log.ts";
import { MIRROR_INSTRUCTION } from "../psyche.ts";
import { chunkMarkdown, escapeHtml, htmlToPlain, markdownToTelegramHtml, visibleControls } from "./format.ts";
import { type InlineButton, TelegramApi, TelegramError, type TgCallbackQuery, type TgMessage } from "./telegram-api.ts";

interface OutboxItem { id: string; chatId: number; threadId?: number; chunks: string[]; firstAt: number; attempts: number; lastError?: string; status?: "unknown"; requestId?: string; unknownNoticeAttempted?: boolean; editMessageId?: number }

/** Consecutive getUpdates failures before the channel reports "retrying" (a single dropped poll is not an outage). */
export const POLL_FAILURES_BEFORE_RETRYING = 2;

export type CommandHandler = (args: string, chatId: number, key: string) => Promise<string>;

export interface ChannelStatus {
  state: "connecting" | "connected" | "retrying" | "stopped" | "fatal";
  error?: string;
  updatedAt: string;
  lastUpdateAt?: string;
}

// Own-draft edits/deletes are idempotent; only a mutation that can create another message needs replay authorization.
const unknownSend = (error: unknown) => error instanceof TelegramError && error.status === "unknown" && !/^(?:edit|delete)/.test(error.method);

const EDIT_INTERVAL_MS = 1_200;
const FIRST_DRAFT_MS = 900;
const TYPING_INTERVAL_MS = 4_500;

export class TelegramChannel {
  readonly api: TelegramApi;
  status: ChannelStatus = { state: "connecting", updatedAt: new Date().toISOString() };
  private abort = new AbortController();
  private offset = 0;
  private readonly offsetFile: string;
  private loop?: Promise<void>;
  private botName = "";
  /** Extra slash commands (/reflect, /schedules ...) registered by the gateway. */
  readonly commands = new Map<string, { help: string; run: CommandHandler }>();
  /** Callback-button handlers by data prefix. */
  readonly callbacks = new Map<string, (q: TgCallbackQuery, data: string) => Promise<string | void>>();
  onStatus?: (s: ChannelStatus) => void;

  private readonly cfg: CarlConfig;
  private readonly brain: Brain;
  private readonly log: Log;
  constructor(cfg: CarlConfig, token: string, brain: Brain, log: Log) {
    this.cfg = cfg;
    this.brain = brain;
    this.log = log;
    this.api = new TelegramApi(token, cfg.telegram.apiBase);
    // Every delivered message (answer, draft frame, edit, deletion) is recorded where `utp ultrabot audit` reads it.
    // The file belongs to UltraTerm, so it is written only for an installation wired to UltraTerm.
    recordDeliveries(this.api, !!cfg.ultraterm, (msg, data) => this.log.warn(msg, data));
    this.offsetFile = join(cfg.home, "state", "telegram-offset.json");
    if (existsSync(this.offsetFile)) {
      try { this.offset = JSON.parse(readFileSync(this.offsetFile, "utf8")).offset ?? 0; } catch { this.offset = 0; }
    }
  }

  private setStatus(state: ChannelStatus["state"], error?: string): void {
    this.status = { ...this.status, state, error, updatedAt: new Date().toISOString() };
    this.onStatus?.(this.status);
  }

  async start(): Promise<void> {
    if (!this.cfg.telegram.allowFrom.length) this.log.warn("telegram.allowFrom is empty: Carl will answer nobody");
    const me = await this.api.getMe();
    this.botName = me.username ?? "";
    this.log.info("telegram connected", { bot: this.botName });
    const builtin = [
      ["new", "Start a fresh conversation"],
      ["stop", "Stop the current run"],
      ["status", "Model, context and run state"],
      ["outbox", "List held replies; resend or discard by ID"],
      ["model", "Show or switch the model"],
      ["compact", "Compact this conversation now"],
      ["mirror", "Reflect a decision back honestly"],
    ];
    const extra = [...this.commands.entries()].map(([c, v]) => [c, v.help]);
    await this.api.setMyCommands([...builtin, ...extra].map(([command, description]) => ({ command, description }))).catch((e) => this.log.warn("setMyCommands failed", { error: (e as Error).message }));
    this.setStatus("connected");
    this.loop = this.poll();
    void this.flushOutbox();
    void this.reportInterrupted();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    // Give handlers a moment to deliver replies already produced; the in-flight journal covers the rest.
    if (this.handlers.size) await Promise.race([Promise.allSettled([...this.handlers]), new Promise((r) => setTimeout(r, 2_500))]);
    this.graceOver = true; // handlers that finish from here on were cut short by the shutdown
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    await this.loop?.catch(() => {});
    this.setStatus("stopped");
  }

  private saveOffset(): void {
    const tmp = `${this.offsetFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ offset: this.offset }), { mode: 0o600 });
    renameSync(tmp, this.offsetFile);
  }

  private async poll(): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.abort.signal);
        if (failures) this.setStatus("connected");
        failures = 0;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.saveOffset(); // before handling: a crash mid-message never replays it
          this.status.lastUpdateAt = new Date().toISOString();
          if (u.message) this.enqueueMessage(u.message);
          else if (u.callback_query) void this.onCallback(u.callback_query).catch((e) => this.log.error("callback failed", { error: (e as Error).message }));
        }
      } catch (e) {
        if (this.abort.signal.aborted) break;
        const err = e as TelegramError;
        if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
          this.setStatus("fatal", `bot token rejected (${err.code}); fix ${this.cfg.telegram.tokenEnv}`);
          this.log.error("telegram token rejected; polling stopped", { code: err.code });
          return;
        }
        failures++;
        // One dropped long poll (a network blip, a sleep/wake) is routine and the next poll usually succeeds: report "retrying"
        // only from the second failure in a row, so UltraTerm does not flash a connection error for a hiccup it would recover from.
        if (err instanceof TelegramError && err.code === 409) {
          this.setStatus("retrying", "another process is polling this bot token (409 conflict)");
        } else if (failures >= POLL_FAILURES_BEFORE_RETRYING) {
          this.setStatus("retrying", err.message);
        }
        const wait = Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6));
        this.log.warn("telegram poll failed; retrying", { error: err.message, waitMs: wait });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  private allowed(userId?: number): boolean {
    return userId !== undefined && this.cfg.telegram.allowFrom.includes(userId);
  }

  static conversationKey(m: Pick<TgMessage, "chat" | "message_thread_id">): string {
    if (m.chat.type === "private") return `telegram:dm:${m.chat.id}`;
    return `telegram:group:${m.chat.id}${m.message_thread_id ? `:${m.message_thread_id}` : ""}`;
  }

  private readonly chains = new Map<string, Promise<void>>();
  private readonly handlers = new Set<Promise<void>>();
  private graceOver = false;

  /** Messages of one chat are prepared (downloads, speech-to-text) and handed to the brain in arrival order. */
  private enqueueMessage(m: TgMessage): void {
    const key = TelegramChannel.conversationKey(m);
    // Journaled the moment the offset moves past it: a restart at any later point is reported, never silent.
    const journalId = `${m.chat.id}:${m.message_id}`;
    if (this.allowed(m.from?.id)) this.markInflight(journalId, { chatId: m.chat.id, threadId: m.message_thread_id, text: (m.text ?? m.caption ?? (m.voice ? "(voice note)" : "(attachment)")).slice(0, 500) });
    let done!: () => void;
    const handed = new Promise<void>((r) => (done = r));
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const handler = this.onMessage(m, done).catch((e) => this.log.error("message handler failed", { error: (e as Error).stack }));
      this.handlers.add(handler);
      void handler.finally(() => {
        this.handlers.delete(handler);
        done();
        if (!this.graceOver) this.markInflight(journalId); // cut short by a shutdown: kept for the restart notice
      });
      // The next message of this chat waits until this one reached the brain (or 5 s), not until it finished,
      // so a follow-up can still steer the running turn.
      await Promise.race([handed, new Promise((r) => setTimeout(r, 5_000))]);
    });
    this.chains.set(key, next);
    void next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
  }

  // ---- In-flight journal: a restart mid-turn is reported to the operator instead of silently dropped. ----

  private readonly inflightFile = () => join(this.cfg.home, "state", "inflight.json");
  private readInflight(): Record<string, { chatId: number; threadId?: number; text: string; at: string; resumed?: boolean }> {
    try { return JSON.parse(readFileSync(this.inflightFile(), "utf8")); } catch { return {}; }
  }
  private markInflight(id: string, entry?: { chatId: number; threadId?: number; text: string; resumed?: boolean }): void {
    const all = this.readInflight();
    if (entry) all[id] = { ...entry, at: new Date().toISOString() };
    else delete all[id];
    try {
      writeFileSync(`${this.inflightFile()}.tmp`, JSON.stringify(all), { mode: 0o600 });
      renameSync(`${this.inflightFile()}.tmp`, this.inflightFile());
    } catch (e) {
      this.log.warn("cannot write in-flight journal", { error: (e as Error).message });
    }
  }
  private async reportInterrupted(): Promise<void> {
    const left = this.readInflight();
    for (const [id, e] of Object.entries(left)) {
      const excerpt = e.text.length > 160 ? e.text.slice(0, 160) + "…" : e.text;
      // A plain text message in a DM whose turn had not run any tool is simply picked up again: nothing can be
      // repeated. Anything else (a tool may have acted, a voice note or file, a group) is reported instead.
      const messageId = Number(id.split(":")[1]);
      const textOnly = e.text.length < 500 && e.text !== "(voice note)" && e.text !== "(attachment)";
      // At most once: a message that was already picked up after one restart is reported after the next.
      if (!e.resumed && e.chatId > 0 && textOnly && Number.isInteger(messageId) && !toolsRanAfter(this.cfg.home, `telegram:dm:${e.chatId}`, e.text)) {
        this.log.info("resuming a message interrupted by a restart", { chat: e.chatId, message: messageId });
        await this.sendMarkdown(e.chatId, `I restarted while answering this, so I am picking it up again:\n\n> ${excerpt.replace(/\n/g, " ")}`, { threadId: e.threadId })
          .catch((err) => this.log.warn("cannot announce a resumed message", { error: (err as Error).message }));
        this.markInflight(id);
        this.enqueueMessage({ message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: e.chatId, type: "private" }, from: { id: e.chatId, is_bot: false, first_name: "" }, text: e.text } as TgMessage);
        this.markInflight(id, { chatId: e.chatId, threadId: e.threadId, text: e.text, resumed: true });
        continue;
      }
      await this.sendMarkdown(e.chatId, `I restarted while working on this, so it did not finish:\n\n> ${excerpt.replace(/\n/g, " ")}\n\nSend it again if it still matters.`, { threadId: e.threadId })
        .catch((err) => this.log.warn("cannot report an interrupted message", { error: (err as Error).message }));
      this.markInflight(id);
    }
  }

  private async onMessage(m: TgMessage, handed: () => void = () => {}): Promise<void> {
    if (!this.allowed(m.from?.id)) {
      this.log.warn("ignored message from a user not in telegram.allowFrom", { userId: m.from?.id, chat: m.chat.type });
      return handed();
    }
    const key = TelegramChannel.conversationKey(m);
    let text = (m.text ?? m.caption ?? "").trim();
    if (m.chat.type !== "private" && this.botName) text = text.replace(new RegExp(`@${this.botName}\\b`, "g"), "").trim();

    const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (cmd) {
      handed(); // commands never wait behind each other
      const handled = await this.command(cmd[1].toLowerCase(), (cmd[2] ?? "").trim(), m, key);
      if (handled) return;
    }

    const images: { type: "image"; data: string; mimeType: string }[] = [];
    const notes: string[] = [];
    try {
      if (m.photo?.length) {
        const best = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const data = await this.api.download(best.file_id, this.mediaPath(m, ".jpg"));
        images.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
      }
      const audio = m.voice ?? m.audio;
      if (audio) {
        const ext = m.voice ? "ogg" : (m.audio?.file_name?.split(".").pop() ?? "mp3");
        const path = this.mediaPath(m, `.${ext.replace(/[^\w]+/g, "")}`);
        await this.api.download(audio.file_id, path);
        const transcript = await this.transcribe(path);
        const missing = this.cfg.stt?.length ? `[voice note at ${path} could not be transcribed; see carl.log]` : `[voice note saved at ${path}; no speech-to-text is configured]`;
        text = [transcript ? `[voice note] ${transcript}` : missing, text].filter(Boolean).join("\n\n");
      }
      if (m.document) {
        const name = (m.document.file_name ?? "file").replace(/[^\w.-]+/g, "_");
        const path = this.mediaPath(m, `-${name}`);
        const data = await this.api.download(m.document.file_id, path);
        if (m.document.mime_type?.startsWith("image/")) images.push({ type: "image", data: data.toString("base64"), mimeType: m.document.mime_type });
        else notes.push(`[file received: ${path}]`);
      }
    } catch (e) {
      notes.push(`[attachment could not be fetched: ${(e as Error).message}]`);
    }
    if (m.reply_to_message?.text) notes.unshift(`[replying to: "${m.reply_to_message.text.slice(0, 400)}"]`);
    const body = [...notes, text].filter(Boolean).join("\n");
    if (!body && !images.length) return handed();
    await this.converse(m, key, { text: body || "(image)", images: images.length ? images : undefined, source: "telegram" }, handed);
  }

  private async converse(m: TgMessage, key: string, input: Parameters<Brain["ask"]>[1], handed: () => void = () => {}): Promise<void> {
    const chatId = m.chat.id;
    const threadId = m.message_thread_id;
    await this.converseInner(m, key, input, handed);
  }

  private async converseInner(m: TgMessage, key: string, input: Parameters<Brain["ask"]>[1], handed: () => void): Promise<void> {
    const chatId = m.chat.id;
    const threadId = m.message_thread_id;
    const typing = setInterval(() => void this.api.sendChatAction(chatId, "typing", threadId).catch(() => {}), TYPING_INTERVAL_MS);
    void this.api.sendChatAction(chatId, "typing", threadId).catch(() => {});
    const draft = new Draft(this.api, chatId, m.message_id, threadId, this.cfg.telegram.stream);
    let result: RunResult;
    try {
      const running = this.brain.ask(key, input, {
        onText: (t) => draft.update(t),
        onTool: (name, detail) => draft.tool(name, detail),
      });
      void this.brain.whenRegistered(key).then(handed, handed);
      result = await running;
    } catch (e) {
      clearInterval(typing);
      await draft.finish(`Carl could not run that: ${(e as Error).message}`);
      return;
    }
    clearInterval(typing);
    if (result.aborted && this.abort.signal.aborted) return; // shutting down: the restart notice covers it
    if (result.steered) {
      await this.api.call("setMessageReaction", { chat_id: chatId, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👀" }] }, { retries: 0 }).catch(() => {});
      return;
    }
    let final = result.text;
    if (result.aborted) final = final ? `${final}\n\n_(stopped)_` : "Stopped.";
    else if (!result.ok) final = `${final ? final + "\n\n" : ""}Run failed: ${result.error}`;
    else if (!final) final = result.toolCalls ? "Done." : "(no reply)";
    const benched = [...this.brain.routerState.entries()].find(([ref, until]) => ref === this.cfg.model && until > Date.now());
    if (benched && result.ok && result.model !== this.cfg.model) {
      final += `\n\n_(${result.model.split("/").pop()} answered: ${this.cfg.model.split("/").pop()} is at its usage limit until ${new Date(benched[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})_`;
    }
    await this.deliverFinal(draft, chatId, threadId, final);
  }

  // ---- Durable delivery: explicit refusals may retry; unknown outcomes are held for reconciliation. ----

  private readonly outboxFile = () => join(this.cfg.home, "state", "outbox.json");
  private outboxTimer?: NodeJS.Timeout;

  private async deliverFinal(draft: Draft, chatId: number, threadId: number | undefined, markdown: string): Promise<void> {
    try {
      await draft.finish(markdown);
    } catch (e) {
      // Only what did not go out is queued: chunks Telegram already took are not sent twice.
      const unknown = unknownSend(e);
      this.log.error(unknown ? "reply outcome unknown; held for reconciliation" : "reply delivery failed; queued for retry", { chatId, error: (e as Error).message, chunksSent: draft.chunksSent });
      this.enqueue(chatId, chunkMarkdown(markdown).slice(draft.chunksSent), threadId, e, draft.pendingEditId);
    }
  }

  private outbox?: OutboxItem[];
  private flushing?: Promise<void>;

  private loadOutbox(): OutboxItem[] {
    if (!this.outbox) {
      try { this.outbox = JSON.parse(readFileSync(this.outboxFile(), "utf8")); } catch { this.outbox = []; }
      if (!Array.isArray(this.outbox)) this.outbox = [];
    }
    return this.outbox!;
  }

  private saveOutbox(): boolean {
    const file = this.outboxFile();
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(this.loadOutbox()), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      return true;
    } catch (e) {
      this.log.error("cannot persist the outbox", { error: (e as Error).message });
      return false;
    }
  }

  /** Queue Markdown chunks for delivery; used for failed replies and failed scheduled deliveries. */
  enqueue(chatId: number, chunks: string[], threadId?: number, error?: unknown, editMessageId?: number): void {
    if (!chunks.length) return;
    const unknown = unknownSend(error);
    const lastError = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
    const item: OutboxItem = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, chatId, threadId, chunks, firstAt: Date.now(), attempts: 1, lastError, status: unknown ? "unknown" : undefined, requestId: unknown && error instanceof TelegramError ? error.requestId : undefined, editMessageId };
    this.loadOutbox().push(item);
    this.saveOutbox();
    if (unknown) void this.noticeHeld(item);
    else this.scheduleOutbox();
  }

  /** Persist the attempt before sending: even a notice with a lost response is not replayed after a restart. */
  private async noticeHeld(item: OutboxItem): Promise<void> {
    if (item.unknownNoticeAttempted) return;
    item.unknownNoticeAttempted = true;
    if (!this.saveOutbox()) { item.unknownNoticeAttempted = undefined; return; }
    await this.api.sendMessage(item.chatId, `A reply's delivery is unknown. I will not resend it automatically. Check the chat first: resending could duplicate it.\nHeld reply: ${item.id}\n/outbox resend ${item.id}\n/outbox discard ${item.id}`, { threadId: item.threadId })
      .catch((e) => this.log.warn("cannot announce a held reply; visible in /status and /outbox", { chatId: item.chatId, error: (e as Error).message }));
  }

  private heldReplies(chatId: number, threadId?: number): OutboxItem[] {
    return this.loadOutbox().filter((item) => item.status === "unknown" && item.chatId === chatId && item.threadId === threadId);
  }

  private scheduleOutbox(): void {
    if (this.outboxTimer || this.abort.signal.aborted) return;
    this.outboxTimer = setTimeout(() => { this.outboxTimer = undefined; void this.flushOutbox(); }, 30_000);
    this.outboxTimer.unref();
  }

  /** Single-flight: concurrent callers share one pass, so nothing is sent twice. */
  flushOutbox(): Promise<void> {
    this.flushing ??= this.flushPass().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushPass(): Promise<void> {
    const queue = this.loadOutbox();
    for (const item of [...queue]) {
      if (item.status === "unknown") { await this.noticeHeld(item); continue; } // an ambiguous receipt must be reconciled before replay, even after restart
      if (Date.now() - item.firstAt > 24 * 3_600_000) {
        this.log.error("undeliverable reply dropped after 24 h", { chatId: item.chatId, attempts: item.attempts, error: item.lastError });
        queue.splice(queue.indexOf(item), 1);
        continue;
      }
      try {
        while (item.chunks.length) {
          if (item.editMessageId !== undefined) {
            const html = markdownToTelegramHtml(item.chunks[0]);
            try { await this.api.editMessageText(item.chatId, item.editMessageId, html, { parseMode: "HTML" }); }
            catch (e) {
              if (e instanceof TelegramError && e.status === "failed" && /not modified/i.test(e.description)) { /* already applied */ }
              else if (e instanceof TelegramError && e.status === "failed" && e.code === 400) await this.api.editMessageText(item.chatId, item.editMessageId, htmlToPlain(html).slice(0, 4096));
              else throw e;
            }
            item.editMessageId = undefined;
          } else await this.sendMarkdown(item.chatId, item.chunks[0], { threadId: item.threadId });
          item.chunks.shift(); // persisted below, so a crash resends at most this one chunk
          this.saveOutbox();
        }
        queue.splice(queue.indexOf(item), 1);
        this.log.info("queued reply delivered", { chatId: item.chatId, attempts: item.attempts + 1 });
      } catch (e) {
        item.attempts++;
        item.lastError = (e as Error).message;
        if (unknownSend(e) && e instanceof TelegramError) {
          item.status = "unknown";
          item.requestId = e.requestId;
          this.log.error("queued reply outcome unknown; held for reconciliation", { chatId: item.chatId, requestId: e.requestId });
          this.saveOutbox();
          await this.noticeHeld(item);
        }
      }
    }
    this.saveOutbox();
    if (queue.some((item) => item.status !== "unknown")) this.scheduleOutbox();
  }

  private async command(name: string, args: string, m: TgMessage, key: string): Promise<boolean> {
    const reply = (t: string) => this.sendMarkdown(m.chat.id, t, { replyTo: m.message_id, threadId: m.message_thread_id });
    switch (name) {
      case "start":
      case "help": {
        const extra = [...this.commands.entries()].map(([c, v]) => `/${c} ${v.help}`).join("\n");
        await reply(`${this.cfg.name} is listening.\n/new fresh conversation\n/stop stop the run\n/status state\n/outbox [resend|discard] <id>\n/model [provider/model]\n/compact\n/mirror <decision or dilemma>${extra ? "\n" + extra : ""}`);
        return true;
      }
      case "new":
      case "reset":
        await this.brain.reset(key);
        await reply("Fresh conversation.");
        return true;
      case "stop":
        await reply((await this.brain.stop(key)) ? "Stopping." : "Nothing is running.");
        return true;
      case "status": {
        const s = await this.brain.status(key);
        const held = this.heldReplies(m.chat.id, m.message_thread_id);
        await reply("```\n" + JSON.stringify(s, null, 1).slice(0, 3_000) + "\n```\n" + `${held.length} replies with unknown delivery${held.length ? `: ${held.slice(0, 10).map((item) => item.id).join(", ")}\n/outbox lists all; check the chat before resend/discard.` : "."}`);
        return true;
      }
      case "outbox": {
        const [action, id, ...extra] = args.split(/\s+/);
        if (!args || action === "list") {
          const held = this.heldReplies(m.chat.id, m.message_thread_id);
          await reply(held.length ? `Replies with unknown delivery (resending may duplicate):\n${held.map((item) => `${item.id}: /outbox resend ${item.id} or /outbox discard ${item.id}`).join("\n")}` : "No replies with unknown delivery in this chat/topic.");
          return true;
        }
        if (!["resend", "discard"].includes(action) || !id || extra.length) {
          await reply("Use /outbox, /outbox resend <id>, or /outbox discard <id>. Check the chat first: resending may duplicate a delivered reply.");
          return true;
        }
        // Wait for a current pass before authorizing replay; commands cannot race a send already in flight.
        await this.flushing;
        const item = this.heldReplies(m.chat.id, m.message_thread_id).find((entry) => entry.id === id);
        if (!item) { await reply("No held reply with that ID in this chat/topic."); return true; }
        if (action === "discard") {
          this.loadOutbox().splice(this.loadOutbox().indexOf(item), 1);
          this.saveOutbox();
          await reply(`Discarded held reply ${id}; nothing was resent.`);
        } else {
          item.status = undefined;
          item.unknownNoticeAttempted = undefined;
          item.firstAt = Date.now(); // explicit replay gets a fresh bounded retry window, even after a long hold
          item.attempts = 0;
          this.saveOutbox(); // explicit authorization survives restart before the retry
          await this.flushOutbox();
          await reply(item.status === "unknown" ? `Reply ${id} is held again: delivery is unknown.` : this.loadOutbox().includes(item) ? `Reply ${id} is queued for retry.` : item.chunks.length ? `Reply ${id} was dropped as undeliverable; it was not resent.` : `Resent held reply ${id}.`);
        }
        return true;
      }
      case "model":
        if (!args) {
          const s = await this.brain.status(key);
          await reply(`Model: ${s.model ?? this.cfg.model}\nSwitch: /model provider/model`);
        } else {
          await reply(await this.brain.setModel(key, args).catch((e) => `Not switched: ${(e as Error).message}`));
        }
        return true;
      case "compact":
        await reply(await this.brain.compact(key));
        return true;
      case "mirror":
        if (!args) {
          await reply("Tell me the decision or dilemma: /mirror <text>");
          return true;
        }
        await this.converse(m, key, { text: args, preface: MIRROR_INSTRUCTION, source: "telegram" });
        return true;
    }
    const extra = this.commands.get(name);
    if (extra) {
      await reply(await extra.run(args, m.chat.id, key).catch((e) => `/${name} failed: ${(e as Error).message}`));
      return true;
    }
    return false; // unknown /command: treat as ordinary text for the agent
  }

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    if (!this.allowed(q.from.id)) {
      await this.api.answerCallbackQuery(q.id, "Not allowed").catch(() => {});
      return;
    }
    const data = q.data ?? "";
    const prefix = data.split(":")[0];
    const handler = this.callbacks.get(prefix);
    if (!handler) {
      await this.api.answerCallbackQuery(q.id, "This button is no longer handled").catch(() => {});
      return;
    }
    const note = await handler(q, data).catch((e) => `Failed: ${(e as Error).message}`);
    await this.api.answerCallbackQuery(q.id, typeof note === "string" ? note.slice(0, 190) : undefined).catch(() => {});
  }

  /** A fresh, unguessable name in the media folder (the agent can write there, so names are never reused). */
  private mediaPath(m: TgMessage, suffix: string): string {
    return join(this.cfg.home, "media", `${m.chat.id}-${m.message_id}-${randomBytes(4).toString("hex")}${suffix}`);
  }

  private transcribe(path: string): Promise<string> {
    const cmd = this.cfg.stt;
    if (!cmd?.length) return Promise.resolve("");
    // "{file}" is the audio; "{output}" (optional) is a file the command writes the transcript to, else stdout.
    const outFile = `${path}.txt`;
    const args = cmd.map((a) => a.replace("{file}", path).replace("{output}", outFile));
    if (!cmd.some((a) => a.includes("{file}"))) args.push(path);
    const usesOutput = cmd.some((a) => a.includes("{output}"));
    // Speech-to-text runs inside the shell sandbox: the agent can change its scripts or models, so it gets no more power.
    const argv = sandboxArgv(this.brain.shellSandbox, args);
    return new Promise((resolve) => {
      // UltraTerm's ultrabot-stt keeps its lock in ~/.ultraterm, which the sandbox closes: it gets one in Carl's temp.
      const env = { ...cleanEnv(this.cfg), ...(this.cfg.ultraterm ? { ULTRABOT_STT_LOCK: join(this.cfg.home, "spill", "tmp", "ultrabot-stt.lock") } : {}) };
      const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env });
      let out = "";
      let err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
      child.on("error", (e) => { clearTimeout(timer); this.log.error("speech-to-text failed to start", { error: e.message }); resolve(""); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) this.log.error("speech-to-text failed", { code, stderr: err.slice(-300) });
        if (code !== 0) return resolve("");
        if (usesOutput) {
          try { return resolve(readNoFollow(outFile).trim()); } catch (e) { this.log.error("speech-to-text wrote no transcript", { error: (e as Error).message }); return resolve(""); }
        }
        resolve(out.trim());
      });
    });
  }

  private readonly approvals = new Map<string, (answer: "approved" | "denied") => void>();

  /** Ask the operator to approve a dangerous command with buttons. Fails closed after 5 minutes. */
  async requestApproval(chatId: number, command: string, reason: string): Promise<"approved" | "denied" | "timeout"> {
    const id = Math.random().toString(36).slice(2, 10);
    if (!this.callbacks.has("ca")) {
      this.callbacks.set("ca", async (q, data) => {
        const [, reqId, choice] = data.split(":");
        const resolve = this.approvals.get(reqId);
        if (!resolve) return "This approval has expired.";
        resolve(choice === "yes" ? "approved" : "denied");
        return choice === "yes" ? "Approved" : "Denied";
      });
    }
    // Shown exactly, escaped, with invisible and direction-changing characters made visible; never truncated:
    // a command too long to read in chat is not approvable in chat.
    const visible = visibleControls(command);
    // One plain sentence first; the exact call follows in a collapsed quote, still complete and never truncated.
    const html = `<b>Approve?</b> ${escapeHtml(approvalSummary(command, reason))}\n<blockquote expandable><pre>${escapeHtml(visible)}</pre></blockquote>`;
    if (html.length > 4_000) {
      await this.api.sendMessage(chatId, `Refused without asking: a ${reason} request of ${command.length} characters is too long to review here.`).catch(() => {});
      return "denied";
    }
    const msg = await this.api.sendMessage(chatId, html, { parseMode: "HTML", buttons: [[{ text: "Run once", callback_data: `ca:${id}:yes` }, { text: "Deny", callback_data: `ca:${id}:no` }]] });
    const answer = await new Promise<"approved" | "denied" | "timeout">((resolve) => {
      const timer = setTimeout(() => { this.approvals.delete(id); resolve("timeout"); }, 300_000);
      this.approvals.set(id, (a) => { clearTimeout(timer); this.approvals.delete(id); resolve(a); });
    });
    const mark = answer === "approved" ? "✅ approved" : answer === "denied" ? "⛔ denied" : "⌛ expired (not run)";
    await this.api.call("editMessageReplyMarkup", { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }, { retries: 0 }).catch(() => {});
    await this.api.sendMessage(chatId, mark, { replyTo: msg.message_id, silent: true }).catch(() => {});
    return answer;
  }

  /** Send Markdown as Telegram HTML, chunked; falls back to plain text when Telegram rejects the HTML. */
  async sendMarkdown(chatId: number, md: string, o: { replyTo?: number; threadId?: number; buttons?: InlineButton[][]; silent?: boolean } = {}): Promise<TgMessage[]> {
    const sent: TgMessage[] = [];
    const chunks = chunkMarkdown(md);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const html = markdownToTelegramHtml(chunks[i]);
      const opts = { replyTo: i === 0 ? o.replyTo : undefined, threadId: o.threadId, buttons: last ? o.buttons : undefined, silent: o.silent };
      try {
        sent.push(await this.api.sendMessage(chatId, html, { ...opts, parseMode: "HTML" }));
      } catch (e) {
        if (!(e instanceof TelegramError) || e.code !== 400 || e.status !== "failed") throw e;
        sent.push(await this.api.sendMessage(chatId, htmlToPlain(html).slice(0, 4096), opts));
      }
    }
    return sent;
  }
}

/** One message that shows the reply as it streams, then becomes (the first chunk of) the final reply. */
class Draft {
  private messageId?: number;
  private shown = "";
  private pending = "";
  private toolLine = "";
  private lastEdit = 0;
  private timer?: NodeJS.Timeout;
  private readonly started = Date.now();
  private chain: Promise<unknown> = Promise.resolve();
  private finished = false;
  private unknownError?: TelegramError;
  /** Final-reply chunks Telegram accepted (for partial-failure recovery). */
  chunksSent = 0;
  /** If an idempotent final edit needs a durable retry, preserve its own-draft target instead of creating a copy. */
  pendingEditId?: number;

  private readonly api: TelegramApi;
  private readonly chatId: number;
  private readonly replyTo: number;
  private readonly threadId: number | undefined;
  private readonly stream: boolean;
  constructor(api: TelegramApi, chatId: number, replyTo: number, threadId: number | undefined, stream: boolean) {
    this.api = api;
    this.chatId = chatId;
    this.replyTo = replyTo;
    this.threadId = threadId;
    this.stream = stream;
  }

  update(text: string): void {
    this.pending = text;
    this.toolLine = "";
    this.schedule();
  }

  tool(name: string, detail: string): void {
    this.toolLine = `⚙ ${name}${detail ? ": " + detail : ""}`;
    this.schedule();
  }

  private render(): string {
    const body = this.pending.length > 3_500 ? "…" + this.pending.slice(-3_500) : this.pending;
    return [body, this.toolLine].filter(Boolean).join("\n\n");
  }

  private schedule(): void {
    if (!this.stream || this.finished || this.timer) return;
    const since = Date.now() - this.started;
    const wait = Math.max(since < FIRST_DRAFT_MS ? FIRST_DRAFT_MS - since : 0, EDIT_INTERVAL_MS - (Date.now() - this.lastEdit), 0);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.chain = this.chain.then(() => this.flush()).catch((e) => {
        if (unknownSend(e) && e instanceof TelegramError) this.unknownError = e;
      });
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.unknownError) throw this.unknownError;
    if (this.finished) return;
    const text = this.render();
    if (!text.trim() || text === this.shown) return;
    this.lastEdit = Date.now();
    // Drafts are plain text: half-written Markdown would fail Telegram's HTML parser mid-stream.
    if (this.messageId === undefined) {
      const m = await this.api.sendMessage(this.chatId, text, { replyTo: this.replyTo, threadId: this.threadId, silent: true });
      this.messageId = m.message_id;
    } else {
      await this.api.editMessageText(this.chatId, this.messageId, text).catch((e) => {
        if (!(e instanceof TelegramError && e.status === "failed" && /not modified/i.test(e.description))) throw e;
      });
    }
    this.shown = text;
  }

  async finish(markdown: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.chain.catch(() => {});
    this.finished = true;
    if (this.unknownError) throw this.unknownError;
    // Telegram does not notify on edits. After a long run, replace the silent draft so the reply pings.
    if (this.messageId !== undefined && Date.now() - this.started > 15_000) {
      await this.api.deleteMessage(this.chatId, this.messageId).catch(() => {}); // best-effort own-draft cleanup, not an unknown final send
      this.messageId = undefined;
    }
    const chunks = chunkMarkdown(markdown);
    for (let i = 0; i < chunks.length; i++) {
      const html = markdownToTelegramHtml(chunks[i]);
      const editable = i === 0 && this.messageId !== undefined;
      this.pendingEditId = editable ? this.messageId : undefined;
      const send = async (text: string, parseMode?: "HTML") => {
        if (!editable) return this.api.sendMessage(this.chatId, text, { parseMode, replyTo: i === 0 ? this.replyTo : undefined, threadId: this.threadId });
        try { return await this.api.editMessageText(this.chatId, this.messageId!, text, { parseMode }); }
        catch (e) {
          if (!(e instanceof TelegramError) || e.status !== "unknown") throw e;
          // One bounded retry is safe only for the same text on our own known draft ID.
          return this.api.editMessageText(this.chatId, this.messageId!, text, { parseMode });
        }
      };
      try {
        await send(html, "HTML");
      } catch (e) {
        if (e instanceof TelegramError && e.status === "failed" && /not modified/i.test(e.description)) { this.pendingEditId = undefined; this.chunksSent++; continue; }
        if (!(e instanceof TelegramError) || e.code !== 400 || e.status !== "failed") throw e;
        await send(htmlToPlain(html).slice(0, 4096));
      }
      this.pendingEditId = undefined;
      this.chunksSent++;
    }
  }
}
