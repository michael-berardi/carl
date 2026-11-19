// `carl doctor` for a model on the `local` provider (served by an on-demand llama-server that a local-model manager
// starts under a lease): ask the manager whether the model would start now, without starting anything.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { operatorPathDirs } from "./sandbox.ts";

export const LOCAL_PROVIDER = "local";
export interface LocalCheck { ok: boolean; detail: string }

/** Turn the exit status and output of `steak-pi local check <id>` into one line. Exit 0: fits; anything else is a named cause. */
export function classifyLocalCheck(id: string, r: { status: number | null; stdout?: string; stderr?: string; error?: Error & { code?: string } }): LocalCheck {
  if (r.error?.code === "ENOENT") return { ok: false, detail: "`steak-pi` is not on PATH, so Carl cannot tell whether the local model can start; install Steak Pi (it manages local models) or fix PATH" };
  if (r.error?.code === "ETIMEDOUT") return { ok: false, detail: `\`steak-pi local check ${id}\` did not answer within its time limit` };
  if (r.error) return { ok: false, detail: `could not run \`steak-pi local check ${id}\`: ${r.error.message}` };
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = text.find((l) => /REFUSED/.test(l)) ?? text.find((l) => /^ok:/.test(l)) ?? text[0] ?? "";
  if (r.status === 0) return { ok: true, detail: line.replace(/^ok:\s*/, "") || `local/${id} can start` };
  if (r.status === 1 && (!line || /REFUSED \((?:unknown-model|bad-id)\)/.test(line))) return { ok: false, detail: `${line || `unknown local model ${id}`} (add it with \`steak-pi local add\`)` };
  if (r.status === 1) return { ok: false, detail: `\`steak-pi local check ${id}\` failed: ${line}` };
  return { ok: false, detail: `${line || `exit ${r.status}`}; turns fall through to fallbackModels while this holds` };
}

/** The manager is looked up on the operator's PATH (Carl's own PATH is a trusted one of fixed programs once the brain started). */
export function findManager(dirs: string[] = operatorPathDirs()): string | undefined {
  for (const d of dirs) {
    try { const f = join(d, "steak-pi"); accessSync(f, constants.X_OK); return f; } catch { /* next folder */ }
  }
  return undefined;
}

export function checkLocalModel(id: string, timeoutMs = 15_000): LocalCheck {
  const bin = findManager();
  if (!bin) return classifyLocalCheck(id, { status: null, error: Object.assign(new Error("steak-pi not found"), { code: "ENOENT" }) });
  return classifyLocalCheck(id, spawnSync(bin, ["local", "check", id], { encoding: "utf8", timeout: timeoutMs }));
}
