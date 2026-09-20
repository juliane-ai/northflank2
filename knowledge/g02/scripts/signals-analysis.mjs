import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { composeArguments, localEnvironment } from './signals-local.mjs';
import { analysisPrompt, collectAnalysisEvidence, validateAnalysisReview, renderAnalysisReport } from '../src/signals/report.js';
import { relayKeys, signalRuntime, signalDataRoot, signalServiceEnvironment, nativeAgentEnvironment } from './signals-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = 'signal-analysis-agent:local';

export function analysisEnvironment(project, local) {
  for (const key of relayKeys) if (!project[key]) throw new Error(`请在 .env 配置 ${key}`);
  return { ...Object.fromEntries(relayKeys.map(key => [key, project[key]])),
    SIGNAL_SERVICE_URL: 'http://127.0.0.1:8082', SIGNAL_API_TOKEN: local.SIGNAL_API_TOKEN,
    SIGNAL_MCP_READ_ONLY: '1', SIGNAL_MCP_AUDIT_PATH: '/reports/tool-calls.jsonl',
    ZEROCLAW_DATA_DIR: '/tmp/signal-analysis/data' };
}

export function captureProcess(command, args, { env = process.env, timeout = 300_000, limit = 2_000_000, killDelay = 2000,
  cwd = root, processGroup = false, signal } = {}) {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) { reject(new Error('分析已停止')); return; }
    const grouped = processGroup && process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    const streams = { stdout: [], stderr: [] }; let size = 0, failure = null, escalation;
    const kill = name => { try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch {} };
    const terminate = () => { kill('SIGTERM'); if (!escalation) escalation = setTimeout(() => kill('SIGKILL'), killDelay); };
    const stop = reason => { if (failure) return; failure = reason; terminate(); };
    const aborted = () => stop('aborted');
    signal?.addEventListener('abort', aborted, { once: true });
    const collect = name => chunk => { size += chunk.length; if (size > limit) { stop('output_limit'); return; } if (!failure) streams[name].push(chunk); };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    const timer = setTimeout(() => stop('timeout'), timeout);
    const cleanup = () => { clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', aborted); if (grouped) kill('SIGKILL'); };
    // The native agent can spawn stdio MCP children. End the entire group even
    // if its leader exits first, so an inherited pipe cannot keep a run alive.
    child.once('exit', () => { if (grouped) terminate(); });
    child.once('error', () => { cleanup(); reject(new Error('无法启动分析进程')); });
    child.once('close', (code, signal) => { cleanup(); resolveRun({ code: failure ? 1 : code, signal, failure,
      output: Buffer.concat(streams.stdout).toString('utf8'), stderr: Buffer.concat(streams.stderr).toString('utf8') }); });
  });
}
function docker(args, env = process.env, timeout = 300_000, signal) { return captureProcess('docker', args, { env, timeout, signal }); }

function validateProfile(profile, agent, reportGroup) {
  if (!['signals-analysis.toml', 'signals-observation.toml'].includes(profile)
    || !['analysis', 'observation'].includes(agent) || !['signal-analysis', 'signal-observation'].includes(reportGroup)) throw new Error('Invalid local analysis profile');
}

async function prepareReport(env, reportGroup, evidenceInput) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  const directory = resolve(signalDataRoot(env), reportGroup, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (evidenceInput) await writeFile(resolve(directory, 'input.json'), JSON.stringify(evidenceInput, null, 2) + '\n', { mode: 0o600 });
  return directory;
}

async function saveAgentResult(result, directory, secrets) {
  function sanitized(value) {
    let text = value.replace(/\x1b\[[0-9;]*m/g, '');
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    return text;
  }
  const output = sanitized(result.output);
  await writeFile(resolve(directory, 'agent-output.log'), output, { mode: 0o600 });
  await writeFile(resolve(directory, 'agent-stderr.log'), sanitized(result.stderr), { mode: 0o600 });
  let calls = [];
  try { calls = (await readFile(resolve(directory, 'tool-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
  if (result.code !== 0) throw new Error(`ZeroClaw 尚未完成真实工具分析，诊断记录：${resolve(directory, 'agent-output.log')}`);
  return { directory, output, calls };
}

export async function runNativeSignalAgent({ prompt, profile = 'signals-analysis.toml', agent = 'analysis', reportGroup = 'signal-analysis', search = false, evidenceInput, env = process.env, signal }) {
  validateProfile(profile, agent, reportGroup);
  const service = await signalServiceEnvironment({ ...env, SIGNAL_AGENT_RUNTIME: 'native' });
  const directory = await prepareReport(env, reportGroup, evidenceInput);
  const temporary = await mkdtemp(resolve(tmpdir(), 'signal-agent-'));
  try {
    const agentEnv = nativeAgentEnvironment(env, { service, directory, temporary, search });
    const configDirectory = resolve(temporary, '.zeroclaw');
    await mkdir(configDirectory, { mode: 0o700 });
    const profileText = (await readFile(resolve(root, '.zeroclaw', profile), 'utf8'))
      .replace('"/app/src/signals/mcp.js"', JSON.stringify(resolve(root, 'src/signals/mcp.js')));
    await writeFile(resolve(configDirectory, 'config.toml'), profileText, { mode: 0o600 });
    const result = await captureProcess('zeroclaw', ['agent', '--config-dir', configDirectory, '--agent', agent, '--message', prompt],
      { env: agentEnv, cwd: temporary, processGroup: true, signal });
    return await saveAgentResult(result, directory, [service.SIGNAL_API_TOKEN, ...relayKeys.slice(0, 2).map(key => env[key])]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function runSignalAgent(options) {
  return signalRuntime(options.env) === 'native' ? runNativeSignalAgent(options) : runLocalSignalAgent(options);
}

export async function runLocalSignalAgent({ prompt, profile = 'signals-analysis.toml', agent = 'analysis', reportGroup = 'signal-analysis', search = false, evidenceInput, env = process.env, signal }) {
  validateProfile(profile, agent, reportGroup);
  const local = await localEnvironment(root, env);
  const project = { ...parseEnv(await readFile(resolve(root, '.env'), 'utf8')), ...env };
  const agentEnv = analysisEnvironment(project, local);
  if (search) agentEnv.SIGNAL_SEARCH_URL = project.SIGNAL_SEARCH_URL || 'https://p01--g02-ritup-repo01-search--4ygvmqls7l8l.code.run';
  const running = await docker(composeArguments(root, ['ps', '--status', 'running', '-q', 'signals']), local, 15_000);
  const serviceId = running.output.trim();
  if (running.code !== 0 || !/^[a-f0-9]{12,64}$/.test(serviceId)) throw new Error('请先运行 npm run signals:local -- up');
  if ((await docker(['image', 'inspect', image, '--format', '{{.Id}}'], process.env, 15_000)).code !== 0) {
    throw new Error('请先构建分析运行环境：docker build -f Dockerfile -t signal-analysis-agent:local .');
  }
  const directory = await prepareReport(project, reportGroup, evidenceInput);
  const name = 'signal-analysis-' + randomBytes(6).toString('hex');
  const args = ['run', '--rm', '--name', name, '--network', `container:${serviceId}`,
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,src=${root}/src/signals,dst=/app/src/signals,readonly`,
    '--mount', `type=bind,src=${root}/.zeroclaw/${profile},dst=/run/signal-analysis.toml,readonly`,
    '--mount', `type=bind,src=${directory},dst=/reports`,
    ...Object.keys(agentEnv).flatMap(key => ['-e', key]), '--entrypoint', 'sh', image, '-c',
    'mkdir -p /tmp/signal-analysis/.zeroclaw && cp /run/signal-analysis.toml /tmp/signal-analysis/.zeroclaw/config.toml && exec zeroclaw agent --config-dir /tmp/signal-analysis/.zeroclaw --agent "$1" --message "$2"', 'signal-analysis', agent, prompt];
  let result;
  try { result = await docker(args, { ...env, ...agentEnv }, 300_000, signal); }
  finally { await docker(['rm', '--force', name], process.env, 15_000); }
  return saveAgentResult(result, directory, [local.SIGNAL_API_TOKEN, ...relayKeys.slice(0, 2).map(key => project[key])]);
}

export async function main(instId = process.argv[2] || 'ETH-USDT-SWAP') {
  if (!/^[A-Z0-9]{2,20}-USDT-SWAP$/.test(instId)) throw new Error('请指定准确合约，例如 npm run signals:analyze -- ETH-USDT-SWAP');
  console.log(`ZeroClaw 正在通过只读 MCP 分析 ${instId}…`);
  const { directory, output, calls } = await runSignalAgent({ prompt: analysisPrompt(instId) });
  let evidence, review;
  try {
    evidence = collectAnalysisEvidence(calls, instId);
    review = validateAnalysisReview(output, evidence);
  } catch (error) { throw new Error(`${error.message}；诊断记录：${resolve(directory, 'agent-output.log')}`); }
  const report = resolve(directory, 'report.md');
  await writeFile(resolve(directory, 'review.json'), JSON.stringify(review, null, 2) + '\n', { mode: 0o600 });
  await writeFile(report, renderAnalysisReport(evidence, review), { mode: 0o600 });
  console.log(`报告：${report}`);
  console.log(`工具调用记录：${resolve(directory, 'tool-calls.jsonl')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
