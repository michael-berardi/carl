// Schedules: one JSON file, a 20-second tick, one catch-up run after downtime (never a burst).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextRun, parseSchedule } from "./cron.ts";
import type { Log } from "./log.ts";

export interface Job {
  id: string;
  name: string;
  /** "every 30m" | cron | "@daily" | "once <ISO time>" */
  when: string;
  /** Instruction for a fresh agent run. */
  prompt?: string;
  /** Shell command; its output is delivered without a model call. */
  command?: string;
  /** Built-in handler name (e.g. "individuation"). */
  builtin?: string;
  /** Set when a built-in was paused because another system owns its work (e.g. "learning"). */
  pausedBy?: string;
  /** "home" | "none" | chat id */
  deliver: string;
  enabled: boolean;
  onlyIfOutput?: boolean;
  model?: string;
  /** Command jobs: minutes before the run is killed (default 10, at most 240). */
  timeoutMinutes?: number;
  /**
   * Command jobs only, operator-set (the portal or schedules.json; the agent's schedule tool cannot set it): run outside
   * the shell sandbox, still with the clean environment. For an operator's own script that needs a credential store the
   * sandbox denies, such as cf's login.
   */
  unsandboxed?: boolean;
  /**
   * Post jobs only (the post primitive, src/post): fire this draft at `when` ("once <ISO>"). Set by the post service after
   * it checks the operator's approval, never by the agent's schedule tool or the portal's generic form. The runner checks
   * the approval again when the job fires. A run that fails before any click is retried up to POST_ATTEMPTS times; a failure
   * after a click, and every refusal, is final (a click that was started is only ever looked for again, never repeated, and
   * only the operator clears it). A run before the slot, unforced, does nothing and changes no state.
   */
  post?: { draft: string; late?: "skip" | "post"; skipDryRun?: boolean };
  attempts?: number;
  /** Post jobs: a refusal that retrying cannot fix. */
  noRetry?: boolean;
  createdAt: string;
  lastRunAt?: number;
  /** "interrupted": a restart or stop cut the run short. It is not a failure; the job runs once more at the next start. */
  lastStatus?: "ok" | "error" | "running" | "interrupted";
  /** Set when the rerun of an interrupted run was scheduled; a second interruption waits for the next slot instead of looping. */
  resumed?: boolean;
  lastError?: string;
  nextRunAt?: number;
}

export type JobRunner = (job: Job, opts?: { force?: boolean }) => Promise<string>;

export class Scheduler {
  private jobs: Job[] = [];
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<string>();
  /** Jobs running now (a restart for an update waits for them). */
  runningCount(): number { return this.running.size; }
  /** Process groups of running command jobs, killed on stop. */
  readonly children = new Set<number>();
  /** Agent and built-in runs are cut off after this long. */
  static readonly RUN_TIMEOUT_MS = 30 * 60_000;
  /** An interrupted run is rerun at the next start only if it began within this long. */
  static readonly RESUME_WINDOW_MS = 12 * 3_600_000;
  /** On stop, running command jobs get this long to finish by themselves, then SIGTERM, then SIGKILL after TERM_WAIT_MS. */
  static readonly STOP_GRACE_MS = 2_000;
  static readonly TERM_WAIT_MS = 500;
  private stopping = false;
  private stopSignal = "restart";
  static readonly POST_ATTEMPTS = 5;
  static readonly POST_RETRY_MS = 60_000;
  /** Job ids that were in schedules.json when this instance last read or wrote it. A file without one of them means another process removed it; a file with an id not here means another process added it. */
  private persisted = new Set<string>();
  /** Ids this instance removed (never adopted back from a stale read). */
  private readonly removedHere = new Set<string>();
  /** Ids this instance added. A passive instance (the CLI) writes only these from memory and keeps the file's version of every other job. */
  private readonly owned = new Set<string>();
  private readonly passive: boolean;
  private readonly file: string;

  private readonly log: Log;
  private readonly runners: {
    prompt: JobRunner; builtin: Record<string, JobRunner>; deliver: (job: Job, text: string) => Promise<void>;
    commandSandbox?: () => { wrap: (argv: string[]) => string[]; env: Record<string, string>; cwd?: string };
  };
  constructor(home: string, log: Log, runners: {
    prompt: JobRunner; builtin: Record<string, JobRunner>; deliver: (job: Job, text: string) => Promise<void>;
    /** How command jobs run: wrap the argv (the shell sandbox) and the environment they get. */
    commandSandbox?: () => { wrap: (argv: string[]) => string[]; env: Record<string, string>; cwd?: string };
  }, opts: { passive?: boolean } = {}) {
    this.passive = !!opts.passive;
    this.log = log;
    this.runners = runners;
    this.file = join(home, "schedules.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      this.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
      this.persisted = new Set(this.jobs.map((j) => j.id));
    } catch (e) {
      throw new Error(`${this.file} is not valid JSON: ${(e as Error).message}`);
    }
    if (this.passive) return; // the CLI reads; it must not mark the gateway's running jobs interrupted or rewrite their timing
    for (const job of this.jobs) {
      const wasRunning = job.lastStatus === "running";
      // A scheduled post keeps its own retry rules (a click that started is never repeated); it waits for its retry slot.
      const interrupted = wasRunning && !!job.post;
      if (interrupted) {
        job.lastStatus = "error";
        job.lastError = "interrupted by a restart";
      }
      let rerun = false;
      if (!job.post && (wasRunning || job.lastStatus === "interrupted")) {
        // A restart (or a hard kill) is not the job's failure: it runs once more now if the run began recently and it was
        // not already a rerun; otherwise it waits for its next slot. The job's own lock files decide whether it may start.
        job.lastStatus = "interrupted";
        job.lastError ||= "interrupted by restart";
        rerun = job.enabled && !job.resumed && Date.now() - (job.lastRunAt ?? 0) < Scheduler.RESUME_WINDOW_MS;
        job.resumed = rerun;
        if (rerun) this.log.info("schedule interrupted by a restart: running it again", { id: job.id, name: job.name });
      }
      try {
        if (rerun) job.nextRunAt = Date.now();
        // An interrupted run waits for its next slot instead of firing again the moment Carl starts.
        else if (job.nextRunAt === undefined || interrupted || job.lastStatus === "interrupted") job.nextRunAt = this.next(job, Date.now());
      } catch (e) {
        job.enabled = false;
        job.lastError = (e as Error).message;
        this.log.error("schedule disabled: bad timing", { id: job.id, error: job.lastError });
      }
    }
  }

  private fileJobs(): Job[] | undefined {
    if (!existsSync(this.file)) return undefined;
    try { const raw = JSON.parse(readFileSync(this.file, "utf8")); return Array.isArray(raw.jobs) ? raw.jobs : []; } catch { return undefined; }
  }

  /** Fold in what other processes did to schedules.json since we last looked: jobs they added are adopted, jobs they removed are dropped. */
  private adoptExternal(): void {
    const file = this.fileJobs();
    if (!file) return;
    const inFile = new Map(file.map((j) => [j.id, j]));
    this.jobs = this.jobs.filter((j) => !(this.persisted.has(j.id) && !inFile.has(j.id)));
    for (const job of file) {
      if (this.persisted.has(job.id) || this.removedHere.has(job.id) || this.jobs.some((j) => j.id === job.id)) continue;
      if (!this.passive) { try { job.nextRunAt ??= this.next(job, Date.now()); } catch { continue; } }
      this.jobs.push(job);
      this.persisted.add(job.id); // it is in the file: a later removal by another process must be noticed, not undone
    }
    if (this.passive) this.jobs = this.jobs.map((j) => (this.owned.has(j.id) ? j : (inFile.get(j.id) ?? j)));
  }

  /** Hold schedules.json's lock around a read-merge-write (the CLI and the gateway both write it). */
  private withFileLock<T>(fn: () => T): T {
    const lock = `${this.file}.lock`;
    const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (let waited = 0; ; waited += 20) {
      try { writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let age = 0;
        try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
        if (age > 15_000) { rmSync(lock, { force: true }); continue; }
        if (waited > 10_000) throw new Error(`${this.file} is locked by another process (${lock})`);
        pause(20);
      }
    }
    try { return fn(); } finally { rmSync(lock, { force: true }); }
  }

  private save(): void {
    this.withFileLock(() => {
      this.adoptExternal();
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ jobs: this.jobs }, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.file);
      this.persisted = new Set(this.jobs.map((j) => j.id));
    });
  }

  private next(job: Job, after: number): number | undefined {
    const once = job.when.match(/^once\s+(.+)$/i);
    if (once) {
      const at = Date.parse(once[1]);
      if (Number.isNaN(at)) throw new Error(`schedule "${job.when}": bad time`);
      if (job.post && job.lastRunAt && job.lastStatus !== "ok" && !job.noRetry && (job.attempts ?? 0) < Scheduler.POST_ATTEMPTS) return after + Scheduler.POST_RETRY_MS;
      return job.lastRunAt ? undefined : at;
    }
    return nextRun(parseSchedule(job.when), after, job.lastRunAt);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
    void this.tick();
  }

  /**
   * Stop ticking and wind down running jobs without failing them. Command jobs get `graceMs` to finish by themselves,
   * then SIGTERM, then SIGKILL. Any job still running afterwards is recorded as interrupted (saved now, because the
   * process exits right after) and runs once more at the next start.
   */
  async stop(reason = "restart", graceMs = Scheduler.STOP_GRACE_MS): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stopping = true;
    this.stopSignal = reason;
    const settle = async (ms: number) => {
      for (const end = Date.now() + ms; this.children.size && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
    };
    await settle(graceMs);
    for (const pid of this.children) { try { process.kill(-pid, "SIGTERM"); } catch {} }
    await settle(Scheduler.TERM_WAIT_MS);
    for (const pid of this.children) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    this.children.clear();
    let changed = false;
    for (const job of this.jobs) {
      if (!this.running.has(job.id) || job.post) continue;
      this.markInterrupted(job);
      changed = true;
    }
    if (changed) { try { this.save(); } catch (e) { this.log.error("cannot save schedules", { error: (e as Error).message }); } }
  }

  private markInterrupted(job: Job): void {
    job.lastStatus = "interrupted";
    job.lastError = `interrupted by restart (${this.stopSignal})`;
  }

  /** Make sure a built-in job exists; the operator may edit its timing or pause it afterwards. */
  ensureBuiltin(builtin: string, name: string, when: string, deliver = "home"): void {
    const existing = this.jobs.find((j) => j.builtin === builtin);
    if (existing) {
      // Turned back on after another system owned it; an operator's own pause stays.
      let changed = false;
      if (builtin === "feedback" && existing.when !== when) { existing.when = when; existing.nextRunAt = this.next(existing, Date.now()); changed = true; }
      if (existing.pausedBy === "learning" || (builtin === "feedback" && existing.pausedBy === "config")) {
        existing.enabled = true;
        delete existing.pausedBy;
        existing.nextRunAt = this.next(existing, Date.now()); // not a run missed while paused
        changed = true;
      }
      if (changed) this.save();
      return;
    }
    this.add({ name, when, builtin, deliver });
  }

  /** Pause a built-in job while another system owns that work; its schedule and edits are kept. */
  pauseBuiltin(builtin: string, by: string): void {
    let changed = false;
    for (const j of this.jobs) {
      if (j.builtin !== builtin || !j.enabled) continue;
      // A paused job's last failure is no longer actionable; UltraTerm would keep showing it as a failed schedule.
      j.enabled = false; j.pausedBy = by; delete j.lastError; delete j.lastStatus; changed = true;
    }
    if (changed) this.save();
  }

  add(spec: { name: string; when: string; prompt?: string; command?: string; builtin?: string; post?: Job["post"]; deliver: string; onlyIfOutput?: boolean; model?: string; timeoutMinutes?: number }): Job {
    if (!spec.name?.trim()) throw Object.assign(new Error("a schedule needs a name"), { status: 400 });
    if (!spec.prompt && !spec.command && !spec.builtin && !spec.post) throw Object.assign(new Error("a schedule needs a prompt or a command"), { status: 400 });
    if (spec.post && !/^once\s/i.test(spec.when)) throw Object.assign(new Error('a post schedule fires once: when is "once <ISO time>"'), { status: 400 });
    const job: Job = { id: `j-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, enabled: true, createdAt: new Date().toISOString(), ...spec, ...(spec.post ? { builtin: "post" } : {}) };
    try {
      job.nextRunAt = this.next(job, Date.now());
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { status: 400 });
    }
    this.owned.add(job.id);
    this.jobs.push(job);
    this.save();
    return job;
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.removedHere.add(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.save();
    return this.jobs.length < before;
  }

  /** A fresh approval of a draft ends any earlier `--skip-dry-run` on its scheduled posts. */
  clearSkipDryRun(draft: string): void {
    let changed = false;
    for (const j of this.jobs) if (j.post?.draft === draft && j.post.skipDryRun) { j.post = { draft: j.post.draft, ...(j.post.late ? { late: j.post.late } : {}) }; this.owned.add(j.id); changed = true; }
    if (changed) this.save();
  }

  setEnabled(id: string, enabled: boolean): void {
    const job = this.find(id);
    job.enabled = enabled;
    delete job.pausedBy; // the operator decides from here
    if (enabled) job.nextRunAt = this.next(job, Date.now());
    this.save();
  }

  list(): Job[] {
    return this.jobs.map((j) => ({ ...j }));
  }

  describe(): string {
    if (!this.jobs.length) return "No schedules.";
    return this.jobs
      .map((j) => `${j.id} ${j.enabled ? "on " : "off"} ${j.name} [${j.when}] ${j.prompt ? "agent" : j.command ? "command" : j.post ? "post" : j.builtin ?? ""}` +
        ` next=${j.nextRunAt ? new Date(j.nextRunAt).toISOString().slice(0, 16) : "-"} last=${j.lastStatus ?? "-"}${j.lastError ? ` (${j.lastError.slice(0, 80)})` : ""}`)
      .join("\n");
  }

  get(id: string): Job {
    return { ...this.find(id) };
  }

  private find(id: string): Job {
    const job = this.jobs.find((j) => j.id === id || j.name === id);
    if (!job) throw Object.assign(new Error(`no schedule ${id}`), { status: 404 });
    return job;
  }

  /** Run a job now. `force` (the operator's portal, never the agent) lets a post job run before its slot. */
  async runNow(id: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.execute(this.find(id), opts.force);
  }

  private async tick(): Promise<void> {
    try { this.adoptExternal(); } catch (e) { this.log.error("cannot read schedules.json", { error: (e as Error).message }); }
    const now = Date.now();
    for (const job of this.jobs) {
      if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now || this.running.has(job.id)) continue;
      void this.execute(job);
    }
  }

  private async execute(job: Job, force = false): Promise<void> {
    if (this.running.has(job.id)) return;
    if (job.post) {
      // The CLI may have removed or rescheduled this job since the last tick: look before a post can go out.
      try { this.adoptExternal(); } catch {}
      if (!this.jobs.includes(job)) return;
    }
    // A post job asked to run before its slot without force (the UltraTerm Run button, say) does nothing: no attempt is used, no state changes.
    if (job.post && !force) {
      const slot = Date.parse(job.when.replace(/^once\s+/i, ""));
      if (!Number.isNaN(slot) && Date.now() < slot) { this.log.info("post job not run: its slot has not arrived", { id: job.id }); return; }
    }
    this.running.add(job.id);
    let output = "";
    try {
      job.lastStatus = "running";
      job.lastRunAt = Date.now();
      if (job.post) job.attempts = (job.attempts ?? 0) + 1;
      this.save();
      this.log.info("schedule started", { id: job.id, name: job.name });
      const timed = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no result after ${Scheduler.RUN_TIMEOUT_MS / 60_000} minutes`)), Scheduler.RUN_TIMEOUT_MS).unref())]);
      if (job.builtin) {
        const run = this.runners.builtin[job.builtin];
        if (!run) throw new Error(`unknown built-in job "${job.builtin}"`);
        output = await timed(run(job, { force }));
      } else if (job.command) {
        const sandbox = this.runners.commandSandbox?.();
        output = await runCommand(job.command, Math.min(Math.max(job.timeoutMinutes ?? 10, 1), 240) * 60_000, this.children,
          sandbox && job.unsandboxed === true ? { ...sandbox, wrap: (argv) => argv } : sandbox);
      } else if (job.prompt) {
        output = await timed(this.runners.prompt(job));
      } else {
        throw new Error("job has neither prompt, command nor builtin");
      }
      job.lastStatus = "ok";
      job.lastError = undefined;
      job.resumed = undefined;
    } catch (e) {
      if (this.stopping && !job.post) {
        // The gateway is shutting down: this run was cut short, it did not fail. No failure is delivered.
        this.markInterrupted(job);
        output = "";
        this.log.info("schedule interrupted by a restart; it runs again at the next start", { id: job.id, name: job.name });
      } else {
        job.lastStatus = "error";
        job.lastError = (e as Error).message.slice(0, 500);
        job.resumed = undefined;
        if (job.post && (e as { final?: boolean }).final) job.noRetry = true;
        output = `Schedule "${job.name}" failed: ${job.lastError}`;
        this.log.error("schedule failed", { id: job.id, error: job.lastError });
      }
    } finally {
      this.running.delete(job.id);
      try {
        job.nextRunAt = this.next(job, Date.now());
      } catch {
        job.nextRunAt = undefined;
      }
      if (job.when.startsWith("once") && job.nextRunAt === undefined && job.lastStatus !== "interrupted") job.enabled = false;
      if (job.post && job.lastStatus === "error" && job.nextRunAt !== undefined) output += ` It will retry in ${Scheduler.POST_RETRY_MS / 60_000} min, resuming from the profile check; a part already live is not posted again.`;
      try { this.save(); } catch (e) { this.log.error("cannot save schedules", { error: (e as Error).message }); }
    }
    // A run that answered only with a silence marker ("[SILENT]", "NO_REPLY", "HEARTBEAT_OK", optionally with trailing
    // punctuation) has nothing to say: it is never delivered, whether or not the job set onlyIfOutput.
    const silent = isSilentReply(output);
    const skip = job.deliver === "none" || silent || (job.onlyIfOutput && job.lastStatus === "ok" && !output.trim());
    if (silent && job.lastStatus === "ok") this.log.info("schedule finished silently", { id: job.id, name: job.name });
    if (!skip && output.trim()) {
      await this.runners.deliver(job, output).catch((e) => {
        job.lastError = `ran, but delivery failed: ${(e as Error).message}`.slice(0, 500);
        this.log.error("schedule delivery failed", { id: job.id, error: (e as Error).message });
        try { this.save(); } catch {}
      });
    }
  }
}

/** A reply that only says "nothing to report". Exported for the gateway and tests. */
export function isSilentReply(text: string): boolean {
  return /^\s*(?:\[\s*SILENT\s*\]|NO_REPLY|HEARTBEAT_OK)[\s.!]*$/i.test(text ?? "");
}

export function runCommand(command: string, timeoutMs: number, groups?: Set<number>, sandbox?: { wrap: (argv: string[]) => string[]; env: Record<string, string>; cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!sandbox) return reject(new Error("command schedules run only in the gateway, where they run inside the shell sandbox"));
    const argv = sandbox.wrap(["/bin/bash", "-lc", command]);
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: true, env: sandbox.env, cwd: sandbox.cwd });
    if (child.pid) groups?.add(child.pid);
    child.on("exit", () => child.pid && groups?.delete(child.pid));
    let out = "";
    const cap = (b: Buffer) => { if (out.length < 200_000) out += b.toString(); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch {}
      reject(new Error(`command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${code === null ? `killed by signal ${signal ?? "unknown"}` : `exit ${code}`}${out.trim() ? `: ${out.trim().slice(-400)}` : ""}`));
    });
  });
}
