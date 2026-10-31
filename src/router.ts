// Model routing: the primary model first; the next model in the chain only when the primary provably cannot answer.
// "Provably" means the provider said so: out of quota or credits (a plan, usage or session limit, HTTP 402/429), the
// route has no endpoints (OpenRouter's 404 "No endpoints available"), or a 5xx outage before any output. Anything
// else (a bad login, a malformed request, an unknown error) fails with its own named cause instead of quietly
// moving the work to another model. A model that failed stays benched for its reset hint, or a short cooldown when
// it gave none.
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

const QUOTA = /\b(402|429)\b|rate.?limit|usage limit|session limit|weekly limit|limit reached|quota|insufficient_quota|insufficient credits|billing|credit balance|resets? (at|in)\b/i;
// 5xx only when the message names a status: "HTTP 503", "status 502", "code 500", "5xx". A bare number in a reset
// hint ("resets in 500 seconds") is not an outage.
const OUTAGE = /(?:http(?:\/\d(?:\.\d)?)?|status|code)\s*[:=]?\s*5\d\d\b|\b5xx\b|bad gateway|service unavailable|gateway time-?out|internal server error|overloaded/i;
const NO_ENDPOINTS = /no endpoints? (?:available|found)|no available (?:endpoints?|providers?)|no provider (?:available|found)/i;

export function isExhaustion(message: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined): boolean {
  if (!message || message.stopReason !== "error") return false;
  const text = message.errorMessage ?? "";
  return QUOTA.test(text) || OUTAGE.test(text) || NO_ENDPOINTS.test(text);
}

/** True when the failure is a provider outage or a route with no endpoints, not a quota refusal. */
export function isOutage(message: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined): boolean {
  if (!message || message.stopReason !== "error") return false;
  const text = message.errorMessage ?? "";
  return !QUOTA.test(text) && (OUTAGE.test(text) || NO_ENDPOINTS.test(text));
}

/**
 * How long to bench the failed model: the provider's own reset hint when it gave one, 2 minutes after a 5xx outage,
 * 10 minutes for a route with no endpoints (the model or its provider set is unavailable), else the default.
 */
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
  if (NO_ENDPOINTS.test(errorMessage)) return 10 * 60_000;
  if (OUTAGE.test(errorMessage)) return 2 * 60_000;
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
        // Move the work only when the failure produced nothing: a partial answer or a started tool call belongs to
        // the model that wrote it. A failed retry arrives here with the failed message stripped from `messages`.
        const silent = !(request.failed.message.content?.length);
        const ms = cooldownMs(request.failed.message.errorMessage ?? "");
        exhaustedUntil.set(failed, Date.now() + ms);
        const next = silent ? chain.find((r) => r !== failed && available(r)) : undefined;
        if (next) {
          opts.events.onFallback(failed, next, (request.failed.message.errorMessage ?? "").slice(0, 200), Date.now() + ms);
          return { model: opts.resolve(next), thinkingLevel: request.thinkingLevel };
        }
        // The failure came after output: finish this turn on the model that started it (its caches and tool calls
        // belong to it). The model is benched either way, so the next turn starts on the next tier.
        if (!silent) return { model: request.failed.model, thinkingLevel: request.thinkingLevel };
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
