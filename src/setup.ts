import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { carlHome, loadConfig, secret } from "./config.ts";
import { TelegramApi } from "./channels/telegram-api.ts";
import { configuredProviders, login, providerModels } from "./login.ts";

type Options = {
  init: () => number;
  doctor: () => Promise<number>;
  ask?: (prompt: string, hidden?: boolean) => Promise<string>;
  telegramBase?: string;
  slackBase?: string;
  discordBase?: string;
};

/** Validate a Slack credential without exposing it in errors. */
export async function slackCall(base: string, method: string, token: string): Promise<void> {
  try {
    const r = await fetch(`${base}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const data = await r.json() as { ok?: boolean; error?: string };
    if (!r.ok || !data.ok) throw new Error("rejected");
  } catch { throw new Error(`Slack ${method} failed`); }
}

/** Validate a Discord credential without exposing it in errors. */
export async function discordMe(base: string, token: string): Promise<void> {
  try {
    const r = await fetch(`${base}/users/@me`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error("rejected");
  } catch { throw new Error("Discord GET /users/@me failed"); }
}

/** Guided setup; every optional prompt accepts an empty answer to skip. */
export async function setup(opts: Options): Promise<number> {
  if (opts.init()) return 1;
  const home = carlHome(), file = join(home, "carl.json"), envFile = join(home, ".env");
  chmodSync(home, 0o700);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  let muted = false;
  const makeInterface = () => createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  let rl = opts.ask ? undefined : makeInterface();
  const ask = opts.ask ?? (async (prompt: string, hidden = false) => {
    if (hidden) process.stdout.write(prompt + " ");
    muted = hidden;
    try { return (await rl!.question(hidden ? "" : prompt + " ")).trim(); }
    finally { muted = false; if (hidden) process.stdout.write("\n"); }
  });
  const save = () => writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  const putSecret = (key: string, value: string) => {
    if (/[\r\n]/.test(value)) throw new Error(`${key} contains a newline`);
    let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, () => `${key}=${value}`);
    else text += `${text && !text.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
    writeFileSync(envFile, text, { mode: 0o600 });
    chmodSync(envFile, 0o600);
  };
  try {
    let cfg = loadConfig(home);
    const current = cfg.telegram.enabled ? "telegram" : cfg.slack.enabled ? "slack" : cfg.discord.enabled ? "discord" : "web";
    const choice = (await ask(`Channel: telegram, slack, discord, web [${current}] (or skip):`)).toLowerCase() || current;
    if (!["telegram", "slack", "discord", "web", "skip"].includes(choice)) throw new Error("unknown channel choice");
    if (choice !== "skip") {
      for (const name of ["telegram", "slack", "discord"] as const) {
        raw[name] ??= {};
        if (choice !== current) raw[name].enabled = choice === name;
      }
      save();
    }
    cfg = loadConfig(home);
    const getToken = async (key: string, label: string) => {
      const existing = secret(home, key, cfg.envFiles);
      if (existing) return existing;
      const value = await ask(`${label} (empty to skip):`, true);
      return value;
    };
    if (choice === "telegram") {
      const token = await getToken(cfg.telegram.tokenEnv, "BotFather token");
      if (token) {
        const api = new TelegramApi(token, opts.telegramBase ?? cfg.telegram.apiBase);
        const me = await api.getMe();
        if (!secret(home, cfg.telegram.tokenEnv, cfg.envFiles)) putSecret(cfg.telegram.tokenEnv, token);
        console.log(`Telegram bot @${me.username}`);
        if (!cfg.telegram.allowFrom.length || !cfg.telegram.homeChat) {
          const go = await ask(`Send any message to @${me.username} now (Enter to wait, or skip):`);
          if (go.toLowerCase() !== "skip") {
            const until = Date.now() + 120_000;
            let offset = 0, found = false;
            while (Date.now() < until && !found) {
              const remaining = until - Date.now();
              const updates = await api.call<any[]>("getUpdates", { offset, timeout: Math.min(25, Math.max(1, Math.floor(remaining / 1000))) }, { timeoutMs: remaining, retries: 0 });
              for (const update of updates) {
                offset = Math.max(offset, update.update_id + 1);
                const from = update.message?.from;
                if (!found && from && !from.is_bot && update.message?.chat?.type === "private") {
                  const yes = await ask(`Allow ${from.first_name ?? "user"} (${from.id})? [Y/n]:`);
                  if (!yes || /^y(es)?$/i.test(yes)) {
                    raw.telegram ??= {};
                    if (!cfg.telegram.allowFrom.length) raw.telegram.allowFrom = [from.id];
                    if (!cfg.telegram.homeChat) raw.telegram.homeChat = from.id;
                    save(); found = true;
                  }
                }
              }
              if (offset) await api.call("getUpdates", { offset, timeout: 0 }, { retries: 0 });
            }
            if (!found) console.log("Telegram setup timed out; run carl setup again.");
          }
        }
      }
    } else if (choice === "slack" || choice === "discord") {
      const channel = cfg[choice];
      if (choice === "slack") {
        const app = await getToken(cfg.slack.appTokenEnv, "Slack xapp- token");
        const bot = await getToken(cfg.slack.botTokenEnv, "Slack xoxb- token");
        if (app) { if (!app.startsWith("xapp-")) throw new Error("Slack app token must start with xapp-"); await slackCall(opts.slackBase ?? cfg.slack.apiBase, "apps.connections.open", app); if (!secret(home, cfg.slack.appTokenEnv, cfg.envFiles)) putSecret(cfg.slack.appTokenEnv, app); }
        if (bot) { if (!bot.startsWith("xoxb-")) throw new Error("Slack bot token must start with xoxb-"); await slackCall(opts.slackBase ?? cfg.slack.apiBase, "auth.test", bot); if (!secret(home, cfg.slack.botTokenEnv, cfg.envFiles)) putSecret(cfg.slack.botTokenEnv, bot); }
      } else {
        const token = await getToken(cfg.discord.tokenEnv, "Discord bot token");
        if (token) { await discordMe(opts.discordBase ?? cfg.discord.apiBase, token); if (!secret(home, cfg.discord.tokenEnv, cfg.envFiles)) putSecret(cfg.discord.tokenEnv, token); }
      }
      if (!channel.allowFrom.length) {
        const id = await ask(choice === "slack" ? "Slack user ID (profile > More > Copy member ID; empty to skip):" : "Discord user ID (enable Developer Mode, then Copy User ID; empty to skip):");
        if (id) { raw[choice].allowFrom = [id]; save(); }
      }
    }
    if (!secret(home, cfg.api.keyEnv, cfg.envFiles)) putSecret(cfg.api.keyEnv, randomBytes(32).toString("hex"));
    if (existsSync(envFile)) chmodSync(envFile, 0o600);
    if (!raw.model) {
      cfg = loadConfig(home);
      const providers = await configuredProviders(cfg);
      console.log(`Signed-in providers: ${providers.join(", ") || "none"}`);
      console.log("Claude runs through Claude Code: after `claude auth login`, choose provider claude-code.");
      const provider = await ask("Provider (or 'login <provider>', empty to skip):");
      let selected = provider;
      if (provider.startsWith("login ")) {
        selected = provider.slice(6).trim();
        if (selected) {
          rl?.close(); rl = undefined;
          try { if (await login(cfg, [selected])) selected = ""; }
          finally { if (!opts.ask) rl = makeInterface(); }
        }
      }
      if (selected) {
        const models = await providerModels(cfg, selected);
        if (models.length) console.log(`Models: ${models.join(", ")}`);
        const model = await ask("Model name (empty to skip):");
        if (model) { raw.model = `${selected}/${model}`; save(); }
      }
    }
    const result = await opts.doctor();
    cfg = loadConfig(home);
    const host = cfg.api.host === "0.0.0.0" ? "127.0.0.1" : cfg.api.host;
    console.log(`Next: carl gateway\nWeb app: http://${host}:${cfg.api.port}/`);
    return result;
  } finally { rl?.close(); }
}
