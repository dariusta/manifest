import type { AuthType, ModelCapability, ModelModality } from 'manifest-shared';

/**
 * Hand-curated capability facts for models where both the provider's own
 * metadata and models.dev are silent.
 *
 * **Authority:** modalities already discovered from the provider or models.dev
 * win, except for Code Assist's fixed subscription catalog: it has no modality
 * discovery, so old inferred text-only snapshots must be repaired. Capability
 * lists are positive assertions, so they merge; an upstream omission means
 * unknown, never unsupported. Keep this list minimal: add an
 * entry only when support was confirmed against the provider's actual behavior
 * and no upstream catalog carries it.
 */
interface KnownCapabilities {
  input: readonly ModelModality[];
  output: readonly ModelModality[];
  capabilities: readonly ModelCapability[];
}

const TEXT_IMAGE_TOOLS: KnownCapabilities = {
  input: ['text', 'image'],
  output: ['text'],
  capabilities: ['text', 'image', 'tools', 'stream'],
};
const TEXT_IMAGE_VIDEO_TOOLS: KnownCapabilities = {
  input: ['text', 'image', 'video'],
  output: ['text'],
  capabilities: ['text', 'image', 'video', 'tools', 'stream'],
};
const TEXT_TOOLS: KnownCapabilities = {
  input: ['text'],
  output: ['text'],
  capabilities: ['text', 'tools', 'stream'],
};
const MULTIMODAL_TOOLS: KnownCapabilities = {
  input: ['text', 'image', 'audio', 'video'],
  output: ['text'],
  capabilities: ['text', 'image', 'audio', 'video', 'tools', 'stream'],
};

// Code Assist uses private wire IDs rather than the public Gemini API names.
// Those IDs have no models.dev modality entry. Keep the list explicit so a
// future speech-only or image-generation model is not promoted by a prefix.
const GEMINI_SUBSCRIPTION_MODELS = new Set([
  'gemini-pro-agent',
  'gemini-3.1-pro-low',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-tiered',
]);

/** Keyed by `<provider-id>/<model-id>`, lowercase. */
const KNOWN_MODEL_MODALITIES: Readonly<Record<string, KnownCapabilities>> = {
  // https://ai.google.dev/gemini-api/docs/long-context
  // https://ai.google.dev/gemini-api/docs/video-understanding
  ...Object.fromEntries(
    [...GEMINI_SUBSCRIPTION_MODELS].map((id) => [`gemini/${id}`, MULTIMODAL_TOOLS]),
  ),
  'gemini/gemini-3.8-flash': MULTIMODAL_TOOLS,
  'gemini/gemini-3.7-flash': MULTIMODAL_TOOLS,
  'gemini/gemini-3.1-pro-preview': MULTIMODAL_TOOLS,
  // Live Codex discovery carries `input_modalities`, but the curated
  // subscription fallback and API-key `/v1/models` do not, and models.dev
  // lags behind new launches. These facts cover that gap (#2537).
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  'openai/gpt-6.1-sol': TEXT_IMAGE_TOOLS,
  'openai/gpt-6-astra': TEXT_IMAGE_TOOLS,
  'openai/gpt-6-sol': TEXT_IMAGE_TOOLS,
  'openai/gpt-6-luna': TEXT_IMAGE_TOOLS,
  'openai/gpt-5.6-sol': TEXT_IMAGE_TOOLS,
  'openai/gpt-5.6-terra': TEXT_IMAGE_TOOLS,
  'openai/gpt-5.6-luna': TEXT_IMAGE_TOOLS,
  'openai/gpt-5.5': TEXT_IMAGE_TOOLS,
  'openai/gpt-5.4': TEXT_IMAGE_TOOLS,
  'openai/gpt-5.4-mini': TEXT_IMAGE_TOOLS,
  // Rejects image input (#2537).
  'openai/gpt-5.3-codex-spark': TEXT_TOOLS,
  // Kimi Coding Plan has no /models endpoint and the subscription catalog is
  // curated, so no upstream source carries these modalities. Keys use the
  // wire-format ids the coding endpoint expects (k3, not kimi-k3).
  'moonshot/k3': TEXT_IMAGE_VIDEO_TOOLS,
  'moonshot/k3-256k': TEXT_IMAGE_TOOLS,
  'moonshot/kimi-for-coding': TEXT_IMAGE_VIDEO_TOOLS,
  'moonshot/kimi-for-coding-highspeed': TEXT_IMAGE_VIDEO_TOOLS,
};

export function lookupKnownModalities(
  providerId: string,
  modelId: string,
): KnownCapabilities | undefined {
  const provider = providerId.toLowerCase() === 'google' ? 'gemini' : providerId.toLowerCase();
  return KNOWN_MODEL_MODALITIES[`${provider}/${modelId.toLowerCase()}`];
}

/** CCA has no modality discovery; replace old inferred text-only snapshots. */
export function lookupKnownSubscriptionModalities(
  providerId: string,
  modelId: string,
  authType: AuthType | undefined,
): KnownCapabilities | undefined {
  if (authType !== 'subscription' || !['gemini', 'google'].includes(providerId.toLowerCase()))
    return undefined;
  if (!GEMINI_SUBSCRIPTION_MODELS.has(modelId.toLowerCase())) return undefined;
  return MULTIMODAL_TOOLS;
}
