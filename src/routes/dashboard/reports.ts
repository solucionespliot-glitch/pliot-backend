import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg, userHasSiteAccess } from '../../middleware/auth';

const router = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const reportParamsSchema = z.object({
  vpd_threshold:          z.number().min(0).max(10).default(1.2),
  cold_hours_threshold:   z.number().min(-10).max(20).default(7),
  degree_day_base:        z.number().min(0).max(20).default(10),
  include_activities:     z.boolean().default(true),
  include_monitoring:     z.boolean().default(true),
});

const createConfigSchema = z.object({
  name:         z.string().trim().min(1).max(150),
  site_id:      z.string().uuid().optional(),
  lot_id:       z.string().uuid().optional(),
  cycle_id:     z.string().uuid().optional(),
  schedule:     z.enum(['weekly', 'monthly']).nullable().optional(),
  schedule_day: z.number().int().min(0).max(31).nullable().optional(),
  params:       reportParamsSchema.optional(),
  enabled:      z.boolean().optional(),
});

const patchConfigSchema = createConfigSchema.partial();

const runSchema = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'period_start debe ser YYYY-MM-DD'),
  period_end:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'period_end debe ser YYYY-MM-DD'),
});

// ── Helper: compute report result ─────────────────────────────────────────────
// Performs all telemetry queries for a period and returns the structured result.
// Reuses the same degree-day pattern from cycles.ts (average temperature per day).

interface ReportParams {
  vpd_threshold:        number;
  cold_hours_threshold: number;
  degree_day_base:      number;
  include_activities:   boolean;
  include_monitoring:   boolean;
}

async function computeReport(
  cycleId: string,
  periodStart: string,
  periodEnd: string,
  params: ReportParams,
): Promise<Record<string, unknown>> {
  // ── Cycle and lot data ─────────────────────────────────────────────────────
  const { rows: cycleRows } = await pool.query(
    `SELECT c.id, c.lot_id, c.name AS cycle_name, c.crop_type, c.started_at, c.base_temp,
            l.name AS lot_name, l.site_id
       FROM lot_cycles c
       JOIN lots l ON l.id = c.lot_id
      WHERE c.id = $1`,
    [cycleId],
  );
  if (!cycleRows[0]) throw new Error('Cycle not found');
  const cycle = cycleRows[0];

  // Days since sowing (from cycle start to period end)
  const daysSinceSowing = Math.floor(
    (new Date(periodEnd).getTime() - new Date(cycle.started_at).getTime()) / (1000 * 60 * 60 * 24),
  );

  // ── Device UUIDs for telemetry queries ─────────────────────────────────────
  const { rows: nodeRows } = await pool.query(
    `SELECT d.id AS device_uuid
       FROM lot_nodes ln
       JOIN devices d ON d.id = ln.device_id
      WHERE ln.lot_id = $1`,
    [cycle.lot_id],
  );
  const deviceUuids: string[] = nodeRows.map((n: { device_uuid: string }) => n.device_uuid);

  let degreeDaysPeriod       = 0;
  let degreeDaysSinceSowing  = 0;
  let vpdHoursAboveThreshold = 0;
  let coldHours              = 0;

  if (deviceUuids.length > 0) {
    const baseTemp: number = params.degree_day_base ?? cycle.base_temp ?? 10;

    // Degree-days in the report period: average T per day, sum of MAX(avg-base, 0)
    const { rows: ddPeriod } = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(avg_temp - $1, 0)), 0) AS degree_days
         FROM (
           SELECT DATE_TRUNC('day', ts) AS day,
                  AVG(temperature)      AS avg_temp
             FROM telemetry_norm
            WHERE device_id = ANY($2)
              AND ts >= $3
              AND ts < $4
              AND temperature IS NOT NULL
            GROUP BY 1
         ) daily`,
      [baseTemp, deviceUuids, periodStart, periodEnd],
    );
    degreeDaysPeriod = Number(ddPeriod[0]?.degree_days ?? 0);

    // Degree-days since sowing (from started_at to period_end)
    const { rows: ddTotal } = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(avg_temp - $1, 0)), 0) AS degree_days
         FROM (
           SELECT DATE_TRUNC('day', ts) AS day,
                  AVG(temperature)      AS avg_temp
             FROM telemetry_norm
            WHERE device_id = ANY($2)
              AND ts >= $3
              AND ts < $4
              AND temperature IS NOT NULL
            GROUP BY 1
         ) daily`,
      [baseTemp, deviceUuids, cycle.started_at, periodEnd],
    );
    degreeDaysSinceSowing = Number(ddTotal[0]?.degree_days ?? 0);

    // Hours with VPD above threshold (one reading = one hour approximation)
    const { rows: vpdRows } = await pool.query(
      `SELECT COUNT(*) AS hours
         FROM telemetry_norm
        WHERE device_id = ANY($1)
          AND ts >= $2
          AND ts < $3
          AND vpd IS NOT NULL
          AND vpd > $4`,
      [deviceUuids, periodStart, periodEnd, params.vpd_threshold],
    );
    vpdHoursAboveThreshold = Number(vpdRows[0]?.hours ?? 0);

    // Cold hours: hours with temperature <= threshold
    const { rows: coldRows } = await pool.query(
      `SELECT COUNT(*) AS hours
         FROM telemetry_norm
        WHERE device_id = ANY($1)
          AND ts >= $2
          AND ts < $3
          AND temperature IS NOT NULL
          AND temperature <= $4`,
      [deviceUuids, periodStart, periodEnd, params.cold_hours_threshold],
    );
    coldHours = Number(coldRows[0]?.hours ?? 0);
  }

  // ── Activities (lot_events in period) ──────────────────────────────────────
  let activities: unknown[] = [];
  if (params.include_activities) {
    const { rows: eventRows } = await pool.query(
      `SELECT event_type, occurred_at, notes, data
         FROM lot_events
        WHERE lot_id = $1
          AND occurred_at >= $2
          AND occurred_at < $3
        ORDER BY occurred_at ASC`,
      [cycle.lot_id, periodStart, periodEnd],
    );
    activities = eventRows;
  }

  // ── Monitoring scores in period ────────────────────────────────────────────
  let monitoringScores: unknown[] = [];
  if (params.include_monitoring) {
    const { rows: monRows } = await pool.query(
      `SELECT monitored_at, week_number, days_from_transplant, scores, notes
         FROM cycle_monitorings
        WHERE cycle_id = $1
          AND monitored_at >= $2
          AND monitored_at < $3
        ORDER BY monitored_at ASC`,
      [cycleId, periodStart, periodEnd],
    );
    monitoringScores = monRows;
  }

  return {
    period_start:               periodStart,
    period_end:                 periodEnd,
    lot_name:                   cycle.lot_name,
    cycle_name:                 cycle.cycle_name,
    crop_type:                  cycle.crop_type,
    days_since_sowing:          daysSinceSowing,
    degree_days_period:         Math.round(degreeDaysPeriod * 10) / 10,
    degree_days_since_sowing:   Math.round(degreeDaysSinceSowing * 10) / 10,
    vpd_hours_above_threshold:  vpdHoursAboveThreshold,
    cold_hours:                 coldHours,
    params_used:                params,
    activities,
    monitoring_scores:          monitoringScores,
  };
}

// ── GET /dashboard/reports/configs ───────────────────────────────────────────
router.get('/reports/configs', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT rc.id, rc.name, rc.site_id, rc.lot_id, rc.cycle_id,
              rc.schedule, rc.schedule_day, rc.params, rc.enabled, rc.created_at,
              l.name  AS lot_name,
              lc.name AS cycle_name,
              lc.crop_type
         FROM report_configs rc
         LEFT JOIN lots       l  ON l.id  = rc.lot_id
         LEFT JOIN lot_cycles lc ON lc.id = rc.cycle_id
        WHERE rc.organization_id = $1
        ORDER BY rc.created_at DESC`,
      [req.user!.organization_id],
    );
    res.json({ configs: rows });
  } catch (err) {
    console.error('Error fetching report configs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/reports/configs ──────────────────────────────────────────
router.post('/reports/configs', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = createConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const {
    name, site_id, lot_id, cycle_id,
    schedule = null, schedule_day = null,
    params = {}, enabled = true,
  } = parsed.data;

  // If a lot_id is given, verify it belongs to this org
  if (lot_id) {
    const { rows } = await pool.query(
      `SELECT site_id FROM lots WHERE id = $1 AND organization_id = $2`,
      [lot_id, req.user!.organization_id],
    );
    if (!rows[0] || !userHasSiteAccess(req.user!.site_ids, rows[0].site_id)) {
      res.status(404).json({ error: 'Lot not found' });
      return;
    }
  }

  // If a cycle_id is given, verify it belongs to a lot of this org
  if (cycle_id) {
    const { rows } = await pool.query(
      `SELECT l.site_id
         FROM lot_cycles c
         JOIN lots l ON l.id = c.lot_id
        WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );
    if (!rows[0] || !userHasSiteAccess(req.user!.site_ids, rows[0].site_id)) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO report_configs
         (organization_id, site_id, lot_id, cycle_id, name, schedule, schedule_day, params, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        req.user!.organization_id,
        site_id ?? null, lot_id ?? null, cycle_id ?? null,
        name, schedule, schedule_day,
        JSON.stringify(params), enabled,
      ],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('Error creating report config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/reports/configs/:id ───────────────────────────────────────
router.get('/reports/configs/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT rc.id, rc.name, rc.site_id, rc.lot_id, rc.cycle_id,
              rc.schedule, rc.schedule_day, rc.params, rc.enabled, rc.created_at,
              l.name  AS lot_name,
              lc.name AS cycle_name,
              lc.crop_type,
              lc.started_at AS cycle_started_at
         FROM report_configs rc
         LEFT JOIN lots       l  ON l.id  = rc.lot_id
         LEFT JOIN lot_cycles lc ON lc.id = rc.cycle_id
        WHERE rc.id = $1 AND rc.organization_id = $2`,
      [id, req.user!.organization_id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Report config not found' });
      return;
    }
    res.json({ config: rows[0] });
  } catch (err) {
    console.error('Error fetching report config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /dashboard/reports/configs/:id ─────────────────────────────────────
router.patch('/reports/configs/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const parsed = patchConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { name, schedule, schedule_day, params, enabled } = parsed.data;

  // Build dynamic SET clause
  const updates: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (name         !== undefined) { updates.push(`name = $${i++}`);         values.push(name) }
  if (schedule     !== undefined) { updates.push(`schedule = $${i++}`);     values.push(schedule) }
  if (schedule_day !== undefined) { updates.push(`schedule_day = $${i++}`); values.push(schedule_day) }
  if (params       !== undefined) { updates.push(`params = $${i++}`);       values.push(JSON.stringify(params)) }
  if (enabled      !== undefined) { updates.push(`enabled = $${i++}`);      values.push(enabled) }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  values.push(id, req.user!.organization_id);

  try {
    const { rowCount } = await pool.query(
      `UPDATE report_configs SET ${updates.join(', ')}
        WHERE id = $${i++} AND organization_id = $${i++}`,
      values,
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Report config not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating report config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /dashboard/reports/configs/:id ────────────────────────────────────
router.delete('/reports/configs/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM report_configs WHERE id = $1 AND organization_id = $2`,
      [id, req.user!.organization_id],
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Report config not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting report config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/reports/configs/:id/run ───────────────────────────────────
// Triggers a manual report run for a given period.
// Creates a 'pending' run, computes synchronously, then marks as 'done' or 'error'.
router.post('/reports/configs/:id/run', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { period_start, period_end } = parsed.data;

  if (period_start >= period_end) {
    res.status(400).json({ error: 'period_start must be before period_end' });
    return;
  }

  // Verify config belongs to this org and has a cycle to calculate against
  const { rows: configRows } = await pool.query(
    `SELECT id, cycle_id, params FROM report_configs WHERE id = $1 AND organization_id = $2`,
    [id, req.user!.organization_id],
  );
  if (!configRows[0]) {
    res.status(404).json({ error: 'Report config not found' });
    return;
  }
  const config = configRows[0];

  if (!config.cycle_id) {
    res.status(400).json({ error: 'Report config must have a cycle_id to run calculations' });
    return;
  }

  // Insert a pending run first so we have an ID to return
  const { rows: runRows } = await pool.query(
    `INSERT INTO report_runs (config_id, period_start, period_end, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [id, period_start, period_end],
  );
  const runId: string = runRows[0].id;

  // Compute synchronously — if the period is large this could be slow,
  // but for weekly/monthly ranges over a single lot it's acceptable.
  try {
    const params = reportParamsSchema.parse(config.params ?? {});
    const result = await computeReport(config.cycle_id, period_start, period_end, params);

    await pool.query(
      `UPDATE report_runs SET status = 'done', result = $1 WHERE id = $2`,
      [JSON.stringify(result), runId],
    );

    res.status(201).json({ id: runId, status: 'done' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await pool.query(
      `UPDATE report_runs SET status = 'error', error_msg = $1 WHERE id = $2`,
      [msg, runId],
    );
    console.error('Error computing report run:', err);
    res.status(500).json({ error: 'Report computation failed', run_id: runId });
  }
});

// ── GET /dashboard/reports/runs ──────────────────────────────────────────────
// Lists runs for the org. Optional query param: ?config_id=UUID
router.get('/reports/runs', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const configId = typeof req.query.config_id === 'string' ? req.query.config_id : null;

  try {
    const { rows } = await pool.query(
      `SELECT rr.id, rr.config_id, rc.name AS config_name,
              rr.period_start, rr.period_end, rr.status, rr.created_at
         FROM report_runs rr
         JOIN report_configs rc ON rc.id = rr.config_id
        WHERE rc.organization_id = $1
          AND ($2::uuid IS NULL OR rr.config_id = $2)
        ORDER BY rr.created_at DESC
        LIMIT 100`,
      [req.user!.organization_id, configId],
    );
    res.json({ runs: rows });
  } catch (err) {
    console.error('Error fetching report runs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/reports/runs/:id ──────────────────────────────────────────
router.get('/reports/runs/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT rr.id, rr.config_id, rc.name AS config_name,
              rr.period_start, rr.period_end, rr.status, rr.result, rr.error_msg, rr.created_at
         FROM report_runs rr
         JOIN report_configs rc ON rc.id = rr.config_id
        WHERE rr.id = $1 AND rc.organization_id = $2`,
      [id, req.user!.organization_id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Report run not found' });
      return;
    }
    res.json({ run: rows[0] });
  } catch (err) {
    console.error('Error fetching report run:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
