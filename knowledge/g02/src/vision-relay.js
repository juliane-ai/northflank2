import { sameToken } from './auth.js';

// 上游中转的重试层。
//
// 中转服务（new-api）在多个通道之间随机分流，其中一部分通道会直接返回
// 403/5xx：实测同一个模型连续请求也会 1 次成功、2 次失败，纯文字与图片请求的
// 失败率一致。ZeroClaw v0.8.5 既不重试专用视觉路由（`create_model_provider_from_ref_with_model`
// 返回裸 provider），也不重试文字 relay 的 403（只会重建 provider 再失败一次），
// 一次随机失败就会让整轮 Discord 回复报错，因此这里提供同一套补救路径：
//
//   1. 主服务暴露仅回环可达的重试端点，ZeroClaw 的 vision / relay alias 指向它；
//   2. 方向实验室复用同一套可重试状态判定。
//
// 请求体只在内存中保留一份用于重试，大小有上限；凭据与上游响应正文都不会写日志。

export const RELAY_PATH = '/internal/vision/v1/chat/completions';
// 文字模型 alias 的对应端点；只重试同一个模型，不会静默换模型。
export const TEXT_RELAY_PATH = '/internal/relay/v1/chat/completions';
export const MAX_RELAY_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_RELAY_RESPONSE_BYTES = 4 * 1024 * 1024;

// 403 用来表示"该通道被上游拒绝"，与 429/5xx 一样属于换通道就能成功的临时故障。
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const RELAY_UPSTREAM_URI = 'ZEROCLAW_providers__models__custom__relay__uri';
const RELAY_UPSTREAM_KEY = 'ZEROCLAW_providers__models__custom__relay__api_key';
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isRetryableVisionStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

export function positiveInt(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function visionRelayLimits(env = {}) {
  return {
    // 实测该中转每个请求约 50% 返回 403，4 次尝试把单模型失败率压到 ~6%。
    attempts: positiveInt(env.SIGNAL_VISION_RELAY_ATTEMPTS, 4, 6),
    timeoutMs: positiveInt(env.SIGNAL_VISION_RELAY_TIMEOUT_MS, 20_000, 120_000),
    budgetMs: positiveInt(env.SIGNAL_VISION_RELAY_BUDGET_MS, 60_000, 300_000),
    backoffMs: positiveInt(env.SIGNAL_VISION_RELAY_BACKOFF_MS, 250, 10_000),
  };
}

// 文字 alias 的降级候选：上游分组调整后原模型可能整组下线（503 no available
// channel），此时换到运维在同一中转上已批准的型号。默认复用视觉模型清单。
export function relayTextFallbackModels(env = {}, requested, maximum = 3) {
  const configured = String(env.SIGNAL_TEXT_MODELS ?? env.SIGNAL_VISION_MODELS ?? '')
    .split(',').map(value => value.trim()).filter(Boolean);
  return relayCandidateModels({ SIGNAL_VISION_MODELS: configured.join(',') }, requested, maximum);
}

// 先试请求里点名的模型，再按配置顺序换模型；同名（忽略 models/ 前缀）只留一个。
export function relayCandidateModels(env = {}, requested, maximum = 4) {
  const configured = String(env.SIGNAL_VISION_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const models = [];
  const seen = new Set();
  for (const candidate of [requested, ...configured]) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const identity = candidate.replace(/^models\//, '');
    if (seen.has(identity)) continue;
    seen.add(identity);
    models.push(candidate);
    if (models.length >= maximum) break;
  }
  return models;
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedText(response, maximum) {
  const declared = response.headers?.get?.('content-length');
  if (typeof declared === 'string' && declared !== ''
    && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new Error('Vision relay response exceeds the size limit');
  }
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximum) throw new Error('Vision relay response exceeds the size limit');
    return text;
  }
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error('Vision relay response exceeds the size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

export async function readBoundedJson(response, maximum = MAX_RELAY_RESPONSE_BYTES) {
  const text = await readBoundedText(response, maximum);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Vision relay returned invalid JSON');
  }
}

const defaultSleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); });

// 返回最后一次上游结果；调用方据此决定是回写上游状态码还是自己兜底。
// 上游明确说"该模型没有可用通道"时，重试同一个模型只是浪费预算。
const NO_CHANNEL = /no available channel/i;

export async function relayUpstreamCompletion({
  endpoint, key, body, env = {}, fetchImpl = fetch, sleep = defaultSleep, now = Date.now,
  onRetry = () => {}, onFallback = () => {}, rotateModels = true,
} = {}) {
  if (typeof endpoint !== 'string' || endpoint === '') throw new Error('Vision relay needs an endpoint');
  if (typeof key !== 'string' || key === '' || /[\r\n]/.test(key)) throw new Error('Vision relay needs an API key');
  if (!plain(body) || !Array.isArray(body.messages)) throw new Error('Vision relay needs an OpenAI-compatible request body');
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function') {
    throw new Error('Vision relay needs a usable runtime');
  }
  const limits = visionRelayLimits(env);
  const requested = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;
  // 视觉按 SIGNAL_VISION_MODELS 轮换；文字只在运维批准的同组清单上降级，
  // 候选取自 SIGNAL_TEXT_MODELS（未配置时复用 SIGNAL_VISION_MODELS）。
  const models = rotateModels
    ? relayCandidateModels(env, requested)
    : (requested ? relayTextFallbackModels(env, requested) : []);
  if (models.length === 0) throw new Error('Vision relay needs a model');
  const deadline = now() + limits.budgetMs;
  let last = null;
  for (const model of models) {
    if (models.indexOf(model) > 0) onFallback({ from: models[models.indexOf(model) - 1], to: model, status: last?.status ?? 0 });
    for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
      if (attempt > 1 || last) {
        const wait = attempt > 1
          ? Math.min(limits.backoffMs * 2 ** (attempt - 2), 2_000)
          : limits.backoffMs;
        if (now() + wait > deadline) return { ...(last ?? { status: 504, payload: null }), model, attempts: attempt };
        await sleep(wait);
        if (now() > deadline) return { ...(last ?? { status: 504, payload: null }), model, attempts: attempt };
      }
      const controller = new AbortController();
      let expire;
      // 同时中断信号和显式竞速：即使某个 fetch 实现忽略 signal，卡死的通道
      // 也不能把整条回复拖到超时之外。
      const expired = new Promise((_, reject) => {
        expire = () => reject(Object.assign(new Error('Vision relay attempt timed out'), { name: 'AbortError' }));
      });
      expired.catch(() => {});
      const timer = setTimeout(() => { controller.abort(); expire(); }, limits.timeoutMs);
      let status = 0;
      let payload = null;
      try {
        const attempt = fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...body, model }),
        });
        // 竞速失败的一方也不会留下未处理的 rejection。
        attempt?.catch?.(() => {});
        const response = await Promise.race([attempt, expired]);
        status = Number(response?.status) || 0;
        const ok = Boolean(response?.ok);
        try {
          payload = await readBoundedJson(response);
        } catch {
          payload = null;
        }
        if (payload === null) status = ok ? 502 : status;
      } catch (error) {
        // 超时会立刻转成上游错误，避免同一个卡死的通道把整个预算耗尽。
        if (error?.name === 'AbortError') return { status: 504, payload: null, model, attempts: attempt, aborted: true };
        status = 0;
        payload = null;
      } finally {
        clearTimeout(timer);
      }
      if (payload !== null && status >= 200 && status < 300) return { status, payload, model, attempts: attempt };
      last = { status: status || 502, payload };
      if (!isRetryableVisionStatus(status)) return { ...last, model, attempts: attempt };
      onRetry({ model, attempt, status });
      // 该型号整组没有通道，换下一个候选而不是重复同一个。
      if (NO_CHANNEL.test(String(payload?.error?.message ?? ''))) break;
    }
  }
  return { ...(last ?? { status: 504, payload: null }), attempts: limits.attempts };
}

async function readRequestBody(request, maximum) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) {
    const error = new Error('Relay request body is too large');
    error.status = 413;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
  if (!plain(parsed) || !Array.isArray(parsed.messages)) {
    const error = new Error('Expected an OpenAI-compatible chat request');
    error.status = 400;
    throw error;
  }
  return parsed;
}

function relayJson(response, status, payload) {
  const text = JSON.stringify(payload ?? { error: { message: 'Vision relay failed', type: 'relay_error' } });
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(text);
}

// 上游端点解析：视觉 alias 用 SIGNAL_VISION_*，文字 alias 用 ZeroClaw relay 的同一份配置。
function upstreamEndpoint(base) {
  if (typeof base !== 'string' || base === '') return null;
  try {
    return new URL('/v1/chat/completions', new URL(base)).href;
  } catch {
    return null;
  }
}

function validKey(value) {
  return typeof value === 'string' && value !== '' && !/[\r\n]/.test(value);
}

function makeRoute({ path, endpoint, upstreamKey, token, env, deps, rotateModels, label }) {
  const { fetchImpl, sleep, now, log = console } = deps;
  return {
    path,
    endpoint,
    async handle(request, response) {
      // 网关进程在同容器内走 127.0.0.1；外部流量即使被平台代理成回环也会被下面的
      // Bearer 校验挡住，因此这里两层都保留。
      if (!LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress ?? '')) {
        request.resume?.();
        relayJson(response, 404, { error: { message: 'Not found' } });
        return;
      }
      if (request.method !== 'POST') {
        request.resume?.();
        relayJson(response, 405, { error: { message: 'Method not allowed' } });
        return;
      }
      const authorization = String(request.headers.authorization ?? '');
      if (!authorization.startsWith('Bearer ') || !sameToken(authorization.slice(7), token)) {
        request.resume?.();
        relayJson(response, 401, { error: { message: 'Unauthorized' } });
        return;
      }
      let body;
      try {
        body = await readRequestBody(request, MAX_RELAY_REQUEST_BYTES);
      } catch (error) {
        relayJson(response, error.status ?? 400, { error: { message: error.status ? 'Invalid relay request' : 'Relay unavailable' } });
        return;
      }
      let result;
      try {
        result = await relayUpstreamCompletion({
          endpoint, key: upstreamKey, body, env, fetchImpl, sleep, now, rotateModels,
          onRetry: ({ model, attempt, status }) => {
            log.info?.(JSON.stringify({ event: 'relay.retry', route: label, model, attempt, status, at: new Date().toISOString() }));
          },
          onFallback: ({ from, to, status }) => {
            log.info?.(JSON.stringify({ event: 'relay.fallback', route: label, from, to, status, at: new Date().toISOString() }));
          },
        });
      } catch {
        relayJson(response, 502, { error: { message: 'Relay unavailable', type: 'relay_error' } });
        return;
      }
      if (result.payload === null || result.payload === undefined) {
        relayJson(response, 502, { error: { message: 'Relay exhausted its retries', type: 'relay_error' } });
        return;
      }
      relayJson(response, result.status, result.payload);
    },
  };
}

// 未配置对应上游时不会生成路由，调用方不需要挂载任何东西。
export function createRelayRoutes(env = {}, deps = {}) {
  const routes = [];
  const visionBase = env.SIGNAL_VISION_BASE_URL;
  const visionKey = env.SIGNAL_VISION_API_KEY;
  const visionEndpoint = upstreamEndpoint(visionBase);
  if (visionEndpoint && validKey(visionKey)) {
    routes.push(makeRoute({
      path: RELAY_PATH, endpoint: visionEndpoint, upstreamKey: visionKey, env, deps, label: 'vision',
      rotateModels: true,
      token: validKey(env.SIGNAL_VISION_PROXY_TOKEN) ? env.SIGNAL_VISION_PROXY_TOKEN : visionKey,
    }));
  }
  const textBase = env[RELAY_UPSTREAM_URI];
  const textKey = env[RELAY_UPSTREAM_KEY];
  const textEndpoint = upstreamEndpoint(textBase);
  if (textEndpoint && validKey(textKey)) {
    routes.push(makeRoute({
      path: TEXT_RELAY_PATH, endpoint: textEndpoint, upstreamKey: textKey, token: textKey, env, deps,
      rotateModels: false, label: 'text',
    }));
  }
  return routes;
}
