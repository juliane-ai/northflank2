import { validSymbol } from './catalog.js';

export function chinaTime(now = Date.now()) {
  const date = new Date(now + 8 * 3_600_000);
  return { date: date.toISOString().slice(0, 10), month: date.toISOString().slice(0, 7), weekday: date.getUTCDay(), minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
}

// Public quote timestamps provide the holiday/staleness guard. Weekday hours
// alone are not a complete exchange calendar.
export function tradingHours(now = Date.now()) {
  const { weekday, minute } = chinaTime(now);
  return weekday > 0 && weekday < 6 && ((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900));
}

export function parseQuoteTime(value) {
  if (!/^\d{14}$/.test(value || '')) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}+08:00`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const roundtrip = new Date(time + 8 * 3_600_000).toISOString().slice(0, 19).replace(/[-T:]/g, '');
  return roundtrip === value ? new Date(time).toISOString() : null;
}

export function parseTencent(text, symbols) {
  const allowed = new Set(symbols);
  const quotes = [];
  // The upstream response is JavaScript-shaped text. Never execute it.
  for (const match of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"\r\n]*)";/g)) {
    if (!allowed.has(match[1])) continue;
    const fields = match[2].split('~');
    const price = Number(fields[3]);
    const previousClose = Number(fields[4]);
    const time = parseQuoteTime(fields[30]);
    if (fields.length < 35 || fields[2] !== match[1].slice(2) || !time || !Number.isFinite(price) || price <= 0) continue;
    quotes.push({ symbol: match[1], price, previousClose: previousClose > 0 ? previousClose : null,
      changePct: previousClose > 0 ? (price / previousClose - 1) * 100 : null,
      volume: Math.max(0, Number(fields[6]) || 0), time, source: '腾讯行情', simulated: false });
  }
  return quotes;
}

export function freshQuote(quote, now = Date.now()) {
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0 || quote.volume <= 0) return false;
  const time = Date.parse(quote.time);
  return Number.isFinite(time) && time <= now + 5_000 && now - time <= 180_000 && chinaTime(time).date === chinaTime(now).date;
}

export async function fetchQuotes(symbols, fetcher = fetch) {
  if (!symbols.length) return [];
  if (symbols.length > 100 || !symbols.every(validSymbol)) throw new Error('Invalid quote symbols');
  const response = await fetcher(`https://qt.gtimg.cn/q=${symbols.join(',')}`, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('Quote service unavailable');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 1_000_000) throw new Error('Quote response too large');
  const quotes = parseTencent(new TextDecoder('gb18030').decode(buffer), symbols);
  if (!quotes.length) throw new Error('No valid quotes received');
  return quotes;
}

export function demoQuotes(symbols, now = Date.now()) {
  return symbols.map((symbol, index) => ({ symbol, price: Number((6 + index * 1.37).toFixed(2)), previousClose: 6.2 + index * 1.37,
    changePct: -1.2, volume: 10000, time: new Date(now).toISOString(), source: '模拟数据', simulated: true }));
}
