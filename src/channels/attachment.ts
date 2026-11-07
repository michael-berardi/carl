// Shared file handling for the channels: capped downloads and exclusive writes into the media folder.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Download bytes with a hard cap; a larger response fails naming the limit. */
export async function downloadCapped(url: string, maxBytes: number, init?: RequestInit): Promise<Buffer> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error(`attachment exceeds ${maxBytes} byte limit`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`attachment exceeds ${maxBytes} byte limit`);
  return data;
}

/** Save bytes in the media folder under a fresh unguessable name (mode 0600, created exclusively). */
export function saveMedia(mediaDir: string, name: string, data: Buffer): string {
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  const clean = (name || "file").replace(/[^\w.-]+/g, "_");
  const path = join(mediaDir, `${Date.now()}-${randomBytes(4).toString("hex")}-${clean}`);
  writeFileSync(path, data, { mode: 0o600, flag: "wx" });
  return path;
}
