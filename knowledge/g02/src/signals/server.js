import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { sameToken } from '../auth.js';
import { createPostgresPool } from '../postgres.js';
import { SignalAuth } from './auth.js';
import { SignalStore, badRequest, LIMITS } from './store.js';
import { SignalMonitor } from './monitor.js';
import { SignalMarket, signalMarketRegion } from './market.js';
import { DemoExecutor } from './executor.js';
import { analyzeFrame } from './analysis.js';
import { runtimeSummary } from './runtime.js';
import { sendStaticAsset } from '../static-assets.js';

const files = new Map([
  ['/', ['index.html', 'text/html']], ['/login', ['login.html', 'text/html']],
  ['/signal.js', ['app.js', 'text/javascript']], ['/signal.css', ['app.css', 'text/css']],
  ['/login.js', ['login.js', 'text/javascript']], ['/login.css', ['login.css', 'text/css']],
  ['/shared/tabler.min.css', ['../../node_modules/@tabler/core/dist/css/tabler.min.css', 'text/css']],
  ...['themes.js', 'themes.css', 'app.css', 'workspace-nav.css', 'workspace-navigation.js'].map(file =>
    [`/shared/${file}`, [`../${file}`, file.endsWith('.js') ? 'text/javascript' : 'text/css']]),
]);
const publicPaths = new Set(['/login', '/login.js', '/login.css', '/signal.css']);
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try { const url = new URL(req.headers.origin); return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host; } catch { return false; }
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw badRequest('需要 JSON 请求', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw badRequest('请求内容过长', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw badRequest('请求格式不正确'); }
}
export async function createSignalService({ pool, mode = 'paper', username, password, apiToken = '', secureCookie = false,
  trustProxy = false, market, executor, intervalMs = 5000, startMonitor = true, accountBinding = '',
  basePath = '', browserAuth = null, onFailure = null, runtimeStatus = null }) {
  if (basePath && !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(basePath)) throw badRequest('方向策略路径配置不正确');
  if (browserAuth && (typeof browserAuth.session !== 'function' || !/^\/(?!\/)/.test(browserAuth.loginPath || ''))) throw badRequest('共享登录配置不正确');
  if (!browserAuth && (!username || !password || password.length < 16)) throw badRequest('请配置 SIGNAL_VIEWER_USERNAME 和至少 16 位的 SIGNAL_VIEWER_PASSWORD');
  if (apiToken && apiToken.length < 32) throw badRequest('SIGNAL_API_TOKEN 至少 32 位');
  if (!['paper', 'okx-demo'].includes(mode)) throw badRequest('SIGNAL_MODE 只支持 paper 或 okx-demo');
  if (!executor || executor.mode !== mode || typeof executor.execute !== 'function' || typeof executor.reconcile !== 'function') {
    throw badRequest('执行器必须与 SIGNAL_MODE 一致');
  }
  if (!market || typeof market.frame !== 'function') throw badRequest('方向策略行情源配置不正确');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 30_000) throw badRequest('SIGNAL_POLL_MS 必须在 1000～30000 之间');
  let accountId = '';
  if (mode === 'okx-demo') {
    if (!(executor instanceof DemoExecutor)) throw badRequest('OKX 模拟盘必须使用内置 DemoExecutor');
    if (!/^[a-f0-9]{64}$/.test(accountBinding)) throw badRequest('OKX 模拟盘必须配置独立账户绑定');
    if (typeof executor.preflight !== 'function' || typeof executor.inventory !== 'function') throw badRequest('OKX 模拟盘执行器不完整');
    executor.assertDemo();
    const preflight = await executor.preflight();
    accountId = typeof preflight?.accountId === 'string' ? preflight.accountId.trim() : '';
    if (preflight?.mode !== mode || !accountId) throw badRequest('OKX 模拟盘账户身份预检失败');
  }
  const store = new SignalStore(pool, mode);
  await store.initialize({ credential: accountBinding, accountId });
  const lease = await pool.connect();
  const acquired = (await lease.query("SELECT pg_try_advisory_lock(hashtext('signal-research-worker')) AS acquired")).rows[0].acquired;
  if (!acquired) { lease.release(); throw badRequest('同一数据库已有方向策略服务运行，请保持单副本'); }
  let monitor, auth, server, heartbeat, leaseLost = false;
  const loseLease = () => {
    if (leaseLost) return;
    leaseLost = true; monitor?.loseLease(); if (server?.listening) server.close();
    onFailure?.(new Error('方向策略数据库调度锁已断开'));
  };
  lease.on('error', loseLease);
  try {
    if (!browserAuth) { auth = new SignalAuth(pool, { username, password }); await auth.initialize(); }
    monitor = new SignalMonitor(store, { mode, market, executor, intervalMs });
    executor.setSubmissionGuard?.(() => monitor.leaseValid && !monitor.stopped);
    const cookieName = secureCookie ? '__Host-signal_research_session' : 'signal_research_session';
    const cookieToken = req => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}; Expires=${new Date(Date.now() + age * 1000).toUTCString()}${secureCookie ? '; Secure' : ''}`;
    const health = async () => {
      try { await lease.query('SELECT 1'); } catch { loseLease(); }
      const healthy = !leaseLost && monitor.status().running;
      return { status: healthy ? 'ok' : 'unavailable', service: 'signal-research', mode };
    };
    const handleRequest = async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
      if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); };
      const redirect = location => { res.writeHead(303, { Location: location }); res.end(); };
      const sendFile = async path => {
        const [file, type] = files.get(path);
        const fileUrl = new URL(`../../public/signals/${file}`, import.meta.url);
        if (type !== 'text/html') { await sendStaticAsset(req, res, fileUrl, `${type}; charset=utf-8`); return; }
        let contents = await readFile(fileUrl, 'utf8');
        // Mounted pages share the live workspace's exact asset URLs and cache.
        if (browserAuth && basePath) contents = contents.replaceAll('"./shared/', '"/shared/');
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(contents);
      };
      try {
        const requestUrl = new URL(req.url, 'http://localhost');
        const pathname = requestUrl.pathname;
        if (basePath && pathname !== basePath && !pathname.startsWith(basePath + '/')) { json(404, { error: '未找到内容' }); return; }
        const path = (basePath ? pathname.slice(basePath.length) : pathname) || '/';
        if (req.method === 'GET' && path === '/healthz') { const result = await health(); json(result.status === 'ok' ? 200 : 503, result); return; }
        if (browserAuth && ['/auth/login', '/auth/logout'].includes(path)) { json(404, { error: '请使用统一登录入口' }); return; }
        if (browserAuth && path === '/login') { redirect(browserAuth.loginPath); return; }
        if (req.method === 'POST' && path === '/auth/login') {
          if (!sameOrigin(req)) throw badRequest('登录请求已拒绝', 403);
          const input = await body(req);
          const ip = trustProxy ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64) : req.socket.remoteAddress;
          const result = await auth.login({ username: input.username, password: input.password, ip: ip || 'unknown' });
          if (!result.ok) { json(result.status, { error: '无法登录，请稍后重试' }, result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : {}); return; }
          json(200, { ok: true }, { 'Set-Cookie': cookie(result.token, Math.floor((result.expiresAt - Date.now()) / 1000)) }); return;
        }
        if (req.method === 'GET' && publicPaths.has(path) && (!browserAuth || path === '/signal.css')) { await sendFile(path); return; }
        const bearer = Boolean(apiToken && req.headers.authorization?.startsWith('Bearer ') && sameToken(req.headers.authorization.slice(7), apiToken));
        const session = bearer ? { serviceToken: true } : await (browserAuth ? browserAuth.session(req) : auth.session(cookieToken(req)));
        if (!session) { if (path.startsWith('/api/') || path.startsWith('/auth/')) json(401, { error: '请重新登录' }); else redirect(browserAuth?.loginPath || `${basePath}/login`); return; }
        if (!['GET', 'HEAD'].includes(req.method) && (!sameOrigin(req) || (!bearer && !sameToken(req.headers['x-csrf-token'], session.csrfToken)))) throw badRequest('请求已拒绝，请刷新页面后重试', 403);
        if (req.method === 'GET' && path === '/api/session') { json(200, session); return; }
        if (req.method === 'POST' && path === '/auth/logout') { if (!bearer) await auth.revoke(cookieToken(req)); json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return; }
        if (req.method === 'GET' && path === '/api/dashboard') {
          // Optional status files must not serialize or indefinitely block the dashboard.
          let statusTimeout;
          const status = runtimeStatus ? Promise.race([
            Promise.resolve().then(runtimeStatus).catch(() => null),
            new Promise(resolve => { statusTimeout = setTimeout(() => resolve(null), 1000); }),
          ]).finally(() => clearTimeout(statusTimeout)) : null;
          const [tasks, events, runtime] = await Promise.all([store.list(), store.events(), status]);
          const realizedPnl = tasks.reduce((sum, t) => sum + (t.rounds || []).reduce((s, r) => s + Number(r.netPnl || 0), 0), 0);
          json(200, { mode, tasks, events, limits: LIMITS, monitor: monitor.status(), summary: { initialEquity: LIMITS.initialEquity, realizedPnl, equity: LIMITS.initialEquity + realizedPnl }, runtime, serverTime: new Date().toISOString() }); return;
        }
        if (req.method === 'POST' && path === '/api/refresh') { await monitor.refresh(); json(200, { ok: !monitor.error, monitor: monitor.status() }); return; }
        if (req.method === 'GET' && path === '/api/analysis') {
          const instId = requestUrl.searchParams.get('instId');
          if (!/^[A-Z0-9]{2,20}-USDT-SWAP$/.test(instId || '') || [...requestUrl.searchParams.keys()].some(key => key !== 'instId') || requestUrl.searchParams.getAll('instId').length !== 1) throw badRequest('需要准确的 USDT 永续合约代码');
          json(200, analyzeFrame(await market.frame(instId), { mode })); return;
        }
        if (req.method === 'POST' && path === '/api/tasks') {
          const input = await body(req);
          if (Object.keys(input).some(k => !['sourceId', 'sourceText', 'source', 'instId', 'direction', 'expiresAt', 'config'].includes(k))) throw badRequest('包含不支持的方向任务字段');
          const result = await monitor.exclusive(() => store.create(input)); json(result.duplicate ? 200 : 201, result); return;
        }
        const analysisMatch = /^\/api\/tasks\/([0-9a-f-]{36})\/analysis$/i.exec(path);
        if (req.method === 'GET' && analysisMatch) {
          const task = await store.get(analysisMatch[1]);
          let frame;
          try { frame = await market.frame(task.instId); }
          catch (error) { if (!task.position || !market.quote) throw error; frame = await market.quote(task.instId); }
          json(200, analyzeFrame(frame, { task, mode })); return;
        }
        const match = /^\/api\/tasks\/([0-9a-f-]{36})$/i.exec(path);
        if (req.method === 'GET' && match) { const task = await store.get(match[1]); json(200, { task, events: await store.events(task.id), orders: await store.orders(task.id) }); return; }
        if (req.method === 'PATCH' && match) { const input = await body(req); if (Object.keys(input).some(k => k !== 'action')) throw badRequest('仅支持 action 字段'); json(200, { task: await monitor.control(match[1], input.action) }); return; }
        if (req.method === 'GET' && files.has(path)) { await sendFile(path); return; }
        json(404, { error: '未找到内容' });
      } catch (error) { if (!res.headersSent) json(error.status || 503, { error: error.status ? error.message : '服务暂时不可用，请稍后重试' }); }
    };
    server = createServer({ maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000 }, handleRequest);
    // Detect a lost lease even without API traffic. No replacement connection owns this lock.
    heartbeat = setInterval(() => lease.query('SELECT 1').catch(loseLease), 5000).unref();
    if (startMonitor) monitor.start();
    let closed = false;
    return { server, handleRequest, health, store, monitor, close: async () => {
      if (closed) return; closed = true; clearInterval(heartbeat);
      await monitor.stop(); if (server.listening) await new Promise(resolve => server.close(resolve));
      auth?.verifier.close();
      if (!leaseLost) await lease.query("SELECT pg_advisory_unlock(hashtext('signal-research-worker'))").catch(() => {});
      lease.release(leaseLost);
    } };
  } catch (error) { clearInterval(heartbeat); auth?.verifier.close(); await lease.query("SELECT pg_advisory_unlock(hashtext('signal-research-worker'))").catch(() => {}); lease.release(leaseLost); throw error; }
}

export async function openSignalRuntime(env = process.env, options = {}) {
  // Deployments default to the OKX demo account; paper remains available for isolated tests.
  const mode = env.SIGNAL_MODE || 'okx-demo';
  if (mode !== 'okx-demo') throw badRequest('部署服务仅支持 SIGNAL_MODE=okx-demo；paper 仅供自动化测试');
  const databaseUrl = env.SIGNAL_DATABASE_URL || env.EXTERNAL_JDBC_POSTGRES_URI_ADMIN;
  if (!databaseUrl) throw badRequest('请配置 SIGNAL_DATABASE_URL 或 EXTERNAL_JDBC_POSTGRES_URI_ADMIN');
  const marketRegion = signalMarketRegion(env.SIGNAL_OKX_MARKET);
  // The process entrypoint is intentionally demo-only. PaperExecutor remains available
  // through the test-oriented factory, never through the deployed server command.
  const executor = DemoExecutor.fromEnv({
    SIGNAL_MODE: mode,
    SIGNAL_OKX_DEMO_API_KEY: env.SIGNAL_OKX_DEMO_API_KEY,
    SIGNAL_OKX_DEMO_API_SECRET: env.SIGNAL_OKX_DEMO_API_SECRET,
    SIGNAL_OKX_DEMO_API_PASSPHRASE: env.SIGNAL_OKX_DEMO_API_PASSPHRASE,
    SIGNAL_OKX_MARKET: marketRegion,
  });
  const market = new SignalMarket({ market: marketRegion });
  const pool = createPostgresPool(databaseUrl, 'signal-research');
  pool.on('error', () => console.error('signal.database_connection_lost'));
  try {
    const service = await createSignalService({ pool, mode, market, executor, username: env.SIGNAL_VIEWER_USERNAME,
      password: env.SIGNAL_VIEWER_PASSWORD, apiToken: env.SIGNAL_API_TOKEN,
      accountBinding: mode === 'okx-demo' ? createHash('sha256').update(`${marketRegion}:${env.SIGNAL_OKX_DEMO_API_KEY}`).digest('hex') : '',
      intervalMs: Number(env.SIGNAL_POLL_MS || 5000), secureCookie: env.NODE_ENV === 'production' || env.SIGNAL_SECURE_COOKIE === '1', trustProxy: env.SIGNAL_TRUST_PROXY === '1',
      basePath: options.basePath, browserAuth: options.browserAuth, onFailure: options.onFailure,
      runtimeStatus: options.runtimeStatus || (() => runtimeSummary(env)) });
    let closing;
    const close = () => closing ||= (async () => { try { await service.close(); } finally { await pool.end(); } })();
    return { ...service, close };
  } catch (error) { await pool.end(); throw error; }
}

export async function main(env = process.env) {
  const port = Number(env.SIGNAL_PORT || 8082);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('SIGNAL_PORT 配置不正确');
  const host = env.SIGNAL_HOST || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  if (!isIP(host)) throw badRequest('SIGNAL_HOST 必须为有效 IP 地址');
  const service = await openSignalRuntime(env);
  service.server.listen(port, host, () => console.log(`Signal research listening on ${host}:${port} (okx-demo)`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.status ? error.message : '方向策略服务启动失败，请检查专用配置和连接'); process.exitCode = 1;
});
