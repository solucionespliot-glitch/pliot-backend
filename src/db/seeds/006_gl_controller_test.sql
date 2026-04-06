-- Seed: GL Controller test device — banco de pruebas para flashear la placa física
-- ─────────────────────────────────────────────────────────────────────────────
-- Org:      Pliot  (aa000000-0000-0000-0000-000000000001)
-- Site:     WiFiNodos (aa000000-0000-0000-0000-000000000002)
--
-- IDs fijos para fácil referencia:
--   device:     cc000000-0000-0000-0000-000000000001
--   controller: cc000000-0000-0000-0000-000000000002
--   actuator:   cc000000-0000-0000-0000-000000000003
--
-- API key para cargar en NVS del ESP32:
--   X-API-Key: gl-ctrl:gl-controller-cmd-2026
--
-- Valores a cargar en la WebUI del GL Controller (AP GL-Controller / pliot1234):
--   backend_url: http://<IP_VPS>:3001    (o https://... si hay nginx)
--   api_key:     gl-ctrl:gl-controller-cmd-2026
--   device_id:   GL-CTRL-TEST-001

-- ─── 1. API key con scope command + ingest ────────────────────────────────────
-- ingest: permite POST /api/v5/lora desde el mismo device (forwarding LoRa)
-- command: permite /api/v1.5/controllers/* (snapshot, heartbeat, vpd, commands)

INSERT INTO api_keys (id, key_id, key_hash, scopes, enabled)
VALUES (
    gen_random_uuid(),
    'gl-ctrl',
    '$2b$10$2uSC2n/0cgRHJNSZdP3/4OBTOH8X9m8jLyWefr9r9GFSwIfxtETWe',
    '["command", "ingest"]'::jsonb,
    true
)
ON CONFLICT (key_id) DO NOTHING;

-- ─── 2. Device del GL Controller ─────────────────────────────────────────────

INSERT INTO devices (
    id,
    device_id,
    legacy_device_name,
    device_type,
    organization_id,
    site_id,
    enabled,
    transport_type,
    battery_powered
)
VALUES (
    'cc000000-0000-0000-0000-000000000001',
    'GL-CTRL-TEST-001',
    'GL-CTRL-TEST-001',
    'controller',
    'aa000000-0000-0000-0000-000000000001',
    'aa000000-0000-0000-0000-000000000002',
    true,
    'wifi',
    false
)
ON CONFLICT (device_id) DO NOTHING;

-- ─── 3. Controller ────────────────────────────────────────────────────────────

INSERT INTO controllers (
    id,
    device_id,
    mode,
    environment_type,
    config_version,
    heartbeat_interval_seconds,
    override_mode
)
VALUES (
    'cc000000-0000-0000-0000-000000000002',
    'cc000000-0000-0000-0000-000000000001',
    'auto',
    'greenhouse',
    1,
    60,
    'none'
)
ON CONFLICT (id) DO NOTHING;

-- ─── 4. Actuador fogger ───────────────────────────────────────────────────────
-- relay_index 0 = Re3 (IO25) en el GL Controller
-- behavior_type vpd_triggered: el fogger enciende cuando VPD supera el umbral

INSERT INTO actuators (
    id,
    controller_id,
    device_id,
    actuator_type,
    behavior_type,
    behavior_config,
    relay_index,
    label,
    default_safe_state,
    enabled
)
VALUES (
    'cc000000-0000-0000-0000-000000000003',
    'cc000000-0000-0000-0000-000000000002',
    'cc000000-0000-0000-0000-000000000001',
    'fogger',
    'vpd_triggered',
    '{
        "vpd_threshold_kpa": 1.2,
        "cycle_on_seconds":  30,
        "cycle_off_seconds": 120,
        "min_temp_c":        15,
        "max_temp_c":        40
    }'::jsonb,
    0,
    'Fogger A',
    false,
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── 5. Influence node ────────────────────────────────────────────────────────
-- Usa AWN-300 como sensor de referencia para VPD (ya existe en seed 002)

INSERT INTO actuator_influence_nodes (actuator_id, sensor_device_id)
SELECT
    'cc000000-0000-0000-0000-000000000003',
    d.id
FROM devices d
WHERE d.device_id = 'AWN-300'
ON CONFLICT (actuator_id, sensor_device_id) DO NOTHING;
