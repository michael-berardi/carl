// `carl login` / `carl logout`: model-provider sign-in from the terminal, stored in Carl's own agent folder
// (agentDir, default CARL_HOME/agent). Claude uses the Claude Code CLI's own login and is not handled here.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CarlConfig } from "./config.ts";

async function runtime(cfg: CarlConfig): Promise<ModelRuntime> {
  mkdirSync(cfg.agentDir, { recursive: true, mode: 0o700 });
  return ModelRuntime.create({ authPath: join(cfg.agentDir, "auth.json"), modelsPath: join(cfg.agentDir, "models.json") });
}

/** A stable id for this installation, which some providers (OpenAI's Codex login) ask for. */
function deviceId(cfg: CarlConfig): string {
  const file = join(cfg.home, "state", "device-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const id = randomUUID();
  mkdirSync(join(cfg.home, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}

function ask(message: string, secret: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secret) (rl as any)._writeToOutput = (s: string) => { if (s.includes(message)) process.stdout.write(s); };
    rl.question(`${message} `, (answer) => { rl.close(); if (secret) process.stdout.write("\n"); resolve(answer.trim()); });
    rl.on("SIGINT", () => { rl.close(); reject(new Error("cancelled")); });
  });
}

function openUrl(url: string): void {
  if (process.platform !== "darwin") return;
  spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

export async function login(cfg: CarlConfig, args: string[]): Promise<number> {
  const rt = await runtime(cfg);
  const providers = rt.getProviders().map((p: any) => p.id as string).sort();
  const providerId = args.find((a) => !a.startsWith("-"));
  if (!providerId) {
    console.log(`Providers (credentials in ${join(cfg.agentDir, "auth.json")}):`);
    for (const id of providers) {
      const auth = (rt.getProvider(id) as any)?.auth ?? {};
      const kinds = [auth.oauth ? "sign-in" : "", auth.apiKey?.login ? "api key" : ""].filter(Boolean).join(", ");
      const status = rt.getProviderAuthStatus(id);
      console.log(`  ${status.configured ? "✓" : " "} ${id.padEnd(28)} ${kinds || "ambient"}${status.configured && status.source ? ` (${status.source})` : ""}`);
    }
    console.log("\nSign in: carl login <provider> [--api-key]. Claude uses Claude Code's own login: claude auth login.");
    return 0;
  }
  if (!providers.includes(providerId)) {
    console.error(`unknown provider "${providerId}"; run \`carl login\` for the list`);
    return 1;
  }
  const auth = (rt.getProvider(providerId) as any)?.auth ?? {};
  const type = args.includes("--api-key") || !auth.oauth ? "api_key" : "oauth";
  if (type === "api_key" && !auth.apiKey?.login) {
    console.error(`${providerId} takes no interactive login; it reads its credentials from the environment or local config`);
    return 1;
  }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  await rt.login(providerId, type, {
    signal: controller.signal,
    prompt: async (p) => {
      if (p.type === "select") {
        p.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`));
        const pick = Number(await ask(`${p.message} [1-${p.options.length}]`, false));
        const option = p.options[pick - 1];
        if (!option) throw new Error("no option chosen");
        return option.id;
      }
      return ask(p.message, p.type === "secret");
    },
    notify: (e) => {
      if (e.type === "auth_url") {
        console.log(`Open this link to sign in${e.instructions ? ` (${e.instructions})` : ""}:\n  ${e.url}`);
        openUrl(e.url);
      } else if (e.type === "device_code") {
        console.log(`Go to ${e.verificationUri} and enter the code ${e.userCode}`);
        openUrl(e.verificationUri);
      } else {
        console.log(e.message + ("links" in e && e.links?.length ? " " + e.links.map((l) => l.url).join(" ") : ""));
      }
    },
  }, { getDeviceId: () => deviceId(cfg) });
  console.log(`Signed in to ${providerId}.`);
  return 0;
}

export async function logout(cfg: CarlConfig, args: string[]): Promise<number> {
  const providerId = args.find((a) => !a.startsWith("-"));
  if (!providerId) {
    console.error("usage: carl logout <provider>");
    return 1;
  }
  const rt = await runtime(cfg);
  await rt.logout(providerId);
  console.log(`Signed out of ${providerId}.`);
  return 0;
}
