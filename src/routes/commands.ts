import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db';
import { requireApiKeyScope } from '../middleware/apiKeyAuth';

const router = Router();

const requireCommandScope = requireApiKeyScope('command');

// ─── GET /api/v1.5/controllers/:id/snapshot ──────────────────────────────────
// Full config snapshot for a controller identified by device_id.
// Called by the device at boot and after receiving a requestSync command.
// Returns controller settings, all fogger actuators with behavior_config,
// and the influence nodes (sensor devices) for each actuator.

router.get('/:id/snapshot', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { rows: ctrlRows } = await pool.query(
    `SELECT
        c.id,
        c.mode,
        c.config_version,
        c.heartbeat_interval_seconds,
        c.override_mode,
        c.override_expires_at,
        c.context
       FROM controllers c
       JOIN devices d ON d.id = c.device_id
      WHERE d.device_id = $1`,
    [id],
  );

  if (!ctrlRows[0]) {
    res.status(404).json({ error: 'Controller not found' });
    return;
  }

  const ctrl = ctrlRows[0];

  const { rows: actuatorRows } = await pool.query(
    `SELECT
        a.id,
        a.label,
        a.relay_index,
        a.enabled,
        a.behavior_type,
        a.behavior_config,
        a.default_safe_state
       FROM actuators a
      WHERE a.controller_id = $1
        AND a.actuator_type = 'fogger'
      ORDER BY a.relay_index ASC`,
    [ctrl.id],
  );

  // Attach influence node device_ids to each actuator
  const actuators = await Promise.all(
    actuatorRows.map(async (act) => {
      const { rows: nodeRows } = await pool.query(
        `SELECT d.device_id AS sensor_id
           FROM actuator_influence_nodes ain
           JOIN devices d ON d.id = ain.sensor_device_id
          WHERE ain.actuator_id = $1`,
        [act.id],
      );
      return { ...act, influence_nodes: nodeRows.map((n) => n.sensor_id) };
    }),
  );

  // Mark controller as synced
  await pool.query(
    `UPDATE controllers
        SET last_sync_at = NOW(),
            sync_status  = 'synced',
            updated_at   = NOW()
      WHERE id = $1`,
    [ctrl.id],
  );

  res.json({
    controller: {
      id:                         ctrl.id,
      mode:                       ctrl.mode,
      config_version:             ctrl.config_version,
      heartbeat_interval_seconds: ctrl.heartbeat_interval_seconds,
      override_mode:              ctrl.override_mode,
      override_expires_at:        ctrl.override_expires_at,
      context:                    ctrl.context ?? {},
    },
    actuators,
  });
});

// ─── POST /api/v1.5/controllers/:id/heartbeat ────────────────────────────────
// Device reports liveness and current operational state.
// Updates online status, sync_status, and persists runtime state in context.
// Response tells the device whether to immediately poll for pending commands.

const HeartbeatSchema = z.object({
  config_version: z.number().int().nonnegative(),
  relay_states:   z.array(z.boolean()).max(8).optional(),
  cycle_state:    z.enum(['IDLE', 'CYCLE_ON', 'CYCLE_OFF']).optional(),
  last_vpd:       z.number().optional(),
  uptime_seconds: z.number().int().nonnegative().optional(),
  wifi_rssi:      z.number().int().optional(),
});

router.post('/:id/heartbeat', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const parsed = HeartbeatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { config_version, relay_states, cycle_state, last_vpd, uptime_seconds, wifi_rssi } = parsed.data;

  const { rows } = await pool.query(
    `SELECT c.id, c.config_version, c.context
       FROM controllers c
       JOIN devices d ON d.id = c.device_id
      WHERE d.device_id = $1`,
    [id],
  );

  if (!rows[0]) {
    res.status(404).json({ error: 'Controller not found' });
    return;
  }

  const ctrl       = rows[0];
  const inSync     = ctrl.config_version === config_version;
  const runtimeCtx = {
    ...(ctrl.context ?? {}),
    last_relay_states:   relay_states   ?? null,
    last_cycle_state:    cycle_state    ?? null,
    last_vpd:            last_vpd       ?? null,
    last_uptime_seconds: uptime_seconds ?? null,
    last_wifi_rssi:      wifi_rssi      ?? null,
  };

  await pool.query(
    `UPDATE controllers
        SET online       = TRUE,
            last_seen_at = NOW(),
            last_sync_at = CASE WHEN $2 THEN NOW() ELSE last_sync_at END,
            sync_status  = CASE WHEN $2 THEN 'synced' ELSE 'pending' END,
            context      = $3::jsonb,
            updated_at   = NOW()
      WHERE id = $1`,
    [ctrl.id, inSync, JSON.stringify(runtimeCtx)],
  );

  // Check for pending commands so device can poll immediately if needed
  const { rows: cmdRows } = await pool.query(
    `SELECT 1 FROM commands
      WHERE target_controller_id = $1
        AND state = 'PENDING'
      LIMIT 1`,
    [ctrl.id],
  );

  res.json({ ok: true, has_pending_commands: cmdRows.length > 0 });
});

// ─── GET /api/v1.5/controllers/:id/vpd ───────────────────────────────────────
// Returns one VPD value per enabled actuator, combining its influence nodes
// according to the actuator's vpd_logic (stored in behavior_config):
//   "any"     → MAX(vpd)  — starts if any node exceeds threshold (default)
//   "all"     → MIN(vpd)  — starts only when all nodes exceed threshold
//   "average" → AVG(vpd)  — starts when the average exceeds threshold
//
// Actuators with no influence nodes or no fresh data (>5 min) are omitted.
// The firmware maps each entry to its relay by relay_index.

router.get('/:id/vpd', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  // Resolve controller UUID from device_id string
  const { rows: ctrlRows } = await pool.query(
    `SELECT c.id
       FROM controllers c
       JOIN devices d ON d.id = c.device_id
      WHERE d.device_id = $1`,
    [id],
  );

  if (!ctrlRows[0]) {
    res.status(404).json({ error: 'Controller not found' });
    return;
  }

  // For each enabled actuator, get the latest VPD from each influence node
  // (within the last 5 minutes), then combine using vpd_logic.
  const { rows } = await pool.query(
    `WITH node_readings AS (
        SELECT
          a.id                                                  AS actuator_id,
          a.relay_index,
          COALESCE(a.behavior_config->>'vpd_logic', 'any')      AS vpd_logic,
          tn.vpd,
          EXTRACT(EPOCH FROM (NOW() - tn.ts))::int              AS age_seconds
        FROM actuators a
        JOIN actuator_influence_nodes ain ON ain.actuator_id = a.id
        JOIN devices d                   ON d.id = ain.sensor_device_id
        JOIN LATERAL (
          SELECT vpd, ts
            FROM telemetry_norm
           WHERE device_id = d.id
             AND vpd IS NOT NULL
             AND ts > NOW() - INTERVAL '5 minutes'
           ORDER BY ts DESC
           LIMIT 1
        ) tn ON true
        WHERE a.controller_id = $1
          AND a.enabled = true
     )
     SELECT
       relay_index,
       vpd_logic,
       CASE vpd_logic
         WHEN 'all'     THEN MIN(vpd)
         WHEN 'average' THEN ROUND(AVG(vpd)::numeric, 3)::float8
         ELSE                MAX(vpd)
       END                  AS vpd,
       MIN(age_seconds)     AS age_seconds
     FROM node_readings
     GROUP BY relay_index, vpd_logic
     ORDER BY relay_index ASC`,
    [ctrlRows[0].id],
  );

  if (rows.length === 0) {
    res.status(404).json({ error: 'No VPD data available from influence nodes' });
    return;
  }

  res.json({ actuators: rows });
});

// GET /api/v1.5/controllers/:id/commands
// Returns all PENDING commands for the controller identified by device_id
router.get('/:id/commands', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { rows: controllerRows } = await pool.query(
    `SELECT c.id
       FROM controllers c
       JOIN devices d ON d.id = c.device_id
      WHERE d.device_id = $1`,
    [id],
  );

  if (!controllerRows[0]) {
    res.status(404).json({ error: 'Controller not found' });
    return;
  }

  const controllerId = controllerRows[0].id;

  const { rows } = await pool.query(
    `SELECT id, cmd_id, command_type, payload, state, attempts, issued_at, expires_at
       FROM commands
      WHERE target_controller_id = $1
        AND state = 'PENDING'
      ORDER BY issued_at ASC`,
    [controllerId],
  );

  res.json({ commands: rows });
});

// POST /api/v1.5/controllers/:id/commands/:cmd_id/ack
// Controller confirms command execution
const AckSchema = z.object({
  state: z.enum(['APPLIED', 'FAILED']),
  error: z.string().optional(),
});

router.post('/:id/commands/:cmd_id/ack', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
  const { cmd_id } = req.params;

  const parsed = AckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { state, error } = parsed.data;

  const result = await pool.query(
    `UPDATE commands
        SET state      = $1,
            applied_at = CASE WHEN $1 = 'APPLIED' THEN NOW() ELSE applied_at END,
            last_error = $2,
            updated_at = NOW()
      WHERE cmd_id = $3
      RETURNING id`,
    [state, error ?? null, cmd_id],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: 'Command not found' });
    return;
  }

  res.json({ ok: true });
});

export default router;
