import { createPostgresPool } from './postgres.js';
import { initializeOkxSchema, okxStorageConfig, storageError } from './okx-database.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== '--check')) throw storageError('用法：npm run okx:migrate -- [--check]');
  const config = okxStorageConfig(process.env);
  const pool = createPostgresPool(config.connection, 'okx-migration');
  pool.on('error', () => console.error('okx.database_connection_lost'));
  try {
    if (args.includes('--check')) {
      const { rows } = await pool.query("SELECT current_setting('server_version') AS version");
      console.log(JSON.stringify({ connected: true, version: rows[0].version }));
      return;
    }
    await initializeOkxSchema(pool);
    console.log('OKX PostgreSQL schema ready');
  } finally { await pool.end(); }
}

main().catch((error) => {
  console.error(error.safeToLog ? error.message : `OKX 数据库操作失败 (${error.code || 'CONNECTION_OR_DATA_ERROR'})`);
  process.exitCode = 1;
});
