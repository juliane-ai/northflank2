import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行状态汇总：把“截图入口是否真的在跑、识图走哪条链路、备份映射有没有生效”
// 变成主看板可以读到的一份只读摘要。所有值都来自环境变量与容器内的状态文件，
// 不包含任何凭据正文；读取失败一律降级为 null/缺省，绝不影响健康检查。
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const PERSISTENCE_STATUS_FILE = '/tmp/rclone-persistence/status.json';
const SNOWFLAKE = /^\d{16,22}$/;
const MAPPING_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_MODELS = 8;
const MAX_TEXT = 160;

export function signalDataRoot(env = process.env) {
  return resolve(env.SIGNAL_DATA_DIR || resolve(projectRoot, 'data'));
}

export function positiveInt(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function text(value) {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : null;
}

function moment(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function mappingNames(value) {
  if (typeof value !== 'string' || value === '') return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(entry => entry && typeof entry === 'object' ? entry.name : null)
    .filter(name => typeof name === 'string' && MAPPING_NAME.test(name))
    .slice(0, 16);
}

export function visionSummary(env = {}) {
  const models = String(env.SIGNAL_VISION_MODELS || '').split(',').map(model => model.trim()).filter(Boolean).slice(0, MAX_MODELS);
  return {
    configured: Boolean(text(env.SIGNAL_VISION_BASE_URL) && text(env.SIGNAL_VISION_API_KEY) && models.length),
    route: String(env.ZEROCLAW_VISION_ROUTE || '').trim().toLowerCase() === 'direct' ? 'direct' : 'relay',
    models,
    attempts: positiveInt(env.SIGNAL_VISION_ATTEMPTS, 2, 6),
  };
}

export function discordConfigured(env = {}) {
  const token = env.SIGNAL_DISCORD_BOT_TOKEN || env.ZEROCLAW_channels__discord__main__bot_token;
  return typeof token === 'string' && token.length >= 20
    && SNOWFLAKE.test(env.SIGNAL_DISCORD_CHANNEL_ID || '')
    && SNOWFLAKE.test(env.SIGNAL_DISCORD_GUILD_ID || '')
    && SNOWFLAKE.test(env.SIGNAL_DISCORD_ALLOWED_USER_ID || '');
}

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 与 scripts/cloud-health.mjs 的全量健康检查共用同一判定，避免两处标准漂移。
export function discordStatusHealthy(status, record, { now = Date.now(), alive: isAlive = alive } = {}) {
  if (!Number.isSafeInteger(status?.pid) || status.pid < 2 || record?.pid !== status.pid || !isAlive(status.pid)) return false;
  // 三张图片下载（60s）、三次模型调用（135s）、分析代理（300s）、登记与回复预算都包含在十分钟内。
  if (status.state === 'processing') return Number.isFinite(status.processingStartedAt) && now - status.processingStartedAt <= 600_000;
  return status.state === 'running' && !status.error && Number.isFinite(status.lastPollAt) && now - status.lastPollAt <= 60_000;
}

export function intakeState(summary) {
  if (!summary) return 'unknown';
  if (!summary.enabled) return 'disabled';
  if (summary.state === 'missing') return 'not_started';
  if (summary.healthy) return 'running';
  return summary.state === 'processing' || summary.state === 'starting' ? summary.state : 'unhealthy';
}

async function jsonAt(read, path) {
  try { return JSON.parse(await read(path, 'utf8')); } catch { return null; }
}

async function intakeSummary(env, { read, now, isAlive }) {
  const base = resolve(signalDataRoot(env), 'signal-discord');
  const [status, record, cursor] = await Promise.all([
    jsonAt(read, resolve(base, 'status.json')),
    jsonAt(read, resolve(base, 'worker.pid')),
    jsonAt(read, resolve(base, 'cursor.json')),
  ]);
  const healthy = discordStatusHealthy(status, record, { now: now(), alive: isAlive });
  return {
    enabled: env.SIGNAL_DISCORD_ENABLED === 'true',
    configured: discordConfigured(env),
    state: text(status?.state) || 'missing',
    healthy,
    pidAlive: isAlive(record?.pid),
    startedAt: moment(status?.startedAt),
    lastPollAt: moment(status?.lastPollAt),
    processed: Number.isSafeInteger(status?.processed) ? status.processed : 0,
    lastResult: text(status?.lastResult),
    error: text(status?.error),
    cursorUpdatedAt: moment(cursor?.updatedAt),
  };
}

async function persistenceSummary(env, { read }) {
  const status = await jsonAt(read, PERSISTENCE_STATUS_FILE);
  const lastSuccess = status?.lastSuccess;
  return {
    enabled: env.PERSIST_ENABLED === 'true',
    mappings: mappingNames(env.PERSIST_PATHS_JSON),
    lastSuccessAt: Number.isFinite(lastSuccess) && lastSuccess > 0 ? Math.round(lastSuccess * 1000) : null,
    error: text(status?.error),
  };
}

export async function runtimeSummary(env = process.env, deps = {}) {
  const { read = readFile, now = Date.now, alive: isAlive = alive } = deps;
  const [intake, persistence] = await Promise.all([
    intakeSummary(env, { read, now, isAlive }),
    persistenceSummary(env, { read }),
  ]);
  return {
    intake,
    vision: visionSummary(env),
    persistence,
    agent: { runtime: String(env.SIGNAL_AGENT_RUNTIME || '').toLowerCase() === 'docker' ? 'docker' : 'native' },
    checkedAt: now(),
  };
}
