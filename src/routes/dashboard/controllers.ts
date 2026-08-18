import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg, requireRole } from '../../middleware/auth';

const router = Router();

// GET /dashboard/controllers
// List controllers with sync_status, override_mode, last heartbeat
router.get('/', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT
        c.id,
        c.mode,
        c.environment_type,
        c.online,
        c.last_seen_at,
        c.sync_status,
        c.override_mode,
        c.override_expires_at,
        c.config_version,
        c.last_sync_at,
        c.context,
        d.device_id,
        d.device_type,
        COALESCE(d.legacy_device_name, d.device_id) AS device_name,
        d.site_id,
        d.zone_id
       FROM controllers c
       JOIN devices d ON d.id = c.device_id
      WHERE d.organization_id = $1
      ORDER BY COALESCE(d.legacy_device_name, d.device_id) ASC`,
    [req.user!.organization_id],
  );

  res.json({ controllers: rows });
});

// PATCH /dashboard/controllers/:id/override
// Update override_mode and override_expires_at. Roles: producer, operator, superuser.
const OverrideSchema = z.object({
  override_mode:       z.enum(['none', 'temporary_24h', 'temporary_48h', 'permanent']),
  override_expires_at: z.string().datetime().optional(),
});

router.patch(
  '/:id/override',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'operator', 'superuser']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = OverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { override_mode, override_expires_at } = parsed.data;

    const { rows } = await pool.query(
      `UPDATE controllers c
          SET override_mode       = $1,
              override_expires_at = $2,
              updated_at          = NOW()
         FROM devices d
        WHERE c.device_id       = d.id
          AND c.id              = $3
          AND d.organization_id = $4
        RETURNING c.id, c.override_mode, c.override_expires_at`,
      [override_mode, override_expires_at ?? null, req.params.id, req.user!.organization_id],
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Controller not found' });
      return;
    }

    res.json({ ok: true, controller: rows[0] });
  },
);

// ─── PATCH /dashboard/controllers/:id/context ────────────────────────────────
// Update controller-level settings stored in context JSONB.
// Currently used for relay_mode and cascade_delay_ms.
// Merges with existing context — does not overwrite unrelated fields.

const ControllerContextSchema = z.object({
  relay_mode:       z.enum(['cascade', 'independent']).optional(),
  cascade_delay_ms: z.number().int().min(0).max(5000).optional(),
});

router.patch(
  '/:id/context',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'operator', 'superuser', 'distributor']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = ControllerContextSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { rows } = await pool.query(
      `UPDATE controllers c
          SET context      = COALESCE(c.context, '{}'::jsonb) || $1::jsonb,
              sync_status  = 'pending',
              config_version = c.config_version + 1,
              updated_at   = NOW()
         FROM devices d
        WHERE c.device_id       = d.id
          AND c.id              = $2
          AND d.organization_id = $3
        RETURNING c.id, c.context, c.config_version, c.sync_status`,
      [JSON.stringify(parsed.data), req.params.id, req.user!.organization_id],
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Controller not found' });
      return;
    }

    res.json({ ok: true, controller: rows[0] });
  },
);

// ─── GET /dashboard/controllers/:id/actuators ────────────────────────────────
// Returns all actuators for a controller with their behavior_config and
// the list of influence nodes currently assigned to each one.
// Accessible to any authenticated user of the org.

router.get(
  '/:id/actuators',
  requireAuth,
  requireOrg,
  async (req: Request, res: Response): Promise<void> => {
    // Verify controller belongs to the requesting org
    const { rows: ctrlRows } = await pool.query(
      `SELECT c.id FROM controllers c
         JOIN devices d ON d.id = c.device_id
        WHERE c.id = $1 AND d.organization_id = $2`,
      [req.params.id, req.user!.organization_id],
    );
    if (!ctrlRows[0]) {
      res.status(404).json({ error: 'Controller not found' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT
          a.id,
          a.label,
          a.relay_index,
          a.enabled,
          a.behavior_type,
          a.behavior_config,
          a.default_safe_state,
          COALESCE(
            json_agg(
              json_build_object('id', d.id, 'device_id', d.device_id)
              ORDER BY d.device_id
            ) FILTER (WHERE d.id IS NOT NULL),
            '[]'::json
          ) AS influence_nodes
         FROM actuators a
         LEFT JOIN actuator_influence_nodes ain ON ain.actuator_id = a.id
         LEFT JOIN devices d                   ON d.id = ain.sensor_device_id
        WHERE a.controller_id = $1
        GROUP BY a.id
        ORDER BY a.relay_index ASC`,
      [ctrlRows[0].id],
    );

    res.json({ actuators: rows });
  },
);

// ─── PUT /dashboard/controllers/:id/actuators/:actuator_id ───────────────────
// Updates behavior_config fields for one actuator (thresholds, schedule,
// vpd_logic). Merges into existing config — fields not sent are preserved.
// Bumps config_version so the device fetches a new snapshot on next heartbeat.
// Requires producer role or above.

const ActuatorConfigSchema = z.object({
  vpd_logic:            z.enum(['any', 'all', 'average']).optional(),
  threshold_on:         z.number().min(0).max(5).optional(),
  threshold_off:        z.number().min(0).max(5).optional(),
  on_seconds:           z.number().int().min(1).max(3600).optional(),
  off_seconds:          z.number().int().min(1).max(3600).optional(),
  min_interval_seconds: z.number().int().min(0).optional(),
  schedule: z.object({
    from: z.string().regex(/^\d{2}:\d{2}$/, 'Expected HH:MM'),
    to:   z.string().regex(/^\d{2}:\d{2}$/, 'Expected HH:MM'),
  }).optional(),
});

router.put(
  '/:id/actuators/:actuator_id',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'distributor', 'superuser']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = ActuatorConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { rows: ctrlRows } = await pool.query(
      `SELECT c.id FROM controllers c
         JOIN devices d ON d.id = c.device_id
        WHERE c.id = $1 AND d.organization_id = $2`,
      [req.params.id, req.user!.organization_id],
    );
    if (!ctrlRows[0]) {
      res.status(404).json({ error: 'Controller not found' });
      return;
    }

    // Merge new fields into existing behavior_config without overwriting unrelated keys
    const { rows } = await pool.query(
      `UPDATE actuators
          SET behavior_config = COALESCE(behavior_config, '{}'::jsonb) || $1::jsonb,
              updated_at      = NOW()
        WHERE id            = $2
          AND controller_id = $3
        RETURNING id, relay_index, label, behavior_config`,
      [JSON.stringify(parsed.data), req.params.actuator_id, ctrlRows[0].id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Actuator not found' });
      return;
    }

    // Bump config_version so the device knows to re-sync
    await pool.query(
      `UPDATE controllers
          SET config_version = config_version + 1,
              sync_status    = 'pending',
              updated_at     = NOW()
        WHERE id = $1`,
      [ctrlRows[0].id],
    );

    res.json({ ok: true, actuator: rows[0] });
  },
);

// ─── PUT /dashboard/controllers/:id/actuators/:actuator_id/nodes ─────────────
// Replaces the set of influence nodes for one actuator.
// Validates that all node UUIDs belong to the same org.
// Runs inside a transaction; bumps config_version on success.
// Requires producer role or above.

const NodesSchema = z.object({
  node_ids: z.array(z.string().uuid()).max(10),
});

router.put(
  '/:id/actuators/:actuator_id/nodes',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'distributor', 'superuser']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = NodesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { node_ids } = parsed.data;

    const { rows: ctrlRows } = await pool.query(
      `SELECT c.id FROM controllers c
         JOIN devices d ON d.id = c.device_id
        WHERE c.id = $1 AND d.organization_id = $2`,
      [req.params.id, req.user!.organization_id],
    );
    if (!ctrlRows[0]) {
      res.status(404).json({ error: 'Controller not found' });
      return;
    }

    const { rows: actRows } = await pool.query(
      `SELECT id FROM actuators WHERE id = $1 AND controller_id = $2`,
      [req.params.actuator_id, ctrlRows[0].id],
    );
    if (!actRows[0]) {
      res.status(404).json({ error: 'Actuator not found' });
      return;
    }

    // All nodes must belong to the same org to prevent cross-tenant data access
    if (node_ids.length > 0) {
      const { rows: nodeRows } = await pool.query(
        `SELECT id FROM devices WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [node_ids, req.user!.organization_id],
      );
      if (nodeRows.length !== node_ids.length) {
        res.status(400).json({ error: 'One or more nodes not found in your organization' });
        return;
      }
    }

    // Replace influence nodes atomically
    await pool.query('BEGIN');
    try {
      await pool.query(
        `DELETE FROM actuator_influence_nodes WHERE actuator_id = $1`,
        [req.params.actuator_id],
      );

      for (const nodeId of node_ids) {
        await pool.query(
          `INSERT INTO actuator_influence_nodes (actuator_id, sensor_device_id)
           VALUES ($1, $2)`,
          [req.params.actuator_id, nodeId],
        );
      }

      await pool.query(
        `UPDATE controllers
            SET config_version = config_version + 1,
                sync_status    = 'pending',
                updated_at     = NOW()
          WHERE id = $1`,
        [ctrlRows[0].id],
      );

      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    res.json({ ok: true, node_ids });
  },
);

export default router;
