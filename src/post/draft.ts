// A draft is a Markdown file with YAML front matter. Reads are tolerant (the front matter may have been written by a
// notes vault); writes change only the keys they name, with a compare-and-set so nobody's concurrent edit is lost.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DraftContent, Runner } from "./types.ts";
import { PostError } from "./types.ts";

export type Value = string | string[];

export interface Draft extends DraftContent {
  path: string;
  /** Hash of the whole file as read: the compare-and-set token. */
  fileHash: string;
  /** Hash of what would be posted (platform, account, text, thread, reply): approval is bound to it. */
  textHash: string;
  fields: Record<string, Value>;
  status: string;
  approved?: string;
  approvedHash?: string;
  scheduledAt?: string;
  postUrl?: string;
  threadUrls: string[];
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Split a file into front matter lines, and the body. */
function split(raw: string): { front: string[]; body: string } {
  const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return { front: [], body: raw };
  return { front: m[1].split(/\r?\n/), body: m[2] ?? "" };
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** The YAML subset drafts use: scalars, quoted strings, `|` / `>` blocks, `- item` lists and `[a, b]`. */
export function parseFront(lines: string[]): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    const cont: string[] = [];
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1] === "" || /^-[ \t]/.test(lines[i + 1]))) cont.push(lines[++i]);
    while (cont.length && cont[cont.length - 1] === "") cont.pop();
    if (/^[|>][+-]?$/.test(rest.trim())) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length), Infinity);
      const text = cont.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      out[key] = rest.trim().startsWith(">") ? text.join(" ").replace(/ +/g, " ").trim() : text.join("\n").replace(/\n+$/, "");
    } else if (rest.trim() === "" && cont.some((l) => /^\s*-[ \t]/.test(l))) {
      out[key] = cont.filter((l) => /^\s*-[ \t]/.test(l)).map((l) => unquote(l.replace(/^\s*-[ \t]+/, "")));
    } else if (rest.trim().startsWith("[") && rest.trim().endsWith("]")) {
      out[key] = rest.trim().slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      out[key] = unquote(rest);
    }
  }
  return out;
}

/** `## Name` section of the body, trimmed. */
function section(body: string, name: string): string {
  const m = body.match(new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?\\n\\r?\\n?([\\s\\S]*?)(?=\\r?\\n## |(?![\\s\\S]))`, "mi"));
  return m ? m[1].trim() : "";
}

function threadFromBody(body: string): string[] {
  const raw = section(body, "Thread");
  if (!raw) return [];
  return raw.split(/^### \d+[ \t]*$/m).map((p) => p.trim()).filter(Boolean);
}

const str = (v: Value | undefined) => (Array.isArray(v) ? v.join(",") : (v ?? "")).trim();

export function parseDraft(raw: string, path: string): Draft {
  const { front, body } = split(raw);
  const fields = parseFront(front);
  const thread = Array.isArray(fields.thread) ? fields.thread.map((s) => s.trim()).filter(Boolean) : threadFromBody(body);
  const text = str(fields.text) || section(body, "Post");
  const reply = str(fields.reply) || str(fields.first_reply) || section(body, "First reply") || undefined;
  const isThread = thread.length > 0;
  const parts = isThread ? thread : text ? [text] : [];
  const platform = str(fields.platform);
  const account = str(fields.account);
  const urls = fields.thread_urls;
  const threadUrls = (Array.isArray(urls) ? urls : (urls ?? "").split(",")).map((u) => u.trim()).filter(Boolean);
  return {
    path, fields, platform, account, parts, isThread, reply: isThread ? undefined : reply,
    fileHash: sha256(raw),
    textHash: textHash({ platform, account, parts, isThread, reply: isThread ? undefined : reply }),
    status: str(fields.status) || "Draft",
    approved: str(fields.approved) || undefined,
    approvedHash: str(fields.approved_hash) || undefined,
    scheduledAt: str(fields.scheduled_at) || undefined,
    postUrl: str(fields.post_url) || undefined,
    threadUrls,
  };
}

/** What approval is bound to. Any change to where or what is posted changes it. */
export function textHash(c: DraftContent): string {
  return sha256(JSON.stringify({ platform: c.platform, account: c.account, parts: c.parts.map((p) => p.trim()), thread: c.isThread, reply: c.reply?.trim() ?? null }));
}

export function readDraft(path: string): Draft {
  if (!existsSync(path)) throw new PostError(`no draft at ${path}`, true);
  return parseDraft(readFileSync(path, "utf8"), path);
}

/** A value as one YAML line: plain when safe, else a JSON-quoted string. */
function yamlValue(v: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_./:@+,-]*(?: [A-Za-z0-9_./:@+,-]+)*$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) && !/^[\d.]+$/.test(v) ? v : JSON.stringify(v);
}

/** Replace or add top-level front matter keys, leaving every other line as it was. Values are single-line strings. */
export function setFields(raw: string, props: Record<string, string | undefined>): string {
  const m = raw.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n[\s\S]*)?)$/);
  const head = m ? m[1] : "---\n";
  const lines = m ? m[2].split(/\r?\n/) : [];
  const tail = m ? m[3] : `\n---\n${raw}`;
  for (const [key, value] of Object.entries(props)) {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    let end = at;
    if (at >= 0) while (end + 1 < lines.length && (/^[ \t]/.test(lines[end + 1]) || /^-[ \t]/.test(lines[end + 1]))) end++;
    if (value === undefined) { if (at >= 0) lines.splice(at, end - at + 1); continue; }
    const line = `${key}: ${yamlValue(value)}`;
    if (at >= 0) lines.splice(at, end - at + 1, line); else lines.push(line);
  }
  return head + lines.join("\n") + tail;
}

/**
 * Compare-and-set write of front matter keys. With retex available: `retex set --if-hash`. Otherwise an atomic write
 * after checking the file is still what was read. A concurrent edit makes this throw instead of overwriting it.
 */
export class DraftStore {
  private readonly run: Runner;
  private readonly useRetex: boolean;
  constructor(run: Runner, useRetex: boolean) {
    this.run = run;
    this.useRetex = useRetex;
  }

  async set(path: string, props: Record<string, string | undefined>): Promise<void> {
    if (this.useRetex) {
      const show = await this.run("retex", ["show", path, "--lean"]);
      let hash: string | undefined;
      try { hash = JSON.parse(show.stdout).contentHash; } catch {}
      if (show.code === 0 && typeof hash === "string") {
        const defined = Object.entries(props).filter(([, v]) => v !== undefined) as [string, string][];
        const unset = Object.entries(props).filter(([, v]) => v === undefined).map(([k]) => k);
        // retex cannot clear a key through `set`; those go through the file path below, after the retex write.
        const done = await this.run("retex", ["set", path, ...defined.map(([k, v]) => `${k}=${v}`), "--if-hash", hash, "--lean"]);
        if (done.code !== 0) throw new PostError(`draft update failed (${Object.keys(props).join(", ")}): ${(done.stdout + done.stderr).slice(0, 200)}`);
        if (unset.length) this.atomic(path, Object.fromEntries(unset.map((k) => [k, undefined])));
        return;
      }
    }
    this.atomic(path, props);
  }

  private atomic(path: string, props: Record<string, string | undefined>): void {
    const before = readFileSync(path, "utf8");
    const next = setFields(before, props);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, next, { mode: 0o600 });
    // Check-then-rename: the window is a few microseconds, and a lost race is reported, not hidden.
    if (sha256(readFileSync(path, "utf8")) !== sha256(before)) throw new PostError(`${path} changed while it was being updated; nothing was overwritten`);
    renameSync(tmp, path);
  }
}
