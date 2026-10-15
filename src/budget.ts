// Context budget guard: oversized tool results are cut to head + tail before they reach the model.
// The full text is spilled to a file the model can read in ranges, so nothing is lost, only deferred.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

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
        const file = join(spillDir, `${Date.now().toString(36)}-${String(event.toolCallId).replace(/[^\w-]/g, "_").slice(0, 40)}.txt`);
        const full = texts.map((c: any) => c.text).join("\n");
        writeFileSync(file, full, { mode: 0o600 });
        const images = (event.content ?? []).filter((c: any) => c.type !== "text");
        return { content: [{ type: "text", text: capText(full, maxChars, file) }, ...images], isError: event.isError };
      });
    },
  };
}
