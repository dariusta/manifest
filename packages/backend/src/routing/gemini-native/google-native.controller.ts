import {
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response as ExpressResponse } from 'express';
import { randomUUID } from 'crypto';
import { Public } from '../../common/decorators/public.decorator';
import { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';
import { IngestionContext } from '../../otlp/interfaces/ingestion-context.interface';
import { GoogleNativeService } from './google-native.service';
import { GoogleNativeExceptionFilter } from './google-native-exception.filter';
import {
  callerFacingOrigin,
  forwardableResponseHeaders,
  rewriteUploadUrl,
} from './google-native-wire';

/**
 * The two Gemini-native surfaces that are **state**, not completions: the
 * Files API and agentic mode (`/v1beta/interactions`).
 *
 * Why these bypass the router entirely:
 *
 *  - A file handle (`files/abc123`) and an interaction id are allocated *by
 *    Google, inside one project*. Scoring a request that carries one and
 *    routing it to a different provider — or even a different Google project —
 *    resolves to a 403/404, so there is nothing for a router to decide.
 *  - Agentic mode runs its tool loop **server-side**. Manifest cannot
 *    represent `previous_interaction_id`, `codeExecutionCallStep` or
 *    `googleSearchCallStep` in the Chat Completions shape it routes on, and
 *    round-tripping through that shape would drop them silently.
 *  - Agentic mode never inlines media. It ships a `uri` reference, which is
 *    why the Files API has to exist here for video to work at all.
 *
 * What Manifest still does: authenticates the caller with its own `mnfst_` key
 * (`AgentKeyAuthGuard`), resolves *that tenant's* Google credential, and
 * relays. The caller never learns the Google credential, and one Manifest key
 * keeps working across both surfaces — which is the whole point of pointing an
 * SDK at Manifest instead of at Google.
 */
@Controller()
@Public()
@UseGuards(AgentKeyAuthGuard)
@UseFilters(GoogleNativeExceptionFilter)
@SkipThrottle()
export class GoogleNativeController {
  private readonly logger = new Logger(GoogleNativeController.name);

  constructor(private readonly googleNative: GoogleNativeService) {}

  // ---------------------------------------------------------------- files

  /**
   * `POST /v1beta/files` and `POST /upload/v1beta/files`.
   *
   * Both the metadata-only create and the resumable-upload handshake land
   * here, because the SDK distinguishes them with `x-goog-upload-protocol`
   * rather than with the path. The one thing Manifest must not do is relay
   * Google's `X-Goog-Upload-URL` verbatim: the SDK POSTs the bytes to whatever
   * that header says, so returning Google's URL would send the media straight
   * past Manifest using a credential the caller was never given. It is
   * swapped for an opaque ticket that routes back through here.
   */
  @Post(['v1beta/files', 'upload/v1beta/files'])
  async createFile(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    const ctx = this.context(req);
    const auth = await this.googleNative.resolveAuth(ctx.agentId, ctx.tenantId, ctx.agentName);
    const upstream = await this.googleNative.forward({
      method: 'POST',
      url: `/upload/v1beta/files${this.queryString(req)}`,
      auth,
      headers: req.headers,
      body: JSON.stringify(req.body ?? {}),
    });

    const googleUploadUrl = upstream.headers.get('x-goog-upload-url');
    const extra: Record<string, string> = {};
    if (googleUploadUrl) {
      const ticket = randomUUID();
      this.googleNative.rememberUploadSession(ticket, {
        uploadUrl: googleUploadUrl,
        tenantId: ctx.tenantId,
      });
      extra['x-goog-upload-url'] = rewriteUploadUrl(callerFacingOrigin(req), ticket);
    }
    await this.relay(upstream, res, extra);
  }

  /**
   * `POST /upload/v1beta/files/session/:ticket` — the byte-transfer leg.
   *
   * The body is raw media, so `main.ts` parses this path with `express.raw`
   * and it arrives as a Buffer. An unknown ticket is a 404 rather than a 403:
   * the ticket is a capability that reaches a live Google upload session, and
   * confirming one exists for another tenant would be a disclosure.
   */
  @Post('upload/v1beta/files/session/:ticket')
  async uploadFileBytes(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    const ctx = this.context(req);
    const ticket = req.params['ticket'] as string;
    const session = this.googleNative.takeUploadSession(ticket, ctx.tenantId);
    if (!session) {
      res.status(404).json({
        error: {
          code: 404,
          message: 'Unknown or expired upload session.',
          status: 'NOT_FOUND',
        },
      });
      return;
    }
    const auth = await this.googleNative.resolveAuth(ctx.agentId, ctx.tenantId, ctx.agentName);
    const upstream = await this.googleNative.forward({
      method: 'POST',
      url: session.uploadUrl,
      auth,
      headers: req.headers,
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    // `finalize` (alone or as `upload, finalize`) is the last leg — the ticket
    // can never be used again, so drop it rather than waiting out the TTL.
    const command = String(req.headers['x-goog-upload-command'] ?? '');
    if (command.includes('finalize')) this.googleNative.forgetUploadSession(ticket);
    await this.relay(upstream, res);
  }

  /** `GET /v1beta/files` — list the project's uploaded files. */
  @Get('v1beta/files')
  listFiles(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    return this.passthrough(req, res, 'GET', `/v1beta/files${this.queryString(req)}`);
  }

  /**
   * `GET /v1beta/files/{name}` — what the SDK polls while a video moves from
   * `PROCESSING` to `ACTIVE`. Without it `client.files.upload()` hangs, since
   * it will not return a handle until the file reports active.
   */
  @Get('v1beta/files/*name')
  getFile(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    const name = this.splat(req, 'name');
    return this.passthrough(req, res, 'GET', `/v1beta/files/${name}${this.queryString(req)}`);
  }

  /** `DELETE /v1beta/files/{name}`. */
  @Delete('v1beta/files/*name')
  deleteFile(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    const name = this.splat(req, 'name');
    return this.passthrough(req, res, 'DELETE', `/v1beta/files/${name}`);
  }

  // --------------------------------------------------------- interactions

  /**
   * `POST /v1beta/interactions` — agentic mode.
   *
   * Streaming answers arrive as SSE with **no `[DONE]` sentinel**; upstream EOF
   * is the terminator. `relay` pipes bytes through untouched for exactly that
   * reason — a chunk-rewriting relay would have to synthesize a terminator it
   * has no way to know is due.
   */
  @Post('v1beta/interactions')
  createInteraction(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    return this.passthrough(
      req,
      res,
      'POST',
      `/v1beta/interactions${this.queryString(req)}`,
      JSON.stringify(req.body ?? {}),
    );
  }

  /** `GET /v1beta/interactions` — list stored interactions. */
  @Get('v1beta/interactions')
  listInteractions(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    return this.passthrough(req, res, 'GET', `/v1beta/interactions${this.queryString(req)}`);
  }

  /**
   * `POST /v1beta/interactions/{id}:cancel` — the only sub-action, used to
   * stop a `background: true` interaction mid-loop.
   */
  @Post('v1beta/interactions/*idAction')
  interactionAction(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    const idAction = this.splat(req, 'idAction');
    return this.passthrough(
      req,
      res,
      'POST',
      `/v1beta/interactions/${idAction}${this.queryString(req)}`,
      JSON.stringify(req.body ?? {}),
    );
  }

  /** `GET /v1beta/interactions/{id}` — poll a stored or background interaction. */
  @Get('v1beta/interactions/*id')
  getInteraction(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    const id = this.splat(req, 'id');
    return this.passthrough(req, res, 'GET', `/v1beta/interactions/${id}${this.queryString(req)}`);
  }

  /** `DELETE /v1beta/interactions/{id}`. */
  @Delete('v1beta/interactions/*id')
  deleteInteraction(@Req() req: Request, @Res() res: ExpressResponse): Promise<void> {
    const id = this.splat(req, 'id');
    return this.passthrough(req, res, 'DELETE', `/v1beta/interactions/${id}`);
  }

  // ------------------------------------------------------------- plumbing

  private context(req: Request): IngestionContext {
    // AgentKeyAuthGuard has already run — it either attached the context or
    // threw, so a missing one here is a wiring bug, not a request problem.
    return (req as Request & { ingestionContext: IngestionContext }).ingestionContext;
  }

  /**
   * Express 5 / path-to-regexp v8 hands a splat back as an **array of path
   * segments**, not a joined string. Re-joining is what keeps a two-segment
   * resource name like `files/abc-123` intact.
   */
  private splat(req: Request, param: string): string {
    const raw = req.params[param] as string | string[] | undefined;
    return Array.isArray(raw) ? raw.join('/') : String(raw ?? '');
  }

  /** The caller's query string, including `?`, or `''`. */
  private queryString(req: Request): string {
    const idx = req.originalUrl.indexOf('?');
    return idx === -1 ? '' : req.originalUrl.slice(idx);
  }

  private async passthrough(
    req: Request,
    res: ExpressResponse,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: string,
  ): Promise<void> {
    const ctx = this.context(req);
    const auth = await this.googleNative.resolveAuth(ctx.agentId, ctx.tenantId, ctx.agentName);
    const upstream = await this.googleNative.forward({
      method,
      url: path,
      auth,
      headers: req.headers,
      body,
    });
    await this.relay(upstream, res);
  }

  /**
   * Copies status, the allow-listed headers, and the body through byte for
   * byte. Streaming and non-streaming take the same path on purpose: an SSE
   * answer must reach the caller chunk by chunk, and buffering it here would
   * turn agentic mode's incremental steps into one late blob.
   */
  private async relay(
    upstream: { status: number; headers: Headers; body: ReadableStream<Uint8Array> | null },
    res: ExpressResponse,
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    res.status(upstream.status);
    for (const [name, value] of Object.entries({
      ...forwardableResponseHeaders(upstream.headers),
      ...extraHeaders,
    })) {
      res.setHeader(name, value);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        // SSE only reaches the caller live if each chunk is flushed; Node
        // buffers writes on a compressed/keep-alive socket otherwise.
        res.flush?.();
      }
    } catch (err) {
      // Mid-body failure: the status and headers are already on the wire, so
      // there is no error envelope left to send — end the response and let the
      // SDK see a truncated stream.
      this.logger.warn(`Gemini-native relay interrupted: ${String(err)}`);
    } finally {
      res.end();
    }
  }
}
