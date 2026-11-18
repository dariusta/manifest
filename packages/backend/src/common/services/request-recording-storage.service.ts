import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isSelfHosted } from '../utils/detect-self-hosted';

export type RecordingStorageBackend = 'filesystem' | 's3';

export interface RecordingStorage {
  readonly backend: RecordingStorageBackend;
  prepare(): Promise<void>;
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export interface S3StorageConfig {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  /** Prepended to the logical key on put/get/delete. The database key is unchanged. */
  prefix?: string;
  /** Read-only filesystem root used when GetObject returns NoSuchKey. */
  fallbackFilesystemPath?: string;
}

function invalidRecordingS3Prefix(prefix: string): Error {
  return new Error(
    `Invalid REQUEST_RECORDING_S3_PREFIX "${prefix}". Use a relative prefix with no "..", ".", or control characters. An invalid prefix prevents the process from booting.`,
  );
}

/**
 * Collapse duplicate and leading/trailing slashes and require one trailing
 * slash. `..` and `.` segments and control characters are rejected so a prefix
 * cannot climb out of the intended bucket location or hide a bad value.
 * An empty prefix leaves logical keys unchanged. An invalid prefix throws:
 * selecting S3 with that value fails boot instead of disabling recording.
 */
export function normalizeRecordingS3Prefix(prefix: string | undefined | null): string {
  if (prefix == null) return '';
  // Trim before the control-character check so a trailing CR or tab from a
  // Windows .env is the same as a trailing space, not a boot failure.
  const trimmed = prefix.trim();
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) throw invalidRecordingS3Prefix(prefix);
  const collapsed = trimmed
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!collapsed) return '';
  if (collapsed.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw invalidRecordingS3Prefix(prefix);
  }
  return `${collapsed}/`;
}

export type ResolvedRecordingStorage =
  | { backend: 'filesystem'; path: string }
  | ({ backend: 's3' } & S3StorageConfig)
  | { backend: null; reason: string };

function storageKeySegment(value: string): string {
  if (!value) throw new Error('Request recording storage key segments cannot be empty');
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

interface RecordingStorageConfigSource {
  get<T = unknown>(key: string): T | undefined;
}

export function resolveRecordingStorage(
  config: RecordingStorageConfigSource,
  selfHosted = isSelfHosted(),
  cwd = process.cwd(),
): ResolvedRecordingStorage {
  const requested = (config.get<string>('app.requestRecordingStorage') ?? 'auto').toLowerCase();
  const nodeEnv = config.get<string>('app.nodeEnv') ?? 'development';
  const filesystemPath =
    config.get<string>('app.requestRecordingFilesystemPath') ||
    (nodeEnv === 'production'
      ? '/data/request-recordings'
      : join(cwd, '.data', 'request-recordings'));
  const bucket = config.get<string>('app.requestRecordingS3Bucket')?.trim() ?? '';
  const endpoint = config.get<string>('app.requestRecordingS3Endpoint')?.trim() || undefined;
  const region = config.get<string>('app.requestRecordingS3Region')?.trim() ?? '';
  const accessKeyId = config.get<string>('app.requestRecordingS3AccessKeyId')?.trim() || undefined;
  const secretAccessKey =
    config.get<string>('app.requestRecordingS3SecretAccessKey')?.trim() || undefined;
  const forcePathStyle = config.get<boolean>('app.requestRecordingS3ForcePathStyle') ?? false;
  const prefix = config.get<string>('app.requestRecordingS3Prefix') ?? '';
  const fallbackFilesystemPath =
    config.get<string>('app.requestRecordingFallbackFilesystemPath')?.trim() || undefined;
  const hasExplicitCredentials = Boolean(accessKeyId && secretAccessKey);
  const hasPartialCredentials = Boolean(accessKeyId || secretAccessKey);
  const completeS3 = Boolean(
    bucket && region && (!hasPartialCredentials || hasExplicitCredentials),
  );

  const s3 = (): ResolvedRecordingStorage => {
    if (!completeS3) {
      return {
        backend: null,
        reason:
          'S3 recording storage requires a bucket, region, and either both access-key values or neither',
      };
    }
    // Throw rather than disabling storage. The service constructor calls this
    // while Nest is booting, so a bad prefix stops the process.
    normalizeRecordingS3Prefix(prefix);
    return {
      backend: 's3',
      bucket,
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      prefix,
      fallbackFilesystemPath,
    };
  };

  if (requested === 's3') return s3();
  if (requested === 'filesystem') return { backend: 'filesystem', path: filesystemPath };
  if (requested === 'disabled') {
    return { backend: null, reason: 'Recording storage was explicitly disabled' };
  }
  if (requested !== 'auto') {
    return {
      backend: null,
      reason: `Unknown REQUEST_RECORDING_STORAGE value "${requested}"`,
    };
  }
  if (bucket || region || hasPartialCredentials || endpoint) return s3();
  if (selfHosted || nodeEnv !== 'production') {
    return { backend: 'filesystem', path: filesystemPath };
  }
  return {
    backend: null,
    reason: 'Managed Cloud requires S3 recording storage credentials',
  };
}

class FilesystemRecordingStorage implements RecordingStorage {
  readonly backend = 'filesystem' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.pathFor(key);
    const temporary = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, body);
    await rename(temporary, target);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new Error('Invalid request recording storage key');
    }
    return target;
  }
}

function recordingErrorLabels(error: object): string[] {
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  return [candidate.name, candidate.Code, candidate.code].filter(
    (value): value is string => typeof value === 'string' && value.length > 0 && value !== 'Error',
  );
}

function describeRecordingError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const labels = recordingErrorLabels(error);
  const message = error instanceof Error ? error.message : '';
  return labels.length > 0 ? `${labels[0]}: ${message}` : message || String(error);
}

/**
 * Missing object only when the error is named NoSuchKey. S3 and R2 GetObject
 * both return that name for a key that is not in the bucket. A bare HTTP 404
 * is not that response, so it is not a reason to read the filesystem copy.
 */
function isMissingRecordingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return recordingErrorLabels(error).includes('NoSuchKey');
}

function isEnoent(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT',
  );
}

export class S3RecordingStorage implements RecordingStorage {
  readonly backend = 's3' as const;
  private readonly client: S3Client;
  private readonly keyPrefix: string;
  private readonly fallback: FilesystemRecordingStorage | null;
  private readonly logger = new Logger(S3RecordingStorage.name);

  constructor(
    private readonly config: S3StorageConfig,
    client?: S3Client,
  ) {
    this.keyPrefix = normalizeRecordingS3Prefix(config.prefix);
    const fallbackPath = config.fallbackFilesystemPath?.trim() ?? '';
    // Read-only: prepare() is never called, so a missing directory is not created.
    this.fallback = fallbackPath ? new FilesystemRecordingStorage(fallbackPath) : null;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        credentials:
          config.accessKeyId && config.secretAccessKey
            ? {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
              }
            : undefined,
      });
  }

  async prepare(): Promise<void> {}

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.storedKey(key),
        Body: body,
        // The body is client-side ciphertext (see request-recording-codec), not
        // readable JSON, and declaring ContentEncoding: gzip made some
        // S3-compatible stores and CDNs try to gunzip it transparently on GET.
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await this.readStoredObject(key);
    } catch (error) {
      if (this.fallback && isMissingRecordingObject(error)) {
        return this.readFallback(this.fallback, key, error);
      }
      if (this.fallback) {
        this.logger.error(
          `Request recording S3 read failed; filesystem fallback was not used: ${describeRecordingError(error)}`,
        );
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.storedKey(key) }),
    );
  }

  private storedKey(key: string): string {
    if (!this.keyPrefix) return key;
    return `${this.keyPrefix}${key.replace(/^\/+/, '')}`;
  }

  private async readStoredObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: this.storedKey(key) }),
    );
    if (!response.Body) throw new Error('Request recording object has no body');
    return Buffer.from(await response.Body.transformToByteArray());
  }

  private async readFallback(
    fallback: FilesystemRecordingStorage,
    key: string,
    missing: unknown,
  ): Promise<Buffer> {
    try {
      const body = await fallback.get(key);
      this.logger.debug(`Request recording filesystem fallback hit: ${key}`);
      return body;
    } catch (error) {
      if (isEnoent(error)) throw missing;
      throw error;
    }
  }
}

@Injectable()
export class RequestRecordingStorageService implements OnModuleInit {
  private readonly logger = new Logger(RequestRecordingStorageService.name);
  private storage: RecordingStorage | null;
  private unavailableReason: string | null;
  private readonly fallbackFilesystemPath: string;
  private readonly retentionDays: number | null;

  constructor(config: ConfigService) {
    this.fallbackFilesystemPath =
      config.get<string>('app.requestRecordingFallbackFilesystemPath')?.trim() ?? '';
    this.retentionDays = config.get<number | null>('app.requestRecordingRetentionDays') ?? null;
    const resolved = resolveRecordingStorage(config);
    if (resolved.backend === 'filesystem') {
      this.storage = new FilesystemRecordingStorage(resolved.path);
      this.unavailableReason = null;
    } else if (resolved.backend === 's3') {
      this.storage = new S3RecordingStorage(resolved);
      this.unavailableReason = null;
    } else {
      this.storage = null;
      this.unavailableReason = resolved.reason;
    }
  }

  async onModuleInit(): Promise<void> {
    this.warnIfFallbackOutlivesRetention();
    if (!this.storage) {
      this.logger.warn(`Request recording storage unavailable: ${this.unavailableReason}`);
      return;
    }
    try {
      await this.storage.prepare();
      this.logger.log(`Request recording storage: ${this.storage.backend}`);
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : String(error);
      this.storage = null;
      this.logger.error(`Request recording storage unavailable: ${this.unavailableReason}`);
    }
  }

  get backend(): RecordingStorageBackend | null {
    return this.storage?.backend ?? null;
  }

  objectKey(tenantId: string, requestId: string, attemptId: string): string {
    return (
      `request-recordings/v1/tenants/${storageKeySegment(tenantId)}` +
      `/requests/${storageKeySegment(requestId)}` +
      `/attempts/${storageKeySegment(attemptId)}.json.gz`
    );
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.requireStorage().put(key, body);
  }

  async get(key: string): Promise<Buffer> {
    return this.requireStorage().get(key);
  }

  async delete(key: string): Promise<void> {
    await this.requireStorage().delete(key);
  }

  private warnIfFallbackOutlivesRetention(): void {
    if (
      this.storage?.backend !== 's3' ||
      !this.fallbackFilesystemPath ||
      this.retentionDays === 0
    ) {
      return;
    }
    this.logger.warn(
      'REQUEST_RECORDING_FALLBACK_FILESYSTEM_PATH is set while retention is enabled. Retention deletes only the S3 object and clears the database key; files on the fallback path are never deleted by the app.',
    );
  }

  private requireStorage(): RecordingStorage {
    if (!this.storage) {
      throw new Error(this.unavailableReason ?? 'Request recording storage is unavailable');
    }
    return this.storage;
  }
}
