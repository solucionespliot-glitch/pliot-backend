-- Migration: 005_devices_controllers_actuators
-- Description: Controllers, actuators, influence nodes, and irrigation specs

-- Controllers
CREATE TABLE IF NOT EXISTS controllers (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id                   UUID        NOT NULL REFERENCES devices(id),
  mode                        TEXT        CHECK (mode IN ('auto','manual','mixed')),
  environment_type            TEXT,
  context                     JSONB,
  online                      BOOLEAN     DEFAULT FALSE,
  last_seen_at                TIMESTAMPTZ,
  config_version              INTEGER     DEFAULT 0,
  last_sync_at                TIMESTAMPTZ,
  sync_status                 TEXT        DEFAULT 'pending',
  offline_retention_days      INTEGER     DEFAULT 10,
  last_local_config_hash      TEXT,
  heartbeat_interval_seconds  INTEGER     DEFAULT 60,
  override_mode               TEXT        DEFAULT 'none' CHECK (override_mode IN ('none','temporary_24h','temporary_48h','permanent')),
  override_expires_at         TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_controllers_device_id ON controllers (device_id);

-- Actuators
CREATE TABLE IF NOT EXISTS actuators (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  controller_id    UUID        NOT NULL REFERENCES controllers(id),
  device_id        UUID        NOT NULL REFERENCES devices(id),
  actuator_type    TEXT        CHECK (actuator_type IN ('fogger','irrigation_valve','pump','fan','fertigation_valve')),
  behavior_type    TEXT        CHECK (behavior_type IN ('direct','pulse_cycle','timed_on','vpd_triggered','manual_only')),
  behavior_config  JSONB,
  relay_index      INTEGER,
  label            TEXT,
  default_safe_state BOOLEAN   DEFAULT FALSE,
  heartbeat_seconds INTEGER    DEFAULT 15,
  enabled          BOOLEAN     DEFAULT TRUE,
  status           TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actuators_controller_id ON actuators (controller_id);
CREATE INDEX IF NOT EXISTS idx_actuators_device_id     ON actuators (device_id);

-- Actuator Influence Nodes
CREATE TABLE IF NOT EXISTS actuator_influence_nodes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actuator_id      UUID        NOT NULL REFERENCES actuators(id),
  sensor_device_id UUID        NOT NULL REFERENCES devices(id),
  weight           NUMERIC,
  rule_type        TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (actuator_id, sensor_device_id)
);

CREATE INDEX IF NOT EXISTS idx_actuator_influence_nodes_actuator_id ON actuator_influence_nodes (actuator_id);

-- Irrigation System Specs
CREATE TABLE IF NOT EXISTS irrigation_system_specs (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actuator_id          UUID        NOT NULL REFERENCES actuators(id),
  flow_source          TEXT        CHECK (flow_source IN ('flowmeter','theoretical_drip','pump_nominal')),
  nominal_flow_l_min   NUMERIC,
  drip_tape_meters     NUMERIC,
  dripper_spacing_cm   NUMERIC,
  dripper_flow_l_h     NUMERIC,
  irrigated_area_m2    NUMERIC,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_system_specs_actuator_id ON irrigation_system_specs (actuator_id);
