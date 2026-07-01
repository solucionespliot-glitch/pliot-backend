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

export default router;
