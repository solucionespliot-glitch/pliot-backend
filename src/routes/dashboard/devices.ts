import { Router, Request, Response } from 'express';
import { pool } from '../../db';
import { requireAuth, requireOrg } from '../../middleware/auth';

const router = Router();

// Whitelisted telemetry columns — prevents SQL injection on dynamic SELECT
const TELEMETRY_COLUMNS = new Set([
  'battery_voltage', 'temperature', 'humidity', 'vpd', 'dew_point',
  'light', 'co2', 'report_period', 'flow_main', 'ph', 'ec',
  'tank_level', 'scale_weight', 'wind_speed', 'wind_direction',
  'rain', 'fertimeter',
]);

// ─── GET /dashboard/sites ────────────────────────────────────────────────────
router.get('/sites', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, latitude, longitude, timezone, enabled, created_at
         FROM sites
        WHERE organization_id = $1
          AND enabled = true
        ORDER BY name ASC`,
      [req.user!.organization_id],
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching sites:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /dashboard/sites/:site_id/devices ───────────────────────────────────
router.get('/sites/:site_id/devices', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { site_id } = req.params;
  const { zone_id } = req.query;

  const params: unknown[] = [req.user!.organization_id, site_id];
  let zoneFilter = '';
  if (zone_id && typeof zone_id === 'string') {
    params.push(zone_id);
    zoneFilter = `AND d.zone_id = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT
          d.id,
          d.device_id,
          COALESCE(d.legacy_device_name, d.device_id) AS display_name,
          d.device_type,
          d.zone_id,
          z.name                                        AS zone_name,
          d.enabled,
          d.firmware_version,
          d.last_seen_at,
          d.last_seen_at > NOW() - INTERVAL '10 minutes' AS online,
          tn.ts                                         AS last_telemetry_ts,
          tn.temperature,
          tn.humidity,
          tn.vpd,
          tn.battery_voltage,
          tn.light,
          tn.co2,
          tn.flow_main,
          tn.ph,
          tn.ec,
          tn.tank_level,
          tn.extras
         FROM devices d
         LEFT JOIN zones z ON z.id = d.zone_id
         LEFT JOIN LATERAL (
           SELECT *
             FROM telemetry_norm tn
            WHERE tn.device_id = d.id
            ORDER BY tn.ts DESC
            LIMIT 1
         ) tn ON TRUE
        WHERE d.organization_id = $1
          AND d.site_id = $2
          ${zoneFilter}
        ORDER BY d.device_id ASC`,
      params,
    );
    res.json({ devices: rows });
  } catch (err) {
    console.error('Error fetching devices:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /dashboard/devices/:device_id/telemetry ─────────────────────────────
router.get('/devices/:device_id/telemetry', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { device_id } = req.params;
  const { from, to, variables, aggregation = 'raw' } = req.query;

  if (!from || !to) {
    res.status(400).json({ error: 'Query params from and to are required (ISO timestamps)' });
    return;
  }

  try {
    const { rows: devRows } = await pool.query(
      `SELECT id FROM devices WHERE device_id = $1 AND organization_id = $2`,
      [device_id, req.user!.organization_id],
    );
    if (!devRows[0]) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    const internalDeviceId = devRows[0].id;

    const requestedCols = variables && typeof variables === 'string'
      ? variables.split(',').map((v) => v.trim()).filter((v) => TELEMETRY_COLUMNS.has(v))
      : [...TELEMETRY_COLUMNS];

    if (requestedCols.length === 0) {
      res.status(400).json({ error: 'No valid telemetry variables requested' });
      return;
    }

    let query: string;
    const params: unknown[] = [internalDeviceId, from, to];

    if (aggregation === 'raw') {
      const cols = requestedCols.map((c) => `tn.${c}`).join(', ');
      query = `
        SELECT tn.ts AS timestamp, ${cols}
          FROM telemetry_norm tn
         WHERE tn.device_id = $1
           AND tn.ts >= $2
           AND tn.ts <= $3
         ORDER BY tn.ts ASC`;
    } else {
      const trunc = aggregation === 'daily' ? 'day' : 'hour';
      const cols = requestedCols.map((c) => `AVG(tn.${c}) AS ${c}`).join(', ');
      query = `
        SELECT DATE_TRUNC('${trunc}', tn.ts) AS timestamp, ${cols}
          FROM telemetry_norm tn
         WHERE tn.device_id = $1
           AND tn.ts >= $2
           AND tn.ts <= $3
         GROUP BY DATE_TRUNC('${trunc}', tn.ts)
         ORDER BY timestamp ASC`;
    }

    const { rows } = await pool.query(query, params);
    res.json({ device_id, aggregation, rows });
  } catch (err) {
    console.error('Error fetching telemetry:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /dashboard/devices/:id/annotations ──────────────────────────────────
router.get('/devices/:id/annotations', requireAuth, requireOrg, (_req: Request, res: Response): void => {
  try {
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /dashboard/devices/:id/annotations ─────────────────────────────────
router.post('/devices/:id/annotations', requireAuth, requireOrg, (_req: Request, res: Response): void => {
  try {
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
