import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg, userHasSiteAccess, roleRank } from '../../middleware/auth';

const router = Router();

// Producer (rank 2) and above can see/manage all org configs.
// Advisor (rank 1) and operator (rank 0) only see own + shared configs.
const PRIVILEGED_RANK = 2;

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
  is_shared:    z.boolean().optional(),
});

const patchConfigSchema = createConfigSchema.partial();

const runSchema = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'period_start debe ser YYYY-MM-DD'),
  period_end:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'period_end debe ser YYYY-MM-DD'),
});

// ── Explore schemas ───────────────────────────────────────────────────────────

const VALID_METRICS    = ['temperature', 'humidity', 'vpd', 'co2'] as const;
const VALID_OPERATORS  = ['gt', 'lt'] as const;

// Map metric name → telemetry_norm column. Whitelisted to prevent SQL injection.
const METRIC_COL: Record<string, string> = {
  temperature: 'temperature',
  humidity:    'humidity',
  vpd:         'vpd',
  co2:         'co2',
};

// Map operator → SQL comparison sign. Whitelisted to prevent SQL injection.
const OP_SQL: Record<string, string> = {
  gt: '>',
  lt: '<',
};

const exploreQuerySchema = z.object({
  metric:    z.enum(VALID_METRICS),
  threshold: z.number(),
  operator:  z.enum(VALID_OPERATORS),
  label:     z.string().max(100).optional(),
});

const exploreSchema = z.object({
  entity_type: z.enum(['node', 'lot']),
  entity_id:   z.string().uuid(),
  date_from:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from debe ser YYYY-MM-DD'),
  date_to:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to debe ser YYYY-MM-DD'),
  queries:     z.array(exploreQuerySchema).min(1).max(6),
});

// ── Helper: compute report result ─────────────────────────────────────────────
// Performs all telemetry queries for a period and returns the structured result.

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

    const { rows: ddPeriod } = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(avg_temp - $1, 0)), 0) AS degree_days
         FROM (
           SELECT DATE_TRUNC('day', ts) AS day, AVG(temperature) AS avg_temp
             FROM telemetry_norm
            WHERE device_id = ANY($2) AND ts >= $3 AND ts < $4 AND temperature IS NOT NULL
            GROUP BY 1
         ) daily`,
      [baseTemp, deviceUuids, periodStart, periodEnd],
    );
    degreeDaysPeriod = Number(ddPeriod[0]?.degree_days ?? 0);

    const { rows: ddTotal } = await pool.query(
      `SELECT COALESCE(SUM(GREATEST(avg_temp - $1, 0)), 0) AS degree_days
         FROM (
           SELECT DATE_TRUNC('day', ts) AS day, AVG(temperature) AS avg_temp
             FROM telemetry_norm
            WHERE device_id = ANY($2) AND ts >= $3 AND ts < $4 AND temperature IS NOT NULL
            GROUP BY 1
         ) daily`,
      [baseTemp, deviceUuids, cycle.started_at, periodEnd],
    );
    degreeDaysSinceSowing = Number(ddTotal[0]?.degree_days ?? 0);

    const { rows: vpdRows } = await pool.query(
      `SELECT COUNT(*) AS hours
         FROM telemetry_norm
        WHERE device_id = ANY($1) AND ts >= $2 AND ts < $3
          AND vpd IS NOT NULL AND vpd > $4`,
      [deviceUuids, periodStart, periodEnd, params.vpd_threshold],
    );
    vpdHoursAboveThreshold = Number(vpdRows[0]?.hours ?? 0);

    const { rows: coldRows } = await pool.query(
      `SELECT COUNT(*) AS hours
         FROM telemetry_norm
        WHERE device_id = ANY($1) AND ts >= $2 AND ts < $3
          AND temperature IS NOT NULL AND temperature <= $4`,
      [deviceUuids, periodStart, periodEnd, params.cold_hours_threshold],
    );
    coldHours = Number(coldRows[0]?.hours ?? 0);
  }

  let activities: unknown[] = [];
  if (params.include_activities) {
    const { rows: eventRows } = await pool.query(
      `SELECT event_type, occurred_at, notes, data
         FROM lot_events
        WHERE lot_id = $1 AND occurred_at >= $2 AND occurred_at < $3
        ORDER BY occurred_at ASC`,
      [cycle.lot_id, periodStart, periodEnd],
    );
    activities = eventRows;
  }

  let monitoringScores: unknown[] = [];
  if (params.include_monitoring) {
    const { rows: monRows } = await pool.query(
      `SELECT monitored_at, week_number, days_from_transplant, scores, notes
         FROM cycle_monitorings
        WHERE cycle_id = $1 AND monitored_at >= $2 AND monitored_at < $3
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
  // Producer and above see all org configs; advisor/operator only see own or shared.
  const isPrivileged = roleRank(req.user!.role) >= PRIVILEGED_RANK;
  const params: unknown[] = [req.user!.organization_id];
  const visClause = isPrivileged
    ? ''
    : `AND (rc.created_by = $${params.push(req.user!.auth0_sub)} OR rc.is_shared = true)`;

  try {
    const { rows } = await pool.query(
      `SELECT rc.id, rc.name, rc.site_id, rc.lot_id, rc.cycle_id,
              rc.schedule, rc.schedule_day, rc.params, rc.enabled,
              rc.created_by, rc.is_shared, rc.created_at,
              l.name  AS lot_name,
              lc.name AS cycle_name,
              lc.crop_type
         FROM report_configs rc
         LEFT JOIN lots       l  ON l.id  = rc.lot_id
         LEFT JOIN lot_cycles lc ON lc.id = rc.cycle_id
        WHERE rc.organization_id = $1
          ${visClause}
        ORDER BY rc.created_at DESC`,
      params,
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
    params = {}, enabled = true, is_shared = false,
  } = parsed.data;

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
         (organization_id, site_id, lot_id, cycle_id, name, schedule, schedule_day,
          params, enabled, created_by, is_shared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        req.user!.organization_id,
        site_id ?? null, lot_id ?? null, cycle_id ?? null,
        name, schedule, schedule_day,
        JSON.stringify(params), enabled,
        req.user!.auth0_sub, is_shared,
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
  const isPrivileged = roleRank(req.user!.role) >= PRIVILEGED_RANK;
  const params: unknown[] = [id, req.user!.organization_id];
  const visClause = isPrivileged
    ? ''
    : `AND (rc.created_by = $${params.push(req.user!.auth0_sub)} OR rc.is_shared = true)`;

  try {
    const { rows } = await pool.query(
      `SELECT rc.id, rc.name, rc.site_id, rc.lot_id, rc.cycle_id,
              rc.schedule, rc.schedule_day, rc.params, rc.enabled,
              rc.created_by, rc.is_shared, rc.created_at,
              l.name  AS lot_name,
              lc.name AS cycle_name,
              lc.crop_type,
              lc.started_at AS cycle_started_at
         FROM report_configs rc
         LEFT JOIN lots       l  ON l.id  = rc.lot_id
         LEFT JOIN lot_cycles lc ON lc.id = rc.cycle_id
        WHERE rc.id = $1 AND rc.organization_id = $2
          ${visClause}`,
      params,
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

  const { name, schedule, schedule_day, params, enabled, is_shared } = parsed.data;

  const updates: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (name         !== undefined) { updates.push(`name = $${i++}`);         values.push(name) }
  if (schedule     !== undefined) { updates.push(`schedule = $${i++}`);     values.push(schedule) }
  if (schedule_day !== undefined) { updates.push(`schedule_day = $${i++}`); values.push(schedule_day) }
  if (params       !== undefined) { updates.push(`params = $${i++}`);       values.push(JSON.stringify(params)) }
  if (enabled      !== undefined) { updates.push(`enabled = $${i++}`);      values.push(enabled) }
  if (is_shared    !== undefined) { updates.push(`is_shared = $${i++}`);    values.push(is_shared) }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  // Owner can edit their own config; producer+ can edit any org config.
  const isPrivileged = roleRank(req.user!.role) >= PRIVILEGED_RANK;
  const ownerClause  = isPrivileged ? '' : `AND created_by = $${i++}`;
  if (!isPrivileged) values.push(req.user!.auth0_sub);

  values.push(id, req.user!.organization_id);

  try {
    const { rowCount } = await pool.query(
      `UPDATE report_configs SET ${updates.join(', ')}
        WHERE id = $${i++} AND organization_id = $${i++} ${ownerClause}`,
      values,
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Report config not found or not authorized' });
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
  // Owner can delete their own config; producer+ can delete any org config.
  const isPrivileged = roleRank(req.user!.role) >= PRIVILEGED_RANK;
  const params: unknown[] = [id, req.user!.organization_id];
  const ownerClause = isPrivileged ? '' : `AND created_by = $${params.push(req.user!.auth0_sub)}`;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM report_configs WHERE id = $1 AND organization_id = $2 ${ownerClause}`,
      params,
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Report config not found or not authorized' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting report config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/reports/configs/:id/run ───────────────────────────────────
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

  // Any user who can see the config (own or shared) can run it.
  const isPrivileged = roleRank(req.user!.role) >= PRIVILEGED_RANK;
  const visParams: unknown[] = [id, req.user!.organization_id];
  const visClause = isPrivileged
    ? ''
    : `AND (created_by = $${visParams.push(req.user!.auth0_sub)} OR is_shared = true)`;

  const { rows: configRows } = await pool.query(
    `SELECT id, cycle_id, params FROM report_configs
      WHERE id = $1 AND organization_id = $2 ${visClause}`,
    visParams,
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

  const { rows: runRows } = await pool.query(
    `INSERT INTO report_runs (config_id, period_start, period_end, status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [id, period_start, period_end],
  );
  const runId: string = runRows[0].id;

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
router.get('/reports/runs', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const configId = typeof req.query.config_id === 'string' ? req.query.config_id : null;
  const isPrivileged = roleRank(req.user!.role) >= PRIVILEGED_RANK;
  const params: unknown[] = [req.user!.organization_id];
  const visClause = isPrivileged
    ? ''
    : `AND (rc.created_by = $${params.push(req.user!.auth0_sub)} OR rc.is_shared = true)`;
  params.push(configId);

  try {
    const { rows } = await pool.query(
      `SELECT rr.id, rr.config_id, rc.name AS config_name,
              rr.period_start, rr.period_end, rr.status, rr.created_at
         FROM report_runs rr
         JOIN report_configs rc ON rc.id = rr.config_id
        WHERE rc.organization_id = $1
          ${visClause}
          AND ($${params.length}::uuid IS NULL OR rr.config_id = $${params.length})
        ORDER BY rr.created_at DESC
        LIMIT 100`,
      params,
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
  const isPrivileged = roleRank(req.user!.role) >= PRIVILEGED_RANK;
  const params: unknown[] = [id, req.user!.organization_id];
  const visClause = isPrivileged
    ? ''
    : `AND (rc.created_by = $${params.push(req.user!.auth0_sub)} OR rc.is_shared = true)`;

  try {
    const { rows } = await pool.query(
      `SELECT rr.id, rr.config_id, rc.name AS config_name,
              rr.period_start, rr.period_end, rr.status, rr.result, rr.error_msg, rr.created_at
         FROM report_runs rr
         JOIN report_configs rc ON rc.id = rr.config_id
        WHERE rr.id = $1 AND rc.organization_id = $2 ${visClause}`,
      params,
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

// ── POST /dashboard/reports/explore ──────────────────────────────────────────
// Ad-hoc telemetry exploration: given an entity (node or lot) and a date range,
// computes daily series + totals for one or more metric/threshold queries.
// Results are NOT saved — this is a one-off computation for interactive use.
router.post('/reports/explore', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = exploreSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { entity_type, entity_id, date_from, date_to, queries } = parsed.data;

  if (date_from >= date_to) {
    res.status(400).json({ error: 'date_from must be before date_to' });
    return;
  }

  // ── Resolve entity to device UUIDs and a display name ──────────────────────
  let deviceUuids: string[] = [];
  let entityName = '';

  if (entity_type === 'node') {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(display_name, legacy_device_name, device_id) AS name, site_id
         FROM devices WHERE id = $1 AND organization_id = $2`,
      [entity_id, req.user!.organization_id],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Dispositivo no encontrado' }); return; }
    if (!userHasSiteAccess(req.user!.site_ids, rows[0].site_id)) {
      res.status(403).json({ error: 'Sin acceso a este site' }); return;
    }
    deviceUuids = [rows[0].id];
    entityName  = rows[0].name;

  } else {
    // lot — aggregate telemetry across all assigned nodes
    const { rows: lotRows } = await pool.query(
      `SELECT id, name, site_id FROM lots WHERE id = $1 AND organization_id = $2`,
      [entity_id, req.user!.organization_id],
    );
    if (!lotRows[0]) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
    if (!userHasSiteAccess(req.user!.site_ids, lotRows[0].site_id)) {
      res.status(403).json({ error: 'Sin acceso a este site' }); return;
    }
    entityName = lotRows[0].name;

    const { rows: nodeRows } = await pool.query(
      `SELECT d.id FROM lot_nodes ln JOIN devices d ON d.id = ln.device_id WHERE ln.lot_id = $1`,
      [entity_id],
    );
    deviceUuids = nodeRows.map((r: { id: string }) => r.id);
  }

  // Lot with no assigned nodes — return empty results immediately
  if (deviceUuids.length === 0) {
    res.json({
      entity_name: entityName, entity_type, date_from, date_to,
      results: queries.map((q) => ({
        metric: q.metric, threshold: q.threshold, operator: q.operator,
        label: q.label ?? null, series: [], totals: null,
      })),
    });
    return;
  }

  // ── Run each metric query in parallel ─────────────────────────────────────
  try {
    const results = await Promise.all(
      queries.map(async (q) => {
        const col   = METRIC_COL[q.metric];  // safe — from validated enum
        const opSql = OP_SQL[q.operator];    // safe — from validated enum

        // Daily series: avg/max/min per day + hours meeting the threshold condition
        const { rows: seriesRows } = await pool.query(
          `SELECT
             DATE_TRUNC('day', ts)::date             AS date,
             ROUND(AVG(${col})::numeric, 2)          AS avg,
             ROUND(MAX(${col})::numeric, 2)          AS max,
             ROUND(MIN(${col})::numeric, 2)          AS min,
             COUNT(*) FILTER (WHERE ${col} ${opSql} $4) AS hours_condition
           FROM telemetry_norm
          WHERE device_id = ANY($1::uuid[])
            AND ts >= $2::date
            AND ts < ($3::date + INTERVAL '1 day')
            AND ${col} IS NOT NULL
          GROUP BY 1
          ORDER BY 1`,
          [deviceUuids, date_from, date_to, q.threshold],
        );

        // Period totals: single aggregate over the full range
        const { rows: totalRows } = await pool.query(
          `SELECT
             ROUND(AVG(${col})::numeric, 2)          AS avg_period,
             ROUND(MAX(${col})::numeric, 2)          AS max_period,
             ROUND(MIN(${col})::numeric, 2)          AS min_period,
             COUNT(*) FILTER (WHERE ${col} ${opSql} $4) AS total_hours_condition
           FROM telemetry_norm
          WHERE device_id = ANY($1::uuid[])
            AND ts >= $2::date
            AND ts < ($3::date + INTERVAL '1 day')
            AND ${col} IS NOT NULL`,
          [deviceUuids, date_from, date_to, q.threshold],
        );

        return {
          metric:    q.metric,
          threshold: q.threshold,
          operator:  q.operator,
          label:     q.label ?? null,
          series: seriesRows.map((r: Record<string, unknown>) => ({
            date:            r.date,
            avg:             r.avg  !== null ? Number(r.avg)  : null,
            max:             r.max  !== null ? Number(r.max)  : null,
            min:             r.min  !== null ? Number(r.min)  : null,
            hours_condition: Number(r.hours_condition),
          })),
          totals: totalRows[0]?.avg_period !== null ? {
            avg_period:            Number(totalRows[0].avg_period),
            max_period:            Number(totalRows[0].max_period),
            min_period:            Number(totalRows[0].min_period),
            total_hours_condition: Number(totalRows[0].total_hours_condition),
          } : null,
        };
      }),
    );

    res.json({ entity_name: entityName, entity_type, date_from, date_to, results });
  } catch (err) {
    console.error('Error running explore query:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
