// Deterministic state machine: no exchange calls, timers, or inferred fills.
import { MAX_ENTRY_MARGIN } from './policy.js';
export const STRATEGY_VERSION = 'pullback-protection-v1';
const BAR = 15 * 60_000;
const HOUR = 4 * BAR;
const EPSILON = 1e-10;
const COST_PROTECTION_BUFFER_ATR = 0.5;
const PROTECTIVE_EXIT_REASONS = Object.freeze(['protective_stop', 'cost_protection_unavailable']);
const MAX_COST_DOMINATED_ROUNDS = 2;

export const DEFAULT_CONFIG = Object.freeze({
  riskPerRound: 25,
  riskBudget: 75,
  maxNotional: 1000,
  marginPerRound: 100,
  leverage: 3,
  maxRounds: 3,
  maxHoldMs: 48 * HOUR,
  pullbackAtr: 1.5,
  invalidationAtr: 3,
  initialStopAtr: 2,
  breakevenAtr: 1,
  trailingAtr: 1,
  confirmationCandles: 3,
  cooldownCandles: 2,
  feeBps: 5,
  slippageBps: 2,
  fundingReserveBps: 3,
  bufferBps: 2,
  maxQuoteAgeMs: 30_000,
  maxSpreadBps: 30,
});

const CONFIG_BOUNDS = {
  riskPerRound: [0.01, 25], riskBudget: [0.01, 75], maxNotional: [1, 1000],
  marginPerRound: [1, 500], leverage: [1, 10, true],
  maxRounds: [1, 3, true], maxHoldMs: [BAR, 48 * HOUR, true],
  pullbackAtr: [0.5, 3], invalidationAtr: [1, 6], initialStopAtr: [1, 4],
  breakevenAtr: [0.5, 3], trailingAtr: [0.5, 3],
  confirmationCandles: [1, 3, true], cooldownCandles: [2, 16, true],
  feeBps: [0, 100], slippageBps: [0, 100], fundingReserveBps: [0, 100],
  bufferBps: [0, 100], maxQuoteAgeMs: [1000, 30_000, true], maxSpreadBps: [1, 30],
};

function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function time(value) { return Number.isSafeInteger(value) && value >= 0; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateConfig(input = {}) {
  assert(plain(input), 'config must be an object');
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(input)) {
    const bounds = CONFIG_BOUNDS[key];
    assert(bounds, `Unknown config field: ${key}`);
    assert(typeof value === 'number' && Number.isFinite(value) && value >= bounds[0] && value <= bounds[1]
      && (!bounds[2] || Number.isInteger(value)), `Invalid config field: ${key}`);
    config[key] = value;
  }
  assert(config.riskPerRound <= config.riskBudget, 'riskPerRound exceeds riskBudget');
  assert(config.invalidationAtr > config.pullbackAtr, 'invalidationAtr must exceed pullbackAtr');
  return config;
}

function normalizeSavedConfig(value) {
  assert(value === undefined || plain(value), 'Invalid saved task config');
  const source = value === undefined ? {} : Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
  return validateConfig(source);
}

export function createTask(input, { id, mode = 'paper', now } = {}) {
  assert(plain(input), 'Task input must be an object');
  const allowed = new Set(['instId', 'direction', 'sourceId', 'sourceText', 'expiresAt', 'config']);
  for (const key of Object.keys(input)) assert(allowed.has(key), `Unknown task field: ${key}`);
  assert(typeof id === 'string' && id.length > 0 && id.length <= 128, 'Task id is required');
  assert(['paper', 'okx-demo'].includes(mode), 'Only paper and OKX demo modes are supported');
  assert(time(now), 'Invalid creation time');
  assert(typeof input.instId === 'string' && /^[A-Z0-9]{2,20}-USDT-SWAP$/.test(input.instId), 'Expected an exact USDT swap instrument id');
  assert(['long', 'short'].includes(input.direction), 'direction must be long or short');
  assert(typeof input.sourceId === 'string' && input.sourceId.trim().length > 0 && input.sourceId.length <= 512, 'sourceId is required');
  assert(input.sourceText === undefined || (typeof input.sourceText === 'string' && input.sourceText.length <= 10_000), 'Invalid sourceText');
  const expiresAt = input.expiresAt ?? now + 24 * HOUR;
  assert(time(expiresAt) && expiresAt > now && expiresAt <= now + 24 * HOUR, 'expiresAt must be within the next 24 hours');
  return {
    id, mode, instId: input.instId, direction: input.direction,
    sourceId: input.sourceId, sourceText: input.sourceText ?? '',
    source: { id: input.sourceId, text: input.sourceText ?? '' },
    createdAt: now, updatedAt: now, expiresAt, strategyVersion: STRATEGY_VERSION,
    config: validateConfig(input.config), status: 'observing', paused: false,
    round: 0, rounds: [], position: null, candidate: null, pendingIntent: null,
    plannedRiskUsed: 0, realizedLoss: 0, realizedNet: 0, smallProfitStreak: 0,
    autoReentryDisabled: false, lastFrameTs: null, settledOrderIds: [],
  };
}

function event(type, data, ts) { return { type, data, ts }; }
function side(task) { return task.direction === 'long' ? 1 : -1; }
function roundQuantity(value, step) { return Number((Math.floor((value + EPSILON) / step) * step).toPrecision(12)); }
function roundStop(value, tick, direction) {
  return Number(((direction === 1 ? Math.ceil(value / tick - EPSILON) : Math.floor(value / tick + EPSILON)) * tick).toPrecision(12));
}
function instrumentData(instrument) {
  assert(plain(instrument), 'Missing instrument metadata');
  for (const key of ['ctVal', 'lotSz', 'minSz', 'tickSz']) assert(positive(Number(instrument[key])), `Invalid instrument ${key}`);
  const multiplier = instrument.ctMult === undefined || instrument.ctMult === '' ? 1 : Number(instrument.ctMult);
  assert(positive(multiplier), 'Invalid instrument ctMult');
  assert(instrument.state === undefined || instrument.state === 'live', 'Instrument is not live');
  assert(instrument.ctType === undefined || instrument.ctType === 'linear', 'Only linear contracts are supported');
  assert(instrument.settleCcy === undefined || instrument.settleCcy === 'USDT', 'Only USDT settlement is supported');
  return {
    unitValue: Number(instrument.ctVal) * multiplier,
    lotSz: Number(instrument.lotSz), minSz: Number(instrument.minSz), tickSz: Number(instrument.tickSz),
  };
}

function closedCandles(rows, interval, quoteTs, minimum) {
  assert(Array.isArray(rows), 'Missing closed candle history');
  const candles = rows.filter((row) => time(row?.ts) && row.ts + interval <= quoteTs);
  assert(candles.length >= minimum, 'Insufficient closed candle history');
  for (let i = 0; i < candles.length; i += 1) {
    const row = candles[i];
    assert(['open', 'high', 'low', 'close'].every((key) => positive(row[key]))
      && row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close)
      && row.high >= row.low, 'Invalid candle prices');
    assert(i === 0 || row.ts - candles[i - 1].ts === interval, 'Candle history has gaps or duplicates');
  }
  assert(quoteTs - candles.at(-1).ts < interval * 2 + 60_000, 'Closed candle history is stale');
  return candles;
}

function ema(rows, period) {
  let value = rows.slice(0, period).reduce((sum, row) => sum + row.close, 0) / period;
  const weight = 2 / (period + 1);
  for (let i = period; i < rows.length; i += 1) value += weight * (rows[i].close - value);
  return value;
}

function indicators(frame) {
  const candles15m = closedCandles(frame.candles15m, BAR, frame.ts, 15);
  const candles1h = closedCandles(frame.candles1h, HOUR, frame.ts, 50);
  const ranges = candles15m.slice(1).map((row, i) => Math.max(row.high - row.low,
    Math.abs(row.high - candles15m[i].close), Math.abs(row.low - candles15m[i].close)));
  let atr = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
  for (let i = 14; i < ranges.length; i += 1) atr = (atr * 13 + ranges[i]) / 14;
  assert(positive(atr), 'ATR must be positive');
  const fast = ema(candles1h, 20);
  const slow = ema(candles1h, 50);
  const close = candles1h.at(-1).close;
  return { atr, ema20: fast, ema50: slow, hourClose: close, candles15m, hourTs: candles1h.at(-1).ts,
    trend: fast > slow && close > slow ? 'long' : fast < slow && close < slow ? 'short' : 'neutral' };
}

function fundingPerUnit(position, config, now) {
  // Conservative reserve per commenced 8-hour window, explicitly an estimate.
  const windows = Math.max(1, Math.ceil(Math.max(0, now - position.openedAt) / (8 * HOUR)));
  return position.entryPrice * config.fundingReserveBps / 10_000 * windows;
}

function breakeven(position, config, direction, now) {
  const fee = config.feeBps / 10_000;
  const slip = config.slippageBps / 10_000;
  const entryFeePerUnit = position.entryFee / (position.initialContracts * position.unitValue);
  const costs = entryFeePerUnit + fundingPerUnit(position, config, now);
  const buffer = position.entryPrice * config.bufferBps / 10_000;
  const price = direction === 1
    ? (position.entryPrice + costs + buffer) / ((1 - slip) * (1 - fee))
    : (position.entryPrice - costs - buffer) / ((1 + slip) * (1 + fee));
  return roundStop(price, position.tickSz, direction);
}

function protectionThresholds(position, config, direction, now) {
  const target = breakeven(position, config, direction, now);
  const activation = Math.max(config.breakevenAtr * position.atr,
    direction * (target - position.entryPrice) + COST_PROTECTION_BUFFER_ATR * position.atr);
  return { target, activation, activationPrice: position.entryPrice + direction * activation };
}

// Machine-readable facts for analysis consumers. Parameters come from the same
// normalized config and constants used by execution; risk is never a PnL target.
function strategyRules(config) {
  return {
    authority: 'deterministic_execution_state_machine', version: STRATEGY_VERSION,
    budget: { currency: 'USDT', marginPerRound: Math.min(config.marginPerRound, MAX_ENTRY_MARGIN),
      marginPerRoundCap: MAX_ENTRY_MARGIN, leverage: config.leverage,
      maxEntryNotional: Math.min(config.maxNotional, Math.min(config.marginPerRound, MAX_ENTRY_MARGIN) * config.leverage),
      riskPerRound: config.riskPerRound, riskPerRoundMeaning: 'planned_loss_risk_cap_not_profit_target',
      totalRiskBudget: config.riskBudget, maxRounds: config.maxRounds,
      sizing: 'minimum_of_remaining_risk_notional_and_margin_limits_rounded_down_to_lot_size' },
    entry: { trendTimeframeMs: HOUR, signalTimeframeMs: BAR, atrPeriod: 14,
      trend: { long: 'ema20 > ema50 && hourClose > ema50', short: 'ema20 < ema50 && hourClose < ema50' },
      pullbackAtr: config.pullbackAtr, invalidationAtr: config.invalidationAtr,
      observationAtrFixed: true, referenceTracksFavorableMidUntilPullback: true,
      confirmation: { long: 'closedCandle.close > previousCandle.high', short: 'closedCandle.close < previousCandle.low',
        maxCandles: config.confirmationCandles, latestClosedCandleRequired: true, laterQuoteRequired: true },
      initialStopAtr: config.initialStopAtr },
    protection: { trigger: 'favorable_executable_price_distance', quoteSide: { long: 'bid', short: 'ask' },
      atrBasis: 'fixed_at_entry', activationAtr: config.breakevenAtr,
      costBreakevenBufferAtr: COST_PROTECTION_BUFFER_ATR,
      activationDistance: 'max(activationAtr * entryAtr, directionSign * (costBreakeven - entryPrice) + costBreakevenBufferAtr * entryAtr)',
      activationComparison: 'directionSign * (favorablePrice - entryPrice) >= activationDistance',
      directionSign: { long: 1, short: -1 }, fixedProfitTriggerUsdt: null,
      costBreakeven: { entryFee: 'actual_or_conservative_estimate_if_unknown', exitFeeBps: config.feeBps,
        exitSlippageBps: config.slippageBps, fundingReserveBps: config.fundingReserveBps,
        fundingWindowMs: 8 * HOUR, minimumFundingWindows: 1, fundingWindowRounding: 'ceil_elapsed_windows',
        bufferBps: config.bufferBps, fundingBasis: 'conservative_estimate',
        long: '(entryPrice + entryFeePerUnit + fundingPerUnit + bufferPerUnit) / ((1 - slippageRate) * (1 - feeRate))',
        short: '(entryPrice - entryFeePerUnit - fundingPerUnit - bufferPerUnit) / ((1 + slippageRate) * (1 + feeRate))',
        tickRounding: { long: 'up', short: 'down' } },
      trailingAtr: config.trailingAtr,
      trailingStop: 'round_to_tick(favorablePrice - directionSign * trailingAtr * entryAtr)',
      stopAdjustment: { long: 'max(previousStop, costBreakeven, trailingStop)', short: 'min(previousStop, costBreakeven, trailingStop)' },
      stopOnlyTightens: true, previousStopCheckedBeforeAdjustment: true,
      maxHoldMs: config.maxHoldMs, fixedTakeProfitUsdt: null, fixedTakeProfitPrice: null },
    reentry: { sameDirectionOnly: true, requiresFullExit: true, requiresProtectedPosition: true,
      allowedExitReasons: [...PROTECTIVE_EXIT_REASONS], minimumRoundNetPnl: 0,
      netPnlBasis: 'actual_fills_fees_and_conservative_funding_estimate', requiresKnownFees: true,
      requiresUnpausedUnexpiredTask: true, requiresRemainingRoundsAndRisk: true,
      cooldownCandles: config.cooldownCandles, candleMs: BAR,
      cooldownUntil: 'floor(exitFillTime / candleMs) * candleMs + cooldownCandles * candleMs',
      requiresFreshPullbackAndConfirmation: true, requiresMatchingHourTrend: true,
      costDominatedRound: 'roundNetPnl < max(0, roundTotalCost)',
      pauseAfterConsecutiveCostDominatedRounds: MAX_COST_DOMINATED_ROUNDS },
  };
}

function exitIntent(task, reason, now, events) {
  const intent = {
    kind: 'exit', instId: task.instId, direction: task.direction,
    contracts: task.position.contracts, reason, atr: task.position.atr, stopPx: task.position.stop,
  };
  task.pendingIntent = { ...intent, issuedAt: now };
  task.status = 'exit_pending';
  events.push(event('exit_requested', intent, now));
  return intent;
}

function managePosition(task, frame, now, events) {
  const position = task.position;
  const direction = side(task);
  const executable = direction === 1 ? frame.bid : frame.ask;
  if (task.closeRequested) return exitIntent(task, task.closeReason || 'user_close', now, events);
  if (now - position.openedAt >= task.config.maxHoldMs) return exitIntent(task, 'max_hold', now, events);
  // Check the previously established stop before changing it at this quote.
  if (direction * (executable - position.stop) <= 0) {
    return exitIntent(task, position.protected ? 'protective_stop' : 'initial_stop', now, events);
  }
  position.favorable = direction === 1 ? Math.max(position.favorable, executable) : Math.min(position.favorable, executable);
  const { target, activation } = protectionThresholds(position, task.config, direction, now);
  const canActivate = direction * (position.favorable - position.entryPrice) >= activation;
  if (position.protected || canActivate) {
    const wasProtected = position.protected;
    const oldStop = position.stop;
    const trail = roundStop(position.favorable - direction * task.config.trailingAtr * position.atr, position.tickSz, direction);
    position.stop = direction === 1 ? Math.max(position.stop, target, trail) : Math.min(position.stop, target, trail);
    position.protected = true;
    position.breakeven = target;
    if (!wasProtected || oldStop !== position.stop) {
      events.push(event(wasProtected ? 'protection_moved' : 'breakeven_enabled', {
        round: task.round, oldStop, stop: position.stop, breakeven: target, favorable: position.favorable,
        fundingBasis: 'conservative_estimate',
      }, now));
    }
    if (direction * (executable - position.stop) <= 0) return exitIntent(task, 'cost_protection_unavailable', now, events);
  }
  position.costs.fundingEstimate = fundingPerUnit(position, task.config, now) * position.contracts * position.unitValue;
  return null;
}

function invalidateCandidate(task, hourTs, reason, now, events) {
  task.candidate = null;
  task.status = 'awaiting_hour';
  task.waitAfterHourTs = hourTs;
  events.push(event('candidate_invalidated', { reason, waitAfterHourTs: hourTs }, now));
}

function pause(task, reason, now, events) {
  task.paused = true;
  task.pauseReason = reason;
  task.status = task.position ? 'holding' : 'paused';
  events.push(event('task_paused', { reason }, now));
}

function makeEntryIntent(task, frame, data, instrument, now, events) {
  const direction = side(task);
  const rawPrice = direction === 1 ? frame.ask : frame.bid;
  const entryPrice = rawPrice * (1 + direction * task.config.slippageBps / 10_000);
  const distance = task.config.initialStopAtr * data.atr;
  const stopPx = roundStop(entryPrice - direction * distance, instrument.tickSz, direction);
  if (!positive(stopPx) || direction * (entryPrice - stopPx) <= 0) {
    invalidateCandidate(task, data.hourTs, 'invalid_stop', now, events);
    return null;
  }
  const costsPerUnit = entryPrice * (2 * task.config.feeBps + 2 * task.config.slippageBps
    + task.config.fundingReserveBps + task.config.bufferBps) / 10_000;
  if (costsPerUnit >= distance) {
    invalidateCandidate(task, data.hourTs, 'costs_exceed_stop_distance', now, events);
    return null;
  }
  const remaining = Math.min(task.config.riskBudget - task.plannedRiskUsed, task.config.riskBudget - task.realizedLoss);
  const budget = Math.min(task.config.riskPerRound, remaining);
  const riskPerContract = (distance + costsPerUnit) * instrument.unitValue;
  const marginPerRound = Math.min(task.config.marginPerRound, MAX_ENTRY_MARGIN);
  const marginNotional = marginPerRound * task.config.leverage;
  const contracts = roundQuantity(Math.min(budget / riskPerContract,
    task.config.maxNotional / (entryPrice * instrument.unitValue),
    marginNotional / (entryPrice * instrument.unitValue)), instrument.lotSz);
  if (!positive(contracts) || contracts < instrument.minSz) {
    pause(task, 'insufficient_risk_budget_or_minimum_size', now, events);
    return null;
  }
  const intent = { kind: 'entry', instId: task.instId, direction: task.direction, contracts,
    leverage: task.config.leverage, marginPerRound,
    reason: 'pullback_confirmed', atr: data.atr, stopPx };
  task.pendingIntent = { ...intent, ...instrument, plannedRisk: contracts * riskPerContract,
    marginNotional,

    riskPerContract, expectedPrice: entryPrice, issuedAt: now };
  task.status = 'entry_pending';
  events.push(event('entry_requested', { ...intent, plannedRisk: task.pendingIntent.plannedRisk,
    notional: contracts * instrument.unitValue * entryPrice }, now));
  return intent;
}

export function advanceTask(original, frame, now) {
  assert(time(now), 'Invalid evaluation time');
  const task = structuredClone(original);
  task.config = normalizeSavedConfig(task.config);
  const events = [];
  const result = (intent = null) => ({ task, intent, events });
  if (!plain(frame) || frame.instId !== task.instId || !time(frame.ts)
    || !positive(frame.bid) || !positive(frame.ask) || frame.ask < frame.bid
    || frame.ts > now + 1000 || now - frame.ts > task.config.maxQuoteAgeMs) {
    events.push(event('market_rejected', { reason: 'invalid_or_stale_quote' }, now));
    return result();
  }
  if (task.lastFrameTs !== null && frame.ts <= task.lastFrameTs) return result();
  task.lastFrameTs = frame.ts;
  task.updatedAt = now;
  if (task.pendingIntent) return result();
  if (task.position) return result(managePosition(task, frame, now, events));
  if (task.paused || task.cancelled || ['completed', 'canceled', 'cancelled', 'expired'].includes(task.status)) return result();
  if (now >= task.expiresAt) {
    task.status = 'expired';
    task.candidate = null;
    events.push(event('task_expired', {}, now));
    return result();
  }
  if (task.round >= task.config.maxRounds) {
    task.status = 'completed';
    return result();
  }
  if (task.status === 'cooldown' && now < task.cooldownUntil) return result();
  let data;
  let instrument;
  try {
    instrument = instrumentData(frame.instrument);
    data = indicators(frame);
    assert((frame.ask - frame.bid) / ((frame.ask + frame.bid) / 2) * 10_000 <= task.config.maxSpreadBps,
      'Spread exceeds configured bound');
  } catch (error) {
    events.push(event('market_rejected', { reason: error.message }, now));
    return result();
  }
  if (task.status === 'awaiting_hour' && data.hourTs <= task.waitAfterHourTs) return result();
  if (data.trend !== task.direction) {
    if (task.candidate) invalidateCandidate(task, data.hourTs, 'trend_filter_failed', now, events);
    return result();
  }
  const mid = (frame.bid + frame.ask) / 2;
  const direction = side(task);
  if (!task.candidate || task.status === 'cooldown') {
    task.status = 'observing';
    task.candidate = { reference: mid, atr: data.atr, startedAt: frame.ts, hourTs: data.hourTs,
      lastCandleTs: data.candles15m.at(-1).ts, confirmationCount: 0 };
    events.push(event('observation_started', { reference: mid, atr: data.atr, round: task.round + 1 }, now));
    return result();
  }
  const candidate = task.candidate;
  if (task.status === 'observing') {
    candidate.reference = direction === 1 ? Math.max(candidate.reference, mid) : Math.min(candidate.reference, mid);
  }
  const adverse = direction * (candidate.reference - mid);
  if (adverse > task.config.invalidationAtr * candidate.atr) {
    invalidateCandidate(task, data.hourTs, 'extreme_adverse_move', now, events);
    return result();
  }
  if (task.status === 'entry_ready') {
    if (frame.ts > candidate.readyAt) return result(makeEntryIntent(task, frame, data, instrument, now, events));
    return result();
  }
  if (task.status === 'observing' && adverse >= task.config.pullbackAtr * candidate.atr) {
    task.status = 'waiting_confirmation';
    candidate.pullbackAt = frame.ts;
    candidate.lastCandleTs = data.candles15m.at(-1).ts;
    events.push(event('pullback_reached', { reference: candidate.reference, price: mid, atr: candidate.atr }, now));
    return result();
  }
  if (task.status === 'waiting_confirmation') {
    for (let i = 1; i < data.candles15m.length; i += 1) {
      const candle = data.candles15m[i];
      if (candle.ts <= candidate.lastCandleTs || candle.ts + BAR <= candidate.pullbackAt) continue;
      candidate.lastCandleTs = candle.ts;
      candidate.confirmationCount += 1;
      const previous = data.candles15m[i - 1];
      const confirmed = direction === 1 ? candle.close > previous.high : candle.close < previous.low;
      // An old breakout seen only after a data gap is not a current executable signal.
      if (confirmed && i === data.candles15m.length - 1) {
        task.status = 'entry_ready';
        candidate.readyAt = frame.ts;
        candidate.confirmedCandleTs = candle.ts;
        events.push(event('entry_confirmed', { candleTs: candle.ts, close: candle.close }, now));
        return result();
      }
      if (candidate.confirmationCount >= task.config.confirmationCandles) {
        invalidateCandidate(task, data.hourTs, 'confirmation_timeout', now, events);
        return result();
      }
    }
  }
  return result();
}

// Read-only explanation: share the exact engine calculations, advance only a
// clone, and never save an intent or call an executor from this path.
export function inspectStrategy(original, frame, now) {
  const task = structuredClone(original);
  task.config = normalizeSavedConfig(task.config);
  assert(frame?.instId === task.instId && time(frame.ts) && time(now)
    && positive(frame.bid) && positive(frame.ask) && frame.ask >= frame.bid
    && frame.ts <= now + 1000 && now - frame.ts <= task.config.maxQuoteAgeMs, 'Invalid analysis quote');
  const instrument = instrumentData(frame.instrument);
  let data = null;
  try { data = indicators(frame); } catch (error) { if (!task.position) throw error; }
  const mid = (frame.ask + frame.bid) / 2;
  const spreadBps = (frame.ask - frame.bid) / mid * 10_000;
  const direction = side(task);
  const preview = advanceTask(task, frame, now);
  let sizing = null;
  if (data && !task.position && !task.pendingOrder && !task.pendingIntent) {
    const estimate = structuredClone(task);
    if (makeEntryIntent(estimate, frame, data, instrument, now, [])) {
      const intent = estimate.pendingIntent;
      const notional = intent.contracts * instrument.unitValue * intent.expectedPrice;
      const expectedPosition = { entryPrice: intent.expectedPrice,
        entryFee: notional * task.config.feeBps / 10_000,
        initialContracts: intent.contracts, unitValue: instrument.unitValue,
        atr: intent.atr, tickSz: instrument.tickSz, openedAt: now };
      const thresholds = protectionThresholds(expectedPosition, task.config, direction, now);
      sizing = { contracts: intent.contracts, entryPriceEstimate: intent.expectedPrice, notional,
        marginEstimate: notional / intent.leverage, marginBudget: intent.marginPerRound,
        leverage: intent.leverage, initialStop: intent.stopPx, plannedRisk: intent.plannedRisk,
        costBreakevenEstimate: thresholds.target, protectionActivationPriceEstimate: thresholds.activationPrice,
        protectionActivationDistanceEstimate: thresholds.activation,
        hypothetical: true, accountCapacityChecked: false };
    }
  }
  const candidate = preview.task.candidate;
  const reference = candidate?.reference ?? mid;
  const atr = candidate?.atr ?? data?.atr;
  const remainingRisk = Math.max(0, Math.min(task.config.riskBudget - task.plannedRiskUsed, task.config.riskBudget - task.realizedLoss));
  const check = (code, passed, label) => ({ code, passed, label });
  const checks = [
    check('trend', data?.trend === task.direction, '小时趋势与任务方向一致'),
    check('spread', spreadBps <= task.config.maxSpreadBps, '买卖价差在策略范围内'),
    check('enabled', !task.paused && !task.cancelled && !['completed', 'expired', 'cancelled', 'canceled'].includes(task.status), '任务允许新开仓'),
    check('expiry', now < task.expiresAt, '方向任务仍在有效期内'),
    check('rounds', task.round < task.config.maxRounds && remainingRisk > 0, '轮数和累计风险仍有余量'),
    check('cooldown', task.status !== 'cooldown' || now >= task.cooldownUntil, '重入冷却已结束'),
    check('no_exposure', !task.position && !task.pendingOrder && !task.pendingIntent, '已有仓位及订单已处理'),
    check('confirmation', preview.intent?.kind === 'entry', '回撤、后续收盘确认与新报价均满足'),
  ];
  let protection = null;
  if (task.position) {
    const position = task.position;
    const { target, activation, activationPrice } = protectionThresholds(position, task.config, direction, now);
    const exitPrice = (direction === 1 ? frame.bid : frame.ask) * (1 - direction * task.config.slippageBps / 10_000);
    const units = position.contracts * position.unitValue;
    const entryFees = position.entryFee * position.contracts / position.initialContracts;
    const exitFees = units * exitPrice * task.config.feeBps / 10_000;
    const fundingEstimate = fundingPerUnit(position, task.config, now) * units;
    protection = { active: position.protected, activeAfterQuote: preview.task.position?.protected ?? position.protected,
      entryPrice: position.entryPrice, contracts: position.contracts,
      currentStop: position.stop, stopAfterQuote: preview.task.position?.stop ?? position.stop,
      costBreakeven: target, activationPrice, activationDistance: activation,
      trailingDistance: position.atr * task.config.trailingAtr,
      executableExit: direction === 1 ? frame.bid : frame.ask,
      remainingPositionNetEstimate: direction * (exitPrice - position.entryPrice) * units - entryFees - exitFees - fundingEstimate,
      fundingEstimate, feesKnown: position.feeKnown !== false, fundingBasis: 'conservative_estimate',
      exitReason: preview.intent?.kind === 'exit' ? preview.intent.reason : null };
  }
  return {
    version: task.strategyVersion, readOnly: true, taskId: task.id, direction: task.direction, asOf: now,
    strategyRules: strategyRules(task.config),
    market: { instId: frame.instId, quoteTime: frame.ts, quoteAgeMs: Math.max(0, now - frame.ts), bid: frame.bid, ask: frame.ask, mid, spreadBps,
      historyAvailable: Boolean(data), atr15m: data?.atr ?? null, atrPercent: data ? data.atr / mid * 100 : null,
      ema20: data?.ema20 ?? null, ema50: data?.ema50 ?? null, hourClose: data?.hourClose ?? null,
      hourClosedAt: data ? data.hourTs + HOUR : null, candle15ClosedAt: data ? data.candles15m.at(-1).ts + BAR : null,
      trend: data?.trend ?? 'unavailable' },
    budget: { marginPerRound: Math.min(task.config.marginPerRound, MAX_ENTRY_MARGIN), leverage: task.config.leverage,
      maxNotional: task.config.maxNotional, riskPerRound: task.config.riskPerRound, remainingRisk,
      remainingRounds: Math.max(0, task.config.maxRounds - task.round) },
    state: { saved: task.status, afterQuote: preview.task.status, actionAtQuote: preview.intent?.kind ?? 'wait',
      reason: preview.intent?.reason ?? null, pendingOrder: Boolean(task.pendingOrder), checks,
      transitions: preview.events.map(e => ({ type: e.type, data: e.data })) },
    entry: { reference, referenceIsSaved: Boolean(task.candidate),
      pullbackPrice: atr ? reference - direction * task.config.pullbackAtr * atr : null,
      invalidationPrice: atr ? reference - direction * task.config.invalidationAtr * atr : null,
      confirmationRule: direction === 1 ? '后续已收盘15分钟K线收盘高于前一根最高价，再等新报价' : '后续已收盘15分钟K线收盘低于前一根最低价，再等新报价',
      sizing },
    protection,
    reentry: { cooldownUntil: task.cooldownUntil ?? null, cooldownCandles: task.config.cooldownCandles,
      autoReentryDisabled: task.autoReentryDisabled, lastExitReason: task.rounds.at(-1)?.exitReason ?? null,
      completedRounds: task.rounds.length, realizedNet: task.realizedNet,
      rule: `仅已启用保护的仓位因保护退出而完全平仓、扣除手续费和预估资金费后净结果非负，才可按原方向重入；退出后第${task.config.cooldownCandles}个15分钟边界结束冷却，再等小时趋势、新回撤、收盘确认及新报价。任务须未暂停且未过期，轮数与风险须有余量；费用不明、亏损或连续${MAX_COST_DOMINATED_ROUNDS}轮净收益低于成本均暂停重入` },
    limitations: ['分析不推进任务或下单，后台执行前仍需核验账户、风险与最新行情', '数量和成本为当前报价估算；保证金不含手续费，资金费为预留估算', '候选参数尚无已验证盈利结论'],
  };
}

export function settleOrder(original, order, now) {
  assert(time(now), 'Invalid settlement time');
  const task = structuredClone(original);
  const events = [];
  assert(plain(order) && typeof order.id === 'string' && order.id.length > 0, 'Order id is required');
  if (task.settledOrderIds.includes(order.id)) return { task, events };
  task.config = normalizeSavedConfig(task.config);
  const pending = task.pendingIntent;
  assert(pending && pending.kind === order.kind, 'No matching pending intent');
  const state = order.state ?? order.status;
  assert(['filled', 'canceled', 'rejected'].includes(state), 'Only terminal orders may be settled');
  assert(typeof order.filledContracts === 'number' && Number.isFinite(order.filledContracts)
    && order.filledContracts >= 0 && order.filledContracts <= pending.contracts + EPSILON, 'Invalid filled quantity');
  assert(state !== 'rejected' || order.filledContracts === 0, 'Rejected orders cannot have fills');
  assert(state !== 'filled' || Math.abs(order.filledContracts - pending.contracts) <= EPSILON,
    'A filled terminal order must account for the full requested quantity');
  assert(typeof order.fee === 'number' && Number.isFinite(order.fee), 'Invalid fee');
  assert(order.feeCcy === undefined || order.feeCcy === 'USDT', 'Only USDT fees can be settled');
  const filled = order.filledContracts;
  const fillTs = order.ts ?? order.fillTs ?? now;
  assert(time(fillTs) && fillTs <= now + 1000, 'Invalid fill timestamp');
  if (filled > 0) assert(positive(order.avgPx), 'Filled order requires an average price');
  const feeKnown = order.feeKnown !== false;
  task.pendingIntent = null;
  task.settledOrderIds.push(order.id);
  task.updatedAt = now;
  if (!feeKnown) task.autoReentryDisabled = true;
  events.push(event('order_settled', { orderId: order.id, kind: order.kind, state, filledContracts: filled,
    avgPx: filled > 0 ? order.avgPx : null, fee: order.fee, feeKnown }, now));
  if (filled === 0) {
    if (order.kind === 'entry') {
      invalidateCandidate(task, task.candidate?.hourTs ?? 0, 'entry_unfilled', now, events);
    } else {
      task.status = 'holding';
      // A failed exit remains an exit requirement, even if the next quote recovers.
      task.closeRequested = true;
      task.closeReason = pending.reason;
    }
    return { task, events };
  }
  if (order.kind === 'entry') {
    assert(!task.position, 'An entry cannot overwrite an open position');
    const leverage = pending.leverage === undefined ? 1 : Number(pending.leverage);
    const marginPerRound = pending.marginPerRound === undefined ? task.config.marginPerRound : Number(pending.marginPerRound);
    assert(Number.isInteger(leverage) && leverage >= 1 && leverage <= 10, 'Invalid saved entry leverage');
    assert(positive(marginPerRound) && marginPerRound <= 500, 'Invalid saved entry margin budget');
    const fee = feeKnown ? order.fee : Math.max(order.fee,
      filled * pending.unitValue * order.avgPx * task.config.feeBps / 10_000);
    const direction = side(task);
    const stopFromFill = roundStop(order.avgPx - direction * task.config.initialStopAtr * pending.atr, pending.tickSz, direction);
    const stop = direction === 1 ? Math.max(pending.stopPx, stopFromFill) : Math.min(pending.stopPx, stopFromFill);
    const plannedRisk = pending.plannedRisk * filled / pending.contracts;
    task.round += 1;
    task.plannedRiskUsed += plannedRisk;
    task.position = {
      round: task.round, initialContracts: filled, contracts: filled, entryPrice: order.avgPx,
      leverage,
      entryFee: fee, feeKnown, costs: { entryFees: fee, exitFees: 0, fundingEstimate: 0 },
      atr: pending.atr, stop, initialStop: stop, favorable: order.avgPx, protected: false,
      openedAt: fillTs, unitValue: pending.unitValue, tickSz: pending.tickSz,
      plannedRisk, grossRealized: 0, netRealized: -fee, fundingRealized: 0,
      exitContracts: 0, exitValue: 0, entryOrderId: order.id, exitOrderIds: [],
    };
    task.candidate = null;
    task.status = 'holding';
    const fillRisk = filled * pending.unitValue * (Math.max(0, direction * (order.avgPx - stop))
      + order.avgPx * (task.config.feeBps + task.config.slippageBps + task.config.fundingReserveBps) / 10_000) + Math.max(0, fee);
    if (filled * pending.unitValue * order.avgPx > task.config.maxNotional + EPSILON
      || filled * pending.unitValue * order.avgPx / leverage > marginPerRound + EPSILON
      || fillRisk > task.config.riskPerRound + EPSILON
      || task.realizedLoss + fillRisk > task.config.riskBudget + EPSILON
      || direction * (order.avgPx - stop) <= 0) {
      task.closeRequested = true;
      task.closeReason = 'fill_exceeded_risk_limit';
      pause(task, task.closeReason, now, events);
    }
    events.push(event('position_opened', { round: task.round, contracts: filled, entryPrice: order.avgPx,
      stop, plannedRisk, feeKnown }, now));
    return { task, events };
  }
  const position = task.position;
  assert(position && filled <= position.contracts + EPSILON, 'Exit exceeds the open position');
  const units = filled * position.unitValue;
  const fee = feeKnown ? order.fee : Math.max(order.fee, units * order.avgPx * task.config.feeBps / 10_000);
  const gross = side(task) * (order.avgPx - position.entryPrice) * units;
  const funding = fundingPerUnit(position, task.config, fillTs) * units;
  position.contracts = Math.max(0, Number((position.contracts - filled).toPrecision(12)));
  position.costs.exitFees += fee;
  position.grossRealized += gross;
  position.fundingRealized += funding;
  position.netRealized += gross - fee - funding;
  position.feeKnown &&= feeKnown;
  position.exitContracts += filled;
  position.exitValue += filled * order.avgPx;
  position.exitOrderIds.push(order.id);
  if (position.contracts > EPSILON) {
    task.status = 'holding';
    task.closeRequested = true;
    task.closeReason = pending.reason;
    events.push(event('partial_exit', { remainingContracts: position.contracts, round: task.round }, now));
    return { task, events };
  }
  const totalCost = position.entryFee + position.costs.exitFees + position.fundingRealized;
  const round = { ...position, closedAt: fillTs, exitPrice: position.exitValue / position.exitContracts,
    exitReason: pending.reason, grossPnl: position.grossRealized, netPnl: position.netRealized,
    totalCost, fundingEstimate: position.fundingRealized, pnlBasis: 'fees_and_conservative_funding_estimate' };
  task.rounds.push(round);
  task.realizedNet += round.netPnl;
  task.realizedLoss += Math.max(0, -round.netPnl);
  task.smallProfitStreak = round.netPnl < Math.max(0, totalCost) ? task.smallProfitStreak + 1 : 0;
  task.position = null;
  task.closeRequested = false;
  task.closeReason = null;
  events.push(event('round_closed', { round: task.round, exitReason: round.exitReason, netPnl: round.netPnl,
    totalCost, pnlBasis: round.pnlBasis, feeKnown: position.feeKnown }, now));
  const protective = PROTECTIVE_EXIT_REASONS.includes(pending.reason) && position.protected;
  if (task.paused) task.status = 'paused';
  else if (now >= task.expiresAt) task.status = 'expired';
  else if (task.round >= task.config.maxRounds) task.status = 'completed';
  else if (!protective || round.netPnl < 0 || task.autoReentryDisabled || task.smallProfitStreak >= MAX_COST_DOMINATED_ROUNDS
    || task.plannedRiskUsed >= task.config.riskBudget || task.realizedLoss >= task.config.riskBudget) {
    pause(task, task.autoReentryDisabled ? 'unknown_execution_fees'
      : !protective ? 'non_protective_exit' : round.netPnl < 0 ? 'negative_net_exit'
        : task.smallProfitStreak >= MAX_COST_DOMINATED_ROUNDS ? 'consecutive_cost_dominated_rounds' : 'risk_budget_exhausted', now, events);
  } else {
    task.status = 'cooldown';
    task.cooldownUntil = Math.floor(fillTs / BAR) * BAR + task.config.cooldownCandles * BAR;
    events.push(event('cooldown_started', { until: task.cooldownUntil, nextRound: task.round + 1 }, now));
  }
  return { task, events };
}
