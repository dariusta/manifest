export interface DatabaseTlsOptions {
  connectionString: string;
  ssl?: {
    ca: string;
    rejectUnauthorized: true;
  };
}

const SSL_QUERY_PARAMETERS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];

/**
 * Build pg/TypeORM connection options for platforms that provide a private CA.
 *
 * node-postgres replaces an explicit `ssl` object when the connection string
 * contains SSL query parameters. Remove those parameters when a CA is supplied
 * so the verified CA configuration remains authoritative.
 */
export function databaseTlsOptions(
  connectionString: string,
  caValue = process.env['DATABASE_CA_CERT'],
): DatabaseTlsOptions {
  const ca = caValue?.replace(/\\n/g, '\n').trim();
  if (!ca) return { connectionString };

  const parsed = new URL(connectionString);
  for (const parameter of SSL_QUERY_PARAMETERS) {
    parsed.searchParams.delete(parameter);
  }

  return {
    connectionString: parsed.toString(),
    ssl: { ca, rejectUnauthorized: true },
  };
}
