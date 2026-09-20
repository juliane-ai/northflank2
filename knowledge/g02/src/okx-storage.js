import { createPostgresPool } from './postgres.js';
import { initializeOkxSchema, okxStorageConfig, storageError } from './okx-database.js';
import { OkxPostgresAuth } from './okx-postgres-auth.js';
import { PostgresPositionLifecycleStore } from './okx-postgres-lifecycle.js';

export async function openOkxStorage({ env = process.env, authOptions, lifecycleOptions }) {
  const config = okxStorageConfig(env);
  const pool = createPostgresPool(config.connection, 'okx-research');
  pool.on('error', () => console.error('okx.database_connection_lost'));
  let lease;
  let acquired = false;
  try {
    lease = await pool.connect();
    acquired = (await lease.query("SELECT pg_try_advisory_lock(hashtext('okx-research-service')) AS acquired")).rows[0].acquired;
    if (!acquired) throw storageError('同一数据库已有 OKX 服务运行，请保持单副本');
    // Keep the lock connection supervised throughout initialization, too.
    let available = true;
    let storage;
    lease.on('error', () => { available = false; storage?.onFailure?.(); });
    await initializeOkxSchema(pool);
    const mode = config.mock ? 'demo' : 'live';
    const previousMode = (await pool.query("SELECT value FROM okx_research.storage_meta WHERE key='mode'")).rows[0];
    if (previousMode && previousMode.value !== mode) throw storageError('OKX 模拟和真实服务需要使用不同数据库');
    await pool.query("INSERT INTO okx_research.storage_meta VALUES('mode',$1) ON CONFLICT(key) DO NOTHING", [mode]);
    const auth = config.mock ? null : await new OkxPostgresAuth(pool, authOptions).initialize();
    if (!available) throw storageError('数据库服务锁已断开，请重启 OKX 服务');
    const lifecycleStore = new PostgresPositionLifecycleStore(pool, lifecycleOptions);
    let closing;
    storage = { backend: 'postgres', get available() { return available; }, auth, lifecycleStore,
      health: async () => { if (!available) throw new Error('Lease lost'); await pool.query('SELECT 1'); },
      close: () => closing ||= (async () => {
        available = false;
        auth?.close();
        await lease.query("SELECT pg_advisory_unlock(hashtext('okx-research-service'))").catch(() => {});
        lease.release();
        await pool.end();
      })() };
    return storage;
  } catch (error) {
    if (lease) {
      if (acquired) await lease.query("SELECT pg_advisory_unlock(hashtext('okx-research-service'))").catch(() => {});
      lease.release();
    }
    await pool.end();
    throw error;
  }
}
