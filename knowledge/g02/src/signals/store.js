import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { transaction } from '../postgres.js';
import { createTask, DEFAULT_CONFIG } from './strategy.js';
import { MAX_ENTRY_MARGIN } from './policy.js';

export function badRequest(message, status = 400) { return Object.assign(new Error(message), { status }); }
export const LIMITS = Object.freeze({ riskPerRound: 25, riskBudget: 75, maxNotional: 1000, marginPerRound: MAX_ENTRY_MARGIN, leverage: 10, maxRounds: 3, maxTasks: 10, portfolioRisk: 75, initialEquity: 10_000 });

function hydrateTask(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  return { ...state, config: { ...DEFAULT_CONFIG, ...(state.config || {}) } };
}

export class SignalStore {
  constructor(pool, mode = 'paper') { this.pool = pool; this.mode = mode; }
  async initialize(binding = {}) {
    if (!['paper', 'okx-demo'].includes(this.mode)) throw badRequest('仅支持 paper 或 okx-demo');
    const credential = typeof binding === 'string' ? binding : binding?.credential ?? '';
    const accountId = typeof binding === 'object' && binding !== null && typeof binding.accountId === 'string'
      ? binding.accountId.trim() : '';
    await this.pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await transaction(this.pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('signal-mode-binding'))");
      const rows = (await db.query("SELECT key,value FROM signal_research.meta WHERE key IN ('mode','account','account_uid')")).rows;
      const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
      const taskModes = (await db.query("SELECT state->>'mode' AS mode,count(*)::int AS count FROM signal_research.tasks GROUP BY state->>'mode'")).rows;
      const taskCount = taskModes.reduce((sum, row) => sum + Number(row.count), 0);
      if (taskCount && !meta.mode) throw badRequest('方向策略账本缺少模式绑定，请勿自动接入现有账户');
      if (meta.mode && meta.mode !== this.mode) throw badRequest('paper 与 okx-demo 必须使用不同数据库');
      if (taskModes.some(row => row.mode !== this.mode)) throw badRequest('数据库中存在其他模式或未标记模式的方向任务');
      if (this.mode === 'okx-demo') {
        if (!/^[a-f0-9]{64}$/.test(credential) || !accountId || accountId.length > 128) {
          throw badRequest('OKX 模拟盘账本需要有效的凭据指纹和账户 UID');
        }
        if (taskCount && !meta.account) throw badRequest('现有模拟盘账本缺少账户绑定，请使用新数据库人工迁移');
        if (meta.account && meta.account !== credential) throw badRequest('该数据库已绑定其他模拟盘 API Key，请使用原 Key 或新数据库');
        if (meta.account_uid && meta.account_uid !== accountId) throw badRequest('该数据库已绑定其他 OKX 模拟账户，请使用原账户或新数据库');
      } else if (meta.account || meta.account_uid) {
        throw badRequest('paper 与 okx-demo 必须使用不同数据库');
      }
      await db.query("INSERT INTO signal_research.meta VALUES('mode',$1) ON CONFLICT DO NOTHING", [this.mode]);
      if (this.mode === 'okx-demo') {
        await db.query("INSERT INTO signal_research.meta VALUES('account',$1) ON CONFLICT DO NOTHING", [credential]);
        await db.query("INSERT INTO signal_research.meta VALUES('account_uid',$1) ON CONFLICT DO NOTHING", [accountId]);
      }
    });
  }
  async recordFrame(frame) {
    const { candles15, candles1h, ...quote } = frame;
    await transaction(this.pool, async db => {
      await db.query('INSERT INTO signal_research.quotes(inst_id,quote_time,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [frame.instId, frame.time, JSON.stringify(quote)]);
      const candles = [...candles15.map(data => ({ interval: '15m', time: data.time, data })), ...candles1h.map(data => ({ interval: '1H', time: data.time, data }))];
      await db.query(`INSERT INTO signal_research.candles(inst_id,interval,candle_time,data)
        SELECT $1,x.interval,x.time,x.data FROM jsonb_to_recordset($2::jsonb) AS x(interval text,time bigint,data jsonb)
        ON CONFLICT DO NOTHING`, [frame.instId, JSON.stringify(candles)]);
    });
  }
  async list() { return (await this.pool.query('SELECT state FROM signal_research.tasks ORDER BY created_at DESC,id')).rows.map(r => hydrateTask(r.state)); }
  async researchStatus(tasks = []) {
    const row = (await this.pool.query(`SELECT
      (SELECT count(*)::int FROM signal_research.events) AS event_count,
      (SELECT count(*)::int FROM signal_research.quotes) AS quote_count,
      (SELECT count(*)::int FROM signal_research.candles) AS candle_count,
      (SELECT count(DISTINCT inst_id)::int FROM signal_research.quotes) AS instrument_count`)).rows[0] || {};
    return {
      taskCount: tasks.length,
      activeTaskCount: tasks.filter(isActive).length,
      eventCount: Number(row.event_count || 0),
      quoteCount: Number(row.quote_count || 0),
      candleCount: Number(row.candle_count || 0),
      instrumentCount: Number(row.instrument_count || 0),
    };
  }
  async get(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('任务 ID 不正确');
    const row = (await this.pool.query('SELECT state FROM signal_research.tasks WHERE id=$1', [id])).rows[0];
    if (!row) throw badRequest('方向任务不存在', 404);
    return hydrateTask(row.state);
  }
  async events(id, limit = 100) {
    return (await this.pool.query(`SELECT id,task_id AS "taskId",type,data,created_at AS "createdAt" FROM signal_research.events
      WHERE ($1::uuid IS NULL OR task_id=$1) ORDER BY id DESC LIMIT $2`, [id || null, limit])).rows;
  }
  async orders(id) { return (await this.pool.query('SELECT state FROM signal_research.orders WHERE ($1::uuid IS NULL OR task_id=$1) ORDER BY created_at,id', [id || null])).rows.map(r => r.state); }
  async appendEvents(db, id, events = []) {
    for (const event of events) await db.query('INSERT INTO signal_research.events(task_id,type,data) VALUES($1,$2,$3)', [id, event.type || 'transition', JSON.stringify(event)]);
  }
  async create(input, now = Date.now()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('需要方向任务对象');
    const allowedFields = ['sourceId', 'sourceText', 'source', 'instId', 'direction', 'expiresAt', 'config'];
    if (Object.keys(input).some(key => !allowedFields.includes(key))) throw badRequest('包含不支持的方向任务字段');
    const sourceId = input.sourceId ?? input.source?.id;
    if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 200) throw badRequest('需要稳定且不超过 200 字符的 sourceId，Discord 请用原消息 ID');
    const config = input.config === undefined ? {} : input.config;
    const allowed = ['riskPerRound', 'riskBudget', 'maxNotional', 'marginPerRound', 'leverage', 'maxRounds'];
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !allowed.includes(k))) throw badRequest('只允许设置每轮风险、总风险、保证金、杠杆、名义金额和轮数');
    for (const key of allowed) {
      const minimum = key === 'maxNotional' || key === 'maxRounds' || key === 'leverage' || key === 'marginPerRound' ? 1 : 0.01;
      if (config[key] !== undefined && (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < minimum || config[key] > LIMITS[key])) throw badRequest(`${key} 必须为 ${minimum}～${LIMITS[key]} 之间的数字`);
    }
    if (config.leverage !== undefined && (!Number.isInteger(config.leverage) || config.leverage < 1)) throw badRequest('leverage 必须为 1～10 的整数');
    if (config.maxRounds !== undefined && !Number.isInteger(config.maxRounds)) throw badRequest('maxRounds 必须为整数');
    const expiresAt = input.expiresAt === undefined ? now + 86400_000 : (typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 86400_000) throw badRequest('有效期须在未来 24 小时以内');
    const sourceText = input.sourceText ?? input.source?.text ?? '';
    if (typeof sourceText !== 'string' || sourceText.length > 4000) throw badRequest('来源文本最多 4000 字符');
    let task;
    try { task = createTask({ instId: input.instId, direction: input.direction, sourceId, sourceText, expiresAt, config }, { id: randomUUID(), mode: this.mode, now }); }
    catch { throw badRequest('方向任务参数不正确：需要明确的 XXX-USDT-SWAP 合约及 long 或 short 方向'); }
    return transaction(this.pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('signal-task-create'))");
      const previous = hydrateTask((await db.query('SELECT state FROM signal_research.tasks WHERE source_id=$1', [sourceId])).rows[0]?.state);
      if (previous) {
        if (previous.instId !== task.instId || previous.direction !== task.direction) throw badRequest('同一来源已登记其他方向；修订请使用新消息 ID', 409);
        return { task: previous, duplicate: true };
      }
      const active = (await db.query('SELECT state FROM signal_research.tasks')).rows.map(r => r.state).filter(isActive);
      if (active.length >= LIMITS.maxTasks) throw badRequest('最多同时观察 10 个方向任务', 409);
      if (active.some(t => t.instId === task.instId)) throw badRequest('该合约已有方向任务，请先取消旧任务并完成平仓', 409);
      await db.query('INSERT INTO signal_research.tasks(id,source_id,state) VALUES($1,$2,$3)', [task.id, sourceId, JSON.stringify(task)]);
      await this.appendEvents(db, task.id, [{ type: 'created', at: now, mode: this.mode, sourceId }]);
      return { task, duplicate: false };
    });
  }
  async save(task, events = [], order = null, settled = false) {
    await transaction(this.pool, async db => {
      await db.query('UPDATE signal_research.tasks SET state=$2,updated_at=now() WHERE id=$1', [task.id, JSON.stringify(task)]);
      if (order) await db.query(`INSERT INTO signal_research.orders(id,task_id,state,settled) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,settled=EXCLUDED.settled`, [order.clOrdId, task.id, JSON.stringify(order), settled]);
      await this.appendEvents(db, task.id, events);
    });
  }
}

export function isActive(task) { return Boolean(task.position || task.pendingOrder) || !['completed', 'expired', 'cancelled', 'canceled'].includes(task.status); }
