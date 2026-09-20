import { readFile, writeFile, mkdir, rename, readdir, unlink, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discordConfig, createDiscordClient, eligibleMessage, downloadMessageImages, observationFromMessage, discordResultText } from '../src/signals/discord.js';
import { extractDirection } from '../src/signals/vision.js';
import { observeDirection } from './signals-observe.mjs';
import { captureProcess } from './signals-analysis.mjs';
import { signalEnvironment, signalRuntime, signalDataRoot, signalServiceEnvironment, relayKeys } from './signals-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function workerPaths(env) {
  const base = resolve(signalDataRoot(env), 'signal-discord');
  return { base, pidFile: resolve(base, 'worker.pid'), statusFile: resolve(base, 'status.json') };
}
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('本地任务记录损坏，已停止处理'); } }
async function atomicJson(path, value) {
  const temp = path + '.tmp-' + process.pid;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path);
}
function alive(pid) { if (!Number.isSafeInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
export async function processDiscordMessage(message, { config, env, directory, client, extract = extractDirection, observe = observeDirection, download = downloadMessageImages, now = Date.now, signal }) {
  signal?.throwIfAborted();
  if (!eligibleMessage(message, config, now())) return { state: 'ignored' };
  const path = resolve(directory, `${message.id}.json`);
  const job = { messageId: message.id, channelId: config.channelId, authorId: config.userId, receivedAt: message.timestamp, claimedAt: now(), state: 'processing', originalText: message.content || '',
    attachments: (message.attachments || []).map(a => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size })) };
  try { await writeFile(path, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code === 'EEXIST') return { state: 'duplicate' }; throw e; }
  let response;
  try {
    job.phase = 'download';
    const images = await download(message);
    job.images = images.map(image => ({ attachmentId: image.attachmentId, sha256: image.sha256, bytes: image.bytes.length, mimeType: image.mimeType }));
    job.phase = 'recognition';
    const extraction = await extract({ content: message.content || '', images, env });
    job.extraction = extraction; await atomicJson(path, job);
    let result;
    if (extraction.decision === 'candidate') {
      const input = observationFromMessage(message, extraction, now());
      job.input = input; job.phase = 'research'; await atomicJson(path, job);
      signal?.throwIfAborted();
      result = await observe(input, { env, signal });
      job.analysisDirectory = result.directory; job.review = result.review; job.registration = result.registration;
    }
    response = discordResultText(extraction, result);
    job.state = result?.registration?.taskId ? 'registered' : extraction.decision === 'ignore' ? 'ignored' : 'reviewed';
  } catch (error) {
    // Never echo model/network errors or credentials to Discord. The source id
    // remains stable even when a registration outcome cannot be confirmed.
    job.state = 'failed'; job.failure = job.phase === 'research' ? 'analysis_or_registration_failed' : 'image_or_recognition_failed';
    response = job.phase === 'research'
      ? '本次策略校验未完成，任务登记结果尚未确认。请在看板按来源 ID 核对：\n' + `discord:${config.channelId}:${message.id}\n` + '系统不会自动重复提交。'
      : '本次图片读取或识别未完成，没有创建任务。请使用清晰的 PNG/JPEG/WebP 附件，一次最多 3 张且总计不超过 8 MiB；也可补充准确合约和当前方向。';
  }
  if (response) response = '【方向实验室 · 模拟盘】\n' + response;
  job.finishedAt = now(); job.reply = response ? 'pending' : 'none'; await atomicJson(path, job);
  if (response) {
    // Mark before transmission: a timeout may have delivered a reply already.
    // A restart never blindly resends messages or an uncertain registration.
    job.reply = 'sending'; await atomicJson(path, job);
    try { const sent = await client.reply(message.id, response); job.reply = 'sent'; job.replyId = sent.id; }
    catch { job.reply = 'unconfirmed'; }
    await atomicJson(path, job);
  }
  return job;
}
export async function assertDependencies(env, { fetchImpl = fetch, capture = captureProcess } = {}) {
  if (!env.SIGNAL_VISION_BASE_URL || !env.SIGNAL_VISION_API_KEY) throw new Error('Vision endpoint and API key are required');
  for (const key of relayKeys) if (!env[key]) throw new Error(`Missing model configuration: ${key}`);
  const service = await signalServiceEnvironment(env);
  const health = await fetchImpl(`${service.SIGNAL_SERVICE_URL}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!health.ok || (await health.json()).mode !== 'okx-demo') throw new Error('Demo service unavailable');
  const response = await fetchImpl(`${service.SIGNAL_SERVICE_URL}/api/dashboard`, { headers: { Authorization: `Bearer ${service.SIGNAL_API_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Demo service unavailable');
  const dashboard = await response.json();
  if (dashboard.mode !== 'okx-demo' || !dashboard.monitor?.running || dashboard.monitor.error) throw new Error('Demo scheduler is not ready');
  const native = signalRuntime(env) === 'native';
  const runtime = await capture(native ? 'zeroclaw' : 'docker', native ? ['--version'] : ['image', 'inspect', 'signal-analysis-agent:local', '--format', '{{.Id}}'],
    { timeout: 15000, limit: 32768, ...(native ? { env: { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', NO_COLOR: '1' } } : {}) });
  if (runtime.code !== 0) throw new Error('ZeroClaw analysis runtime unavailable');
}
export async function runWorker(env = process.env) {
  const { base, pidFile, statusFile } = workerPaths(env);
  const config = discordConfig(env);
  const directory = resolve(base, 'messages'); await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(pidFile, JSON.stringify({ pid: process.pid, channelId: config.channelId }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    const old = await readJson(pidFile); if (alive(old?.pid)) throw new Error('Discord 入口已在运行');
    await unlink(pidFile).catch(() => {}); await writeFile(pidFile, JSON.stringify({ pid: process.pid, channelId: config.channelId }), { flag: 'wx', mode: 0o600 });
  }
  let stopping = false, waitResolve;
  const controller = new AbortController();
  const stop = () => { stopping = true; controller.abort(); waitResolve?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const wait = ms => new Promise(resolveWait => { const timer = setTimeout(resolveWait, ms); waitResolve = () => { clearTimeout(timer); resolveWait(); }; });
  const client = createDiscordClient(config);
  const status = { pid: process.pid, channelId: config.channelId, guildId: config.guildId, startedAt: Date.now(), state: 'starting', lastPollAt: null, processed: 0 };
  try {
    await assertDependencies(env);
    const channel = await client.preflight(); status.channelName = channel.name;
    // Each start arms from the current newest message. Offline backlog, history,
    // edits and bot replies never become newly authorized live observations.
    const latest = await client.messages(undefined, 1);
    let cursor = latest.at(-1)?.id || ((BigInt(Date.now() - 1420070400000) << 22n).toString());
    await atomicJson(resolve(base, 'cursor.json'), { channelId: config.channelId, after: cursor, armedAt: Date.now() });
    for (const filename of await readdir(directory)) {
      if (!/^\d{16,22}\.json$/.test(filename)) continue;
      const path = resolve(directory, filename), job = await readJson(path);
      if (job?.state === 'processing') { job.state = 'interrupted'; job.failure = 'restart_requires_source_reconciliation'; await atomicJson(path, job); }
    }
    status.state = 'running'; await atomicJson(statusFile, status);
    console.log(`Discord screenshot intake ready in #${channel.name}; new owner messages only.`);
    while (!stopping) {
      let retryAfter = 10000;
      try {
        const messages = await client.messages(cursor);
        status.lastPollAt = Date.now(); status.error = null;
        for (const message of messages) {
          if (stopping) break;
          if (eligibleMessage(message, config)) {
            status.state = 'processing'; status.processingStartedAt = Date.now(); status.messageId = message.id; await atomicJson(statusFile, status);
            const result = await processDiscordMessage(message, { config, env, directory, client, signal: controller.signal });
            status.processed++; status.lastResult = result.state;
          }
          cursor = message.id;
          await atomicJson(resolve(base, 'cursor.json'), { channelId: config.channelId, after: cursor, updatedAt: Date.now() });
        }
        status.state = stopping ? 'stopping' : 'running'; delete status.messageId; delete status.processingStartedAt;
      } catch (error) { status.state = 'retrying'; status.error = 'Discord polling failed; no new task submitted'; retryAfter = error.retryAfterMs || 10000; }
      await atomicJson(statusFile, status);
      if (!stopping) await wait(retryAfter);
    }
  } finally {
    status.state = 'stopped'; status.stoppedAt = Date.now(); await atomicJson(statusFile, status);
    const owner = await readJson(pidFile); if (owner?.pid === process.pid) await unlink(pidFile);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
export async function main(action = process.argv[2] || 'status') {
  const env = await signalEnvironment();
  const { base, pidFile, statusFile } = workerPaths(env);
  if (action === 'run') return runWorker(env);
  if (action === 'check') { const config = discordConfig(env); const channel = await createDiscordClient(config).preflight(); await assertDependencies(env); console.log(`Discord channel verified: #${channel.name}; only configured owner accepted.`); return; }
  if (action === 'status') { const record = await readJson(pidFile), status = await readJson(statusFile); console.log(JSON.stringify({ ...status, processAlive: alive(record?.pid) }, null, 2)); return; }
  if (action === 'stop') {
    const record = await readJson(pidFile); if (!alive(record?.pid)) { console.log('Discord intake is not running.'); return; }
    process.kill(record.pid, 'SIGTERM'); console.log('Discord intake is stopping and cancelling active analysis.'); return;
  }
  if (action === 'start') {
    discordConfig(env); const record = await readJson(pidFile); if (alive(record?.pid)) { console.log('Discord intake already running.'); return; }
    await mkdir(base, { recursive: true, mode: 0o700 });
    const log = await open(resolve(base, 'worker.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] }); child.unref(); await log.close();
    for (let i = 0; i < 20; i++) { await delay(500); const status = await readJson(statusFile); if (status?.pid === child.pid && status.state === 'running') { console.log(`Discord intake started for #${status.channelName}. New messages only. Log: ${resolve(base, 'worker.log')}`); return; } if (!alive(child.pid)) throw new Error(`Discord intake failed to start; inspect ${resolve(base, 'worker.log')}`); }
    throw new Error('Discord intake is still starting; use the status command to inspect readiness');
  }
  throw new Error('Usage: signals:discord check|start|status|stop|run');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Discord intake failed. Check configuration and local audit records; no credentials are logged.'); process.exitCode = 1; });
