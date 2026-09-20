import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { STOCKS, validSymbol } from './catalog.js';
import { transaction } from './database.js';
import { chinaTime, freshQuote, tradingHours } from './market.js';

export function badRequest(message, status = 400) { return Object.assign(new Error(message), { status }); }
function money(value, label, nullable = false, max = 1_000_000, decimals = 2) {
  if (nullable && (value === null || value === '')) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || Math.abs(value * 10 ** decimals - Math.round(value * 10 ** decimals)) > 1e-6) throw badRequest(`${label}格式不正确`);
  return value;
}
function date(value) {
  if (value === '') return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw badRequest('日期格式不正确');
  return value;
}
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw badRequest(`${label}格式不正确`);
  return value.trim();
}
const toRule = (r) => ({ ...r, target: r.target === null ? null : Number(r.target) });

export class StockStore {
  constructor(pool) { this.pool = pool; }

  async initialize() {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('stock-watch-schema-v1'))");
      await db.query(schema);
      const seeded = await db.query("SELECT 1 FROM stock_watch.meta WHERE key='seeded'");
      if (!seeded.rowCount) {
        for (const [index, stock] of STOCKS.entries()) await this.insert(db, { ...stock, position: index });
        await db.query("INSERT INTO stock_watch.meta VALUES ('seeded','1')");
      }
    });
  }

  async insert(db, { symbol, name, sector, position }) {
    await db.query('INSERT INTO stock_watch.stocks(symbol,name,sector,position) VALUES($1,$2,$3,$4)', [symbol, name, sector, position]);
    for (let slot = 1; slot <= 3; slot++) await db.query('INSERT INTO stock_watch.rules(id,symbol,slot) VALUES($1,$2,$3)', [randomUUID(), symbol, slot]);
  }

  async add(input) {
    if (!validSymbol(input.symbol)) throw badRequest('请填写正确的 A 股代码，例如 sh601398');
    const name = text(input.name, 30, '股票名称');
    const sector = text(input.sector, 20, '行业');
    if (!name || !sector) throw badRequest('请填写名称与行业');
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('stock-watch-add'))");
      const { rows } = await db.query('SELECT count(*)::int AS count, COALESCE(max(position),0)+1 AS position FROM stock_watch.stocks');
      if (rows[0].count >= 100) throw badRequest('观察列表最多 100 只股票');
      if ((await db.query('SELECT 1 FROM stock_watch.stocks WHERE symbol=$1', [input.symbol])).rowCount) throw badRequest('股票已在观察列表中');
      await this.insert(db, { symbol: input.symbol, name, sector, position: rows[0].position });
    });
  }

  async list() {
    const [stocks, rules] = await Promise.all([
      this.pool.query('SELECT * FROM stock_watch.stocks ORDER BY position, symbol'),
      this.pool.query('SELECT * FROM stock_watch.rules ORDER BY slot'),
    ]);
    return stocks.rows.map((s) => ({ ...s, dividend: s.dividend === null ? null : Number(s.dividend), rules: rules.rows.filter((r) => r.symbol === s.symbol).map(toRule) }));
  }

  async save(symbol, input, now = Date.now()) {
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.revision)) throw badRequest('设置格式不正确');
    const dividend = money(input.dividend, '分红', true, 10000, 4);
    const asof = date(input.dividend_asof);
    const exDate = date(input.ex_date);
    if (dividend !== null && !asof) throw badRequest('填写分红时，请同时填写统计截止日');
    const note = text(input.note, 500, '备注');
    if (!Array.isArray(input.rules) || input.rules.length !== 3) throw badRequest('需要三个价格档位');
    const rules = input.rules.map((r) => {
      const target = money(r.target, '目标价', true);
      if (target === 0 || typeof r.enabled !== 'boolean') throw badRequest('目标价应大于 0');
      return { target, enabled: r.enabled };
    });
    const values = rules.filter((r) => r.target !== null).map((r) => r.target);
    if (values.some((v, i) => i && v >= values[i - 1])) throw badRequest('各档目标价应依次降低');
    await transaction(this.pool, async (db) => {
      const stock = (await db.query('SELECT * FROM stock_watch.stocks WHERE symbol=$1 FOR UPDATE', [symbol])).rows[0];
      if (!stock) throw badRequest('股票不存在', 404);
      if (stock.revision !== input.revision) throw badRequest('设置已在其他页面更新，请关闭后重新打开', 409);
      await db.query('UPDATE stock_watch.stocks SET enabled=$2,dividend=$3,dividend_asof=$4,ex_date=$5,note=$6,revision=revision+1 WHERE symbol=$1', [symbol, input.enabled, dividend, asof, exDate, note]);
      for (let index = 0; index < 3; index++) {
        const { target, enabled } = rules[index];
        // Only changing a threshold starts a new alert cycle. Saving notes or
        // pausing/resuming a rule must not resend an already-triggered alert.
        await db.query(`UPDATE stock_watch.rules SET
          cycle=CASE WHEN target IS DISTINCT FROM $3::numeric THEN cycle+1 ELSE cycle END,
          triggered_at=CASE WHEN target IS DISTINCT FROM $3::numeric THEN NULL ELSE triggered_at END,
          armed_at=CASE WHEN target IS DISTINCT FROM $3::numeric OR enabled=false OR $6 THEN $5 ELSE armed_at END,
          target=$3,enabled=$4 WHERE symbol=$1 AND slot=$2`, [symbol, index + 1, target, enabled, new Date(now), !stock.enabled]);
      }
    });
  }

  async rearm(id, now = Date.now()) {
    const result = await this.pool.query('UPDATE stock_watch.rules SET triggered_at=NULL,cycle=cycle+1,armed_at=$2 WHERE id=$1 AND triggered_at IS NOT NULL RETURNING symbol', [id, new Date(now)]);
    if (!result.rowCount) throw badRequest('该档位尚未触发或不存在', 409);
  }

  async recordQuotes(quotes) {
    await transaction(this.pool, async (db) => {
      for (const q of quotes) await db.query(`UPDATE stock_watch.stocks SET quote=$2 WHERE symbol=$1
        AND (quote IS NULL OR (quote->>'time')::timestamptz <= $3)`, [q.symbol, JSON.stringify(q), q.time]);
    });
  }

  async evaluate(quotes, { now = Date.now(), webhook = false, demo = false } = {}) {
    if (!demo && !tradingHours(now)) return [];
    const events = [];
    for (const q of quotes) {
      if (!freshQuote(q, now) || (!!q.simulated !== demo)) continue;
      await transaction(this.pool, async (db) => {
        const stock = (await db.query('SELECT * FROM stock_watch.stocks WHERE symbol=$1 FOR UPDATE', [q.symbol])).rows[0];
        if (!stock?.enabled) return;
        const rules = await db.query(`SELECT * FROM stock_watch.rules WHERE symbol=$1 AND enabled
          AND target IS NOT NULL AND triggered_at IS NULL AND armed_at <= $2 FOR UPDATE`, [q.symbol, q.time]);
        for (const r of rules.rows) {
          if (Math.round(q.price * 100) > Math.round(Number(r.target) * 100)) continue;
          const id = randomUUID();
          const snapshot = { symbol: stock.symbol, name: stock.name, price: q.price, target: Number(r.target), slot: r.slot,
            quoteTime: q.time, source: q.source, simulated: demo, exDividend: stock.ex_date === chinaTime(now).date };
          const inserted = await db.query(`INSERT INTO stock_watch.alerts(id,rule_id,cycle,snapshot,created_at,delivery)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(rule_id,cycle) DO NOTHING RETURNING id`,
          [id, r.id, r.cycle, JSON.stringify(snapshot), new Date(now), webhook && !demo ? 'pending' : 'unconfigured']);
          await db.query('UPDATE stock_watch.rules SET triggered_at=$2 WHERE id=$1', [r.id, new Date(now)]);
          if (inserted.rowCount) events.push({ id, ...snapshot });
        }
      });
    }
    return events;
  }

  async alerts() {
    return (await this.pool.query('SELECT id,snapshot,created_at,handled,delivery,attempts FROM stock_watch.alerts ORDER BY created_at DESC LIMIT 200')).rows;
  }

  async handleAlert(id) {
    const result = await this.pool.query('UPDATE stock_watch.alerts SET handled=true WHERE id=$1', [id]);
    if (!result.rowCount) throw badRequest('提醒不存在', 404);
  }

  async plan(month = chinaTime().month) {
    const { rows } = await this.pool.query('SELECT * FROM stock_watch.plans WHERE month=$1', [month]);
    return rows[0] ? Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, k === 'month' ? v : Number(v)]))
      : { month, regular_budget: 0, extra_budget: 0, regular_spent: 0, extra_spent: 0 };
  }

  async savePlan(input) {
    if (input.month !== chinaTime().month) throw badRequest('月份已变化，请刷新后再保存', 409);
    const values = ['regular_budget', 'extra_budget', 'regular_spent', 'extra_spent'].map((key) => money(input[key], '金额', false, 100_000_000));
    await this.pool.query(`INSERT INTO stock_watch.plans VALUES($1,$2,$3,$4,$5) ON CONFLICT(month) DO UPDATE SET
      regular_budget=$2,extra_budget=$3,regular_spent=$4,extra_spent=$5`, [input.month, ...values]);
  }
}
