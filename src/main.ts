// carl <command>: gateway | init | status | doctor | ask | send | reflect | schedules
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Brain } from "./brain.ts";
import { TelegramApi } from "./channels/telegram-api.ts";
import { chunkMarkdown, markdownToTelegramHtml } from "./channels/format.ts";
import { carlHome, ConfigError, DEFAULT_MODEL, ensureHome, loadConfig, mcpFile, secret } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { Log } from "./log.ts";
import { recordDeliveries, sendLogOrigin } from "./message-log.ts";
import { Psyche } from "./psyche.ts";
import { Scheduler } from "./scheduler.ts";
import { carlTools } from "./tools.ts";
import { COMMIT, VERSION } from "./version.ts";
import { loadPlugins } from "./plugins.ts";
import { resolveClaude } from "./providers/claude-code.ts";
import { login, logout } from "./login.ts";
import { spawnSync } from "node:child_process";

const HELP = `carl ${VERSION}: the minimal bot gateway

  carl gateway [--verbose]          run the gateway (channels, API, webhooks, schedules)
  carl init                         create CARL_HOME (${carlHome()}) with a starter carl.json
  carl status [--json]              the running gateway's status
  carl doctor                       check config, model, credentials and channels
  carl ask [-c key] <text>          one turn without channels (default conversation cli:default)
  carl send -t telegram:<chat> [--json] <text>
                                    send a message (Hermes-compatible output with --json)
  carl ask-post <id>                post an ask's questions to its chat (asks module; CARL_HOME/asks/<id>.json)
  carl reflect                      run the individuation pass once and print it
  carl schedules                    list schedules
  carl prompt [--full]              the system prompt and tools a new conversation gets, with sizes
  carl app [--install]              open the web app in its own window; --install adds Carl.app (macOS)
  carl login [provider] [--api-key] list model providers, or sign in to one (Claude: claude auth login)
  carl logout <provider>            remove a provider's stored credentials

Environment: CARL_HOME (default ~/.carl).`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    case "--version":
    case "version":
      console.log(`${VERSION} (${COMMIT})`);
      return 0;
    case "gateway":
      return gateway(rest);
    case "init":
      return init();
    case "status":
      return status(rest);
    case "doctor":
      return doctor();
    case "ask":
      return ask(rest);
    case "send":
      return send(rest);
    case "ask-post":
      return askPost(rest);
    case "reflect":
      return reflect();
    case "schedules":
      return schedules();
    case "prompt":
      return prompt(rest);
    case "app":
      return app(rest);
    case "login":
      return login(loadConfig(), rest);
    case "logout":
      return logout(loadConfig(), rest);
  }
  console.error(`carl: unknown command "${cmd}"\n\n${HELP}`);
  return 64;
}

async function gateway(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { verbose: { type: "boolean", short: "v" } } });
  const cfg = loadConfig();
  const gw = new Gateway(cfg, { verbose: values.verbose });
  for (const plugin of await loadPlugins(cfg)) gw.use(plugin);
  let exiting = false;
  const shutdown = async (signal: string) => {
    if (exiting) return;
    exiting = true;
    // UltraTerm sends SIGKILL 10 s after SIGTERM: finish inside 8 s.
    const hard = setTimeout(() => process.exit(gw.exitCode || 1), 8_000);
    hard.unref();
    await gw.stop(signal).catch((e) => console.error(`carl: stop failed: ${(e as Error).message}`));
    process.exit(gw.exitCode);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("unhandledRejection", (e) => gw.log.error("unhandled rejection", { error: (e as Error)?.stack ?? String(e) }));
  process.on("uncaughtException", (e) => {
    // State may be inconsistent: record why, then exit so the supervisor restarts a clean process.
    gw.log.error("uncaught exception; exiting for a clean restart", { error: e.stack ?? String(e) });
    gw.exitCode = 70;
    void shutdown("uncaught exception");
  });
  try {
    await gw.start();
  } catch (e) {
    gw.log.error("carl failed to start", { error: (e as Error).message });
    await gw.stop(`startup failed: ${(e as Error).message}`).catch(() => {});
    return 78;
  }
  await new Promise(() => {}); // run until a signal
  return 0;
}

function init(): number {
  const home = carlHome();
  const file = join(home, "carl.json");
  if (existsSync(file)) {
    console.log(`${file} already exists; nothing changed.`);
    return 0;
  }
  const cfg = loadConfig(home);
  ensureHome(cfg);
  new Psyche(home).seed();
  writeFileSync(
    file,
    JSON.stringify(
      {
        name: "Carl",
        model: DEFAULT_MODEL,
        thinking: "medium",
        contextBudget: 96000,
        tools: ["read", "bash"],
        telegram: { enabled: true, allowFrom: [], homeChat: null, tokenEnv: "TELEGRAM_BOT_TOKEN" },
        api: { enabled: true, port: 8642, keyEnv: "CARL_API_KEY" },
        contextFiles: [],
        skills: [],
        extensions: [],
      },
      null,
      2,
    ).replace('"homeChat": null', '"homeChat": 0') + "\n",
    { mode: 0o600 },
  );
  console.log(`Created ${home}.
Next:
  1. Put TELEGRAM_BOT_TOKEN and CARL_API_KEY (16+ chars) in ${join(home, ".env")} (mode 600).
  2. Add your Telegram user id to telegram.allowFrom and telegram.homeChat in ${file}.
  3. Sign in to a model: \`carl login\` lists providers (\`carl login openai-codex\` for GPT through Codex);
     for Claude, install Claude Code and run \`claude auth login\`.
  4. Edit ${join(home, "psyche", "persona.md")} and self.md, then run \`carl doctor\` and \`carl gateway\`.`);
  return 0;
}

function status(args: string[]): number {
  const cfg = loadConfig();
  const file = join(cfg.home, "state", "status.json");
  if (!existsSync(file)) {
    console.log("Carl has not run on this home yet.");
    return 3;
  }
  const s = JSON.parse(readFileSync(file, "utf8"));
  let alive = false;
  try {
    process.kill(s.pid, 0);
    alive = true;
  } catch {}
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...s, alive }, null, 2));
  } else {
    const age = Math.round((Date.now() - Date.parse(s.updatedAt)) / 1000);
    console.log(`${alive && s.state === "running" ? "running" : "not running"} (pid ${s.pid}, updated ${age}s ago)
model ${s.model} · runs ${s.activeRuns} · conversations ${s.conversations}
telegram ${s.telegram?.state}${s.telegram?.error ? ` (${s.telegram.error})` : ""} · api ${s.api?.state}${s.api?.port ? ` :${s.api.port}` : ""}`);
  }
  return alive && s.state === "running" ? 0 : 3;
}

async function doctor(): Promise<number> {
  let failed = 0;
  const check = async (name: string, fn: () => Promise<string> | string) => {
    try {
      console.log(`ok    ${name}: ${await fn()}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}: ${(e as Error).message}`);
    }
  };
  let cfg: ReturnType<typeof loadConfig> | undefined;
  await check("config", () => {
    cfg = loadConfig();
    return `${cfg.home}/carl.json`;
  });
  if (!cfg) return 1;
  const c = cfg;
  const log = new Log(undefined);
  const brain = new Brain(c, new Psyche(c.home, c.learning), log, () => []);
  await check("model", async () => {
    await brain.init();
    const m = brain.model(c.model);
    return `${c.model} (window ${m.contextWindow.toLocaleString()} tokens; Carl compacts at ${Math.min(c.contextBudget, m.contextWindow).toLocaleString()})`;
  });
  for (const ref of [c.model, ...c.fallbackModels]) {
    const provider = ref.split("/")[0];
    await check(`login ${provider}`, async () => {
      if (provider === "claude-code") {
        const dirs = c.claude.configDirs.length ? c.claude.configDirs : [undefined];
        const lines: string[] = [];
        for (const dir of dirs) {
          const env: NodeJS.ProcessEnv = { ...process.env };
          const isDefault = !dir || dir.replace(/\/+$/, "") === join(process.env.HOME ?? "", ".claude");
          if (isDefault) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = dir;
          const bin = resolveClaude(c.claude.command, env);
          if (!bin) throw new Error("the claude CLI is not installed (npm install -g @anthropic-ai/claude-code)");
          const out = spawnSync(bin, ["auth", "status"], { env, encoding: "utf8", timeout: 20_000 });
          let status: any = {};
          try { status = JSON.parse(out.stdout); } catch {}
          if (out.status !== 0 || status.loggedIn === false) throw new Error(`${dir ?? "default"}: not logged in (run \`${isDefault ? "" : `CLAUDE_CONFIG_DIR=${dir} `}claude auth login\`)`);
          lines.push(`${dir ?? "default"}${status.subscriptionType ? ` (${status.subscriptionType})` : ""}`);
        }
        return `Claude Code logged in: ${lines.join(", ")}`;
      }
      const available = brain.listModels().filter((m) => m.startsWith(provider + "/"));
      if (!available.length) throw new Error(`no credentials for ${provider} in ${c.agentDir}/auth.json (sign in with \`carl login ${provider}\`)`);
      return `${provider} signed in`;
    });
  }
  if (c.telegram.enabled) {
    await check("telegram", async () => {
      const token = secret(c.home, c.telegram.tokenEnv, c.envFiles);
      if (!token) throw new Error(`${c.telegram.tokenEnv} is not set`);
      const me = await new TelegramApi(token, c.telegram.apiBase).getMe();
      if (!c.telegram.allowFrom.length) throw new Error(`bot @${me.username} reachable, but telegram.allowFrom is empty`);
      return `@${me.username} via ${new URL(c.telegram.apiBase).host}, ${c.telegram.allowFrom.length} allowed user(s)`;
    });
  }
  if (c.api.enabled) {
    await check("api key", () => {
      const key = secret(c.home, c.api.keyEnv, c.envFiles);
      if (!key) throw new Error(`${c.api.keyEnv} is not set`);
      if (key.length < 16) throw new Error(`${c.api.keyEnv} must be at least 16 characters`);
      return `${c.api.keyEnv} set; listening on ${c.api.host}:${c.api.port}`;
    });
  }
  for (const f of c.contextFiles) await check("context file", () => { if (!existsSync(f)) throw new Error(`${f} is missing`); return f; });
  for (const d of c.skills) await check("skills dir", () => { if (!existsSync(d)) throw new Error(`${d} is missing`); return d; });
  if (c.stt) await check("speech-to-text", () => { if (!existsSync(c.stt![0])) throw new Error(`${c.stt![0]} is missing`); return c.stt!.join(" "); });
  await check("mcp", () => (existsSync(mcpFile(c)) ? `${mcpFile(c)} (servers via codemode)` : "no mcp.json (no MCP servers)"));
  await brain.shutdown(); // removes its state/run/<pid> folder
  return failed ? 1 : 0;
}

async function ask(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { conversation: { type: "string", short: "c" } } });
  const text = positionals.join(" ").trim();
  if (!text) {
    console.error("carl ask: give the message as arguments");
    return 64;
  }
  const cfg = loadConfig();
  ensureHome(cfg);
  const log = new Log(join(cfg.home, "logs", "carl.log"));
  const psyche = new Psyche(cfg.home, cfg.learning);
  psyche.seed();
  const scheduler = new Scheduler(cfg.home, log, { prompt: async () => "", builtin: {}, deliver: async () => {} });
  const brain = new Brain(cfg, psyche, log, () => carlTools(psyche, scheduler, { send: async () => "Not delivered: carl ask has no channels." }));
  await brain.init();
  let shown = 0;
  const result = await brain.ask(values.conversation ?? "cli:default", { text, source: "cli" }, {
    onMessageStart: () => {
      if (shown > 0) process.stdout.write("\n\n");
      shown = 0;
    },
    onText: (t) => {
      process.stdout.write(t.slice(shown));
      shown = t.length;
    },
    onTool: (name, detail) => process.stderr.write(`\n⚙ ${name} ${detail}\n`),
  });
  process.stdout.write("\n");
  process.stderr.write(`[${result.model} · ${(result.ms / 1000).toFixed(1)}s · in ${result.usage.input} (+${result.usage.cacheRead} cached) out ${result.usage.output} · tools ${result.toolCalls}]\n`);
  await brain.shutdown();
  if (!result.ok) console.error(`carl: ${result.error ?? "stopped"}`);
  return result.ok ? 0 : 1;
}

/** Hermes-compatible: `send -t telegram:<chat_id> [--json] <text>` → {"success":true,"message_id":N}. */
async function send(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { to: { type: "string", short: "t" }, json: { type: "boolean" } } });
  const out = (o: Record<string, unknown>, code: number) => {
    if (values.json) console.log(JSON.stringify(o));
    else if (o.success) console.log(`sent (message ${o.message_id})`);
    else console.error(`carl send: ${o.error}`);
    return code;
  };
  const target = values.to ?? "";
  const m = target.match(/^telegram:(-?\d+)$/);
  if (!m) return out({ success: false, error: `target must be telegram:<chat_id>, got "${target}"` }, 64);
  const text = positionals.join(" ") || (!process.stdin.isTTY ? readFileSync(0, "utf8") : "");
  if (!text.trim()) return out({ success: false, error: "no message text" }, 64);
  try {
    const cfg = loadConfig();
    const token = secret(cfg.home, cfg.telegram.tokenEnv, cfg.envFiles);
    if (!token) throw new Error(`${cfg.telegram.tokenEnv} is not set`);
    const api = new TelegramApi(token, cfg.telegram.apiBase);
    // A `carl send` lands in the operator's chat like any other send: record it for `utp ultrabot audit` too.
    recordDeliveries(api, !!cfg.ultraterm, (msg, data) => console.error(`carl: ${msg} ${JSON.stringify(data ?? {})}`), sendLogOrigin(process.env, (msg) => console.error(`carl: ${msg}`)));
    const ids: number[] = [];
    for (const chunk of chunkMarkdown(text)) {
      const html = markdownToTelegramHtml(chunk);
      const sent = await api.sendHtmlMessage(Number(m[1]), html);
      ids.push(sent.message_id);
    }
    return out({ success: true, message_id: ids[0], message_ids: ids }, 0);
  } catch (e) {
    return out({ success: false, error: (e as Error).message }, 1);
  }
}

/** Post an ask's questions to its chat and open it: the gateway's agent then records the answers. */
async function askPost(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) { console.error("carl ask-post: give the ask id (CARL_HOME/asks/<id>.json)"); return 64; }
  try {
    const cfg = loadConfig();
    if (!cfg.asks) throw new Error(`the asks module is off: set "asks": true in ${join(cfg.home, "carl.json")} and restart the gateway`);
    const { Asks } = await import("./asks.ts");
    const asks = new Asks(cfg.home);
    const a = asks.load(id);
    if (a.status === "done") throw new Error(`ask ${id} is already done`);
    if (!cfg.telegram.groups.some((g) => g.chat === a.chat) && !cfg.telegram.allowFrom.includes(a.chat) && a.chat !== cfg.telegram.homeChat)
      throw new Error(`chat ${a.chat} is not a configured group, allowed user or home chat: the answers would never reach Carl`);
    const token = secret(cfg.home, cfg.telegram.tokenEnv, cfg.envFiles);
    if (!token) throw new Error(`${cfg.telegram.tokenEnv} is not set`);
    const api = new TelegramApi(token, cfg.telegram.apiBase);
    recordDeliveries(api, !!cfg.ultraterm, (msg, data) => console.error(`carl: ${msg} ${JSON.stringify(data ?? {})}`));
    let first: number | undefined;
    for (const chunk of chunkMarkdown(Asks.message(a))) {
      const sent = await api.sendHtmlMessage(a.chat, markdownToTelegramHtml(chunk));
      first ??= sent.message_id;
    }
    asks.save({ ...a, status: "open", postedMessageId: first });
    console.log(`posted ask ${id} to chat ${a.chat} (message ${first}); it is open`);
    return 0;
  } catch (e) {
    console.error(`carl ask-post: ${(e as Error).message}`);
    return 1;
  }
}

async function reflect(): Promise<number> {
  const cfg = loadConfig();
  const gw = new Gateway({ ...cfg, telegram: { ...cfg.telegram, enabled: false }, api: { ...cfg.api, enabled: false } });
  await gw.brain.init();
  const report = await gw.individuate();
  console.log(report || "Nothing to flag. Lessons:\n\n" + gw.psyche.read("integrated.md"));
  await gw.brain.shutdown();
  return 0;
}

async function prompt(args: string[]): Promise<number> {
  const cfg = loadConfig();
  ensureHome(cfg);
  const psyche = new Psyche(cfg.home, cfg.learning);
  psyche.seed();
  const log = new Log(undefined);
  const scheduler = new Scheduler(cfg.home, log, { prompt: async () => "", builtin: {}, deliver: async () => {} });
  const brain = new Brain(cfg, psyche, log, () => carlTools(psyche, scheduler, { send: async () => "" }));
  await brain.init();
  const { systemPrompt, tools } = await brain.inspect();
  if (args.includes("--full")) console.log(systemPrompt + "\n");
  const sections = [...systemPrompt.matchAll(/^<([a-z_]+)>$/gm)].map((m) => m[1]);
  const toolChars = tools.reduce((n, t) => n + t.chars, 0);
  console.log(`system prompt: ${systemPrompt.length.toLocaleString()} chars (~${Math.round(systemPrompt.length / 4).toLocaleString()} tokens); sections: preamble ${sections.join(" ")}`);
  for (const s of ["project_context", "skills"]) {
    const m = systemPrompt.match(new RegExp(`<${s}>([\\s\\S]*?)</${s}>`));
    if (m) console.log(`  ${s}: ${m[1].length.toLocaleString()} chars`);
  }
  console.log(`tools: ${tools.length} active, ${toolChars.toLocaleString()} chars of schema (~${Math.round(toolChars / 4).toLocaleString()} tokens)`);
  for (const t of tools) console.log(`  ${t.name.padEnd(28)} ${t.chars.toLocaleString()} chars`);
  console.log(`fixed overhead per call: ~${Math.round((systemPrompt.length + toolChars) / 4).toLocaleString()} tokens`);
  await brain.shutdown();
  return 0;
}

/** The web app as a desktop window: Chrome's app mode when present, else the default browser. */
async function app(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const host = cfg.api.host === "0.0.0.0" ? "127.0.0.1" : cfg.api.host;
  const url = `http://${host}:${cfg.api.port}/`;
  if (args.includes("--install")) {
    if (process.platform !== "darwin") {
      console.error("carl app --install creates a macOS app; elsewhere, open the web app and use the browser's Install menu.");
      return 64;
    }
    const self = realpathSync(process.argv[1]).replace(/src\/main\.ts$/, "bin/carl");
    const dir = join(process.env.HOME ?? "", "Applications", "Carl.app", "Contents");
    mkdirSync(join(dir, "MacOS"), { recursive: true });
    writeFileSync(join(dir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Carl</string><key>CFBundleIdentifier</key><string>dev.carl.app</string>
<key>CFBundleExecutable</key><string>Carl</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${VERSION}</string><key>LSUIElement</key><true/>
</dict></plist>
`);
    const launcher = join(dir, "MacOS", "Carl");
    const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    writeFileSync(launcher, `#!/bin/zsh\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\n${process.env.CARL_HOME ? `export CARL_HOME=${sq(process.env.CARL_HOME)}\n` : ""}exec ${sq(self)} app\n`, { mode: 0o755 });
    console.log(`Installed ${join(process.env.HOME ?? "", "Applications", "Carl.app")}. It opens ${url}; the gateway must be running.`);
    return 0;
  }
  const up = await fetch(url, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok).catch(() => false);
  if (!up) {
    console.error(`Carl is not answering at ${url}. Start it with \`carl gateway\` (or check api.enabled and api.port in carl.json).`);
    return 69;
  }
  const chrome = ["/Applications/Google Chrome.app", join(process.env.HOME ?? "", "Applications", "Google Chrome.app")].find((p) => existsSync(p));
  const [cmd, cmdArgs] =
    process.platform === "darwin"
      ? chrome ? ["open", ["-na", chrome, "--args", `--app=${url}`]] : ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const r = spawnSync(cmd as string, cmdArgs as string[], { stdio: "inherit" });
  return r.status ?? 1;
}

function schedules(): number {
  const cfg = loadConfig();
  const s = new Scheduler(cfg.home, new Log(undefined), { prompt: async () => "", builtin: {}, deliver: async () => {} });
  console.log(s.describe());
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== 0 || !["gateway"].includes(process.argv[2] ?? "")) process.exit(code); },
  (e) => {
    console.error(e instanceof ConfigError ? `carl: config error: ${e.message}` : `carl: ${(e as Error).stack ?? e}`);
    process.exit(e instanceof ConfigError ? 78 : 1);
  },
);
