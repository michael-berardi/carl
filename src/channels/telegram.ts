// Telegram channel: long polling, allowlist, streamed replies by editing one draft message, media in, commands.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Brain, RunResult } from "../brain.ts";
import type { CarlConfig } from "../config.ts";
import type { Log } from "../log.ts";
import { MIRROR_INSTRUCTION } from "../psyche.ts";
import { chunkMarkdown, htmlToPlain, markdownToTelegramHtml } from "./format.ts";
import { type InlineButton, TelegramApi, TelegramError, type TgCallbackQuery, type TgMessage } from "./telegram-api.ts";

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
  constructor(cfg: CarlConfig, token: string, brain: Brain, log: Log) {
    this.cfg = cfg;
    this.brain = brain;
    this.log = log;
    this.api = new TelegramApi(token, cfg.telegram.apiBase);
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
  }

  async stop(): Promise<void> {
    this.abort.abort();
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
          if (u.message) void this.onMessage(u.message).catch((e) => this.log.error("message handler failed", { error: (e as Error).stack }));
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

  private async onMessage(m: TgMessage): Promise<void> {
    if (!this.allowed(m.from?.id)) {
      this.log.warn("ignored message from a user not in telegram.allowFrom", { userId: m.from?.id, chat: m.chat.type });
      return;
    }
    const key = TelegramChannel.conversationKey(m);
    let text = (m.text ?? m.caption ?? "").trim();
    if (m.chat.type !== "private" && this.botName) text = text.replace(new RegExp(`@${this.botName}\\b`, "g"), "").trim();

    const cmd = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (cmd) {
      const handled = await this.command(cmd[1].toLowerCase(), (cmd[2] ?? "").trim(), m, key);
      if (handled) return;
    }

    const images: { type: "image"; data: string; mimeType: string }[] = [];
    const notes: string[] = [];
    try {
      if (m.photo?.length) {
        const best = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        const path = await this.api.download(best.file_id, join(this.cfg.home, "media", `${m.chat.id}-${m.message_id}.jpg`));
        images.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/jpeg" });
      }
      const audio = m.voice ?? m.audio;
      if (audio) {
        const ext = m.voice ? "ogg" : (m.audio?.file_name?.split(".").pop() ?? "mp3");
        const path = await this.api.download(audio.file_id, join(this.cfg.home, "media", `${m.chat.id}-${m.message_id}.${ext}`));
        const transcript = await this.transcribe(path);
        const missing = this.cfg.stt?.length ? `[voice note at ${path} could not be transcribed; see carl.log]` : `[voice note saved at ${path}; no speech-to-text is configured]`;
        text = [transcript ? `[voice note] ${transcript}` : missing, text].filter(Boolean).join("\n\n");
      }
      if (m.document) {
        const name = (m.document.file_name ?? "file").replace(/[^\w.-]+/g, "_");
        const path = await this.api.download(m.document.file_id, join(this.cfg.home, "media", `${m.chat.id}-${m.message_id}-${name}`));
        if (m.document.mime_type?.startsWith("image/")) images.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: m.document.mime_type });
        else notes.push(`[file received: ${path}]`);
      }
    } catch (e) {
      notes.push(`[attachment could not be fetched: ${(e as Error).message}]`);
    }
    if (m.reply_to_message?.text) notes.unshift(`[replying to: "${m.reply_to_message.text.slice(0, 400)}"]`);
    const body = [...notes, text].filter(Boolean).join("\n");
    if (!body && !images.length) return;
    await this.converse(m, key, { text: body || "(image)", images: images.length ? images : undefined, source: "telegram" });
  }

  private async converse(m: TgMessage, key: string, input: Parameters<Brain["ask"]>[1]): Promise<void> {
    const chatId = m.chat.id;
    const threadId = m.message_thread_id;
    const typing = setInterval(() => void this.api.sendChatAction(chatId, "typing", threadId).catch(() => {}), TYPING_INTERVAL_MS);
    void this.api.sendChatAction(chatId, "typing", threadId).catch(() => {});
    const draft = new Draft(this.api, chatId, m.message_id, threadId, this.cfg.telegram.stream);
    let result: RunResult;
    try {
      result = await this.brain.ask(key, input, {
        onText: (t) => draft.update(t),
        onTool: (name, detail) => draft.tool(name, detail),
      });
    } catch (e) {
      clearInterval(typing);
      await draft.finish(`Carl could not run that: ${(e as Error).message}`);
      return;
    }
    clearInterval(typing);
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
    await this.deliverFinal(draft, chatId, final);
  }

  // ---- Durable delivery: a final reply that fails to send is kept and retried until Telegram takes it. ----

  private readonly outboxFile = () => join(this.cfg.home, "state", "outbox.json");
  private outboxTimer?: NodeJS.Timeout;

  private async deliverFinal(draft: Draft, chatId: number, markdown: string): Promise<void> {
    try {
      await draft.finish(markdown);
    } catch (e) {
      this.log.error("reply delivery failed; queued for retry", { chatId, error: (e as Error).message });
      const queue = this.readOutbox();
      queue.push({ chatId, markdown, firstAt: Date.now(), attempts: 1, lastError: (e as Error).message });
      this.writeOutbox(queue);
      this.scheduleOutbox();
    }
  }

  private readOutbox(): { chatId: number; markdown: string; firstAt: number; attempts: number; lastError?: string }[] {
    try { return JSON.parse(readFileSync(this.outboxFile(), "utf8")); } catch { return []; }
  }

  private writeOutbox(queue: unknown[]): void {
    const file = this.outboxFile();
    writeFileSync(`${file}.tmp`, JSON.stringify(queue), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private scheduleOutbox(): void {
    if (this.outboxTimer || this.abort.signal.aborted) return;
    this.outboxTimer = setTimeout(() => { this.outboxTimer = undefined; void this.flushOutbox(); }, 30_000);
    this.outboxTimer.unref();
  }

  async flushOutbox(): Promise<void> {
    const queue = this.readOutbox();
    if (!queue.length) return;
    const left: typeof queue = [];
    for (const item of queue) {
      if (Date.now() - item.firstAt > 24 * 3_600_000) {
        this.log.error("undeliverable reply dropped after 24 h", { chatId: item.chatId, attempts: item.attempts, error: item.lastError });
        continue;
      }
      try {
        await this.sendMarkdown(item.chatId, `(delivered late)\n\n${item.markdown}`);
        this.log.info("queued reply delivered", { chatId: item.chatId, attempts: item.attempts + 1 });
      } catch (e) {
        left.push({ ...item, attempts: item.attempts + 1, lastError: (e as Error).message });
      }
    }
    this.writeOutbox(left);
    if (left.length) this.scheduleOutbox();
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

  private transcribe(path: string): Promise<string> {
    const cmd = this.cfg.stt;
    if (!cmd?.length) return Promise.resolve("");
    // "{file}" is the audio; "{output}" (optional) is a file the command writes the transcript to, else stdout.
    const outFile = `${path}.txt`;
    const argv = cmd.map((a) => a.replace("{file}", path).replace("{output}", outFile));
    if (!cmd.some((a) => a.includes("{file}"))) argv.push(path);
    const usesOutput = cmd.some((a) => a.includes("{output}"));
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
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
          try { return resolve(readFileSync(outFile, "utf8").trim()); } catch (e) { this.log.error("speech-to-text wrote no transcript", { error: (e as Error).message }); return resolve(""); }
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
    const text = `**Approve this command?** (${reason})\n\n\`\`\`\n${command.slice(0, 3_000)}\n\`\`\``;
    const [msg] = await this.sendMarkdown(chatId, text, { buttons: [[{ text: "Run once", callback_data: `ca:${id}:yes` }, { text: "Deny", callback_data: `ca:${id}:no` }]] });
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
        if (e instanceof TelegramError && /not modified/i.test(e.description)) continue;
        if (!(e instanceof TelegramError) || e.code !== 400) throw e;
        await send(htmlToPlain(html).slice(0, 4096));
      }
    }
  }
}
