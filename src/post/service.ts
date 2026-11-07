// The post pipeline: draft record -> render and validate (dry run) -> post -> verify the live URL -> record the outcome.
// Approval is a hard gate in front of every live or scheduled post, and is bound to the draft's current text.
// Posting is something only the gateway process does: the approval key exists only in its memory (see key.ts), every approval is
// made after an operator's press verified in this process, and `carl post` only asks the gateway to raise a card.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { PostConfig } from "../config.ts";
import type { Job, Scheduler } from "../scheduler.ts";
import { BAD_CHARS, type Draft, DraftStore, readDraft, sha256, syncDir, textHash, visible } from "./draft.ts";
import { agentCanWrite, canon, hmac, newKey, relayFingerprint } from "./key.ts";
import type { AdapterRegistry } from "./registry.ts";
import { type CardKind, type CardRequest, CardStore } from "./cards.ts";
import { type AdapterContext, type PostAccount, PostError, type PostRun, type Rendered, type Runner } from "./types.ts";

export interface PostDeps {
  home: string;
  config: PostConfig;
  run: Runner;
  registry: AdapterRegistry;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  id?: () => string;
  scheduler?: Scheduler;
  /** Told when the agent sets a slot (the operator must know a post is coming). */
  notify?: (message: string) => void | Promise<void>;
  /** The browser relay descriptor as it is now (default: read from the operator's files). Posting refuses once it differs from what Carl saw at start. */
  relayFingerprint?: () => string;
  /** Environment the relay descriptors are read with (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** Session-command problems found at start (the gateway's own PATH check); `carl post status` shows them. */
  sessionProblems?: () => string[];
}

/** An approval is good for this long (and for one post): short-lived by design, since a gateway restart voids every approval anyway. */
export const APPROVAL_TTL_MS = 24 * 3600_000;

/** An agent may not schedule closer than this: the operator needs time to look. */
export const AGENT_MIN_LEAD_MS = 15 * 60_000;

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** Why this draft may not be posted, or undefined when the operator's approval covers its current text. `expected` is the keyed binding hash. */
export function approvalProblem(d: Draft, expected?: string, nowMs?: number): string | undefined {
  if (!d.approved?.trim()) return "no operator approval is recorded (run `carl post approve`)";
  const who = d.approved.replace(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*(?:Z|[+-]\d{2}:?\d{2})?/, "").replace(/\b(?:at|on|by)\b/gi, "").trim();
  if (!ISO_DATE.test(d.approved) || !who) return `approval "${d.approved}" must name who and when (for example "alice 2026-01-31T09:00:00Z"); approve it again with \`carl post approve\``;
  if (!d.approvedHash) return "the approval does not record which text it covered; approve it again";
  if (expected === undefined || d.approvedHash !== expected) return "the draft was edited after it was approved (or the approval was not made by this Carl); approve it again";
  if (nowMs !== undefined && nowMs - approvedAt(d) > APPROVAL_TTL_MS) return `the approval expired (${d.approved} is older than ${APPROVAL_TTL_MS / 3600_000} h); approve it again`;
  return undefined;
}

const dur = (ms: number) => {
  const m = Math.round(Math.abs(ms) / 60_000);
  return m >= 120 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const partHash = (t: string) => sha256(t.trim()).slice(0, 16);
const approvedAt = (d: Draft) => { const m = d.approved?.match(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*(?:Z|[+-]\d{2}:?\d{2})?/); const t = m ? Date.parse(m[0]) : NaN; return Number.isNaN(t) ? 0 : t; };
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; }
  const comm = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  return !comm.trim() || /node|carl|bun|deno/i.test(comm); // a recycled pid belongs to some other program
};

export interface PublishOpts { note?: string; skipDryRun?: boolean }

export class PostService {
  readonly deps: PostDeps;
  private readonly store: DraftStore;
  /** The approval key: random per service (the gateway makes one at start), held in memory only, never written anywhere. */
  private readonly key = newKey();
  /** Approvals (their stamps) that a click has been made under: one approval posts once. */
  private readonly consumed = new Set<string>();
  constructor(deps: PostDeps) {
    this.deps = deps;
    this.store = new DraftStore(deps.run, deps.config.retex === "auto");
    this.relayAtStart = this.relayNow();
  }
  private readonly relayAtStart: string;
  private relayNow = () => (this.deps.relayFingerprint ?? (() => relayFingerprint(this.deps.config.browser, this.deps.env)))();
  /** The sandbox closed the relay root that was named when Carl started; a different one now is open to the agent's shell. */
  private assertRelay(): void {
    if (this.relayNow() !== this.relayAtStart) throw new PostError("the browser relay descriptor changed since Carl started, so the new relay root is not closed to the agent's shell yet; restart Carl (the gateway) and try again", true);
  }

  private now = () => (this.deps.now ?? Date.now)();

  /**
   * Where (platform, account, profile) and what (every part, the reply) a keyed hash covers. `purpose` keeps the hashes apart:
   * a dry run's hash is not an approval, and the approval's covers the approved stamp itself, so a stamp cannot be copied or edited.
   */
  mac(purpose: "approve" | "dry-run" | "card", d: Draft, extra: unknown = null): string {
    const profile = this.deps.config.accounts[d.account]?.profile ?? "";
    return hmac(this.key, JSON.stringify({ v: 4, purpose, path: canon(d.path), platform: d.platform, account: d.account, profile, parts: d.parts.map((p) => p.trim()), thread: d.isThread, reply: d.reply?.trim() ?? null, extra }));
  }
  /** Why this draft may not be posted (approval, keyed). */
  problem(d: Draft): string | undefined { return approvalProblem(d, this.mac("approve", d, d.approved ?? ""), this.now()); }

  /** A draft by name (in the drafts folder) or, for the operator's CLI, by path. The agent's tool passes `named` only. */
  resolve(ref: string, opts: { named?: boolean } = {}): string {
    const dir = this.deps.config.draftsDir;
    const name = ref.replace(/\.md$/, "");
    if (NAME.test(name)) return join(dir, `${name}.md`);
    if (opts.named) throw new PostError(`draft names are lowercase letters, digits, . _ - (got "${ref}")`, true);
    return isAbsolute(ref) ? ref : resolve(process.cwd(), ref);
  }

  load(ref: string, opts: { named?: boolean } = {}): Draft {
    const path = this.resolve(ref, opts);
    if (!existsSync(path)) throw new PostError(`no draft at ${path}`, true);
    return readDraft(path);
  }

  /** Account, adapter and rendered text for a draft; throws a final PostError naming what is wrong. */
  prepare(d: Draft): { account: PostAccount; ctx: AdapterContext; rendered: Rendered; adapter: ReturnType<AdapterRegistry["get"]> } {
    const n = basename(d.path);
    if (agentCanWrite(d.path, this.deps.config.agentWritable ?? [], this.deps.home)) throw new PostError(`${n}: the draft is in a folder the agent can write; approvals there could be forged. Keep drafts in post.draftsDir outside the agent's areas`, true);
    if (!d.platform) throw new PostError(`${n}: the draft has no platform`, true);
    if (!d.account) throw new PostError(`${n}: the draft has no account`, true);
    const account = this.deps.config.accounts[d.account];
    if (!account) throw new PostError(`${n}: account "${d.account}" is not in carl.json post.accounts`, true);
    if (account.platform !== d.platform) throw new PostError(`${n}: the draft says platform "${d.platform}" but account "${d.account}" is "${account.platform}"`, true);
    if (String(Array.isArray(d.fields.media) ? d.fields.media.join("") : (d.fields.media ?? "")).trim()) throw new PostError(`${n}: media is not supported yet and would be dropped silently; remove \`media:\``, true);
    if (d.droppedText.length) throw new PostError(`${n}: ${d.droppedText.join(", ")} would not be posted (a thread posts only its parts) and would be dropped silently; put it in the thread as another part or remove it`, true);
    const adapter = this.deps.registry.get(d.platform);
    const rendered = adapter.render(d, account);
    const bad = rendered.sequence.findIndex((t) => BAD_CHARS.test(t));
    if (bad >= 0 && !rendered.problems.some((p) => /control/.test(p))) rendered.problems.push(`part ${bad + 1} contains control or bidirectional characters (${visible(rendered.sequence[bad]).slice(0, 80)})`);
    if (rendered.problems.length) throw new PostError(`${n}: ${rendered.problems.join("; ")}`, true);
    const ctx: AdapterContext = {
      account,
      run: this.deps.run,
      sleep: this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      id: this.deps.id ?? (() => randomBytes(4).toString("hex")),
    };
    return { account, ctx, rendered, adapter };
  }

  /** A part already live must not be edited: the thread's replies hang off its old text. */
  private liveEdit(d: Draft, rendered: Rendered, hashes: string[] = d.partHashes): string | undefined {
    for (let i = 0; i < hashes.length && i < rendered.sequence.length; i++) {
      if (hashes[i] !== partHash(rendered.sequence[i])) return `part ${i + 1} is already live and its text was edited since; restore the live text (the later parts reply to it)`;
    }
    return undefined;
  }

  /** Render and validate (no side effects); with `offline` false the adapter also proves the platform takes the exact text, then discards it. No approval needed. */
  async dryRun(ref: string, opts: { offline?: boolean; named?: boolean } = {}): Promise<string> {
    // A live dry run writes the draft; it takes the draft's lock, so it cannot land in the middle of a post (which would fail its write-ahead record).
    if (!opts.offline) return this.withLock(this.resolve(ref, opts), () => this.dryRunBody(ref, opts));
    return this.dryRunBody(ref, opts);
  }

  private async dryRunBody(ref: string, opts: { offline?: boolean; named?: boolean }): Promise<string> {
    const d = this.load(ref, opts);
    const { ctx, rendered, adapter } = this.prepare(d);
    const lines = [`${basename(d.path)}: ${d.platform}/${d.account}, ${rendered.sequence.length} text(s), sizes ${rendered.sizes.join(", ")}`];
    const gate = this.problem(d);
    lines.push(gate ? `approval: not ready (${gate})` : `approval: ${d.approved}`);
    if (d.status === "Posted") lines.push("status: already Posted; it cannot be posted again");
    if (opts.offline) lines.push("offline: text rendered and validated; the platform was not contacted. A live dry run (not offline) is still required before posting");
    else {
      this.assertRelay();
      const report = await adapter.dryRun(ctx, rendered);
      lines.push(...report.lines);
      if (report.ok && d.status.toLowerCase() !== "posted") {
        await this.store.set(d.path, { dry_run_hash: this.mac("dry-run", d) }, d.fileHash);
        lines.push("dry run recorded for this exact text");
      }
    }
    return lines.join("\n");
  }

  private dryRunProblem(d: Draft): string | undefined {
    return d.dryRunHash && d.dryRunHash === this.mac("dry-run", d) ? undefined : `no live dry run covers this exact text; run \`carl post dry-run ${basename(d.path, ".md")}\` (not --offline) first, or pass --skip-dry-run`;
  }

  /** Post now. Refuses without a current approval and a live dry run. Resumes a half-posted thread; never reposts a part already live. */
  async postNow(ref: string, opts: { named?: boolean; skipDryRun?: boolean } = {}): Promise<string> {
    return this.publish(this.resolve(ref, opts), { skipDryRun: opts.skipDryRun });
  }

  private async publish(path: string, opts: PublishOpts): Promise<string> {
    return this.withLock(path, async () => {
      this.assertRelay();
      const d = readDraft(path);
      const name = basename(path);
      if (d.status.toLowerCase() === "posted") throw new PostError(`${name} is already marked Posted; refusing to post it twice`, true);
      const gate = this.problem(d);
      if (gate) throw new PostError(`refused: ${name}: ${gate}`, true);
      const { ctx, rendered, adapter } = this.prepare(d);
      if (!opts.skipDryRun) {
        const dry = this.dryRunProblem(d);
        if (dry) throw new PostError(`refused: ${name}: ${dry}`, true);
      }
      // Carl's own record (state/post-ledger.jsonl) backs the draft's: an editor's stale save of the draft cannot erase a click or a live post.
      const eff = this.effective(d, rendered);
      const key = eff.key;
      if (eff.recoverBlock) throw new PostError(`refused: ${name}: ${eff.recoverBlock}`, true);
      const edited = this.liveEdit(d, rendered, eff.hashes);
      if (edited) throw new PostError(`refused: ${name}: ${edited}`, true);
      const done = eff.urls;
      // One approval posts once: after a click was made under it, only finishing that same post (parts already live, or a click
      // pending) may continue; starting over (say after a clear-pending) needs a fresh press.
      const approvalId = `${canon(path)}|${d.approved}`;
      if (this.consumed.has(approvalId) && !done.length && !eff.pending) throw new PostError(`refused: ${name}: the approval was already used for a post attempt; approve it again`, true);
      const pendingPart = eff.pending?.part;
      const pendingAt = eff.pending?.atMs ?? 0;
      const pendingBaseline = eff.pending?.baseline;
      let token = d.fileHash;
      const set = async (props: Record<string, string | undefined>) => { token = await this.store.set(path, props, token); };
      const stamp = () => new Date(this.now()).toISOString();
      const resumed = done.length;
      try {
        // Every part was already recorded live (a run died between the last part and the Posted record): just record it.
        const urls = done.length >= rendered.sequence.length && pendingPart === undefined
          ? done
          : await adapter.post(ctx, rendered, {
            done,
            approvedAtMs: approvedAt(d),
            pending: pendingPart !== undefined ? { part: pendingPart, atMs: pendingAt, baseline: pendingBaseline } : undefined,
            onBeforeClick: async (part, baseline) => {
              this.ledgerAppend({ key, event: "click", part, atMs: this.now(), baseline });
              try {
                await set({ pending_part: String(part), pending_at: stamp(), pending_baseline: baseline });
              } catch (e) {
                // Nothing is clicked when this throws, so the click event just written must not stand (it would wedge the draft).
                this.ledgerAppend({ key, event: "cleared", by: "carl: the pending record could not be written, nothing was clicked" });
                throw e;
              }
              this.consumed.add(approvalId); // a click is now under way: this approval is spent
            },
            onPart: (urls) => {
              const hashes = urls.map((_, i) => partHash(rendered.sequence[i]));
              this.ledgerAppend({ key, event: "live", urls, hashes, approved: d.approved ?? "" });
              const props: Record<string, string | undefined> = {
                thread_urls: urls.join(","), post_url: urls[0], part_hashes: hashes.join(","),
                pending_part: undefined, pending_at: undefined, pending_baseline: undefined,
              };
              if (!d.isThread && urls[1]) props.reply_url = urls[1];
              return set(props);
            },
          } satisfies PostRun);
        if (urls.length > d.threadUrls.length && done === urls) {
          // Recovered from the ledger: put the draft's own record right too.
          await set({ thread_urls: urls.join(","), post_url: urls[0], part_hashes: urls.map((_, i) => partHash(rendered.sequence[i])).join(","), pending_part: undefined, pending_at: undefined, pending_baseline: undefined });
        }
        await set({ status: "Posted", posted_at: stamp(), last_error: undefined, schedule_note: undefined });
        return `Posted ${name}${opts.note ? ` (${opts.note})` : ""}:\n${urls.join("\n")}${resumed ? `\n(resumed after ${resumed} part(s) already live)` : ""}`;
      } catch (e) {
        try { await this.store.set(path, { last_error: `${stamp()} ${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}` }); } catch {}
        throw e;
      }
    });
  }

  // ---- Carl's own durable record of clicks and live posts (the draft file can be overwritten by a stale editor save) ----

  private ledgerFile = () => join(this.deps.home, "state", "post-ledger.jsonl");
  private ledgerKey = (path: string, first: string) => sha256(`${canon(path)}\0${partHash(first)}`).slice(0, 16);
  private ledgerAppend(e: Record<string, unknown>): void {
    const file = this.ledgerFile();
    mkdirSync(join(this.deps.home, "state"), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(file);
    const fd = openSync(file, "a", 0o600);
    try { appendFileSync(fd, JSON.stringify({ at: new Date(this.now()).toISOString(), ...e }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    if (fresh) syncDir(join(this.deps.home, "state"));
  }
  private ledgerRead(key: string): { pending?: { part: number; atMs: number; at?: string; baseline?: string }; live: string[]; hashes: string[]; approved?: string } {
    const out: ReturnType<PostService["ledgerRead"]> = { live: [], hashes: [] };
    let raw = "";
    try { raw = readFileSync(this.ledgerFile(), "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw new PostError(`Carl's own record ${this.ledgerFile()} cannot be read (${(e as Error).message}); nothing is posted until it can be, because a click or a live post recorded there would be missed`, true);
    }
    for (const line of raw.split("\n")) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.key !== key) continue;
      if (e.event === "click") out.pending = { part: e.part, atMs: e.atMs, at: e.at, baseline: e.baseline };
      else if (e.event === "cleared") out.pending = undefined;
      else if (e.event === "live" && Array.isArray(e.urls)) { out.live = e.urls; out.hashes = e.hashes ?? []; out.approved = e.approved; out.pending = undefined; }
    }
    return out;
  }

  /**
   * What is true of a draft, from the draft and Carl's own ledger together: the live URLs and their text hashes, and any click
   * started and never recorded. Every path (post, cards, status, schedule) reads this one view. It refuses when the ledger says a
   * part went live with text other than what the draft holds now.
   */
  private effective(d: Draft, rendered: Rendered): { key: string; urls: string[]; hashes: string[]; pending?: { part: number; atMs: number; at?: string; baseline?: string }; recoverBlock?: string } {
    const key = this.ledgerKey(d.path, rendered.sequence[0]);
    const led = this.ledgerRead(key);
    const name = basename(d.path);
    let urls = d.threadUrls;
    let recoverBlock: string | undefined;
    if (led.live.length > urls.length) {
      if (!urls.every((u, i) => led.live[i] === u)) throw new PostError(`${name}: the draft's recorded URLs disagree with Carl's own record (state/post-ledger.jsonl); check the profile and fix the draft with \`carl post record-live\``, true);
      urls = led.live;
      // The same approval that posted them: a stale editor save lost the record. A different approval of the same text from the same
      // file is a repost (the old post may have been deleted): Carl will not tell the two apart on its own.
      if ((led.approved ?? "") !== (d.approved ?? "")) recoverBlock = `Carl's own record shows ${led.live.length} part(s) of this exact text already posted from this file under an earlier approval (${led.live[0]}). If that post was deleted and you want it posted again, save the draft under a new name or change the text; if the draft only lost its record, open the profile and restore it by hand: put the live URLs in the draft's thread_urls (comma-separated, in order), their hashes in part_hashes, and status: Posted when every part is live (\`carl post record-live\` records only the next part, so it cannot help when that part is not live or every part already is)`;
    }
    for (let i = 0; i < led.hashes.length && i < rendered.sequence.length; i++) {
      if (led.hashes[i] !== partHash(rendered.sequence[i])) throw new PostError(`${name}: part ${i + 1} went live with different text than the draft holds now (Carl's own record, state/post-ledger.jsonl); restore the text that is live (the later parts reply to it)`, true);
    }
    const hashes = led.hashes.length > d.partHashes.length ? led.hashes : d.partHashes;
    let pending: { part: number; atMs: number; at?: string; baseline?: string } | undefined;
    if (d.pendingPart !== undefined) pending = { part: d.pendingPart, atMs: Date.parse(d.pendingAt ?? "") || 0, at: d.pendingAt, baseline: d.pendingBaseline };
    else if (led.pending && led.pending.part === urls.length) pending = led.pending;
    return { key, urls, hashes, pending, recoverBlock };
  }

  /**
   * Record the operator's approval of the draft's current text. Called only after the operator answered an approval card
   * (see cards.ts); the agent's tool and the CLI have no path to it. `expected` is the text hash of what the operator was shown:
   * if the file is anything else now, nothing is approved.
   */
  async approve(ref: string, by: string, expected?: string): Promise<string> {
    const d = this.load(ref);
    if (d.status.toLowerCase() === "posted") throw new PostError(`${basename(d.path)} is already Posted`, true);
    if (expected !== undefined && d.textHash !== expected) throw new PostError(`${basename(d.path)} changed after it was shown to you; nothing was approved. Read it again and approve again`, true);
    const { rendered } = this.prepare(d); // an invalid draft is not approved
    const eff = this.effective(d, rendered);
    if (eff.pending) throw new PostError(`${basename(d.path)}: a click on part ${eff.pending.part + 1} was started and never recorded; settle it first (\`carl post record-live\` or \`carl post clear-pending\`), then approve`, true);
    const edited = this.liveEdit(d, rendered, eff.hashes);
    if (edited) throw new PostError(`${basename(d.path)}: ${edited}`, true);
    const who = by.trim();
    if (!who || ISO_DATE.test(who)) throw new PostError("approval needs a name (--by <name>)", true);
    const stamp = `${who} ${new Date(this.now()).toISOString()}`;
    for (const id of [...this.consumed]) if (id.startsWith(`${canon(d.path)}|`)) this.consumed.delete(id); // a fresh approval is a fresh one-time permission
    await this.store.set(d.path, { approved: stamp, approved_hash: this.mac("approve", d, stamp), status: d.status === "Draft" ? "Ready" : d.status }, d.fileHash);
    this.deps.scheduler?.clearSkipDryRun(d.path); // an earlier --skip-dry-run belonged to the earlier approval
    return `Approved ${basename(d.path)}: ${stamp}\ntext hash ${d.textHash.slice(0, 12)}; editing the draft clears this approval.`;
  }

  // ---- Operator cards: approve, clear-pending and record-live are decided on an operator channel, never by a caller ----

  /** What the operator is shown for a card, and the keyed value the answer is bound to. Throws a final PostError when the card cannot be acted on. */
  describeCard(card: CardRequest): { text: string; bind: string; hash: string } {
    const d = readDraft(card.draft);
    const name = basename(d.path);
    const { rendered, adapter, account } = this.prepare(d);
    const eff = this.effective(d, rendered);
    const where = `${d.platform}/${d.account} (${account.profile})`;
    const asked = `Asked by: ${card.by === "agent" ? "THE AGENT (not you)" : "you (carl post)"}`;
    const parts = rendered.sequence.map((t, i) => `[${i + 1}]${i < eff.hashes.length ? " (ALREADY LIVE, cannot be changed)" : ""} ${visible(t)}`).join("\n\n");
    if (d.status.toLowerCase() === "posted") throw new PostError(`${name} is already Posted`, true);
    if (card.kind === "approve") {
      if (eff.pending) throw new PostError(`${name}: a click on part ${eff.pending.part + 1} was started and never recorded; settle it first (record-live or clear-pending)`, true);
      const edited = this.liveEdit(d, rendered, eff.hashes);
      if (edited) throw new PostError(`${name}: ${edited}`, true);
      return { text: `Approve posting to ${where}\n${asked}\nDraft ${name}, text hash ${d.textHash.slice(0, 12)}\n\n${parts}`, bind: this.mac("card", d, { kind: "approve", hash: d.textHash }), hash: d.textHash };
    }
    if (card.kind === "post-now") {
      if (eff.pending) throw new PostError(`${name}: a click on part ${eff.pending.part + 1} was started and never recorded; settle it first (record-live or clear-pending)`, true);
      const edited = this.liveEdit(d, rendered, eff.hashes);
      if (edited) throw new PostError(`${name}: ${edited}`, true);
      if (eff.recoverBlock) throw new PostError(`${name}: ${eff.recoverBlock}`, true);
      if (!card.skipDryRun) { const dry = this.dryRunProblem(d); if (dry) throw new PostError(`${name}: ${dry}`, true); }
      this.assertRelay();
      return { text: `POST NOW to ${where}\n${asked}\nDraft ${name}, text hash ${d.textHash.slice(0, 12)}\nAllowing this posts the text below immediately.\n\n${parts}`, bind: this.mac("card", d, { kind: "post-now", hash: d.textHash, skip: !!card.skipDryRun }), hash: d.textHash };
    }
    if (card.kind === "clear-pending") {
      if (!eff.pending) throw new PostError(`${name} has no pending part`, true);
      const part = eff.pending.part;
      return {
        text: `A click on part ${part + 1} of ${name} was started${eff.pending.at ? ` at ${eff.pending.at}` : ""} and never recorded.\nAccount ${where}\n${asked}\n\n${parts}\n\nOnly allow this if part ${part + 1} is CERTAINLY NOT on the profile. Clearing removes the record of the started click; the next run looks for the part on the profile first and clicks Post for it only if it is not there.`,
        bind: this.mac("card", d, { kind: "clear-pending", part, at: eff.pending.at ?? null, baseline: eff.pending.baseline ?? null }),
        hash: d.textHash,
      };
    }
    // record-live
    const url = card.url ?? "";
    const part = eff.urls.length;
    if (part >= rendered.sequence.length) throw new PostError(`${name}: every part is already recorded live`, true);
    const bad = adapter.checkLiveUrl(account, url, eff.urls);
    if (bad) throw new PostError(`${name}: ${bad}`, true);
    return {
      text: `Record part ${part + 1} of ${name} as already live\nAccount ${where}\n${asked}\nURL ${url}\n\n[${part + 1}] ${visible(rendered.sequence[part])}\n\nOnly allow this if that URL really is this exact text, posted by this account.`,
      bind: this.mac("card", d, { kind: "record-live", part, url }),
      hash: d.textHash,
    };
  }

  /** Carry out a card the operator answered yes to. The bound value must still match what is on disk now. */
  async applyCard(card: CardRequest, bind: string, by: string): Promise<string> {
    const now = this.describeCard(card);
    if (now.bind !== bind) throw new PostError("the draft changed after the card was shown to you; nothing was done. Ask again", true);
    const path = card.draft;
    // The text hash the card was just checked against (not a fresh read): an edit after this point is refused by approve.
    if (card.kind === "approve") return this.approve(path, by, now.hash);
    if (card.kind === "post-now") {
      await this.approve(path, by, now.hash);
      return this.publish(path, { skipDryRun: card.skipDryRun });
    }
    return this.withLock(path, async () => {
      const d = readDraft(path);
      if (this.describeCard(card).bind !== bind) throw new PostError("the draft changed after the card was shown to you; nothing was done. Ask again", true);
      const { rendered } = this.prepare(d);
      const eff = this.effective(d, rendered);
      const key = eff.key;
      if (card.kind === "clear-pending") {
        this.ledgerAppend({ key, event: "cleared", by });
        await this.store.set(path, { pending_part: undefined, pending_at: undefined, pending_baseline: undefined }, d.fileHash);
        return `Cleared the pending record for part ${eff.pending!.part + 1} of ${basename(path)}. The next run will post it if it is not live.`;
      }
      const urls = [...eff.urls, card.url!];
      const hashes = urls.map((_, i) => partHash(rendered.sequence[i]));
      this.ledgerAppend({ key, event: "live", urls, hashes, by, approved: d.approved ?? "" });
      const props: Record<string, string | undefined> = { thread_urls: urls.join(","), post_url: urls[0], part_hashes: hashes.join(","), pending_part: undefined, pending_at: undefined, pending_baseline: undefined };
      if (urls.length >= rendered.sequence.length) { props.status = "Posted"; props.posted_at = new Date(this.now()).toISOString(); props.last_error = undefined; props.schedule_note = undefined; }
      await this.store.set(path, props, d.fileHash);
      return `Recorded part ${urls.length} of ${basename(path)} as live: ${card.url}${urls.length >= rendered.sequence.length ? "\nEvery part is live; the draft is marked Posted." : ""}`;
    });
  }

  /** Schedule an approved draft. Approval is checked here and again when it fires. The agent may only give a draft its first slot. */
  async schedule(ref: string, at: string, opts: { late?: "skip" | "post"; named?: boolean; agent?: boolean; skipDryRun?: boolean } = {}): Promise<{ job: Job; text: string }> {
    const scheduler = this.deps.scheduler;
    if (!scheduler) throw new PostError("scheduling needs the scheduler (run it through the gateway or the CLI)", true);
    const d = this.load(ref, opts);
    const name = basename(d.path);
    if (d.status.toLowerCase() === "posted") throw new PostError(`${name} is already Posted`, true);
    if (opts.agent && opts.late) throw new PostError("only the operator can choose to post a missed slot late", true);
    if (opts.agent && (d.scheduledAt || scheduler.list().some((j) => j.post?.draft === d.path && j.enabled))) throw new PostError(`refused: ${name} already has a slot; only the operator can change it (\`carl post schedule\`)`, true);
    const gate = this.problem(d);
    if (gate) throw new PostError(`refused: ${name}: ${gate}`, true);
    const { rendered } = this.prepare(d);
    const eff = this.effective(d, rendered);
    const edited = this.liveEdit(d, rendered, eff.hashes);
    if (edited) throw new PostError(`refused: ${name}: ${edited}`, true);
    if (!opts.skipDryRun) {
      const dry = this.dryRunProblem(d);
      if (dry) throw new PostError(`refused: ${name}: ${dry}`, true);
    }
    const when = Date.parse(at);
    if (Number.isNaN(when)) throw new PostError(`--at "${at}" is not an ISO time (for example 2026-01-31T09:00:00Z)`, true);
    if (when <= this.now()) throw new PostError(`--at ${at} is in the past; use \`carl post now\` to post immediately`, true);
    if (opts.agent && when < this.now() + AGENT_MIN_LEAD_MS) throw new PostError(`a slot the agent sets must be at least ${AGENT_MIN_LEAD_MS / 60_000} minutes away, so the operator can look first (got ${dur(when - this.now())}); pick a later time`, true);
    const iso = new Date(when).toISOString();
    const expires = approvedAt(d) + APPROVAL_TTL_MS;
    if (when > expires) throw new PostError(`--at ${at} is after this approval expires (${new Date(expires).toISOString()}; an approval lasts ${APPROVAL_TTL_MS / 3600_000} h and a gateway restart voids it); approve again closer to the slot`, true);
    for (const old of scheduler.list()) if (old.post?.draft === d.path && old.enabled) scheduler.remove(old.id);
    const job = scheduler.add({ name: `post ${basename(d.path, ".md")}`, when: `once ${iso}`, post: { draft: d.path, ...(opts.late === "post" ? { late: "post" as const } : {}), ...(opts.skipDryRun ? { skipDryRun: true } : {}) }, deliver: "home" });
    try {
      await this.store.set(d.path, { status: "Scheduled", scheduled_at: iso, schedule_note: undefined }, d.fileHash);
    } catch (e) {
      scheduler.remove(job.id);
      throw e;
    }
    if (opts.agent) {
      // The operator must know a post is coming: if they cannot be told, there is no slot.
      try {
        await this.deps.notify?.(`The agent scheduled ${name} to post to ${d.platform}/${d.account} at ${iso}. The text is the one you approved. To stop it, remove the schedule or edit the draft (an edit voids the approval).`);
      } catch (e) {
        scheduler.remove(job.id);
        try { await this.store.set(d.path, { status: d.status, scheduled_at: undefined }); } catch {}
        throw new PostError(`the operator could not be told about this slot (${(e as Error).message}), so it was not kept; try again`);
      }
    }
    const policy = opts.late === "post" ? "posts late if the slot is missed" : `skips the slot if missed by more than ${dur(this.deps.config.missedWindowMinutes * 60_000)}`;
    return { job, text: `Scheduled ${name} for ${iso} (${policy}). Job ${job.id}.` };
  }

  /**
   * The scheduler's runner for a post job. Returns the message to deliver; throws PostError (final = no retry).
   * Before the slot it refuses unless the operator forces it.
   */
  async runScheduled(job: Job, opts: { force?: boolean } = {}): Promise<string> {
    if (!job.post) throw new PostError("job has no post", true);
    const path = job.post.draft;
    const d = readDraft(path);
    const name = basename(path);
    const slot = Date.parse(job.when.replace(/^once\s+/i, ""));
    if (d.status.toLowerCase() === "posted") return `${name} is already Posted${d.postUrl ? `: ${d.postUrl}` : ""}; nothing to do.`;
    if (!opts.force && this.now() < slot) throw new PostError(`${name}: the slot ${new Date(slot).toISOString()} has not arrived; nothing was posted`);
    const gate = this.problem(d);
    if (gate) throw new PostError(`Not posted: ${name}: ${gate}`, true);
    const eff = this.effective(d, this.prepare(d).rendered);
    const started = eff.urls.length > 0 || eff.pending !== undefined; // a click was started: never skip it silently
    if (d.status !== "Scheduled" && !started) return `Not posted: ${name} is no longer Scheduled (status ${d.status}); the slot ${new Date(slot).toISOString()} was left alone.`;
    if (d.scheduledAt && Date.parse(d.scheduledAt) !== slot && !started) return `Not posted: ${name} was rescheduled to ${d.scheduledAt}; this slot (${new Date(slot).toISOString()}) is stale.`;
    const late = this.now() - slot;
    const window = this.deps.config.missedWindowMinutes * 60_000;
    // A thread already partly live (or with a click under way) is finished or checked whatever the lateness.
    if (!started && late > window && job.post.late !== "post") {
      const note = `skipped ${new Date(this.now()).toISOString()}: slot ${new Date(slot).toISOString()} missed by ${dur(late)} (window ${dur(window)})`;
      try { await this.store.set(path, { schedule_note: note }, d.fileHash); } catch {}
      return `Skipped ${name}: it was scheduled for ${new Date(slot).toISOString()} and Carl could not post it until ${dur(late)} later, past the ${dur(window)} window. It is still Scheduled and was NOT posted. Reschedule it with \`carl post schedule\` or post it with \`carl post now\`.`;
    }
    return this.publish(path, { note: late > 60_000 && !started ? `${dur(late)} late` : undefined, skipDryRun: job.post.skipDryRun });
  }

  /** Put a card in front of the operator (it is shown on their channel by the gateway). It records nothing by itself. */
  requestCard(kind: CardKind, ref: string, opts: { named?: boolean; url?: string; skipDryRun?: boolean; by: "operator" | "agent" }): string {
    const draft = this.resolve(ref, { named: opts.named });
    if (!existsSync(draft)) throw new PostError(`no draft at ${draft}`, true);
    const card = { id: "", kind, draft, ...(opts.url ? { url: opts.url } : {}), ...(opts.skipDryRun ? { skipDryRun: true } : {}), by: opts.by, at: new Date(this.now()).toISOString() };
    this.describeCard(card); // refuses now what could never be approved
    const made = new CardStore(this.deps.home, () => this.now()).add(card);
    return `${made.fresh ? "Asked" : "Already asked"}: card ${made.card.id} (${kind} ${basename(draft)}) waits for your answer on the operator channel (Telegram, the home chat). Nothing is ${kind === "approve" ? "approved" : kind === "post-now" ? "posted" : "changed"} until you answer it.`;
  }

  /** The agent's tool: a new draft. It cannot carry approval; the operator approves with the CLI. */
  createDraft(spec: { name: string; platform: string; account: string; text?: string; thread?: string[]; reply?: string }): string {
    if (!NAME.test(spec.name)) throw new PostError(`draft names are lowercase letters, digits, . _ - (got "${spec.name}")`, true);
    const account = this.deps.config.accounts[spec.account];
    if (!account) throw new PostError(`account "${spec.account}" is not configured (carl.json post.accounts: ${Object.keys(this.deps.config.accounts).join(", ") || "none"})`, true);
    if (account.platform !== spec.platform) throw new PostError(`account "${spec.account}" is a ${account.platform} account, not ${spec.platform}`, true);
    const thread = (spec.thread ?? []).map((t) => t.trim()).filter(Boolean);
    if (!thread.length && !spec.text?.trim()) throw new PostError("a draft needs text or thread parts", true);
    if (thread.length && spec.text?.trim()) throw new PostError("give text or thread parts, not both", true);
    const q = (s: string) => JSON.stringify(s);
    const lines = ["---", `platform: ${spec.platform}`, `account: ${spec.account}`, "status: Draft"];
    if (thread.length) lines.push("thread:", ...thread.map((t) => `  - ${q(t)}`));
    else lines.push(`text: ${q(spec.text!.trim())}`);
    if (spec.reply?.trim() && !thread.length) lines.push(`reply: ${q(spec.reply.trim())}`);
    lines.push("---", "");
    const path = join(this.deps.config.draftsDir, `${spec.name}.md`);
    mkdirSync(this.deps.config.draftsDir, { recursive: true, mode: 0o700 });
    if (existsSync(path)) throw new PostError(`${spec.name}.md already exists; pick another name`, true);
    writeFileSync(path, lines.join("\n"), { mode: 0o600, flag: "wx" });
    const d = readDraft(path);
    const { rendered } = (() => { try { return this.prepare(d); } catch (e) { rmSync(path); throw e; } })();
    return `Created ${spec.name}.md (${rendered.sizes.join(", ")} chars). It needs the operator's approval (\`carl post approve ${spec.name}\`) before it can be scheduled or posted.`;
  }

  status(): string {
    const dir = this.deps.config.draftsDir;
    const out: string[] = [];
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
    for (const f of files) {
      try {
        const d = readDraft(join(dir, f));
        const gate = this.problem(d);
        let live = d.threadUrls.length; let pend = d.pendingPart;
        try { const eff = this.effective(d, this.prepare(d).rendered); live = eff.urls.length; pend = eff.pending?.part; } catch { /* shown from the draft alone; the refusal itself appears when it is acted on */ }
        const late = d.status === "Scheduled" && d.scheduledAt && Date.parse(d.scheduledAt) < this.now() ? " (slot passed)" : "";
        out.push(`${f.replace(/\.md$/, "").padEnd(28)} ${d.status.padEnd(10)} ${d.platform}/${d.account} ${gate ? "unapproved" : "approved"}${d.scheduledAt ? ` at ${d.scheduledAt}${late}` : ""}${live ? ` live ${live}/${d.isThread ? d.parts.length : d.parts.length + (d.reply ? 1 : 0)}` : ""}${pend !== undefined ? ` [PENDING part ${pend + 1}: a click was started; check the profile, then carl post record-live or clear-pending]` : ""}${d.fields.schedule_note ? ` [${d.fields.schedule_note}]` : ""}${d.fields.last_error ? ` [error: ${String(d.fields.last_error).slice(0, 80)}]` : ""}`);
      } catch (e) {
        out.push(`${f}: unreadable (${(e as Error).message})`);
      }
    }
    const cards = new CardStore(this.deps.home, () => this.now()).list();
    const problems = this.deps.sessionProblems?.() ?? [];
    const jobs = (this.deps.scheduler?.list() ?? []).filter((j) => j.post);
    return [...problems.map((p) => `SESSION COMMAND PROBLEM: ${p}`), out.length ? out.join("\n") : `No drafts in ${dir}.`, ...(cards.length ? ["", "Waiting for your answer on the operator channel:", ...cards.map((c) => `${c.id} ${c.kind} ${basename(c.draft)}${c.url ? ` ${c.url}` : ""}`)] : []), ...(jobs.length ? ["", "Scheduled posts:", ...jobs.map((j) => `${j.id} ${j.enabled ? "on " : "off"} ${basename(j.post!.draft)} ${j.when} last=${j.lastStatus ?? "-"}${j.lastError ? ` (${j.lastError.slice(0, 80)})` : ""}${j.post!.late === "post" ? " late:post" : ""}`)] : [])].join("\n");
  }

  /** One run per draft at a time (the CLI and the scheduler could otherwise both post it). */
  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const dir = join(this.deps.home, "state", "post-locks");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, `${sha256(canon(path)).slice(0, 16)}.lock`);
    const busy = () => new PostError(`${basename(path)} is being posted by another run (lock ${lock}); wait for it, or delete the lock if it is stale`);
    const take = () => writeFileSync(lock, `${process.pid} ${this.now()}\n`, { flag: "wx", mode: 0o600 });
    try {
      take();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let seen = ""; let age = Infinity;
      try { seen = readFileSync(lock, "utf8"); age = Date.now() - statSync(lock).mtimeMs; } catch {}
      // Only a dead owner's lock is taken over; a long run (a slow browser) keeps it. A lock still being written is given a moment.
      if (seen ? alive(Number(seen.split(" ")[0])) : age < 10_000) throw busy();
      // Take over a stale lock atomically: renaming it aside succeeds for one contender only, and a lock that turns out
      // to be a fresh one (another contender won first) is put back.
      const aside = `${lock}.stale-${process.pid}-${randomBytes(3).toString("hex")}`;
      try { renameSync(lock, aside); } catch { throw busy(); }
      let moved = "";
      try { moved = readFileSync(aside, "utf8"); } catch {}
      if (moved !== seen) { try { renameSync(aside, lock); } catch {} throw busy(); }
      rmSync(aside, { force: true });
      try { take(); } catch { throw busy(); }
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

export { textHash };
