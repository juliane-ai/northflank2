import { createHash } from 'node:crypto';
import { advanceTask, settleOrder } from './strategy.js';
import { badRequest, LIMITS, isActive } from './store.js';

const terminal = order => ['filled', 'canceled', 'rejected'].includes(order.state);
const contracts = task => Number(task.position?.currentContracts ?? task.position?.contracts ?? 0);
const positive = value => Number.isFinite(value) && value > 0;
const side = task => task.direction === 'long' ? 1 : -1;
const clientOrderId = order => order?.clOrdId ?? order?.id;
const orderContracts = order => Number(order?.size ?? order?.contracts);
const closeEnough = (left, right) => Math.abs(left - right) <= 1e-8;
const sameFiniteNumber = (value, expected) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) && Number(value) === Number(expected);
function savedPositive(value, fallback = 1) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  return positive(number) ? number : NaN;
}
function savedLeverage(value) {
  const leverage = value === undefined || value === null || value === '' ? 1 : Number(value);
  return Number.isInteger(leverage) && leverage >= 1 && leverage <= 10 ? leverage : NaN;
}

function expectedPosition(task) {
  if (!['long', 'short'].includes(task.direction)) throw new Error('INVENTORY_MISMATCH');
  const held = task.position ? contracts(task) : 0;
  if (!Number.isFinite(held) || held < 0) throw new Error('INVENTORY_MISMATCH');
  if (!task.pendingOrder) return side(task) * held;
  const order = task.pendingOrder;
  const size = orderContracts(order);
  const filled = order.filledContracts === undefined ? 0 : Number(order.filledContracts);
  if (!['entry', 'exit'].includes(order.kind) || order.instId !== task.instId || order.direction !== task.direction
    || !positive(size) || !Number.isFinite(filled) || filled < 0 || filled > size + 1e-8
    || (order.kind === 'entry' && task.position) || (order.kind === 'exit' && !task.position)) {
    throw new Error('INVENTORY_MISMATCH');
  }
  // The task position is only settled after an order becomes terminal.  Until
  // then, include cumulative partial fills so inventory is still reconciled.
  return side(task) * (held + (order.kind === 'entry' ? filled : -filled));
}

function ownsOpenOrder(row, task) {
  const order = task.pendingOrder;
  const size = orderContracts(order);
  const buy = (task.direction === 'long') === (order.kind === 'entry');
  return row && row.clOrdId === clientOrderId(order) && row.instId === task.instId
    && row.instType === 'SWAP' && row.tdMode === 'isolated' && row.posSide === 'net' && row.ordType === 'market'
    && row.side === (buy ? 'buy' : 'sell') && closeEnough(Number(row.sz), size)
    && String(row.reduceOnly) === String(order.kind === 'exit')
    && (order.kind !== 'entry' || sameFiniteNumber(row.lever, order.leverage))
    && ['live', 'partially_filled'].includes(row.state);
}
function marginUsed(task) {
  if (task.position) {
    const leverage = savedLeverage(task.position.leverage);
    const size = contracts(task), unitValue = savedPositive(task.position.unitValue), price = Number(task.position.entryPrice);
    return [size, unitValue, price, leverage].every(positive) ? size * unitValue * price / leverage : Infinity;
  }
  if (task.pendingOrder?.kind === 'entry') {
    const order = task.pendingOrder;
    const leverage = savedLeverage(order.leverage);
    const price = Number(task.pendingIntent?.expectedPrice || order.expectedPrice);
    const size = Number(order.size || order.contracts), contractValue = Number(order.instrument?.ctVal);
    const contractMultiplier = savedPositive(order.instrument?.ctMult);
    return [size, contractValue, contractMultiplier, price, leverage].every(positive)
      ? size * contractValue * contractMultiplier * price / leverage : Infinity;
  }
  return 0;
}

export class SignalMonitor {
  constructor(store, { market, executor, mode = 'paper', intervalMs = 5000, now = Date.now }) {
    Object.assign(this, { store, market, executor, mode, intervalMs, now });
    this.tail = Promise.resolve(); this.stopped = false; this.leaseValid = true;
    this.lastRunAt = null; this.lastSuccessAt = null; this.error = null;
  }
  exclusive(work) {
    const result = this.tail.then(() => {
      if (!this.leaseValid) throw badRequest('数据库调度锁已断开，服务需重启', 503);
      return work();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  status() { return { running: !this.stopped && this.leaseValid, intervalMs: this.intervalMs, lastRunAt: this.lastRunAt, lastSuccessAt: this.lastSuccessAt, error: this.error }; }
  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped || !this.leaseValid) return;
      try { await this.refresh(); } catch { this.error = '策略调度失败'; }
      if (!this.stopped && this.leaseValid) this.timer = setTimeout(loop, this.intervalMs).unref();
    };
    this.timer = setTimeout(loop, 0).unref();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.tail; }
  loseLease() { this.leaseValid = false; this.stopped = true; clearTimeout(this.timer); this.error = '数据库调度锁断开'; }
  async control(id, action) {
    return this.exclusive(async () => {
      const task = await this.store.get(id);
      if (!['pause', 'resume', 'cancel', 'close'].includes(action)) throw badRequest('不支持该任务操作');
      if (action === 'resume') {
        if (task.pendingOrder || task.position) throw badRequest('请先完成当前订单和持仓处理', 409);
        if (task.expiresAt <= this.now() || ['cancelled', 'canceled', 'completed'].includes(task.status)) throw badRequest('该任务已结束，请新建方向任务', 409);
        // Resuming never changes round counts, loss budget or reuses a confirmation.
        task.paused = false; task.status = 'observing'; task.candidate = null; task.pendingIntent = null; task.closeRequested = false; task.closeReason = null;
      } else {
        task.paused = true;
        if (action === 'close' || action === 'cancel') task.closeRequested = true;
        if (action === 'cancel') task.cancelled = true;
        if (!task.position && !task.pendingOrder) task.status = action === 'cancel' ? 'cancelled' : 'paused';
      }
      await this.store.save(task, [{ type: 'user_control', action, at: this.now() }]);
      return task;
    });
  }
  async settle(task, order) {
    if (!terminal(order)) {
      task.pendingOrder = order;
      if (order.state === 'unknown') task.executionError = '订单状态不明，保持冻结并继续查询；不会重复提交';
      await this.store.save(task, [{ type: 'order_observed', at: this.now(), order }], order);
      return task;
    }
    const next = settleOrder(task, { ...order, id: order.clOrdId, ts: order.time }, this.now());
    const result = next.task ?? next;
    result.pendingOrder = null; result.executionError = null;
    if (result.cancelled && !result.position) result.status = 'cancelled';
    await this.store.save(result, [...(next.events || []), { type: 'order_terminal', at: this.now(), order }], order, true);
    return result;
  }
  async refresh() { return this.exclusive(() => this.tick()); }
  async auditInventory(tasks) {
    if (this.mode !== 'okx-demo' || !this.executor.inventory) return;
    const inventory = await this.executor.inventory();
    if (!inventory || !Array.isArray(inventory.positions) || !Array.isArray(inventory.orders)
      || !Array.isArray(inventory.algoOrders)) throw new Error('INVENTORY_MISMATCH');
    const pending = tasks.filter(t => t.pendingOrder);
    const pendingById = new Map();
    for (const task of pending) {
      const id = clientOrderId(task.pendingOrder);
      if (typeof id !== 'string' || !id || pendingById.has(id)) throw new Error('INVENTORY_MISMATCH');
      pendingById.set(id, task);
    }
    const observedOrders = new Set();
    for (const order of inventory.orders) {
      const task = pendingById.get(order?.clOrdId);
      if (!task || observedOrders.has(order.clOrdId) || !ownsOpenOrder(order, task)) throw new Error('INVENTORY_MISMATCH');
      observedOrders.add(order.clOrdId);
    }
    if (inventory.algoOrders.length) throw new Error('INVENTORY_MISMATCH');
    if (inventory.positions.some(p => !Number.isFinite(Number(p?.pos)))) throw new Error('INVENTORY_MISMATCH');
    const positions = inventory.positions.filter(p => Math.abs(Number(p.pos)) > 1e-10);
    if (positions.some(p => p.instType !== 'SWAP' || p.mgnMode !== 'isolated' || p.posSide !== 'net'
      || typeof p.instId !== 'string' || !p.instId.endsWith('-USDT-SWAP'))) throw new Error('INVENTORY_MISMATCH');
    const symbols = new Set([...positions.map(p => p.instId), ...tasks.filter(t => t.position || t.pendingOrder).map(t => t.instId)]);
    for (const instId of symbols) {
      const instrumentTasks = tasks.filter(t => t.instId === instId);
      const instrumentPositions = positions.filter(p => p.instId === instId);
      const expected = instrumentTasks.reduce((sum, t) => sum + expectedPosition(t), 0);
      const actual = instrumentPositions.reduce((sum, p) => sum + Number(p.pos), 0);
      if (!Number.isFinite(expected) || !Number.isFinite(actual) || !closeEnough(expected, actual)) throw new Error('INVENTORY_MISMATCH');
      if (instrumentPositions.length) {
        const owners = instrumentTasks.filter(t => Math.abs(expectedPosition(t)) > 1e-10);
        if (owners.length !== 1 || instrumentPositions.length !== 1) throw new Error('INVENTORY_MISMATCH');
        const owner = owners[0];
        const leverage = savedLeverage(owner.position ? owner.position.leverage : owner.pendingOrder.leverage);
        if (!sameFiniteNumber(instrumentPositions[0].lever, leverage)) throw new Error('INVENTORY_MISMATCH');
      }
    }
  }
  async tick() {
    this.lastRunAt = this.now(); this.error = null;
    let tasks = await this.store.list();
    // Query durable intents before using current prices, including after a restart.
    for (const task of tasks.filter(t => t.pendingOrder)) {
      try {
        const result = await this.executor.reconcile(task.pendingOrder, task.pendingOrder.executionFrame);
        await this.settle(task, receiptOrder(task.pendingOrder, result));
      } catch { this.error = '模拟订单查询失败，相关任务保持冻结'; }
    }
    tasks = await this.store.list();
    try { await this.auditInventory(tasks); }
    catch { this.error = '模拟盘持仓或挂单与账本不一致，已停止提交订单；请核对专用模拟账户'; return; }
    const frames = new Map();
    for (let task of tasks.filter(isActive)) {
      if (task.pendingOrder) continue;
      let frame;
      try {
        if (!frames.has(task.instId)) {
          let fresh;
          try { fresh = await this.market.frame(task.instId, this.now()); }
          catch (error) {
            if (!task.position || !this.market.quote) throw error;
            fresh = await this.market.quote(task.instId, this.now());
            fresh.historyUnavailable = true;
          }
          await this.store.recordFrame(fresh);
          frames.set(task.instId, fresh);
        }
        frame = frames.get(task.instId);
      } catch {
        this.error = '行情读取失败；新开仓暂停，保护等待有效报价';
        if (!task.marketError) { task.marketError = true; await this.store.save(task, [{ type: 'market_gap', at: this.now() }]); }
        continue;
      }
      const resumed = task.marketError; task.marketError = false;
      if (frame.historyUnavailable) this.error = '历史 K 线暂不可用；已有持仓使用新报价继续保护';
      const evaluated = advanceTask(task, { ...frame, ts: frame.time, candles15m: frame.candles15.map(c => ({ ...c, ts: c.time })), candles1h: frame.candles1h.map(c => ({ ...c, ts: c.time })) }, this.now());
      const next = evaluated.task;
      const events = [...(resumed ? [{ type: 'market_resumed', at: this.now() }] : []), ...(evaluated.events || [])];
      const intent = evaluated.intent;
      if (!intent) { await this.store.save(next, events); continue; }
      if (intent.kind === 'entry') {
        const current = await this.store.list();
        const activeRisk = current.filter(t => t.id !== task.id && (t.position || t.pendingOrder)).reduce((sum, t) => sum + (t.config?.riskPerRound || LIMITS.riskPerRound), 0);
        const realized = current.reduce((sum, t) => sum + (t.rounds || []).reduce((s, r) => s + Number(r.netPnl || 0), 0), 0);
        const margin = current.filter(t => t.id !== task.id).reduce((sum, t) => sum + marginUsed(t), 0);
        const nextMargin = Number(intent.contracts || 0) * Number(frame.instrument.ctVal || 0)
          * savedPositive(frame.instrument.ctMult) * Number(next.pendingIntent?.expectedPrice || 0)
          / savedLeverage(intent.leverage ?? next.config.leverage);
        if (current.some(t => t.pendingOrder) || !Number.isFinite(activeRisk)
          || activeRisk + next.config.riskPerRound > LIMITS.portfolioRisk
          || !Number.isFinite(margin) || !positive(nextMargin) || !Number.isFinite(realized)
          || margin + nextMargin > LIMITS.initialEquity + realized) {
          // Keep the pre-intent state; evaluate again on a later fresh quote.
          task.blockedReason = '组合风险、可用模拟资金或待确认订单限制';
          await this.store.save(task, [{ type: 'portfolio_blocked', at: this.now() }]); continue;
        }
      }
      next.blockedReason = null;
      const sequence = (task.orderSequence || 0) + 1;
      next.orderSequence = sequence;
      const clOrdId = 'sig' + createHash('sha256').update(`${this.mode}:${task.id}:${sequence}`).digest('hex').slice(0, 28);
      const order = { ...intent, id: clOrdId, size: intent.contracts, createdAt: this.now(), stopPrice: intent.stopPx, clOrdId, taskId: task.id, instId: task.instId, direction: task.direction,
        mode: this.mode, state: 'prepared', submittedAt: this.now(), instrument: frame.instrument,
        feeBps: next.config.feeBps, slippageBps: next.config.slippageBps };
      if (this.mode === 'paper') order.executionFrame = { instId: frame.instId, time: frame.time, bid: frame.bid, ask: frame.ask, instrument: frame.instrument };
      next.pendingOrder = order;
      // Commit first. A crash after this point can only reconcile, never resubmit.
      await this.store.save(next, [...events, { type: 'order_prepared', at: this.now(), order }], order);
      if (!this.leaseValid || this.stopped) return;
      try {
        const receipt = await this.executor.execute(order, frame);
        await this.settle(next, receiptOrder(order, receipt));
      } catch {
        next.pendingOrder = { ...order, state: 'unknown' };
        next.executionError = '提交结果不明，等待查询';
        await this.store.save(next, [{ type: 'order_unknown', at: this.now(), clOrdId }], next.pendingOrder);
        this.error = '模拟订单提交结果不明';
      }
    }
    if (!this.error) this.lastSuccessAt = this.now();
  }
}

function receiptOrder(order, receipt) {
  return { ...order, ...receipt, state: ({ cancelled: 'canceled', pending: 'live' })[receipt.status] || receipt.status, filledContracts: receipt.filledSize, avgPx: receipt.avgPrice, feeCcy: 'USDT' };
}
