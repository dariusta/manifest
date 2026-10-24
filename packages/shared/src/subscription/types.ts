export interface SubscriptionCapabilities {
  maxContextWindow: number;
  modelContextWindows?: Readonly<Record<string, number>>;
  supportsPromptCaching: boolean;
  supportsBatching: boolean;
}

export interface SubscriptionProviderConfig {
  supportsSubscription: true;
  subscriptionLabel: string;
  subscriptionKeyPlaceholder?: string;
  subscriptionCommand?: string;
  subscriptionAuthMode?: 'popup_oauth' | 'device_code' | 'token';
  subscriptionTokenPrefix?: string;
  knownModels?: readonly string[];
  /** Supported lightweight model for credential tests when catalog prices are not comparable. */
  connectionTestModel?: string;
  /**
   * How a known model is considered covered by live subscription discovery:
   * `prefix` (default) accepts a more specific discovered variant, while
   * `exact` requires the curated model ID itself to be present.
   */
  knownModelsMatch?: 'prefix' | 'exact';
  /**
   * How knownModels combine with live subscription discovery: `supplement`
   * (default) merges them into every result, while `fallback` uses them only
   * when live discovery returns nothing — so a live catalog that has retired
   * a model is not overruled by the curated list.
   */
  knownModelsUsage?: 'supplement' | 'fallback';
  subscriptionCapabilities?: Readonly<SubscriptionCapabilities>;
}
