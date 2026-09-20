import { createHash } from 'node:crypto';
import { AuthService } from './auth.js';
import { transaction } from './postgres.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export class OkxPostgresAuth {
  constructor(pool, options) {
    this.pool = pool;
    this.binding = hash(`${options.username}\0${options.password}`);
    this.verifier = new AuthService(options);
  }

  async initialize() {
    await this.verifier.initialize();
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('okx-auth'))");
      const previous = (await db.query("SELECT value FROM okx_research.auth_meta WHERE key='credential_binding'")).rows[0];
      if (!previous || previous.value !== this.binding) await db.query('DELETE FROM okx_research.auth_sessions');
      await db.query("INSERT INTO okx_research.auth_meta VALUES('credential_binding',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [this.binding]);
      await db.query('DELETE FROM okx_research.auth_sessions WHERE expires_at<=$1', [Date.now()]);
    });
    this.binding = null;
    return this;
  }

  async login(input) {
    const now = input.now ?? Date.now();
    const result = await this.verifier.login({ ...input, now });
    if (!result.ok) return result;
    this.verifier.revoke(result.token);
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('okx-auth'))");
      await db.query('DELETE FROM okx_research.auth_sessions WHERE expires_at<=$1', [now]);
      await db.query('INSERT INTO okx_research.auth_sessions VALUES($1,$2,$3,$4)', [hash(result.token), result.csrfToken, now, result.expiresAt]);
      await db.query(`DELETE FROM okx_research.auth_sessions WHERE token_hash IN (
        SELECT token_hash FROM okx_research.auth_sessions ORDER BY created_at DESC,token_hash OFFSET $1
      )`, [this.verifier.maxSessions]);
    });
    return result;
  }

  async session(token, now = Date.now()) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return null;
    const row = (await this.pool.query(`SELECT csrf_token,created_at,expires_at FROM okx_research.auth_sessions
      WHERE token_hash=$1 AND expires_at>$2`, [hash(token), now])).rows[0];
    return row ? { csrfToken: row.csrf_token, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) } : null;
  }

  async revoke(token) {
    if (!token) return;
    await this.pool.query('DELETE FROM okx_research.auth_sessions WHERE token_hash=$1', [hash(token)]);
  }

  async cleanup(now = Date.now()) {
    this.verifier.cleanup(now);
    await this.pool.query('DELETE FROM okx_research.auth_sessions WHERE expires_at<=$1', [now]);
  }

  close() { this.verifier.close(); }
}
