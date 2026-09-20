import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { localEnvironment } from './signals-local.mjs';
import { validateServiceConfig } from '../src/signals/mcp.js';
import { signalDataRoot } from '../src/signals/runtime.js';

export { signalDataRoot };

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const relayKeys = ['api_key', 'uri', 'model'].map(key => 'ZEROCLAW_providers__models__custom__relay__' + key);
export const relayUriKey = relayKeys[1];
export const textRelayPath = '/internal/relay/v1';

export function relayRoute(env = process.env) {
  const value = String(env.ZEROCLAW_RELAY_ROUTE ?? 'local').trim().toLowerCase();
  if (value !== 'local' && value !== 'direct') throw new Error('ZEROCLAW_RELAY_ROUTE must be local or direct');
  return value;
}

export function loopbackRelayUri(env = process.env, path = textRelayPath) {
  const port = String(env.PORT ?? env.OKX_VIEWER_PORT ?? '8080').trim();
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Dashboard port is invalid for the local retry relay');
  }
  return `http://127.0.0.1:${Number(port)}${path}`;
}

// 上游中转随机返回 403/5xx，文字模型调用同样改道同容器回环重试端点；
// 运维自己指向的其他服务（HTTP、额外路径、查询参数）保持原样。
export function relayAgentUri(env = process.env) {
  const value = env[relayUriKey];
  if (relayRoute(env) !== 'local' || typeof value !== 'string' || value === '') return value;
  let parsed;
  try { parsed = new URL(value); } catch { return value; }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.search !== '' || parsed.hash !== '' || !['', '/', '/v1', '/v1/'].includes(parsed.pathname)) return value;
  return loopbackRelayUri(env);
}

export function signalRuntime(env = process.env) {
  const mode = env.SIGNAL_AGENT_RUNTIME || 'docker';
  if (!['docker', 'native'].includes(mode)) throw new Error('SIGNAL_AGENT_RUNTIME must be docker or native');
  return mode;
}

export async function signalEnvironment(inherited = process.env) {
  // Production uses only explicit container configuration, never developer files.
  if (signalRuntime(inherited) === 'native') return { ...inherited };
  let project = {};
  try { project = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...project, ...inherited };
}

export async function signalServiceEnvironment(env = process.env) {
  const native = signalRuntime(env) === 'native';
  const values = native ? env : await localEnvironment(projectRoot, env);
  const port = native ? (values.SIGNAL_PORT || '8082') : values.SIGNAL_LOCAL_PORT;
  const defaultUrl = native && values.SIGNAL_ENABLED === 'true'
    ? `http://127.0.0.1:${values.PORT || '8080'}/simulation`
    : `http://127.0.0.1:${port}`;
  const service = validateServiceConfig({
    SIGNAL_SERVICE_URL: native && values.SIGNAL_SERVICE_URL || defaultUrl,
    SIGNAL_API_TOKEN: values.SIGNAL_API_TOKEN,
  });
  return { SIGNAL_SERVICE_URL: service.origin, SIGNAL_API_TOKEN: service.token };
}

export function nativeAgentEnvironment(env, { service, directory, temporary, search = false }) {
  for (const key of relayKeys) if (!env[key]) throw new Error(`Missing model configuration: ${key}`);
  const result = {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8', NO_COLOR: '1', HOME: temporary, TMPDIR: temporary,
    ...Object.fromEntries(relayKeys.map(key => [key, key === relayUriKey ? relayAgentUri(env) : env[key]])),
    ...service, SIGNAL_MCP_READ_ONLY: '1',
    SIGNAL_MCP_AUDIT_PATH: resolve(directory, 'tool-calls.jsonl'),
    ZEROCLAW_DATA_DIR: resolve(temporary, 'data'),
  };
  if (search) result.SIGNAL_SEARCH_URL = env.SIGNAL_SEARCH_URL || 'https://p01--g02-ritup-repo01-search--4ygvmqls7l8l.code.run';
  return result;
}
