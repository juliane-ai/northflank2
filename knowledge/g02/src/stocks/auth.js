import { createHash } from 'node:crypto';
import { AuthService } from '../auth.js';
import { transaction } from './database.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

// Reuse the existing password verification and rate limits, with a separate
// PostgreSQL session repository and independent stock-service credentials.
export class StockAuth {
  constructor(pool, { username, password, ttlMs = 30 * 86400_000 }) {
    this.pool = pool;
    this.username = username;
    this.binding = hash(`${username}\0${password}`);
    this.verifier = new AuthService({ username, password, sessionTtlMs: ttlMs });
  }

  async initialize() {
    await this.verifier.initialize();
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('stock-auth-binding'))");
      const previous = (await db.query("SELECT value FROM stock_watch.meta WHERE key='credentials'")).rows[0];
      if (previous && previous.value !== this.binding) await db.query('DELETE FROM stock_watch.sessions');
      await db.query("INSERT INTO stock_watch.meta VALUES('credentials',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [this.binding]);
      await db.query('DELETE FROM stock_watch.sessions WHERE expires_at<=now()');
    });
    this.binding = null;
  }

  async login(input) {
    const result = await this.verifier.login(input);
    if (!result.ok) return result;
    this.verifier.revoke(result.token);
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('stock-auth-sessions'))");
      await db.query('DELETE FROM stock_watch.sessions WHERE expires_at<=now()');
      await db.query('INSERT INTO stock_watch.sessions VALUES($1,$2,now(),$3)', [hash(result.token), result.csrfToken, new Date(result.expiresAt)]);
      await db.query('DELETE FROM stock_watch.sessions WHERE token_hash IN (SELECT token_hash FROM stock_watch.sessions ORDER BY created_at DESC OFFSET 10)');
    });
    return result;
  }

  async session(token) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return null;
    const row = (await this.pool.query('SELECT csrf_token,expires_at FROM stock_watch.sessions WHERE token_hash=$1 AND expires_at>now()', [hash(token)])).rows[0];
    return row ? { csrfToken: row.csrf_token, expiresAt: new Date(row.expires_at).getTime() } : null;
  }

  async revoke(token) { await this.pool.query('DELETE FROM stock_watch.sessions WHERE token_hash=$1', [hash(token)]); }
}
