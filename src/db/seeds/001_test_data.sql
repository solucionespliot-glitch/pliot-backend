-- Seed: Test data for development and QA
-- Creates a full hierarchy: org → site → zones → devices → controller → actuator
-- Includes Kc profile, irrigation profile, turn, api_key, and 50 telemetry rows

-- ─── Organization ────────────────────────────────────────────────────────────
INSERT INTO organizations (id, name, slug, active)
VALUES ('00000000-0000-0000-0000-000000000001', 'Pliot Demo Org', 'pliot-demo', true)
ON CONFLICT (id) DO NOTHING;

-- ─── Site ────────────────────────────────────────────────────────────────────
INSERT INTO sites (id, organization_id, name, slug, timezone, latitude, longitude, active)
VALUES (
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    'Finca Demo Norte',
    'finca-demo-norte',
    'America/Argentina/Buenos_Aires',
    -31.4167,
    -64.1833,
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Zones ───────────────────────────────────────────────────────────────────
INSERT INTO zones (id, site_id, name, slug, area_ha, active)
VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010', 'Cuartel A', 'cuartel-a', 2.5, true),
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000010', 'Cuartel B', 'cuartel-b', 3.0, true)
ON CONFLICT (id) DO NOTHING;

-- ─── Devices ─────────────────────────────────────────────────────────────────
INSERT INTO devices (id, zone_id, name, slug, device_type, firmware_version, active)
VALUES
    ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000020', 'Nodo A-01', 'nodo-a-01', 'sensor', 'v1.5.0', true),
    ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000020', 'Nodo A-02', 'nodo-a-02', 'sensor', 'v1.5.0', true),
    ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000021', 'Nodo B-01', 'nodo-b-01', 'sensor', 'v1.5.0', true)
ON CONFLICT (id) DO NOTHING;

-- ─── Controller ──────────────────────────────────────────────────────────────
INSERT INTO controllers (id, zone_id, name, slug, model, firmware_version, active)
VALUES (
    '00000000-0000-0000-0000-000000000040',
    '00000000-0000-0000-0000-000000000020',
    'Controlador A-01',
    'ctrl-a-01',
    'ESP32-S3',
    'v1.5.0',
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Actuator ────────────────────────────────────────────────────────────────
INSERT INTO actuators (id, controller_id, name, slug, actuator_type, channel, active)
VALUES (
    '00000000-0000-0000-0000-000000000050',
    '00000000-0000-0000-0000-000000000040',
    'Electroválvula 1',
    'ev-1',
    'valve',
    1,
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── API Key ─────────────────────────────────────────────────────────────────
-- key_hash is SHA256 of 'test-api-key-pliot-demo-2024'
INSERT INTO api_keys (id, device_id, key_hash, label, active)
VALUES (
    '00000000-0000-0000-0000-000000000060',
    '00000000-0000-0000-0000-000000000030',
    encode(sha256('test-api-key-pliot-demo-2024'::bytea), 'hex'),
    'Dev test key node A-01',
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Kc Profile ──────────────────────────────────────────────────────────────
INSERT INTO crop_kc_profiles (id, organization_id, name, crop_type, active)
VALUES (
    '00000000-0000-0000-0000-000000000070',
    '00000000-0000-0000-0000-000000000001',
    'Vid Malbec estándar',
    'grapevine',
    true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO crop_kc_profile_stages (id, profile_id, stage_name, day_start, day_end, kc_value)
VALUES
    ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000070', 'Inicial',     1,   30,  0.30),
    ('00000000-0000-0000-0000-000000000072', '00000000-0000-0000-0000-000000000070', 'Desarrollo', 31,   90,  0.70),
    ('00000000-0000-0000-0000-000000000073', '00000000-0000-0000-0000-000000000070', 'Media',      91,  150,  1.05),
    ('00000000-0000-0000-0000-000000000074', '00000000-0000-0000-0000-000000000070', 'Final',     151,  180,  0.65)
ON CONFLICT (id) DO NOTHING;

-- ─── Irrigation Profile ──────────────────────────────────────────────────────
INSERT INTO irrigation_profiles (id, zone_id, kc_profile_id, name, active)
VALUES (
    '00000000-0000-0000-0000-000000000080',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000070',
    'Perfil riego cuartel A',
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Irrigation Turn ─────────────────────────────────────────────────────────
INSERT INTO irrigation_turns (id, profile_id, actuator_id, name, sequence_order, duration_min, active)
VALUES (
    '00000000-0000-0000-0000-000000000090',
    '00000000-0000-0000-0000-000000000080',
    '00000000-0000-0000-0000-000000000050',
    'Turno 1 - mañana',
    1,
    45,
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Telemetry (50 rows, last 50 hours from now) ─────────────────────────────
INSERT INTO telemetry_raw (device_id, received_at, payload)
SELECT
    '00000000-0000-0000-0000-000000000030',
    NOW() - (n || ' hours')::INTERVAL,
    jsonb_build_object(
        'temp',  round((18 + random() * 12)::numeric, 1),
        'hum',   round((40 + random() * 40)::numeric, 1),
        'vwc',   round((20 + random() * 30)::numeric, 1),
        'bat',   round((3.5 + random() * 0.7)::numeric, 2),
        'rssi',  -(50 + (random() * 40)::int)
    )
FROM generate_series(1, 50) AS n
ON CONFLICT DO NOTHING;

INSERT INTO telemetry_norm (device_id, measured_at, temperature_c, humidity_pct, soil_moisture_pct, battery_v, rssi_dbm)
SELECT
    '00000000-0000-0000-0000-000000000030',
    NOW() - (n || ' hours')::INTERVAL,
    round((18 + random() * 12)::numeric, 1),
    round((40 + random() * 40)::numeric, 1),
    round((20 + random() * 30)::numeric, 1),
    round((3.5 + random() * 0.7)::numeric, 2),
    -(50 + (random() * 40)::int)
FROM generate_series(1, 50) AS n
ON CONFLICT DO NOTHING;