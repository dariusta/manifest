jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => 'ticket-uuid'),
}));

import { Logger } from '@nestjs/common';
import type { Request, Response as ExpressResponse } from 'express';
import { GoogleNativeController } from '../google-native.controller';
import type {
  GoogleNativeForward,
  GoogleNativeService,
  UploadSession,
} from '../google-native.service';
import type { IngestionContext } from '../../../otlp/interfaces/ingestion-context.interface';

const CTX: IngestionContext = {
  agentId: 'agent-1',
  tenantId: 'tenant-1',
  agentName: 'demo-agent',
} as IngestionContext;

const AUTH = { authType: 'api_key' as const, credential: 'AIza-live' };

type ResMock = ExpressResponse & {
  _status?: number;
  _headers: Record<string, string>;
  _chunks: Buffer[];
  _ended: boolean;
  _json?: unknown;
};

const makeRes = (): ResMock => {
  const res = {
    _headers: {},
    _chunks: [],
    _ended: false,
    status(code: number) {
      res._status = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
    write(chunk: Buffer) {
      res._chunks.push(chunk);
      return true;
    },
    end() {
      res._ended = true;
      return res;
    },
    flush: jest.fn(),
  } as unknown as ResMock;
  return res;
};

const makeReq = (over: Partial<Request> = {}): Request =>
  ({
    headers: {},
    params: {},
    originalUrl: '/v1beta/interactions',
    protocol: 'http',
    get: () => 'manifest.test:38240',
    ingestionContext: CTX,
    ...over,
  }) as unknown as Request;

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });

const upstream = (over: Partial<GoogleNativeForward> = {}): GoogleNativeForward => ({
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: streamOf('{"ok":true}'),
  contentType: 'application/json',
  ...over,
});

describe('GoogleNativeController', () => {
  let controller: GoogleNativeController;
  let service: jest.Mocked<
    Pick<
      GoogleNativeService,
      | 'resolveAuth'
      | 'forward'
      | 'rememberUploadSession'
      | 'takeUploadSession'
      | 'forgetUploadSession'
    >
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      resolveAuth: jest.fn().mockResolvedValue(AUTH),
      forward: jest.fn().mockResolvedValue(upstream()),
      rememberUploadSession: jest.fn(),
      takeUploadSession: jest.fn(),
      forgetUploadSession: jest.fn(),
    };
    controller = new GoogleNativeController(service as unknown as GoogleNativeService);
  });

  // ------------------------------------------------------------- files

  describe('createFile', () => {
    it('swaps Google’s upload URL for a ticket that routes back through Manifest', async () => {
      service.forward.mockResolvedValue(
        upstream({
          headers: new Headers({
            'content-type': 'application/json',
            'x-goog-upload-status': 'active',
            'x-goog-upload-url':
              'https://generativelanguage.googleapis.com/upload/v1beta/files/secret-id',
          }),
          body: null,
        }),
      );
      const req = makeReq({
        originalUrl: '/upload/v1beta/files',
        body: { file: { mime_type: 'video/mp4' } },
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mnfst.example.com' },
      });
      const res = makeRes();

      await controller.createFile(req, res);

      expect(service.rememberUploadSession).toHaveBeenCalledWith('ticket-uuid', {
        uploadUrl: 'https://generativelanguage.googleapis.com/upload/v1beta/files/secret-id',
        tenantId: 'tenant-1',
      });
      expect(res._headers['x-goog-upload-url']).toBe(
        'https://mnfst.example.com/upload/v1beta/files/session/ticket-uuid',
      );
      // Google's own URL must not survive anywhere in the reply.
      expect(JSON.stringify(res._headers)).not.toContain('generativelanguage');
      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: '/upload/v1beta/files',
          body: '{"file":{"mime_type":"video/mp4"}}',
        }),
      );
    });

    it('issues no ticket for a metadata-only create', async () => {
      const res = makeRes();

      await controller.createFile(makeReq({ originalUrl: '/v1beta/files' }), res);

      expect(service.rememberUploadSession).not.toHaveBeenCalled();
      expect(res._headers['x-goog-upload-url']).toBeUndefined();
      expect(service.forward).toHaveBeenCalledWith(expect.objectContaining({ body: '{}' }));
    });

    it('preserves the caller’s query string on the handshake', async () => {
      await controller.createFile(
        makeReq({ originalUrl: '/upload/v1beta/files?alt=json&key=x' }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/upload/v1beta/files?alt=json&key=x' }),
      );
    });
  });

  describe('uploadFileBytes', () => {
    const session: UploadSession = {
      uploadUrl: 'https://generativelanguage.googleapis.com/upload/v1beta/files/secret-id',
      tenantId: 'tenant-1',
    };

    it('posts the raw bytes to the remembered Google URL', async () => {
      service.takeUploadSession.mockReturnValue(session);
      const media = Buffer.from('mp4-bytes');
      const res = makeRes();

      await controller.uploadFileBytes(
        makeReq({
          params: { ticket: 'ticket-uuid' },
          body: media,
          headers: { 'x-goog-upload-command': 'upload' },
        }),
        res,
      );

      expect(service.takeUploadSession).toHaveBeenCalledWith('ticket-uuid', 'tenant-1');
      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', url: session.uploadUrl, body: media }),
      );
      // Not the last leg — the ticket stays usable for the next chunk.
      expect(service.forgetUploadSession).not.toHaveBeenCalled();
    });

    it('drops the ticket once the command finalizes', async () => {
      service.takeUploadSession.mockReturnValue(session);

      await controller.uploadFileBytes(
        makeReq({
          params: { ticket: 'ticket-uuid' },
          body: Buffer.from('tail'),
          headers: { 'x-goog-upload-command': 'upload, finalize' },
        }),
        makeRes(),
      );

      expect(service.forgetUploadSession).toHaveBeenCalledWith('ticket-uuid');
    });

    it('sends an empty body when the raw parser produced no Buffer', async () => {
      service.takeUploadSession.mockReturnValue(session);

      await controller.uploadFileBytes(
        makeReq({ params: { ticket: 'ticket-uuid' }, body: undefined }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ body: Buffer.alloc(0) }),
      );
    });

    it('404s an unknown ticket without ever resolving a credential', async () => {
      service.takeUploadSession.mockReturnValue(undefined);
      const res = makeRes();

      await controller.uploadFileBytes(makeReq({ params: { ticket: 'nope' } }), res);

      expect(res._status).toBe(404);
      expect(res._json).toEqual({
        error: { code: 404, message: 'Unknown or expired upload session.', status: 'NOT_FOUND' },
      });
      expect(service.resolveAuth).not.toHaveBeenCalled();
      expect(service.forward).not.toHaveBeenCalled();
    });
  });

  describe('file reads', () => {
    it('lists files with the query string intact', async () => {
      await controller.listFiles(makeReq({ originalUrl: '/v1beta/files?pageSize=10' }), makeRes());

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/v1beta/files?pageSize=10' }),
      );
    });

    it('rejoins a multi-segment resource name Express split into an array', async () => {
      await controller.getFile(
        makeReq({
          params: { name: ['files', 'abc-123'] as unknown as string },
          originalUrl: '/v1beta/files/files/abc-123',
        }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/v1beta/files/files/abc-123' }),
      );
    });

    it('takes a single-segment splat as a plain string', async () => {
      await controller.getFile(
        makeReq({ params: { name: 'abc-123' }, originalUrl: '/v1beta/files/abc-123?stream=false' }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/v1beta/files/abc-123?stream=false' }),
      );
    });

    it('treats a missing splat as an empty name rather than "undefined"', async () => {
      await controller.deleteFile(makeReq({ params: {} }), makeRes());

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', url: '/v1beta/files/' }),
      );
    });
  });

  // ------------------------------------------------------ interactions

  describe('interactions', () => {
    it('relays an agentic request body verbatim', async () => {
      const body = { model: 'gemini-3.1-pro-preview', input: [{ type: 'user_input' }] };

      await controller.createInteraction(makeReq({ body }), makeRes());

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: '/v1beta/interactions',
          body: JSON.stringify(body),
        }),
      );
    });

    it('sends {} when the caller posted no body', async () => {
      await controller.createInteraction(makeReq({ body: undefined }), makeRes());

      expect(service.forward).toHaveBeenCalledWith(expect.objectContaining({ body: '{}' }));
    });

    it('lists interactions', async () => {
      await controller.listInteractions(
        makeReq({ originalUrl: '/v1beta/interactions?pageSize=2' }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/v1beta/interactions?pageSize=2' }),
      );
    });

    it('routes the cancel sub-action through the splat', async () => {
      await controller.interactionAction(
        makeReq({
          params: { idAction: ['abc-1', 'cancel'] as unknown as string },
          originalUrl: '/v1beta/interactions/abc-1/cancel',
          body: {},
        }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', url: '/v1beta/interactions/abc-1/cancel' }),
      );
    });

    it('sends {} on a body-less cancel', async () => {
      await controller.interactionAction(
        makeReq({
          params: { idAction: ['abc-1', 'cancel'] as unknown as string },
          body: undefined,
        }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(expect.objectContaining({ body: '{}' }));
    });

    it('polls one interaction, query string included', async () => {
      await controller.getInteraction(
        makeReq({
          params: { id: 'abc-1' },
          originalUrl: '/v1beta/interactions/abc-1?stream=false',
        }),
        makeRes(),
      );

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ url: '/v1beta/interactions/abc-1?stream=false' }),
      );
    });

    it('deletes one interaction', async () => {
      await controller.deleteInteraction(makeReq({ params: { id: 'abc-1' } }), makeRes());

      expect(service.forward).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', url: '/v1beta/interactions/abc-1' }),
      );
    });
  });

  // ------------------------------------------------------------- relay

  describe('relay', () => {
    it('copies status, allow-listed headers and body bytes through', async () => {
      service.forward.mockResolvedValue(
        upstream({
          status: 201,
          headers: new Headers({
            'content-type': 'application/json',
            'x-goog-upload-status': 'final',
            'set-cookie': 'leak=1',
          }),
          body: streamOf('{"name":', '"files/x"}'),
        }),
      );
      const res = makeRes();

      await controller.listFiles(makeReq(), res);

      expect(res._status).toBe(201);
      expect(res._headers).toEqual({
        'content-type': 'application/json',
        'x-goog-upload-status': 'final',
      });
      expect(Buffer.concat(res._chunks).toString()).toBe('{"name":"files/x"}');
      expect(res._ended).toBe(true);
    });

    it('flushes every chunk so SSE reaches the caller live', async () => {
      service.forward.mockResolvedValue(
        upstream({
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: streamOf('data: {"event_type":"step.delta"}\n\n', 'data: {"x":2}\n\n'),
        }),
      );
      const res = makeRes();

      await controller.createInteraction(makeReq({ body: {} }), res);

      expect(res._chunks).toHaveLength(2);
      expect(res.flush).toHaveBeenCalledTimes(2);
    });

    it('survives a response object with no flush (plain http.ServerResponse)', async () => {
      const res = makeRes();
      (res as { flush?: unknown }).flush = undefined;

      await controller.listFiles(makeReq(), res);

      expect(Buffer.concat(res._chunks).toString()).toBe('{"ok":true}');
    });

    it('ends the response without a body for a 204', async () => {
      service.forward.mockResolvedValue(
        upstream({ status: 204, headers: new Headers(), body: null }),
      );
      const res = makeRes();

      await controller.deleteFile(makeReq({ params: { name: 'x' } }), res);

      expect(res._status).toBe(204);
      expect(res._chunks).toHaveLength(0);
      expect(res._ended).toBe(true);
    });

    it('closes a stream that dies mid-body instead of throwing at the filter', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      let sentFirst = false;
      service.forward.mockResolvedValue(
        upstream({
          // `error()` in `start` would discard the queued chunk, so fail on the
          // second pull — the shape a real reset has: some bytes, then nothing.
          body: new ReadableStream({
            pull(controller) {
              if (controller.desiredSize !== null && sentFirst) {
                controller.error(new Error('upstream reset'));
                return;
              }
              sentFirst = true;
              controller.enqueue(new TextEncoder().encode('partial'));
            },
          }),
        }),
      );
      const res = makeRes();

      await expect(controller.listFiles(makeReq(), res)).resolves.toBeUndefined();

      expect(Buffer.concat(res._chunks).toString()).toBe('partial');
      expect(res._ended).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('upstream reset'));
      logSpy.mockRestore();
    });
  });
});
