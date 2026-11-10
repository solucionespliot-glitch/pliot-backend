import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg } from '../../middleware/auth';

const router = Router();

// All routes require auth + org context
router.use(requireAuth, requireOrg);

// Helper to get org id from request (set by requireAuth middleware)
function getOrgId(req: Request): string {
  return req.user!.organization_id;
}

// Valid metric names (normalized column names from telemetry_norm)
const VALID_METRICS = [
  'temperature', 'humidity', 'vpd', 'co2', 'battery_voltage',
  'dew_point', 'soil_moisture_cap', 'rika_moisture', 'soil_temperature',
] as const;

const CreateRuleSchema = z.object({
  name:             z.string().min(1).max(255),
  metric:           z.enum(VALID_METRICS),
  operator:         z.enum(['gt', 'lt', 'gte', 'lte']),
  threshold:        z.number(),
  site_id:          z.string().uuid().nullable().optional(),
  device_id:        z.string().uuid().nullable().optional(),
  cooldown_minutes: z.number().int().min(1).max(1440).optional(),
});

const UpdateRuleSchema = z.object({
  name:             z.string().min(1).max(255).optional(),
  metric:           z.enum(VALID_METRICS).optional(),
  operator:         z.enum(['gt', 'lt', 'gte', 'lte']).optional(),
  threshold:        z.number().optional(),
  site_id:          z.string().uuid().nullable().optional(),
  device_id:        z.string().uuid().nullable().optional(),
  cooldown_minutes: z.number().int().min(1).max(1440).optional(),
  enabled:          z.boolean().optional(),
});

// ─── GET /dashboard/alarms/rules ─────────────────────────────────────────────
// Returns all alarm rules for the current organization.
router.get('/rules', async (req: Request, res: Response): Promise<void> => {
  try {
    const orgId = getOrgId(req);

    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.metric, r.operator, r.threshold,
              r.site_id, r.device_id, r.cooldown_minutes, r.enabled,
              r.created_at, r.updated_at,
              s.name AS site_name,
              d.device_id AS device_label
         FROM alarm_rules r
         LEFT JOIN sites   s ON s.id = r.site_id
         LEFT JOIN devices d ON d.id = r.device_id
        WHERE r.organization_id = $1
        ORDER BY r.created_at DESC`,
      [orgId],
    );

    res.json({ rules: rows });
  } catch (err) {
    console.error('GET /alarms/rules error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /dashboard/alarms/rules ────────────────────────────────────────────
router.post('/rules', async (req: Request, res: Response): Promise<void> => {
  try {
    const orgId = getOrgId(req);

    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { name, metric, operator, threshold, site_id, device_id, cooldown_minutes } = parsed.data;

    // If device_id provided, verify it belongs to this org
    if (device_id) {
      const { rows } = await pool.query(
        `SELECT id FROM devices WHERE id = $1 AND organization_id = $2`,
        [device_id, orgId],
      );
      if (!rows[0]) {
        res.status(400).json({ error: 'Device not found in this organization' });
        return;
      }
    }

    // If site_id provided, verify it belongs to this org
    if (site_id) {
      const { rows } = await pool.query(
        `SELECT id FROM sites WHERE id = $1 AND organization_id = $2`,
        [site_id, orgId],
      );
      if (!rows[0]) {
        res.status(400).json({ error: 'Site not found in this organization' });
        return;
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO alarm_rules
         (organization_id, site_id, device_id, name, metric, operator, threshold, cooldown_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [orgId, site_id ?? null, device_id ?? null, name, metric, operator, threshold, cooldown_minutes ?? 60],
    );

    res.status(201).json({ rule: rows[0] });
  } catch (err) {
    console.error('POST /alarms/rules error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /dashboard/alarms/rules/:id ───────────────────────────────────────
router.patch('/rules/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const orgId  = getOrgId(req);
    const ruleId = req.params['id'];

    // Verify rule belongs to this org
    const { rows: existing } = await pool.query(
      `SELECT id FROM alarm_rules WHERE id = $1 AND organization_id = $2`,
      [ruleId, orgId],
    );
    if (!existing[0]) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    const parsed = UpdateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const data = parsed.data;
    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    // Build dynamic SET clause — only update fields that were provided
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[]    = [ruleId, orgId];
    let paramIdx               = 3;

    const updatable = ['name', 'metric', 'operator', 'threshold', 'site_id', 'device_id', 'cooldown_minutes', 'enabled'] as const;
    for (const field of updatable) {
      if (data[field] !== undefined) {
        setClauses.push(`${field} = $${paramIdx++}`);
        params.push(data[field] as unknown);
      }
    }

    const { rows } = await pool.query(
      `UPDATE alarm_rules SET ${setClauses.join(', ')}
        WHERE id = $1 AND organization_id = $2
       RETURNING *`,
      params,
    );

    res.json({ rule: rows[0] });
  } catch (err) {
    console.error('PATCH /alarms/rules/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /dashboard/alarms/rules/:id ──────────────────────────────────────
router.delete('/rules/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const orgId  = getOrgId(req);
    const ruleId = req.params['id'];

    const { rowCount } = await pool.query(
      `DELETE FROM alarm_rules WHERE id = $1 AND organization_id = $2`,
      [ruleId, orgId],
    );

    if (!rowCount) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /alarms/rules/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /dashboard/alarms/events ────────────────────────────────────────────
// Query params:
//   active=true  — only unresolved events
//   site_id=UUID — filter by site
//   limit=N      — max results (default 50, max 200)
router.get('/events', async (req: Request, res: Response): Promise<void> => {
  try {
    const orgId = getOrgId(req);

    const activeOnly = req.query['active'] === 'true';
    const siteId     = req.query['site_id'] as string | undefined;
    const rawLimit   = parseInt(req.query['limit'] as string ?? '50', 10);
    const limit      = isNaN(rawLimit) ? 50 : Math.min(rawLimit, 200);

    const params: unknown[] = [orgId];
    const conditions: string[] = ['r.organization_id = $1'];
    let paramIdx = 2;

    if (activeOnly) {
      conditions.push('e.resolved_at IS NULL');
    }

    if (siteId) {
      conditions.push(`d.site_id = $${paramIdx++}`);
      params.push(siteId);
    }

    params.push(limit);
    const limitParam = `$${paramIdx}`;

    const { rows } = await pool.query(
      `SELECT e.id, e.metric, e.value, e.threshold, e.operator,
              e.triggered_at, e.resolved_at, e.acknowledged_at, e.acknowledged_by,
              r.name AS rule_name,
              d.device_id AS device_label, d.id AS device_uuid,
              s.name AS site_name
         FROM alarm_events e
         JOIN alarm_rules r ON r.id = e.rule_id
         JOIN devices     d ON d.id = e.device_id
         LEFT JOIN sites  s ON s.id = d.site_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.triggered_at DESC
        LIMIT ${limitParam}`,
      params,
    );

    // Count of unresolved events (for the navbar badge)
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total
         FROM alarm_events e
         JOIN alarm_rules r ON r.id = e.rule_id
        WHERE r.organization_id = $1
          AND e.resolved_at IS NULL
          AND e.acknowledged_at IS NULL`,
      [orgId],
    );

    res.json({
      events:          rows,
      unacked_active:  parseInt(countRows[0].total, 10),
    });
  } catch (err) {
    console.error('GET /alarms/events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /dashboard/alarms/events/:id/ack ───────────────────────────────────
// Acknowledges an alarm event. Does not resolve it — acknowledgement and
// resolution are separate concepts: ack = "I've seen this", resolve = "value is back to normal".
router.post('/events/:id/ack', async (req: Request, res: Response): Promise<void> => {
  try {
    const orgId   = getOrgId(req);
    const eventId = req.params['id'];
    const userSub = req.user?.auth0_sub ?? 'unknown';

    // Verify event belongs to this org via the rule
    const { rowCount } = await pool.query(
      `UPDATE alarm_events e
          SET acknowledged_at = NOW(), acknowledged_by = $3
         FROM alarm_rules r
        WHERE e.id = $1
          AND e.rule_id = r.id
          AND r.organization_id = $2
          AND e.acknowledged_at IS NULL`,
      [eventId, orgId, userSub],
    );

    if (!rowCount) {
      res.status(404).json({ error: 'Event not found or already acknowledged' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /alarms/events/:id/ack error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
