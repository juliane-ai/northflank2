const BAR = '15m';
const INTERVAL = 15 * 60 * 1000;
const WARMUP = 72 * 60 * 60 * 1000;
const HISTORY_URL = 'https://www.okx.com/api/v5/market/history-candles';
const INSTRUMENTS_URL = 'https://www.okx.com/api/v5/public/instruments';

function validInstId(value) {
  return typeof value === 'string' && /^[A-Z0-9]{1,24}-USDT-SWAP$/.test(value);
}

function finitePositive(value) {
  const n = Number(value);
  return value !== '' && value !== null && Number.isFinite(n) && n > 0;
}

function epoch(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}

function normalizeInstrument(raw, instId) {
  if (!raw || raw.instId !== instId || raw.instType !== 'SWAP' || raw.ctType !== 'linear'
    || raw.settleCcy !== 'USDT' || raw.state !== 'live'
    || !['ctVal', 'lotSz', 'minSz', 'tickSz'].every((key) => finitePositive(raw[key]))
    || (raw.ctValCcy && raw.ctValCcy !== instId.split('-')[0])) {
    throw new Error('Instrument must be a live linear USDT perpetual with valid contract metadata');
  }
  const numeric = ['ctVal', 'ctMult', 'lotSz', 'minSz', 'tickSz'];
  const instrument = { ...raw };
  for (const key of numeric) {
    if (raw[key] !== undefined && raw[key] !== '') {
      const n = Number(raw[key]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid contract metadata');
      instrument[key] = n;
    }
  }
  if (raw.ctMult === undefined || raw.ctMult === '') instrument.ctMult = 1;
  return instrument;
}

function normalizeRow(row, now) {
  if (!Array.isArray(row) || row.length < 9 || row[8] !== '1') throw new Error('Invalid or unclosed candle');
  const [time, open, high, low, close, volume] = row.slice(0, 6).map(Number);
  if (!Number.isSafeInteger(time) || time <= 0 || time % INTERVAL !== 0 || time + INTERVAL > now
    || ![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)
    || !Number.isFinite(volume) || volume < 0 || low > Math.min(open, close)
    || high < Math.max(open, close) || low > high) throw new Error('Invalid confirmed candle');
  return { time, open, high, low, close, volume };
}

async function requestJson(fetchImpl, url, timeoutMs, retries, signal) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new Error('OKX public request aborted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const response = await fetchImpl(url, { method: 'GET', signal: requestSignal, credentials: 'omit', redirect: 'error' });
      if (!response?.ok) throw new Error('HTTP request failed');
      const body = await response.json();
      if (!body || body.code !== '0' || !Array.isArray(body.data)) throw new Error('Invalid OKX response');
      return body.data;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw new Error('OKX public request aborted');
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * (attempt + 1))));
    } finally { clearTimeout(timer); }
  }
  throw new Error(lastError?.name === 'AbortError' ? 'OKX public request timed out' : 'OKX public request unavailable');
}

/** Download a bounded, read-only OKX replay dataset (15m candles plus 72h warmup). */
export async function fetchReplayDataset({
  instId, from, to, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 10_000,
  retries = 1, maxPages = 40, pageLimit = 100, signal,
} = {}) {
  if (!validInstId(instId)) throw new Error('Expected an OKX USDT perpetual instrument ID');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  for (const [name, value, minimum, maximum] of [
    ['timeoutMs', timeoutMs, 1, 30_000], ['retries', retries, 0, 3],
    ['maxPages', maxPages, 1, 200], ['pageLimit', pageLimit, 1, 100],
  ]) if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid abort signal');
  const start = epoch(from, 'from');
  const end = epoch(to, 'to');
  const current = epoch(now, 'market time');
  if (start % INTERVAL || end % INTERVAL || end <= start || end > Math.floor(current / INTERVAL) * INTERVAL) {
    throw new Error('Invalid replay time range');
  }
  const warmupStart = start - WARMUP;
  if (warmupStart <= 0) throw new Error('Invalid replay warmup range');
  if ((end - warmupStart) / INTERVAL > maxPages * pageLimit) throw new Error('Candle history exceeds pagination bound');
  const instrumentUrl = `${INSTRUMENTS_URL}?instType=SWAP&instId=${encodeURIComponent(instId)}`;
  const instrumentRows = await requestJson(fetchImpl, instrumentUrl, timeoutMs, retries, signal);
  const instrument = normalizeInstrument(instrumentRows.find((row) => row?.instId === instId), instId);

  const byTime = new Map();
  let cursor = end;
  let pages = 0;
  while (pages < maxPages && cursor > warmupStart) {
    const params = new URLSearchParams({ instId, bar: BAR, limit: String(pageLimit), after: String(cursor) });
    const url = `${HISTORY_URL}?${params}`;
    const rows = await requestJson(fetchImpl, url, timeoutMs, retries, signal);
    pages += 1;
    if (!rows.length) break;
    let oldest = Infinity;
    for (const raw of rows) {
      const candle = normalizeRow(raw, current);
      oldest = Math.min(oldest, candle.time);
      if (candle.time < warmupStart || candle.time >= end) continue;
      const previous = byTime.get(candle.time);
      if (previous && JSON.stringify(previous) !== JSON.stringify(candle)) throw new Error('Conflicting duplicate candle');
      byTime.set(candle.time, candle);
    }
    if (!Number.isFinite(oldest) || oldest >= cursor) throw new Error('Candle history pagination did not advance');
    cursor = oldest;
  }
  const expected = [];
  for (let t = warmupStart; t < end; t += INTERVAL) expected.push(t);
  if (pages >= maxPages && !byTime.has(warmupStart)) throw new Error('Candle history exceeds pagination bound');
  if (expected.some((t) => !byTime.has(t))) throw new Error('Candle history has gaps');
  const candles15 = expected.map((t) => byTime.get(t));
  return {
    schemaVersion: 1, instId, from: start, to: end, downloadedAt: current,
    instrument, candles15,
    source: { candles: HISTORY_URL, instruments: INSTRUMENTS_URL, bar: BAR, pages, warmupMs: WARMUP,
      fetchedFrom: warmupStart, fetchedTo: end },
  };
}

export { INTERVAL as CANDLE_INTERVAL_MS, WARMUP as REPLAY_WARMUP_MS };
