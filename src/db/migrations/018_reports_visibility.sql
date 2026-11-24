-- Migration 018: report_configs visibility (owner + sharing)
-- created_by: auth0_sub of the user who created the config
-- is_shared:  when true, all org members can view and run this config

ALTER TABLE report_configs
  ADD COLUMN created_by TEXT    NOT NULL DEFAULT '',
  ADD COLUMN is_shared  BOOLEAN NOT NULL DEFAULT FALSE;
