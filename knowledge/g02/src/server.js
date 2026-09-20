import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sameToken } from './auth.js';
import { AsyncTtlCache } from './cache.js';
import { geoAccess, parseAllowedCountries } from './geo-access.js';
import { openOkxStorage } from './okx-storage.js';
import { MockOkxReadClient, OkxReadClient } from './okx-reader.js';
import { buildOverview, normalizeCopySettings } from './overview.js';
import { openSignalRuntime } from './signals/server.js';
import { createRelayRoutes } from './vision-relay.js';
import { intakeState, runtimeSummary } from './signals/runtime.js';
import { sendStaticAsset } from './static-assets.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public');
const tablerDir = join(root, 'node_modules', '@tabler', 'core', 'dist');
const port = Number(process.env.PORT ?? process.env.OKX_VIEWER_PORT ?? 8080);
const mockMode = process.env.OKX_MOCK === '1';
const username = process.env.OKX_VIEWER_USERNAME;
const password = process.env.OKX_VIEWER_PASSWORD;
const trustProxy = process.env.AUTH_TRUST_PROXY === '1';
const allowedCountries = parseAllowedCountries(process.env.AUTH_ALLOWED_COUNTRIES);
const countryHeaderName = (process.env.AUTH_COUNTRY_HEADER || 'CF-IPCountry').toLowerCase();
const secureCookie = process.env.AUTH_SECURE_COOKIE === '1'
  || (process.env.AUTH_SECURE_COOKIE !== '0' && process.env.NODE_ENV === 'production');
const sessionCookieName = secureCookie ? '__Host-okx_research_session' : 'okx_research_session';
const sessionTtlMs = Number(process.env.AUTH_SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1_000);
if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) throw new Error('AUTH_SESSION_TTL_MS must be a positive integer');

if (!mockMode && (!username || !password)) {
  throw new Error('OKX_VIEWER_USERNAME and OKX_VIEWER_PASSWORD are required');
}

if (!mockMode && password.length < 16) {
  throw new Error('OKX_VIEWER_PASSWORD must contain at least 16 characters');
}

if (allowedCountries.size > 0 && !trustProxy) {
  throw new Error('AUTH_TRUST_PROXY=1 is required when AUTH_ALLOWED_COUNTRIES is configured');
}

if (!/^[a-z0-9-]{1,64}$/.test(countryHeaderName)) {
  throw new Error('AUTH_COUNTRY_HEADER must be a valid HTTP header name');
}

const reader = mockMode ? new MockOkxReadClient() : OkxReadClient.fromEnv();
const storage = await openOkxStorage({
  authOptions: { username, password, sessionTtlMs },
  lifecycleOptions: {
    snapshotIntervalMs: Number(process.env.RESEARCH_SNAPSHOT_MS ?? 15_000),
    closeConfirmations: Number(process.env.RESEARCH_CLOSE_CONFIRMATIONS ?? 2),
  },
}).catch((error) => {
  console.error(error.safeToLog ? error.message : `OKX PostgreSQL 启动失败 (${error.code || 'CONNECTION_OR_CONFIG_ERROR'})`);
  process.exit(1);
});
const { auth, lifecycleStore } = storage;
const overviewCache = new AsyncTtlCache(Number(process.env.OKX_CACHE_MS ?? 8_000));
const settingsCaches = new Map();
const auditThrottle = new Map();
// 平台健康检查轮询频繁；入口状态最多每 5 秒读一次容器状态文件。
let intakeCache = { at: 0, value: 'unknown' };
async function intakeHealth() {
  if (Date.now() - intakeCache.at < 5_000) return intakeCache.value;
  let value = 'unknown';
  try { value = intakeState(await runtimeSummary(process.env)); }
  catch (error) {
    // 只在从正常转为异常时提示一次，避免健康检查轮询刷屏；不输出文件内容或凭据。
    if (intakeCache.value !== 'unknown') console.error('intake status unavailable: ' + (error?.name || 'Error'));
  }
  intakeCache = { at: Date.now(), value };
  return value;
}
const relayRoutes = new Map(createRelayRoutes(process.env).map(route => [route.path, route]));
const signalEnabled = process.env.SIGNAL_ENABLED === 'true';
const simulationPath = '/simulation';
let signalService = null, signalFailed = false, serverReady = false;
const simulationRequest = path => path === simulationPath || path.startsWith(simulationPath + '/');
const loginDestination = url => url.searchParams.get('next') === '/simulation/' ? '/simulation/' : '/';

const staticFiles = new Map([
  ['/', [join(publicDir, 'index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [join(publicDir, 'app.js'), 'text/javascript; charset=utf-8']],
  ['/workspace-navigation.js', [join(publicDir, 'workspace-navigation.js'), 'text/javascript; charset=utf-8']],
  ['/app.css', [join(publicDir, 'app.css'), 'text/css; charset=utf-8']],
  ['/workspace-nav.css', [join(publicDir, 'workspace-nav.css'), 'text/css; charset=utf-8']],
  ['/themes.js', [join(publicDir, 'themes.js'), 'text/javascript; charset=utf-8']],
  ['/themes.css', [join(publicDir, 'themes.css'), 'text/css; charset=utf-8']],
  ['/login', [join(publicDir, 'login.html'), 'text/html; charset=utf-8']],
  ['/login.js', [join(publicDir, 'login.js'), 'text/javascript; charset=utf-8']],
  ['/login.css', [join(publicDir, 'login.css'), 'text/css; charset=utf-8']],
  ['/access-denied.css', [join(publicDir, 'access-denied.css'), 'text/css; charset=utf-8']],
  ['/vendor/tabler/css/tabler.min.css', [join(tablerDir, 'css', 'tabler.min.css'), 'text/css; charset=utf-8']],
  ['/vendor/tabler/js/tabler.min.js', [join(tablerDir, 'js', 'tabler.min.js'), 'text/javascript; charset=utf-8']],
  ['/shared/tabler.min.css', [join(tablerDir, 'css', 'tabler.min.css'), 'text/css; charset=utf-8']],
  ...['themes.js', 'themes.css', 'app.css', 'workspace-nav.css', 'workspace-navigation.js'].map(file =>
    [`/shared/${file}`, [join(publicDir, file), `${file.endsWith('.js') ? 'text/javascript' : 'text/css'}; charset=utf-8`]]),
]);

function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    return key ? [[key, value]] : [];
  }));
}

function clientAddress(request) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first && first.trim().length <= 64) return first.trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function sessionToken(request) {
  return cookies(request)[sessionCookieName];
}

function sessionCookie(token, maxAgeSeconds) {
  const safeMaxAge = Math.max(0, Number(maxAgeSeconds) || 0);
  const parts = [
    `${sessionCookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${safeMaxAge}`,
    `Expires=${new Date(Date.now() + safeMaxAge * 1_000).toUTCString()}`,
  ];
  if (secureCookie) parts.push('Secure');
  return parts.join('; ');
}

function sameSiteRequest(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!request.headers.origin) return true;
  try { const origin = new URL(request.headers.origin); return ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host; }
  catch { return false; }
}

function securityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (secureCookie) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
}

function sendJson(response, status, body, headers = {}) {
  securityHeaders(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function redirect(response, location) {
  securityHeaders(response);
  response.writeHead(303, { Location: location });
  response.end();
}

async function sendFile(response, path, contentType, status = 200, request) {
  try {
    securityHeaders(response);
    if (request && status === 200 && /^text\/(?:css|javascript)/.test(contentType)) {
      await sendStaticAsset(request, response, path, contentType);
      return;
    }
    const body = await readFile(path);
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

function parseSettingsCode(pathname) {
  const match = pathname.match(/^\/api\/copy-settings\/([A-Za-z0-9]{1,64})$/);
  return match?.[1];
}

async function readJson(request) {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8_192) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) {
    const error = new Error('Request body is too large');
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
}

function audit(event, request, details = {}, throttleMs = 0) {
  const ip = clientAddress(request);
  const throttleKey = `${event}:${ip}:${details.country ?? ''}`;
  const now = Date.now();
  if (throttleMs > 0 && now - (auditThrottle.get(throttleKey) ?? 0) < throttleMs) return;
  if (throttleMs > 0) {
    if (auditThrottle.size >= 10_000) auditThrottle.clear();
    auditThrottle.set(throttleKey, now);
  }
  console.info(JSON.stringify({ event, ip, ...details, at: new Date(now).toISOString() }));
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');

  // 上游重试中转移位于登录/地理围栏之前：调用方是同容器的 ZeroClaw 进程，
  // 没有浏览器会话，鉴权靠回环来源 + Bearer 密钥（见 vision-relay.js）。
  const relay = relayRoutes.get(url.pathname);
  if (relay) {
    await relay.handle(request, response);
    return;
  }

  if (!storage.available) throw new Error('Database lease unavailable');

  if (url.pathname === '/healthz') {
    await storage.health();
    if (signalEnabled && (!signalService || (await signalService.health()).status !== 'ok')) throw new Error('Simulation service unavailable');
    // 只暴露粗粒度入口状态：远程就能判断截图入口是否真的启用，不会带出凭据或账号信息。
    sendJson(response, 200, signalEnabled ? { status: 'ok', intake: await intakeHealth() } : { status: 'ok' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/simulation/healthz') {
    if (signalService) await signalService.handleRequest(request, response);
    else sendJson(response, 503, { status: 'disabled', service: 'signal-research' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/access-denied.css') {
    await sendFile(response, ...staticFiles.get(url.pathname), 200, request);
    return;
  }

  // Automation tokens are scoped to the simulation routes; they never grant
  // access to live account data or the shared browser session.
  const simulationBearer = simulationRequest(url.pathname) && signalService && process.env.SIGNAL_API_TOKEN
    && request.headers.authorization?.startsWith('Bearer ')
    && sameToken(request.headers.authorization.slice(7), process.env.SIGNAL_API_TOKEN);
  const access = simulationBearer ? { allowed: true } : geoAccess(request, allowedCountries, countryHeaderName);
  if (!access.allowed) {
    audit('auth.geo_denied', request, { country: access.country ?? 'unknown' }, 60_000);
    if ((request.headers.accept ?? '').includes('text/html')) {
      await sendFile(response, join(publicDir, 'access-denied.html'), 'text/html; charset=utf-8', 404);
    } else {
      sendJson(response, 404, { error: 'Not found' });
    }
    return;
  }

  if (simulationRequest(url.pathname) && signalService) {
    if (url.pathname === simulationPath && request.method === 'GET') redirect(response, simulationPath + '/');
    else await signalService.handleRequest(request, response);
    return;
  }

  if (url.pathname === '/auth/login' && request.method === 'POST' && !mockMode) {
    if (!sameSiteRequest(request)) {
      sendJson(response, 403, { error: '无法登录' });
      return;
    }
    try {
      const body = await readJson(request);
      const result = await auth.login({
        username: body.username,
        password: body.password,
        ip: clientAddress(request),
      });
      if (!result.ok) {
        audit(result.status === 429 ? 'auth.login_blocked' : 'auth.login_failed', request);
        const headers = result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : {};
        sendJson(response, result.status, {
          error: '无法登录，请稍后重试',
          retryAfterSeconds: result.retryAfterSeconds,
        }, headers);
        return;
      }
      audit('auth.login_succeeded', request);
      sendJson(response, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(result.token, Math.floor((result.expiresAt - Date.now()) / 1_000)),
      });
    } catch (error) {
      sendJson(response, error.status ?? 503, { error: error.status ? '请求无效' : '服务暂时不可用，请稍后重试' });
    }
    return;
  }

  if (url.pathname === '/auth/logout' && request.method === 'POST' && mockMode) {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && ['/login', '/login.js', '/login.css', '/themes.js', '/themes.css', '/vendor/tabler/css/tabler.min.css'].includes(url.pathname)) {
    if (url.pathname === '/login' && (mockMode || await auth.session(sessionToken(request)))) {
      redirect(response, loginDestination(url));
      return;
    }
    await sendFile(response, ...staticFiles.get(url.pathname), 200, request);
    return;
  }

  const currentSession = mockMode ? { csrfToken: null, expiresAt: null } : await auth.session(sessionToken(request));
  if (!currentSession) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/simulation/api/')) {
      sendJson(response, 401, { error: 'Unauthorized' });
    } else {
      redirect(response, simulationRequest(url.pathname) ? '/login?next=%2Fsimulation%2F' : '/login');
    }
    return;
  }

  if (url.pathname === '/auth/logout' && request.method === 'POST' && !mockMode) {
    if (!sameSiteRequest(request) || !sameToken(request.headers['x-csrf-token'], currentSession.csrfToken)) {
      sendJson(response, 403, { error: '退出请求已被拒绝' });
      return;
    }
    await auth.revoke(sessionToken(request));
    audit('auth.logout', request);
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    return;
  }

  if (simulationRequest(url.pathname)) {
    if (request.method === 'GET' && ['/simulation', '/simulation/'].includes(url.pathname)) {
      await sendFile(response, join(publicDir, 'simulation-disabled.html'), 'text/html; charset=utf-8');
    } else sendJson(response, 503, { error: '模拟盘暂未启用，请完成模拟服务配置后重试' });
    return;
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendJson(response, 405, { error: 'Read-only service: only GET is allowed' });
    return;
  }

  if (url.pathname === '/api/session') {
    sendJson(response, 200, {
      username: mockMode ? 'mock' : username,
      csrfToken: currentSession.csrfToken,
      expiresAt: currentSession.expiresAt,
    });
    return;
  }

  if (url.pathname === '/api/research/lifecycles') {
    sendJson(response, 200, await lifecycleStore.list());
    return;
  }

  if (url.pathname === '/api/overview') {
    try {
      const data = await overviewCache.get(() => buildOverview(reader));
      try {
        await lifecycleStore.observe(data.copyPositions, {
          observedAt: Date.parse(data.updatedAt),
          sourceOk: data.sources.copyPositions.ok,
        });
      } catch {
        console.error(JSON.stringify({ event: 'research.persistence_failed', at: new Date().toISOString() }));
      }
      sendJson(response, 200, data);
    } catch {
      sendJson(response, 502, { error: '暂时无法读取 OKX 数据，请稍后重试' });
    }
    return;
  }

  const uniqueCode = parseSettingsCode(url.pathname);
  if (uniqueCode) {
    try {
      if (!settingsCaches.has(uniqueCode)) {
        settingsCaches.set(uniqueCode, new AsyncTtlCache(60_000));
      }
      const data = await settingsCaches
        .get(uniqueCode)
        .get(async () => normalizeCopySettings(await reader.getCopySettings(uniqueCode)));
      sendJson(response, 200, data);
    } catch {
      sendJson(response, 502, { error: '暂时无法读取该带单员的跟单设置' });
    }
    return;
  }

  const staticFile = staticFiles.get(url.pathname);
  if (staticFile) {
    await sendFile(response, ...staticFile, 200, request);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

if (signalEnabled) {
  if (mockMode) { await storage.close(); throw new Error('统一模拟盘入口需要主站登录，不能与 OKX_MOCK 共用'); }
  try {
    signalService = await openSignalRuntime(process.env, {
      basePath: simulationPath,
      browserAuth: { session: request => auth.session(sessionToken(request)), loginPath: '/login?next=%2Fsimulation%2F' },
      onFailure: () => { signalFailed = true; if (serverReady) shutdown(1); },
    });
    if (signalFailed) throw new Error('Simulation lease lost during startup');
    console.log(`Signal research mounted on :${port}${simulationPath}/ (okx-demo; shared login)`);
  } catch (error) {
    await signalService?.close(); await storage.close();
    console.error(error.status ? error.message : '统一模拟盘启动失败，请检查模拟账户与数据库配置');
    process.exit(1);
  }
}

const server = createServer({
  maxHeaderSize: 16 * 1_024,
  headersTimeout: 10_000,
  requestTimeout: 15_000,
  keepAliveTimeout: 5_000,
}, (request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.headersSent) sendJson(response, 503, { error: '服务暂时不可用，请稍后重试' });
    else response.destroy();
  });
});
serverReady = true;

server.listen(port, mockMode ? '127.0.0.1' : '0.0.0.0', () => {
  for (const path of relayRoutes.keys()) console.log('Upstream retry relay mounted on ' + path + ' (loopback only)');
  console.log(`OKX copy research dashboard listening on :${port} (${mockMode ? 'mock' : 'live'}, PostgreSQL, read-only)`);
});

const cleanupTimer = auth ? setInterval(() => {
  auth.cleanup().catch(() => console.error('okx.session_cleanup_failed'));
}, 5 * 60 * 1_000).unref() : null;

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  const deadline = setTimeout(() => process.exit(1), 15_000).unref();
  const stopped = new Promise(resolve => server.close(resolve));
  Promise.all([stopped, signalService?.close()]).then(async () => {
    await storage.close(); clearTimeout(deadline); process.exit(code);
  }).catch(() => process.exit(1));
}
storage.onFailure = () => { console.error('okx.database_lease_lost'); shutdown(1); };
server.on('error', () => shutdown(1));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown());
