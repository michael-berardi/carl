// Writes to carl.json's `model` go through here: the model and every configured fallback must resolve in the registry
// Carl itself reads (cfg.modelsPath), or nothing is written. A model that is not there makes the gateway start on a
// fallback or not at all (2026-11-18 crash loop), so the writer refuses by name instead.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_NOT_IN_REGISTRY = "model_not_in_registry";

export class ModelRegistryError extends Error {
  readonly code = MODEL_NOT_IN_REGISTRY;
  readonly missing: string[];
  readonly registry: string;
  constructor(missing: string[], registry: string) {
    super(`${MODEL_NOT_IN_REGISTRY}: ${missing.map((m) => `"${m}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} not in the model registry ${registry}; nothing was written to carl.json`);
    this.missing = missing;
    this.registry = registry;
    this.name = "ModelRegistryError";
  }
}

/** Throws ModelRegistryError naming every ref `resolves` rejects and the registry file consulted. */
export function checkModelsResolve(refs: string[], registry: string, resolves: (ref: string) => boolean): void {
  const missing = [...new Set(refs)].filter((ref) => {
    try { return !resolves(ref); } catch { return true; }
  });
  if (missing.length) throw new ModelRegistryError(missing, registry);
}

/** Set carl.json `model` to `ref` after checking it and the configured fallbacks resolve in `registry`. */
export function persistModel(home: string, ref: string, fallbacks: string[], registry: string, resolves: (ref: string) => boolean): void {
  checkModelsResolve([ref, ...fallbacks], registry, resolves);
  const file = join(home, "carl.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  raw.model = ref;
  writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
