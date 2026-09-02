/**
 * Cloud Code client — talks to Antigravity's Cloud Code Assist API
 * (`daily-cloudcode-pa.googleapis.com/v1internal:*`, with production
 * `cloudcode-pa.googleapis.com` as fallback).
 *
 * Gemini OAuth tokens for personal Google accounts cannot hit
 * `generativelanguage.googleapis.com` directly: that API needs either an
 * API key or a billed GCP project for quota attribution. Cloud Code is
 * what Antigravity (`agy`) uses after Google shut down Gemini Code Assist
 * for individuals.
 *
 * Two responsibilities:
 *
 *   1. **Onboarding** — first time we see an OAuth token, call
 *      `:loadCodeAssist` to discover the user's tier + assigned project,
 *      then `:onboardUser` if they don't have one yet. The resulting
 *      project id is persisted in the OAuth token blob's `u` field.
 *   2. **Envelope wrap/unwrap** — every chat request must be wrapped as
 *      `{ model, project, request: <standard-Gemini-payload> }`; responses
 *      come back as `{ response: <standard-Gemini-payload>, ... }`.
 *      Streaming chunks have the same wrapper shape.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  ANTIGRAVITY_CLIENT_METADATA,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD,
  buildAntigravitySubscriptionHeaders,
} from '../../../common/constants/subscription-clients';
import { scrubSecrets } from '../../../common/utils/secret-scrub';

const CODE_ASSIST_VERSION = 'v1internal';
const CODE_ASSIST_OPERATION_POLL_MS = 5_000;
const CODE_ASSIST_OPERATION_MAX_POLLS = 12;
const CODE_ASSIST_ENDPOINTS = [ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_PROD] as const;

const CLIENT_METADATA = {
  ...ANTIGRAVITY_CLIENT_METADATA,
  pluginVersion: '0.1.0',
} as const;

export interface OnboardResult {
  /** The cloudaicompanionProject id to send on every subsequent request. */
  projectId: string;
  /** The tier id ('free-tier' or 'standard-tier'). */
  tierId: string;
}

interface LoadCodeAssistResponse {
  currentTier?: CodeAssistTier | null;
  cloudaicompanionProject?: string | null;
  allowedTiers?: CodeAssistTier[] | null;
  ineligibleTiers?: CodeAssistIneligibleTier[] | null;
  paidTier?: CodeAssistTier | null;
}

interface CodeAssistTier {
  id?: string;
  name?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean | null;
}

interface CodeAssistIneligibleTier {
  reasonMessage?: string;
}

interface LongRunningOperation {
  done?: boolean;
  name?: string;
  response?: { cloudaicompanionProject?: { id?: string } };
}

@Injectable()
export class CodeAssistClientService {
  private readonly logger = new Logger(CodeAssistClientService.name);

  /**
   * One-time-per-user setup. Returns the project id that must be sent on
   * every chat request thereafter. Idempotent — safe to call repeatedly.
   */
  async onboard(accessToken: string, requestedProjectId?: string): Promise<OnboardResult> {
    const explicitProjectId = requestedProjectId?.trim() || undefined;
    const loadMetadata = explicitProjectId
      ? { ...CLIENT_METADATA, duetProject: explicitProjectId }
      : CLIENT_METADATA;
    const loaded = await this.callJson<LoadCodeAssistResponse>(':loadCodeAssist', accessToken, {
      ...(explicitProjectId ? { cloudaicompanionProject: explicitProjectId } : {}),
      metadata: loadMetadata,
    });
    const existingProject = loaded.cloudaicompanionProject;
    const currentTierId = loaded.paidTier?.id ?? loaded.currentTier?.id ?? 'standard-tier';
    if (existingProject && loaded.currentTier) {
      return { projectId: existingProject, tierId: currentTierId };
    }
    if (loaded.currentTier) {
      if (explicitProjectId) {
        return { projectId: explicitProjectId, tierId: currentTierId };
      }
      this.throwEligibilityOrProjectError(loaded);
    }

    // Match Google's CLI: only an explicitly-default tier can be
    // auto-selected. Taking allowedTiers[0] can accidentally select the
    // standard tier, which requires a caller-supplied Google Cloud project.
    const tier = loaded.allowedTiers?.find((candidate) => candidate.isDefault) ?? {
      id: 'legacy-tier',
      userDefinedCloudaicompanionProject: true,
    };
    if (!tier.id) this.throwEligibilityOrProjectError(loaded);
    const isFreeTier = tier.id === 'free-tier';
    if (!isFreeTier && !explicitProjectId) this.throwEligibilityOrProjectError(loaded);

    const onboardMetadata = explicitProjectId && !isFreeTier ? loadMetadata : CLIENT_METADATA;
    const lro = await this.callJson<LongRunningOperation>(':onboardUser', accessToken, {
      tierId: tier.id,
      ...(explicitProjectId && !isFreeTier ? { cloudaicompanionProject: explicitProjectId } : {}),
      metadata: onboardMetadata,
    });
    const completed = await this.waitForOperation(lro, accessToken);
    const projectId = completed.response?.cloudaicompanionProject?.id ?? explicitProjectId;
    if (!projectId) {
      this.throwEligibilityOrProjectError(loaded);
    }
    return { projectId, tierId: tier.id };
  }

  private throwEligibilityOrProjectError(loaded: LoadCodeAssistResponse): never {
    const reasons = (loaded.ineligibleTiers ?? [])
      .map((tier) => tier.reasonMessage?.trim())
      .filter((reason): reason is string => Boolean(reason));
    if (reasons.length > 0) {
      throw new Error(`Google Cloud Code is unavailable for this account: ${reasons.join(', ')}`);
    }
    throw new Error(
      'Google sign-in succeeded, but this account requires a Google Cloud project ID. Enter the project ID in Manifest and sign in again.',
    );
  }

  private async waitForOperation(
    lro: LongRunningOperation,
    accessToken: string,
  ): Promise<LongRunningOperation> {
    let current = lro;
    for (let poll = 0; poll < CODE_ASSIST_OPERATION_MAX_POLLS && current.done !== true; poll++) {
      if (!current.name) {
        throw new Error('Cloud Code onboardUser operation returned no operation name.');
      }
      await new Promise((resolve) => setTimeout(resolve, CODE_ASSIST_OPERATION_POLL_MS));
      current = await this.callOperation(current.name, accessToken);
    }
    if (current.done !== true) {
      throw new Error('Cloud Code onboardUser operation did not complete.');
    }
    return current;
  }

  private async callJson<T>(
    method: ':loadCodeAssist' | ':onboardUser',
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (const base of CODE_ASSIST_ENDPOINTS) {
      const url = `${base}/${CODE_ASSIST_VERSION}${method}`;
      try {
        return await this.postJson<T>(url, accessToken, body, `Cloud Code ${method}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!this.shouldFallbackToNextEndpoint(lastError)) {
          throw lastError;
        }
        this.logger.warn(
          `Cloud Code ${method} failed on ${base}; trying next endpoint. ${lastError.message}`,
        );
      }
    }
    throw lastError ?? new Error(`Cloud Code ${method} failed`);
  }

  private shouldFallbackToNextEndpoint(error: Error): boolean {
    const match = error.message.match(/failed \((\d+)\)/);
    if (!match) return true;
    const status = Number(match[1]);
    return status >= 500 || status === 404;
  }

  private async postJson<T>(
    url: string,
    accessToken: string,
    body: Record<string, unknown>,
    label: string,
  ): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildAntigravitySubscriptionHeaders(accessToken),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      this.logger.error(`${label} failed (${response.status}): ${scrubSecrets(text)}`);
      throw new Error(`${label} failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  private async callOperation(name: string, accessToken: string): Promise<LongRunningOperation> {
    let lastError: Error | undefined;
    for (const base of CODE_ASSIST_ENDPOINTS) {
      const url = `${base}/${CODE_ASSIST_VERSION}/${name}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: buildAntigravitySubscriptionHeaders(accessToken),
      });
      if (response.ok) {
        return (await response.json()) as LongRunningOperation;
      }
      const text = await response.text();
      lastError = new Error(`Cloud Code operation ${name} failed (${response.status})`);
      this.logger.error(`${lastError.message}: ${scrubSecrets(text)}`);
      if (response.status < 500 && response.status !== 404) {
        throw lastError;
      }
    }
    throw lastError ?? new Error(`Cloud Code operation ${name} failed`);
  }
}
