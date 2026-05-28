import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { createCipheriv } from 'crypto';
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

// ─── LoRaWAN ABP decryption ───────────────────────────────────────────────────
// Handles raw LoRaWAN frames forwarded by the GL controller firmware.
// The network_server.js path (old VPS) already decrypts before forwarding,
// so this is only needed for the direct controller → backend path.

// AES-128-ECB: encrypt a single 16-byte block with the given key.
function aes128Ecb(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]) as Buffer;
}

// AES-CMAC: used to verify the LoRaWAN MIC (Message Integrity Code).
// Implements RFC 4493.
function aesCmac(key: Buffer, message: Buffer): Buffer {
  // Generate subkeys K1, K2 from AES(key, 0^16)
  const L = aes128Ecb(key, Buffer.alloc(16));

  function shiftLeft(buf: Buffer): Buffer {
    const out = Buffer.alloc(16);
    for (let i = 0; i < 15; i++) out[i] = ((buf[i] << 1) | (buf[i + 1] >> 7)) & 0xff;
    out[15] = (buf[15] << 1) & 0xff;
    return out;
  }

  const k1 = shiftLeft(L);
  if (L[0] & 0x80) k1[15] ^= 0x87;
  const k2 = shiftLeft(k1);
  if (k1[0] & 0x80) k2[15] ^= 0x87;

  const n = Math.max(1, Math.ceil(message.length / 16));
  const lastComplete = message.length > 0 && message.length % 16 === 0;

  let x: Buffer = Buffer.alloc(16);

  for (let i = 0; i < n - 1; i++) {
    const block = message.slice(i * 16, (i + 1) * 16);
    const y = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) y[j] = x[j] ^ block[j];
    x = aes128Ecb(key, y);
  }

  // Last block: pad if incomplete, then XOR with K1 or K2
  const last = Buffer.alloc(16);
  const lastData = message.slice((n - 1) * 16);
  lastData.copy(last);
  if (!lastComplete) {
    last[lastData.length] = 0x80; // ISO/IEC 9797-1 padding
    for (let j = 0; j < 16; j++) last[j] ^= k2[j];
  } else {
    for (let j = 0; j < 16; j++) last[j] ^= k1[j];
  }

  const y = Buffer.alloc(16);
  for (let j = 0; j < 16; j++) y[j] = x[j] ^ last[j];
  return aes128Ecb(key, y);
}

// Decrypt LoRaWAN FRMPayload using AppSKey (AES-128 CTR-like, LoRaWAN spec 1.0).
// devAddrBuf: 4 bytes little-endian as they appear in the frame.
// fCnt: 16-bit uplink frame counter.
function decryptFrmPayload(appSKey: Buffer, devAddrBuf: Buffer, fCnt: number, payload: Buffer): Buffer {
  const result = Buffer.alloc(payload.length);
  const numBlocks = Math.ceil(payload.length / 16);

  for (let i = 1; i <= numBlocks; i++) {
    // Build A block: 01 00 00 00 00 [Dir=00] [DevAddr LE 4B] [FCnt LE 2B] 00 00 00 [i]
    const a = Buffer.alloc(16);
    a[0] = 0x01;
    // a[1..4] = 0x00 (already zero)
    // a[5] = 0x00 (Dir = uplink)
    devAddrBuf.copy(a, 6);      // bytes 6-9: DevAddr little-endian
    a[10] = fCnt & 0xff;        // FCnt LSB
    a[11] = (fCnt >> 8) & 0xff; // FCnt MSB
    // a[12..14] = 0x00 (FCnt upper bytes, always 0 for 16-bit counter)
    a[15] = i;                  // block counter (1-indexed)

    const s = aes128Ecb(appSKey, a);
    const start = (i - 1) * 16;
    const end = Math.min(start + 16, payload.length);
    for (let j = start; j < end; j++) result[j] = payload[j] ^ s[j - start];
  }

  return result;
}

// Decode a raw LoRaWAN ABP uplink frame (base64-encoded).
// Returns the decrypted sensor data object, or null if MIC fails or parse fails.
function decodeAbpFrame(
  frameB64: string,
  appSKeyHex: string,
  nwkSKeyHex: string,
): Record<string, unknown> | null {
  let frame: Buffer;
  try {
    frame = Buffer.from(frameB64, 'base64');
  } catch {
    return null;
  }

  // Minimum frame: MHDR(1) + DevAddr(4) + FCtrl(1) + FCnt(2) + FPort(1) + payload(1) + MIC(4) = 14 bytes
  if (frame.length < 14) return null;

  // Only handle Unconfirmed Data Up (0x40) and Confirmed Data Up (0x80)
  const mhdr = frame[0];
  if (mhdr !== 0x40 && mhdr !== 0x80) return null;

  const devAddrBuf = frame.slice(1, 5); // DevAddr, little-endian
  const fCtrl      = frame[5];
  const fOptsLen   = fCtrl & 0x0f;     // lower 4 bits = FOpts length
  const fCnt       = frame[6] | (frame[7] << 8);

  // FPort sits after FHDR (1+4+1+2 = 8 bytes) + FOpts
  const fPortOffset = 8 + fOptsLen;
  if (frame.length <= fPortOffset + 4) return null; // no room for FPort + payload + MIC

  const frmPayloadStart = fPortOffset + 1;
  const frmPayloadEnd   = frame.length - 4; // exclude 4-byte MIC
  if (frmPayloadEnd <= frmPayloadStart) return null;

  const frmPayload = frame.slice(frmPayloadStart, frmPayloadEnd);
  const rxMic      = frame.slice(frame.length - 4);

  // Verify MIC using NwkSKey.
  // B0 = 49 00 00 00 00 [Dir=00] [DevAddr LE 4B] [FCnt LE 2B] 00 00 00 [msgLen]
  const macPayload = frame.slice(1, frame.length - 4);
  const msgLen     = macPayload.length + 1; // +1 for MHDR byte
  const b0         = Buffer.alloc(16);
  b0[0] = 0x49;
  // b0[1..4] = 0x00 (zeros)
  // b0[5] = 0x00 (Dir = uplink)
  devAddrBuf.copy(b0, 6);
  b0[10] = fCnt & 0xff;
  b0[11] = (fCnt >> 8) & 0xff;
  // b0[12..14] = 0x00
  b0[15] = msgLen & 0xff;

  const nwkSKey = Buffer.from(nwkSKeyHex, 'hex');
  const micMsg  = Buffer.concat([b0, frame.slice(0, 1), macPayload]); // B0 || MHDR || MACPayload
  const cmac    = aesCmac(nwkSKey, micMsg);

  if (!cmac.slice(0, 4).equals(rxMic)) {
    // MIC mismatch — wrong keys or corrupted frame
    return null;
  }

  // Decrypt FRMPayload with AppSKey
  const appSKey   = Buffer.from(appSKeyHex, 'hex');
  const decrypted = decryptFrmPayload(appSKey, devAddrBuf, fCnt, frmPayload);

  try {
    return JSON.parse(decrypted.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
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

    // Some sensors send the string "null" when a reading is unavailable.
    // Skip those for normalized columns — inserting "null" into a numeric column fails.
    const isNullish = value === null || value === undefined || value === 'null';

    if (FIELD_MAP[key]) {
      if (!isNullish) normFields[FIELD_MAP[key]] = value;
    } else if (NORM_COLUMNS.has(key)) {
      if (!isNullish) normFields[key] = value;
    } else {
      extras[key] = value;
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

      // ── Device lookup ────────────────────────────────────────────────────────
      // Two paths depending on the source of the frame:
      //
      // Path A — GL controller (raw ABP frame):
      //   deviceName = DevAddr hex (e.g. '01FF0703'). The frame.data field contains
      //   the raw encrypted LoRaWAN frame. We look up the ABP keys and decrypt.
      //
      // Path B — network_server.js via VPS viejo mirror:
      //   deviceName = human-readable name (e.g. 'ASN-MVP-104'). The frame.data
      //   field contains the already-decoded sensor JSON in base64. Normal path.

      let device: { id: string; enabled: boolean } | undefined;
      let sensorData: Record<string, unknown> = {};

      // Try ABP path first: look up DevAddr in lora_abp_keys
      const { rows: abpRows } = await pool.query(
        `SELECT k.app_s_key, k.nwk_s_key, d.id, d.enabled
           FROM lora_abp_keys k
           JOIN devices d ON d.id = k.device_id
          WHERE k.dev_addr = $1`,
        [deviceId.toUpperCase()],
      );

      if (abpRows[0]) {
        // Path A: raw ABP frame — decrypt and extract sensor data
        const abpKey = abpRows[0];
        const decoded = decodeAbpFrame(frame.data ?? '', abpKey.app_s_key, abpKey.nwk_s_key);

        if (!decoded) {
          // MIC failed or malformed frame — log and skip, don't alert (could be noise)
          console.warn(`[LoRa ABP] MIC fail or parse error for DevAddr ${deviceId}`);
          continue;
        }

        device = { id: abpKey.id, enabled: abpKey.enabled };
        sensorData = decoded;

      } else {
        // Path B: normal device lookup by deviceName
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

        device = deviceRows[0];

        // Parse sensor values: prefer objectJSON.DecodeDataString, fallback to base64 data field
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
      }

      if (!device || !device.enabled) continue;

      // Extract measurement timestamp from rxInfo[0].time, fallback to NOW()
      const rxTime    = frame.rxInfo?.[0]?.time as string | undefined;
      const measuredAt = rxTime && !isNaN(Date.parse(rxTime)) ? new Date(rxTime).toISOString() : null;

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
        // Some sensors send the string "null" when a reading is unavailable.
        // Skip those for normalized columns — inserting "null" into a numeric column fails.
        const isNullish = value === null || value === undefined || value === 'null';

        if (FIELD_MAP[key]) {
          if (!isNullish) normFields[FIELD_MAP[key]] = value;
        } else if (NORM_COLUMNS.has(key)) {
          if (!isNullish) normFields[key] = value;
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
