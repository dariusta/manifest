import { Logger } from '@nestjs/common';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  RequestRecordingStorageService,
  S3RecordingStorage,
  resolveRecordingStorage,
  type S3StorageConfig,
} from './request-recording-storage.service';

function config(values: Record<string, unknown>) {
  return {
    get: <T>(key: string) => values[key] as T | undefined,
  };
}

describe('request recording storage selection', () => {
  it('selects S3 automatically when complete bucket credentials are present', () => {
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 'auto',
          'app.nodeEnv': 'production',
          'app.requestRecordingS3Bucket': 'recordings',
          'app.requestRecordingS3Endpoint': 'https://storage.example.com',
          'app.requestRecordingS3Region': 'auto',
          'app.requestRecordingS3AccessKeyId': 'access',
          'app.requestRecordingS3SecretAccessKey': 'secret',
        }),
        true,
      ),
    ).toEqual(
      expect.objectContaining({
        backend: 's3',
        bucket: 'recordings',
        endpoint: 'https://storage.example.com',
      }),
    );
  });

  it('uses filesystem storage for self-hosting without S3 configuration', () => {
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 'auto',
          'app.nodeEnv': 'production',
          'app.requestRecordingFilesystemPath': '/data/request-recordings',
        }),
        true,
      ),
    ).toEqual({ backend: 'filesystem', path: '/data/request-recordings' });
  });

  it('does not fall back to ephemeral filesystem storage in managed Cloud', () => {
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 'auto',
          'app.nodeEnv': 'production',
        }),
        false,
      ),
    ).toEqual({
      backend: null,
      reason: 'Managed Cloud requires S3 recording storage credentials',
    });
  });

  it('reports partial S3 credentials instead of silently falling back', () => {
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 'auto',
          'app.nodeEnv': 'production',
          'app.requestRecordingS3Bucket': 'recordings',
          'app.requestRecordingS3Region': 'auto',
          'app.requestRecordingS3AccessKeyId': 'access',
        }),
        true,
      ),
    ).toEqual(
      expect.objectContaining({
        backend: null,
        reason: expect.stringContaining('either both access-key values or neither'),
      }),
    );
  });

  it('supports explicit disabled, filesystem, and S3 modes', () => {
    expect(
      resolveRecordingStorage(config({ 'app.requestRecordingStorage': 'disabled' }), true),
    ).toEqual({
      backend: null,
      reason: 'Recording storage was explicitly disabled',
    });
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 'filesystem',
          'app.nodeEnv': 'development',
        }),
        false,
        '/manifest',
      ),
    ).toEqual({
      backend: 'filesystem',
      path: '/manifest/.data/request-recordings',
    });
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 's3',
          'app.requestRecordingS3Bucket': 'recordings',
          'app.requestRecordingS3Region': 'eu-west-1',
        }),
        false,
      ),
    ).toEqual(
      expect.objectContaining({
        backend: 's3',
        bucket: 'recordings',
        region: 'eu-west-1',
      }),
    );
  });

  it('rejects unknown storage modes', () => {
    expect(
      resolveRecordingStorage(config({ 'app.requestRecordingStorage': 'somewhere-else' }), true),
    ).toEqual({
      backend: null,
      reason: 'Unknown REQUEST_RECORDING_STORAGE value "somewhere-else"',
    });
  });

  it('passes the S3 prefix and read-only filesystem fallback through to S3', () => {
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 's3',
          'app.requestRecordingS3Bucket': 'recordings',
          'app.requestRecordingS3Region': 'auto',
          'app.requestRecordingS3Prefix': 'manifest/recordings/',
          'app.requestRecordingFallbackFilesystemPath': '  /data/request-recordings  ',
        }),
        false,
      ),
    ).toEqual(
      expect.objectContaining({
        backend: 's3',
        prefix: 'manifest/recordings/',
        fallbackFilesystemPath: '/data/request-recordings',
      }),
    );
  });

  it('fails closed instead of using the filesystem when the S3 prefix is invalid', () => {
    expect(() =>
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 'auto',
          'app.nodeEnv': 'production',
          'app.requestRecordingS3Bucket': 'recordings',
          'app.requestRecordingS3Region': 'auto',
          'app.requestRecordingS3AccessKeyId': 'access',
          'app.requestRecordingS3SecretAccessKey': 'secret',
          'app.requestRecordingS3Prefix': '..',
        }),
        true,
      ),
    ).toThrow(/Invalid REQUEST_RECORDING_S3_PREFIX/);
  });

  it('keeps filesystem selection when an S3 prefix is also set', () => {
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 'filesystem',
          'app.nodeEnv': 'production',
          'app.requestRecordingFilesystemPath': '/data/request-recordings',
          'app.requestRecordingS3Prefix': '../nope',
          'app.requestRecordingFallbackFilesystemPath': '/data/request-recordings',
        }),
        true,
      ),
    ).toEqual({ backend: 'filesystem', path: '/data/request-recordings' });
  });
});

describe('S3RecordingStorage', () => {
  const send = jest.fn();
  const storage = new S3RecordingStorage(
    {
      bucket: 'recordings',
      endpoint: 'https://storage.example.com',
      region: 'auto',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      forcePathStyle: false,
    },
    { send } as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('writes opaque encrypted objects to the configured private bucket', async () => {
    send.mockResolvedValue({});

    await storage.put('request-recordings/v1/request-1.json.gz', Buffer.from('body'));

    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0][0].input).toEqual(
      expect.objectContaining({
        Bucket: 'recordings',
        Key: 'request-recordings/v1/request-1.json.gz',
        ContentType: 'application/octet-stream',
      }),
    );
    // The body is ciphertext, so declaring gzip would make S3-compatible stores
    // and CDNs try to decompress it on GET.
    expect(send.mock.calls[0][0].input.ContentEncoding).toBeUndefined();
  });

  it('reads object bytes through the S3 streaming body helper', async () => {
    send.mockResolvedValue({
      Body: { transformToByteArray: jest.fn().mockResolvedValue(Uint8Array.from([1, 2, 3])) },
    });

    await expect(storage.get('recording.json.gz')).resolves.toEqual(Buffer.from([1, 2, 3]));

    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
  });

  it('rejects S3 objects without a response body', async () => {
    send.mockResolvedValue({});

    await expect(storage.get('missing.json.gz')).rejects.toThrow(
      'Request recording object has no body',
    );
  });

  it('deletes objects idempotently through the S3 API', async () => {
    send.mockResolvedValue({});

    await storage.delete('recording.json.gz');

    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[0][0].input.Key).toBe('recording.json.gz');
  });

  it('can initialize the default AWS client without explicit credentials', async () => {
    const defaultClientStorage = new S3RecordingStorage({
      bucket: 'recordings',
      region: 'eu-west-1',
      forcePathStyle: false,
    });

    await expect(defaultClientStorage.prepare()).resolves.toBeUndefined();
  });
});

describe('RequestRecordingStorageService filesystem driver', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'manifest-recordings-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes, reads, and deletes objects through the mounted directory', async () => {
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 'filesystem',
        'app.requestRecordingFilesystemPath': directory,
      }) as never,
    );
    await service.onModuleInit();
    const key = service.objectKey('tenant-1', 'request-1', 'attempt-1');
    const body = Buffer.from('recording');

    expect(key).toBe(
      'request-recordings/v1/tenants/tenant-1/requests/request-1/attempts/attempt-1.json.gz',
    );
    await service.put(key, body);
    await expect(service.get(key)).resolves.toEqual(body);
    await service.delete(key);
    await expect(service.get(key)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('keeps storage segments inside their tenant namespace', async () => {
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 'filesystem',
        'app.requestRecordingFilesystemPath': directory,
      }) as never,
    );
    await service.onModuleInit();

    expect(service.objectKey('../tenant', 'request/1', 'attempt/1')).toBe(
      'request-recordings/v1/tenants/%2E%2E%2Ftenant/requests/request%2F1/attempts/attempt%2F1.json.gz',
    );
    expect(() => service.objectKey('', 'request-1', 'attempt-1')).toThrow(
      'Request recording storage key segments cannot be empty',
    );
  });

  it('continues reading legacy unscoped object keys', async () => {
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 'filesystem',
        'app.requestRecordingFilesystemPath': directory,
      }) as never,
    );
    await service.onModuleInit();
    const legacyKey = 'request-recordings/v1/request-1.json.gz';
    const body = Buffer.from('legacy recording');

    await service.put(legacyKey, body);

    await expect(service.get(legacyKey)).resolves.toEqual(body);
  });

  it('rejects keys that escape the configured recording directory', async () => {
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 'filesystem',
        'app.requestRecordingFilesystemPath': directory,
      }) as never,
    );
    await service.onModuleInit();

    await expect(service.put('../outside', Buffer.from('nope'))).rejects.toThrow(
      'Invalid request recording storage key',
    );
  });

  it('initializes S3 storage', async () => {
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 's3',
        'app.requestRecordingS3Bucket': 'recordings',
        'app.requestRecordingS3Region': 'eu-west-1',
      }) as never,
    );

    await service.onModuleInit();

    expect(service.backend).toBe('s3');
  });

  it('reports explicitly disabled storage as unavailable', async () => {
    const service = new RequestRecordingStorageService(
      config({ 'app.requestRecordingStorage': 'disabled' }) as never,
    );

    await service.onModuleInit();

    expect(service.backend).toBeNull();
    await expect(service.put('recording.json.gz', Buffer.from('nope'))).rejects.toThrow(
      'Recording storage was explicitly disabled',
    );
  });

  it('becomes unavailable when filesystem preparation fails', async () => {
    const blockedPath = join(directory, 'blocked');
    await writeFile(blockedPath, 'not a directory');
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 'filesystem',
        'app.requestRecordingFilesystemPath': blockedPath,
      }) as never,
    );

    await service.onModuleInit();

    expect(service.backend).toBeNull();
    await expect(service.put('recording.json.gz', Buffer.from('nope'))).rejects.toThrow('EEXIST');
  });

  it('does not create the fallback directory while preparing S3 storage', async () => {
    const fallback = join(directory, 'old-recordings');
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 's3',
        'app.requestRecordingS3Bucket': 'recordings',
        'app.requestRecordingS3Region': 'auto',
        'app.requestRecordingS3Prefix': 'manifest/recordings/',
        'app.requestRecordingFallbackFilesystemPath': fallback,
      }) as never,
    );

    await service.onModuleInit();

    expect(service.backend).toBe('s3');
    await expect(stat(fallback)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('fails boot when an S3 prefix climbs out of the bucket', () => {
    expect(
      () =>
        new RequestRecordingStorageService(
          config({
            'app.requestRecordingStorage': 's3',
            'app.requestRecordingS3Bucket': 'recordings',
            'app.requestRecordingS3Region': 'auto',
            'app.requestRecordingS3Prefix': 'manifest/../secret',
          }) as never,
        ),
    ).toThrow(/Invalid REQUEST_RECORDING_S3_PREFIX/);
  });

  it('ignores an invalid S3 prefix while filesystem storage is selected', async () => {
    const service = new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 'filesystem',
        'app.requestRecordingFilesystemPath': directory,
        'app.requestRecordingS3Prefix': '..',
      }) as never,
    );

    await service.onModuleInit();

    expect(service.backend).toBe('filesystem');
  });
});

describe('S3 recording key prefix', () => {
  const send = jest.fn();
  const logicalKey = 'request-recordings/v1/request-1.json.gz';

  beforeEach(() => jest.clearAllMocks());

  function open(prefix?: string): S3RecordingStorage {
    return new S3RecordingStorage(s3Config({ prefix }), { send } as never);
  }

  it.each([
    ['manifest/recordings/', 'manifest/recordings/'],
    ['manifest/recordings', 'manifest/recordings/'],
    ['/manifest//recordings/', 'manifest/recordings/'],
    ['manifest\\recordings', 'manifest/recordings/'],
    ['  /manifest/recordings/  ', 'manifest/recordings/'],
  ])('applies prefix %p as %p on put, get, and delete', async (prefix, stored) => {
    const storage = open(prefix);
    const storedKey = `${stored}${logicalKey}`;
    send.mockResolvedValueOnce({});
    await storage.put(logicalKey, Buffer.from('body'));
    send.mockResolvedValueOnce({
      Body: { transformToByteArray: jest.fn().mockResolvedValue(Uint8Array.from([1])) },
    });
    await expect(storage.get(logicalKey)).resolves.toEqual(Buffer.from([1]));
    send.mockResolvedValueOnce({});
    await storage.delete(logicalKey);

    expect(send.mock.calls.map((call) => call[0].input.Key)).toEqual([
      storedKey,
      storedKey,
      storedKey,
    ]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it.each([undefined, '', '   ', '/'])(
    'leaves the logical key unchanged when the prefix is %p',
    async (prefix) => {
      const storage = open(prefix);
      send.mockResolvedValue({});
      await storage.put(logicalKey, Buffer.from('body'));
      expect(send.mock.calls[0][0].input.Key).toBe(logicalKey);
    },
  );

  it.each([
    '..',
    '../secret',
    'manifest/../secret',
    'manifest/../../etc',
    'foo/..',
    '..\\secret',
    '/../x',
    'foo/../bar/',
    '.',
    'foo/./bar',
    './recordings',
    'manifest/\nrecordings',
    'foo\u0000bar',
  ])('rejects prefix %s', (prefix) => {
    expect(() => open(prefix)).toThrow(/Invalid REQUEST_RECORDING_S3_PREFIX/);
  });
});

describe('S3 filesystem read fallback', () => {
  const send = jest.fn();
  const logicalKey = 'request-recordings/v1/tenants/t/requests/r/attempts/a.json.gz';
  let directory: string;
  let debug: jest.SpiedFunction<Logger['debug']>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'manifest-recording-fallback-'));
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    send.mockReset();
  });

  afterEach(async () => {
    debug.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  function open(fallback?: string): S3RecordingStorage {
    return new S3RecordingStorage(
      s3Config({
        prefix: 'manifest/recordings',
        fallbackFilesystemPath: fallback,
      }),
      { send } as never,
    );
  }

  function noSuchKey(): Error {
    return Object.assign(new Error('The specified key does not exist.'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
  }

  async function writeFallback(body: Buffer): Promise<void> {
    const target = join(directory, logicalKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  it.each([
    ['NoSuchKey', { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }],
    ['NoSuchKey without a status', { name: 'NoSuchKey' }],
    ['HTTP 404', { $metadata: { httpStatusCode: 404 } }],
    ['Code NoSuchKey', { Code: 'NoSuchKey' }],
  ])('reads the logical key from the filesystem when S3 returns %s', async (_label, shape) => {
    const body = Buffer.from(`fallback-${_label}`);
    await writeFallback(body);
    send.mockRejectedValue(Object.assign(new Error('missing'), shape));
    const storage = open(directory);

    await expect(storage.get(logicalKey)).resolves.toEqual(body);

    expect(send.mock.calls[0][0].input.Key).toBe(`manifest/recordings/${logicalKey}`);
    expect(debug).toHaveBeenCalledWith(`Request recording filesystem fallback hit: ${logicalKey}`);
  });

  it('rethrows the S3 miss when the fallback object does not exist', async () => {
    const missing = noSuchKey();
    send.mockRejectedValue(missing);
    const storage = open(directory);

    await expect(storage.get(logicalKey)).rejects.toBe(missing);
    expect(debug).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'does not read the filesystem when the fallback path is %p',
    async (fallback) => {
      const body = Buffer.from('on disk');
      await writeFallback(body);
      const missing = noSuchKey();
      send.mockRejectedValue(missing);
      const storage = open(fallback);

      await expect(storage.get(logicalKey)).rejects.toBe(missing);

      expect(debug).not.toHaveBeenCalled();
      await expect(readFile(join(directory, logicalKey))).resolves.toEqual(body);
    },
  );

  it('does not fall back when S3 returns the object', async () => {
    await writeFallback(Buffer.from('stale'));
    send.mockResolvedValue({
      Body: { transformToByteArray: jest.fn().mockResolvedValue(Uint8Array.from([9])) },
    });
    const storage = open(directory);

    await expect(storage.get(logicalKey)).resolves.toEqual(Buffer.from([9]));
    expect(debug).not.toHaveBeenCalled();
  });

  it.each([
    [
      'NoSuchBucket',
      Object.assign(new Error('The specified bucket does not exist.'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      }),
    ],
    [
      'NotFound',
      Object.assign(new Error('Not Found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }),
    ],
    [
      'AccessDenied',
      Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    ],
    ['403', Object.assign(new Error('Forbidden'), { $metadata: { httpStatusCode: 403 } })],
    [
      '500',
      Object.assign(new Error('Internal error'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      }),
    ],
    [
      'timeout',
      Object.assign(new Error('request timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' }),
    ],
    ['ECONNRESET', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('does not fall back on %s', async (_label, failure) => {
    await writeFallback(Buffer.from('on disk'));
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      send.mockRejectedValue(failure);
      const storage = open(directory);

      await expect(storage.get(logicalKey)).rejects.toBe(failure);

      expect(debug).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('filesystem fallback was not used'),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('does not write or delete the fallback filesystem', async () => {
    const body = Buffer.from('keep');
    await writeFallback(body);
    send.mockResolvedValue({});
    const storage = open(directory);
    const target = join(directory, logicalKey);

    await storage.put(logicalKey, Buffer.from('new'));
    await expect(readFile(target)).resolves.toEqual(body);

    await storage.delete(logicalKey);
    await expect(readFile(target)).resolves.toEqual(body);
    expect(send.mock.calls.map((call) => call[0].input.Key)).toEqual([
      `manifest/recordings/${logicalKey}`,
      `manifest/recordings/${logicalKey}`,
    ]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('keeps filesystem path traversal protection on the fallback read', async () => {
    send.mockRejectedValue(noSuchKey());
    const storage = open(directory);

    await expect(storage.get('../outside')).rejects.toThrow(
      'Invalid request recording storage key',
    );
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('recording fallback retention warning', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  function service(retention: number | null, fallback = '/data/request-recordings') {
    return new RequestRecordingStorageService(
      config({
        'app.requestRecordingStorage': 's3',
        'app.requestRecordingS3Bucket': 'recordings',
        'app.requestRecordingS3Region': 'auto',
        'app.requestRecordingFallbackFilesystemPath': fallback,
        'app.requestRecordingRetentionDays': retention,
      }) as never,
    );
  }

  function warnedAboutDiskCopies(): boolean {
    return warn.mock.calls.some((call) => String(call[0]).includes('never deleted'));
  }

  it.each([null, 30])(
    'warns at startup when the fallback path is set and retention is %s',
    async (days) => {
      const storage = service(days);
      await storage.onModuleInit();
      expect(warnedAboutDiskCopies()).toBe(true);
    },
  );

  it('does not warn when retention deletes are disabled', async () => {
    const storage = service(0);
    await storage.onModuleInit();
    expect(warnedAboutDiskCopies()).toBe(false);
  });

  it('does not warn when the fallback path is unset', async () => {
    const storage = service(30, '');
    await storage.onModuleInit();
    expect(warnedAboutDiskCopies()).toBe(false);
  });
});

function s3Config(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
  return {
    bucket: 'recordings',
    region: 'auto',
    forcePathStyle: false,
    ...overrides,
  };
}
