import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const localFile = '.env.signals.local';
const demoKeys = ['SIGNAL_OKX_DEMO_API_KEY', 'SIGNAL_OKX_DEMO_API_SECRET', 'SIGNAL_OKX_DEMO_API_PASSPHRASE'];

async function readEnv(path, optional = false) {
  try { return parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return {}; throw new Error(`无法读取 ${path}`); }
}

export async function initializeLocalConfig(directory = root) {
  const path = resolve(directory, localFile);
  const values = {
    SIGNAL_LOCAL_PORT: '8082',
    SIGNAL_LOCAL_DB_PASSWORD: randomBytes(24).toString('hex'),
    SIGNAL_VIEWER_USERNAME: 'signalresearch',
    SIGNAL_VIEWER_PASSWORD: randomBytes(24).toString('base64url'),
    SIGNAL_API_TOKEN: randomBytes(32).toString('base64url'),
  };
  try {
    await writeFile(path, '# 本地模拟服务专用；保留此文件和 Docker 数据卷，重启后继续使用原账本及登录。\n'
      + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw new Error(`无法创建 ${path}`); }
  return path;
}

export async function localEnvironment(directory = root, inherited = process.env) {
  const project = { ...await readEnv(resolve(directory, '.env'), true), ...inherited };
  const local = await readEnv(resolve(directory, localFile));
  const port = Number(local.SIGNAL_LOCAL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${localFile} 中 SIGNAL_LOCAL_PORT 必须是有效端口`);
  if (!/^[a-f0-9]{48}$/.test(local.SIGNAL_LOCAL_DB_PASSWORD || '')) throw new Error(`${localFile} 中数据库密码格式不正确，请保留初始化值`);
  if (!local.SIGNAL_VIEWER_USERNAME || (local.SIGNAL_VIEWER_PASSWORD || '').length < 16 || (local.SIGNAL_API_TOKEN || '').length < 32) {
    throw new Error(`${localFile} 中看板账号、密码或工具令牌不完整`);
  }
  // Compose receives only dedicated configuration; dashboard/live credentials
  // and ambient Compose overrides cannot select another file, service or mode.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(SIGNAL_|OKX_|COMPOSE_)/.test(key)));
  for (const key of ['SIGNAL_LOCAL_PORT', 'SIGNAL_LOCAL_DB_PASSWORD', 'SIGNAL_VIEWER_USERNAME', 'SIGNAL_VIEWER_PASSWORD', 'SIGNAL_API_TOKEN']) env[key] = local[key];
  for (const key of demoKeys) if (project[key]) env[key] = project[key];
  env.SIGNAL_OKX_MARKET = project.SIGNAL_OKX_MARKET || 'OPENAPI_GLOBAL';
  env.COMPOSE_DISABLE_ENV_FILE = '1';
  return env;
}

export function composeArguments(directory, args) {
  const project = 'signal-demo-' + createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 10);
  return ['compose', '--project-name', project, '--project-directory', directory, '--env-file', '/dev/null', '-f', resolve(directory, 'compose.signals.yaml'), ...args];
}

async function compose(env, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn('docker', composeArguments(root, args), { cwd: root, env, stdio: 'inherit' });
    child.once('error', () => reject(new Error('无法启动 Docker，请确认 Docker Desktop 已运行')));
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error('Docker 操作失败，请检查上方服务状态')));
  });
}

async function status(env) {
  const url = `http://127.0.0.1:${env.SIGNAL_LOCAL_PORT}`;
  let dashboard;
  try {
    const response = await fetch(`${url}/api/dashboard`, {
      headers: { Authorization: `Bearer ${env.SIGNAL_API_TOKEN}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new Error();
    dashboard = await response.json();
  } catch { throw new Error(`无法读取本地服务状态：${url}；可运行 npm run signals:local -- up`); }
  if (dashboard.mode !== 'okx-demo') throw new Error('本地端口上的服务不是 OKX 模拟盘，请核对端口');
  console.log(`看板：${url}`);
  console.log(`模式：OKX 模拟盘；方向任务：${dashboard.tasks.length}；策略持仓：${dashboard.tasks.filter(t => t.position).length}`);
  console.log(`调度：${dashboard.monitor.error || (dashboard.monitor.lastSuccessAt ? '正常' : '等待首次账户对账')}`);
  console.log(`登录账号和密码保存在 ${resolve(root, localFile)}`);
  if (dashboard.monitor.error || !dashboard.monitor.running) throw new Error('策略调度尚未就绪，请在看板查看详情');
}

export async function main(action = process.argv[2] || 'up') {
  if (!['init', 'up', 'status', 'restart', 'down'].includes(action)) throw new Error('用法：npm run signals:local -- init|up|status|restart|down');
  if (action === 'init' || action === 'up') await initializeLocalConfig();
  if (action === 'init') { console.log(`本地配置已就绪：${resolve(root, localFile)}（已有值会保留）`); return; }
  const env = await localEnvironment();
  for (const key of demoKeys) {
    if (env[key]) continue;
    if (action === 'up' || action === 'restart') throw new Error(`请在 .env 配置 ${key}（模拟盘专用）`);
    env[key] = 'unused'; // Stopping or inspecting containers does not need exchange credentials.
  }
  if (action === 'down') { await compose(env, ['down']); console.log('本地服务已停止；数据库卷与登录配置保留。'); return; }
  if (action === 'up') await compose(env, ['up', '--build', '--detach', '--wait', '--wait-timeout', '90']);
  if (action === 'restart') await compose(env, ['up', '--detach', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '90', 'signals']);
  if (action === 'status') await compose(env, ['ps']);
  await status(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
