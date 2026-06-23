import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg } from '../../middleware/auth';

const router = Router();

// ── Validation schemas ────────────────────────────────────────────────────────

const createLotSchema = z.object({
  name:      z.string().trim().min(1).max(100),
  crop_type: z.string().trim().max(100).optional(),
  area_ha:   z.number().positive().optional(),
  status:    z.enum(['green', 'yellow', 'red']).optional(),
  notes:     z.string().trim().max(500).optional(),
  // UUIDs of devices (devices.id, not device_id string) to assign to this lot
  node_ids:  z.array(z.string().uuid()).optional(),
});

const patchLotSchema = z.object({
  name:      z.string().trim().min(1).max(100).optional(),
  crop_type: z.string().trim().max(100).nullable().optional(),
  area_ha:   z.number().positive().nullable().optional(),
  status:    z.enum(['green', 'yellow', 'red']).optional(),
  notes:     z.string().trim().max(500).nullable().optional(),
  node_ids:  z.array(z.string().uuid()).optional(),
});

const createEventSchema = z.object({
  event_type:  z.enum(['sowing', 'transplant', 'application', 'harvest']),
  occurred_at: z.string().datetime(),
  notes:       z.string().trim().max(1000).optional(),
  // For application events: { product, dose, unit }
  data:        z.record(z.unknown()).optional(),
});

// ── GET /dashboard/sites/:site_id/lots ───────────────────────────────────────
// Returns all lots for a site, including their assigned nodes and latest event.
router.get('/sites/:site_id/lots', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { site_id } = req.params;

  try {
    // Main lot list with latest event joined
    const { rows: lots } = await pool.query(
      `SELECT
          l.id,
          l.name,
          l.crop_type,
          l.area_ha,
          l.status,
          l.notes,
          l.created_at,
          l.updated_at,
          -- Latest event for this lot
          le.id           AS last_event_id,
          le.event_type   AS last_event_type,
          le.occurred_at  AS last_event_at,
          le.notes        AS last_event_notes
        FROM lots l
        LEFT JOIN LATERAL (
          SELECT id, event_type, occurred_at, notes
            FROM lot_events
           WHERE lot_id = l.id
           ORDER BY occurred_at DESC
           LIMIT 1
        ) le ON TRUE
        WHERE l.organization_id = $1
          AND l.site_id = $2
        ORDER BY l.name ASC`,
      [req.user!.organization_id, site_id],
    );

    if (lots.length === 0) {
      res.json({ lots: [] });
      return;
    }

    // Fetch assigned nodes for all lots in one query
    const lotIds = lots.map((l) => l.id);
    const { rows: nodeRows } = await pool.query(
      `SELECT ln.lot_id, d.id AS device_uuid, d.device_id, d.display_name
         FROM lot_nodes ln
         JOIN devices d ON d.id = ln.device_id
        WHERE ln.lot_id = ANY($1)`,
      [lotIds],
    );

    // Group nodes by lot_id
    const nodesByLot: Record<string, { device_uuid: string; device_id: string; display_name: string }[]> = {};
    for (const row of nodeRows) {
      if (!nodesByLot[row.lot_id]) nodesByLot[row.lot_id] = [];
      nodesByLot[row.lot_id].push({
        device_uuid:  row.device_uuid,
        device_id:    row.device_id,
        display_name: row.display_name,
      });
    }

    const result = lots.map((l) => ({
      id:         l.id,
      name:       l.name,
      crop_type:  l.crop_type,
      area_ha:    l.area_ha,
      status:     l.status,
      notes:      l.notes,
      created_at: l.created_at,
      updated_at: l.updated_at,
      nodes:      nodesByLot[l.id] ?? [],
      last_event: l.last_event_id ? {
        id:         l.last_event_id,
        event_type: l.last_event_type,
        occurred_at: l.last_event_at,
        notes:      l.last_event_notes,
      } : null,
    }));

    res.json({ lots: result });
  } catch (err) {
    console.error('Error fetching lots:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/sites/:site_id/lots ──────────────────────────────────────
router.post('/sites/:site_id/lots', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { site_id } = req.params;

  const parsed = createLotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { name, crop_type, area_ha, status = 'green', notes, node_ids = [] } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO lots (organization_id, site_id, name, crop_type, area_ha, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [req.user!.organization_id, site_id, name, crop_type ?? null, area_ha ?? null, status, notes ?? null],
    );
    const lotId = rows[0].id;

    // Assign nodes if provided — verify they belong to the same org
    if (node_ids.length > 0) {
      const { rows: validDevices } = await client.query(
        `SELECT id FROM devices WHERE id = ANY($1) AND organization_id = $2`,
        [node_ids, req.user!.organization_id],
      );
      for (const dev of validDevices) {
        await client.query(
          `INSERT INTO lot_nodes (lot_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [lotId, dev.id],
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ id: lotId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating lot:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── GET /dashboard/lots/:lot_id ───────────────────────────────────────────────
// Lot detail: lot data + assigned nodes + events + degree-day accumulator.
router.get('/lots/:lot_id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { lot_id } = req.params;

  try {
    // Lot basic data
    const { rows: lotRows } = await pool.query(
      `SELECT id, name, crop_type, area_ha, status, notes, created_at, updated_at
         FROM lots
        WHERE id = $1 AND organization_id = $2`,
      [lot_id, req.user!.organization_id],
    );
    if (!lotRows[0]) {
      res.status(404).json({ error: 'Lot not found' });
      return;
    }
    const lot = lotRows[0];

    // Assigned nodes
    const { rows: nodeRows } = await pool.query(
      `SELECT d.id AS device_uuid, d.device_id, d.display_name, d.last_seen_at
         FROM lot_nodes ln
         JOIN devices d ON d.id = ln.device_id
        WHERE ln.lot_id = $1`,
      [lot_id],
    );

    // Events — full history for the lot timeline, enriched with cycle info.
    // Ordered chronologically (ASC) so the frontend can render oldest→newest.
    const { rows: eventRows } = await pool.query(
      `SELECT
          le.id, le.event_type, le.occurred_at, le.notes, le.data,
          le.created_at, le.cycle_id,
          lc.name       AS cycle_name,
          lc.crop_type  AS cycle_crop_type,
          lc.started_at AS cycle_started_at,
          lc.ended_at   AS cycle_ended_at
         FROM lot_events le
         LEFT JOIN lot_cycles lc ON lc.id = le.cycle_id
        WHERE le.lot_id = $1
        ORDER BY le.occurred_at ASC
        LIMIT 200`,
      [lot_id],
    );

    // Monitoring summaries — one entry per date per cycle for the lot timeline.
    // The frontend shows a single line per date ("Monitoreo · N plantas").
    const { rows: monitoringSummaries } = await pool.query(
      `SELECT
          cm.monitored_at,
          c.id         AS cycle_id,
          c.name       AS cycle_name,
          c.crop_type  AS cycle_crop_type,
          COUNT(*)     AS count
         FROM cycle_monitorings cm
         JOIN lot_cycles c ON c.id = cm.cycle_id
        WHERE c.lot_id = $1
        GROUP BY cm.monitored_at, c.id, c.name, c.crop_type
        ORDER BY cm.monitored_at ASC`,
      [lot_id],
    );

    res.json({
      lot: {
        ...lot,
        nodes:               nodeRows,
        events:              eventRows,
        monitoring_summaries: monitoringSummaries,
      },
    });
  } catch (err) {
    console.error('Error fetching lot detail:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /dashboard/lots/:lot_id ─────────────────────────────────────────────
router.patch('/lots/:lot_id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { lot_id } = req.params;

  const parsed = patchLotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { name, crop_type, area_ha, status, notes, node_ids } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Build dynamic SET clause — only update provided fields
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let i = 1;

    if (name      !== undefined) { updates.push(`name = $${i++}`);      values.push(name) }
    if (crop_type !== undefined) { updates.push(`crop_type = $${i++}`); values.push(crop_type) }
    if (area_ha   !== undefined) { updates.push(`area_ha = $${i++}`);   values.push(area_ha) }
    if (status    !== undefined) { updates.push(`status = $${i++}`);    values.push(status) }
    if (notes     !== undefined) { updates.push(`notes = $${i++}`);     values.push(notes) }

    if (updates.length > 1) {
      values.push(lot_id, req.user!.organization_id);
      const { rowCount } = await client.query(
        `UPDATE lots SET ${updates.join(', ')}
          WHERE id = $${i++} AND organization_id = $${i++}`,
        values,
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Lot not found' });
        return;
      }
    }

    // Replace node assignments if provided
    if (node_ids !== undefined) {
      await client.query(`DELETE FROM lot_nodes WHERE lot_id = $1`, [lot_id]);
      if (node_ids.length > 0) {
        const { rows: validDevices } = await client.query(
          `SELECT id FROM devices WHERE id = ANY($1) AND organization_id = $2`,
          [node_ids, req.user!.organization_id],
        );
        for (const dev of validDevices) {
          await client.query(
            `INSERT INTO lot_nodes (lot_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [lot_id, dev.id],
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating lot:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── DELETE /dashboard/lots/:lot_id ───────────────────────────────────────────
router.delete('/lots/:lot_id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { lot_id } = req.params;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM lots WHERE id = $1 AND organization_id = $2`,
      [lot_id, req.user!.organization_id],
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'Lot not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting lot:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/lots/:lot_id/events ───────────────────────────────────────
router.get('/lots/:lot_id/events', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
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

    const { rows } = await pool.query(
      `SELECT id, event_type, occurred_at, notes, data, created_at
         FROM lot_events
        WHERE lot_id = $1
        ORDER BY occurred_at DESC`,
      [lot_id],
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('Error fetching lot events:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/lots/:lot_id/events ──────────────────────────────────────
router.post('/lots/:lot_id/events', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { lot_id } = req.params;

  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { event_type, occurred_at, notes, data } = parsed.data;

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

    const { rows } = await pool.query(
      `INSERT INTO lot_events (lot_id, event_type, occurred_at, notes, data, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [lot_id, event_type, occurred_at, notes ?? null, data ? JSON.stringify(data) : null, req.user!.auth0_sub],
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('Error creating lot event:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
