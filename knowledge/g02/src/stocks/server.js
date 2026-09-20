import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sameToken } from '../auth.js';
import { StockAuth } from './auth.js';
import { createPool } from './database.js';
import { StockStore, badRequest } from './store.js';
import { StockMonitor } from './monitor.js';

const root = new URL('../../', import.meta.url);
const files = new Map([
  ['/', ['public/stocks/index.html', 'text/html']], ['/login', ['public/stocks/login.html', 'text/html']],
  ['/stock.js', ['public/stocks/app.js', 'text/javascript']], ['/stock.css', ['public/stocks/app.css', 'text/css']],
  ['/themes.js', ['public/themes.js', 'text/javascript']], ['/themes.css', ['public/themes.css', 'text/css']],
  ['/login.js', ['public/login.js', 'text/javascript']], ['/login.css', ['public/login.css', 'text/css']],
  ['/vendor/tabler/css/tabler.min.css', ['node_modules/@tabler/core/dist/css/tabler.min.css', 'text/css']],
]);
const publicPaths = new Set(['/login', '/themes.js', '/themes.css', '/login.js', '/login.css', '/vendor/tabler/css/tabler.min.css']);

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw badRequest('需要 JSON 请求', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw badRequest('请求内容过长', 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw badRequest('请求格式不正确'); }
}

function sameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return ['http:', 'https:'].includes(new URL(origin).protocol) && new URL(origin).host === request.headers.host; }
  catch { return false; }
}

export async function createStockService({ pool, username, password, demo = false, secureCookie = false,
  trustProxy = false, intervalMs = 60_000, webhookUrl = '', quoteFetcher, startMonitor = true }) {
  if (!demo && (!username || !password || password.length < 16)) throw new Error('请配置 STOCK_VIEWER_USERNAME 和至少 16 位的 STOCK_VIEWER_PASSWORD');
  const store = new StockStore(pool);
  await store.initialize();
  // A persistent advisory lock enforces one scheduler/dispatcher per database.
  const lease = await pool.connect();
  const acquired = (await lease.query("SELECT pg_try_advisory_lock(hashtext('stock-watch-worker')) AS acquired")).rows[0].acquired;
  if (!acquired) { lease.release(); throw new Error('同一数据库已有 A 股服务运行，请保持单副本'); }
  try {
    const mode = demo ? 'demo' : 'live';
    const previous = (await pool.query("SELECT value FROM stock_watch.meta WHERE key='mode'")).rows[0];
    if (previous && previous.value !== mode) throw new Error('模拟和真实服务需要使用不同数据库');
    await pool.query("INSERT INTO stock_watch.meta VALUES('mode',$1) ON CONFLICT(key) DO NOTHING", [mode]);
    const auth = demo ? null : new StockAuth(pool, { username, password });
    if (auth) await auth.initialize();
    const demoSession = { csrfToken: randomUUID(), expiresAt: null };
    const monitor = new StockMonitor(store, { demo, intervalMs, webhookUrl, quoteFetcher });
    const cookieName = secureCookie ? '__Host-stock_watch_session' : 'stock_watch_session';
    function token(request) {
      return (request.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    }
    function cookie(value, age) {
      return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}; Expires=${new Date(Date.now() + age * 1000).toUTCString()}${secureCookie ? '; Secure' : ''}`;
    }
    const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (secureCookie) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const json = (status, value, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); response.end(JSON.stringify(value)); };
      const redirect = (location) => { response.writeHead(303, { Location: location }); response.end(); };
      const sendFile = async (path) => {
        const [file, type] = files.get(path);
        const content = await readFile(new URL(file, root));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(content);
      };
      try {
        const path = new URL(request.url, 'http://localhost').pathname;
        if (path === '/healthz' && request.method === 'GET') {
          await pool.query('SELECT 1'); json(200, { status: 'ok', service: 'stock-watch' }); return;
        }
        if (request.method === 'POST' && path === '/auth/login') {
          if (!sameOrigin(request)) throw badRequest('登录请求已拒绝', 403);
          if (!auth) { json(200, { ok: true }); return; }
          const input = await body(request);
          const ip = trustProxy ? (request.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64) : request.socket.remoteAddress;
          const result = await auth.login({ username: input.username, password: input.password, ip: ip || 'unknown' });
          if (!result.ok) { json(result.status, { error: '无法登录，请稍后重试' }, result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : {}); return; }
          json(200, { ok: true }, { 'Set-Cookie': cookie(result.token, Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000))) }); return;
        }
        if (request.method === 'GET' && publicPaths.has(path)) {
          if (path === '/login' && (demo || await auth.session(token(request)))) redirect('/');
          else await sendFile(path);
          return;
        }
        const session = demo ? demoSession : await auth.session(token(request));
        if (!session) {
          if (path.startsWith('/api/') || path.startsWith('/auth/')) json(401, { error: '请重新登录' });
          else redirect('/login');
          return;
        }
        if (!['GET', 'HEAD'].includes(request.method) && (!sameOrigin(request) || !sameToken(request.headers['x-csrf-token'], session.csrfToken))) throw badRequest('请求已拒绝，请刷新页面后重试', 403);
        if (request.method === 'GET' && path === '/api/session') { json(200, session); return; }
        if (request.method === 'GET' && path === '/api/dashboard') {
          const [stocks, alerts, plan] = await Promise.all([store.list(), store.alerts(), store.plan()]);
          json(200, { stocks, alerts, plan, monitor: monitor.status(), serverTime: new Date().toISOString() }); return;
        }
        if (request.method === 'POST' && path === '/auth/logout') {
          if (auth) await auth.revoke(token(request));
          json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return;
        }
        if (request.method === 'POST' && path === '/api/refresh') { await monitor.refresh(true); json(200, { ok: !monitor.error, monitor: monitor.status() }); return; }
        if (request.method === 'POST' && path === '/api/stocks') { await store.add(await body(request)); json(201, { ok: true }); return; }
        if (request.method === 'PUT' && path === '/api/plan') { await store.savePlan(await body(request)); json(200, { ok: true }); return; }
        const stockMatch = /^\/api\/stocks\/((?:sh|sz|bj)\d{6})$/.exec(path);
        if (request.method === 'PUT' && stockMatch) { await store.save(stockMatch[1], await body(request)); json(200, { ok: true }); return; }
        const ruleMatch = /^\/api\/rules\/([0-9a-f-]{36})\/rearm$/.exec(path);
        if (request.method === 'POST' && ruleMatch) { await store.rearm(ruleMatch[1]); json(200, { ok: true }); return; }
        const alertMatch = /^\/api\/alerts\/([0-9a-f-]{36})\/handle$/.exec(path);
        if (request.method === 'POST' && alertMatch) { await store.handleAlert(alertMatch[1]); json(200, { ok: true }); return; }
        if (request.method === 'GET' && files.has(path)) { await sendFile(path); return; }
        json(404, { error: '未找到内容' });
      } catch (error) {
        if (!response.headersSent) json(error.status || 503, { error: error.status ? error.message : '服务暂时不可用，请稍后重试' });
      }
    });
    lease.on('error', () => { monitor.stop().catch(() => {}); server.close(); });
    if (startMonitor) monitor.start();
    return { server, store, monitor, close: async () => {
      await monitor.stop();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await lease.query("SELECT pg_advisory_unlock(hashtext('stock-watch-worker'))");
      lease.release();
    } };
  } catch (error) {
    await lease.query("SELECT pg_advisory_unlock(hashtext('stock-watch-worker'))");
    lease.release(); throw error;
  }
}

export async function main() {
  const demo = process.env.STOCK_DEMO === '1';
  const production = process.env.NODE_ENV === 'production';
  if (production && demo) throw new Error('生产环境不能运行模拟模式');
  const raw = demo
    ? process.env.STOCK_DEMO_DATABASE_URL || 'postgresql://stockdev:local-stock-preview-only@127.0.0.1:15432/stock_watch_dev'
    : process.env.STOCK_DATABASE_URL || process.env.EXTERNAL_JDBC_POSTGRES_URI_ADMIN;
  // The shared .env may contain PORT=8080 for OKX. Never inherit that port.
  const port = Number(process.env.STOCK_PORT || 8081);
  const intervalMs = Number(process.env.STOCK_POLL_MS || 60_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STOCK_PORT 配置不正确');
  if (!Number.isInteger(intervalMs) || intervalMs < 30_000 || intervalMs > 300_000) throw new Error('STOCK_POLL_MS 应在 30000～300000 毫秒之间');
  const webhookUrl = process.env.STOCK_WEBHOOK_URL || '';
  if (webhookUrl && new URL(webhookUrl).protocol !== 'https:') throw new Error('STOCK_WEBHOOK_URL 需要使用 HTTPS');
  const pool = createPool(raw);
  pool.on('error', () => console.error('stock.database_connection_lost'));
  try {
    const service = await createStockService({ pool, demo, username: process.env.STOCK_VIEWER_USERNAME,
      password: process.env.STOCK_VIEWER_PASSWORD, secureCookie: production || process.env.STOCK_SECURE_COOKIE === '1',
      trustProxy: process.env.STOCK_TRUST_PROXY === '1', intervalMs, webhookUrl });
    service.server.listen(port, demo || !production ? '127.0.0.1' : '0.0.0.0', () => console.log(`Stock watch listening on :${port} (${demo ? 'demo' : 'live'})`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.close(); await pool.end(); process.exit(0); });
  } catch (error) { await pool.end(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Connection errors may contain credentials, hostnames or SQL. Keep startup
    // output restricted to our configuration messages and error codes.
    console.error(error.message.startsWith('请配置') || /配置不正确|需要使用|不能运行|应在|需要 PostgreSQL|已有 A 股|不同数据库/.test(error.message)
      ? error.message : `A 股服务启动失败 (${error.code || 'CONNECTION_OR_CONFIG_ERROR'})`);
    process.exitCode = 1;
  });
}
