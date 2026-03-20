-- Migration: 008_irrigation_domain
-- Description: Irrigation domain — profiles, turns, plans, executions, observations

-- Irrigation Profiles
CREATE TABLE IF NOT EXISTS irrigation_profiles (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID        REFERENCES organizations(id),
  crop_kc_profile_id   UUID        REFERENCES crop_kc_profiles(id),
  name                 TEXT        NOT NULL,
  version              INTEGER     DEFAULT 1,
  is_active            BOOLEAN     DEFAULT TRUE,
  valid_from           TIMESTAMPTZ DEFAULT NOW(),
  checksum             TEXT,
  replenishment_tactic TEXT        CHECK (replenishment_tactic IN ('open_field_single','open_field_split','greenhouse_soil_pulsed','substrate_high_frequency','custom_technical')),
  tactic_config        JSONB,
  etp_threshold_mm     NUMERIC     DEFAULT 0.5,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_profiles_organization_id    ON irrigation_profiles (organization_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_profiles_crop_kc_profile_id ON irrigation_profiles (crop_kc_profile_id);

-- Irrigation Turns
CREATE TABLE IF NOT EXISTS irrigation_turns (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  controller_id             UUID        NOT NULL REFERENCES controllers(id),
  irrigation_profile_id     UUID        REFERENCES irrigation_profiles(id),
  name                      TEXT        NOT NULL,
  sowing_date               DATE,
  crop                      TEXT,
  enabled                   BOOLEAN     DEFAULT TRUE,
  producer_adjustment_percent NUMERIC   DEFAULT 0,
  status                    TEXT        DEFAULT 'active' CHECK (status IN ('active','paused','finished','error')),
  error_recovery_mode       TEXT        DEFAULT 'auto' CHECK (error_recovery_mode IN ('auto','manual_confirm')),
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_turns_controller_id         ON irrigation_turns (controller_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_turns_irrigation_profile_id ON irrigation_turns (irrigation_profile_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_turns_status                ON irrigation_turns (status);

-- Irrigation Turn Actuators
CREATE TABLE IF NOT EXISTS irrigation_turn_actuators (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  irrigation_turn_id UUID        NOT NULL REFERENCES irrigation_turns(id),
  actuator_id        UUID        NOT NULL REFERENCES actuators(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (irrigation_turn_id, actuator_id)
);

CREATE INDEX IF NOT EXISTS idx_irrigation_turn_actuators_turn_id    ON irrigation_turn_actuators (irrigation_turn_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_turn_actuators_actuator_id ON irrigation_turn_actuators (actuator_id);

-- Irrigation Plans
CREATE TABLE IF NOT EXISTS irrigation_plans (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  irrigation_turn_id       UUID        NOT NULL REFERENCES irrigation_turns(id),
  planned_start_at         TIMESTAMPTZ,
  planned_end_at           TIMESTAMPTZ,
  target_depth_mm          NUMERIC,
  target_volume_l          NUMERIC,
  target_duration_seconds  INTEGER,
  etc_accumulated_mm       NUMERIC,
  kc_stage                 TEXT,
  kc_value                 NUMERIC,
  etp_source               TEXT        CHECK (etp_source IN ('reference_node','cloud_assigned','forecast')),
  plan_source              TEXT        CHECK (plan_source IN ('controller_auto','manual','cloud_recommendation')),
  plan_context             JSONB,
  actuator_id              UUID        REFERENCES actuators(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_plans_turn_id      ON irrigation_plans (irrigation_turn_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_plans_actuator_id  ON irrigation_plans (actuator_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_plans_planned_start ON irrigation_plans (planned_start_at);

-- Irrigation Executions
CREATE TABLE IF NOT EXISTS irrigation_executions (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  irrigation_plan_id        UUID        REFERENCES irrigation_plans(id),
  irrigation_turn_id        UUID        REFERENCES irrigation_turns(id),
  controller_id             UUID        REFERENCES controllers(id),
  command_id                UUID        REFERENCES commands(id),
  requested_start_at        TIMESTAMPTZ,
  requested_end_at          TIMESTAMPTZ,
  commanded_duration_seconds INTEGER,
  commanded_volume_l        NUMERIC,
  execution_state           TEXT        DEFAULT 'PENDING' CHECK (execution_state IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  execution_notes           TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_executions_plan_id    ON irrigation_executions (irrigation_plan_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_executions_turn_id    ON irrigation_executions (irrigation_turn_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_executions_state      ON irrigation_executions (execution_state);
CREATE INDEX IF NOT EXISTS idx_irrigation_executions_command_id ON irrigation_executions (command_id);

-- Irrigation Observations
CREATE TABLE IF NOT EXISTS irrigation_observations (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  irrigation_execution_id UUID        NOT NULL REFERENCES irrigation_executions(id),
  observed_start_at       TIMESTAMPTZ,
  observed_end_at         TIMESTAMPTZ,
  observed_duration_seconds INTEGER,
  observed_volume_l       NUMERIC,
  observed_flow_l_min     NUMERIC,
  observed_pressure       NUMERIC,
  verification_source     TEXT        CHECK (verification_source IN ('flow_sensor','pressure_sensor','valve_feedback','inferred')),
  confidence              NUMERIC     CHECK (confidence BETWEEN 0 AND 1),
  status                  TEXT        CHECK (status IN ('CONFIRMED','PARTIAL','FAILED','UNVERIFIED')),
  raw_data                JSONB,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_observations_execution_id ON irrigation_observations (irrigation_execution_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_observations_status       ON irrigation_observations (status);
