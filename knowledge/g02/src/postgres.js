import pg from 'pg';

export function createPostgresPool(raw, applicationName) {
  if (!raw) throw new Error('请配置 PostgreSQL 连接串');
  const url = new URL(raw.replace(/^jdbc:/, ''));
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('需要 PostgreSQL 连接串');
  // pg 8 treats these modes as verify-full. Keep certificate verification.
  if (['require', 'prefer', 'verify-ca'].includes(url.searchParams.get('sslmode'))) url.searchParams.set('sslmode', 'verify-full');
  return new pg.Pool({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, application_name: applicationName });
}

export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
