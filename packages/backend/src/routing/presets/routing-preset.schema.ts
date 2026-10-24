import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  TIER_SLOTS,
  TIER_COLORS,
  SPECIFICITY_CATEGORIES,
  type RoutingPresetConfig,
} from 'manifest-shared';
import { RESERVED_HEADER_KEYS } from '../header-tiers/header-tier.service';

const text = z.string().trim().min(1).max(256);
const route = z.object({
  model: text,
  provider: text,
  authType: z.enum(['api_key', 'subscription', 'local']),
  keyLabel: z.string().trim().min(1).max(128).nullable().optional(),
});
const chain = z.object({
  route: route.nullable(),
  fallbacks: z.array(route).max(5),
  responseMode: z.enum(['buffered', 'stream']),
  outputModality: z.enum(['text', 'image', 'audio', 'video']),
});
const schema = z.object({
  version: z.literal(1),
  complexityRoutingEnabled: z.boolean(),
  providerIds: z.array(text).max(200),
  tiers: z.array(chain.extend({ tier: z.enum(TIER_SLOTS) })).max(TIER_SLOTS.length),
  specificity: z.array(chain.extend({ category: z.string().max(64), active: z.boolean() })).max(32),
  headers: z
    .array(
      chain.extend({
        sourceId: text,
        name: z.string().trim().min(1).max(32),
        headerKey: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(128),
        headerValue: z.string().trim().min(1).max(128),
        badgeColor: z.enum(TIER_COLORS),
        sortOrder: z.number().int().min(0),
        enabled: z.boolean(),
      }),
    )
    .max(64),
  modelParams: z
    .array(
      z.object({
        scope: text,
        provider: text,
        authType: z.enum(['api_key', 'subscription', 'local']),
        model: text,
        params: z.record(z.string(), z.json()),
      }),
    )
    .max(512),
});

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new BadRequestException(`Duplicate ${label} in preset`);
}
export function parsePresetConfig(value: unknown): RoutingPresetConfig {
  if (JSON.stringify(value)?.length > 256_000) throw new BadRequestException('Preset is too large');
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException(`Invalid routing preset: ${parsed.error.issues[0]?.message}`);
  const config = parsed.data;
  if (!config.tiers.some((tier) => tier.route))
    throw new BadRequestException('Choose a primary model before saving a preset');
  unique(config.providerIds, 'provider connections');
  unique(
    config.modelParams.map(
      (p) => `${p.scope}\0${p.provider.toLowerCase()}\0${p.authType}\0${p.model}`,
    ),
    'model parameter settings',
  );
  unique(
    config.tiers.map((t) => t.tier),
    'tiers',
  );
  unique(
    config.specificity.map((t) => t.category),
    'specificity categories',
  );
  unique(
    config.headers.map((t) => t.sourceId),
    'custom tier IDs',
  );
  unique(
    config.headers.map((t) => t.name.toLowerCase()),
    'custom tier names',
  );
  unique(
    config.headers.map((t) => `${t.headerKey}\0${t.headerValue}`),
    'header rules',
  );
  for (const header of config.headers) {
    if (RESERVED_HEADER_KEYS.has(header.headerKey))
      throw new BadRequestException('Reserved header in preset');
  }
  const categories = new Set<string>(SPECIFICITY_CATEGORIES);
  if (config.specificity.some((t) => !categories.has(t.category)))
    throw new BadRequestException('Invalid specificity category');
  const scopes = new Set([
    'default',
    ...config.tiers.map((t) => `tier:${t.tier}`),
    ...config.specificity.map((t) => `specificity:${t.category}`),
    ...config.headers.map((t) => `header:${t.sourceId}`),
  ]);
  for (const params of config.modelParams) {
    if (!scopes.has(params.scope)) throw new BadRequestException('Invalid model parameter scope');
  }
  for (const tier of [...config.tiers, ...config.specificity, ...config.headers]) {
    unique(
      [...(tier.route ? [tier.route] : []), ...tier.fallbacks].map(
        (r) => `${r.provider.toLowerCase()}\0${r.authType}\0${r.model}\0${r.keyLabel ?? ''}`,
      ),
      'model routes',
    );
  }
  return config as RoutingPresetConfig;
}
