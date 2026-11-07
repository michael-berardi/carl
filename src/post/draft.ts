// A draft is a Markdown file with YAML front matter. Reads are tolerant (the front matter may have been written by a
// notes vault); writes change only the keys they name, with a compare-and-set so nobody's concurrent edit is lost.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
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
  /** Write-ahead record: a click on this part (0-based) started and was not recorded as live. */
  pendingPart?: number;
  pendingAt?: string;
  /** The newest status id on the profile just before that click: a rerun looks only for posts newer than it, whatever the clocks say. */
  pendingBaseline?: string;
  /** Text the draft carries that would not be posted (a thread's `reply` or `first_reply`, a `## First reply` section): the draft is refused while it exists. */
  droppedText: string[];
  /** Hashes of the texts that went live, per part (an edit of a live part is refused). */
  partHashes: string[];
  /** The binding hash a successful live dry run covered. */
  dryRunHash?: string;
}

/**
 * Characters a terminal or chat can show differently from what is hashed and posted, or not show at all: C0/C1 controls (\n
 * alone is allowed), bidi controls, line and paragraph separators, soft hyphen, zero-width space/non-joiner, the invisible
 * math operators, the byte-order mark and the tag characters. (The zero-width joiner stays: emoji sequences need it.)
 */
export const BAD_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200c\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;
/** The same text with every such character shown as \\uXXXX. */
export const visible = (s: string) => s.replace(new RegExp(BAD_CHARS.source, "gu"), (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`);

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

/** Only these keys are lists: `text: [beta] note [x]` is a plain string. */
const LIST_KEYS = new Set(["thread", "thread_urls", "media"]);

/** `["a, b", 'c', d]`: JSON when it is JSON, else commas outside quotes. */
function flowList(v: string): string[] {
  try { const j = JSON.parse(v); if (Array.isArray(j) && j.every((x) => typeof x === "string")) return j.filter(Boolean); } catch {}
  const items: string[] = [];
  let cur = ""; let q = "";
  for (const ch of v.slice(1, -1)) {
    if (q) { cur += ch; if (ch === q) q = ""; } else if (ch === '"' || ch === "'") { q = ch; cur += ch; } else if (ch === ",") { items.push(cur); cur = ""; } else cur += ch;
  }
  items.push(cur);
  return items.map(unquote).filter(Boolean);
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
    } else if (LIST_KEYS.has(key) && rest.trim().startsWith("[") && rest.trim().endsWith("]")) {
      out[key] = flowList(rest.trim());
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
  // Text the file carries that the thread form would drop silently: refused by the service so nothing is lost unseen.
  const droppedText: string[] = [];
  if (isThread) {
    if (str(fields.reply)) droppedText.push("`reply`");
    if (str(fields.first_reply)) droppedText.push("`first_reply`");
    if (section(body, "First reply")) droppedText.push("the `## First reply` section");
    if (str(fields.text) || section(body, "Post")) droppedText.push("`text` / the `## Post` section");
  }
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
    pendingPart: /^\d+$/.test(str(fields.pending_part)) ? Number(str(fields.pending_part)) : undefined,
    pendingAt: str(fields.pending_at) || undefined,
    pendingBaseline: /^\d+$/.test(str(fields.pending_baseline)) ? str(fields.pending_baseline) : undefined,
    droppedText,
    partHashes: str(fields.part_hashes).split(",").map((h) => h.trim()).filter(Boolean),
    dryRunHash: str(fields.dry_run_hash) || undefined,
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

/** fsync a folder so a rename or a new file in it is durable. */
export function syncDir(dir: string): void {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch {}
}

/**
 * Compare-and-set write of front matter keys. `expect` is the hash of the file as it was read: if the file is anything
 * else, nothing is written. With retex available (and nothing to clear) the write is `retex set --if-hash`; retex missing
 * (exit 127) falls back to an atomic write; any other retex failure is an error. Returns the hash of the file afterwards.
 */
export class DraftStore {
  private readonly run: Runner;
  private readonly useRetex: boolean;
  constructor(run: Runner, useRetex: boolean) {
    this.run = run;
    this.useRetex = useRetex;
  }

  async set(path: string, props: Record<string, string | undefined>, expect?: string): Promise<string> {
    const changed = () => new PostError(`${path} changed while it was being updated; nothing was overwritten`);
    if (expect !== undefined && sha256(readFileSync(path, "utf8")) !== expect) throw changed();
    const defined = Object.entries(props).filter(([, v]) => v !== undefined) as [string, string][];
    // retex cannot clear a key through `set`: a write that clears keys is one atomic write, never two.
    if (this.useRetex && defined.length === Object.keys(props).length) {
      const show = await this.run("retex", ["show", path, "--lean"]);
      if (show.code !== 127) {
        let hash: string | undefined;
        try { hash = JSON.parse(show.stdout).contentHash; } catch {}
        if (show.code !== 0 || typeof hash !== "string") throw new PostError(`retex show failed for ${path}: ${(show.stdout + show.stderr).slice(0, 200)}`);
        const done = await this.run("retex", ["set", path, ...defined.map(([k, v]) => `${k}=${v}`), "--if-hash", hash, "--lean"]);
        if (done.code !== 0) throw new PostError(`draft update failed (${Object.keys(props).join(", ")}): ${(done.stdout + done.stderr).slice(0, 200)}`);
        return sha256(readFileSync(path, "utf8"));
      }
    }
    return this.atomic(path, props, expect);
  }

  private atomic(path: string, props: Record<string, string | undefined>, expect?: string): string {
    const before = readFileSync(path, "utf8");
    if (expect !== undefined && sha256(before) !== expect) throw new PostError(`${path} changed while it was being updated; nothing was overwritten`);
    const next = setFields(before, props);
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, next); fsyncSync(fd); } finally { closeSync(fd); }
      // Check-then-rename: the window is a few microseconds, and a lost race is reported, not hidden.
      if (sha256(readFileSync(path, "utf8")) !== sha256(before)) throw new PostError(`${path} changed while it was being updated; nothing was overwritten`);
      renameSync(tmp, path);
      syncDir(dirname(path)); // the rename itself must survive a power loss: the write-ahead record depends on it
    } finally {
      rmSync(tmp, { force: true });
    }
    return sha256(next);
  }
}
