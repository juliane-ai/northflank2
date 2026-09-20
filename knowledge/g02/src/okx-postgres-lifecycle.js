import { transaction } from './postgres.js';
import { camelCasePosition, positionPayload, timestamp } from './lifecycle-model.js';

const numericFields = ['first_seen_at', 'last_seen_at', 'opened_at', 'closed_at', 'last_snapshot_at', 'snapshot_count', 'event_count'];

export class PostgresPositionLifecycleStore {
  constructor(pool, { snapshotIntervalMs = 15_000, closeConfirmations = 2 } = {}) {
    this.pool = pool;
    this.snapshotIntervalMs = Number.isFinite(snapshotIntervalMs) && snapshotIntervalMs > 0 ? snapshotIntervalMs : 15_000;
    this.closeConfirmations = Number.isFinite(closeConfirmations) && closeConfirmations >= 2 ? Math.floor(closeConfirmations) : 2;
  }

  async observe(copyPositions, { observedAt = Date.now(), sourceOk = true } = {}) {
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw new Error('Invalid observation timestamp');
    return transaction(this.pool, async (db) => {
      // Serialize complete observations, including the duplicate check, across connections.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('okx-observation'))");
      const previous = (await db.query("SELECT value FROM okx_research.research_meta WHERE key='last_observation_at'")).rows[0];
      if (observedAt <= Number(previous?.value ?? 0)) return { recorded: false, reason: 'duplicate' };
      await db.query(`INSERT INTO okx_research.research_meta VALUES('last_observation_at',$1),('last_source_ok',$2)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(observedAt), sourceOk ? '1' : '0']);
      if (!sourceOk) return { recorded: false, reason: 'source_unavailable' };
      const seen = new Set();
      let opened = 0;
      let closed = 0;
      let snapshots = 0;
      for (const raw of Array.isArray(copyPositions) ? copyPositions : []) {
        const p = positionPayload(raw);
        if (!p.subPosId || seen.has(p.subPosId)) continue;
        seen.add(p.subPosId);
        const existing = (await db.query('SELECT * FROM okx_research.lifecycle_positions WHERE sub_pos_id=$1', [p.subPosId])).rows[0];
        if (!existing) {
          await db.query(`INSERT INTO okx_research.lifecycle_positions(
            sub_pos_id,unique_code,inst_id,pos_side,state,first_seen_at,last_seen_at,opened_at,
            open_avg_px,last_mark_px,quantity,last_upl,last_upl_ratio,last_snapshot_at)
            VALUES($1,$2,$3,$4,'OBSERVING',$5,$5,$6,$7,$8,$9,$10,$11,$5)`,
          [p.subPosId,p.uniqueCode,p.instId,p.posSide,observedAt,timestamp(p.openTime,observedAt),p.openAvgPx,p.markPx,p.subPos,p.upl,p.uplRatio]);
          await this.event(db, p.subPosId, 'COPIED_OPEN_DETECTED', observedAt, p);
          await this.snapshot(db, p, observedAt);
          opened++;
          snapshots++;
          continue;
        }
        await db.query(`UPDATE okx_research.lifecycle_positions SET unique_code=$2,inst_id=$3,pos_side=$4,
          state='OBSERVING',last_seen_at=$5,closed_at=NULL,open_avg_px=$6,last_mark_px=$7,quantity=$8,
          last_upl=$9,last_upl_ratio=$10,miss_count=0 WHERE sub_pos_id=$1`,
        [p.subPosId,p.uniqueCode,p.instId,p.posSide,observedAt,p.openAvgPx,p.markPx,p.subPos,p.upl,p.uplRatio]);
        if (existing.state !== 'OBSERVING') await this.event(db, p.subPosId, 'POSITION_REAPPEARED', observedAt, p);
        if (observedAt - Number(existing.last_snapshot_at) >= this.snapshotIntervalMs) {
          await this.snapshot(db, p, observedAt);
          await db.query('UPDATE okx_research.lifecycle_positions SET last_snapshot_at=$2 WHERE sub_pos_id=$1', [p.subPosId,observedAt]);
          snapshots++;
        }
      }
      const active = await db.query("SELECT sub_pos_id,miss_count FROM okx_research.lifecycle_positions WHERE state='OBSERVING'");
      for (const row of active.rows) {
        if (seen.has(row.sub_pos_id)) continue;
        const missing = row.miss_count + 1;
        if (missing >= this.closeConfirmations) {
          await db.query("UPDATE okx_research.lifecycle_positions SET state='CLOSED_DETECTED',closed_at=$2,miss_count=$3 WHERE sub_pos_id=$1", [row.sub_pos_id,observedAt,missing]);
          await this.event(db, row.sub_pos_id, 'CLOSE_DETECTED', observedAt, { missingConfirmations: missing });
          closed++;
        } else await db.query('UPDATE okx_research.lifecycle_positions SET miss_count=$2 WHERE sub_pos_id=$1', [row.sub_pos_id,missing]);
      }
      return { recorded: true, opened, closed, snapshots };
    });
  }

  async event(db, id, type, at, details) {
    await db.query('INSERT INTO okx_research.lifecycle_events(sub_pos_id,event_type,observed_at,detail_json) VALUES($1,$2,$3,$4)', [id,type,at,JSON.stringify(details)]);
  }

  async snapshot(db, p, at) {
    await db.query(`INSERT INTO okx_research.position_snapshots(sub_pos_id,observed_at,mark_px,quantity,upl,upl_ratio)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sub_pos_id,observed_at) DO NOTHING`, [p.subPosId,at,p.markPx,p.subPos,p.upl,p.uplRatio]);
  }

  async list(limit = 100) {
    const safeLimit = Math.floor(Math.min(500, Math.max(1, Number(limit) || 100)));
    return transaction(this.pool, async (db) => {
      // Keep counts, metadata and rows from the same committed observation.
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const meta = Object.fromEntries((await db.query('SELECT key,value FROM okx_research.research_meta')).rows.map((r) => [r.key,r.value]));
      const counts = (await db.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE state='OBSERVING')::int AS observing,
        count(*) FILTER(WHERE state='CLOSED_DETECTED')::int AS closed FROM okx_research.lifecycle_positions`)).rows[0];
      const { rows } = await db.query(`SELECT p.*,
        (SELECT count(*) FROM okx_research.position_snapshots s WHERE s.sub_pos_id=p.sub_pos_id) AS snapshot_count,
        (SELECT count(*) FROM okx_research.lifecycle_events e WHERE e.sub_pos_id=p.sub_pos_id) AS event_count
        FROM okx_research.lifecycle_positions p
        ORDER BY CASE p.state WHEN 'OBSERVING' THEN 0 ELSE 1 END,p.last_seen_at DESC LIMIT $1`, [safeLimit]);
      return { updatedAt: Number(meta.last_observation_at ?? 0) || null, sourceOk: meta.last_source_ok === '1', counts,
        positions: rows.map((row) => camelCasePosition(Object.fromEntries(Object.entries(row).map(([key,value]) =>
          [key,numericFields.includes(key) && value !== null ? Number(value) : value])))) };
    });
  }

  close() {} // The shared pool is owned by the service storage lifecycle.
}
