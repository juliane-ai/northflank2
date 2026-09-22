// User-approved simulation allocation, shared by API/MCP and new submissions.
export const MAX_ENTRY_MARGIN = 100;

// Keep the regular automatic entry surface deliberately small while the
// strategy is still being validated. Read-only market analysis can inspect
// other exact instruments, but new automatic direction tasks use this policy.
export const DEFAULT_AUTO_INSTRUMENTS = Object.freeze([
  'BTC-USDT-SWAP',
  'ETH-USDT-SWAP',
]);

const INSTRUMENT_ID = /^[A-Z0-9]{1,24}-USDT-SWAP$/;

export function normalizeAutoInstruments(value = DEFAULT_AUTO_INSTRUMENTS) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const instruments = [...new Set(raw.map(item => String(item).trim().toUpperCase()).filter(Boolean))];
  if (!instruments.length || instruments.length > 16 || instruments.some(item => !INSTRUMENT_ID.test(item))) {
    throw new Error('SIGNAL_AUTO_INSTRUMENTS 必须是逗号分隔的 USDT 永续合约代码');
  }
  return Object.freeze(instruments);
}

export function autoInstrumentMessage(instruments) {
  return `常规自动开单仅支持：${normalizeAutoInstruments(instruments).join('、')}`;
}
