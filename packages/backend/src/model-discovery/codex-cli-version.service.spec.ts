import { Logger } from '@nestjs/common';
import { CODEX_CLI_VERSION_TTL_MS, CodexCliVersionService } from './codex-cli-version.service';
import {
  getCodexCliVersion,
  refreshCodexCliVersion,
} from '../common/constants/subscription-clients';

jest.mock('../common/constants/subscription-clients', () => ({
  getCodexCliVersion: jest.fn(),
  refreshCodexCliVersion: jest.fn(),
}));

const mockGetVersion = jest.mocked(getCodexCliVersion);
const mockRefresh = jest.mocked(refreshCodexCliVersion);

describe('CodexCliVersionService', () => {
  let service: CodexCliVersionService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    mockGetVersion.mockReturnValue('0.170.0');
    mockRefresh.mockResolvedValue('0.170.0');
    service = new CodexCliVersionService();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('resolves the latest version on first use', async () => {
    await expect(service.ensureFresh()).resolves.toBe('0.170.0');

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reuses the resolved version within the TTL', async () => {
    await service.ensureFresh(1_000);
    await service.ensureFresh(1_000 + CODEX_CLI_VERSION_TTL_MS - 1);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('checks npm again once the TTL has elapsed', async () => {
    await service.ensureFresh(1_000);
    await service.ensureFresh(1_000 + CODEX_CLI_VERSION_TTL_MS);

    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('shares one registry lookup between concurrent callers', async () => {
    let resolveLookup!: (version: string) => void;
    mockRefresh.mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const first = service.ensureFresh(1_000);
    const second = service.ensureFresh(1_000);
    resolveLookup('0.170.0');

    await expect(Promise.all([first, second])).resolves.toEqual(['0.170.0', '0.170.0']);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the current version and waits a full TTL after a failed lookup', async () => {
    mockRefresh.mockResolvedValue(null);
    mockGetVersion.mockReturnValue('0.164.0');

    await expect(service.ensureFresh(1_000)).resolves.toBe('0.164.0');
    await service.ensureFresh(2_000);

    expect(warn).toHaveBeenCalledWith(
      'Could not resolve the latest Codex CLI version; using 0.164.0',
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
