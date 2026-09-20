import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSignalAgent } from './signals-analysis.mjs';
import { signalServiceEnvironment } from './signals-runtime.mjs';
import { createSignalBridge } from '../src/signals/mcp.js';
import { parseObservationInput, observationPrompt, validateObservationDecision, buildObservationTask } from '../src/signals/observation.js';

export async function registerObservation({ input, review, env, fetchImpl = fetch, now = Date.now, signal }) {
  signal?.throwIfAborted();
  const payload = buildObservationTask(input, review);
  if (payload.expiresAt <= now()) throw new Error('方向已过期，未登记任务');
  const bridge = createSignalBridge({ env: { ...env, SIGNAL_MCP_READ_ONLY: '0' }, fetchImpl, now, signal });
  const listed = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'signal_list_directions', arguments: {} } });
  if (listed.error || listed.result?.isError) throw new Error('无法核对模拟盘状态，未登记任务');
  const state = JSON.parse(listed.result.content[0].text);
  if (state.mode !== 'okx-demo' || state.monitor?.error || !state.monitor?.running) throw new Error('模拟盘调度未就绪，未登记任务');
  const existing = state.tasks?.find(task => (task.sourceId ?? task.source?.id) === payload.source.id);
  if (existing) {
    if (existing.instId !== payload.instId || existing.direction !== payload.direction) throw new Error('原消息已登记其他方向，不能覆盖');
    return { taskId: existing.id, duplicate: true, status: existing.status, submitted: false };
  }
  signal?.throwIfAborted();
  const result = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'signal_create_direction', arguments: payload } });
  if (result.error || result.result?.isError) throw new Error('任务登记未确认；请在看板按原消息 ID 核对，重试须保留该 ID');
  const data = JSON.parse(result.result.content[0].text);
  if (!data.task?.id || data.task.instId !== payload.instId || data.task.direction !== payload.direction
    || (data.task.sourceId ?? data.task.source?.id) !== payload.source.id) throw new Error('任务登记回执不匹配；请核对看板，不要改原消息 ID 重试');
  return { taskId: data.task.id, duplicate: data.duplicate === true, status: data.task.status, submitted: true };
}

export async function main(args = process.argv.slice(2)) {
  const preview = args[0] === '--preview';
  const paths = preview ? args.slice(1) : args;
  if (paths.length !== 1 || paths[0].startsWith('-')) throw new Error('用法：npm run signals:observe -- [--preview] direction.json');
  const raw = await readFile(resolve(paths[0]), 'utf8');
  if (Buffer.byteLength(raw) > 16_384) throw new Error('方向输入文件过大');
  return observeDirection(JSON.parse(raw), { preview });
}

export async function observeDirection(raw, { preview = false, agentRunner = runSignalAgent, registrationEnv, env = process.env, signal } = {}) {
  signal?.throwIfAborted();
  const input = parseObservationInput(raw, Date.now());
  console.log(`ZeroClaw 正在评估 ${input.instId} ${input.direction}，包含行情与网络资料…`);
  const { directory, output, calls } = await agentRunner({
    prompt: observationPrompt(input), profile: 'signals-observation.toml', agent: 'observation', reportGroup: 'signal-observation', search: true, evidenceInput: input, env, signal,
  });
  await writeFile(resolve(directory, 'input.json'), JSON.stringify(input, null, 2) + '\n', { mode: 0o600 });
  let review;
  try { review = validateObservationDecision(output, input, calls, Date.now()); }
  catch (error) { throw new Error(`${error.message}；未登记任务，诊断记录：${directory}`); }
  await writeFile(resolve(directory, 'decision.json'), JSON.stringify(review, null, 2) + '\n', { mode: 0o600 });
  let registration = { submitted: false, reason: preview ? 'preview' : review.decision };
  const registrationPath = resolve(directory, 'registration.json');
  if (!preview && review.decision === 'observe') {
    signal?.throwIfAborted();
    const serviceEnv = registrationEnv || await signalServiceEnvironment(env);
    await writeFile(registrationPath, JSON.stringify({ state: 'pending', sourceId: input.source.id, at: Date.now() }) + '\n', { mode: 0o600 });
    try {
      registration = await registerObservation({ input, review, env: serviceEnv, signal });
    } catch (error) {
      await writeFile(registrationPath, JSON.stringify({ state: 'unconfirmed', sourceId: input.source.id, error: error.message }) + '\n', { mode: 0o600 });
      throw new Error(`${error.message}；记录：${directory}`);
    }
  }
  await writeFile(registrationPath, JSON.stringify(registration, null, 2) + '\n', { mode: 0o600 });
  const label = { observe: '允许策略观察', wait: '暂缓登记', reject: '不采用该方向' }[review.decision];
  const report = [`# ${input.instId} 方向评估`, '', `方向：${input.direction}；结论：${label}。`, '',
    `原因：${review.reason}`, '',
    registration.taskId ? `任务：${registration.taskId}；状态：${registration.status}。登记成功不代表已成交；入场和持仓管理由后台策略执行。`
      : preview ? '本次为预览，未登记任务。' : '本次未登记任务。暂缓不等于已开始持续观察，后续重新评估应保留原消息 ID 和有效期。', '',
    '每轮保证金最多 100 USDT、3 倍逐仓；规则和来源不由网络内容改写。', '',
    '完整输入、引用资料、判断与登记结果保存在本目录的 input.json、tool-calls.jsonl、decision.json、registration.json。', ''].join('\n');
  const reportPath = resolve(directory, 'report.md');
  await writeFile(reportPath, report, { mode: 0o600 });
  console.log(`结论：${label}${registration.taskId ? `；任务 ${registration.taskId}` : ''}`);
  console.log(`记录：${reportPath}`);
  return { input, review, registration, directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
