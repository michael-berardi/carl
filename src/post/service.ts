// The post pipeline: draft record -> render and validate (dry run) -> post -> verify the live URL -> record the outcome.
// Approval is a hard gate in front of every live or scheduled post, and is bound to the draft's current text.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { PostConfig } from "../config.ts";
import type { Job, Scheduler } from "../scheduler.ts";
import { BAD_CHARS, type Draft, DraftStore, readDraft, sha256, textHash, visible } from "./draft.ts";
import { agentCanWrite, canon, ensureKey, hmac } from "./key.ts";
import type { AdapterRegistry } from "./registry.ts";
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
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** Why this draft may not be posted, or undefined when the operator's approval covers its current text. `expected` is the keyed binding hash. */
export function approvalProblem(d: Draft, expected?: string): string | undefined {
  if (!d.approved?.trim()) return "no operator approval is recorded (run `carl post approve`)";
  const who = d.approved.replace(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*(?:Z|[+-]\d{2}:?\d{2})?/, "").replace(/\b(?:at|on|by)\b/gi, "").trim();
  if (!ISO_DATE.test(d.approved) || !who) return `approval "${d.approved}" must name who and when (for example "alice 2026-01-31T09:00:00Z"); approve it again with \`carl post approve\``;
  if (!d.approvedHash) return "the approval does not record which text it covered; approve it again";
  if (expected === undefined || d.approvedHash !== expected) return "the draft was edited after it was approved (or the approval was not made by this Carl); approve it again";
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
  private keyCache?: string;
  constructor(deps: PostDeps) {
    this.deps = deps;
    this.store = new DraftStore(deps.run, deps.config.retex === "auto");
  }

  private now = () => (this.deps.now ?? Date.now)();
  /** The approval key, created (0600) on first use. The gateway creates it at start. */
  ensureKey(): string { return (this.keyCache ??= ensureKey(this.deps.home)); }

  /** What approval and the dry run are bound to: where (platform, account, profile) and what (every part, the reply), keyed. */
  bind(d: Draft): string {
    const profile = this.deps.config.accounts[d.account]?.profile ?? "";
    return hmac(this.ensureKey(), JSON.stringify({ v: 2, platform: d.platform, account: d.account, profile, parts: d.parts.map((p) => p.trim()), thread: d.isThread, reply: d.reply?.trim() ?? null }));
  }
  /** Why this draft may not be posted (approval, keyed). */
  problem(d: Draft): string | undefined { return approvalProblem(d, this.bind(d)); }

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
    if (d.isThread && d.fields.reply !== undefined && String(d.fields.reply).trim()) throw new PostError(`${n}: a thread's \`reply\` is not posted; put it in the thread as another part`, true);
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
  private liveEdit(d: Draft, rendered: Rendered): string | undefined {
    for (let i = 0; i < d.partHashes.length && i < rendered.sequence.length; i++) {
      if (d.partHashes[i] !== partHash(rendered.sequence[i])) return `part ${i + 1} is already live and its text was edited since; restore the live text (the later parts reply to it)`;
    }
    return undefined;
  }

  /** Render and validate (no side effects); with `offline` false the adapter also proves the platform takes the exact text, then discards it. No approval needed. */
  async dryRun(ref: string, opts: { offline?: boolean; named?: boolean } = {}): Promise<string> {
    const d = this.load(ref, opts);
    const { ctx, rendered, adapter } = this.prepare(d);
    const lines = [`${basename(d.path)}: ${d.platform}/${d.account}, ${rendered.sequence.length} text(s), sizes ${rendered.sizes.join(", ")}`];
    const gate = this.problem(d);
    lines.push(gate ? `approval: not ready (${gate})` : `approval: ${d.approved}`);
    if (d.status === "Posted") lines.push("status: already Posted; it cannot be posted again");
    if (opts.offline) lines.push("offline: text rendered and validated; the platform was not contacted. A live dry run (not offline) is still required before posting");
    else {
      const report = await adapter.dryRun(ctx, rendered);
      lines.push(...report.lines);
      if (report.ok && d.status.toLowerCase() !== "posted") {
        await this.store.set(d.path, { dry_run_hash: this.bind(d) }, d.fileHash);
        lines.push("dry run recorded for this exact text");
      }
    }
    return lines.join("\n");
  }

  private dryRunProblem(d: Draft): string | undefined {
    return d.dryRunHash && d.dryRunHash === this.bind(d) ? undefined : `no live dry run covers this exact text; run \`carl post dry-run ${basename(d.path, ".md")}\` (not --offline) first, or pass --skip-dry-run`;
  }

  /** Post now. Refuses without a current approval and a live dry run. Resumes a half-posted thread; never reposts a part already live. */
  async postNow(ref: string, opts: { named?: boolean; skipDryRun?: boolean } = {}): Promise<string> {
    return this.publish(this.resolve(ref, opts), { skipDryRun: opts.skipDryRun });
  }

  private async publish(path: string, opts: PublishOpts): Promise<string> {
    return this.withLock(path, async () => {
      const d = readDraft(path);
      const name = basename(path);
      if (d.status.toLowerCase() === "posted") throw new PostError(`${name} is already marked Posted; refusing to post it twice`, true);
      const gate = this.problem(d);
      if (gate) throw new PostError(`refused: ${name}: ${gate}`, true);
      const { ctx, rendered, adapter } = this.prepare(d);
      const edited = this.liveEdit(d, rendered);
      if (edited) throw new PostError(`refused: ${name}: ${edited}`, true);
      if (!opts.skipDryRun) {
        const dry = this.dryRunProblem(d);
        if (dry) throw new PostError(`refused: ${name}: ${dry}`, true);
      }
      let token = d.fileHash;
      const set = async (props: Record<string, string | undefined>) => { token = await this.store.set(path, props, token); };
      const stamp = () => new Date(this.now()).toISOString();
      const resumed = d.threadUrls.length;
      try {
        // Every part was already recorded live (a run died between the last part and the Posted record): just record it.
        const urls = d.threadUrls.length >= rendered.sequence.length && d.pendingPart === undefined
          ? d.threadUrls
          : await adapter.post(ctx, rendered, {
            done: d.threadUrls,
            approvedAtMs: approvedAt(d),
            pending: d.pendingPart !== undefined ? { part: d.pendingPart, atMs: Date.parse(d.pendingAt ?? "") || 0 } : undefined,
            onBeforeClick: (part) => set({ pending_part: String(part), pending_at: stamp() }),
            onPart: (urls) => {
              const props: Record<string, string | undefined> = {
                thread_urls: urls.join(","), post_url: urls[0], part_hashes: urls.map((_, i) => partHash(rendered.sequence[i])).join(","),
                pending_part: undefined, pending_at: undefined,
              };
              if (!d.isThread && urls[1]) props.reply_url = urls[1];
              return set(props);
            },
          } satisfies PostRun);
        await set({ status: "Posted", posted_at: stamp(), last_error: undefined, schedule_note: undefined });
        return `Posted ${name}${opts.note ? ` (${opts.note})` : ""}:\n${urls.join("\n")}${resumed ? `\n(resumed after ${resumed} part(s) already live)` : ""}`;
      } catch (e) {
        try { await this.store.set(path, { last_error: `${stamp()} ${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}` }); } catch {}
        throw e;
      }
    });
  }

  /**
   * The operator records approval of the draft's current text. Only the CLI calls this; the agent's tool has no way to.
   * `expected` is the text hash of what the operator was shown: if the file is anything else now, nothing is approved.
   */
  async approve(ref: string, by: string, expected?: string): Promise<string> {
    const d = this.load(ref);
    if (d.status.toLowerCase() === "posted") throw new PostError(`${basename(d.path)} is already Posted`, true);
    if (expected !== undefined && d.textHash !== expected) throw new PostError(`${basename(d.path)} changed after it was shown to you; nothing was approved. Read it again and approve again`, true);
    const { rendered } = this.prepare(d); // an invalid draft is not approved
    const edited = this.liveEdit(d, rendered);
    if (edited) throw new PostError(`${basename(d.path)}: ${edited}`, true);
    const who = by.trim();
    if (!who || ISO_DATE.test(who)) throw new PostError("approval needs a name (--by <name>)", true);
    const stamp = `${who} ${new Date(this.now()).toISOString()}`;
    await this.store.set(d.path, { approved: stamp, approved_hash: this.bind(d), status: d.status === "Draft" ? "Ready" : d.status }, d.fileHash);
    return `Approved ${basename(d.path)}: ${stamp}\ntext hash ${d.textHash.slice(0, 12)}; editing the draft clears this approval.`;
  }

  /** Operator only: the operator checked the account and the pending part is not live; allow the draft to click again. */
  async clearPending(ref: string): Promise<string> {
    const path = this.resolve(ref);
    return this.withLock(path, async () => {
      const d = readDraft(path);
      if (d.pendingPart === undefined) return `${basename(path)} has no pending part.`;
      await this.store.set(path, { pending_part: undefined, pending_at: undefined }, d.fileHash);
      return `Cleared the pending record for part ${d.pendingPart + 1} of ${basename(path)}. The next run will post it if it is not live.`;
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
    const edited = this.liveEdit(d, rendered);
    if (edited) throw new PostError(`refused: ${name}: ${edited}`, true);
    if (!opts.skipDryRun) {
      const dry = this.dryRunProblem(d);
      if (dry) throw new PostError(`refused: ${name}: ${dry}`, true);
    }
    const when = Date.parse(at);
    if (Number.isNaN(when)) throw new PostError(`--at "${at}" is not an ISO time (for example 2026-01-31T09:00:00Z)`, true);
    if (when <= this.now()) throw new PostError(`--at ${at} is in the past; use \`carl post now\` to post immediately`, true);
    const iso = new Date(when).toISOString();
    for (const old of scheduler.list()) if (old.post?.draft === d.path && old.enabled) scheduler.remove(old.id);
    const job = scheduler.add({ name: `post ${basename(d.path, ".md")}`, when: `once ${iso}`, post: { draft: d.path, ...(opts.late === "post" ? { late: "post" as const } : {}), ...(opts.skipDryRun ? { skipDryRun: true } : {}) }, deliver: "home" });
    try {
      await this.store.set(d.path, { status: "Scheduled", scheduled_at: iso, schedule_note: undefined }, d.fileHash);
    } catch (e) {
      scheduler.remove(job.id);
      throw e;
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
    const started = d.threadUrls.length > 0 || d.pendingPart !== undefined; // a click was started: never skip it silently
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
        const late = d.status === "Scheduled" && d.scheduledAt && Date.parse(d.scheduledAt) < this.now() ? " (slot passed)" : "";
        out.push(`${f.replace(/\.md$/, "").padEnd(28)} ${d.status.padEnd(10)} ${d.platform}/${d.account} ${gate ? "unapproved" : "approved"}${d.scheduledAt ? ` at ${d.scheduledAt}${late}` : ""}${d.threadUrls.length ? ` live ${d.threadUrls.length}/${d.isThread ? d.parts.length : d.parts.length + (d.reply ? 1 : 0)}` : ""}${d.pendingPart !== undefined ? ` [PENDING part ${d.pendingPart + 1}: a click was started; check the profile, then carl post clear-pending]` : ""}${d.fields.schedule_note ? ` [${d.fields.schedule_note}]` : ""}${d.fields.last_error ? ` [error: ${String(d.fields.last_error).slice(0, 80)}]` : ""}`);
      } catch (e) {
        out.push(`${f}: unreadable (${(e as Error).message})`);
      }
    }
    const jobs = (this.deps.scheduler?.list() ?? []).filter((j) => j.post);
    return [out.length ? out.join("\n") : `No drafts in ${dir}.`, ...(jobs.length ? ["", "Scheduled posts:", ...jobs.map((j) => `${j.id} ${j.enabled ? "on " : "off"} ${basename(j.post!.draft)} ${j.when} last=${j.lastStatus ?? "-"}${j.lastError ? ` (${j.lastError.slice(0, 80)})` : ""}${j.post!.late === "post" ? " late:post" : ""}`)] : [])].join("\n");
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
      if (seen && age < 45 * 60_000 && alive(Number(seen.split(" ")[0]))) throw busy();
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
