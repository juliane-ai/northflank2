const sourceLabels = {
  accountConfiguration: '账户配置',
  balance: '账户余额',
  leadTraders: '跟单关系',
  copyPositions: '跟单子仓位',
  accountPositions: '账户聚合仓位',
  openOrders: '账户挂单',
  recentOrders: '近期订单',
  recentFills: '近期成交',
};

function first(items) {
  return Array.isArray(items) ? items[0] ?? {} : {};
}

function nonZero(value) {
  return value !== undefined && value !== null && value !== '' && Number(value) !== 0;
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object?.[key] ?? '']));
}

async function readSource(name, loader) {
  try {
    return { name, ok: true, data: await loader() };
  } catch {
    return {
      name,
      ok: false,
      data: [],
      message: `${sourceLabels[name]}暂时不可用`,
    };
  }
}

export async function buildOverview(reader, now = new Date()) {
  const results = await Promise.all([
    readSource('accountConfiguration', () => reader.getAccountConfiguration()),
    readSource('balance', () => reader.getBalance()),
    readSource('leadTraders', () => reader.getCurrentLeadTraders()),
    readSource('copyPositions', () => reader.getCopyPositions()),
    readSource('accountPositions', () => reader.getAccountPositions()),
    readSource('openOrders', () => reader.getOpenOrders()),
    readSource('recentOrders', () => reader.getRecentOrders()),
    readSource('recentFills', () => reader.getRecentFills()),
  ]);
  const sources = Object.fromEntries(results.map((result) => [result.name, pick(result, ['ok', 'message'])]));
  const data = Object.fromEntries(results.map((result) => [result.name, result.data]));
  const balance = first(data.balance);
  const details = Array.isArray(balance.details) ? balance.details : [];
  const usdt = details.find((asset) => asset.ccy === 'USDT') ?? {};

  return {
    updatedAt: now.toISOString(),
    readOnly: true,
    sources,
    account: {
      totalEq: balance.totalEq ?? '',
      availableEq: usdt.availEq ?? usdt.availBal ?? '',
      config: pick(first(data.accountConfiguration), ['acctLv', 'posMode', 'roleType', 'perm']),
      assets: details
        .filter((asset) => nonZero(asset.eq) || nonZero(asset.cashBal))
        .map((asset) => pick(asset, ['ccy', 'eq', 'eqUsd', 'availEq', 'availBal', 'cashBal', 'frozenBal', 'upl'])),
    },
    leadTraders: (Array.isArray(data.leadTraders) ? data.leadTraders : []).map((lead) =>
      pick(lead, [
        'uniqueCode',
        'nickName',
        'ccy',
        'margin',
        'copyTotalAmt',
        'upl',
        'todayPnl',
        'copyTotalPnl',
        'profitSharingRatio',
        'beginCopyTime',
        'leadMode',
      ]),
    ),
    copyPositions: (Array.isArray(data.copyPositions) ? data.copyPositions : []).map((position) =>
      pick(position, [
        'subPosId',
        'uniqueCode',
        'instId',
        'instType',
        'posSide',
        'mgnMode',
        'lever',
        'openAvgPx',
        'markPx',
        'margin',
        'subPos',
        'availSubPos',
        'upl',
        'uplRatio',
        'openTime',
        'tpTriggerPx',
        'slTriggerPx',
      ]),
    ),
    accountPositions: (Array.isArray(data.accountPositions) ? data.accountPositions : [])
      .filter((position) => nonZero(position.pos))
      .map((position) =>
        pick(position, [
          'posId',
          'instId',
          'instType',
          'pos',
          'posSide',
          'mgnMode',
          'avgPx',
          'markPx',
          'liqPx',
          'lever',
          'margin',
          'upl',
          'uplRatio',
          'cTime',
          'uTime',
        ]),
      ),
    openOrders: (Array.isArray(data.openOrders) ? data.openOrders : []).map((order) =>
      pick(order, [
        'ordId',
        'instId',
        'side',
        'posSide',
        'tdMode',
        'ordType',
        'state',
        'sz',
        'accFillSz',
        'avgPx',
        'px',
        'reduceOnly',
        'cTime',
        'uTime',
      ]),
    ),
    recentOrders: (Array.isArray(data.recentOrders) ? data.recentOrders : []).map((order) =>
      pick(order, [
        'ordId',
        'instId',
        'side',
        'posSide',
        'tdMode',
        'ordType',
        'state',
        'sz',
        'accFillSz',
        'avgPx',
        'px',
        'reduceOnly',
        'cTime',
        'uTime',
      ]),
    ),
    recentFills: (Array.isArray(data.recentFills) ? data.recentFills : []).map((fill) =>
      pick(fill, [
        'tradeId',
        'ordId',
        'instId',
        'side',
        'posSide',
        'fillPx',
        'fillSz',
        'fee',
        'feeCcy',
        'execType',
        'ts',
      ]),
    ),
  };
}

export function normalizeCopySettings(items) {
  const settings = first(items);
  return pick(settings, [
    'uniqueCode',
    'copyState',
    'copyMode',
    'copyAmt',
    'copyRatio',
    'copyTotalAmt',
    'copyMgnMode',
    'copyInstIdType',
    'instIds',
    'tpRatio',
    'slRatio',
    'slTotalAmt',
    'subPosCloseType',
  ]);
}
