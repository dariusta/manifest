import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response as ExpressResponse } from 'express';
import { ManifestError } from '../../common/errors/manifest-error';

/**
 * HTTP status → Google's canonical status string.
 *
 * The Google Gen AI SDK raises `ClientError`/`ServerError` by reading
 * `error.message` out of Google's envelope, so a Nest-shaped
 * `{statusCode, message}` body surfaces as an unhelpful `None` in the SDK's
 * exception. Rendering the envelope is what makes a Manifest refusal legible
 * in a Python traceback.
 */
const CANONICAL_STATUS: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  502: 'BAD_GATEWAY',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/**
 * Renders errors on the Gemini-native surfaces in Google's envelope.
 *
 * Deliberately *not* `ProxyExceptionFilter`: that filter's job is to record a
 * Manifest Request row for a failed completion, and files/interactions are not
 * completions — there is no model, no attempt and no cost to attribute, so
 * recording one would put a phantom request in the dashboard.
 */
@Catch()
export class GoogleNativeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GoogleNativeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ExpressResponse>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const message =
      exception instanceof HttpException
        ? exception.message
        : 'Something broke on our end. Try again in a moment.';

    if (!(exception instanceof ManifestError) && status >= 500) {
      this.logger.error(`Gemini-native surface failed: ${String(exception)}`);
    }

    // Headers already sent means a relay died mid-body; there is no envelope
    // left to write, so just close the socket.
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({
      error: {
        code: status,
        message,
        status: CANONICAL_STATUS[status] ?? 'UNKNOWN',
        ...(exception instanceof ManifestError ? { manifest_code: exception.code } : {}),
      },
    });
  }
}
