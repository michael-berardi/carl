// Private by default. Carl itself sends nothing anywhere except to the model providers and chat platforms you configure,
// plus one daily look at its own latest GitHub release (src/update.ts; turn it off with update.check false or CARL_OFFLINE=1).
// This module switches off what the libraries underneath would otherwise send. Imported first by src/main.ts.

/** Environment that keeps the Pi SDK from reaching its own servers (version checks, install reports, catalog refreshes,
 *  package and tool downloads) and from adding its attribution headers to provider requests. */
export const PI_PRIVATE_ENV = { PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" } as const;

/** Claude Code's documented switches for usage metrics, error reports, surveys, update checks and other nonessential traffic. */
export const CLAUDE_PRIVATE_ENV = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
} as const;

/**
 * Applied to this process before any SDK module reads it. The SDK treats any PI_OFFLINE value as offline, so an operator
 * who needs it online (to install an `npm:` or `git:` extension, say) sets PI_OFFLINE=0 and Carl removes the variable.
 */
export function applyPrivateDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (/^(0|false|no)$/i.test(env.PI_OFFLINE ?? "")) delete env.PI_OFFLINE;
  else env.PI_OFFLINE ??= PI_PRIVATE_ENV.PI_OFFLINE;
  env.PI_TELEMETRY ??= PI_PRIVATE_ENV.PI_TELEMETRY;
  env.PI_SKIP_VERSION_CHECK ??= PI_PRIVATE_ENV.PI_SKIP_VERSION_CHECK;
}

applyPrivateDefaults();
