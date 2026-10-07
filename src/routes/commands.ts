import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db';
import { requireApiKeyScope } from '../middleware/apiKeyAuth';

const router = Router();

const requireCommandScope = requireApiKeyScope('command');

// ─── GET /api/v1.5/controllers/:id/snapshot ──────────────────────────────────
// Full config snapshot for a controller identified by device_id.
// Called by the device at boot and after receiving a requestSync command.
// Returns controller settings, all enabled actuators with behavior_type +
// behavior_config, influence nodes per actuator, and the site's UTC offset
// so the firmware can convert NTP time to local time for schedule/irrigation.

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
        c.context,
        -- UTC offset in minutes derived from the site's IANA timezone.
        -- The firmware uses this to convert NTP (UTC) time to local time
        -- for schedule and irrigation control logic.
        EXTRACT(EPOCH FROM (TIMEZONE(s.timezone, NOW()) - NOW()))::int / 60
          AS utc_offset_minutes
       FROM controllers c
       JOIN devices d ON d.id  = c.device_id
       JOIN sites   s ON s.id  = d.site_id
      WHERE d.device_id = $1`,
    [id],
  );

  if (!ctrlRows[0]) {
    res.status(404).json({ error: 'Controller not found' });
    return;
  }

  const ctrl = ctrlRows[0];

  // Return all enabled actuators regardless of actuator_type.
  // behavior_type is the single source of truth for control logic.
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
        AND a.enabled = true
      ORDER BY a.relay_index ASC`,
    [ctrl.id],
  );

  // Attach influence nodes to each actuator.
  // ABP keys are included for LoRa nodes (used by gateway-mode firmware to
  // decrypt packets locally). WiFi-only nodes have null dev_addr/keys — the
  // firmware fetches their readings via /readings instead.
  const actuators = await Promise.all(
    actuatorRows.map(async (act) => {
      const { rows: nodeRows } = await pool.query(
        `SELECT d.device_id   AS sensor_id,
                k.dev_addr,
                k.app_s_key,
                k.nwk_s_key
           FROM actuator_influence_nodes ain
           JOIN devices d ON d.id = ain.sensor_device_id
           LEFT JOIN lora_abp_keys k ON k.device_id = d.id
          WHERE ain.actuator_id = $1`,
        [act.id],
      );
      return {
        ...act,
        influence_nodes: nodeRows.map((n) => ({
          sensor_id: n.sensor_id,
          dev_addr:  n.dev_addr  ?? null,
          app_s_key: n.app_s_key ?? null,
          nwk_s_key: n.nwk_s_key ?? null,
        })),
      };
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
      utc_offset_minutes:         ctrl.utc_offset_minutes,
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
  // cycle_states: one entry per relay (independent mode) or repeated coordinator
  // state for all relays (cascade mode). Replaces the old single cycle_state field.
  cycle_states:   z.array(z.enum(['IDLE', 'CYCLE_ON', 'CYCLE_OFF'])).max(8).optional(),
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

  const { config_version, relay_states, cycle_states, uptime_seconds, wifi_rssi } = parsed.data;

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
    last_cycle_states:   cycle_states   ?? null,
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

// ─── GET /api/v1.5/controllers/:id/readings ──────────────────────────────────
// Returns the latest sensor readings per actuator, combining influence nodes
// according to the actuator's vpd_logic (stored in behavior_config).
// Used by sensor-dependent behavior types: vpd, temperature.
//
// vpd_logic (applies to both vpd and temperature aggregation):
//   "any"     → MAX — triggers if any node exceeds threshold
//   "all"     → MIN — triggers only when all nodes exceed threshold
//   "average" → AVG — triggers when the average exceeds threshold
//
// Only actuators with at least one influence node with fresh data (<15 min)
// are included. The firmware treats a missing actuator entry as stale.
// The firmware maps each entry to its relay by relay_index.

router.get('/:id/readings', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
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

  // For each enabled actuator, get the latest vpd and temperature from each
  // influence node (within the last 15 minutes), then combine using vpd_logic.
  // 15 min window = allows missing 2 consecutive sends at the 7-min node interval.
  const { rows } = await pool.query(
    `WITH node_readings AS (
        SELECT
          a.id                                                  AS actuator_id,
          a.relay_index,
          COALESCE(a.behavior_config->>'vpd_logic', 'any')      AS vpd_logic,
          tn.vpd,
          tn.temperature,
          EXTRACT(EPOCH FROM (NOW() - tn.ts))::int              AS age_seconds
        FROM actuators a
        JOIN actuator_influence_nodes ain ON ain.actuator_id = a.id
        JOIN devices d                   ON d.id = ain.sensor_device_id
        JOIN LATERAL (
          SELECT vpd, temperature, ts
            FROM telemetry_norm
           WHERE device_id = d.id
             AND ts > NOW() - INTERVAL '15 minutes'
           ORDER BY ts DESC
           LIMIT 1
        ) tn ON true
        WHERE a.controller_id = $1
          AND a.enabled = true
     )
     SELECT
       relay_index,
       vpd_logic,
       -- Aggregate vpd according to vpd_logic; null if no node has vpd data
       CASE vpd_logic
         WHEN 'all'     THEN MIN(vpd)
         WHEN 'average' THEN ROUND(AVG(vpd)::numeric, 3)::float8
         ELSE                MAX(vpd)
       END                                      AS vpd,
       -- Aggregate temperature with the same logic
       CASE vpd_logic
         WHEN 'all'     THEN MIN(temperature)
         WHEN 'average' THEN ROUND(AVG(temperature)::numeric, 2)::float8
         ELSE                MAX(temperature)
       END                                      AS temperature,
       MIN(age_seconds)                         AS age_seconds
     FROM node_readings
     GROUP BY relay_index, vpd_logic
     ORDER BY relay_index ASC`,
    [ctrlRows[0].id],
  );

  // Return empty list (not 404) so the firmware can distinguish
  // "no influence nodes configured" from a network/server error.
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
