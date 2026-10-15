// Minimal Telegram Bot API client: fetch, bounded retries, 429 back-off. No dependencies.
import { writeFileSync } from "node:fs";

export class TelegramError extends Error {
  override name = "TelegramError";
  readonly method: string;
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

export class TelegramApi {
  private readonly base: string;
  private readonly fileBase: string;
  constructor(token: string, apiBase = "https://api.telegram.org") {
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error("Telegram bot token is malformed (expected <digits>:<secret>)");
    this.base = `${apiBase}/bot${token}`;
    this.fileBase = `${apiBase}/file/bot${token}`;
  }

  /** Call a Bot API method. Retries network errors and 5xx twice and honours 429 retry_after (up to 60 s). */
  async call<T>(method: string, body: Record<string, unknown> = {}, opts: { signal?: AbortSignal; timeoutMs?: number; retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (attempt >= retries) throw new TelegramError(method, 0, `network error: ${(e as Error).message}`);
        await sleep(1_000 * 2 ** attempt, opts.signal);
        continue;
      }
      let json: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      try {
        json = await res.json();
      } catch {
        json = { ok: false, error_code: res.status, description: `non-JSON response (HTTP ${res.status})` };
      }
      if (json.ok) return json.result as T;
      const code = json.error_code ?? res.status;
      const retryAfter = json.parameters?.retry_after;
      if (code === 429 && retryAfter !== undefined && retryAfter <= 60 && attempt < retries + 2) {
        await sleep(retryAfter * 1_000 + 250, opts.signal);
        continue;
      }
      if (code >= 500 && attempt < retries) {
        await sleep(1_000 * 2 ** attempt, opts.signal);
        continue;
      }
      throw new TelegramError(method, code, json.description ?? "unknown error", retryAfter);
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
    const res = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    const json = (await res.json()) as { ok: boolean; result?: TgMessage; error_code?: number; description?: string };
    if (!json.ok) throw new TelegramError("sendDocument", json.error_code ?? res.status, json.description ?? "unknown error");
    return json.result!;
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
