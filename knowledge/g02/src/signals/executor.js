import { RestClient } from 'okx-api';
import { signalMarketRegion, validInstrumentId } from './market.js';
import { MAX_ENTRY_MARGIN } from './policy.js';

const TERMINAL = new Set(['filled', 'cancelled', 'rejected']);
const OKX_REST_BASE_URLS = new Set([
  'https://www.okx.com', 'https://openapi.okx.com', 'https://eea.okx.com', 'https://us.okx.com',
]);

function positive(value) { return Number.isFinite(value) && value > 0; }
function sideFor(order) { return (order.direction === 'long') === (order.kind === 'entry') ? 'buy' : 'sell'; }
function zeroReceipt(status, time, message, exchangeId) {
  return { status, filledSize: 0, avgPrice: 0, fee: 0, time, ...(message ? { message } : {}), ...(exchangeId ? { exchangeId } : {}) };
}
function apiCode(error) {
  const code = error?.code ?? error?.data?.code ?? error?.response?.data?.code;
  return /^\d{5,6}$/.test(String(code)) ? String(code) : null;
}
function safeApiMessage(prefix, error) {
  const code = apiCode(error);
  return `${prefix}${code ? ` (OKX ${code})` : ''}`;
}
function contractMultiplier(instrument) {
  return instrument?.ctMult === undefined || instrument.ctMult === '' ? 1 : Number(instrument.ctMult);
}
function sameLeverage(value, leverage) {
  const actual = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(actual) && actual === leverage;
}
function sameBoolean(value, expected) {
  return value === expected || value === String(expected);
}
function leverageMatches(rows, instId, leverage) {
  return Array.isArray(rows) && rows.some(row => row?.instId === instId
    && row?.mgnMode === 'isolated' && row?.posSide === 'net' && sameLeverage(row?.lever, leverage));
}

export function validateSignalOrder(order, frame) {
  if (!order || !/^[a-zA-Z0-9]{1,32}$/.test(order.id) || !['entry', 'exit'].includes(order.kind)
    || !['long', 'short'].includes(order.direction) || !validInstrumentId(order.instId)
    || !positive(order.size) || !Number.isSafeInteger(order.createdAt) || order.createdAt <= 0
    || (order.leverage !== undefined && (!Number.isInteger(order.leverage) || order.leverage < 1 || order.leverage > 10))
    || (order.marginPerRound !== undefined && (!positive(order.marginPerRound) || order.marginPerRound < 1 || order.marginPerRound > 500))) {
    throw new Error('Invalid durable signal order');
  }
  const instrument = frame?.instrument;
  const multiplier = contractMultiplier(instrument);
  if (frame?.instId !== order.instId || instrument?.instId !== order.instId || instrument.ctType !== 'linear'
    || instrument.settleCcy !== 'USDT' || instrument.state !== 'live'
    || !['ctVal', 'lotSz', 'minSz', 'tickSz'].every((key) => positive(Number(instrument[key])))
    || !positive(multiplier)
    || !positive(frame.bid) || !positive(frame.ask) || frame.ask < frame.bid || !positive(frame.time)) {
    throw new Error('Order needs a valid linear USDT market frame');
  }
  const lots = order.size / Number(instrument.lotSz);
  if (order.size + 1e-12 < Number(instrument.minSz) || Math.abs(lots - Math.round(lots)) > 1e-8) throw new Error('Order violates contract quantity precision');
  if (order.stopPrice !== undefined && !positive(order.stopPrice)) throw new Error('Invalid initial stop price');
}

/** Fills are calculated solely from the observed executable quote, including adverse slippage. */
export class PaperExecutor {
  mode = 'paper';

  constructor(options = {}) {
    this.slippageRate = options.slippageRate ?? 0.0005;
    this.takerFeeRate = options.takerFeeRate ?? 0.0005;
    if (![this.slippageRate, this.takerFeeRate].every((n) => Number.isFinite(n) && n >= 0 && n < 0.1)) throw new Error('Invalid paper cost configuration');
    this.receipts = new Map();
  }

  async execute(order, frame) {
    if (this.receipts.has(order.id)) return { ...this.receipts.get(order.id) };
    validateSignalOrder(order, frame);
    // The durable intent snapshots costs so a deployment changing constructor defaults
    // cannot change an interrupted paper fill during restart reconciliation.
    const slippageRate = order.slippageBps === undefined ? this.slippageRate : order.slippageBps / 10_000;
    const takerFeeRate = order.feeBps === undefined ? this.takerFeeRate : order.feeBps / 10_000;
    if (![slippageRate, takerFeeRate].every((n) => Number.isFinite(n) && n >= 0 && n < 0.1)) throw new Error('Invalid saved paper cost configuration');
    const buy = sideFor(order) === 'buy';
    const avgPrice = (buy ? frame.ask : frame.bid) * (1 + (buy ? 1 : -1) * slippageRate);
    const receipt = {
      status: 'filled', filledSize: order.size, avgPrice,
      fee: order.size * Number(frame.instrument.ctVal) * contractMultiplier(frame.instrument) * avgPrice * takerFeeRate,
      exchangeId: `paper:${order.id}`, time: frame.time,
    };
    this.receipts.set(order.id, receipt);
    return { ...receipt };
  }

  async reconcile(order, frame) {
    if (this.receipts.has(order.id)) return { ...this.receipts.get(order.id) };
    // An interrupted paper intent has no external side effect. Its saved execution frame can
    // deterministically recreate the fill; callers must persist that frame with the intent.
    return this.execute(order, frame);
  }
}

/** Only accepts a client explicitly configured for the OKX demo environment. */
export class DemoExecutor {
  mode = 'okx-demo';

  constructor(options = {}) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.submissionGuard = options.submissionGuard ?? (() => true);
    this.attempted = new Set();
    this.cancelAttempts = new Map();
    this.receipts = new Map();
    this.leverageConfigured = new Map();
    this.assertDemo();
  }

  static fromEnv(env = process.env) {
    if ((env.SIGNAL_MODE || 'okx-demo') !== 'okx-demo') throw new Error('Demo execution requires SIGNAL_MODE=okx-demo');
    const names = ['SIGNAL_OKX_DEMO_API_KEY', 'SIGNAL_OKX_DEMO_API_SECRET', 'SIGNAL_OKX_DEMO_API_PASSPHRASE'];
    for (const name of names) if (typeof env[name] !== 'string' || !env[name].trim()) throw new Error(`${name} is required`);
    const client = new RestClient({
      apiKey: env.SIGNAL_OKX_DEMO_API_KEY,
      apiSecret: env.SIGNAL_OKX_DEMO_API_SECRET,
      apiPass: env.SIGNAL_OKX_DEMO_API_PASSPHRASE,
      demoTrading: true, market: signalMarketRegion(env.SIGNAL_OKX_MARKET), keepAlive: true,
    }, { timeout: 10_000 });
    return new DemoExecutor({ client });
  }

  assertDemo() {
    if (this.client?.options?.demoTrading !== true
      || String(this.client?.globalRequestOptions?.headers?.['x-simulated-trading']) !== '1'
      || !OKX_REST_BASE_URLS.has(this.client?.baseUrl)) {
      throw new Error('Signal executor refuses a client without forced OKX demo trading');
    }
  }

  setSubmissionGuard(guard) {
    if (typeof guard !== 'function') throw new Error('Submission guard must be a function');
    this.submissionGuard = guard;
  }

  async preflight() {
    this.assertDemo();
    let configuration;
    try { [configuration] = await this.client.getAccountConfiguration(); }
    catch (error) { throw new Error(safeApiMessage('OKX demo account preflight failed', error)); }
    if (configuration?.posMode !== 'net_mode') throw new Error('OKX demo account must use net position mode');
    // Orders are always submitted as isolated contracts.  In `autonomy` mode
    // OKX expects margin to be transferred to each isolated position first;
    // this worker deliberately has no margin-transfer side effect, so fail
    // closed unless the account is configured for automatic isolated-margin
    // funding.  Treat a missing value as incompatible as well.
    if (String(configuration?.ctIsoMode ?? '').toLowerCase() !== 'automatic') {
      throw new Error('OKX demo account must use automatic contract isolated margin mode');
    }
    if (!['2', '3'].includes(String(configuration.acctLv))) throw new Error('OKX demo requires futures or multi-currency margin account mode');
    // `settleCcy`/`settleCcyList` describe the account's USD-margined
    // contract settlement preference. They do not gate USDT-margined
    // instruments such as ETH-USDT-SWAP; the market adapter validates the
    // selected instrument's own settleCcy instead.
    if (!configuration?.perm || !String(configuration.perm).split(',').map((part) => part.trim()).includes('trade')) {
      throw new Error('OKX demo API key needs trade permission');
    }
    // Account identity is persisted by the runtime so changing credentials cannot silently
    // attach an old strategy ledger to a different demo account. Never return keys or config.
    const accountId = String(configuration.uid ?? '').trim();
    if (!accountId || accountId.length > 128) throw new Error('OKX demo account UID is unavailable');
    return { mode: this.mode, accountId, positionMode: 'net_mode', accountLevel: String(configuration.acctLv) };
  }

  async ensureLeverage(order) {
    // Standalone callers may only provide instrument/leverage; execute() calls
    // this for entries and skips it for reduce-only exits.
    if (order.kind !== undefined && order.kind !== 'entry') return;
    const leverage = Number(order.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 10) {
      throw new Error('Invalid order leverage');
    }
    const key = `${order.instId}:isolated`;
    this.assertDemo();
    try {
      // Re-read a cached setting before trusting it. The same demo account can be
      // changed by another task or manually between entries.
      if (this.leverageConfigured.get(key) === leverage) {
        const current = await this.client.getLeverage({ instId: order.instId, mgnMode: 'isolated' });
        if (leverageMatches(current, order.instId, leverage)) return;
        this.leverageConfigured.delete(key);
      }
      const result = await this.client.setLeverage({ instId: order.instId, lever: String(leverage), mgnMode: 'isolated' });
      const acknowledgements = Array.isArray(result) ? result : [result];
      const acknowledgement = acknowledgements[0];
      // The setter may omit the position side; readback below must still be net.
      const rowMatches = acknowledgements.some(row => row?.instId === order.instId
        && row?.mgnMode === 'isolated' && sameLeverage(row?.lever, leverage)
        && (row?.posSide === undefined || row.posSide === '' || row.posSide === 'net'));
      if (!acknowledgement || (acknowledgement.sCode !== undefined && String(acknowledgement.sCode) !== '0')
        || (acknowledgement.sCode === undefined && !rowMatches)) {
        throw new Error('set leverage rejected');
      }
      const rows = await this.client.getLeverage({ instId: order.instId, mgnMode: 'isolated' });
      if (!leverageMatches(rows, order.instId, leverage)) {
        throw new Error('leverage verification mismatch');
      }
      this.leverageConfigured.set(key, leverage);
    } catch (error) {
      throw new Error(safeApiMessage('OKX demo leverage setup failed', error));
    }
  }

  async verifyLeverage(order) {
    if (order.kind !== 'entry') return;
    const leverage = Number(order.leverage);
    try {
      const rows = await this.client.getLeverage({ instId: order.instId, mgnMode: 'isolated' });
      if (!leverageMatches(rows, order.instId, leverage)) throw new Error('leverage verification mismatch');
    } catch (error) {
      throw new Error(safeApiMessage('OKX demo leverage changed before order submission', error));
    }
  }

  async verifyCapacity(order) {
    if (order.kind !== 'entry') return;
    try {
      const rows = await this.client.getMaxBuySellAmount({
        instId: order.instId, tdMode: 'isolated', leverage: String(order.leverage),
      });
      const row = Array.isArray(rows) ? rows.find(item => item?.instId === order.instId) : null;
      const available = Number(sideFor(order) === 'buy' ? row?.maxBuy : row?.maxSell);
      if (!positive(available) || available + 1e-8 < order.size) throw new Error('insufficient available demo margin');
    } catch (error) {
      throw new Error(safeApiMessage('OKX demo available order size check failed', error));
    }
  }

  async inventory() {
    this.assertDemo();
    const pages = async (method, params, idKey) => {
      const result = [];
      let after;
      for (let page = 0; page < 50; page += 1) {
        const rows = await this.client[method]({ ...params, limit: '100', ...(after ? { after } : {}) });
        if (!Array.isArray(rows)) throw new Error('Invalid account inventory');
        result.push(...rows);
        if (rows.length < 100) return result;
        const next = rows.at(-1)?.[idKey];
        if (!next || next === after) throw new Error('Incomplete account inventory');
        after = next;
      }
      throw new Error('Account inventory exceeds safety limit');
    };
    try {
      const [positions, orders, ...algoGroups] = await Promise.all([
        this.client.getPositions({}), pages('getOrderList', {}, 'ordId'),
        // Keep this list aligned with OKX's AlgoOrderType union.  There is no
        // `smart_iceberg` order type on the V5 endpoint; querying it makes a
        // valid demo account look unavailable and would freeze submissions.
        ...['conditional', 'oco', 'trigger', 'move_order_stop', 'iceberg', 'twap', 'chase'].map((ordType) => pages('getAlgoOrderList', { ordType }, 'algoId')),
      ]);
      if (!Array.isArray(positions) || positions.some((row) => !Number.isFinite(Number(row.pos)))) throw new Error('Invalid positions');
      return { positions: positions.filter((row) => Number(row.pos) !== 0), orders, algoOrders: algoGroups.flat() };
    } catch (error) { throw new Error(safeApiMessage('OKX demo inventory unavailable', error)); }
  }

  normalize(row, order) {
    const now = this.now();
    const filledSize = Number(row?.accFillSz || 0);
    const avgPrice = Number(row?.avgPx || 0);
    const rawFee = Number(row?.fee || 0);
    const time = Number(row?.uTime || row?.cTime);
    const expectedLeverage = order.kind === 'entry' ? Number(order.leverage) : null;
    if (!row || row.instId !== order.instId || row.clOrdId !== order.id || row.side !== sideFor(order)
      || row.posSide !== 'net' || row.tdMode !== 'isolated' || row.ordType !== 'market'
      || !sameBoolean(row.reduceOnly, order.kind === 'exit')
      || Number(row.sz) !== order.size || !/^[0-9]+$/.test(String(row.ordId)) || !Number.isFinite(filledSize) || filledSize < 0
      || filledSize > order.size + 1e-8 || !Number.isFinite(avgPrice) || !Number.isFinite(rawFee)
      || (order.kind === 'entry' && (!Number.isInteger(expectedLeverage) || expectedLeverage < 1 || expectedLeverage > 10
        || !sameLeverage(row.lever, expectedLeverage)))
      || (filledSize > 0 && (avgPrice <= 0 || row.feeCcy !== 'USDT' || row.fee === '' || row.fee === undefined))
      || !Number.isSafeInteger(time) || time <= 0) {
      return zeroReceipt('unknown', now, 'Invalid or mismatched OKX demo order details');
    }
    const states = { live: 'pending', partially_filled: 'pending', filled: 'filled', canceled: 'cancelled', mmp_canceled: 'cancelled' };
    const status = states[row.state] ?? 'unknown';
    if (status === 'filled' && Math.abs(filledSize - order.size) > 1e-8) return zeroReceipt('unknown', now, 'Filled order quantity mismatch');
    return {
      status, filledSize, avgPrice, fee: Math.max(0, -rawFee), exchangeId: String(row.ordId), time,
      ...(status === 'unknown' ? { message: 'Unknown OKX demo order state' } : {}),
    };
  }

  async lookup(order) {
    try {
      const rows = await this.client.getOrderDetails({ instId: order.instId, clOrdId: order.id });
      if (!Array.isArray(rows)) return { error: zeroReceipt('unknown', this.now(), 'Invalid OKX demo order response') };
      if (!rows.length) return { absent: true };
      return { receipt: this.normalize(rows[0], order) };
    } catch (error) {
      if (apiCode(error) === '51603') return { absent: true };
      return { error: zeroReceipt('unknown', this.now(), safeApiMessage('OKX demo order reconciliation unavailable', error)) };
    }
  }

  async reconcile(order) {
    this.assertDemo();
    const previous = this.receipts.get(order.id);
    if (previous && TERMINAL.has(previous.status)) return { ...previous };
    let result = await this.lookup(order);
    if (result.receipt?.status === 'pending' && this.now() - order.createdAt >= 15_000) {
      // Market orders should become terminal promptly. Finalize any long-lived unfilled
      // remainder so the engine can immediately manage the actual partially filled size.
      // Only an identity-validated known order may be cancelled; never cancel an unknown ID.
      const attempts = this.cancelAttempts.get(order.id) ?? { count: 0, time: 0 };
      if (attempts.count < 3 && this.now() - attempts.time >= 15_000 && this.submissionGuard() === true) {
        this.assertDemo();
        this.cancelAttempts.set(order.id, { count: attempts.count + 1, time: this.now() });
        try { await this.client.cancelOrder({ instId: order.instId, ordId: result.receipt.exchangeId }); }
        catch { /* A cancellation timeout also requires a fresh authoritative order read. */ }
        const afterCancel = await this.lookup(order);
        if (afterCancel.receipt) result = afterCancel;
        else result.receipt = { ...result.receipt, status: 'unknown', message: 'OKX demo cancellation outcome awaits reconciliation' };
      }
    }
    if (result.receipt) {
      if (previous && (result.receipt.filledSize < previous.filledSize || result.receipt.time < previous.time)) {
        return { ...previous, status: 'unknown', message: 'OKX demo order details regressed; awaiting consistent reconciliation' };
      }
      this.receipts.set(order.id, result.receipt);
      return { ...result.receipt };
    }
    // An absent record after a timeout is not proof that submission failed. Never resubmit.
    return result.error ?? zeroReceipt('unknown', this.now(), 'OKX demo order is not yet found; submission will not be repeated');
  }

  async execute(order, frame) {
    this.assertDemo();
    validateSignalOrder(order, frame);
    if (this.attempted.has(order.id) || this.receipts.has(order.id)) return this.reconcile(order);
    const existing = await this.lookup(order);
    if (existing.receipt) {
      this.receipts.set(order.id, existing.receipt);
      return { ...existing.receipt };
    }
    if (existing.error) return existing.error;
    if (order.kind === 'entry' && (order.leverage === undefined || order.marginPerRound === undefined)) {
      const receipt = zeroReceipt('rejected', this.now(), 'OKX demo entry is missing its saved leverage or margin budget');
      this.receipts.set(order.id, receipt);
      return { ...receipt };
    }
    if (order.kind === 'entry') {
      const slippageBps = order.slippageBps ?? 2;
      const price = (order.direction === 'long' ? frame.ask : frame.bid) * (1 + (order.direction === 'long' ? 1 : -1) * slippageBps / 10_000);
      const margin = order.size * Number(frame.instrument.ctVal) * contractMultiplier(frame.instrument) * price / order.leverage;
      if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 100
        || order.marginPerRound > MAX_ENTRY_MARGIN || !positive(margin) || margin > order.marginPerRound + 1e-8) {
        return zeroReceipt('rejected', this.now(), 'OKX demo entry exceeds its per-round margin budget');
      }
    }
    const now = this.now();
    if (now - order.createdAt > 60_000 || order.createdAt - now > 5_000 || now - frame.time > 15_000 || frame.time - now > 2_000) {
      return zeroReceipt('unknown', now, 'Order intent or executable quote is stale; reconcile before further action');
    }
    if (this.submissionGuard() !== true) return zeroReceipt('unknown', now, 'Runtime lease or lifecycle no longer permits submission');
    try { await this.ensureLeverage(order); }
    catch (error) { return zeroReceipt('rejected', this.now(), error.message); }
    try { await this.verifyLeverage(order); }
    catch (error) { return zeroReceipt('rejected', this.now(), error.message); }
    try { await this.verifyCapacity(order); }
    catch (error) { return zeroReceipt('rejected', this.now(), error.message); }
    if (this.submissionGuard() !== true) return zeroReceipt('unknown', this.now(), 'Runtime lease or lifecycle no longer permits submission');
    this.assertDemo();
    this.attempted.add(order.id);
    let acknowledgement;
    try {
      const rows = await this.client.submitOrder({
        instId: order.instId, clOrdId: order.id, tdMode: 'isolated', posSide: 'net',
        side: sideFor(order), ordType: 'market', sz: String(order.size), reduceOnly: order.kind === 'exit',
      });
      acknowledgement = rows?.[0];
    } catch {
      // Error objects may include request headers; only a fresh read may determine outcome.
      return this.reconcile(order);
    }
    if (acknowledgement?.sCode && acknowledgement.sCode !== '0') {
      if (['50071', '51016'].includes(String(acknowledgement.sCode))) return this.reconcile(order);
      const receipt = zeroReceipt('rejected', this.now(), safeApiMessage('OKX demo order rejected', { code: acknowledgement.sCode }));
      this.receipts.set(order.id, receipt);
      return { ...receipt };
    }
    if (acknowledgement?.sCode !== '0' || acknowledgement?.clOrdId !== order.id || !acknowledgement?.ordId) return this.reconcile(order);
    const receipt = await this.reconcile(order);
    if (receipt.status === 'unknown') receipt.exchangeId = String(acknowledgement.ordId);
    return receipt;
  }
}
