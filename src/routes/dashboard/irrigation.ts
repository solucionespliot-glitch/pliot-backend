import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db';
import { requireAuth, requireOrg, requireRole } from '../../middleware/auth';

const router = Router();

// ─── GET /dashboard/irrigation/turns ─────────────────────────────────────────
// Active turns with ETc accumulated, next estimated irrigation, active Kc stage, actuators

router.get('/turns', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { rows } = await pool.query(
    `SELECT
        it.id,
        it.name,
        it.status,
        it.sowing_date,
        it.crop,
        it.producer_adjustment_percent,
        it.error_recovery_mode,
        it.created_at,
        -- Days since sowing
        EXTRACT(DAY FROM NOW() - it.sowing_date::timestamptz)::integer AS days_since_sowing,
        -- ETc accumulated from completed executions
        COALESCE((
          SELECT SUM(io.observed_volume_l)
            FROM irrigation_executions ie
            JOIN irrigation_observations io ON io.irrigation_execution_id = ie.id
           WHERE ie.irrigation_turn_id = it.id
             AND ie.execution_state = 'COMPLETED'
             AND io.status = 'CONFIRMED'
        ), 0) AS etc_accumulated_l,
        -- Next estimated irrigation (earliest future plan)
        (
          SELECT ip.planned_start_at
            FROM irrigation_plans ip
           WHERE ip.irrigation_turn_id = it.id
             AND ip.planned_start_at > NOW()
           ORDER BY ip.planned_start_at ASC
           LIMIT 1
        ) AS next_irrigation_at,
        -- Active Kc stage based on days since sowing
        (
          SELECT s.stage_name
            FROM crop_kc_profile_stages s
            JOIN irrigation_profiles prof ON prof.crop_kc_profile_id = s.crop_kc_profile_id
           WHERE prof.id = it.irrigation_profile_id
             AND s.day_from <= EXTRACT(DAY FROM NOW() - it.sowing_date::timestamptz)
             AND (s.day_to IS NULL OR s.day_to >= EXTRACT(DAY FROM NOW() - it.sowing_date::timestamptz))
           ORDER BY s.day_from DESC
           LIMIT 1
        ) AS kc_stage_active,
        (
          SELECT s.kc_value
            FROM crop_kc_profile_stages s
            JOIN irrigation_profiles prof ON prof.crop_kc_profile_id = s.crop_kc_profile_id
           WHERE prof.id = it.irrigation_profile_id
             AND s.day_from <= EXTRACT(DAY FROM NOW() - it.sowing_date::timestamptz)
             AND (s.day_to IS NULL OR s.day_to >= EXTRACT(DAY FROM NOW() - it.sowing_date::timestamptz))
           ORDER BY s.day_from DESC
           LIMIT 1
        ) AS kc_value_active,
        -- Assigned actuators
        COALESCE((
          SELECT JSON_AGG(JSON_BUILD_OBJECT(
            'actuator_id', a.id,
            'label', a.label,
            'actuator_type', a.actuator_type,
            'enabled', a.enabled
          ))
          FROM irrigation_turn_actuators ita
          JOIN actuators a ON a.id = ita.actuator_id
         WHERE ita.irrigation_turn_id = it.id
        ), '[]') AS actuators
       FROM irrigation_turns it
       JOIN controllers c  ON c.id = it.controller_id
       JOIN devices d      ON d.id = c.device_id
      WHERE d.organization_id = $1
        AND it.status NOT IN ('finished')
      ORDER BY it.created_at DESC`,
    [req.user!.organization_id],
  );

  res.json({ turns: rows });
});

// ─── GET /dashboard/irrigation/turns/:turn_id/history ────────────────────────
// Plans + executions + observations grouped by date

router.get('/turns/:turn_id/history', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { turn_id } = req.params;

  // Verify org ownership
  const { rows: ownerRows } = await pool.query(
    `SELECT it.id
       FROM irrigation_turns it
       JOIN controllers c ON c.id = it.controller_id
       JOIN devices d     ON d.id = c.device_id
      WHERE it.id = $1 AND d.organization_id = $2`,
    [turn_id, req.user!.organization_id],
  );

  if (!ownerRows[0]) {
    res.status(404).json({ error: 'Irrigation turn not found' });
    return;
  }

  const { rows } = await pool.query(
    `SELECT
        DATE(ip.planned_start_at)              AS plan_date,
        ip.id                                  AS plan_id,
        ip.planned_start_at,
        ip.planned_end_at,
        ip.target_depth_mm,
        ip.target_volume_l,
        ip.target_duration_seconds,
        ip.kc_stage,
        ip.kc_value,
        ip.etp_source,
        ip.plan_source,
        ie.id                                  AS execution_id,
        ie.execution_state,
        ie.commanded_duration_seconds,
        ie.commanded_volume_l,
        ie.requested_start_at,
        ie.requested_end_at,
        io.id                                  AS observation_id,
        io.observed_start_at,
        io.observed_end_at,
        io.observed_duration_seconds,
        io.observed_volume_l,
        io.observed_flow_l_min,
        io.verification_source,
        io.confidence,
        io.status                              AS observation_status
       FROM irrigation_plans ip
       LEFT JOIN irrigation_executions ie ON ie.irrigation_plan_id = ip.id
       LEFT JOIN irrigation_observations io ON io.irrigation_execution_id = ie.id
      WHERE ip.irrigation_turn_id = $1
      ORDER BY ip.planned_start_at DESC`,
    [turn_id],
  );

  res.json({ history: rows });
});

// ─── POST /dashboard/irrigation/turns ────────────────────────────────────────

const CreateTurnSchema = z.object({
  name:                        z.string().min(1),
  controller_id:               z.string().uuid(),
  irrigation_profile_id:       z.string().uuid().optional(),
  sowing_date:                 z.string().date().optional(),
  crop:                        z.string().optional(),
  producer_adjustment_percent: z.number().default(0),
});

router.post(
  '/turns',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'operator', 'superuser']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTurnSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { name, controller_id, irrigation_profile_id, sowing_date, crop, producer_adjustment_percent } = parsed.data;

    // Ensure controller belongs to this org
    const { rows: ctrlRows } = await pool.query(
      `SELECT c.id FROM controllers c
         JOIN devices d ON d.id = c.device_id
        WHERE c.id = $1 AND d.organization_id = $2`,
      [controller_id, req.user!.organization_id],
    );

    if (!ctrlRows[0]) {
      res.status(404).json({ error: 'Controller not found' });
      return;
    }

    const { rows } = await pool.query(
      `INSERT INTO irrigation_turns
         (name, controller_id, irrigation_profile_id, sowing_date, crop, producer_adjustment_percent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, controller_id, irrigation_profile_id ?? null, sowing_date ?? null, crop ?? null, producer_adjustment_percent],
    );

    res.status(201).json({ turn: rows[0] });
  },
);

// ─── PATCH /dashboard/irrigation/turns/:turn_id ───────────────────────────────

const UpdateTurnSchema = z.object({
  status:                      z.enum(['active', 'paused', 'finished', 'error']).optional(),
  error_recovery_mode:         z.enum(['auto', 'manual_confirm']).optional(),
  producer_adjustment_percent: z.number().optional(),
});

router.patch(
  '/turns/:turn_id',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'operator', 'superuser']),
  async (req: Request, res: Response): Promise<void> => {
    const { turn_id } = req.params;

    const parsed = UpdateTurnSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const updates = parsed.data;

    // Verify org ownership
    const { rows: ownerRows } = await pool.query(
      `SELECT it.id FROM irrigation_turns it
         JOIN controllers c ON c.id = it.controller_id
         JOIN devices d     ON d.id = c.device_id
        WHERE it.id = $1 AND d.organization_id = $2`,
      [turn_id, req.user!.organization_id],
    );

    if (!ownerRows[0]) {
      res.status(404).json({ error: 'Irrigation turn not found' });
      return;
    }

    const setClauses: string[]  = ['updated_at = NOW()'];
    const params: unknown[]     = [];
    let   idx                   = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${idx++}`);
      params.push(updates.status);
      // Record finished_at in notes when finishing (no dedicated column)
      if (updates.status === 'finished') {
        setClauses.push(`notes = CONCAT(COALESCE(notes, ''), ' [finished_at: ', NOW()::text, ']')`);
      }
    }
    if (updates.error_recovery_mode !== undefined) {
      setClauses.push(`error_recovery_mode = $${idx++}`);
      params.push(updates.error_recovery_mode);
    }
    if (updates.producer_adjustment_percent !== undefined) {
      setClauses.push(`producer_adjustment_percent = $${idx++}`);
      params.push(updates.producer_adjustment_percent);
    }

    params.push(turn_id);

    const { rows } = await pool.query(
      `UPDATE irrigation_turns SET ${setClauses.join(', ')}
        WHERE id = $${idx}
        RETURNING *`,
      params,
    );

    res.json({ turn: rows[0] });
  },
);

export default router;
