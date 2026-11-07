// A fake Discord: REST over HTTP and the Gateway over a minimal WebSocket server (text frames only).
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

/** Light multipart/form-data parse for bot file uploads (files[0] + payload_json). */
function parseMultipart(raw: Buffer, contentType: string): { fields: Record<string, string>; files: { name: string; data: Buffer }[] } {
  const m = contentType.match(/boundary=(.+)$/);
  const boundary = "--" + (m ? m[1].replace(/^"|"$/g, "") : "x");
  const parts = raw.toString("latin1").split(boundary);
  const fields: Record<string, string> = {};
  const files: { name: string; data: Buffer }[] = [];
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    const header = headerEnd === -1 ? "" : part.slice(0, headerEnd);
    const hm = header.match(/name="([^"]+)"(?:;\s*filename="([^"]*)")?/);
    if (!hm) continue;
    let body = headerEnd === -1 ? "" : part.slice(headerEnd + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    if (hm[2] !== undefined) files.push({ name: hm[2], data: Buffer.from(body, "latin1") });
    else fields[hm[1]] = body;
  }
  return { fields, files };
}

export class FakeDiscord {
  calls: { method: string; path: string; body: any }[] = [];
  identified = false;
  private server!: Server;
  private socket?: Duplex;
  private id = 5000;
  private seq = 0;
  /** Files served to the channel as attachments. */
  private media = new Map<string, Buffer>();
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/attachment/")) {
        const name = decodeURIComponent(url.slice(12));
        const data = this.media.get(name);
        if (!data) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(data);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (b: Buffer) => chunks.push(b));
      req.on("end", () => {
        const path = url.replace(/^\/api\/v10/, "");
        const raw = Buffer.concat(chunks);
        const ct = req.headers["content-type"] ?? "";
        let body: any = undefined;
        let files: { name: string; data: Buffer }[] = [];
        if (raw.length) {
          if (ct.includes("multipart/form-data")) {
            const parsed = parseMultipart(raw, ct);
            body = JSON.parse(parsed.fields.payload_json ?? "{}");
            files = parsed.files;
          } else {
            body = JSON.parse(raw.toString("utf8"));
          }
        }
        this.calls.push({ method: req.method!, path, body, ...(files.length ? { files } : {}) });
        const reply = (status: number, o?: any) => { res.writeHead(status, { "content-type": "application/json" }); res.end(o ? JSON.stringify(o) : undefined); };
        if (path === "/gateway/bot") return reply(200, { url: `ws://127.0.0.1:${this.port}/gw` });
        if (req.method === "POST" && /\/channels\/\d+\/messages$/.test(path)) return reply(200, { id: String(this.id++) });
        if (req.method === "PATCH") return reply(200, { id: path.split("/").pop() });
        return reply(204);
      });
    });
    this.server.on("upgrade", (req, socket: Duplex) => {
      const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      this.socket = socket;
      let buf = Buffer.alloc(0);
      socket.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
          const mask = buf.subarray(off, off + 4);
          off += 4;
          if (buf.length < off + len) return;
          const p = Buffer.from(buf.subarray(off, off + len));
          for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
          buf = buf.subarray(off + len);
          if (opcode !== 1) continue;
          const m = JSON.parse(p.toString());
          if (m.op === 2) { this.identified = true; this.dispatch("READY", { user: { id: "999", username: "carl" } }); }
        }
      });
      this.push({ op: 10, d: { heartbeat_interval: 45_000 } });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as any).port;
  }

  get base(): string { return `http://127.0.0.1:${this.port}/api/v10`; }

  attach(name: string, data: Buffer): void { this.media.set(name, data); }
  attachmentUrl(name: string): string { return `http://127.0.0.1:${this.port}/attachment/${name}`; }

  private push(frame: any): void {
    const data = Buffer.from(JSON.stringify(frame));
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    this.socket?.write(Buffer.concat([head, data]));
  }

  dispatch(t: string, d: any): void { this.push({ op: 0, t, s: ++this.seq, d }); }

  message(user: string, content: string, channel = "100"): string {
    const id = String(this.id++);
    this.dispatch("MESSAGE_CREATE", { id, channel_id: channel, author: { id: user, bot: false }, content, mentions: [] });
    return id;
  }

  /** A message with attachments; when guildId is set (a server/thread) the bot is mentioned. */
  fileMessage(user: string, channel: string, attachments: any[], content = "", guildId?: string): string {
    const id = String(this.id++);
    this.dispatch("MESSAGE_CREATE", { id, channel_id: channel, guild_id: guildId, author: { id: user, bot: false }, content, mentions: guildId ? [{ id: "999" }] : [], attachments });
    return id;
  }

  texts(channel: string): string[] {
    const byId = new Map<string, string>();
    let n = 0;
    for (const c of this.calls) {
      if (c.method === "POST" && c.path === `/channels/${channel}/messages`) byId.set(`p${n++}`, c.body.content);
      if (c.method === "PATCH" && c.path.startsWith(`/channels/${channel}/messages/`)) byId.set(`e${c.path}`, c.body.content);
    }
    return [...byId.values()];
  }

  stop(): Promise<void> {
    this.socket?.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}
