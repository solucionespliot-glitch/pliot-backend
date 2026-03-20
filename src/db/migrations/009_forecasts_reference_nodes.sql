-- Migration: 009_forecasts_reference_nodes
-- Description: Safety migration — etp_forecasts and irrigation_turn_reference_nodes
-- were already created in 007_agronomic_engine.sql. This migration adds additional
-- indexes for dashboard query performance.

-- Additional indexes for etp_forecasts
CREATE INDEX IF NOT EXISTS idx_etp_forecasts_site_date
  ON etp_forecasts (site_id, forecast_date DESC);

-- Additional indexes for irrigation_turn_reference_nodes
CREATE INDEX IF NOT EXISTS idx_irrigation_turn_ref_nodes_turn_sensor
  ON irrigation_turn_reference_nodes (irrigation_turn_id, sensor_device_id);

CREATE INDEX IF NOT EXISTS idx_irrigation_turn_ref_nodes_valid
  ON irrigation_turn_reference_nodes (irrigation_turn_id, valid_from, valid_to);
