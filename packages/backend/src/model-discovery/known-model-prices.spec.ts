import { lookupKnownPrice } from './known-model-prices';

describe('lookupKnownPrice', () => {
  it('should return pricing for moonshot-v1-8k', () => {
    const result = lookupKnownPrice('moonshot-v1-8k');
    expect(result).not.toBeNull();
    expect(result!.input).toBeCloseTo(1.66 / 1_000_000, 12);
    expect(result!.output).toBeCloseTo(1.66 / 1_000_000, 12);
  });

  it('should return pricing for moonshot-v1-32k', () => {
    const result = lookupKnownPrice('moonshot-v1-32k');
    expect(result).not.toBeNull();
  });

  it('should return pricing for moonshot-v1-128k', () => {
    const result = lookupKnownPrice('moonshot-v1-128k');
    expect(result).not.toBeNull();
  });

  it('should return pricing for moonshot-v1-128k-vision-preview', () => {
    const result = lookupKnownPrice('moonshot-v1-128k-vision-preview');
    expect(result).not.toBeNull();
  });

  it('should return pricing for moonshot-v1-auto', () => {
    const result = lookupKnownPrice('moonshot-v1-auto');
    expect(result).not.toBeNull();
  });

  it('should return zero pricing for gemma-3-1b-it', () => {
    const result = lookupKnownPrice('gemma-3-1b-it');
    expect(result).not.toBeNull();
    expect(result!.input).toBe(0);
    expect(result!.output).toBe(0);
  });

  it('should return pricing for gemini-pro-latest', () => {
    const result = lookupKnownPrice('gemini-pro-latest');
    expect(result).not.toBeNull();
    expect(result!.input).toBeCloseTo(1.25 / 1_000_000, 12);
    expect(result!.output).toBeCloseTo(10.0 / 1_000_000, 12);
  });

  it('should return null for unknown model', () => {
    expect(lookupKnownPrice('gpt-4o')).toBeNull();
  });

  it('should return null for partial prefix mismatch', () => {
    expect(lookupKnownPrice('moonshot-v2-8k')).toBeNull();
  });

  describe('OpenAI models the native /models endpoint lists but no catalog prices', () => {
    // OpenAI's API returns no pricing, and these ids are absent from both
    // models.dev and OpenRouter, so without a curated entry they surfaced as
    // usage-based models with no price. Values come from the official model
    // pages at developers.openai.com/api/docs/models/<id> (per 1M tokens).
    it.each([
      ['chat-latest', 5.0, 30.0],
      ['gpt-5-chat-latest', 1.25, 10.0],
      ['gpt-5.1-chat-latest', 1.25, 10.0],
      ['gpt-5-codex', 1.25, 10.0],
      ['gpt-4o-search-preview', 2.5, 10.0],
      ['gpt-4o-mini-search-preview', 0.15, 0.6],
    ])('prices %s at $%s in / $%s out per 1M', (modelId, input, output) => {
      const result = lookupKnownPrice(modelId);
      expect(result).not.toBeNull();
      expect(result!.input).toBeCloseTo(input / 1_000_000, 12);
      expect(result!.output).toBeCloseTo(output / 1_000_000, 12);
    });

    it('does not let the gpt-5-codex entry swallow newer codex generations', () => {
      // gpt-5.3-codex is priced by models.dev at a different rate; the
      // curated gpt-5-codex prefix must not shadow it.
      expect(lookupKnownPrice('gpt-5.3-codex')).toBeNull();
    });

    it('does not let chat-latest match the versioned gpt-5.x-chat-latest ids', () => {
      expect(lookupKnownPrice('gpt-5.3-chat-latest')).toBeNull();
    });
  });
});
