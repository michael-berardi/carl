// The post pipeline: draft record -> render and validate (dry run) -> post -> verify the live URL -> record the outcome.
// Approval is a hard gate in front of every live or scheduled post, and is bound to the draft's current text.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { PostConfig } from "../config.ts";
import type { Job, Scheduler } from "../scheduler.ts";
import { type Draft, DraftStore, readDraft, sha256, textHash } from "./draft.ts";
import type { AdapterRegistry } from "./registry.ts";
import { type AdapterContext, type PostAccount, PostError, type Rendered, type Runner } from "./types.ts";

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

/** Why this draft may not be posted, or undefined when the operator's approval covers its current text. */
export function approvalProblem(d: Draft): string | undefined {
  if (!d.approved?.trim()) return "no operator approval is recorded (run `carl post approve`)";
  const who = d.approved.replace(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*(?:Z|[+-]\d{2}:?\d{2})?/, "").replace(/\b(?:at|on|by)\b/gi, "").trim();
  if (!ISO_DATE.test(d.approved) || !who) return `approval "${d.approved}" must name who and when (for example "alice 2026-01-31T09:00:00Z"); approve it again with \`carl post approve\``;
  if (!d.approvedHash) return "the approval does not record which text it covered; approve it again";
  if (d.approvedHash !== d.textHash) return "the draft was edited after it was approved; approve it again";
  return undefined;
}

const dur = (ms: number) => {
  const m = Math.round(Math.abs(ms) / 60_000);
  return m >= 120 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

export class PostService {
  readonly deps: PostDeps;
  private readonly store: DraftStore;
  constructor(deps: PostDeps) {
    this.deps = deps;
    this.store = new DraftStore(deps.run, deps.config.retex === "auto");
  }

  private now = () => (this.deps.now ?? Date.now)();

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
    if (!d.platform) throw new PostError(`${basename(d.path)}: the draft has no platform`, true);
    if (!d.account) throw new PostError(`${basename(d.path)}: the draft has no account`, true);
    const account = this.deps.config.accounts[d.account];
    if (!account) throw new PostError(`${basename(d.path)}: account "${d.account}" is not in carl.json post.accounts`, true);
    if (account.platform !== d.platform) throw new PostError(`${basename(d.path)}: the draft says platform "${d.platform}" but account "${d.account}" is "${account.platform}"`, true);
    const adapter = this.deps.registry.get(d.platform);
    const rendered = adapter.render(d, account);
    if (rendered.problems.length) throw new PostError(`${basename(d.path)}: ${rendered.problems.join("; ")}`, true);
    const ctx: AdapterContext = {
      account,
      run: this.deps.run,
      sleep: this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      id: this.deps.id ?? (() => randomBytes(4).toString("hex")),
    };
    return { account, ctx, rendered, adapter };
  }

  /** Render and validate (no side effects); with `offline` false the adapter also proves the platform takes the exact text, then discards it. No approval needed. */
  async dryRun(ref: string, opts: { offline?: boolean; named?: boolean } = {}): Promise<string> {
    const d = this.load(ref, opts);
    const { ctx, rendered, adapter } = this.prepare(d);
    const lines = [`${basename(d.path)}: ${d.platform}/${d.account}, ${rendered.sequence.length} text(s), sizes ${rendered.sizes.join(", ")}`];
    const gate = approvalProblem(d);
    lines.push(gate ? `approval: not ready (${gate})` : `approval: ${d.approved}`);
    if (d.status === "Posted") lines.push("status: already Posted; it cannot be posted again");
    if (opts.offline) lines.push("offline: text rendered and validated; the platform was not contacted");
    else lines.push(...(await adapter.dryRun(ctx, rendered)).lines);
    return lines.join("\n");
  }

  /** Post now. Refuses without a current approval. Resumes a half-posted thread; never reposts a part already live. */
  async postNow(ref: string, opts: { named?: boolean } = {}): Promise<string> {
    return this.publish(this.resolve(ref, opts), {});
  }

  private async publish(path: string, opts: { note?: string }): Promise<string> {
    return this.withLock(path, async () => {
      const d = readDraft(path);
      if (d.status.toLowerCase() === "posted") throw new PostError(`${basename(path)} is already marked Posted; refusing to post it twice`, true);
      const gate = approvalProblem(d);
      if (gate) throw new PostError(`refused: ${basename(path)}: ${gate}`, true);
      const { ctx, rendered, adapter } = this.prepare(d);
      const resumed = d.threadUrls.length;
      try {
        const urls = await adapter.post(ctx, rendered, d.threadUrls, async (urls) => {
          const props: Record<string, string> = { thread_urls: urls.join(","), post_url: urls[0] };
          if (!d.isThread && urls[1]) props.reply_url = urls[1];
          await this.store.set(path, props);
        });
        await this.store.set(path, { status: "Posted", posted_at: new Date(this.now()).toISOString(), last_error: undefined, schedule_note: undefined });
        return `Posted ${basename(path)}${opts.note ? ` (${opts.note})` : ""}:\n${urls.join("\n")}${resumed ? `\n(resumed after ${resumed} part(s) already live)` : ""}`;
      } catch (e) {
        try { await this.store.set(path, { last_error: `${new Date(this.now()).toISOString()} ${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}` }); } catch {}
        throw e;
      }
    });
  }

  /** The operator records approval of the draft's current text. Only the CLI calls this; the agent's tool has no way to. */
  async approve(ref: string, by: string): Promise<string> {
    const d = this.load(ref);
    if (d.status.toLowerCase() === "posted") throw new PostError(`${basename(d.path)} is already Posted`, true);
    this.prepare(d); // an invalid draft is not approved
    const who = by.trim();
    if (!who || ISO_DATE.test(who)) throw new PostError("approval needs a name (--by <name>)", true);
    const stamp = `${who} ${new Date(this.now()).toISOString()}`;
    await this.store.set(d.path, { approved: stamp, approved_hash: d.textHash, status: d.status === "Draft" ? "Ready" : d.status });
    return `Approved ${basename(d.path)}: ${stamp}\ntext hash ${d.textHash.slice(0, 12)}; editing the draft clears this approval.`;
  }

  /** Schedule an approved draft. Approval is checked here and again when it fires. */
  async schedule(ref: string, at: string, opts: { late?: "skip" | "post"; named?: boolean } = {}): Promise<{ job: Job; text: string }> {
    const scheduler = this.deps.scheduler;
    if (!scheduler) throw new PostError("scheduling needs the scheduler (run it through the gateway or the CLI)", true);
    const d = this.load(ref, opts);
    if (d.status.toLowerCase() === "posted") throw new PostError(`${basename(d.path)} is already Posted`, true);
    const gate = approvalProblem(d);
    if (gate) throw new PostError(`refused: ${basename(d.path)}: ${gate}`, true);
    this.prepare(d);
    const when = Date.parse(at);
    if (Number.isNaN(when)) throw new PostError(`--at "${at}" is not an ISO time (for example 2026-01-31T09:00:00Z)`, true);
    if (when <= this.now()) throw new PostError(`--at ${at} is in the past; use \`carl post now\` to post immediately`, true);
    const iso = new Date(when).toISOString();
    for (const old of scheduler.list()) if (old.post?.draft === d.path && old.enabled) scheduler.remove(old.id);
    const job = scheduler.add({ name: `post ${basename(d.path, ".md")}`, when: `once ${iso}`, post: { draft: d.path, ...(opts.late === "post" ? { late: "post" as const } : {}) }, deliver: "home" });
    try {
      await this.store.set(d.path, { status: "Scheduled", scheduled_at: iso, schedule_note: undefined });
    } catch (e) {
      scheduler.remove(job.id);
      throw e;
    }
    const policy = opts.late === "post" ? "posts late if the slot is missed" : `skips the slot if missed by more than ${dur(this.deps.config.missedWindowMinutes * 60_000)}`;
    return { job, text: `Scheduled ${basename(d.path)} for ${iso} (${policy}). Job ${job.id}.` };
  }

  /** The scheduler's runner for a post job. Returns the message to deliver; throws PostError (final = no retry). */
  async runScheduled(job: Job): Promise<string> {
    if (!job.post) throw new PostError("job has no post", true);
    const path = job.post.draft;
    const d = readDraft(path);
    const name = basename(path);
    const slot = Date.parse(job.when.replace(/^once\s+/i, ""));
    if (d.status.toLowerCase() === "posted") return `${name} is already Posted${d.postUrl ? `: ${d.postUrl}` : ""}; nothing to do.`;
    const gate = approvalProblem(d);
    if (gate) throw new PostError(`Not posted: ${name}: ${gate}`, true);
    if (d.status !== "Scheduled" && !d.threadUrls.length) return `Not posted: ${name} is no longer Scheduled (status ${d.status}); the slot ${new Date(slot).toISOString()} was left alone.`;
    if (d.scheduledAt && Date.parse(d.scheduledAt) !== slot && !d.threadUrls.length) return `Not posted: ${name} was rescheduled to ${d.scheduledAt}; this slot (${new Date(slot).toISOString()}) is stale.`;
    const late = this.now() - slot;
    const window = this.deps.config.missedWindowMinutes * 60_000;
    // A thread already partly live is finished whatever the lateness: leaving it half posted is worse than finishing it.
    if (!d.threadUrls.length && late > window && job.post.late !== "post") {
      const note = `skipped ${new Date(this.now()).toISOString()}: slot ${new Date(slot).toISOString()} missed by ${dur(late)} (window ${dur(window)})`;
      try { await this.store.set(path, { schedule_note: note }); } catch {}
      return `Skipped ${name}: it was scheduled for ${new Date(slot).toISOString()} and Carl could not post it until ${dur(late)} later, past the ${dur(window)} window. It is still Scheduled and was NOT posted. Reschedule it with \`carl post schedule\` or post it with \`carl post now\`.`;
    }
    return this.publish(path, { note: late > 60_000 && !d.threadUrls.length ? `${dur(late)} late` : undefined });
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
        const gate = approvalProblem(d);
        const late = d.status === "Scheduled" && d.scheduledAt && Date.parse(d.scheduledAt) < this.now() ? " (slot passed)" : "";
        out.push(`${f.replace(/\.md$/, "").padEnd(28)} ${d.status.padEnd(10)} ${d.platform}/${d.account} ${gate ? "unapproved" : "approved"}${d.scheduledAt ? ` at ${d.scheduledAt}${late}` : ""}${d.threadUrls.length ? ` live ${d.threadUrls.length}/${d.isThread ? d.parts.length : d.parts.length + (d.reply ? 1 : 0)}` : ""}${d.fields.schedule_note ? ` [${d.fields.schedule_note}]` : ""}${d.fields.last_error ? ` [error: ${String(d.fields.last_error).slice(0, 80)}]` : ""}`);
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
    const lock = join(dir, `${sha256(path).slice(0, 16)}.lock`);
    const take = () => writeFileSync(lock, `${process.pid} ${this.now()}\n`, { flag: "wx", mode: 0o600 });
    try {
      take();
    } catch {
      const age = Date.now() - statSync(lock).mtimeMs;
      let alive = true;
      try { process.kill(Number(readFileSync(lock, "utf8").split(" ")[0]), 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive && age < 45 * 60_000) throw new PostError(`${basename(path)} is being posted by another run (lock ${lock}); wait for it, or delete the lock if it is stale`);
      rmSync(lock, { force: true });
      take();
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

export { textHash };
