// A fake Slack: Web API over HTTP and Socket Mode over a minimal WebSocket server (text frames only).
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

export class FakeSlack {
  calls: { method: string; body: any }[] = [];
  private server!: Server;
  private socket?: Duplex;
  private ts = 1000;
  acks: string[] = [];
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (b) => (raw += b));
      req.on("end", () => {
        const method = (req.url ?? "").split("/").pop()!;
        const body = raw ? JSON.parse(raw) : {};
        this.calls.push({ method, body });
        const reply = (o: any) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, ...o })); };
        if (method === "auth.test") return reply({ user_id: "UBOT" });
        if (method === "apps.connections.open") return reply({ url: `ws://127.0.0.1:${this.port}/socket` });
        if (method === "chat.postMessage") return reply({ ts: String(this.ts++) + ".0001", channel: body.channel });
        return reply({});
      });
    });
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      const key = req.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      this.socket = socket;
      let buf = Buffer.alloc(0);
      socket.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const masked = (buf[1] & 0x80) !== 0;
          const mask = masked ? buf.subarray(off, off + 4) : undefined;
          off += masked ? 4 : 0;
          if (buf.length < off + len) return;
          const payload = Buffer.from(buf.subarray(off, off + len));
          if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          buf = buf.subarray(off + len);
          if (opcode === 1) { const m = JSON.parse(payload.toString()); if (m.envelope_id) this.acks.push(m.envelope_id); }
          if (opcode === 8) socket.end();
        }
      });
      this.push({ type: "hello" });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as any).port;
  }

  get base(): string { return `http://127.0.0.1:${this.port}/api`; }

  push(frame: any): void {
    const data = Buffer.from(JSON.stringify(frame));
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
    this.socket?.write(Buffer.concat([head, data]));
  }

  async waitConnected(timeoutMs = 5_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!this.socket) { if (Date.now() > end) throw new Error("slack socket never connected"); await new Promise((r) => setTimeout(r, 50)); }
  }

  message(user: string, text: string, channel = "D1", channelType = "im"): string {
    const envelope = `env-${Math.random().toString(36).slice(2)}`;
    this.push({ type: "events_api", envelope_id: envelope, payload: { event: { type: "message", user, text, channel, ts: `${this.ts++}.0002`, channel_type: channelType } } });
    return envelope;
  }

  texts(channel: string): string[] {
    const out = new Map<string, string>();
    let n = 0;
    for (const c of this.calls) {
      if (c.method === "chat.postMessage" && c.body.channel === channel) out.set(`p${n++}`, c.body.text);
      if (c.method === "chat.update" && c.body.channel === channel) out.set(`u${c.body.ts}`, c.body.text);
    }
    return [...out.values()];
  }

  stop(): Promise<void> {
    this.socket?.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}
