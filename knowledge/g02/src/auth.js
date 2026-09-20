import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const DEFAULT_SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function sameBuffer(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function boundedString(value, maximumLength) {
  return typeof value === 'string' && value.length <= maximumLength ? value : '';
}

function limiterState(map, key, now, windowMs) {
  const existing = map.get(key);
  if (!existing || (existing.blockedUntil <= now && now - existing.windowStartedAt >= windowMs)) {
    const fresh = { failures: 0, windowStartedAt: now, blockedUntil: 0 };
    map.set(key, fresh);
    return fresh;
  }
  return existing;
}

export class AuthService {
  constructor({
    username,
    password,
    sessionTtlMs = 8 * 60 * 60 * 1_000,
    failureWindowMs = 15 * 60 * 1_000,
    lockoutMs = 15 * 60 * 1_000,
    maxFailuresPerIp = 5,
    maxFailuresPerAccount = 20,
    maxSessions = 10,
    maxConcurrentLogins = 8,
    maxConcurrentLoginsPerIp = 2,
    scryptOptions = DEFAULT_SCRYPT_OPTIONS,
  }) {
    if (!username || !password) throw new Error('Authentication credentials are required');

    this.username = username;
    this.usernameDigest = digest(username);
    this.passwordSalt = randomBytes(16);
    this.password = password;
    this.passwordDigest = null;
    this.scryptOptions = scryptOptions;
    this.sessionTtlMs = sessionTtlMs;
    this.failureWindowMs = failureWindowMs;
    this.lockoutMs = lockoutMs;
    this.maxFailuresPerIp = maxFailuresPerIp;
    this.maxFailuresPerAccount = maxFailuresPerAccount;
    this.maxSessions = maxSessions;
    this.maxConcurrentLogins = maxConcurrentLogins;
    this.maxConcurrentLoginsPerIp = maxConcurrentLoginsPerIp;
    this.activeLoginCount = 0;
    this.activeLoginsByIp = new Map();
    this.failuresByIp = new Map();
    this.accountFailures = new Map();
    this.sessions = new Map();
  }

  async initialize() {
    this.passwordDigest = Buffer.from(await scrypt(this.password, this.passwordSalt, 32, this.scryptOptions));
    this.password = null;
    return this;
  }

  blockedFor(ip, now = Date.now()) {
    const states = [this.failuresByIp.get(ip), this.accountFailures.get('account')].filter(Boolean);
    const blockedUntil = Math.max(0, ...states.map((state) => state.blockedUntil));
    return Math.max(0, blockedUntil - now);
  }

  recordFailure(ip, now) {
    const limits = [
      [this.failuresByIp, ip, this.maxFailuresPerIp],
      [this.accountFailures, 'account', this.maxFailuresPerAccount],
    ];

    for (const [map, key, maximum] of limits) {
      const state = limiterState(map, key, now, this.failureWindowMs);
      state.failures += 1;
      if (state.failures >= maximum) state.blockedUntil = now + this.lockoutMs;
    }
  }

  async login({ username, password, ip, now = Date.now() }) {
    const blockedMs = this.blockedFor(ip, now);
    if (blockedMs > 0) {
      return { ok: false, status: 429, retryAfterSeconds: Math.ceil(blockedMs / 1_000) };
    }

    const activeForIp = this.activeLoginsByIp.get(ip) ?? 0;
    if (this.activeLoginCount >= this.maxConcurrentLogins || activeForIp >= this.maxConcurrentLoginsPerIp) {
      return { ok: false, status: 429, retryAfterSeconds: 1 };
    }

    this.activeLoginCount += 1;
    this.activeLoginsByIp.set(ip, activeForIp + 1);
    try {
      const candidateUsername = boundedString(username, 256);
      const candidatePassword = boundedString(password, 1_024);
      const candidatePasswordDigest = Buffer.from(await scrypt(candidatePassword, this.passwordSalt, 32, this.scryptOptions));
      const validUsername = sameBuffer(digest(candidateUsername), this.usernameDigest);
      const validPassword = sameBuffer(candidatePasswordDigest, this.passwordDigest);

      if (!(validUsername && validPassword)) {
        this.recordFailure(ip, now);
        return { ok: false, status: 401 };
      }

      this.failuresByIp.delete(ip);
      this.accountFailures.delete('account');
      this.cleanup(now);

      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(24).toString('base64url');
      const expiresAt = now + this.sessionTtlMs;
      const tokenHash = digest(token).toString('hex');
      const session = { csrfToken, createdAt: now, expiresAt };
      this.sessions.set(tokenHash, session);
      this.trimSessions();
      return { ok: true, token, csrfToken, expiresAt };
    } finally {
      this.activeLoginCount -= 1;
      const remainingForIp = (this.activeLoginsByIp.get(ip) ?? 1) - 1;
      if (remainingForIp <= 0) this.activeLoginsByIp.delete(ip);
      else this.activeLoginsByIp.set(ip, remainingForIp);
    }
  }

  session(token, now = Date.now()) {
    if (!token) return null;
    const key = digest(token).toString('hex');
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  revoke(token) {
    if (!token) return;
    const key = digest(token).toString('hex');
    this.sessions.delete(key);
  }

  cleanup(now = Date.now()) {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
    for (const map of [this.failuresByIp, this.accountFailures]) {
      for (const [key, state] of map) {
        if (state.blockedUntil <= now && now - state.windowStartedAt >= this.failureWindowMs) map.delete(key);
      }
    }
  }

  trimSessions() {
    if (this.sessions.size <= this.maxSessions) return;
    const oldest = [...this.sessions.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt);
    for (const [key] of oldest.slice(0, this.sessions.size - this.maxSessions)) this.sessions.delete(key);
  }

  close() {
    this.sessions.clear();
  }
}

export function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return sameBuffer(digest(left), digest(right));
}
