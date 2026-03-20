-- Migration: 007_agronomic_engine
-- Description: Agronomic engine schema — Kc profiles, ETP forecasts, irrigation learning observations

-- Crop Kc Profiles (null organization_id = global Pliot profile)
CREATE TABLE IF NOT EXISTS crop_kc_profiles (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        REFERENCES organizations(id),
  name             TEXT        NOT NULL,
  crop             TEXT        NOT NULL,
  environment_type TEXT        CHECK (environment_type IN ('greenhouse','open_field','mixed')),
  substrate_type   TEXT        CHECK (substrate_type IN ('soil','rockwool','coco','perlite','hydro','other')),
  version          INTEGER     DEFAULT 1,
  is_active        BOOLEAN     DEFAULT TRUE,
  valid_from       TIMESTAMPTZ DEFAULT NOW(),
  checksum         TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crop_kc_profiles_organization_id ON crop_kc_profiles (organization_id);
CREATE INDEX IF NOT EXISTS idx_crop_kc_profiles_crop            ON crop_kc_profiles (crop);

-- Crop Kc Profile Stages
CREATE TABLE IF NOT EXISTS crop_kc_profile_stages (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_kc_profile_id  UUID    NOT NULL REFERENCES crop_kc_profiles(id),
  stage_name          TEXT    CHECK (stage_name IN ('inicial','vegetativo','floracion','fructificacion','maduracion')),
  day_from            INTEGER NOT NULL,
  day_to              INTEGER,
  kc_value            NUMERIC NOT NULL,
  kc_min              NUMERIC,
  kc_max              NUMERIC,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crop_kc_profile_stages_profile_id ON crop_kc_profile_stages (crop_kc_profile_id);

-- Crop Profile Adjustments
CREATE TABLE IF NOT EXISTS crop_profile_adjustments (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_kc_profile_id  UUID        REFERENCES crop_kc_profiles(id),
  irrigation_turn_id  UUID,
  stage_name          TEXT,
  kc_adjustment       NUMERIC     NOT NULL,
  adjustment_reason   TEXT        CHECK (adjustment_reason IN ('observacion','desvio_sistematico','recomendacion_asesora')),
  applied_by          TEXT,
  valid_from          TIMESTAMPTZ,
  valid_to            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crop_profile_adjustments_profile_id      ON crop_profile_adjustments (crop_kc_profile_id);
CREATE INDEX IF NOT EXISTS idx_crop_profile_adjustments_irrigation_turn ON crop_profile_adjustments (irrigation_turn_id);

-- Irrigation Learning Observations
CREATE TABLE IF NOT EXISTS irrigation_learning_observations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  irrigation_turn_id UUID        NOT NULL,
  observed_at        TIMESTAMPTZ DEFAULT NOW(),
  planned_etc_mm     NUMERIC,
  observed_etc_mm    NUMERIC,
  deviation_mm       NUMERIC,
  deviation_reason   TEXT        CHECK (deviation_reason IN ('sensor_fault','actuator_fault','manual_override','unknown')),
  context            JSONB,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_learning_obs_turn_id    ON irrigation_learning_observations (irrigation_turn_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_learning_obs_observed_at ON irrigation_learning_observations (observed_at);

-- ETP Forecasts
CREATE TABLE IF NOT EXISTS etp_forecasts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       UUID        NOT NULL REFERENCES sites(id),
  published_at  TIMESTAMPTZ DEFAULT NOW(),
  forecast_date DATE        NOT NULL,
  windows       JSONB       NOT NULL,
  revision      INTEGER     DEFAULT 1,
  source        TEXT        CHECK (source IN ('weather_api','satellite','manual')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_etp_forecasts_site_id       ON etp_forecasts (site_id);
CREATE INDEX IF NOT EXISTS idx_etp_forecasts_forecast_date ON etp_forecasts (forecast_date);

-- Irrigation Turn Reference Nodes
CREATE TABLE IF NOT EXISTS irrigation_turn_reference_nodes (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  irrigation_turn_id UUID        NOT NULL,
  sensor_device_id   UUID        NOT NULL REFERENCES devices(id),
  priority           INTEGER     DEFAULT 1,
  source_type        TEXT        CHECK (source_type IN ('reference_node','cloud_assigned_node')),
  assigned_by        TEXT        CHECK (assigned_by IN ('manual','cloud_auto')),
  valid_from         TIMESTAMPTZ,
  valid_to           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irrigation_turn_ref_nodes_turn_id   ON irrigation_turn_reference_nodes (irrigation_turn_id);
CREATE INDEX IF NOT EXISTS idx_irrigation_turn_ref_nodes_sensor_id ON irrigation_turn_reference_nodes (sensor_device_id);
