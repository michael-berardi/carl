// The gateway process: wires config, psyche, brain, channels, API and schedules; owns status and shutdown.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantText, Brain, listSessionFiles } from "./brain.ts";
import { chunkMarkdown } from "./channels/format.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { type CarlConfig, ensureHome, secret } from "./config.ts";
import { Log } from "./log.ts";
import { individuationPrompt, parseIndividuation, Psyche, readJsonl } from "./psyche.ts";
import { type Job, Scheduler } from "./scheduler.ts";
import { cleanEnv, sandboxArgv } from "./sandbox.ts";
import { ApiServer } from "./server.ts";
import { carlTools, type Outbox } from "./tools.ts";
import { VERSION } from "./version.ts";

export const ULTRATERM_LEARNING = "Lessons come from UltraTerm Dream and Nightmare: they read Carl's shadow and decision ledgers with every other agent's work, and approved lessons reach Carl through shared memory. Carl runs no separate individuation pass.";

export interface GatewayPlugin {
  name: string;
  start(gw: Gateway): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export class Gateway {
  readonly log: Log;
  readonly psyche: Psyche;
  readonly brain: Brain;
  readonly scheduler: Scheduler;
  private hooks?: { journal: import("./hooks.ts").HookJournal; resume: () => void };
  telegram?: TelegramChannel;
  slack?: import("./channels/slack.ts").SlackChannel;
  discord?: import("./channels/discord.ts").DiscordChannel;
  api?: ApiServer;
  readonly startedAt = new Date();
  private statusTimer?: NodeJS.Timeout;
  private stopping = false;
  private readonly plugins: GatewayPlugin[] = [];
  private readonly pidFile: string;
  exitCode = 0;

  readonly cfg: CarlConfig;
  constructor(cfg: CarlConfig, opts: { verbose?: boolean } = {}) {
    this.cfg = cfg;
    ensureHome(cfg);
    this.log = new Log(join(cfg.home, "logs", "carl.log"), opts.verbose);
    this.psyche = new Psyche(cfg.home, cfg.learning);
    this.psyche.seed();
    this.pidFile = join(cfg.home, "state", "gateway.pid");
    const outbox: Outbox = { send: (target, text) => this.send(target, text) };
    this.scheduler = new Scheduler(cfg.home, this.log, {
      prompt: (job) => this.runPromptJob(job),
      builtin: { individuation: () => this.individuate() },
      deliver: async (job, text) => {
        await this.send(job.deliver, `**${job.name}**\n\n${text}`);
      },
      // Command jobs run under the shell sandbox too: the scripts and tools they call are ones the agent can change.
      commandSandbox: () => ({ wrap: (argv) => sandboxArgv(this.brain.shellSandbox, argv), env: cleanEnv(cfg), cwd: cfg.workspace }),
    });
    this.brain = new Brain(cfg, this.psyche, this.log, () => carlTools(this.psyche, this.scheduler, outbox), { shared: true });
  }

  use(plugin: GatewayPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  async start(): Promise<void> {
    this.claimPid();
    this.log.info("carl starting", { version: VERSION, home: this.cfg.home, model: this.cfg.model, pid: process.pid });
    await this.brain.init();
    if (this.cfg.telegram.enabled) {
      const token = secret(this.cfg.home, this.cfg.telegram.tokenEnv, this.cfg.envFiles);
      if (!token) throw new Error(`telegram is enabled but ${this.cfg.telegram.tokenEnv} is not set (environment or ${join(this.cfg.home, ".env")})`);
      this.telegram = new TelegramChannel(this.cfg, token, this.brain, this.log);
      this.telegram.onStatus = () => this.writeStatus();
      this.registerCommands(this.telegram);
      const tg = this.telegram;
      this.brain.approver = (key) => async (command, reason) => {
        const m = key.match(/^telegram:(?:dm|group):(-?\d+)/);
        if (!m) return "unattended";
        const chat = Number(m[1]);
        // Approval cards go only to the operator's own chats: a group conversation asks in the home DM.
        const target = this.cfg.telegram.allowFrom.includes(chat) || chat === this.cfg.telegram.homeChat ? chat : this.cfg.telegram.homeChat;
        if (!target) return "unattended";
        return tg.requestApproval(target, target === chat ? command : `${command}\n\n(from the group conversation ${chat})`, reason);
      };
    }
    if (this.cfg.slack.enabled) {
      const { SlackChannel } = await import("./channels/slack.ts");
      const app = secret(this.cfg.home, this.cfg.slack.appTokenEnv, this.cfg.envFiles);
      const bot = secret(this.cfg.home, this.cfg.slack.botTokenEnv, this.cfg.envFiles);
      if (!app || !bot) throw new Error(`slack is enabled but ${!app ? this.cfg.slack.appTokenEnv : this.cfg.slack.botTokenEnv} is not set`);
      this.slack = new SlackChannel(this.cfg.slack, app, bot, this.brain, this.log);
    }
    if (this.cfg.discord.enabled) {
      const { DiscordChannel } = await import("./channels/discord.ts");
      const token = secret(this.cfg.home, this.cfg.discord.tokenEnv, this.cfg.envFiles);
      if (!token) throw new Error(`discord is enabled but ${this.cfg.discord.tokenEnv} is not set`);
      this.discord = new DiscordChannel(this.cfg.discord, token, this.brain, this.log);
    }
    const baseApprover = this.brain.approver;
    this.brain.approver = (key) => async (command, reason) => {
      const m = key.match(/^slack:(?:dm:)?([A-Z0-9]+)(?::([\d.]+))?$/);
      if (m && this.slack) return this.slack.requestApproval(m[1], m[2], command, reason);
      const d = key.match(/^discord:(?:dm:)?(\d+)$/);
      if (d && this.discord) return this.discord.requestApproval(d[1], command, reason);
      return baseApprover(key)(command, reason);
    };
    if (this.cfg.api.enabled) {
      const key = secret(this.cfg.home, this.cfg.api.keyEnv, this.cfg.envFiles);
      if (!key) throw new Error(`api is enabled but ${this.cfg.api.keyEnv} is not set (environment or ${join(this.cfg.home, ".env")})`);
      this.api = new ApiServer(this.cfg, key, this.brain, this.log, () => this.health());
    }
    if (this.api) {
      const { mountPortal, publicAsset } = await import("./portal/api.ts");
      mountPortal(this.api, this);
      this.api.publicAsset = publicAsset;
      if (Object.keys(this.cfg.hooks).length) {
        const { mountHooks } = await import("./hooks.ts");
        this.hooks = mountHooks(this.api, this, this.cfg.hooks);
      }
    }
    for (const p of this.plugins) await p.start(this);
    if (this.api) await this.api.start();
    this.hooks?.resume();
    if (this.telegram) await this.telegram.start();
    if (this.slack) await this.slack.start();
    if (this.discord) await this.discord.start();
    if (this.cfg.learning === "carl") this.scheduler.ensureBuiltin("individuation", "Individuation", "40 5 * * *");
    else this.scheduler.pauseBuiltin("individuation", "learning"); // UltraTerm Dream and Nightmare own the learning loop
    this.scheduler.start();
    this.writeStatus();
    this.statusTimer = setInterval(() => this.writeStatus(), 15_000);
    this.statusTimer.unref();
    this.log.info("carl ready", { telegram: this.telegram?.status.state ?? "off", api: this.api?.status.state ?? "off" });
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info("carl stopping", { reason });
    this.scheduler.stop();
    await this.telegram?.stop();
    await this.slack?.stop();
    await this.discord?.stop();
    await this.brain.shutdown();
    await this.api?.stop();
    this.hooks?.journal.close();
    for (const p of this.plugins) {
      try {
        await p.stop?.();
      } catch (e) {
        this.log.error("plugin stop failed", { plugin: p.name, error: (e as Error).message });
      }
    }
    if (this.statusTimer) clearInterval(this.statusTimer);
    // A gateway that never claimed the pid (it lost the race to another) must not mark the live one stopped.
    if (this.ownsPid) this.writeStatus("stopped", reason);
    try {
      if (existsSync(this.pidFile) && readFileSync(this.pidFile, "utf8").trim() === String(process.pid)) unlinkSync(this.pidFile);
    } catch {}
  }

  private claimPid(): void {
    if (existsSync(this.pidFile)) {
      const other = Number(readFileSync(this.pidFile, "utf8").trim());
      // A live pid only blocks start when it is really a Carl gateway (pids are reused after a reboot).
      if (other && other !== process.pid && alive(other) && isCarl(other)) throw new Error(`another Carl gateway (pid ${other}) is running on ${this.cfg.home}`);
    }
    writeFileSync(this.pidFile, String(process.pid), { mode: 0o600 });
    this.ownsPid = true;
  }
  private ownsPid = false;

  health(): Record<string, unknown> {
    return {
      name: this.cfg.name,
      version: VERSION,
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      model: this.cfg.model,
      activeRuns: this.brain.busyCount(),
      conversations: this.brain.activeConversations().length,
      telegram: this.telegram?.status ?? { state: "off" },
      slack: this.slack?.status ?? { state: "off" },
      discord: this.discord?.status ?? { state: "off" },
      api: this.api ? { ...this.api.status, port: this.cfg.api.port } : { state: "off" },
    };
  }

  writeStatus(state = "running", reason?: string): void {
    const file = join(this.cfg.home, "state", "status.json");
    const body = { ...this.health(), state, reason, updatedAt: new Date().toISOString() };
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(body, null, 2), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      this.log.error("cannot write status", { error: (e as Error).message });
    }
    try {
      this.emitStatus?.(body);
    } catch (e) {
      this.log.error("status hook failed", { error: (e as Error).message });
    }
  }
  /** Hook for compatibility writers (UltraTerm's gateway_state.json). */
  emitStatus?: (status: Record<string, unknown>) => void;

  /** Deliver Markdown to "home", "none" or a chat id. */
  async send(target: string, text: string): Promise<string> {
    if (target === "none") return "Not delivered (target none).";
    if (target.startsWith("discord:")) {
      if (!this.discord) throw new Error("discord is not enabled");
      const n = await this.discord.deliver(target.slice(8), text);
      return `Delivered to Discord (${n} message${n === 1 ? "" : "s"}).`;
    }
    if (target.startsWith("slack:")) {
      if (!this.slack) throw new Error("slack is not enabled");
      const n = await this.slack.send(target.slice(6), text);
      return `Delivered to Slack (${n} message${n === 1 ? "" : "s"}).`;
    }
    if (!this.telegram) throw new Error("no messaging channel is enabled");
    const chatId = target === "home" ? this.cfg.telegram.homeChat : Number(target);
    if (!chatId || !Number.isSafeInteger(chatId)) throw new Error(target === "home" ? "telegram.homeChat is not configured" : `bad chat id "${target}"`);
    if (!this.cfg.telegram.allowFrom.includes(chatId) && chatId !== this.cfg.telegram.homeChat) throw new Error(`chat ${chatId} is not the home chat or an allowed user`);
    try {
      const sent = await this.telegram.sendMarkdown(chatId, text);
      return `Delivered (${sent.length} message${sent.length === 1 ? "" : "s"}).`;
    } catch (e) {
      this.telegram.enqueue(chatId, chunkMarkdown(text), undefined, (e as Error).message);
      return `Telegram refused it for now (${(e as Error).message}); queued and retried every 30 s.`;
    }
  }

  private async runPromptJob(job: Job): Promise<string> {
    const key = `schedule:${job.id}`;
    await this.brain.reset(key); // every run starts clean: schedules never grow a context
    if (job.model) await this.brain.setModel(key, job.model);
    const limit = setTimeout(() => void this.brain.stop(key), Scheduler.RUN_TIMEOUT_MS - 5_000);
    limit.unref();
    const result = await this.brain.ask(key, { text: job.prompt!, source: "schedule" }).finally(() => clearTimeout(limit));
    if (!result.ok) throw new Error(result.error ?? "stopped");
    return result.text;
  }

  /** Daily individuation: Self against behaviour; rewrites integrated.md and reports contradictions and proposals. */
  async individuate(): Promise<string> {
    if (this.cfg.learning === "ultraterm") return ULTRATERM_LEARNING;
    const since = this.psyche.lastIndividuation();
    const shadow = this.psyche.shadowSince(since);
    const decisions = this.psyche.decisions(30);
    const sinceMs = since ? Date.parse(since) : Date.now() - 86_400_000;
    const replies: string[] = [];
    for (const s of listSessionFiles(this.cfg.home).filter((f) => f.mtime > sinceMs && !f.key.startsWith("schedule:") && f.key !== "inspect").slice(0, 12)) {
      for (const entry of readJsonl<any>(s.file).slice(-40)) {
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const t = assistantText(entry.message);
          if (t) replies.push(`- [${s.key}] ${t.replace(/\s+/g, " ").slice(0, 400)}`);
        }
      }
    }
    if (!shadow.length && !replies.length) return "";
    const reply = await this.brain.oneShot(
      individuationPrompt(this.psyche.read("self.md"), this.psyche.read("integrated.md"), shadow, decisions, replies.slice(-30).join("\n")),
      { system: "You are Carl reflecting on your own conduct. Be exact and unsparing; cite evidence; never invent incidents." },
    );
    const parts = parseIndividuation(reply);
    if (!parts.lessons) throw new Error("individuation reply had no Lessons section");
    this.psyche.writeIntegrated(parts.lessons);
    this.log.info("individuation complete", { shadow: shadow.length, replies: replies.length });
    const notable = [parts.contradictions, parts.proposals].some((s) => s && !/^none( found)?\.?$/i.test(s.trim()));
    if (!notable) return "";
    return `Self vs. behaviour since ${since?.slice(0, 10) ?? "yesterday"} (${shadow.length} shadow entries).\n\n**Contradictions**\n${parts.contradictions}\n\n**Proposals**\n${parts.proposals}`;
  }

  private registerCommands(tg: TelegramChannel): void {
    tg.commands.set("schedules", { help: "List schedules", run: async () => "```\n" + this.scheduler.describe() + "\n```" });
    tg.commands.set("reflect", {
      help: "Run the individuation pass now",
      run: async () => (await this.individuate()) || `Lessons updated; nothing to flag.\n\n${this.psyche.read("integrated.md").slice(0, 2_500)}`,
    });
    tg.commands.set("shadow", {
      help: "Recent shadow entries",
      run: async () => {
        const recent = this.psyche.shadowSince(undefined, 15);
        return recent.length ? recent.map((e) => `• ${e.at.slice(5, 16)} [${e.kind}] ${e.summary}`).join("\n") : "The shadow ledger is empty.";
      },
    });
  }
}

function isCarl(pid: number): boolean {
  try {
    const cmd = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 });
    return /carl|main\.ts gateway/.test(cmd);
  } catch {
    return true; // cannot tell: be safe and treat it as running
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
