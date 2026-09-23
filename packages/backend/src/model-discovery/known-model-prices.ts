/**
 * Hand-curated, per-provider authoritative pricing.
 *
 * **Priority:** entries here win over models.dev and the OpenRouter cache
 * during model discovery. The reason: the same model id can exist on
 * multiple inference providers at different prices (e.g. `qwen/qwen3-32b`
 * appears in Qwen's OR listing at one price and is also served by Groq at
 * a different price), and a connection's reported pricing must reflect
 * *that connection's provider*, not whatever is cheapest in upstream
 * catalogs.
 *
 * Keep this list minimal. Add an entry only when:
 *  1. The provider's native API does not return pricing, AND
 *  2. The model id either isn't in upstream catalogs, OR is in them under
 *     a different inference provider with different pricing.
 *
 * Prices are per-token (not per-million).
 *
 * Sources:
 *  - Moonshot v1: https://platform.moonshot.cn/docs/pricing (¥12/1M ≈ $1.66/1M at 2025 rates)
 *  - gemma-3-1b-it: Free on Google AI Studio
 *  - OpenAI aliases/previews: https://developers.openai.com/api/docs/models/<id>
 *    — the native /v1/models endpoint returns no pricing and these ids are
 *    absent from models.dev and OpenRouter, so they surfaced unpriced.
 */

interface KnownPrice {
  input: number;
  output: number;
}

const PER_MILLION = 1_000_000;

/**
 * Map of model ID prefixes → per-token pricing.
 * Prefix matching allows one entry to cover multiple context-window variants
 * (e.g. "moonshot-v1-" covers moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k).
 */
const KNOWN_PRICES: ReadonlyArray<{ prefix: string; price: KnownPrice }> = [
  { prefix: 'moonshot-v1-', price: { input: 1.66 / PER_MILLION, output: 1.66 / PER_MILLION } },
  { prefix: 'gemma-3-1b-it', price: { input: 0, output: 0 } },
  // gemini-pro-latest is Google's alias for the current Gemini Pro (2.5 Pro)
  { prefix: 'gemini-pro-latest', price: { input: 1.25 / PER_MILLION, output: 10.0 / PER_MILLION } },
  // OpenAI: the ChatGPT-parity alias. Versioned gpt-5.x-chat-latest ids are
  // priced by models.dev and do not share this prefix.
  { prefix: 'chat-latest', price: { input: 5.0 / PER_MILLION, output: 30.0 / PER_MILLION } },
  // OpenAI GPT-5 generation aliases still served by the API but retired from
  // upstream catalogs. Exact ids only — gpt-5.3-codex is a different rate.
  { prefix: 'gpt-5-chat-latest', price: { input: 1.25 / PER_MILLION, output: 10.0 / PER_MILLION } },
  {
    prefix: 'gpt-5.1-chat-latest',
    price: { input: 1.25 / PER_MILLION, output: 10.0 / PER_MILLION },
  },
  { prefix: 'gpt-5-codex', price: { input: 1.25 / PER_MILLION, output: 10.0 / PER_MILLION } },
  // OpenAI search previews: token rates only; the per-call web-search fee is
  // billed separately by OpenAI and is not a per-token price.
  {
    prefix: 'gpt-4o-search-preview',
    price: { input: 2.5 / PER_MILLION, output: 10.0 / PER_MILLION },
  },
  {
    prefix: 'gpt-4o-mini-search-preview',
    price: { input: 0.15 / PER_MILLION, output: 0.6 / PER_MILLION },
  },
];

export function lookupKnownPrice(modelId: string): KnownPrice | null {
  for (const entry of KNOWN_PRICES) {
    if (modelId.startsWith(entry.prefix) || modelId === entry.prefix) {
      return entry.price;
    }
  }
  return null;
}
