import { Injectable, Logger } from '@nestjs/common';
import {
  getCodexCliVersion,
  refreshCodexCliVersion,
} from '../common/constants/subscription-clients';

/** How long a resolved Codex CLI version is trusted before npm is asked again. */
export const CODEX_CLI_VERSION_TTL_MS = 60 * 60 * 1000;

/**
 * Keeps the Codex `client_version` current for ChatGPT subscription model
 * discovery, so newly released models appear without a code change.
 *
 * Asks the npm registry at most once per TTL per process, and concurrent
 * callers share one lookup. A failed lookup keeps the last resolved version
 * (or the compiled fallback) and is not retried until the next window, so a
 * registry outage never adds latency to every discovery call.
 */
@Injectable()
export class CodexCliVersionService {
  private readonly logger = new Logger(CodexCliVersionService.name);
  private checkedAt: number | null = null;
  private inflight: Promise<string> | null = null;

  async ensureFresh(now = Date.now()): Promise<string> {
    if (this.inflight) return this.inflight;
    if (this.checkedAt !== null && now - this.checkedAt < CODEX_CLI_VERSION_TTL_MS) {
      return getCodexCliVersion();
    }
    this.checkedAt = now;
    this.inflight = refreshCodexCliVersion()
      .then((version) => {
        if (version === null) {
          this.logger.warn(
            `Could not resolve the latest Codex CLI version; using ${getCodexCliVersion()}`,
          );
        }
        return getCodexCliVersion();
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
