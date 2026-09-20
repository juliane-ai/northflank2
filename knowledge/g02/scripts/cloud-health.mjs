import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// 与主看板运行状态共用同一判定，避免两处标准漂移。
import { discordStatusHealthy } from '../src/signals/runtime.js';
export { discordStatusHealthy };

const enabled = value => value === 'true';
const fresh = (value, now, maxAge) => Number.isFinite(value) && value <= now + 5000 && now - value <= maxAge;

async function request(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Service health request failed');
  return response;
}

export async function signalHealth(env = process.env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.SIGNAL_API_TOKEN || env.SIGNAL_API_TOKEN.length < 32) throw new Error('Signal service API token is required');
  const base = enabled(env.SIGNAL_ENABLED)
    ? `http://127.0.0.1:${env.PORT || 8080}/simulation`
    : `http://127.0.0.1:${env.SIGNAL_PORT || 8082}`;
  const response = await request(`${base}/api/dashboard`, {
    headers: { Authorization: `Bearer ${env.SIGNAL_API_TOKEN}` },
  }, fetchImpl);
  const body = await response.json();
  if (body.mode !== 'okx-demo' || !body.monitor?.running || body.monitor.error
    || !fresh(body.monitor.lastSuccessAt, now, 120_000)) throw new Error('Signal scheduler is not ready');
}

export async function cloudHealth(env = process.env, { fetchImpl = fetch, read = readFile, now = Date.now(), alive } = {}) {
  if (enabled(env.SIGNAL_DISCORD_ENABLED) && !enabled(env.SIGNAL_ENABLED)) throw new Error('Discord requires the signal service');
  const checks = [request(`http://127.0.0.1:${env.PORT || 8080}/healthz`, {}, fetchImpl)];
  if (enabled(env.SIGNAL_ENABLED)) checks.push(signalHealth(env, { fetchImpl, now }));
  if (enabled(env.STOCK_ENABLED)) checks.push(request(`http://127.0.0.1:${env.STOCK_PORT || 8081}/healthz`, {}, fetchImpl));
  if (enabled(env.SIGNAL_DISCORD_ENABLED)) checks.push((async () => {
    const directory = resolve(env.SIGNAL_DATA_DIR || '/app/data', 'signal-discord');
    const [status, record] = await Promise.all(['status.json', 'worker.pid'].map(async file => JSON.parse(await read(resolve(directory, file), 'utf8'))));
    if (!discordStatusHealthy(status, record, { now, alive })) throw new Error('Discord intake is not healthy');
  })());
  // Wait for every check, including rejected network requests, before exiting.
  const results = await Promise.allSettled(checks);
  if (results.some(result => result.status === 'rejected')) throw new Error('One or more enabled services are not healthy');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2] === '--signals' ? signalHealth : cloudHealth;
  action().catch(() => { console.error('Enabled service health check failed'); process.exitCode = 1; });
}
