// The UltraTerm picker's model write must refuse a ref the registry cannot resolve, and leave carl.json untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { persistModel } from "../src/compat/ultraterm.ts";

const registry = new Set(["opencode-go/hy4-flash-free"]);
const resolve = (ref: string) => { if (!registry.has(ref)) throw new Error(`model "${ref}" is not in Pi's registry`); return ref; };

// The writer as it was before the guard: writes whatever ref it is given.
function oldPersistModel(home: string, ref: string): void {
  const file = join(home, "carl.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.model = ref;
  writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "carl-persist-model-"));
  writeFileSync(join(dir, "carl.json"), JSON.stringify({ model: "opencode-go/hy4-flash-free" }, null, 2) + "\n");
  return dir;
}

test("the old writer persists an unresolvable ref (the failure this guards against)", () => {
  const dir = home();
  try {
    oldPersistModel(dir, "opencode-go/not-in-registry");
    assert.equal(JSON.parse(readFileSync(join(dir, "carl.json"), "utf8")).model, "opencode-go/not-in-registry");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("persistModel refuses an unresolvable ref with a named error and writes nothing", () => {
  const dir = home();
  try {
    const before = readFileSync(join(dir, "carl.json"), "utf8");
    assert.throws(() => persistModel(dir, "opencode-go/not-in-registry", resolve),
      /refusing to write "opencode-go\/not-in-registry" to carl.json: it does not resolve in the model registry/);
    assert.equal(readFileSync(join(dir, "carl.json"), "utf8"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("persistModel writes a resolvable ref", () => {
  const dir = home();
  try {
    persistModel(dir, "opencode-go/hy4-flash-free", resolve);
    assert.equal(JSON.parse(readFileSync(join(dir, "carl.json"), "utf8")).model, "opencode-go/hy4-flash-free");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
