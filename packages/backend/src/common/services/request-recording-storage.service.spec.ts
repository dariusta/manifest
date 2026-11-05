import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchBucket,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  RequestRecordingStorageService,
  S3RecordingStorage,
  resolveRecordingStorage,
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

  it('keeps an explicitly configured filesystem read fallback with S3', () => {
    expect(
      resolveRecordingStorage(
        config({
          'app.requestRecordingStorage': 's3',
          'app.requestRecordingS3Bucket': 'recordings',
          'app.requestRecordingS3Region': 'us-west-2',
          'app.requestRecordingFilesystemFallbackPath': '/data/old-recordings',
        }),
        true,
      ),
    ).toEqual(
      expect.objectContaining({ backend: 's3', filesystemFallbackPath: '/data/old-recordings' }),
    );
  });
});

describe('S3 recording filesystem read fallback', () => {
  let directory: string;
  const send = jest.fn();
  const key = 'request-recordings/v1/recording.json.gz';
  const sourceBody = Buffer.from([0, 5, 255, 87]);
  let storage: S3RecordingStorage;

  beforeEach(async () => {
    send.mockReset();
    directory = await mkdtemp(join(tmpdir(), 'manifest-recording-offload-'));
    await mkdir(join(directory, 'request-recordings/v1'), { recursive: true });
    await writeFile(join(directory, key), sourceBody);
    storage = new S3RecordingStorage(
      {
        bucket: 'recordings',
        region: 'us-west-2',
        forcePathStyle: false,
        filesystemFallbackPath: directory,
      },
      { send } as never,
    );
  });

  afterEach(async () => rm(directory, { recursive: true, force: true }));

  const s3Error = (status: number) =>
    new S3ServiceException({
      name: 'S3Error',
      message: 'S3 request failed',
      $fault: 'client',
      $metadata: { httpStatusCode: status },
    });

  it('reads unchanged source bytes when the object has not reached S3 yet', async () => {
    send.mockRejectedValue(
      new NoSuchKey({ message: 'Missing object', $metadata: { httpStatusCode: 404 } }),
    );
    await expect(storage.get(key)).resolves.toEqual(sourceBody);
  });

  it('prefers S3 when both copies exist', async () => {
    const copiedBody = Buffer.from('copied bytes');
    send.mockResolvedValue({ Body: { transformToByteArray: async () => copiedBody } });
    await expect(storage.get(key)).resolves.toEqual(copiedBody);
  });

  it.each([403, 500, 503])(
    'surfaces S3 error %s instead of masking it with a local copy',
    async (status) => {
      const error = s3Error(status);
      send.mockRejectedValue(error);
      await expect(storage.get(key)).rejects.toBe(error);
    },
  );

  it('rejects source traversal even when S3 reports an absent object', async () => {
    send.mockRejectedValue(
      new NoSuchKey({ message: 'Missing object', $metadata: { httpStatusCode: 404 } }),
    );
    await expect(storage.get('../outside')).rejects.toThrow(
      'Invalid request recording storage key',
    );
  });

  it('surfaces a missing S3 bucket instead of serving a local copy', async () => {
    const error = new NoSuchBucket({
      message: 'Missing bucket',
      $metadata: { httpStatusCode: 404 },
    });
    send.mockRejectedValue(error);
    await expect(storage.get(key)).rejects.toBe(error);
  });

  it('keeps source bytes unchanged when writing or deleting S3 objects', async () => {
    send.mockResolvedValue({});
    await storage.put(key, Buffer.from('new bytes'));
    await storage.delete(key);
    await expect(readFile(join(directory, key))).resolves.toEqual(sourceBody);
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
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
});
