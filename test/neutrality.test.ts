// Carl is a neutral tool. Its source ships no model, provider or fallback choice and no person's, client's or project's
// names: those belong in the operator's own carl.json and files. This test keeps it that way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

function privateTerms(path = process.env.OSS_PRIVATE_TERMS ?? join(homedir(), ".config/oss-audit/names.txt")): RegExp[] {
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`${/^\w/.test(term) ? "\\b" : ""}${escaped}${/\w$/.test(term) ? "\\b" : ""}`, "i");
    });
}
const hasPrivateTerm = (text: string, terms: RegExp[]) => terms.some((term) => term.test(text));

const root = fileURLToPath(new URL("..", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : (/\.(ts|js|mjs|sh|md|html)$/.test(name) || !name.includes(".")) ? [path] : [];
  });
}
const shipped = [
  ...files(join(root, "src")), ...files(join(root, "bin")), ...files(join(root, "scripts")), join(root, "README.md"),
  // The post primitive: its docs, changelog and tests ship neutral too (accounts and handles live only in an operator's carl.json).
  join(root, "docs", "POSTING.md"), join(root, "CHANGELOG.md"), join(root, "test", "post.test.ts"), join(root, "test", "post-fake.ts"), join(root, "test", "feedback.test.ts"), join(root, "test", "group-work.test.ts"),
];

// Concrete model ids that only an operator should choose. Adapter code for a provider (src/providers/claude-code.ts
// lists the Claude Code CLI's own models) and the UltraTerm picker contract (src/compat/ultraterm.ts) are the exceptions.
const MODEL_CHOICE = /\b(?:gpt-\d[\w.-]*|deepseek-v\d[\w.-]*|opencode-go\/|:exacto\b|mimo-v\d|glm-\d)/i;
const ADAPTERS = ["src/providers/claude-code.ts", "src/compat/ultraterm.ts"];
// Names of the people and organisations Carl was first built for: never in the shipped tool.
const PERSONAL = /\b(?:Mike|Berardi|Felix|Mouseia|libertydesign)\b|\/Users\/[a-z]/;

test("source and README ship no default model or fallback choice", () => {
  const hits = shipped.filter((f) => !ADAPTERS.some((a) => f.endsWith(a)))
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i + 1, line] as const))
    .filter(([, , line]) => MODEL_CHOICE.test(line))
    .map(([f, n, line]) => `${f.slice(root.length)}:${n}: ${line.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
});

// Tests and fixtures are public too: a real chat id or a client's name copied into a fixture leaks as surely as source does.
const PUBLIC = [...shipped, ...files(join(root, "test")).filter((f) => !f.endsWith("neutrality.test.ts")), ...files(join(root, "docs"))];

test("source, docs, tests and README name no person, client or project", () => {
  const hits = [...new Set(PUBLIC)]
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i + 1, line] as const))
    .filter(([f, , line]) => PERSONAL.test(line) && !(f.endsWith("src/guard.ts") && line.includes('"/Users"')))
    .map(([f, n, line]) => `${f.slice(root.length)}:${n}: ${line.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
  const terms = privateTerms();
  const privateHits = [...new Set(PUBLIC)].filter((f) =>
    readFileSync(f, "utf8").split("\n").some((line) =>
      hasPrivateTerm(line, terms) && !(f.endsWith("src/guard.ts") && line.includes('"/Users"'))));
  assert.deepEqual(privateHits.map((f) => f.slice(root.length)), []);
});

test("private term loader matches literal terms", () => {
  const dir = mkdtempSync(join(tmpdir(), "neutrality-"));
  try {
    const path = join(dir, "terms.txt");
    writeFileSync(path, "# comment\n\nzzqx-private.term\n");
    const sample = join(dir, "sample.txt");
    writeFileSync(sample, "a ZZQX-private.term here");
    const terms = privateTerms(path);
    assert.equal(hasPrivateTerm(readFileSync(sample, "utf8"), terms), true);
    writeFileSync(sample, "a neutral line");
    assert.equal(hasPrivateTerm(readFileSync(sample, "utf8"), terms), false);
    assert.equal(hasPrivateTerm("zzqx-privateXterm", terms), false);
    assert.equal(hasPrivateTerm("xzzqx-private.term", terms), false);
    assert.deepEqual(privateTerms(join(dir, "missing")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the post primitive ships no account, handle or platform preference: accounts come from operator config only", () => {
  const post = shipped.filter((f) => f.includes("/src/post/") || f.endsWith("POSTING.md") || f.includes("/test/post"));
  assert.ok(post.length >= 10, "the post files are covered");
  const hits = post
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i + 1, line] as const))
    // Only the documentation example handle "example" is allowed in a profile URL; nothing else may look like an account.
    .filter(([, , line]) => /(?:x|twitter|linkedin|bsky|threads)\.(?:com|app|net)\/@?(?!example\b|<|compose\b|i\/)[A-Za-z0-9_]+/i.test(line) || /@[A-Za-z0-9_]{3,}\b(?<!@example)/.test(line))
    .map(([f, n, line]) => `${f.slice(root.length)}:${n}: ${line.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
});

test("shipped code names no coordinator: no overseer, coordinator_, coordinator- or ut-coordinator literal in src, bin, scripts or the web files", () => {
  const scan = [...files(join(root, "src")), ...files(join(root, "bin")), ...files(join(root, "scripts"))];
  assert.ok(scan.length > 20, "the folders are covered");
  const hits = scan
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => [f, i + 1, line] as const))
    .filter(([, , line]) => /overseer|coordinator[_-]|ut-coordinator/i.test(line))
    .map(([f, n, line]) => `${f.slice(root.length)}:${n}: ${line.trim().slice(0, 120)}`);
  assert.deepEqual(hits, []);
});

test("the principles ship: README states private, free and neutral, and the starter Self holds neutrality", async () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /## Principles\n\nCarl is private, free and neutral\./);
  for (const p of ["Private", "Free", "Neutral"]) assert.match(readme, new RegExp(`- \\*\\*${p}\\.\\*\\*`));
  // Neutral: no preferred model, harness or ideology; the operator gives Carl its values.
  const neutral = /- \*\*Neutral\.\*\*([^\n]*)/.exec(readme)?.[1] ?? "";
  for (const word of ["model", "harness", "ideology", "values"]) assert.match(neutral, new RegExp(word), word);
  const { DEFAULT_SELF } = await import("../src/psyche.ts");
  assert.match(DEFAULT_SELF, /Stay neutral on contested questions/);
});
