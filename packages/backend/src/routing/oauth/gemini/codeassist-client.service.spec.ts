import { CodeAssistClientService } from './codeassist-client.service';

const originalFetch = global.fetch;

function mockOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockErrorResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  } as unknown as Response;
}

describe('CodeAssistClientService', () => {
  let svc: CodeAssistClientService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    svc = new CodeAssistClientService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('onboard', () => {
    it('returns projectId and tierId directly when loadCodeAssist already has a project', async () => {
      fetchMock.mockResolvedValue(
        mockOkResponse({
          currentTier: { id: 'free-tier' },
          cloudaicompanionProject: 'proj-123',
        }),
      );

      const result = await svc.onboard('access-token');

      expect(result).toEqual({ projectId: 'proj-123', tierId: 'free-tier' });
      // Only one HTTP call — onboardUser must NOT be called when the project exists.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('calls onboardUser when loadCodeAssist returns no project and picks the default tier', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({
            allowedTiers: [{ id: 'free-tier', isDefault: true }],
          }),
        )
        .mockResolvedValueOnce(
          mockOkResponse({
            done: true,
            response: { cloudaicompanionProject: { id: 'proj-456' } },
          }),
        );

      const result = await svc.onboard('access-token');

      expect(result).toEqual({ projectId: 'proj-456', tierId: 'free-tier' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('polls the operation when onboardUser returns an unfinished LRO', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({
            allowedTiers: [{ id: 'free-tier', isDefault: true }],
          }),
        )
        .mockResolvedValueOnce(
          mockOkResponse({
            name: 'operations/onboard-123',
          }),
        )
        .mockResolvedValueOnce(
          mockOkResponse({
            done: true,
            response: { cloudaicompanionProject: { id: 'proj-polled' } },
          }),
        );

      const resultPromise = svc.onboard('access-token');
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(resultPromise).resolves.toEqual({
        projectId: 'proj-polled',
        tierId: 'free-tier',
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[2][0]).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal/operations/onboard-123',
      );
      expect(fetchMock.mock.calls[2][1].method).toBe('GET');
    });

    it('does not auto-select a non-default standard tier without a project', async () => {
      fetchMock.mockResolvedValueOnce(
        mockOkResponse({
          allowedTiers: [{ id: 'standard-tier' }],
        }),
      );

      await expect(svc.onboard('access-token')).rejects.toThrow(
        'requires a Google Cloud project ID',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('uses an explicit Google Cloud project for a non-default tier', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({
            allowedTiers: [{ id: 'standard-tier' }],
          }),
        )
        .mockResolvedValueOnce(mockOkResponse({ done: true, response: {} }));

      const result = await svc.onboard('access-token', 'my-cloud-project');

      expect(result).toEqual({ projectId: 'my-cloud-project', tierId: 'legacy-tier' });
      const loadBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const onboardBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(loadBody.cloudaicompanionProject).toBe('my-cloud-project');
      expect(loadBody.metadata.duetProject).toBe('my-cloud-project');
      expect(onboardBody.cloudaicompanionProject).toBe('my-cloud-project');
      expect(onboardBody.metadata.duetProject).toBe('my-cloud-project');
    });

    it('asks for a project when allowedTiers is empty', async () => {
      fetchMock.mockResolvedValue(mockOkResponse({ allowedTiers: [] }));

      await expect(svc.onboard('access-token')).rejects.toThrow(
        'requires a Google Cloud project ID',
      );
    });

    it('asks for a project when allowedTiers is missing', async () => {
      fetchMock.mockResolvedValue(mockOkResponse({}));

      await expect(svc.onboard('access-token')).rejects.toThrow(
        'requires a Google Cloud project ID',
      );
    });

    it('surfaces Google eligibility reasons instead of reporting a token exchange failure', async () => {
      fetchMock.mockResolvedValueOnce(
        mockOkResponse({
          allowedTiers: [{ id: 'standard-tier' }],
          ineligibleTiers: [{ reasonMessage: 'This account is not eligible for the free tier.' }],
        }),
      );

      await expect(svc.onboard('access-token')).rejects.toThrow(
        'Google Cloud Code is unavailable for this account: This account is not eligible for the free tier.',
      );
    });

    it('reports the project requirement when free-tier onboarding returns no managed project', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValueOnce(mockOkResponse({ done: true, response: {} }));

      await expect(svc.onboard('access-token')).rejects.toThrow(
        'requires a Google Cloud project ID',
      );
    });

    it('uses an explicit project when Google has a current tier but no managed project', async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse({ currentTier: { id: 'standard-tier' } }));

      await expect(svc.onboard('access-token', 'workspace-project')).resolves.toEqual({
        projectId: 'workspace-project',
        tierId: 'standard-tier',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws with the method name when loadCodeAssist returns non-OK', async () => {
      fetchMock.mockResolvedValue(mockErrorResponse(403, 'Forbidden'));

      await expect(svc.onboard('access-token')).rejects.toThrow(':loadCodeAssist');
    });

    it('throws with the method name when onboardUser returns non-OK', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValueOnce(mockErrorResponse(500, 'Internal error'))
        .mockResolvedValueOnce(mockErrorResponse(500, 'Internal error'));

      await expect(svc.onboard('access-token')).rejects.toThrow(':onboardUser');
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser',
      );
      expect(fetchMock.mock.calls[2][0]).toBe(
        'https://cloudcode-pa.googleapis.com/v1internal:onboardUser',
      );
    });

    it('sends Antigravity Cloud Code headers on both requests', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValueOnce(
          mockOkResponse({ done: true, response: { cloudaicompanionProject: { id: 'p1' } } }),
        );

      await svc.onboard('my-token');

      for (const [, init] of fetchMock.mock.calls) {
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer my-token');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['User-Agent']).toContain('antigravity/');
        expect(headers['X-Goog-Api-Client']).toBe('google-cloud-sdk vscode_cloudshelleditor/0.1');
        expect(JSON.parse(headers['Client-Metadata'])).toEqual(
          expect.objectContaining({ ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' }),
        );
      }
    });

    it('POSTs to the loadCodeAssist and onboardUser paths', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValueOnce(
          mockOkResponse({ done: true, response: { cloudaicompanionProject: { id: 'p1' } } }),
        );

      await svc.onboard('my-token');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser',
      );
    });

    it('falls back to production Cloud Code when the daily endpoint is unavailable', async () => {
      fetchMock
        .mockResolvedValueOnce(mockErrorResponse(404, 'Requested entity was not found'))
        .mockResolvedValueOnce(
          mockOkResponse({
            currentTier: { id: 'free-tier' },
            cloudaicompanionProject: 'proj-prod',
          }),
        );

      await expect(svc.onboard('access-token')).resolves.toEqual({
        projectId: 'proj-prod',
        tierId: 'free-tier',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      );
    });

    it('includes the metadata block on both requests', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValueOnce(
          mockOkResponse({ done: true, response: { cloudaicompanionProject: { id: 'p1' } } }),
        );

      await svc.onboard('my-token');

      for (const [, init] of fetchMock.mock.calls) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        const metadata = body.metadata as Record<string, unknown>;
        expect(metadata).toBeDefined();
        expect(metadata.ideType).toBe('ANTIGRAVITY');
        expect(metadata.pluginType).toBe('GEMINI');
        expect(metadata.pluginVersion).toBe('0.1.0');
      }
    });

    it('throws when the onboard operation has no name to poll', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValueOnce(mockOkResponse({ done: false }));

      await expect(svc.onboard('access-token')).rejects.toThrow(
        'Cloud Code onboardUser operation returned no operation name.',
      );
    });

    it('throws when the operation never completes within the poll budget', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValue(mockOkResponse({ name: 'operations/op-1' }));

      const resultPromise = svc.onboard('access-token');
      const assertion = expect(resultPromise).rejects.toThrow(
        'Cloud Code onboardUser operation did not complete.',
      );
      await jest.advanceTimersByTimeAsync(5_000 * 13);
      await assertion;
    });

    it('throws when polling an operation returns non-OK', async () => {
      jest.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(
          mockOkResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
        )
        .mockResolvedValueOnce(mockOkResponse({ name: 'operations/op-err' }))
        .mockResolvedValueOnce(mockErrorResponse(403, 'Forbidden'));

      const resultPromise = svc.onboard('access-token');
      const assertion = expect(resultPromise).rejects.toThrow(
        'Cloud Code operation operations/op-err failed (403)',
      );
      await jest.advanceTimersByTimeAsync(5_000);
      await assertion;
    });
  });
});
