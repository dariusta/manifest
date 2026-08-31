import { databaseTlsOptions } from './database-tls';

describe('databaseTlsOptions', () => {
  const connectionString =
    'postgresql://manifest:p%40ss@postgres.internal:5432/manifest?sslmode=require&application_name=manifest';

  it('leaves ordinary connection strings unchanged when no CA is supplied', () => {
    expect(databaseTlsOptions(connectionString, undefined)).toEqual({ connectionString });
  });

  it('uses the supplied CA with certificate verification enabled', () => {
    const options = databaseTlsOptions(
      connectionString,
      '  -----BEGIN CERTIFICATE-----\\nCA\\n-----END CERTIFICATE-----  ',
    );

    expect(options.ssl).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
      rejectUnauthorized: true,
    });
  });

  it('removes URL SSL parameters so node-postgres does not replace the CA options', () => {
    const options = databaseTlsOptions(connectionString, 'ca');
    const parsed = new URL(options.connectionString);

    expect(parsed.searchParams.has('sslmode')).toBe(false);
    expect(parsed.searchParams.get('application_name')).toBe('manifest');
    expect(parsed.password).toBe('p%40ss');
  });
});
