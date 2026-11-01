import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("init writes no model choice of its own and preserves an existing model on rerun", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-init-"));
  try {
    const init = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "init"], {
      env: { ...process.env, CARL_HOME: home }, encoding: "utf8",
    });
    const first = init();
    assert.equal(first.status, 0, first.stderr);
    const file = join(home, "carl.json");
    const seeded = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(seeded.model, "", "the operator chooses the model");
    assert.deepEqual(seeded.fallbackModels, []);
    assert.match(first.stdout, /set "model": "provider\/model"/);
    const existing = JSON.stringify({ model: "provider-a/model-1" });
    writeFileSync(file, existing);
    const second = init();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(file, "utf8"), existing);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
