// Model routing: the primary model first; a fallback only when the primary is provably out of quota.
// "Provably" means the provider said so (quota, plan or usage limit, HTTP 402/429 from a subscription route).
// Anything else (an outage, a bad login, an unknown error) fails with its own named cause instead of
// quietly moving the work to another model.
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

const EXHAUSTED = /\b(402|429)\b|rate.?limit|usage limit|session limit|weekly limit|limit reached|quota|insufficient_quota|billing|credit balance|resets? (at|in)\b/i;

export function isExhaustion(message: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined): boolean {
  return !!message && message.stopReason === "error" && EXHAUSTED.test(message.errorMessage ?? "");
}

/** Minutes until a limit resets, when the provider says ("resets in 2h", "resets at 3pm"); else the default. */
export function cooldownMs(errorMessage: string, now = Date.now(), fallbackMs = 30 * 60_000): number {
  const rel = errorMessage.match(/resets? in (\d+)\s*(m|min|minutes?|h|hours?)/i);
  if (rel) return Number(rel[1]) * (rel[2][0].toLowerCase() === "h" ? 3_600_000 : 60_000);
  const abs = errorMessage.match(/resets? at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (abs) {
    let h = Number(abs[1]) % 12 + (abs[3]?.toLowerCase() === "pm" ? 12 : 0);
    if (!abs[3] && Number(abs[1]) >= 12) h = Number(abs[1]);
    const at = new Date(now);
    at.setHours(h, Number(abs[2] ?? 0), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime() - now;
  }
  return fallbackMs;
}

export interface RouterEvents {
  onFallback(from: string, to: string, reason: string, untilMs: number): void;
}

/** Route definition for ModelRuntime.registerVirtualModel. */
export function createRouter(opts: { primary: string | (() => string); fallbacks: string[] | (() => string[]); resolve: (ref: string) => Model<Api>; events: RouterEvents;
  /** Whether a model can be called at all (its provider has a login). A model without one is skipped, never routed to:
   * 2026-10-29 the primary had no Codex login and every turn failed with "has no credentials" while Sonnet sat unused. */
  usable?: (ref: string) => boolean }) {
  const exhaustedUntil = new Map<string, number>();
  const ref = (m: Model<Api>) => `${m.provider}/${m.id}`;
  const usable = (r: string) => { try { return opts.usable ? opts.usable(r) : true; } catch { return true; } };
  const available = (r: string) => (exhaustedUntil.get(r) ?? 0) <= Date.now() && usable(r);
  const primaryOf = () => (typeof opts.primary === "function" ? opts.primary() : opts.primary);
  const fallbacksOf = () => (typeof opts.fallbacks === "function" ? opts.fallbacks() : opts.fallbacks);
  return {
    exhaustedUntil,
    route(request: any) {
      const chain = [primaryOf(), ...fallbacksOf().filter((f) => f !== primaryOf())];
      if (request.reason === "retry" && request.failed && isExhaustion(request.failed.message)) {
        const failed = ref(request.failed.model);
        const ms = cooldownMs(request.failed.message.errorMessage ?? "");
        exhaustedUntil.set(failed, Date.now() + ms);
        const next = chain.find((r) => r !== failed && available(r));
        if (next) {
          opts.events.onFallback(failed, next, (request.failed.message.errorMessage ?? "").slice(0, 200), Date.now() + ms);
          return { model: opts.resolve(next), thinkingLevel: request.thinkingLevel };
        }
      }
      // Tool follow-ups and ordinary retries stay on the model that handled the turn (caches, signatures).
      const sticky = request.reason === "retry" ? request.failed : request.previous;
      if (request.reason !== "user" && sticky && available(ref(sticky.model))) {
        return { model: sticky.model, thinkingLevel: request.thinkingLevel };
      }
      const pick = chain.find(available) ?? primaryOf();
      return { model: opts.resolve(pick), thinkingLevel: request.thinkingLevel };
    },
  };
}
