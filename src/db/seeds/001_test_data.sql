-- Seed: Test data aligned with actual schema
-- Hierarchy: org → site → zone → devices → controller → actuator → api_key → telemetry

-- ─── IDs used ────────────────────────────────────────────────────────────────
-- org:                 'aa000000-0000-0000-0000-000000000001'
-- site:                'aa000000-0000-0000-0000-000000000002'
-- zone:                'aa000000-0000-0000-0000-000000000003'
-- sensor device:       'aa000000-0000-0000-0000-000000000004'
-- controller device:   'aa000000-0000-0000-0000-000000000005'
-- actuator device:     'aa000000-0000-0000-0000-000000000006'
-- controller record:   'aa000000-0000-0000-0000-000000000007'
-- actuator record:     'aa000000-0000-0000-0000-000000000008'

-- ─── Organization ────────────────────────────────────────────────────────────
INSERT INTO organizations (id, slug, name, plan_level, enabled)
VALUES (
    'aa000000-0000-0000-0000-000000000001',
    'pliot-demo',
    'Pliot Demo Org',
    1,
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Site ────────────────────────────────────────────────────────────────────
INSERT INTO sites (id, organization_id, name, latitude, longitude, timezone, enabled)
VALUES (
    'aa000000-0000-0000-0000-000000000002',
    'aa000000-0000-0000-0000-000000000001',
    'Finca Demo Norte',
    -31.4167,
    -64.1833,
    'America/Argentina/Buenos_Aires',
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Zone ────────────────────────────────────────────────────────────────────
INSERT INTO zones (id, site_id, name, zone_type, enabled)
VALUES (
    'aa000000-0000-0000-0000-000000000003',
    'aa000000-0000-0000-0000-000000000002',
    'Cuartel A',
    'open_field',
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Devices ─────────────────────────────────────────────────────────────────
-- Sensor node
INSERT INTO devices (id, device_id, legacy_device_name, device_type, organization_id, site_id, zone_id, enabled, firmware_version, transport_type, battery_powered)
VALUES (
    'aa000000-0000-0000-0000-000000000004',
    'DEMO-SENSOR-001',
    'Nodo Sensor A-01',
    'wifi_sensor',
    'aa000000-0000-0000-0000-000000000001',
    'aa000000-0000-0000-0000-000000000002',
    'aa000000-0000-0000-0000-000000000003',
    true,
    'v1.5.0',
    'wifi',
    true
)
ON CONFLICT (id) DO NOTHING;

-- Controller device (the ESP32 controller itself is also a device)
INSERT INTO devices (id, device_id, legacy_device_name, device_type, organization_id, site_id, zone_id, enabled, firmware_version, transport_type, battery_powered)
VALUES (
    'aa000000-0000-0000-0000-000000000005',
    'DEMO-CTRL-001',
    'Controlador A-01',
    'controller',
    'aa000000-0000-0000-0000-000000000001',
    'aa000000-0000-0000-0000-000000000002',
    'aa000000-0000-0000-0000-000000000003',
    true,
    'v1.5.0',
    'wifi',
    false
)
ON CONFLICT (id) DO NOTHING;

-- Actuator device (the actuator node is also a device)
INSERT INTO devices (id, device_id, legacy_device_name, device_type, organization_id, site_id, zone_id, enabled, firmware_version, transport_type, battery_powered)
VALUES (
    'aa000000-0000-0000-0000-000000000006',
    'DEMO-ACT-001',
    'Actuador EV-01',
    'actuator',
    'aa000000-0000-0000-0000-000000000001',
    'aa000000-0000-0000-0000-000000000002',
    'aa000000-0000-0000-0000-000000000003',
    true,
    'v1.5.0',
    'wifi',
    false
)
ON CONFLICT (id) DO NOTHING;

-- ─── Controller ──────────────────────────────────────────────────────────────
INSERT INTO controllers (id, device_id, mode, environment_type, online, config_version, sync_status, override_mode)
VALUES (
    'aa000000-0000-0000-0000-000000000007',
    'aa000000-0000-0000-0000-000000000005',  -- FK → devices.id of DEMO-CTRL-001
    'auto',
    'open_field',
    false,
    1,
    'pending',
    'none'
)
ON CONFLICT (id) DO NOTHING;

-- ─── Actuator ────────────────────────────────────────────────────────────────
INSERT INTO actuators (id, controller_id, device_id, actuator_type, behavior_type, relay_index, label, enabled)
VALUES (
    'aa000000-0000-0000-0000-000000000008',
    'aa000000-0000-0000-0000-000000000007',  -- FK → controllers.id
    'aa000000-0000-0000-0000-000000000006',  -- FK → devices.id of DEMO-ACT-001
    'irrigation_valve',
    'direct',
    1,
    'Electroválvula 1',
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── API Key ─────────────────────────────────────────────────────────────────
-- key_id: 'test-key-demo-001'
-- raw key value (for testing): 'pliot-test-secret-2024'
-- key_hash = SHA256 hex of raw key
INSERT INTO api_keys (id, key_id, key_hash, device_id, scopes, enabled)
VALUES (
    'aa000000-0000-0000-0000-000000000009',
    'test-key-demo-001',
    encode(sha256('pliot-test-secret-2024'::bytea), 'hex'),
    'aa000000-0000-0000-0000-000000000004',  -- linked to sensor device
    '["ingest"]'::jsonb,
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Telemetry raw (50 rows, last 50 hours) ──────────────────────────────────
-- NOTE: ts must fall within an existing partition range
INSERT INTO telemetry_raw (device_id, ts, received_at, rssi, snr, raw_decoded, parse_status)
SELECT
    'aa000000-0000-0000-0000-000000000004',
    NOW() - (n || ' hours')::INTERVAL,
    NOW() - (n || ' hours')::INTERVAL,
    -(50 + (random() * 40)::int),
    round((5 + random() * 10)::numeric, 1),
    jsonb_build_object(
        'temp',  round((18 + random() * 12)::numeric, 1),
        'hum',   round((40 + random() * 40)::numeric, 1),
        'bat',   round((3.5 + random() * 0.7)::numeric, 2)
    ),
    'ok'
FROM generate_series(1, 50) AS n;

-- ─── Telemetry norm (50 rows, last 50 hours) ─────────────────────────────────
INSERT INTO telemetry_norm (device_id, ts, temperature, humidity, battery_voltage)
SELECT
    'aa000000-0000-0000-0000-000000000004',
    NOW() - (n || ' hours')::INTERVAL,
    round((18 + random() * 12)::numeric, 1),
    round((40 + random() * 40)::numeric, 1),
    round((3.5 + random() * 0.7)::numeric, 2)
FROM generate_series(1, 50) AS n;