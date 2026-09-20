import { createPool } from './database.js';
import { StockStore } from './store.js';

const pool = createPool(process.env.STOCK_DATABASE_URL || process.env.EXTERNAL_JDBC_POSTGRES_URI_ADMIN);
try {
  const version = (await pool.query("SELECT current_setting('server_version') AS version")).rows[0].version;
  await new StockStore(pool).initialize();
  console.log(`PostgreSQL ${version}: stock_watch schema ready`);
} catch (error) {
  console.error(`Database initialization failed (${error.code || 'CONNECTION_ERROR'})`);
  process.exitCode = 1;
} finally { await pool.end(); }
