import { readFile } from 'node:fs/promises';
import { transaction } from './postgres.js';

export function storageError(message) { return Object.assign(new Error(message), { safeToLog: true }); }

export function okxStorageConfig(env) {
  const mock = env.OKX_MOCK === '1';
  if (mock && env.NODE_ENV === 'production') throw storageError('生产环境不能运行 OKX 模拟预览');
  const connection = mock
    ? env.OKX_DEMO_DATABASE_URL || 'postgresql://stockdev:local-stock-preview-only@127.0.0.1:15432/okx_research_dev'
    : env.OKX_DATABASE_URL || env.EXTERNAL_JDBC_POSTGRES_URI_ADMIN;
  if (!connection) throw storageError('请配置 OKX_DATABASE_URL 或 EXTERNAL_JDBC_POSTGRES_URI_ADMIN');
  return { mock, connection };
}

export async function initializeOkxSchema(pool) {
  const sql = await readFile(new URL('./okx-schema.sql', import.meta.url), 'utf8');
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('okx-schema-v1'))");
    await db.query(sql);
  });
}
