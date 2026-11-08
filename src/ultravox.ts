// Optional module: transcribe voice notes and audio attachments locally with the UltraVox app. Off unless config
// has "ultravox": {"enabled": true}. The app's control program runs inside the shell sandbox, one file at a time.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CarlConfig } from "./config.ts";
import { cleanEnv, sandboxArgv } from "./sandbox.ts";

/** First UltraVox release whose control program has `transcribe`. */
export const MIN_VERSION = "0.13.0";
const TIMEOUT_MS = 120_000;
const SETTINGS = join("Library", "Application Support", "com.imploselabs.ultravox", "settings.toml");

export interface UltravoxConfig { app?: string; model?: "v2" | "v3"; dictionary?: string }

/** Candidate control programs, in order: the configured app, then /Applications, then ~/Applications. */
export function controlCandidates(app?: string): string[] {
  const rel = join("Contents", "MacOS", "ultravox-control");
  if (app) return [app.endsWith("ultravox-control") ? app : join(app, rel)];
  return [join("/Applications/UltraVox.app", rel), join(homedir(), "Applications", "UltraVox.app", rel)];
}

export function findControl(app?: string): string | undefined {
  return controlCandidates(app).find((p) => existsSync(p));
}

/** "ultravox-control 0.13.5" -> "0.13.5". */
export function parseVersion(out: string): string {
  const m = out.match(/ultravox-control\s+v?(\d+\.\d+\.\d+)/) ?? out.match(/\bv?(\d+\.\d+\.\d+)\b/);
  if (!m) throw new Error(`could not read a version from: ${out.trim().slice(0, 120) || "(empty output)"}`);
  return m[1];
}

export function versionAtLeast(have: string, min: string): boolean {
  const a = have.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** The dictated text from `ultravox-control transcribe` output; throws with the program's own words on failure. */
export function parseTranscription(out: string): string {
  const lines = out.split(/\r?\n/);
  const err = lines.find((l) => /^\s*error:/i.test(l));
  if (err) throw new Error(err.replace(/^\s*error:\s*/i, "").trim() || "UltraVox reported an error");
  const at = lines.findIndex((l) => /^\s*transcription:/.test(l));
  if (at < 0) throw new Error(`no "transcription:" line in the output (${out.trim().slice(0, 120) || "empty"})`);
  const text = [lines[at].replace(/^\s*transcription:\s?/, "")];
  // A long dictation may wrap: lines up to the next "key: value" line belong to it.
  for (const l of lines.slice(at + 1)) { if (/^\s*[a-z][a-z _-]*:(\s|$)/i.test(l)) break; text.push(l); }
  const result = text.join("\n").trim();
  if (!result) throw new Error("no speech was recognised in the audio");
  return result;
}

/** UltraVox's own custom_dictionary (a TOML string in its settings), or "" when unset or unreadable. */
export function readCustomDictionary(settings = join(homedir(), SETTINGS)): string {
  return tomlString(settings, "custom_dictionary");
}

/** The model UltraVox is set to use (v2 English, v3 multilingual), or "" when unknown. */
export function readModelSetting(settings = join(homedir(), SETTINGS)): string {
  return tomlString(settings, "fluid_audio_model_version");
}

function tomlString(file: string, key: string): string {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return ""; }
  const multi = text.match(new RegExp(`^${key}\\s*=\\s*"""\\n?([\\s\\S]*?)"""`, "m")) ?? text.match(new RegExp(`^${key}\\s*=\\s*'''\\n?([\\s\\S]*?)'''`, "m"));
  if (multi) return multi[1].trim();
  const basic = text.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\\\n]|\\\\.)*")`, "m"));
  if (basic) { try { return String(JSON.parse(basic[1])).trim(); } catch { return ""; } }
  const lit = text.match(new RegExp(`^${key}\\s*=\\s*'([^'\\n]*)'`, "m"));
  return lit ? lit[1].trim() : "";
}

export type Runner = (argv: string[]) => Promise<string>;

/** Is this attachment audio the module should transcribe? */
export function isAudio(mime?: string, name?: string): boolean {
  return !!mime?.startsWith("audio/") || /\.(ogg|oga|opus|m4a|mp3|wav)$/i.test(name ?? "");
}

export class Ultravox {
  private readonly cfg: CarlConfig;
  private readonly conf: UltravoxConfig;
  private readonly sandbox: () => string | undefined;
  private readonly run: Runner;
  private queue: Promise<unknown> = Promise.resolve();
  private control?: string;
  private checked = false;

  /** `run` is for tests; by default the program runs under the shell sandbox with Carl's clean environment. */
  constructor(cfg: CarlConfig, sandbox: () => string | undefined, run?: Runner) {
    if (!cfg.ultravox) throw new Error("ultravox is not enabled");
    this.cfg = cfg;
    this.conf = cfg.ultravox;
    this.sandbox = sandbox;
    this.run = run ?? ((argv) => this.exec(argv));
  }

  private exec(argv: string[]): Promise<string> {
    const full = sandboxArgv(this.sandbox(), argv);
    return new Promise((resolve, reject) => {
      execFile(full[0], full.slice(1), { env: cleanEnv(this.cfg), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`;
        if (err && (err as any).killed) return reject(new Error(`UltraVox did not finish within ${TIMEOUT_MS / 1000} s`));
        // A failing control program still says why on stdout or stderr ("error: ...").
        if (err && !/^\s*error:/im.test(out)) return reject(new Error(`${argv[0]} failed: ${(out.trim() || err.message).slice(-300)}`));
        resolve(out);
      });
    });
  }

  /** Locate the control program and check its version once; later calls reuse the answer. */
  async ready(): Promise<{ control: string; version: string }> {
    const control = this.control ?? findControl(this.conf.app);
    if (!control) throw new Error(`UltraVox is not installed (looked for ${controlCandidates(this.conf.app).join(", ")})`);
    const version = parseVersion(await this.run([control, "version"]));
    if (!versionAtLeast(version, MIN_VERSION)) throw new Error(`UltraVox ${version} is too old for transcription: update the app to ${MIN_VERSION} or newer`);
    this.control = control;
    this.checked = true;
    return { control, version };
  }

  /** The model in use: the configured one, else UltraVox's own setting. */
  model(): string { return this.conf.model ?? (readModelSetting() || "default"); }

  /** Transcribe one audio file; calls run one after another. Throws an Error naming the cause. */
  transcribe(path: string): Promise<string> {
    const job = this.queue.then(() => this.one(path));
    this.queue = job.catch(() => {});
    return job;
  }

  private async one(path: string): Promise<string> {
    const { control } = this.checked && this.control ? { control: this.control } : await this.ready();
    const text = parseTranscription(await this.run([control, "transcribe", path, ...(this.conf.model ? [this.conf.model] : [])]));
    return this.fix(control, text);
  }

  private async fix(control: string, text: string): Promise<string> {
    const parts = [readCustomDictionary()];
    if (this.conf.dictionary) {
      try { parts.push(readFileSync(this.conf.dictionary, "utf8")); } catch (e) { throw new Error(`ultravox.dictionary ${this.conf.dictionary} could not be read: ${(e as Error).message}`); }
    }
    const dictionary = parts.map((p) => p.trim()).filter(Boolean).join("\n");
    if (!dictionary) return text;
    const out = await this.run([control, "dictionary-apply", text, dictionary]);
    if (/^\s*error:/im.test(out)) throw new Error(`dictionary could not be applied: ${out.replace(/^\s*error:\s*/i, "").trim()}`);
    return out.trim() || text;
  }
}

/** The line the agent sees for an audio file: the transcript, or the cause it could not be transcribed. */
export async function voiceNote(uv: Ultravox, path: string, log?: { error(msg: string, extra?: Record<string, unknown>): void }): Promise<string> {
  try {
    return `[voice note] ${await uv.transcribe(path)}`;
  } catch (e) {
    const cause = (e as Error).message;
    log?.error("UltraVox transcription failed", { error: cause, file: path });
    return `[voice note at ${path} could not be transcribed: ${cause}]`;
  }
}
