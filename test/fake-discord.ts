// A fake Discord: REST over HTTP and the Gateway over a minimal WebSocket server (text frames only).
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

export class FakeDiscord {
  calls: { method: string; path: string; body: any }[] = [];
  identified = false;
  private server!: Server;
  private socket?: Duplex;
  private id = 5000;
  private seq = 0;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (b) => (raw += b));
      req.on("end", () => {
        const path = (req.url ?? "").replace(/^\/api\/v10/, "");
        const body = raw ? JSON.parse(raw) : undefined;
        this.calls.push({ method: req.method!, path, body });
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
