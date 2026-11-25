// Context budget guard: oversized tool results are cut to head + tail before they reach the model.
// The full text is spilled to a file the model can read in ranges, so nothing is lost, only deferred.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

export const DEFAULT_SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SPILL_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_SPILL_CAP_MIN_AGE_MS = 60 * 60 * 1000;

/** Remove expired or excess spill files from `<home>/spill`. Skips symlinks and non-regular files. */
export function sweepSpillDir(
  spillDir: string,
  opts?: { maxAgeMs?: number; maxBytes?: number; minCapAgeMs?: number; now?: number },
): { removed: number; freedBytes: number } {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_SPILL_MAX_AGE_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_SPILL_MAX_BYTES;
  const minCapAgeMs = opts?.minCapAgeMs ?? DEFAULT_SPILL_CAP_MIN_AGE_MS;
  const now = opts?.now ?? Date.now();
  let names: string[];
  try {
    const dirSt = lstatSync(spillDir);
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) return { removed: 0, freedBytes: 0 };
    names = readdirSync(spillDir);
  } catch {
    return { removed: 0, freedBytes: 0 };
  }
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".txt")) continue;
    const full = join(spillDir, name);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }
  let removed = 0;
  let freedBytes = 0;
  const kept: typeof files = [];
  for (const f of files) {
    if (now - f.mtimeMs > maxAgeMs) {
      try {
        unlinkSync(f.path);
        removed++;
        freedBytes += f.size;
      } catch {
        // Ignore races.
      }
    } else {
      kept.push(f);
    }
  }
  let total = kept.reduce((acc, f) => acc + f.size, 0);
  if (total > maxBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of kept) {
      if (total <= maxBytes) break;
      if (now - f.mtimeMs < minCapAgeMs) continue;
      try {
        unlinkSync(f.path);
        removed++;
        freedBytes += f.size;
        total -= f.size;
      } catch {
        // Ignore races.
      }
    }
  }
  return { removed, freedBytes };
}

export function capText(text: string, max: number, spillPath: string): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.3));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n[… ${omitted.toLocaleString()} characters omitted to protect the context. Full output: ${spillPath} (read it with offset/limit, or grep it).]\n\n${tail}`;
}

export function resultBudget(spillDir: string, maxChars: number): InlineExtension {
  return {
    name: "carl-result-budget",
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_result", (event: any) => {
        if (event.parentToolCallId) return undefined; // nested calls inside a codemode script never reach the model
        const texts = (event.content ?? []).filter((c: any) => c.type === "text");
        const total = texts.reduce((n: number, c: any) => n + c.text.length, 0);
        if (total <= maxChars) return undefined;
        mkdirSync(spillDir, { recursive: true, mode: 0o700 });
        const file = join(spillDir, `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}-${String(event.toolCallId).replace(/[^\w-]/g, "_").slice(0, 40)}.txt`);
        const full = texts.map((c: any) => c.text).join("\n");
        // The spill folder is agent-writable: create the file exclusively so a planted link is never followed.
        writeFileSync(file, full, { mode: 0o600, flag: "wx" });
        const images = (event.content ?? []).filter((c: any) => c.type !== "text");
        return { content: [{ type: "text", text: capText(full, maxChars, file) }, ...images], isError: event.isError };
      });
    },
  };
}
