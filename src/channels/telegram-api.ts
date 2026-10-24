// Minimal Telegram Bot API client: fetch, bounded retries, 429 back-off. No dependencies.
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { htmlToPlain } from "./format.ts";

export class TelegramError extends Error {
  override name = "TelegramError";
  readonly method: string;
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;
  readonly status: "failed" | "unknown";
  requestId?: string;
  constructor(method: string, code: number, description: string, retryAfter?: number, status: "failed" | "unknown" = code === 0 || code >= 500 ? "unknown" : "failed") {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

export interface TgUser { id: number; is_bot: boolean; first_name?: string; username?: string }
export interface TgChat { id: number; type: string; title?: string; username?: string }
export interface TgPhotoSize { file_id: string; width: number; height: number; file_size?: number }
export interface TgFile { file_id: string; file_path?: string; file_size?: number }
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: TgMessage;
  message_thread_id?: number;
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage; callback_query?: TgCallbackQuery }
export interface InlineButton { text: string; callback_data?: string; url?: string }

export interface SendOptions {
  parseMode?: "HTML";
  replyTo?: number;
  threadId?: number;
  buttons?: InlineButton[][];
  silent?: boolean;
}

export interface TelegramOutcome {
  requestId: string;
  status: "delivered" | "failed" | "unknown";
  error: string | null;
}

// Fail closed for unknown methods: only explicitly listed read-only methods can replay an ambiguous request.
const READ_METHODS = new Set([
  "getMe", "getUpdates", "getFile", "getChat", "getChatAdministrators", "getChatMemberCount", "getChatMember",
  "getWebhookInfo", "getMyCommands", "getMyName", "getMyDescription", "getMyShortDescription",
  "getUserProfilePhotos", "getChatMenuButton", "getMyDefaultAdministratorRights", "getBusinessConnection",
  "getStickerSet", "getCustomEmojiStickers", "getForumTopicIconStickers", "getUserChatBoosts",
]);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  if (signal?.aborted) done();
  else signal?.addEventListener("abort", done, { once: true });
});

export class TelegramApi {
  private readonly base: string;
  private readonly fileBase: string;
  /** Historical name: observes every completed mutation, including refusals and unknown outcomes, once per call. */
  onDelivered?: (method: string, body: Record<string, unknown>, result: unknown, outcome?: TelegramOutcome) => void;
  constructor(token: string, apiBase = "https://api.telegram.org") {
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("Telegram bot token is malformed (expected <digits>:<secret>)");
    this.base = `${apiBase}/bot${token}`;
    this.fileBase = `${apiBase}/file/bot${token}`;
  }

  async call<T>(method: string, body: Record<string, unknown> = {}, opts: { signal?: AbortSignal; timeoutMs?: number; retries?: number } = {}): Promise<T> {
    return this.observed(method, body, () => this.request<T>(method, body, opts));
  }

  private async observed<T>(method: string, body: Record<string, unknown>, request: () => Promise<T>): Promise<T> {
    const requestId = randomUUID();
    let result: T | undefined;
    let outcome: TelegramOutcome;
    try {
      result = await request();
      outcome = { requestId, status: "delivered", error: null };
      return result;
    } catch (e) {
      if (e instanceof TelegramError) e.requestId = requestId;
      outcome = { requestId, status: e instanceof TelegramError ? e.status : "unknown", error: e instanceof Error ? e.message : String(e) };
      throw e;
    } finally {
      if (!READ_METHODS.has(method)) {
        try { this.onDelivered?.(method, body, result, outcome!); } catch {}
      }
    }
  }

  /** Replay ambiguous outcomes only for reads; retry explicit 429 refusals within a finite budget. */
  private async request<T>(method: string, body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number; retries?: number } = {}, form?: FormData): Promise<T> {
    const retries = Math.max(0, Math.min(5, Math.trunc(opts.retries ?? 2) || 0));
    const read = READ_METHODS.has(method);
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new TelegramError(method, 0, "cancelled before request", undefined, "failed");
      let res: Response;
      let json: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      try {
        res = await fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: form ? undefined : { "content-type": "application/json" },
          body: form ?? JSON.stringify(body),
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
        const value: unknown = await res.json();
        json = value && typeof value === "object" ? value : {};
      } catch (e) {
        if (!read || opts.signal?.aborted || attempt >= retries) throw new TelegramError(method, 0, `network or response error: ${(e as Error).message}`);
        await sleep(1_000 * 2 ** attempt, opts.signal);
        continue;
      }
      if (res.ok && json.ok === true) return json.result as T;
      const code = json.error_code ?? res.status;
      const retryAfter = json.parameters?.retry_after;
      if (res.status < 500 && json.ok === false && code === 429 && Number.isFinite(retryAfter) && retryAfter! >= 0 && retryAfter! <= 60 && attempt < retries + 2) {
        await sleep(retryAfter! * 1_000 + 250, opts.signal);
        continue;
      }
      if (read && (res.status >= 500 || code >= 500 || json.ok === undefined) && attempt < retries) {
        await sleep(1_000 * 2 ** attempt, opts.signal);
        continue;
      }
      const unknown = res.status >= 500 || code >= 500 || (res.ok && json.ok !== false);
      throw new TelegramError(method, code, json.description ?? `unclear response (HTTP ${res.status})`, retryAfter, unknown ? "unknown" : "failed");
    }
  }

  getMe() { return this.call<TgUser>("getMe"); }

  getUpdates(offset: number, signal: AbortSignal) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, { signal, timeoutMs: 65_000, retries: 0 });
  }

  sendMessage(chatId: number, text: string, o: SendOptions = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: o.parseMode,
      link_preview_options: { is_disabled: true },
      reply_parameters: o.replyTo ? { message_id: o.replyTo, allow_sending_without_reply: true } : undefined,
      message_thread_id: o.threadId,
      reply_markup: o.buttons ? { inline_keyboard: o.buttons } : undefined,
      disable_notification: o.silent,
    });
  }

  /** Formatting fallback is safe only after an explicit refusal, never a timeout/5xx. */
  async sendHtmlMessage(chatId: number, html: string, o: SendOptions = {}) {
    try { return await this.sendMessage(chatId, html, { ...o, parseMode: "HTML" }); }
    catch (e) {
      if (!(e instanceof TelegramError) || e.code !== 400 || e.status !== "failed") throw e;
      return this.sendMessage(chatId, htmlToPlain(html).slice(0, 4096), { ...o, parseMode: undefined });
    }
  }

  editMessageText(chatId: number, messageId: number, text: string, o: SendOptions = {}) {
    return this.call<TgMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: o.parseMode,
      link_preview_options: { is_disabled: true },
      reply_markup: o.buttons ? { inline_keyboard: o.buttons } : undefined,
    });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<true>("deleteMessage", { chat_id: chatId, message_id: messageId }, { retries: 0 });
  }

  sendChatAction(chatId: number, action: "typing" | "upload_document" = "typing", threadId?: number) {
    return this.call<true>("sendChatAction", { chat_id: chatId, action, message_thread_id: threadId }, { retries: 0, timeoutMs: 10_000 });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call<true>("answerCallbackQuery", { callback_query_id: id, text }, { retries: 0 });
  }

  setMyCommands(commands: { command: string; description: string }[]) {
    return this.call<true>("setMyCommands", { commands });
  }

  async sendDocument(chatId: number, fileName: string, data: Uint8Array, caption?: string): Promise<TgMessage> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption.slice(0, 1024));
    form.set("document", new Blob([new Uint8Array(data)]), fileName);
    const body = { chat_id: chatId, caption: caption?.slice(0, 1024), document: { file_name: fileName } };
    return this.observed("sendDocument", body, () => this.request<TgMessage>("sendDocument", body, { timeoutMs: 120_000 }, form));
  }

  /**
   * Download a file by id to `dest` and return its bytes. Bot API downloads are capped at 20 MB by Telegram.
   * The file is created exclusively: a name planted in advance (a symlink, say) fails instead of being followed.
   */
  async download(fileId: string, dest: string): Promise<Buffer> {
    const file = await this.call<TgFile>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram returned no file_path (file too large for the Bot API?)");
    const res = await fetch(`${this.fileBase}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, data, { mode: 0o600, flag: "wx" });
    return data;
  }
}
