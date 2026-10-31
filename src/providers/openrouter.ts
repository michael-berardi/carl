import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Provider = NonNullable<ReturnType<ModelRuntime["getProvider"]>>;
type Model = ReturnType<Provider["getModels"]>[number];

// OpenRouter model page: https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017:exacto
// The :exacto suffix asks OpenRouter for its quality-first "Exacto" provider sort: the variant OpenRouter
// routes to the provider set that scores highest on tool-call and instruction accuracy, not the cheapest one.
// Pi's catalog lists the plain deepseek/deepseek-v4.1-flash id only, so Carl registers this route itself.
// Prices are OpenRouter's per-1M-token API rates for the Exacto variant, in USD; the variant is text-only.
export const OPENROUTER_EXACTO_MODEL: Model = {
  provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017:exacto", name: "DeepSeek V4.1 Flash 1017 (Exacto)",
  api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
  type: "chat", reasoning: true, input: ["text"], contextWindow: 1_048_576, maxTokens: 65_536,
  // Same thinking levels as the catalog's deepseek/deepseek-v4.1-flash sibling; "medium" has no Exacto effort,
  // so Pi clamps Carl's default to the nearest level the variant supports.
  thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
  compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", supportsStrictMode: true,
    sendSessionAffinityHeaders: true, requiresReasoningContentOnAssistantMessages: true },
  cost: { input: 0.15, output: 0.6, cacheRead: 0.013, cacheWrite: 0 },
};

/** Register against an uncomposed native provider, never a models.json overlay. */
export async function registerOpenRouter(runtime: ModelRuntime): Promise<void> {
  let provider = runtime.getRegisteredNativeProvider("openrouter");
  if (!provider) {
    // getProvider() on the target runtime includes the current models.json overlay. Using it
    // as the native base would retain removed credentials, headers and models on refresh.
    const pristine = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
      credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } });
    provider = pristine.getProvider("openrouter");
  }
  if (!provider || provider.id !== "openrouter") throw new Error("Native OpenRouter provider unavailable; cannot register the Exacto route");
  if (provider.getModels().some((model) => model.id === OPENROUTER_EXACTO_MODEL.id)) return;
  const base = provider;
  const add = <T extends { id: string }>(models: readonly T[]) => models.some((model) => model.id === OPENROUTER_EXACTO_MODEL.id) ? [...models] : [...models, OPENROUTER_EXACTO_MODEL];
  runtime.registerNativeProvider({ ...base, getModels: () => add(base.getModels()),
    ...(base.getAllModels ? { getAllModels: () => add(base.getAllModels!()) } : {}) });
}
