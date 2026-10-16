import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

export const VERSION: string = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;

/** Commit of the running code: COMMIT written by the release install, else the git checkout's HEAD, else "unknown". */
export const COMMIT: string = (() => {
  try {
    return readFileSync(new URL("COMMIT", root), "utf8").trim();
  } catch {}
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return "unknown";
  }
})();
