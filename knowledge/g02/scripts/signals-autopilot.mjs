import { readFile, writeFile, mkdir, rename, unlink, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSignalAgent } from './signals-analysis.mjs';
import { registerObservation } from './signals-observe.mjs';
import { signalEnvironment, signalServiceEnvironment, signalDataRoot, relayKeys } from './signals-runtime.mjs';
import { autopilotInstruments, autopilotIntervalMs, autopilotInput, autopilotSourceId,
  autonomousDirectionPrompt, autonomousReviewInput, validateAutonomousDecision } from '../src/signals/autopilot.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function workerPaths(env) {
  const base = resolve(signalDataRoot(env), 'signal-autopilot');
  return { base, pidFile: resolve(base, 'worker.pid'), statusFile: resolve(base, 'status.json') };
}
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('AI 自动入口记录损坏，已停止处理'); }
}
async function atomicJson(path, value) {
  const temporary = path + '.tmp-' + process.pid;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function cleanReason(error) { return String(error?.message || '自动方向评估失败').slice(0, 500); }

export async function runAutopilotCycle({ env = process.env, now = Date.now, agentRunner = runSignalAgent,
  register = registerObservation, registrationEnv, signal } = {}) {
  const cycleAt = now();
  const instruments = autopilotInstruments(env.SIGNAL_AUTO_INSTRUMENTS);
  const results = [];
  let serviceEnv = registrationEnv;
  for (const instId of instruments) {
    signal?.throwIfAborted();
    const sourceId = autopilotSourceId(instId, cycleAt);
    const seed = autopilotInput(instId, cycleAt);
    try {
      const agent = await agentRunner({
        prompt: autonomousDirectionPrompt(instId, sourceId, cycleAt),
        profile: 'signals-observation.toml',
        agent: 'observation',
        reportGroup: 'signal-observation',
        search: true,
        evidenceInput: seed,
        env,
        signal,
      });
      const review = validateAutonomousDecision(agent.output, seed, agent.calls, cycleAt);
      const input = autonomousReviewInput(review, instId, cycleAt);
      let registration = { submitted: false, reason: review.decision };
      if (review.decision === 'observe') {
        serviceEnv ||= await signalServiceEnvironment(env);
        registration = await register({ input, review, env: serviceEnv, signal });
      }
      results.push({ instId, direction: review.direction, decision: review.decision,
        taskId: registration.taskId || null, duplicate: registration.duplicate === true,
        reason: review.reason.slice(0, 240), directory: agent.directory || null });
    } catch (error) {
      results.push({ instId, decision: 'error', reason: cleanReason(error) });
    }
  }
  return { at: cycleAt, instruments, results };
}

export async function runWorker(env = process.env) {
  if (env.SIGNAL_AI_AUTOCREATE !== 'true') throw new Error('SIGNAL_AI_AUTOCREATE 必须设置为 true');
  for (const key of relayKeys) if (!env[key]) throw new Error('AI 自动方向缺少模型配置');
  const config = { intervalMs: autopilotIntervalMs(env.SIGNAL_AI_AUTOCREATE_INTERVAL_MS), instruments: autopilotInstruments(env.SIGNAL_AUTO_INSTRUMENTS) };
  const { base, pidFile, statusFile } = workerPaths(env);
  await mkdir(base, { recursive: true, mode: 0o700 });
  try { await writeFile(pidFile, JSON.stringify({ pid: process.pid, instruments: config.instruments }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    const old = await readJson(pidFile);
    if (alive(old?.pid)) throw new Error('AI 自动方向入口已在运行');
    await unlink(pidFile).catch(() => {});
    await writeFile(pidFile, JSON.stringify({ pid: process.pid, instruments: config.instruments }), { flag: 'wx', mode: 0o600 });
  }
  let stopping = false, waitResolve;
  const controller = new AbortController();
  const stop = () => { stopping = true; controller.abort(); waitResolve?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const wait = ms => new Promise(resolveWait => {
    const timer = setTimeout(resolveWait, ms);
    waitResolve = () => { clearTimeout(timer); resolveWait(); };
  });
  const status = { pid: process.pid, instruments: config.instruments, intervalMs: config.intervalMs,
    startedAt: Date.now(), state: 'starting', lastCycleAt: null, processed: 0 };
  try {
    await atomicJson(statusFile, status);
    console.log('AI automatic direction intake ready for ' + config.instruments.join(', ') + '.');
    while (!stopping) {
      status.state = 'processing'; status.processingStartedAt = Date.now(); delete status.error;
      await atomicJson(statusFile, status);
      const cycle = await runAutopilotCycle({ env, signal: controller.signal });
      status.state = stopping ? 'stopping' : 'running';
      status.lastCycleAt = cycle.at; status.lastResults = cycle.results;
      status.processed += cycle.results.length; delete status.processingStartedAt;
      await atomicJson(statusFile, status);
      if (!stopping) await wait(config.intervalMs);
    }
  } catch (error) {
    if (!stopping) {
      status.state = 'retrying'; status.error = cleanReason(error); delete status.processingStartedAt;
      await atomicJson(statusFile, status);
      console.error('AI automatic direction cycle failed: ' + status.error);
    }
  } finally {
    status.state = 'stopped'; status.stoppedAt = Date.now();
    await atomicJson(statusFile, status);
    const owner = await readJson(pidFile);
    if (owner?.pid === process.pid) await unlink(pidFile);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

export async function main(action = process.argv[2] || 'status') {
  const env = await signalEnvironment();
  const { base, pidFile, statusFile } = workerPaths(env);
  if (action === 'run') return runWorker(env);
  if (action === 'check') {
    if (env.SIGNAL_AI_AUTOCREATE !== 'true') throw new Error('请先设置 SIGNAL_AI_AUTOCREATE=true');
    for (const key of relayKeys) if (!env[key]) throw new Error('AI 自动方向缺少模型配置');
    console.log(JSON.stringify({ intervalMs: autopilotIntervalMs(env.SIGNAL_AI_AUTOCREATE_INTERVAL_MS),
      instruments: autopilotInstruments(env.SIGNAL_AUTO_INSTRUMENTS) }, null, 2));
    return;
  }
  if (action === 'status') {
    const record = await readJson(pidFile), status = await readJson(statusFile);
    console.log(JSON.stringify({ ...status, processAlive: alive(record?.pid) }, null, 2)); return;
  }
  if (action === 'stop') {
    const record = await readJson(pidFile);
    if (!alive(record?.pid)) { console.log('AI automatic direction intake is not running.'); return; }
    process.kill(record.pid, 'SIGTERM'); console.log('AI automatic direction intake is stopping.'); return;
  }
  if (action === 'start') {
    if (env.SIGNAL_AI_AUTOCREATE !== 'true') throw new Error('请先设置 SIGNAL_AI_AUTOCREATE=true');
    await mkdir(base, { recursive: true, mode: 0o700 });
    const record = await readJson(pidFile);
    if (alive(record?.pid)) { console.log('AI automatic direction intake already running.'); return; }
    const log = await open(resolve(base, 'worker.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref(); await log.close();
    for (let i = 0; i < 20; i++) {
      await delay(500);
      const status = await readJson(statusFile);
      if (status?.pid === child.pid && ['processing', 'running'].includes(status.state)) {
        console.log('AI automatic direction intake started. Log: ' + resolve(base, 'worker.log')); return;
      }
      if (!alive(child.pid)) throw new Error('AI automatic direction intake failed to start; inspect ' + resolve(base, 'worker.log'));
    }
    throw new Error('AI automatic direction intake is still starting; use status to inspect readiness');
  }
  throw new Error('Usage: signals:autopilot check|start|status|stop|run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
