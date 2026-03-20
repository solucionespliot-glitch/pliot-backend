-- Migration: 006_commands
-- Description: Commands table for device/controller/actuator command dispatch

CREATE TABLE IF NOT EXISTS commands (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cmd_id               TEXT        UNIQUE NOT NULL,
  target_device_id     UUID        REFERENCES devices(id),
  target_controller_id UUID        REFERENCES controllers(id),
  target_actuator_id   UUID        REFERENCES actuators(id),
  command_type         TEXT        CHECK (command_type IN ('setRelays','setConfig','requestSync','syncEtpForecast','test')),
  payload              JSONB,
  state                TEXT        DEFAULT 'PENDING' CHECK (state IN ('PENDING','SENT','APPLIED','FAILED','EXPIRED')),
  attempts             INTEGER     DEFAULT 0,
  issued_at            TIMESTAMPTZ DEFAULT NOW(),
  sent_at              TIMESTAMPTZ,
  applied_at           TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  last_error           TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commands_target_controller_id ON commands (target_controller_id);
CREATE INDEX IF NOT EXISTS idx_commands_target_device_id     ON commands (target_device_id);
CREATE INDEX IF NOT EXISTS idx_commands_state                ON commands (state);
CREATE INDEX IF NOT EXISTS idx_commands_cmd_id               ON commands (cmd_id);
