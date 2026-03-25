import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg, requireRole } from '../../middleware/auth';

const router = Router();

// ─── GET /dashboard/foggers ───────────────────────────────────────────────────
// Fogger controllers with current online status and behavior_config

router.get('/', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT
        c.id                          AS controller_id,
        c.online,
        c.last_seen_at,
        c.sync_status,
        c.override_mode,
        c.config_version,
        d.device_id,
        COALESCE(d.legacy_device_name, d.device_id) AS device_name,
        d.site_id,
        d.zone_id,
        d.last_seen_at                AS device_last_seen_at,
        a.id                          AS actuator_id,
        a.label                       AS actuator_label,
        a.behavior_type,
        a.behavior_config,
        a.enabled                     AS actuator_enabled,
        a.relay_index
       FROM controllers c
       JOIN devices d      ON d.id = c.device_id
       JOIN actuators a    ON a.controller_id = c.id
      WHERE d.organization_id = $1
        AND a.actuator_type   = 'fogger'
      ORDER BY COALESCE(d.legacy_device_name, d.device_id) ASC, a.relay_index ASC`,
    [req.user!.organization_id],
  );

  res.json({ foggers: rows });
});

// ─── GET /dashboard/foggers/presets ──────────────────────────────────────────
// Global presets (organization_id IS NULL) + org's own presets
// Own presets first, then global

router.get('/presets', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT
        id,
        organization_id,
        name,
        behavior_config,
        is_global,
        notes,
        created_at
       FROM fogger_presets
      WHERE is_active = TRUE
        AND (organization_id = $1 OR organization_id IS NULL)
      ORDER BY
        (organization_id = $1) DESC,
        name ASC`,
    [req.user!.organization_id],
  );

  res.json({ presets: rows });
});

// ─── PATCH /dashboard/foggers/:id/config ─────────────────────────────────────
// Update actuator behavior_config for a fogger actuator

const FoggerConfigSchema = z.object({
  trigger:              z.literal('vpd'),
  threshold_on:         z.number().positive(),
  threshold_off:        z.number().positive(),
  on_seconds:           z.number().int().positive(),
  off_seconds:          z.number().int().positive(),
  schedule:             z.object({
    from: z.string().regex(/^\d{2}:\d{2}$/, 'schedule.from must be HH:MM'),
    to:   z.string().regex(/^\d{2}:\d{2}$/, 'schedule.to must be HH:MM'),
  }),
  min_interval_seconds: z.number().int().positive(),
});

router.patch(
  '/:id/config',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'operator', 'superuser', 'distributor']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = FoggerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    // Verify actuator belongs to org and is a fogger
    const { rows } = await pool.query(
      `UPDATE actuators a
          SET behavior_config = $1,
              updated_at      = NOW()
         FROM controllers c
         JOIN devices d ON d.id = c.device_id
        WHERE a.id              = $2
          AND a.controller_id   = c.id
          AND a.actuator_type   = 'fogger'
          AND d.organization_id = $3
        RETURNING a.id, a.label, a.behavior_config`,
      [JSON.stringify(parsed.data), req.params.id, req.user!.organization_id],
    );

    if (!rows[0]) {
      res.status(404).json({ error: 'Fogger actuator not found' });
      return;
    }

    res.json({ ok: true, actuator: rows[0] });
  },
);

export default router;
