// Carl is a neutral tool. Its source ships no model, provider or fallback choice and no person's, client's or project's
// names: those belong in the operator's own carl.json and files. This test keeps it that way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|js|sh|md)$/.test(name) ? [path] : [];
  });
}
const shipped = [...files(join(root, "src")), ...files(join(root, "bin")), ...files(join(root, "scripts")), join(root, "README.md")];

// Concrete model ids that only an operator should choose. Adapter code for a provider (src/providers/claude-code.ts
// lists the Claude Code CLI's own models) and the UltraTerm picker contract (src/compat/ultraterm.ts) are the exceptions.
const MODEL_CHOICE = /\b(?:gpt-\d[\w.-]*|deepseek-v\d[\w.-]*|opencode-go\/|:exacto\b|mimo-v\d|glm-\d)/i;
const ADAPTERS = ["src/providers/claude-code.ts", "src/compat/ultraterm.ts"];
// Names of the people and organisations Carl was first built for: never in the shipped tool.
const PERSONAL = /\b(?:Mike|Berardi|Kate|Felix|Lucero|PlataPlace|Mouseia|libertydesign|UltraLDSBot)\b|\/Users\/[a-z]/;

test("source and README ship no default model or fallback choice", () => {
  const hits = shipped.filter((f) => !ADAPTERS.some((a) => f.endsWith(a)))
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i + 1, line] as const))
    .filter(([, , line]) => MODEL_CHOICE.test(line))
    .map(([f, n, line]) => `${f.slice(root.length)}:${n}: ${line.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
});

test("source and README name no person, client or project", () => {
  const hits = shipped
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i + 1, line] as const))
    .filter(([f, , line]) => PERSONAL.test(line) && !(f.endsWith("src/guard.ts") && line.includes('"/Users"')))
    .map(([f, n, line]) => `${f.slice(root.length)}:${n}: ${line.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
});
