import type { TierColor } from './tier-colors';
import type { ModelRoute } from './model-route';
import type { ResponseMode } from './response-mode';
import type { OutputModality } from './output-modality';
import type { AuthType } from './auth-types';
import type { RequestParamDefaults } from './request-params';

export interface PresetChain {
  route: ModelRoute | null;
  fallbacks: ModelRoute[];
  responseMode: ResponseMode;
  outputModality: OutputModality;
}
export interface RoutingPresetConfig {
  version: 1;
  complexityRoutingEnabled: boolean;
  providerIds: string[];
  tiers: (PresetChain & { tier: string })[];
  specificity: (PresetChain & { category: string; active: boolean })[];
  headers: (PresetChain & {
    sourceId: string;
    name: string;
    headerKey: string;
    headerValue: string;
    badgeColor: TierColor;
    sortOrder: number;
    enabled: boolean;
  })[];
  modelParams: {
    scope: string;
    provider: string;
    authType: AuthType;
    model: string;
    params: RequestParamDefaults;
  }[];
}
export interface RoutingPreset {
  id: string;
  name: string;
  config: RoutingPresetConfig;
  created_at: string;
  updated_at: string;
}
