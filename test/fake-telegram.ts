// A fake Telegram Bot API for end-to-end tests: records every call, serves queued updates to getUpdates.
import { createServer, type Server } from "node:http";

export interface Call { method: string; body: any; at: number }

export class FakeTelegram {
  calls: Call[] = [];
  /** message id -> current text, for messages Carl sent. */
  sent = new Map<number, { chatId: number; text: string; deleted?: boolean; at: number }>();
  private updates: any[] = [];
  private nextUpdateId = 1;
  private nextMessageId = 1000;
  private waiters: (() => void)[] = [];
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (b) => (raw += b));
      req.on("end", async () => {
        const method = (req.url ?? "").split("/").pop()!;
        let body: any = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
        const reply = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (method !== "getUpdates") this.calls.push({ method, body, at: Date.now() });
        switch (method) {
          case "getMe":
            return reply({ id: 1, is_bot: true, first_name: "Carl", username: "carl_test_bot" });
          case "getUpdates": {
            const deadline = Date.now() + Math.min((body.timeout ?? 0) * 1000, 2_000);
            while (!this.updates.some((u) => u.update_id >= (body.offset ?? 0)) && Date.now() < deadline) {
              await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 100); });
            }
            return reply(this.updates.filter((u) => u.update_id >= (body.offset ?? 0)));
          }
          case "sendMessage": {
            const id = this.nextMessageId++;
            this.sent.set(id, { chatId: body.chat_id, text: body.text, at: Date.now() });
            return reply({ message_id: id, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text });
          }
          case "deleteMessage": {
            const m = this.sent.get(body.message_id);
            if (m) m.deleted = true;
            return reply(true);
          }
          case "editMessageText":
            if (body.text === this.sent.get(body.message_id)?.text) {
              res.writeHead(400, { "content-type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }));
            }
            if (this.sent.has(body.message_id)) Object.assign(this.sent.get(body.message_id)!, { text: body.text, at: Date.now() });
            return reply({ message_id: body.message_id, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text });
          default:
            return reply(true);
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as any).port;
  }

  get base(): string { return `http://127.0.0.1:${this.port}`; }

  message(fromId: number, text: string, chatType = "private"): number {
    const message_id = this.nextMessageId++;
    this.push({ message: { message_id, date: Math.floor(Date.now() / 1000), chat: { id: fromId, type: chatType }, from: { id: fromId, is_bot: false, first_name: "Op" }, text } });
    return message_id;
  }

  callback(fromId: number, data: string, message: any): void {
    this.push({ callback_query: { id: `cb-${this.nextUpdateId}`, from: { id: fromId, is_bot: false }, message, data } });
  }

  private push(u: any): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...u });
    for (const w of this.waiters.splice(0)) w();
  }

  /** Visible texts Carl left in a chat, oldest first (edits applied, deleted drafts dropped). */
  texts(chatId: number, since = 0): string[] {
    return [...this.sent.values()].filter((m) => m.chatId === chatId && !m.deleted && m.at >= since).map((m) => m.text);
  }

  async waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; calls: ${this.calls.map((c) => c.method).join(",")}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}
