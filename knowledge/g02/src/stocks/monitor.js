import { demoQuotes, fetchQuotes, tradingHours } from './market.js';

export class StockMonitor {
  constructor(store, { demo = false, intervalMs = 60_000, webhookUrl = '', quoteFetcher = fetchQuotes, fetcher = fetch } = {}) {
    this.store = store;
    this.demo = demo;
    this.intervalMs = intervalMs;
    this.webhookUrl = webhookUrl;
    this.quoteFetcher = quoteFetcher;
    this.fetcher = fetcher;
    this.lastAttempt = 0;
    this.lastSuccess = null;
    this.error = null;
    this.busy = null;
    this.stopping = false;
  }

  status() {
    return { lastAttempt: this.lastAttempt || null, lastSuccess: this.lastSuccess, error: this.error,
      intervalSeconds: this.intervalMs / 1000, marketOpen: tradingHours(), demo: this.demo,
      notifications: this.webhookUrl && !this.demo ? 'webhook' : 'inbox', running: !!this.timer };
  }

  async refresh(force = false) {
    if (this.stopping) return;
    if (this.busy) return this.busy;
    const now = Date.now();
    if (now - this.lastAttempt < (force ? 15_000 : this.intervalMs)) return;
    if (!force && !this.demo && !tradingHours(now)) return;
    this.busy = this.check().finally(() => { this.busy = null; });
    return this.busy;
  }

  async check() {
    this.lastAttempt = Date.now();
    try {
      const stocks = await this.store.list();
      const symbols = stocks.map((stock) => stock.symbol);
      const quotes = this.demo ? demoQuotes(symbols) : await this.quoteFetcher(symbols);
      await this.store.recordQuotes(quotes);
      await this.store.evaluate(quotes, { now: Date.now(), webhook: !!this.webhookUrl, demo: this.demo });
      this.lastSuccess = Date.now();
      this.error = quotes.length < symbols.length ? `本次取得 ${quotes.length}/${symbols.length} 只股票行情；缺失报价保留上次数据` : null;
    } catch {
      this.error = '行情读取失败，保留上次报价；本次未触发新提醒';
    }
  }

  async deliver() {
    if (!this.webhookUrl || this.demo || this.delivering || this.stopping) return;
    this.delivering = this.sendPending().finally(() => { this.delivering = null; });
    return this.delivering;
  }

  async sendPending() {
    const { rows } = await this.store.pool.query("SELECT id,snapshot,attempts FROM stock_watch.alerts WHERE delivery='pending' AND next_attempt<=now() ORDER BY created_at LIMIT 10");
    for (const event of rows) {
      if (this.stopping) break;
      const attempt = event.attempts + 1;
      try {
        const response = await this.fetcher(this.webhookUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': event.id },
          body: JSON.stringify({ event: 'stock.price_reached', id: event.id, ...event.snapshot }) });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Delivery failed');
        await this.store.pool.query("UPDATE stock_watch.alerts SET delivery='sent',attempts=$2 WHERE id=$1", [event.id, attempt]);
      } catch {
        await this.store.pool.query("UPDATE stock_watch.alerts SET delivery=$2,attempts=$3,next_attempt=now()+($4 * interval '1 second') WHERE id=$1",
          [event.id, attempt >= 5 ? 'failed' : 'pending', attempt, Math.min(3600, 60 * 2 ** (attempt - 1))]);
      }
    }
  }

  start() {
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
      this.deliver().catch(() => {});
    }, Math.min(this.intervalMs, 15_000));
    this.refresh(true).catch(() => {});
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([this.busy, this.delivering]);
  }
}
