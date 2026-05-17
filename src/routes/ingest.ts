import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db';

const router = Router();

// Require at least one device identifier in the payload
const IngestSchema = z
  .record(z.unknown())
  .refine((data) => typeof data['device_id'] === 'string' && data['device_id'].length > 0, {
    message: 'Payload must include a non-empty device_id',
  });

// Short key → normalized column mapping.
// Keys are the abbreviated field names sent by hardware nodes.
// Values are the corresponding column names in telemetry_norm.
const FIELD_MAP: Record<string, string> = {
  // Environmental sensors (all node types)
  b:    'battery_voltage',
  t:    'temperature',
  h:    'humidity',
  d:    'vpd',
  dp:   'dew_point',
  l:    'light',
  pR:   'report_period',
  co2r: 'co2',
  // Individual light sensors — nodes with fiber optic / LDR array (e.g. Nodo 400)
  l1:   'light_sensor_1',
  l2:   'light_sensor_2',
  l3:   'light_sensor_3',
  l4:   'light_sensor_4',
  l5:   'light_sensor_5',
  l6:   'light_sensor_6',
  l7:   'light_sensor_7',
  l8:   'light_sensor_8',
  lt:   'ppfd',             // Total PPFD (µmol/m²·s), sum of light array
  // Substrate / solution sensors (e.g. Nodos 409, 410)
  ht:   'soil_temperature', // Substrate or solution temperature (°C)
  hp:   'ph',               // pH of solution
  et:   'ec_temperature',   // EC probe temperature (°C)
  ee:   'ec',               // Electrical conductivity (mS/cm)
};

const NORM_COLUMNS = new Set(Object.values(FIELD_MAP));

// ─── Sensor capabilities ──────────────────────────────────────────────────────
// Records which normalized sensor columns a device has ever reported.
// Stored in devices.sensor_capabilities as { ppfd: true, ph: true, ... }.
// The frontend uses this to show/hide sensor widgets per device.
// Fire-and-forget: runs after the telemetry insert, never blocks the response.
function updateSensorCapabilities(deviceId: string, normFields: Record<string, unknown>): void {
  // Build capabilities object from the normalized columns present in this payload.
  // 'extras' is excluded — it's a catch-all bucket, not a real sensor column.
  const capabilities: Record<string, true> = {};
  for (const col of Object.keys(normFields)) {
    if (col !== 'extras') {
      capabilities[col] = true;
    }
  }

  if (Object.keys(capabilities).length === 0) return;

  const capJson = JSON.stringify(capabilities);

  // Only write if at least one capability is new — avoids unnecessary writes on every telemetry packet.
  pool.query(
    `UPDATE devices
        SET sensor_capabilities = sensor_capabilities || $1::jsonb
      WHERE id = $2
        AND NOT (sensor_capabilities @> $1::jsonb)`,
    [capJson, deviceId],
  ).catch((err) => console.error('Failed to update sensor_capabilities:', err));
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

async function requireApiKey(req: Request, res: Response, next: Function): Promise<void> {
  const header = req.headers['x-api-key'] as string | undefined;

  if (!header || !header.includes(':')) {
    res.status(401).json({ error: 'Missing or malformed X-API-Key header (expected key_id:raw_key)' });
    return;
  }

  const colonIdx = header.indexOf(':');
  const keyId    = header.slice(0, colonIdx);
  const rawKey   = header.slice(colonIdx + 1);

  const { rows } = await pool.query(
    `SELECT key_hash, scopes, enabled, expires_at
       FROM api_keys
      WHERE key_id = $1`,
    [keyId],
  );

  const apiKey = rows[0];

  if (
    !apiKey ||
    !apiKey.enabled ||
    (apiKey.expires_at && new Date(apiKey.expires_at) < new Date())
  ) {
    res.status(401).json({ error: 'Invalid or expired API key' });
    return;
  }

  const valid = await bcrypt.compare(rawKey, apiKey.key_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const scopes: string[] = Array.isArray(apiKey.scopes) ? apiKey.scopes : [];
  if (!scopes.includes('ingest')) {
    res.status(403).json({ error: 'API key does not have ingest scope' });
    return;
  }

  // Update last_used_at (fire-and-forget)
  pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_id = $1', [keyId]).catch(() => {});

  next();
}

// ─── POST /api/v5 ────────────────────────────────────────────────────────────

router.post('/', requireApiKey, async (req: Request, res: Response): Promise<void> => {
  try { 
    // 1. Validate payload
  const parsed = IngestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
    const body      = parsed.data as Record<string, unknown>;
    const deviceId  = body['device_id'] as string;
    const ipAddress = req.ip ?? req.socket.remoteAddress ?? 'unknown';
   
  // 2. Look up device
  const { rows: deviceRows } = await pool.query(
    `SELECT id, enabled FROM devices WHERE device_id = $1`,
    [deviceId],
  );

  if (!deviceRows[0]) {
    await pool.query(
      `INSERT INTO security_alerts (attempted_device_id, endpoint, ip_address, alert_type)
       VALUES ($1, $2, $3, 'unknown_device')`,
      [deviceId, '/api/v5', ipAddress],
    );
    res.status(403).json({ error: 'Device not authorized' });
    return;
  }

  const device = deviceRows[0];

  // 3. Insert raw telemetry
  await pool.query(
    `INSERT INTO telemetry_raw (device_id, ts, received_at, raw_decoded, parse_status)
     VALUES ($1, NOW(), NOW(), $2, 'ok')`,
    [device.id, JSON.stringify(body)],
  );

  // 4. Normalize payload
  const normFields: Record<string, unknown> = {};
  const extras: Record<string, unknown>     = {};

  for (const [key, value] of Object.entries(body)) {
    if (key === 'device_id') continue;

    if (FIELD_MAP[key]) {
      normFields[FIELD_MAP[key]] = value;
    } else if (NORM_COLUMNS.has(key)) {
      normFields[key] = value;
    } else {
      extras[key]
       = value;
    }
  }

  if (Object.keys(extras).length > 0) {
    normFields['extras'] = extras;
  }

  // 5. Record which sensor columns this device reported (fire-and-forget)
  updateSensorCapabilities(device.id, normFields);

  // 6. Build and execute dynamic INSERT into telemetry_norm
  const normCols: string[]    = ['device_id', 'ts'];
  const normParams: unknown[] = [device.id];

  for (const [col, val] of Object.entries(normFields)) {
    normCols.push(col);
    normParams.push(col === 'extras' ? JSON.stringify(val) : val);
  }

  const normColStr = normCols.join(', ');
  let paramIdx = 1;
  const normValStr = normCols.map((c) => {
    if (c === 'ts') return 'NOW()';
    return `$${paramIdx++}`;
    }).join(', ');

  await pool.query(
    `INSERT INTO telemetry_norm (${normColStr}) VALUES (${normValStr})`,
    normParams,
  );

  // 6. Update last_seen_at
  await pool.query(
    `UPDATE devices SET last_seen_at = NOW() WHERE id = $1`,
    [device.id],
  );

  res.json({ ok: true });
  } catch (err) {
    console.error('Ingest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/v5/lora ───────────────────────────────────────────────────────
// Accepts ChirpStack webhook format from pliot.ar nodes
// Extracts deviceName as device_id and parses objectJSON.DecodeDataString for telemetry

router.post('/lora', requireApiKey, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body;

    // Support single object or array
    const frames = Array.isArray(body) ? body : [body];

    for (const frame of frames) {
      const deviceId  = frame.deviceName as string | undefined;
      const ipAddress = req.ip ?? req.socket.remoteAddress ?? 'unknown';

      if (!deviceId) continue;

      // Look up device
      const { rows: deviceRows } = await pool.query(
        `SELECT id, enabled FROM devices WHERE device_id = $1`,
        [deviceId],
      );

      if (!deviceRows[0]) {
        await pool.query(
          `INSERT INTO security_alerts (attempted_device_id, endpoint, ip_address, alert_type)
           VALUES ($1, $2, $3, 'unknown_device')`,
          [deviceId, '/api/v5/lora', ipAddress],
        );
        continue; // skip unknown devices, process rest of batch
      }

      const device = deviceRows[0];

      // Extract measurement timestamp from rxInfo[0].time, fallback to NOW()
      const rxTime = frame.rxInfo?.[0]?.time;
      const measuredAt = rxTime && !isNaN(Date.parse(rxTime)) ? new Date(rxTime).toISOString() : null;

      // Parse sensor values: prefer objectJSON.DecodeDataString, fallback to base64 data field
      let sensorData: Record<string, unknown> = {};
      try {
        const decoded = JSON.parse(frame.objectJSON ?? '{}');
        if (decoded.DecodeDataString) {
          sensorData = JSON.parse(decoded.DecodeDataString);
        }
      } catch { /* ignore */ }

      if (Object.keys(sensorData).length === 0) {
        try {
          sensorData = JSON.parse(Buffer.from(frame.data ?? '', 'base64').toString('utf8'));
        } catch { /* ignore */ }
      }

      // Insert raw telemetry
      await pool.query(
        `INSERT INTO telemetry_raw (device_id, ts, received_at, raw_decoded, parse_status)
         VALUES ($1, COALESCE($2::timestamptz, NOW()), NOW(), $3, 'ok')`,
        [device.id, measuredAt, JSON.stringify(frame)],
      );

      // Normalize fields
      const normFields: Record<string, unknown> = {};
      const extras: Record<string, unknown>     = {};

      for (const [key, value] of Object.entries(sensorData)) {
        if (FIELD_MAP[key]) {
          normFields[FIELD_MAP[key]] = value;
        } else if (NORM_COLUMNS.has(key)) {
          normFields[key] = value;
        } else {
          extras[key] = value;
        }
      }

      if (Object.keys(extras).length > 0) {
        normFields['extras'] = extras;
      }

      // Record which sensor columns this device reported (fire-and-forget)
      updateSensorCapabilities(device.id, normFields);

      // Build INSERT into telemetry_norm
      const normCols: string[]    = ['device_id', 'ts'];
      const normParams: unknown[] = [device.id];

      for (const [col, val] of Object.entries(normFields)) {
        normCols.push(col);
        normParams.push(col === 'extras' ? JSON.stringify(val) : val);
      }

      const normColStr = normCols.join(', ');
      let paramIdx = 1;
      const normValStr = normCols.map((c) => {
        if (c === 'ts') return measuredAt ? `$${paramIdx++}::timestamptz` : 'NOW()';
        return `$${paramIdx++}`;
      }).join(', ');

      if (measuredAt) normParams.splice(1, 0, measuredAt);

      await pool.query(
        `INSERT INTO telemetry_norm (${normColStr}) VALUES (${normValStr})`,
        normParams,
      );

      // Update last_seen_at
      await pool.query(
        `UPDATE devices SET last_seen_at = NOW() WHERE id = $1`,
        [device.id],
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Lora ingest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v5/foggers ─────────────────────────────────────────────────────

router.get('/foggers', (_req: Request, res: Response) => {
  res.json({ sync_endpoint: '/api/v1.5/controllers/:id/snapshot' });
});

// ─── GET /api/v5/controllers ──────────────────────────────────────────────────

router.get('/controllers', (_req: Request, res: Response) => {
  res.json({ sync_endpoint: '/api/v1.5/controllers/:id/snapshot' });
});

export default router;
