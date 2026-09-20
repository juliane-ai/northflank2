const POSITION_FIELDS = ['subPosId', 'uniqueCode', 'instId', 'posSide', 'openAvgPx', 'markPx', 'subPos', 'upl', 'uplRatio', 'openTime'];

export function timestamp(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function positionPayload(position) {
  return Object.fromEntries(POSITION_FIELDS.map((field) => [field, String(position[field] ?? '')]));
}

export function camelCasePosition(row) {
  return {
    subPosId: row.sub_pos_id, uniqueCode: row.unique_code, instId: row.inst_id, posSide: row.pos_side,
    state: row.state, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, openedAt: row.opened_at,
    closedAt: row.closed_at, openAvgPx: row.open_avg_px, markPx: row.last_mark_px, subPos: row.quantity,
    upl: row.last_upl, uplRatio: row.last_upl_ratio, missingConfirmations: row.miss_count,
    snapshotCount: row.snapshot_count, eventCount: row.event_count,
  };
}
