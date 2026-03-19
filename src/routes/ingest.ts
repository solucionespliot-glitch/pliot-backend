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

// Short key → normalized column mapping
const FIELD_MAP: Record<string, string> = {
  b:    'battery_voltage',
  t:    'temperature',
  h:    'humidity',
  d:    'vpd',
  dp:   'dew_point',
  l:    'light',
  pR:   'report_period',
  co2r: 'co2',
};

const NORM_COLUMNS = new Set(Object.values(FIELD_MAP));

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
      extras[key] = value;
    }
  }

  if (Object.keys(extras).length > 0) {
    normFields['extras'] = extras;
  }

  // 5. Build and execute dynamic INSERT into telemetry_norm
  const normCols: string[]    = ['device_id', 'ts'];
  const normParams: unknown[] = [device.id];

  for (const [col, val] of Object.entries(normFields)) {
    normCols.push(col);
    normParams.push(col === 'extras' ? JSON.stringify(val) : val);
  }

  const normColStr = normCols.join(', ');
  const normValStr = normCols.map((c, i) => (c === 'ts' ? 'NOW()' : `$${i}`)).join(', ');

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
