import { RestClient } from 'okx-api';

const INTERVALS = { '15m': 900_000, '1H': 3_600_000 };
const MARKETS = new Set(['prod', 'GLOBAL', 'OPENAPI_GLOBAL', 'EEA', 'US']);

export function signalMarketRegion(value = 'OPENAPI_GLOBAL') {
  if (!MARKETS.has(value)) throw new Error('Unsupported SIGNAL_OKX_MARKET');
  return value;
}

export function validInstrumentId(value) {
  return typeof value === 'string' && /^[A-Z0-9]{1,24}-USDT-SWAP$/.test(value);
}

function positive(value) {
  return value !== '' && value !== null && Number.isFinite(Number(value)) && Number(value) > 0;
}

export function normalizeInstrument(raw, instId) {
  if (!validInstrumentId(instId) || raw?.instId !== instId || raw.instType !== 'SWAP'
    || raw.ctType !== 'linear' || raw.settleCcy !== 'USDT' || raw.state !== 'live'
    || !['ctVal', 'lotSz', 'minSz', 'tickSz'].every((key) => positive(raw[key]))) {
    throw new Error('Instrument must be a live linear USDT perpetual with valid contract metadata');
  }
  // Keep the production adapter on unit multipliers until every exchange-side
  // quantity and limit has been exercised against a non-unit contract.
  const contractMultiplier = raw.ctMult === undefined || raw.ctMult === '' ? 1 : Number(raw.ctMult);
  if (!positive(contractMultiplier) || contractMultiplier !== 1) throw new Error('Unsupported contract multiplier');
  if (raw.ctValCcy && raw.ctValCcy !== instId.split('-')[0]) throw new Error('Unsupported contract value currency');
  return {
    instId, instType: 'SWAP', ctType: raw.ctType, settleCcy: raw.settleCcy, state: raw.state,
    ctVal: Number(raw.ctVal), ctMult: contractMultiplier,
    lotSz: Number(raw.lotSz), minSz: Number(raw.minSz), tickSz: Number(raw.tickSz),
  };
}

export function normalizeCandles(rows, interval, now, minimum = 15, maxLagMs = 90_000) {
  if (!Array.isArray(rows)) throw new Error('Invalid candle response');
  const candles = rows.filter((row) => Array.isArray(row) && row[8] === '1').map((row) => {
    const [time, open, high, low, close] = row.slice(0, 5).map(Number);
    if (!Number.isSafeInteger(time) || time <= 0 || time % interval !== 0 || time + interval > now
      || ![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)
      || low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
      throw new Error('Invalid confirmed candle');
    }
    return { time, open, high, low, close, confirm: true };
  }).sort((a, b) => a.time - b.time);
  if (candles.length < minimum) throw new Error('Insufficient confirmed candle history');
  for (let i = 1; i < candles.length; i += 1) {
    if (candles[i].time - candles[i - 1].time !== interval) throw new Error('Candle history has gaps or duplicates');
  }
  if (now - candles.at(-1).time - interval > interval + maxLagMs) throw new Error('Stale candle history');
  return candles;
}

/** Anonymous production market data only; never uses the dashboard mock reader or private keys. */
export class SignalMarket {
  constructor(options = {}) {
    this.client = options.client ?? new RestClient({
      market: signalMarketRegion(options.market), demoTrading: false, keepAlive: true,
    }, { timeout: 10_000 });
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? 15_000;
    this.futureToleranceMs = options.futureToleranceMs ?? 2_000;
    this.candleCacheMs = options.candleCacheMs ?? 30_000;
    this.instrumentCacheMs = options.instrumentCacheMs ?? 60_000;
    this.cache = new Map();
  }

  async cached(key, now, ttl, loader) {
    const previous = this.cache.get(key);
    if (previous && now >= previous.time && now - previous.time < ttl) return previous.value;
    const value = await loader();
    this.cache.set(key, { time: now, value });
    return value;
  }

  async quote(instId, now = Date.now()) {
    if (!validInstrumentId(instId)) throw new Error('Expected an OKX USDT perpetual instrument ID');
    try {
      const [instruments, tickers] = await Promise.all([
        this.client.getInstruments({ instType: 'SWAP', instId }), this.client.getTicker({ instId }),
      ]);
      const instrument = normalizeInstrument(instruments?.find(row => row.instId === instId), instId);
      const ticker = tickers?.find(row => row.instId === instId);
      const time = Number(ticker?.ts), bid = Number(ticker?.bidPx), ask = Number(ticker?.askPx);
      if (!Number.isSafeInteger(time) || now - time > this.maxQuoteAgeMs || time - now > this.futureToleranceMs
        || !positive(bid) || !positive(ask) || ask < bid || !positive(ticker?.bidSz) || !positive(ticker?.askSz)) throw new Error('Invalid executable quote');
      return { instId, time, bid, ask, instrument, candles15: [], candles1h: [] };
    } catch { throw new Error('OKX executable quote unavailable'); }
  }

  async frame(instId, now = Date.now()) {
    if (!validInstrumentId(instId)) throw new Error('Expected an OKX USDT perpetual instrument ID');
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid market time');
    try {
      const [instrument, rows15, rows1h, tickers] = await Promise.all([
        this.cached(`instrument:${instId}`, now, this.instrumentCacheMs, async () => {
          const rows = await this.client.getInstruments({ instType: 'SWAP', instId });
          return normalizeInstrument(rows?.find((row) => row.instId === instId), instId);
        }),
        ...Object.entries(INTERVALS).map(([bar, interval]) => this.cached(
          // Re-fetch at the close boundary even while the ordinary TTL is still valid.
          `candles:${instId}:${bar}:${Math.floor(now / interval)}`, now, this.candleCacheMs,
          () => this.client.getCandles({ instId, bar, limit: '150' }),
        )),
        this.client.getTicker({ instId }),
      ]);
      const ticker = tickers?.find((row) => row.instId === instId);
      const time = Number(ticker?.ts);
      const bid = Number(ticker?.bidPx);
      const ask = Number(ticker?.askPx);
      if (!Number.isSafeInteger(time) || time <= 0 || now - time > this.maxQuoteAgeMs
        || time - now > this.futureToleranceMs || !positive(bid) || !positive(ask) || ask < bid
        || !positive(ticker?.bidSz) || !positive(ticker?.askSz)) throw new Error('Missing, stale or invalid executable quote');
      const candles15 = normalizeCandles(rows15, INTERVALS['15m'], now, 15);
      const candles1h = normalizeCandles(rows1h, INTERVALS['1H'], now, 51);
      // Bound caches for long-running processes and expired candle buckets.
      if (this.cache.size > 500) {
        for (const [key, entry] of this.cache) if (now - entry.time > Math.max(this.instrumentCacheMs, this.candleCacheMs)) this.cache.delete(key);
      }
      return { instId, time, bid, ask, instrument, candles15, candles1h };
    } catch (error) {
      // SDK errors can carry authenticated request objects if an injected client is misconfigured.
      const safe = ['Instrument must', 'Unsupported contract', 'Invalid ', 'Insufficient ', 'Candle history', 'Stale candle', 'Missing, stale'];
      if (error instanceof Error && safe.some((prefix) => error.message.startsWith(prefix))) throw new Error(error.message);
      throw new Error('OKX public market data unavailable');
    }
  }
}
