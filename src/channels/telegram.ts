// Telegram channel: long polling, allowlist, media in, commands, and replies that are answers by default.
// A reply is one final message. Streaming (one draft message edited as the answer grows, with the tool line inside
// it) is opt-in: telegram.stream must be true. Approval cards and a long answer split by Telegram's size limit are
// separate messages either way.
import { approvalSummary } from "../approval-text.ts";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cleanEnv, readNoFollow, sandboxArgv } from "../sandbox.ts";
import { type Brain, type ResumeOutcome, type RunResult } from "../brain.ts";
import { DeliveryLedger, deliveryId } from "../durable.ts";
import type { CarlConfig } from "../config.ts";
import type { Log } from "../log.ts";
import { recordDeliveries } from "../message-log.ts";
import { MIRROR_INSTRUCTION } from "../psyche.ts";
import { chunkMarkdown, escapeHtml, htmlToPlain, markdownToTelegramHtml, visibleControls } from "./format.ts";
import { type InlineButton, TelegramApi, TelegramError, type TgCallbackQuery, type TgMessage } from "./telegram-api.ts";

interface OutboxItem { id: string; chatId: number; threadId?: number; chunks: string[]; firstAt: number; attempts: number; lastError?: string; /** The delivery id the chunks belong to, so a retry after a crash never sends one twice. */ baseId?: string; /** How many chunks of this reply already went out. */ sentCount?: number }

export type CommandHandler = (args: string, chatId: number, key: string) => Promise<string>;

export interface ChannelStatus {
  state: "connecting" | "connected" | "retrying" | "stopped" | "fatal";
  error?: string;
  updatedAt: string;
  lastUpdateAt?: string;
}

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
  /** What was already delivered, so a restart never sends the same reply twice. */
  private readonly ledger: DeliveryLedger;
  constructor(cfg: CarlConfig, token: string, brain: Brain, log: Log, ledger?: DeliveryLedger) {
    this.cfg = cfg;
    this.brain = brain;
    this.log = log;
    this.ledger = ledger ?? new DeliveryLedger(cfg.home);
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
        if (err instanceof TelegramError && err.code === 409) {
          this.setStatus("retrying", "another process is polling this bot token (409 conflict)");
        } else {
          this.setStatus("retrying", err.message);
        }
        failures++;
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
  /** The turn a message picked up again after a restart belongs to, so its reply keeps the same delivery id. */
  private readonly resumedTurns = new Map<string, number>();

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
      // A plain text message in a DM can be picked up again: a turn that ran no tool is simply run again, and a turn
      // whose tool already ran is continued from the transcript. Anything else (a voice note, a file, a group) is
      // reported instead.
      const messageId = Number(id.split(":")[1]);
      const textOnly = e.text.length < 500 && e.text !== "(voice note)" && e.text !== "(attachment)";
      const key = `telegram:dm:${e.chatId}`;
      // At most once: a message that was already picked up after one restart is reported after the next.
      if (!e.resumed && e.chatId > 0 && textOnly && Number.isInteger(messageId)) {
        // The draft shows the answer while the resumed turn runs; it is only created when there is something to show.
        let draft: Draft | undefined;
        const newDraft = (): Draft => (draft ??= new Draft(this.api, e.chatId, messageId, e.threadId, this.cfg.telegram.stream));
        const outcome = await this.brain.resumeTurn(key, e.text, {
          sink: {
            onText: (t) => newDraft().update(t),
            onTool: (n, d) => newDraft().tool(n, d),
          },
          onPlan: async (plan) => {
            const uncertain = plan.pending.map((c) => c.name);
            const what = uncertain.length
              ? `\n\nThe ${uncertain.map((n) => `\`${n}\``).join(" and ")} call may or may not have taken effect; I did not run it again.`
              : "";
            await this.sendNotice(e.chatId, key, messageId, plan.turn, e.threadId, `I restarted while working on this, so I am picking it up again from where it stopped:\n\n> ${excerpt.replace(/\n/g, " ")}${what}`);
          },
        }).catch((err) => ({ status: "not-resumable" as const, reason: (err as Error).message }));
        if (outcome.status === "restart") {
          // Nothing had run yet: the turn is picked up again from the start and nothing can be repeated.
          this.log.info("resuming a message interrupted by a restart", { chat: e.chatId, message: messageId });
          await this.sendNotice(e.chatId, key, messageId, outcome.turn ?? 0, e.threadId, `I restarted while answering this, so I am picking it up again:\n\n> ${excerpt.replace(/\n/g, " ")}`);
          this.markInflight(id);
          this.resumedTurns.set(id, outcome.turn ?? 0);
          this.enqueueMessage({ message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: e.chatId, type: "private" }, from: { id: e.chatId, is_bot: false, first_name: "" }, text: e.text } as TgMessage);
          this.markInflight(id, { chatId: e.chatId, threadId: e.threadId, text: e.text, resumed: true });
          continue;
        }
        if (outcome.status === "resumed" || outcome.status === "answered") {
          await this.deliverResumed(key, messageId, outcome, e, draft);
          this.markInflight(id);
          continue;
        }
        if (outcome.status === "failed") {
          this.log.warn("a resumed turn did not finish", { chat: e.chatId, message: messageId, error: outcome.reason });
        }
      }
      await this.sendNotice(e.chatId, key, messageId, 0, e.threadId, `I restarted while working on this, so it did not finish:\n\n> ${excerpt.replace(/\n/g, " ")}\n\nSend it again if it still matters.`);
      this.markInflight(id);
    }
  }

  /**
   * Deliver the answer of a turn that a restart cut short. The answer goes out once: its delivery id is the one the
   * interrupted turn would have used, so an answer that already reached the operator is never sent again.
   */
  private async deliverResumed(
    key: string,
    messageId: number,
    outcome: ResumeOutcome,
    e: { chatId: number; threadId?: number; text: string },
    draft: Draft | undefined,
  ): Promise<void> {
    const turn = outcome.turn ?? 0;
    const answer = outcome.text?.trim();
    if (!answer) {
      // The turn owes an answer but the model gave none: say so instead of pretending it worked.
      await this.sendNotice(e.chatId, key, messageId, turn, e.threadId, "I restarted while working on this and picked the turn up again, but it did not produce an answer.");
      return;
    }
    const id = deliveryId(key, messageId, turn);
    const state = this.ledger.begin(id, { chatId: e.chatId, preview: answer });
    if (state !== "new") {
      this.log.info(state === "sent" ? "the answer was already delivered; not sending it again" : "the answer delivery was never confirmed; not sending it again", { id });
      await this.sendNotice(e.chatId, key, messageId, turn, e.threadId, "I restarted while working on this; the answer had already gone out before the restart.");
      return;
    }
    try {
      if (draft) await draft.finish(answer);
      else await this.sendMarkdown(e.chatId, answer, { threadId: e.threadId });
      this.ledger.sent(id);
    } catch (err) {
      this.ledger.drop(id);
      this.log.error("reply delivery failed; queued for retry", { chatId: e.chatId, error: (err as Error).message });
      this.enqueue(e.chatId, [answer], e.threadId, (err as Error).message, id);
    }
  }

  /** Tell the operator what happened to an interrupted message. The notice goes out once, like every reply. */
  private async sendNotice(chatId: number, key: string, messageId: number, turn: number, threadId: number | undefined, text: string): Promise<void> {
    const id = deliveryId(key, messageId, turn, "notice");
    const state = this.ledger.begin(id, { chatId, preview: text });
    if (state !== "new") return;
    try {
      await this.sendMarkdown(chatId, text, { threadId });
      this.ledger.sent(id);
    } catch (e) {
      this.ledger.drop(id);
      this.log.warn("cannot announce an interrupted message", { error: (e as Error).message });
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
    // A request Carl already carried out is not carried out again: the operator is told what happened instead.
    const done = await this.brain.recentDuplicate(key, body).catch(() => undefined);
    if (done) {
      this.log.info("not repeating a request that was already carried out", { key });
      await this.sendReply(m.chat.id, m, key, `I already did that a moment ago, so I did not do it again:\n\n${done.text}`.trim());
      return handed();
    }
    // A message picked up again after a restart keeps the turn it continues, so its reply has the same delivery id.
    const turn = this.resumedTurns.get(`${m.chat.id}:${m.message_id}`);
    this.resumedTurns.delete(`${m.chat.id}:${m.message_id}`);
    await this.converse(m, key, { text: body || "(image)", images: images.length ? images : undefined, source: "telegram", turn }, handed);
  }

  /** A short reply that goes out once, like every other reply. */
  private async sendReply(chatId: number, m: TgMessage, key: string, text: string): Promise<void> {
    const id = deliveryId(key, m.message_id, this.brain.currentTurn(key) + 1);
    const state = this.ledger.begin(id, { chatId, preview: text });
    if (state !== "new") return;
    try {
      await this.sendMarkdown(chatId, text, { threadId: m.message_thread_id });
      this.ledger.sent(id);
    } catch (e) {
      this.ledger.drop(id);
      this.log.error("reply delivery failed; queued for retry", { chatId, error: (e as Error).message });
      this.enqueue(chatId, [text], m.message_thread_id, (e as Error).message, id);
    }
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
    await this.deliverFinal(draft, chatId, threadId, final, deliveryId(key, m.message_id, result.turn ?? 0));
  }

  // ---- Durable delivery: a final reply that fails to send is kept and retried until Telegram takes it. ----

  private readonly outboxFile = () => join(this.cfg.home, "state", "outbox.json");
  private outboxTimer?: NodeJS.Timeout;

  private async deliverFinal(draft: Draft, chatId: number, threadId: number | undefined, markdown: string, id?: string): Promise<void> {
    // The delivery id is claimed before the send: a crash between the send and the record cannot send it twice.
    if (id) {
      const state = this.ledger.begin(id, { chatId, preview: markdown });
      if (state !== "new") {
        this.log.info(state === "sent" ? "the reply was already delivered; not sending it again" : "the reply delivery was never confirmed; not sending it again", { id });
        return;
      }
    }
    try {
      await draft.finish(markdown);
      if (id) this.ledger.sent(id);
    } catch (e) {
      if (id) this.ledger.drop(id);
      // Only what did not go out is queued: chunks Telegram already took are not sent twice.
      this.log.error("reply delivery failed; queued for retry", { chatId, error: (e as Error).message, chunksSent: draft.chunksSent });
      this.enqueue(chatId, chunkMarkdown(markdown).slice(draft.chunksSent), threadId, (e as Error).message, id);
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

  private saveOutbox(): void {
    const file = this.outboxFile();
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(this.loadOutbox()), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      this.log.error("cannot persist the outbox", { error: (e as Error).message });
    }
  }

  /** Queue Markdown chunks for delivery; used for failed replies and failed scheduled deliveries. */
  enqueue(chatId: number, chunks: string[], threadId?: number, lastError?: string, baseId?: string): void {
    if (!chunks.length) return;
    this.loadOutbox().push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, chatId, threadId, chunks, firstAt: Date.now(), attempts: 1, lastError, baseId, sentCount: 0 });
    this.saveOutbox();
    this.scheduleOutbox();
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
      if (Date.now() - item.firstAt > 24 * 3_600_000) {
        this.log.error("undeliverable reply dropped after 24 h", { chatId: item.chatId, attempts: item.attempts, error: item.lastError });
        queue.splice(queue.indexOf(item), 1);
        continue;
      }
      try {
        while (item.chunks.length) {
          // Every chunk has its own delivery id: a crash between the send and the persist cannot resend it.
          const chunkId = item.baseId ? `${item.baseId}#${item.sentCount ?? 0}` : undefined;
          if (chunkId) {
            const state = this.ledger.begin(chunkId, { chatId: item.chatId, preview: item.chunks[0] });
            if (state !== "new") {
              item.chunks.shift();
              item.sentCount = (item.sentCount ?? 0) + 1;
              this.saveOutbox();
              continue;
            }
          }
          try {
            await this.sendMarkdown(item.chatId, item.chunks[0], { threadId: item.threadId });
          } catch (e) {
            if (chunkId) this.ledger.drop(chunkId);
            throw e;
          }
          if (chunkId) this.ledger.sent(chunkId);
          item.chunks.shift(); // persisted below, so a crash resends at most this one chunk
          item.sentCount = (item.sentCount ?? 0) + 1;
          this.saveOutbox();
        }
        queue.splice(queue.indexOf(item), 1);
        this.log.info("queued reply delivered", { chatId: item.chatId, attempts: item.attempts + 1 });
      } catch (e) {
        item.attempts++;
        item.lastError = (e as Error).message;
      }
    }
    this.saveOutbox();
    if (queue.length) this.scheduleOutbox();
  }

  private async command(name: string, args: string, m: TgMessage, key: string): Promise<boolean> {
    const reply = (t: string) => this.sendMarkdown(m.chat.id, t, { replyTo: m.message_id, threadId: m.message_thread_id });
    switch (name) {
      case "start":
      case "help": {
        const extra = [...this.commands.entries()].map(([c, v]) => `/${c} ${v.help}`).join("\n");
        await reply(`${this.cfg.name} is listening.\n/new fresh conversation\n/stop stop the run\n/status state\n/model [provider/model]\n/compact\n/mirror <decision or dilemma>${extra ? "\n" + extra : ""}`);
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
        await reply("```\n" + JSON.stringify(s, null, 1).slice(0, 3_500) + "\n```");
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
  /** The question each card id is waiting for, so the same card is never asked about twice. */
  private readonly approvalPromises = new Map<string, Promise<"approved" | "denied" | "timeout">>();

  /**
   * Ask the operator to approve a dangerous command with buttons. Fails closed after 5 minutes.
   * With a stable id the card goes out once: a proposal that is asked about again (after a restart, say) keeps the
   * card that is already in the chat instead of putting a second one there.
   */
  async requestApproval(chatId: number, command: string, reason: string, stable?: string): Promise<"approved" | "denied" | "timeout"> {
    // The callback data of a card is short (Telegram allows 64 bytes), so a stable id is hashed into it.
    const id = stable ? createHash("sha256").update(stable).digest("hex").slice(0, 12) : Math.random().toString(36).slice(2, 10);
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
    let msg: TgMessage | undefined;
    if (stable) {
      const state = this.ledger.begin(stable, { chatId, preview: command });
      if (state === "new") {
        msg = await this.api.sendMessage(chatId, html, { parseMode: "HTML", buttons: [[{ text: "Run once", callback_data: `ca:${id}:yes` }, { text: "Deny", callback_data: `ca:${id}:no` }]] });
        this.ledger.sent(stable, [msg.message_id]);
      } else {
        // The card is already in the chat (P-1416): the operator answers that one, no second card goes out.
        this.log.info("the approval card is already in the chat; not sending a second one", { id: stable });
      }
    } else {
      msg = await this.api.sendMessage(chatId, html, { parseMode: "HTML", buttons: [[{ text: "Run once", callback_data: `ca:${id}:yes` }, { text: "Deny", callback_data: `ca:${id}:no` }]] });
    }
    const answer = await this.waitForApproval(id);
    if (stable) this.ledger.resolve(stable);
    const mark = answer === "approved" ? "✅ approved" : answer === "denied" ? "⛔ denied" : "⌛ expired (not run)";
    if (msg) await this.api.call("editMessageReplyMarkup", { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } }, { retries: 0 }).catch(() => {});
    await this.api.sendMessage(chatId, mark, { replyTo: msg?.message_id, silent: true }).catch(() => {});
    return answer;
  }

  /** Wait for the operator's answer on a card. The same card id is always the same question. */
  private waitForApproval(id: string): Promise<"approved" | "denied" | "timeout"> {
    const existing = this.approvalPromises.get(id);
    if (existing) return existing;
    const promise = new Promise<"approved" | "denied" | "timeout">((resolve) => {
      const timer = setTimeout(() => { this.approvals.delete(id); this.approvalPromises.delete(id); resolve("timeout"); }, 300_000);
      this.approvals.set(id, (a) => { clearTimeout(timer); this.approvals.delete(id); this.approvalPromises.delete(id); resolve(a); });
    });
    this.approvalPromises.set(id, promise);
    return promise;
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
        if (!(e instanceof TelegramError) || e.code !== 400) throw e;
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
  /** Final-reply chunks Telegram accepted (for partial-failure recovery). */
  chunksSent = 0;

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
      this.chain = this.chain.then(() => this.flush()).catch(() => {});
    }, wait);
  }

  private async flush(): Promise<void> {
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
        if (!(e instanceof TelegramError && /not modified/i.test(e.description))) throw e;
      });
    }
    this.shown = text;
  }

  async finish(markdown: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.chain.catch(() => {});
    this.finished = true;
    // Telegram does not notify on edits. After a long run, replace the silent draft so the reply pings.
    if (this.messageId !== undefined && Date.now() - this.started > 15_000) {
      await this.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
      this.messageId = undefined;
    }
    const chunks = chunkMarkdown(markdown);
    for (let i = 0; i < chunks.length; i++) {
      const html = markdownToTelegramHtml(chunks[i]);
      const editable = i === 0 && this.messageId !== undefined;
      const send = async (text: string, parseMode?: "HTML") =>
        editable
          ? this.api.editMessageText(this.chatId, this.messageId!, text, { parseMode })
          : this.api.sendMessage(this.chatId, text, { parseMode, replyTo: i === 0 ? this.replyTo : undefined, threadId: this.threadId });
      try {
        await send(html, "HTML");
      } catch (e) {
        if (e instanceof TelegramError && /not modified/i.test(e.description)) { this.chunksSent++; continue; }
        if (!(e instanceof TelegramError) || e.code !== 400) throw e;
        await send(htmlToPlain(html).slice(0, 4096));
      }
      this.chunksSent++;
    }
  }
}
