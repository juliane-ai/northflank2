import { RestClient } from 'okx-api';

const ALLOWED_MARKETS = new Set(['prod', 'GLOBAL', 'OPENAPI_GLOBAL', 'EEA', 'US']);

function createClient(env) {
  const rawMarket = env.OKX_MARKET?.trim();
  const market = rawMarket?.toLowerCase() === 'prod' ? 'prod' : rawMarket?.toUpperCase();
  if (market && !ALLOWED_MARKETS.has(market)) {
    throw new Error('OKX_MARKET must be GLOBAL, OPENAPI_GLOBAL, EEA, or US');
  }

  return new RestClient(
    {
      apiKey: env.OKX_API_KEY,
      apiSecret: env.OKX_API_SECRET,
      apiPass: env.OKX_API_PASSPHRASE,
      demoTrading: env.OKX_SIMULATED === '1',
      keepAlive: true,
      ...(market ? { market } : {}),
    },
    { timeout: 15_000 },
  );
}

export class OkxReadClient {
  constructor(client) {
    this.client = client;
  }

  static fromEnv(env = process.env) {
    for (const key of ['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE']) {
      if (!env[key]) {
        throw new Error(`${key} is required unless OKX_MOCK=1`);
      }
    }
    return new OkxReadClient(createClient(env));
  }

  getAccountConfiguration() {
    return this.client.getAccountConfiguration();
  }

  getBalance() {
    return this.client.getBalance();
  }

  getAccountPositions() {
    return this.client.getPositions({ instType: 'SWAP' });
  }

  getOpenOrders() {
    return this.client.getOrderList({ instType: 'SWAP', limit: '50' });
  }

  getRecentOrders() {
    return this.client.getOrderHistory({ instType: 'SWAP', limit: '50' });
  }

  getRecentFills() {
    return this.client.getFills({ instType: 'SWAP', limit: '50' });
  }

  getCurrentLeadTraders() {
    return this.client.getCopytradingMyLeadTraders({ instType: 'SWAP' });
  }

  getCopyPositions() {
    return this.client.getCopytradingSubpositions({
      instType: 'SWAP',
      subPosType: 'copy',
    });
  }

  getCopySettings(uniqueCode) {
    return this.client.getCopytradingCopySettings({
      instType: 'SWAP',
      uniqueCode,
    });
  }
}

export class MockOkxReadClient {
  getAccountConfiguration() {
    return Promise.resolve([
      { acctLv: '2', posMode: 'long_short_mode', roleType: '2', perm: 'read_only' },
    ]);
  }

  getBalance() {
    return Promise.resolve([
      {
        totalEq: '12842.67',
        details: [
          {
            ccy: 'USDT',
            eq: '12842.67',
            eqUsd: '12842.67',
            availEq: '10754.21',
            availBal: '10754.21',
            cashBal: '12430.18',
            frozenBal: '0',
            upl: '412.49',
          },
          {
            ccy: 'BTC',
            eq: '0.00042',
            eqUsd: '48.12',
            availEq: '0.00042',
            availBal: '0.00042',
            cashBal: '0.00042',
            frozenBal: '0',
            upl: '0',
          },
        ],
      },
    ]);
  }

  getAccountPositions() {
    return Promise.resolve([
      {
        posId: '900001',
        instId: 'BTC-USDT-SWAP',
        instType: 'SWAP',
        pos: '0.38',
        posSide: 'long',
        mgnMode: 'cross',
        avgPx: '116240.5',
        markPx: '118412.8',
        liqPx: '93214.2',
        lever: '8',
        margin: '5521.42',
        upl: '825.47',
        uplRatio: '0.1495',
        cTime: String(Date.now() - 5_760_000),
        uTime: String(Date.now() - 2_000),
      },
    ]);
  }

  getOpenOrders() {
    return Promise.resolve([]);
  }

  getRecentOrders() {
    return Promise.resolve([
      {
        ordId: '8100000001',
        instId: 'BTC-USDT-SWAP',
        instType: 'SWAP',
        side: 'buy',
        posSide: 'long',
        tdMode: 'cross',
        ordType: 'market',
        state: 'filled',
        sz: '0.12',
        accFillSz: '0.12',
        avgPx: '116240.5',
        px: '',
        reduceOnly: 'false',
        source: '',
        cTime: String(Date.now() - 5_760_000),
        uTime: String(Date.now() - 5_759_400),
      },
      {
        ordId: '8100000002',
        instId: 'ETH-USDT-SWAP',
        instType: 'SWAP',
        side: 'sell',
        posSide: 'short',
        tdMode: 'isolated',
        ordType: 'market',
        state: 'filled',
        sz: '0.55',
        accFillSz: '0.55',
        avgPx: '4518.4',
        px: '',
        reduceOnly: 'false',
        source: '',
        cTime: String(Date.now() - 2_820_000),
        uTime: String(Date.now() - 2_819_600),
      },
    ]);
  }

  getRecentFills() {
    return Promise.resolve([
      {
        tradeId: '9100000001',
        ordId: '8100000001',
        instId: 'BTC-USDT-SWAP',
        instType: 'SWAP',
        side: 'buy',
        posSide: 'long',
        fillPx: '116240.5',
        fillSz: '0.12',
        fee: '-0.3487215',
        feeCcy: 'USDT',
        execType: 'T',
        ts: String(Date.now() - 5_759_400),
      },
      {
        tradeId: '9100000002',
        ordId: '8100000002',
        instId: 'ETH-USDT-SWAP',
        instType: 'SWAP',
        side: 'sell',
        posSide: 'short',
        fillPx: '4518.4',
        fillSz: '0.55',
        fee: '-0.248512',
        feeCcy: 'USDT',
        execType: 'T',
        ts: String(Date.now() - 2_819_600),
      },
    ]);
  }

  getCurrentLeadTraders() {
    return Promise.resolve([
      {
        uniqueCode: 'A81C47D94E2F119B',
        nickName: 'Delta Rider',
        ccy: 'USDT',
        margin: '1360.00',
        copyTotalAmt: '4000',
        upl: '184.31',
        todayPnl: '96.28',
        copyTotalPnl: '1842.73',
        profitSharingRatio: '0.1',
        beginCopyTime: String(Date.now() - 42 * 86_400_000),
        leadMode: 'public',
      },
      {
        uniqueCode: '9F7B11C3640ADE20',
        nickName: 'North Star',
        ccy: 'USDT',
        margin: '728.46',
        copyTotalAmt: '2500',
        upl: '-26.84',
        todayPnl: '-26.84',
        copyTotalPnl: '516.09',
        profitSharingRatio: '0.08',
        beginCopyTime: String(Date.now() - 18 * 86_400_000),
        leadMode: 'public',
      },
    ]);
  }

  getCopyPositions() {
    return Promise.resolve([
      {
        subPosId: '7100000001',
        uniqueCode: 'A81C47D94E2F119B',
        instId: 'BTC-USDT-SWAP',
        instType: 'SWAP',
        posSide: 'long',
        mgnMode: 'cross',
        lever: '8',
        openAvgPx: '116240.5',
        markPx: '118412.8',
        margin: '860.00',
        subPos: '0.12',
        availSubPos: '0.12',
        upl: '260.68',
        uplRatio: '0.3031',
        openTime: String(Date.now() - 5_760_000),
        tpTriggerPx: '',
        slTriggerPx: '',
      },
      {
        subPosId: '7100000002',
        uniqueCode: 'A81C47D94E2F119B',
        instId: 'ETH-USDT-SWAP',
        instType: 'SWAP',
        posSide: 'short',
        mgnMode: 'isolated',
        lever: '5',
        openAvgPx: '4518.4',
        markPx: '4469.7',
        margin: '500.00',
        subPos: '0.55',
        availSubPos: '0.55',
        upl: '26.79',
        uplRatio: '0.0536',
        openTime: String(Date.now() - 2_820_000),
        tpTriggerPx: '',
        slTriggerPx: '4580',
      },
      {
        subPosId: '7100000003',
        uniqueCode: '9F7B11C3640ADE20',
        instId: 'SOL-USDT-SWAP',
        instType: 'SWAP',
        posSide: 'long',
        mgnMode: 'cross',
        lever: '3',
        openAvgPx: '248.31',
        markPx: '245.27',
        margin: '728.46',
        subPos: '8',
        availSubPos: '8',
        upl: '-24.32',
        uplRatio: '-0.0334',
        openTime: String(Date.now() - 1_260_000),
        tpTriggerPx: '',
        slTriggerPx: '',
      },
    ]);
  }

  getCopySettings(uniqueCode) {
    return Promise.resolve([
      {
        uniqueCode,
        copyState: '1',
        copyMode: uniqueCode.startsWith('A') ? 'fixed_amount' : 'ratio_copy',
        copyAmt: uniqueCode.startsWith('A') ? '500' : '',
        copyRatio: uniqueCode.startsWith('A') ? '' : '0.35',
        copyTotalAmt: uniqueCode.startsWith('A') ? '4000' : '2500',
        copyMgnMode: 'copy',
        copyInstIdType: 'copy',
        instIds: [],
        tpRatio: '',
        slRatio: '',
        slTotalAmt: '',
        subPosCloseType: 'copy_close',
      },
    ]);
  }
}
