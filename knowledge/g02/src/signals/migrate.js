import { createPostgresPool } from '../postgres.js';
import { readFile } from 'node:fs/promises';
const pool = createPostgresPool(process.env.SIGNAL_DATABASE_URL, 'signal-migrate');
try { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); console.log('signal_research schema ready'); }
catch { console.error('方向策略数据库迁移失败，请检查 SIGNAL_DATABASE_URL'); process.exitCode = 1; }
finally { await pool.end(); }
