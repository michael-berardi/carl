// Schedules: one JSON file, a 20-second tick, one catch-up run after downtime (never a burst).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
   * sandbox denies, such as cf's login (Mike 2026-10-16: the PlataPlace photo render could not reach Cloudflare).
   */
  unsandboxed?: boolean;
  createdAt: string;
  lastRunAt?: number;
  lastStatus?: "ok" | "error" | "running";
  lastError?: string;
  nextRunAt?: number;
  /** The pid of the command that is running now. It leads its own process group, so a restart can stop it. */
  runPid?: number;
  /** When the running job started, so a restart can tell an old process group from a new one. */
  runStartedAt?: number;
  /** What kind of run is going on, so an interrupted run is reported in the right words. */
  runKind?: "command" | "agent" | "builtin";
}

export type JobRunner = (job: Job) => Promise<string>;

/** A run that a restart cut short. */
interface InterruptedRun {
  job: Job;
  kind: "command" | "agent" | "builtin";
  /** True when the command was still running when Carl came back (and was stopped). */
  wasRunning: boolean;
  /** When the run started, so the notice about it is sent once. */
  startedAt: number;
}

export class Scheduler {
  private jobs: Job[] = [];
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<string>();
  /** Process groups of running command jobs, killed on stop. */
  readonly children = new Set<number>();
  /** Agent and built-in runs are cut off after this long. */
  static readonly RUN_TIMEOUT_MS = 30 * 60_000;
  private readonly file: string;
  /** The runs a restart cut short, reported once the channels are up. */
  private readonly interrupted: InterruptedRun[] = [];

  private readonly log: Log;
  private readonly runners: {
    prompt: JobRunner; builtin: Record<string, JobRunner>; deliver: (job: Job, text: string, id?: string) => Promise<void>;
    commandSandbox?: () => { wrap: (argv: string[]) => string[]; env: Record<string, string>; cwd?: string };
  };
  constructor(home: string, log: Log, runners: {
    prompt: JobRunner; builtin: Record<string, JobRunner>; deliver: (job: Job, text: string, id?: string) => Promise<void>;
    /** How command jobs run: wrap the argv (the shell sandbox) and the environment they get. */
    commandSandbox?: () => { wrap: (argv: string[]) => string[]; env: Record<string, string>; cwd?: string };
  }) {
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
    } catch (e) {
      throw new Error(`${this.file} is not valid JSON: ${(e as Error).message}`);
    }
    for (const job of this.jobs) {
      if (job.nextRunAt !== undefined) continue;
      try {
        job.nextRunAt = this.next(job, Date.now());
      } catch (e) {
        job.enabled = false;
        job.lastError = (e as Error).message;
        this.log.error("schedule disabled: bad timing", { id: job.id, error: job.lastError });
      }
    }
  }

  /**
   * Recover from a restart: stop the command groups of the runs that were cut short, mark them on disk and report
   * them once. Only the gateway that owns the pid may do this: a second gateway, or a plain command such as
   * `carl reflect`, must never stop the running gateway's command or rewrite its schedules.
   */
  recover(): void {
    let changed = false;
    for (const job of this.jobs) {
      if (job.lastStatus !== "running") continue;      // The run is on disk as running: it was cut short by a restart. Its command is stopped, so nothing finishes
      // unobserved, and the operator is told what happened.
      const kind = job.runKind ?? (job.command ? "command" : job.builtin ? "builtin" : "agent");
      const wasRunning = job.runPid !== undefined && this.stopRunGroup(job.runPid, job.runStartedAt ?? Date.now());
      this.interrupted.push({ job, kind, wasRunning, startedAt: job.runStartedAt ?? job.lastRunAt ?? Date.now() });
      this.log.warn("a scheduled run was interrupted by a restart", { id: job.id, name: job.name, kind, wasRunning });
      job.lastStatus = "error";
      job.lastError = "interrupted by a restart";
      delete job.runPid;
      delete job.runStartedAt;
      delete job.runKind;
      try {
        // An interrupted run waits for its next slot instead of firing again the moment Carl starts.
        job.nextRunAt = this.next(job, Date.now());
      } catch (e) {
        job.enabled = false;
        job.lastError = (e as Error).message;
        this.log.error("schedule disabled: bad timing", { id: job.id, error: job.lastError });
      }
      changed = true;
    }
    // The file said "running" for a run that is over: say so on disk, so nothing else reads a stale state.
    if (changed) {
      this.didRecover = true;
      try { this.save(); } catch (e) { this.log.error("cannot save schedules", { error: (e as Error).message }); }
    }
  }

  /** True when a restart was recovered from: the interrupted runs were stopped and marked. */
  get recovered(): boolean {
    return this.didRecover;
  }
  private didRecover = false;

  /**
   * Stop the process group of a command that a restart cut short. Returns true when the group was still alive.
   * A pid that was recycled by the system is left alone: it did not start before our run did. When the system will
   * not say when the process started, nothing is killed at all: an unknown process is never assumed to be ours.
   */
  private stopRunGroup(pgid: number, startedAt: number): boolean {
    if (!this.groupIsOurs(pgid, startedAt)) return false;
    try { process.kill(-pgid, "SIGTERM"); } catch {}
    const killer = setTimeout(() => {
      // The group may have been recycled in the meantime, so it is looked at again before the kill.
      if (!this.groupIsOurs(pgid, startedAt)) {
        this.log.warn("the interrupted run's process group is gone or was recycled; not killing it", { pgid });
        return;
      }
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }, 2_000);
    killer.unref();
    return true;
  }

  /** True when the process group is still the one the interrupted run started. */
  private groupIsOurs(pgid: number, startedAt: number): boolean {
    try {
      process.kill(-pgid, 0);
    } catch {
      return false; // the group is gone: the command did not finish on its own
    }
    const born = processStart(pgid);
    if (!mayStopGroup(born, startedAt)) {
      if (born === undefined) {
        // The system will not say when the process started: fail closed, never kill what may be another process.
        this.log.warn("not stopping a process group whose start time could not be read", { pgid });
      } else {
        this.log.warn("not stopping a process group that started after the interrupted run", { pgid, born, startedAt });
      }
      return false;
    }
    return true;
  }

  private save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ jobs: this.jobs }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private next(job: Job, after: number): number | undefined {
    const once = job.when.match(/^once\s+(.+)$/i);
    if (once) {
      const at = Date.parse(once[1]);
      if (Number.isNaN(at)) throw new Error(`schedule "${job.when}": bad time`);
      return job.lastRunAt ? undefined : at;
    }
    return nextRun(parseSchedule(job.when), after, job.lastRunAt);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
    void this.tick();
    void this.reportInterrupted();
  }

  /**
   * Tell the operator about the runs a restart cut short. One message each, and never the same one twice: the
   * delivery id is the run itself, so a restart during the notice does not send it again.
   */
  private async reportInterrupted(): Promise<void> {
    for (const run of this.interrupted.splice(0)) {
      const text = run.kind === "command"
        ? run.wasRunning
          ? "The run was interrupted by a restart. Its command was still running and has been stopped, so it may have applied part of its side effect. The next slot runs as normal."
          : "The run was interrupted by a restart. Its command was no longer running, so whatever it did is already done. The next slot runs as normal."
        : "The run was interrupted by a restart. It did not finish and is not repeated; the next slot runs as normal.";
      try {
        await this.runners.deliver(run.job, text, `schedule:${run.job.id}:interrupted:${run.startedAt}`);
      } catch (e) {
        this.log.error("cannot report an interrupted run", { id: run.job.id, error: (e as Error).message });
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const pid of this.children) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    this.children.clear();
  }

  /** Make sure a built-in job exists; the operator may edit its timing or pause it afterwards. */
  ensureBuiltin(builtin: string, name: string, when: string, deliver = "home"): void {
    const existing = this.jobs.find((j) => j.builtin === builtin);
    if (existing) {
      // Turned back on after another system owned it; an operator's own pause stays.
      if (existing.pausedBy === "learning") {
        existing.enabled = true;
        delete existing.pausedBy;
        existing.nextRunAt = this.next(existing, Date.now()); // not a run missed while paused
        this.save();
      }
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

  add(spec: { name: string; when: string; prompt?: string; command?: string; builtin?: string; deliver: string; onlyIfOutput?: boolean; model?: string; timeoutMinutes?: number }): Job {
    if (!spec.name?.trim()) throw Object.assign(new Error("a schedule needs a name"), { status: 400 });
    if (!spec.prompt && !spec.command && !spec.builtin) throw Object.assign(new Error("a schedule needs a prompt or a command"), { status: 400 });
    const job: Job = { id: `j-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, enabled: true, createdAt: new Date().toISOString(), ...spec };
    try {
      job.nextRunAt = this.next(job, Date.now());
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { status: 400 });
    }
    this.jobs.push(job);
    this.save();
    return job;
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.save();
    return this.jobs.length < before;
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
      .map((j) => `${j.id} ${j.enabled ? "on " : "off"} ${j.name} [${j.when}] ${j.prompt ? "agent" : j.command ? "command" : j.builtin ?? ""}` +
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

  async runNow(id: string): Promise<void> {
    await this.execute(this.find(id));
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const job of this.jobs) {
      if (!job.enabled || job.nextRunAt === undefined || job.nextRunAt > now || this.running.has(job.id)) continue;
      void this.execute(job);
    }
  }

  private async execute(job: Job): Promise<void> {
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    let output = "";
    try {
      job.lastStatus = "running";
      job.lastRunAt = Date.now();
      job.runStartedAt = job.lastRunAt;
      job.runKind = job.builtin ? "builtin" : job.command ? "command" : "agent";
      this.save();
      this.log.info("schedule started", { id: job.id, name: job.name });
      const timed = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no result after ${Scheduler.RUN_TIMEOUT_MS / 60_000} minutes`)), Scheduler.RUN_TIMEOUT_MS).unref())]);
      if (job.builtin) {
        const run = this.runners.builtin[job.builtin];
        if (!run) throw new Error(`unknown built-in job "${job.builtin}"`);
        output = await timed(run(job));
      } else if (job.command) {
        const sandbox = this.runners.commandSandbox?.();
        output = await runCommand(job.command, Math.min(Math.max(job.timeoutMinutes ?? 10, 1), 240) * 60_000, this.children,
          sandbox && job.unsandboxed === true ? { ...sandbox, wrap: (argv) => argv } : sandbox,
          (pid) => {
            // The command leads its own process group. The pid is on disk before the command can finish, so a
            // restart can stop the group instead of leaving an orphan that completes unobserved.
            job.runPid = pid;
            try { this.save(); } catch (e) { this.log.error("cannot save schedules", { error: (e as Error).message }); }
          });
      } else if (job.prompt) {
        output = await timed(this.runners.prompt(job));
      } else {
        throw new Error("job has neither prompt, command nor builtin");
      }
      job.lastStatus = "ok";
      job.lastError = undefined;
    } catch (e) {
      job.lastStatus = "error";
      job.lastError = (e as Error).message.slice(0, 500);
      output = `Schedule "${job.name}" failed: ${job.lastError}`;
      this.log.error("schedule failed", { id: job.id, error: job.lastError });
    } finally {
      this.running.delete(job.id);
      delete job.runPid;
      delete job.runStartedAt;
      delete job.runKind;
      try {
        job.nextRunAt = this.next(job, Date.now());
      } catch {
        job.nextRunAt = undefined;
      }
      if (job.when.startsWith("once")) job.enabled = false;
      try { this.save(); } catch (e) { this.log.error("cannot save schedules", { error: (e as Error).message }); }
    }
    const skip = job.deliver === "none" || (job.onlyIfOutput && job.lastStatus === "ok" && !output.trim());
    if (!skip && output.trim()) {
      await this.runners.deliver(job, output, `schedule:${job.id}:run:${job.lastRunAt}`).catch((e) => {
        job.lastError = `ran, but delivery failed: ${(e as Error).message}`.slice(0, 500);
        this.log.error("schedule delivery failed", { id: job.id, error: (e as Error).message });
        try { this.save(); } catch {}
      });
    }
  }
}

export function runCommand(
  command: string,
  timeoutMs: number,
  groups?: Set<number>,
  sandbox?: { wrap: (argv: string[]) => string[]; env: Record<string, string>; cwd?: string },
  onStart?: (pid: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!sandbox) return reject(new Error("command schedules run only in the gateway, where they run inside the shell sandbox"));
    const argv = sandbox.wrap(["/bin/bash", "-lc", command]);
    // detached: the command leads its own process group, so Carl can stop the whole group and not leave orphans.
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: true, env: sandbox.env, cwd: sandbox.cwd });
    if (child.pid) {
      groups?.add(child.pid);
      onStart?.(child.pid);
    }
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
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`exit ${code}: ${out.trim().slice(-400)}`));
    });
  });
}

/** When a process started, in epoch ms, or undefined when the system will not say. */
export function processStart(pid: number): number | undefined {
  try {
    // LC_ALL=C: the start time is parsed in a fixed format, whatever the machine's locale says.
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    }).trim();
    if (!out) return undefined;
    const at = Date.parse(out);
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

/**
 * Whether a recorded process group may be stopped: it must be the group the interrupted run started. An unknown
 * start time means no: an unknown process is never assumed to be ours.
 */
export function mayStopGroup(born: number | undefined, startedAt: number): boolean {
  if (born === undefined) return false;
  return born <= startedAt + 5_000;
}
