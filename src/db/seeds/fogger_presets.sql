-- Seed: fogger_presets
-- Description: Global Pliot fogger behavior presets (organization_id IS NULL)

INSERT INTO fogger_presets (organization_id, name, behavior_config, is_global, is_active, notes)
VALUES
  (
    NULL,
    'Invernadero alta humedad',
    '{
      "trigger": "vpd",
      "threshold_on": 1.2,
      "threshold_off": 0.8,
      "on_seconds": 30,
      "off_seconds": 60,
      "schedule": { "from": "10:00", "to": "16:00" },
      "min_interval_seconds": 120
    }'::jsonb,
    TRUE,
    TRUE,
    'Para invernaderos con alta demanda de humedad y VPD moderado'
  ),
  (
    NULL,
    'Galpón ventilado',
    '{
      "trigger": "vpd",
      "threshold_on": 1.5,
      "threshold_off": 1.0,
      "on_seconds": 20,
      "off_seconds": 90,
      "schedule": { "from": "09:00", "to": "17:00" },
      "min_interval_seconds": 180
    }'::jsonb,
    TRUE,
    TRUE,
    'Para galpones con buena ventilación y VPD alto'
  ),
  (
    NULL,
    'Sustrato intensivo',
    '{
      "trigger": "vpd",
      "threshold_on": 0.9,
      "threshold_off": 0.6,
      "on_seconds": 45,
      "off_seconds": 45,
      "schedule": { "from": "08:00", "to": "18:00" },
      "min_interval_seconds": 90
    }'::jsonb,
    TRUE,
    TRUE,
    'Para cultivos en sustrato con control intensivo de VPD'
  )
ON CONFLICT DO NOTHING;
