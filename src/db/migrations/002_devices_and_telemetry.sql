-- Migration: 002_devices_and_telemetry
-- Description: Devices table and partitioned telemetry tables

-- Devices
CREATE TABLE IF NOT EXISTS devices (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id             TEXT        UNIQUE NOT NULL,
  legacy_device_name    TEXT,
  device_type           TEXT        CHECK (device_type IN ('wifi_sensor','lora_sensor','controller','fogger_controller','actuator','gateway','meteo_station')),
  application_name      TEXT,
  application_id        TEXT,
  dev_eui               TEXT,
  organization_id       UUID        NOT NULL REFERENCES organizations(id),
  site_id               UUID        REFERENCES sites(id),
  zone_id               UUID        REFERENCES zones(id),
  enabled               BOOLEAN     DEFAULT TRUE,
  firmware_version      TEXT,
  hardware_version      TEXT,
  transport_type        TEXT,
  schema_version        INTEGER,
  report_period_seconds INTEGER,
  battery_powered       BOOLEAN,
  last_seen_at          TIMESTAMPTZ,
  labels                JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_id
  ON devices (device_id);

CREATE INDEX IF NOT EXISTS idx_devices_org_site
  ON devices (organization_id, site_id);

CREATE INDEX IF NOT EXISTS idx_devices_legacy_device_name
  ON devices (legacy_device_name);

-- Telemetry Raw (partitioned by month on ts)
CREATE TABLE IF NOT EXISTS telemetry_raw (
  id             UUID        DEFAULT gen_random_uuid(),
  device_id      UUID        NOT NULL REFERENCES devices(id),
  ts             TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ DEFAULT NOW(),
  gateway_id     TEXT,
  rssi           NUMERIC,
  snr            NUMERIC,
  fcnt           INTEGER,
  fport          INTEGER,
  raw_envelope   JSONB,
  raw_decoded    JSONB,
  parse_status   TEXT        DEFAULT 'ok',
  schema_version INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY RANGE (ts);

-- Telemetry Norm (partitioned by month on ts)
CREATE TABLE IF NOT EXISTS telemetry_norm (
  id               UUID        DEFAULT gen_random_uuid(),
  device_id        UUID        NOT NULL REFERENCES devices(id),
  ts               TIMESTAMPTZ NOT NULL,
  battery_voltage  NUMERIC,
  temperature      NUMERIC,
  humidity         NUMERIC,
  vpd              NUMERIC,
  dew_point        NUMERIC,
  light            NUMERIC,
  co2              NUMERIC,
  report_period    INTEGER,
  flow_main        NUMERIC,
  ph               NUMERIC,
  ec               NUMERIC,
  tank_level       NUMERIC,
  scale_weight     NUMERIC,
  wind_speed       NUMERIC,
  wind_direction   NUMERIC,
  rain             NUMERIC,
  fertimeter       NUMERIC,
  extras           JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY RANGE (ts);

-- Monthly partitions for telemetry_raw
CREATE TABLE IF NOT EXISTS telemetry_raw_2026_03
  PARTITION OF telemetry_raw
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE IF NOT EXISTS telemetry_raw_2026_04
  PARTITION OF telemetry_raw
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE IF NOT EXISTS telemetry_raw_2026_05
  PARTITION OF telemetry_raw
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE IF NOT EXISTS telemetry_raw_2026_06
  PARTITION OF telemetry_raw
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS telemetry_raw_2026_07
  PARTITION OF telemetry_raw
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS telemetry_raw_2026_08
  PARTITION OF telemetry_raw
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Monthly partitions for telemetry_norm
CREATE TABLE IF NOT EXISTS telemetry_norm_2026_03
  PARTITION OF telemetry_norm
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE IF NOT EXISTS telemetry_norm_2026_04
  PARTITION OF telemetry_norm
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE IF NOT EXISTS telemetry_norm_2026_05
  PARTITION OF telemetry_norm
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE IF NOT EXISTS telemetry_norm_2026_06
  PARTITION OF telemetry_norm
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS telemetry_norm_2026_07
  PARTITION OF telemetry_norm
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS telemetry_norm_2026_08
  PARTITION OF telemetry_norm
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Indexes on telemetry_norm
CREATE INDEX IF NOT EXISTS idx_telemetry_norm_device_ts
  ON telemetry_norm (device_id, ts);

CREATE INDEX IF NOT EXISTS idx_telemetry_norm_ts
  ON telemetry_norm (ts);
