import {
  ArgumentsHost,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { GoogleNativeExceptionFilter } from '../google-native-exception.filter';
import { ManifestError } from '../../../common/errors/manifest-error';

describe('GoogleNativeExceptionFilter', () => {
  let filter: GoogleNativeExceptionFilter;
  let res: { headersSent: boolean; status: jest.Mock; json: jest.Mock; end: jest.Mock };
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new GoogleNativeExceptionFilter();
    res = {
      headersSent: false,
      status: jest.fn().mockImplementation(() => res),
      json: jest.fn(),
      end: jest.fn(),
    };
    host = {
      switchToHttp: () => ({ getResponse: () => res }),
    } as unknown as ArgumentsHost;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('renders a ManifestError in Google’s envelope and carries the code as data', () => {
    filter.catch(
      new ManifestError('M100', 401, { provider: 'gemini', dashboardUrl: 'https://d/x' }),
      host,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 401,
        message: expect.stringContaining('[🦚 Manifest M100]'),
        status: 'UNAUTHENTICATED',
        manifest_code: 'M100',
      },
    });
  });

  it.each([
    [400, 'INVALID_ARGUMENT'],
    [401, 'UNAUTHENTICATED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [429, 'RESOURCE_EXHAUSTED'],
    [500, 'INTERNAL'],
    [502, 'BAD_GATEWAY'],
    [503, 'UNAVAILABLE'],
    [504, 'DEADLINE_EXCEEDED'],
  ])('maps %s to the canonical status %s', (status, canonical) => {
    filter.catch(new HttpException('boom', status), host);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ status: canonical }) }),
    );
  });

  it('falls back to UNKNOWN for a status Google has no canonical name for', () => {
    filter.catch(new HttpException('teapot', 418), host);

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 418, message: 'teapot', status: 'UNKNOWN' },
    });
  });

  it('hides an unexpected throw behind a 500 and logs it', () => {
    filter.catch(new Error('undefined is not a function'), host);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 500,
        message: 'Something broke on our end. Try again in a moment.',
        status: 'INTERNAL',
      },
    });
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('undefined is not a function'),
    );
  });

  it('does not log a 4xx HttpException as a server failure', () => {
    filter.catch(new NotFoundException('missing'), host);

    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('does not log a ManifestError, even a 5xx one', () => {
    filter.catch(new ManifestError('M500', 502, { error: 'ECONNRESET' }), host);

    expect(Logger.prototype.error).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ status: 'BAD_GATEWAY', manifest_code: 'M500' }),
      }),
    );
  });

  it('just closes the socket when a relay already sent headers', () => {
    res.headersSent = true;

    filter.catch(new ForbiddenException('too late'), host);

    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
