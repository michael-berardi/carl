import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("init seeds Terra and preserves an existing model on rerun", () => {
  const home = mkdtempSync(join(tmpdir(), "carl-init-"));
  try {
    const init = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "init"], {
      env: { ...process.env, CARL_HOME: home }, encoding: "utf8",
    });
    const first = init();
    assert.equal(first.status, 0, first.stderr);
    const file = join(home, "carl.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).model, "openai-codex/gpt-6.1-terra");
    const existing = JSON.stringify({ model: "openai-codex/gpt-6.1-sol" });
    writeFileSync(file, existing);
    const second = init();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(file, "utf8"), existing);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
