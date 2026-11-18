// carl.json's model is written only after it and every fallback resolve in the registry Carl reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRegistryError, persistModel } from "../src/model-guard.ts";

const REGISTRY = "/agent/models.json";
const registry = (...known: string[]) => (ref: string) => known.includes(ref);

function withHome(fn: (home: string, read: () => any) => void) {
  const home = mkdtempSync(join(tmpdir(), "carl-guard-"));
  try {
    writeFileSync(join(home, "carl.json"), JSON.stringify({ model: "a/old", fallbackModels: ["a/fb"] }));
    fn(home, () => JSON.parse(readFileSync(join(home, "carl.json"), "utf8")));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("a model missing from the registry is refused by name with the registry file, and carl.json is untouched", () => {
  withHome((home, read) => {
    assert.throws(() => persistModel(home, "a/free", ["a/fb"], REGISTRY, registry("a/old", "a/fb")), (e: any) => {
      assert.ok(e instanceof ModelRegistryError);
      assert.equal(e.code, "model_not_in_registry");
      assert.deepEqual(e.missing, ["a/free"]);
      assert.match(e.message, /"a\/free" is not in the model registry \/agent\/models\.json/);
      return true;
    });
    assert.equal(read().model, "a/old");
  });
});

test("a fallback missing from the registry is refused too, naming it", () => {
  withHome((home, read) => {
    assert.throws(() => persistModel(home, "a/new", ["a/fb", "b/gone"], REGISTRY, registry("a/new", "a/fb")), /"b\/gone" is not in the model registry/);
    assert.equal(read().model, "a/old");
  });
});

test("when everything resolves the model is written and other settings are kept", () => {
  withHome((home, read) => {
    persistModel(home, "a/new", ["a/fb"], REGISTRY, registry("a/new", "a/fb"));
    assert.equal(read().model, "a/new");
    assert.deepEqual(read().fallbackModels, ["a/fb"]);
  });
});
