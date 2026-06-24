import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg } from '../../middleware/auth';

const router = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonitoringItem {
  item_key:        string;
  scale_type:      string;
  threshold_value: number | null;
  category:        string;
}

// ── Semaphore calculation ──────────────────────────────────────────────────────
// Compares monitoring scores against thresholds to determine lot status.
// Returns 'red' if any item exceeds its threshold, 'yellow' if any item
// reaches 70% of threshold, 'green' otherwise.
// Special case: trips_ninfas_pct has threshold 0 (any presence) when ddt <= 40.
function calculateStatus(
  scores: Record<string, number | boolean>,
  items: MonitoringItem[],
  daysFromTransplant: number,
): 'green' | 'yellow' | 'red' {
  let status: 'green' | 'yellow' | 'red' = 'green';

  for (const item of items) {
    const raw = scores[item.item_key];
    if (raw === undefined || raw === null) continue;

    // Boolean items: any truthy value = red
    if (item.scale_type === 'boolean') {
      if (raw === true || raw === 1) return 'red';
      continue;
    }

    const value = Number(raw);
    let threshold = item.threshold_value;

    // trips_ninfas_pct: threshold drops to 0 when ddt <= 40
    // (any ninfa presence during early stage triggers action)
    if (item.item_key === 'trips_ninfas_pct' && daysFromTransplant <= 40) {
      threshold = 0;
    }

    if (threshold === null) continue; // metric items (informative only)

    if (value > threshold) return 'red';
    if (threshold > 0 && value >= threshold * 0.7) {
      status = 'yellow'; // keep looking — a later item might be red
    }
  }

  return status;
}

// ── Validation schemas ─────────────────────────────────────────────────────────

// One product row in an application event: commercial_name is required, the rest optional
const applicationProductSchema = z.object({
  commercial_name:   z.string().trim().min(1).max(200),
  active_ingredient: z.string().trim().max(200).optional(),
  dose:              z.number().positive().optional(),
  dose_unit:         z.string().trim().max(50).optional(),
});

const createEventSchema = z.object({
  event_type:  z.enum(['sowing', 'transplant', 'application', 'harvest']),
  occurred_at: z.string().datetime(),
  notes:       z.string().trim().max(1000).optional(),
  // For application events: data.products is an array of product rows.
  // Other event types may leave data undefined.
  data: z.object({
    products: z.array(applicationProductSchema).optional(),
  }).optional(),
});

const createCycleSchema = z.object({
  name:                      z.string().trim().min(1).max(150),
  crop_type:                 z.string().trim().min(1).max(100),
  started_at:                z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'started_at debe ser YYYY-MM-DD'),
  notes:                     z.string().trim().max(500).optional(),
  monitoring_frequency_days: z.number().int().min(1).max(90).optional(),
});

const closeCycleSchema = z.object({
  ended_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ended_at debe ser YYYY-MM-DD'),
});

const createMonitoringSchema = z.object({
  monitored_at:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'monitored_at debe ser YYYY-MM-DD'),
  plant_label:     z.string().trim().max(100).optional(),
  scores:          z.record(z.union([z.number(), z.boolean()])),
  sampling_effort: z.record(z.unknown()).optional(),
  notes:           z.string().trim().max(1000).optional(),
  foci:            z.array(z.object({
    item_key:      z.string().min(1),
    location_text: z.string().trim().max(500).optional(),
    notes:         z.string().trim().max(500).optional(),
  })).optional(),
});

// ── GET /dashboard/pesticide-products ─────────────────────────────────────────
// Returns the global catalog of pesticide products for application event autocomplete.
// This is a shared catalog (not org-scoped) so no requireOrg needed.
router.get('/pesticide-products', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, commercial_name, active_ingredient, dose_unit, default_dose, toxicological_category
         FROM pesticide_products
        ORDER BY commercial_name ASC`,
    );
    res.json({ products: rows });
  } catch (err) {
    console.error('Error fetching pesticide products:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/crop-types ─────────────────────────────────────────────────
// Returns the list of known crop types for the cycle creation dropdown.
router.get('/crop-types', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT crop_type, base_temp, notes FROM crop_base_temps ORDER BY crop_type ASC`,
    );
    res.json({ crop_types: rows });
  } catch (err) {
    console.error('Error fetching crop types:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/cycles/:cycle_id ──────────────────────────────────────────
// Returns a single cycle with days_without_monitoring and degree_days.
//
// Degree-day accumulator strategy (lazy/incremental):
//   - lot_cycles stores degree_days_to_date (total up to degree_days_calc_date)
//   - On each request: if calc_date < yesterday, calculate the missing completed
//     days and persist the updated total (fast — only processes new days)
//   - Always add today's partial live from telemetry_norm (current-day readings)
//   - Result: accurate to the minute without recalculating the full history
router.get('/cycles/:cycle_id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { cycle_id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT
          c.id, c.lot_id, c.name, c.crop_type, c.base_temp,
          c.started_at, c.ended_at, c.monitoring_frequency_days,
          c.notes, c.created_by, c.created_at,
          c.degree_days_to_date,
          c.degree_days_calc_date,
          m.last_monitored_at,
          CASE
            WHEN m.last_monitored_at IS NOT NULL
            THEN (CURRENT_DATE - m.last_monitored_at)
            ELSE NULL
          END AS days_without_monitoring
        FROM lot_cycles c
        JOIN lots l ON l.id = c.lot_id
        LEFT JOIN LATERAL (
          SELECT MAX(monitored_at) AS last_monitored_at
            FROM cycle_monitorings
           WHERE cycle_id = c.id
        ) m ON TRUE
       WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }

    const cycle = rows[0];

    // ── Degree-day accumulator ────────────────────────────────────────────────
    // Fetch device UUIDs for all nodes assigned to this lot
    const { rows: nodeRows } = await pool.query(
      `SELECT d.id AS device_uuid
         FROM lot_nodes ln
         JOIN devices d ON d.id = ln.device_id
        WHERE ln.lot_id = $1`,
      [cycle.lot_id],
    );
    const deviceUuids: string[] = nodeRows.map((n: { device_uuid: string }) => n.device_uuid);

    let degree_days: number | null = null;

    if (deviceUuids.length > 0) {
      const baseTemp: number = cycle.base_temp ?? 10;

      // Get yesterday as YYYY-MM-DD using DB timezone to stay consistent
      const { rows: dateRows } = await pool.query(
        `SELECT (CURRENT_DATE - INTERVAL '1 day')::text AS yesterday`,
      );
      const yesterdayStr: string = dateRows[0].yesterday;

      // calcDate: last date already included in the stored accumulator
      const calcDate: string | null = cycle.degree_days_calc_date
        ? new Date(cycle.degree_days_calc_date).toISOString().slice(0, 10)
        : null;

      let storedTotal: number = Number(cycle.degree_days_to_date ?? 0);

      // If stored total doesn't cover through yesterday, catch up on completed days
      if (calcDate === null || calcDate < yesterdayStr) {
        // Start the day after the last calculated date, or from cycle start
        const fromDate: string = calcDate
          ? new Date(new Date(calcDate + 'T12:00:00Z').getTime() + 86_400_000)
              .toISOString()
              .slice(0, 10)
          : cycle.started_at;

        const { rows: deltaRows } = await pool.query(
          `SELECT COALESCE(SUM(GREATEST(avg_temp - $1, 0)), 0) AS delta
             FROM (
               SELECT DATE_TRUNC('day', ts) AS day,
                      AVG(temperature)      AS avg_temp
                 FROM telemetry_norm
                WHERE device_id = ANY($2)
                  AND ts >= $3
                  AND ts < CURRENT_DATE
                  AND temperature IS NOT NULL
                GROUP BY 1
             ) daily`,
          [baseTemp, deviceUuids, fromDate],
        );

        const delta = Number(deltaRows[0]?.delta ?? 0);
        storedTotal += delta;

        // Persist so the next request skips these already-processed days
        await pool.query(
          `UPDATE lot_cycles
              SET degree_days_to_date   = $1,
                  degree_days_calc_date = $2
            WHERE id = $3`,
          [storedTotal, yesterdayStr, cycle.id],
        );
      }

      // Add today's partial: average of all readings received so far today
      const { rows: todayRows } = await pool.query(
        `SELECT GREATEST(AVG(temperature) - $1, 0) AS today_partial
           FROM telemetry_norm
          WHERE device_id = ANY($2)
            AND ts >= CURRENT_DATE
            AND temperature IS NOT NULL`,
        [baseTemp, deviceUuids],
      );

      const todayPartial = Number(todayRows[0]?.today_partial ?? 0);
      degree_days = storedTotal + todayPartial;
    }

    // Strip internal accumulator columns before sending the response
    const { degree_days_to_date: _a, degree_days_calc_date: _b, ...cycleData } = cycle;
    res.json({ cycle: { ...cycleData, degree_days } });
  } catch (err) {
    console.error('Error fetching cycle:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/lots/:lot_id/cycles ───────────────────────────────────────
// Returns all cycles for a lot, including days since last monitoring for each.
router.get('/lots/:lot_id/cycles', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { lot_id } = req.params;

  try {
    // Verify lot belongs to this org
    const { rows: lotRows } = await pool.query(
      `SELECT id FROM lots WHERE id = $1 AND organization_id = $2`,
      [lot_id, req.user!.organization_id],
    );
    if (!lotRows[0]) {
      res.status(404).json({ error: 'Lot not found' });
      return;
    }

    // Cycles with last monitoring date and days without monitoring
    const { rows } = await pool.query(
      `SELECT
          c.id,
          c.name,
          c.crop_type,
          c.base_temp,
          c.started_at,
          c.ended_at,
          c.monitoring_frequency_days,
          c.notes,
          c.created_by,
          c.created_at,
          -- Last monitoring date for this cycle
          m.last_monitored_at,
          -- Days since last monitoring (NULL if never monitored)
          CASE
            WHEN m.last_monitored_at IS NOT NULL
            THEN (CURRENT_DATE - m.last_monitored_at)
            ELSE NULL
          END AS days_without_monitoring
        FROM lot_cycles c
        LEFT JOIN LATERAL (
          SELECT MAX(monitored_at) AS last_monitored_at
            FROM cycle_monitorings
           WHERE cycle_id = c.id
        ) m ON TRUE
        WHERE c.lot_id = $1
        ORDER BY c.started_at DESC`,
      [lot_id],
    );

    res.json({ cycles: rows });
  } catch (err) {
    console.error('Error fetching cycles:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/lots/:lot_id/cycles ──────────────────────────────────────
// Creates a new cycle for a lot. Copies base_temp from crop_base_temps.
router.post('/lots/:lot_id/cycles', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { lot_id } = req.params;

  const parsed = createCycleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { name, crop_type, started_at, notes, monitoring_frequency_days = 7 } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify lot belongs to this org
    const { rows: lotRows } = await client.query(
      `SELECT id FROM lots WHERE id = $1 AND organization_id = $2`,
      [lot_id, req.user!.organization_id],
    );
    if (!lotRows[0]) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Lot not found' });
      return;
    }

    // Look up base_temp for this crop type (NULL if crop_type is "Otros" or unknown)
    const { rows: tempRows } = await client.query(
      `SELECT base_temp FROM crop_base_temps WHERE crop_type = $1`,
      [crop_type],
    );
    const base_temp: number | null = tempRows[0]?.base_temp ?? null;

    const { rows } = await client.query(
      `INSERT INTO lot_cycles
         (lot_id, name, crop_type, base_temp, started_at, monitoring_frequency_days, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [lot_id, name, crop_type, base_temp, started_at, monitoring_frequency_days, notes ?? null, req.user!.auth0_sub],
    );

    await client.query('COMMIT');
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating cycle:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── PATCH /dashboard/cycles/:cycle_id/close ──────────────────────────────────
// Closes an active cycle by setting ended_at. Cannot re-open a closed cycle.
router.patch('/cycles/:cycle_id/close', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { cycle_id } = req.params;

  const parsed = closeCycleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { ended_at } = parsed.data;

  try {
    // Verify cycle belongs to a lot of this org and is still active
    const { rows } = await pool.query(
      `SELECT c.id, c.ended_at
         FROM lot_cycles c
         JOIN lots l ON l.id = c.lot_id
        WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }
    if (rows[0].ended_at !== null) {
      res.status(400).json({ error: 'Cycle is already closed' });
      return;
    }

    await pool.query(
      `UPDATE lot_cycles SET ended_at = $1 WHERE id = $2`,
      [ended_at, cycle_id],
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error closing cycle:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/cycles/:cycle_id/monitoring-items ─────────────────────────
// Returns the monitoring items for the crop type of a cycle.
// The frontend uses this to build the monitoring form dynamically.
router.get('/cycles/:cycle_id/monitoring-items', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { cycle_id } = req.params;

  try {
    // Verify cycle belongs to a lot of this org
    const { rows: cycleRows } = await pool.query(
      `SELECT c.id, c.crop_type
         FROM lot_cycles c
         JOIN lots l ON l.id = c.lot_id
        WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );
    if (!cycleRows[0]) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }

    const { rows: items } = await pool.query(
      `SELECT id, item_key, label, category, scale_type, threshold_value, threshold_notes, sort_order
         FROM crop_monitoring_items
        WHERE crop_type = $1
        ORDER BY sort_order ASC`,
      [cycleRows[0].crop_type],
    );

    res.json({ crop_type: cycleRows[0].crop_type, items });
  } catch (err) {
    console.error('Error fetching monitoring items:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/cycles/:cycle_id/monitorings ───────────────────────────────
// Returns all monitorings for a cycle, most recent first.
router.get('/cycles/:cycle_id/monitorings', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { cycle_id } = req.params;

  try {
    // Verify cycle belongs to a lot of this org
    const { rows: cycleRows } = await pool.query(
      `SELECT c.id
         FROM lot_cycles c
         JOIN lots l ON l.id = c.lot_id
        WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );
    if (!cycleRows[0]) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }

    const { rows: monitorings } = await pool.query(
      `SELECT id, monitored_at, plant_label, week_number, days_from_transplant,
              scores, sampling_effort, notes, created_by, created_at
         FROM cycle_monitorings
        WHERE cycle_id = $1
        ORDER BY monitored_at DESC`,
      [cycle_id],
    );

    // Attach foci to each monitoring
    if (monitorings.length > 0) {
      const monitoringIds = monitorings.map((m) => m.id);
      const { rows: foci } = await pool.query(
        `SELECT id, monitoring_id, item_key, location_text, notes, created_at
           FROM monitoring_foci
          WHERE monitoring_id = ANY($1)`,
        [monitoringIds],
      );

      const fociByMonitoring: Record<string, typeof foci> = {};
      for (const f of foci) {
        if (!fociByMonitoring[f.monitoring_id]) fociByMonitoring[f.monitoring_id] = [];
        fociByMonitoring[f.monitoring_id].push(f);
      }

      for (const m of monitorings) {
        (m as Record<string, unknown>).foci = fociByMonitoring[m.id] ?? [];
      }
    }

    res.json({ monitorings });
  } catch (err) {
    console.error('Error fetching monitorings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/cycles/:cycle_id/monitorings ─────────────────────────────
// Records a monitoring session for a cycle.
// - Calculates days_from_transplant and week_number automatically.
// - Evaluates scores against thresholds and updates lots.status.
// - Monitorings are append-only: no DELETE or PATCH endpoint exists.
router.post('/cycles/:cycle_id/monitorings', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { cycle_id } = req.params;

  const parsed = createMonitoringSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { monitored_at, plant_label, scores, sampling_effort, notes, foci = [] } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch cycle and verify org ownership
    const { rows: cycleRows } = await client.query(
      `SELECT c.id, c.crop_type, c.started_at, c.ended_at, l.id AS lot_id
         FROM lot_cycles c
         JOIN lots l ON l.id = c.lot_id
        WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );
    if (!cycleRows[0]) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }
    if (cycleRows[0].ended_at !== null) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Cannot add monitoring to a closed cycle' });
      return;
    }

    const cycle = cycleRows[0];

    // Calculate days from transplant (started_at to monitored_at)
    const startDate = new Date(cycle.started_at);
    const monitorDate = new Date(monitored_at);
    const daysFromTransplant = Math.floor(
      (monitorDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const weekNumber = Math.ceil((daysFromTransplant + 1) / 7);

    // Insert monitoring record
    const { rows: monRows } = await client.query(
      `INSERT INTO cycle_monitorings
         (cycle_id, monitored_at, plant_label, week_number, days_from_transplant,
          scores, sampling_effort, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        cycle_id,
        monitored_at,
        plant_label ?? null,
        weekNumber,
        daysFromTransplant,
        JSON.stringify(scores),
        sampling_effort ? JSON.stringify(sampling_effort) : null,
        notes ?? null,
        req.user!.auth0_sub,
      ],
    );
    const monitoringId = monRows[0].id;

    // Insert foci if any were reported
    for (const focus of foci) {
      await client.query(
        `INSERT INTO monitoring_foci (monitoring_id, item_key, location_text, notes)
         VALUES ($1, $2, $3, $4)`,
        [monitoringId, focus.item_key, focus.location_text ?? null, focus.notes ?? null],
      );
    }

    // Calculate new semaphore status for the lot
    const { rows: itemRows } = await client.query(
      `SELECT item_key, scale_type, threshold_value, category
         FROM crop_monitoring_items
        WHERE crop_type = $1`,
      [cycle.crop_type],
    );

    const newStatus = calculateStatus(
      scores as Record<string, number | boolean>,
      itemRows,
      daysFromTransplant,
    );

    // Update lot status with the result of this monitoring
    await client.query(
      `UPDATE lots SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, cycle.lot_id],
    );

    await client.query('COMMIT');

    res.status(201).json({
      id:         monitoringId,
      lot_status: newStatus,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating monitoring:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── GET /dashboard/cycles/:cycle_id/events ───────────────────────────────────
// Returns all events belonging to a cycle, ordered chronologically.
router.get('/cycles/:cycle_id/events', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { cycle_id } = req.params;

  try {
    // Verify cycle belongs to a lot of this org
    const { rows: cycleRows } = await pool.query(
      `SELECT c.id
         FROM lot_cycles c
         JOIN lots l ON l.id = c.lot_id
        WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );
    if (!cycleRows[0]) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT id, event_type, occurred_at, notes, data, days_from_transplant, created_by, created_at
         FROM lot_events
        WHERE cycle_id = $1
        ORDER BY occurred_at ASC`,
      [cycle_id],
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('Error fetching cycle events:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/cycles/:cycle_id/events ───────────────────────────────────
// Records an event (sowing, transplant, application, harvest) within a cycle.
// Events are stored in lot_events with cycle_id set — they belong to the cycle,
// not the lot directly. Closed cycles do not accept new events.
router.post('/cycles/:cycle_id/events', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { cycle_id } = req.params;

  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { event_type, occurred_at, notes, data } = parsed.data;

  // Reject events dated in the future
  if (new Date(occurred_at) > new Date()) {
    res.status(400).json({ error: 'No se pueden registrar eventos con fecha futura' });
    return;
  }

  try {
    // Verify cycle belongs to this org and is still active; also fetch started_at for ddt
    const { rows: cycleRows } = await pool.query(
      `SELECT c.id, c.ended_at, c.started_at, l.id AS lot_id
         FROM lot_cycles c
         JOIN lots l ON l.id = c.lot_id
        WHERE c.id = $1 AND l.organization_id = $2`,
      [cycle_id, req.user!.organization_id],
    );
    if (!cycleRows[0]) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }
    if (cycleRows[0].ended_at !== null) {
      res.status(400).json({ error: 'Cannot add events to a closed cycle' });
      return;
    }

    // Calculate days from transplant: days between cycle start and event date
    const startDate  = new Date(cycleRows[0].started_at);
    const eventDate  = new Date(occurred_at);
    const daysFromTransplant = Math.floor(
      (eventDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    const { rows } = await pool.query(
      `INSERT INTO lot_events
         (lot_id, cycle_id, event_type, occurred_at, notes, data, days_from_transplant, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        cycleRows[0].lot_id,
        cycle_id,
        event_type,
        occurred_at,
        notes ?? null,
        data ? JSON.stringify(data) : null,
        daysFromTransplant,
        req.user!.auth0_sub,
      ],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('Error creating cycle event:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
