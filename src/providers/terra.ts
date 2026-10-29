import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Provider = NonNullable<ReturnType<ModelRuntime["getProvider"]>>;
type Model = ReturnType<Provider["getModels"]>[number];

// OpenAI model documentation: https://developers.openai.com/api/docs/models/gpt-6.1-terra
// API-equivalent prices use standard 30-minute cache-write rates, not subscription charges;
// the tier applies above 272k input tokens. Codex limits and capabilities conservatively
// follow the SDK's first-party gpt-6.1-sol Codex sibling, not the API's larger window.
export const TERRA_MODEL: Model = {
  provider: "openai-codex", id: "gpt-6.1-terra", name: "GPT-6.1 Terra",
  api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api",
  type: "chat", reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000,
  thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
  inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } } },
  cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
    tiers: [{ inputTokensAbove: 272_000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }] },
};

/** Register against an uncomposed native provider, never a models.json overlay. */
export async function registerTerra(runtime: ModelRuntime): Promise<void> {
  let provider = runtime.getRegisteredNativeProvider("openai-codex");
  if (!provider) {
    // getProvider() on the target runtime includes the current models.json overlay. Using it
    // as the native base would retain removed credentials, headers and models on refresh.
    const pristine = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
      credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } });
    provider = pristine.getProvider("openai-codex");
  }
  if (!provider || provider.id !== "openai-codex") throw new Error("Native Codex provider unavailable; cannot register Terra");
  if (provider.getModels().some((model) => model.id === TERRA_MODEL.id)) return;
  const base = provider;
  const add = <T extends { id: string }>(models: readonly T[]) => models.some((model) => model.id === TERRA_MODEL.id) ? [...models] : [...models, TERRA_MODEL];
  runtime.registerNativeProvider({ ...base, getModels: () => add(base.getModels()),
    ...(base.getAllModels ? { getAllModels: () => add(base.getAllModels!()) } : {}) });
}
