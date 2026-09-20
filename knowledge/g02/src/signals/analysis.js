import { createTask, inspectStrategy } from './strategy.js';

export function analyzeFrame(frame, { task, now = Date.now(), mode = 'okx-demo' } = {}) {
  const input = { ...frame, ts: frame.time,
    candles15m: frame.candles15.map(c => ({ ...c, ts: c.time })),
    candles1h: frame.candles1h.map(c => ({ ...c, ts: c.time })) };
  if (task) return { mode, analysis: inspectStrategy(task, input, now) };
  const directions = ['long', 'short'].map(direction => {
    const sample = createTask({ instId: frame.instId, direction, sourceId: 'read-only-analysis' }, { id: 'read-only-analysis', mode, now });
    const report = inspectStrategy(sample, input, now);
    return { ...report, taskId: null };
  });
  return { mode, analysis: { readOnly: true, asOf: now, market: directions[0].market,
    strategyRules: directions[0].strategyRules, directions,
    note: '多空预案使用当前报价作为假设观察起点。只有创建方向任务后才会持续观察和模拟执行。' } };
}
