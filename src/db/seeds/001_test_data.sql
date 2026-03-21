-- Seed: 001_test_data
-- Description: Demo organization, devices, telemetry, and irrigation setup for development and QA
--
-- API key for CTRL-001:
--   X-API-Key header: demo-ctrl001:pliot-demo-secret-2026
--   Scopes: ingest, sync, command

DO $$
DECLARE
  v_org_id        UUID;
  v_site_id       UUID;
  v_zone_gh_id    UUID;
  v_zone_campo_id UUID;
  v_dev_awn001_id UUID;
  v_dev_awn002_id UUID;
  v_dev_ctrl001_id UUID;
  v_controller_id UUID;
  v_actuator_id   UUID;
  v_kc_profile_id UUID;
  v_irr_profile_id UUID;
  v_turn_id       UUID;
BEGIN

  -- ── 1. Organization ─────────────────────────────────────────────────────────
  INSERT INTO organizations (slug, name, plan_level)
  VALUES ('pliot-demo', 'Pliot Demo', 4)
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_org_id;

  -- ── 2. Site ──────────────────────────────────────────────────────────────────
  INSERT INTO sites (organization_id, name, latitude, longitude, timezone)
  VALUES (v_org_id, 'Campo Demo', -34.6037, -58.3816, 'America/Argentina/Buenos_Aires')
  RETURNING id INTO v_site_id;

  -- ── 3. Zones ─────────────────────────────────────────────────────────────────
  INSERT INTO zones (site_id, name, zone_type)
  VALUES (v_site_id, 'Invernadero 1', 'greenhouse')
  RETURNING id INTO v_zone_gh_id;

  INSERT INTO zones (site_id, name, zone_type)
  VALUES (v_site_id, 'Campo Norte', 'open_field')
  RETURNING id INTO v_zone_campo_id;

  -- ── 4. Devices ───────────────────────────────────────────────────────────────
  INSERT INTO devices (device_id, name, device_type, organization_id, site_id, zone_id, enabled)
  VALUES ('AWN-001', 'Sensor Invernadero 1', 'wifi_sensor', v_org_id, v_site_id, v_zone_gh_id, TRUE)
  RETURNING id INTO v_dev_awn001_id;

  INSERT INTO devices (device_id, name, device_type, organization_id, site_id, zone_id, enabled)
  VALUES ('AWN-002', 'Sensor Campo Norte', 'wifi_sensor', v_org_id, v_site_id, v_zone_campo_id, TRUE)
  RETURNING id INTO v_dev_awn002_id;

  INSERT INTO devices (device_id, name, device_type, organization_id, site_id, zone_id, enabled)
  VALUES ('CTRL-001', 'Controlador Invernadero 1', 'controller', v_org_id, v_site_id, v_zone_gh_id, TRUE)
  RETURNING id INTO v_dev_ctrl001_id;

  -- ── 5. Controller ─────────────────────────────────────────────────────────────
  INSERT INTO controllers (device_id, mode, environment_type, online, heartbeat_interval_seconds, sync_status)
  VALUES (v_dev_ctrl001_id, 'auto', 'greenhouse', FALSE, 60, 'pending')
  RETURNING id INTO v_controller_id;

  -- ── 6. Actuator: irrigation_valve ────────────────────────────────────────────
  INSERT INTO actuators (controller_id, device_id, actuator_type, behavior_type, relay_index, label, enabled)
  VALUES (
    v_controller_id,
    v_dev_ctrl001_id,
    'irrigation_valve',
    'timed_on',
    0,
    'Válvula principal goteo',
    TRUE
  )
  RETURNING id INTO v_actuator_id;

  -- ── 7. Crop Kc Profile ────────────────────────────────────────────────────────
  INSERT INTO crop_kc_profiles (organization_id, name, crop, environment_type, substrate_type, is_active)
  VALUES (v_org_id, 'Tomate cherry invernadero sustrato', 'tomate_cherry', 'greenhouse', 'rockwool', TRUE)
  RETURNING id INTO v_kc_profile_id;

  -- 5 phenological stages
  INSERT INTO crop_kc_profile_stages (crop_kc_profile_id, stage_name, day_from, day_to, kc_value)
  VALUES
    (v_kc_profile_id, 'inicial',        0,  14, 0.60),
    (v_kc_profile_id, 'vegetativo',    15,  35, 0.85),
    (v_kc_profile_id, 'floracion',     36,  65, 1.10),
    (v_kc_profile_id, 'fructificacion',66,  90, 1.20),
    (v_kc_profile_id, 'maduracion',    91, NULL, 0.90);

  -- ── 8. Irrigation Profile ─────────────────────────────────────────────────────
  INSERT INTO irrigation_profiles (
    organization_id, crop_kc_profile_id, name,
    replenishment_tactic, etp_threshold_mm, is_active,
    tactic_config
  )
  VALUES (
    v_org_id,
    v_kc_profile_id,
    'Perfil sustrato intensivo - Tomate cherry',
    'substrate_high_frequency',
    0.5,
    TRUE,
    '{"pulses_per_day": 6, "min_pulse_volume_l": 0.2, "drain_target_percent": 20}'::jsonb
  )
  RETURNING id INTO v_irr_profile_id;

  -- ── 9. Irrigation Turn ────────────────────────────────────────────────────────
  -- sowing_date = current_date - 45 → día 45 → etapa floracion (36–65)
  INSERT INTO irrigation_turns (
    controller_id, irrigation_profile_id,
    name, sowing_date, crop,
    status, producer_adjustment_percent
  )
  VALUES (
    v_controller_id,
    v_irr_profile_id,
    'Sector 1 - Tomate cherry',
    CURRENT_DATE - 45,
    'tomate_cherry',
    'active',
    0
  )
  RETURNING id INTO v_turn_id;

  -- Link actuator to the turn
  INSERT INTO irrigation_turn_actuators (irrigation_turn_id, actuator_id)
  VALUES (v_turn_id, v_actuator_id);

  -- ── 10. Telemetry: 50 rows for AWN-001, last 24 h, every ~29 min ─────────────
  INSERT INTO telemetry_norm (device_id, ts, temperature, humidity, vpd, battery_voltage)
  SELECT
    v_dev_awn001_id,
    NOW() - ((49 - gs.i) * INTERVAL '29 minutes'),
    ROUND((22 + random() * 6)::numeric,    2),   -- 22–28 °C
    ROUND((60 + random() * 15)::numeric,   2),   -- 60–75 %
    ROUND((0.8 + random() * 0.6)::numeric, 3),   -- 0.800–1.400 kPa
    ROUND((3.7 + random() * 0.2)::numeric, 3)    -- 3.700–3.900 V
  FROM generate_series(0, 49) AS gs(i);

  -- ── 11. API Key for CTRL-001 ──────────────────────────────────────────────────
  -- key_id: demo-ctrl001
  -- raw_key: pliot-demo-secret-2026
  -- X-API-Key header: demo-ctrl001:pliot-demo-secret-2026
  INSERT INTO api_keys (key_id, key_hash, device_id, scopes, enabled)
  VALUES (
    'demo-ctrl001',
    crypt('pliot-demo-secret-2026', gen_salt('bf', 8)),
    v_dev_ctrl001_id,
    '["ingest","sync","command"]'::jsonb,
    TRUE
  );

END $$;
