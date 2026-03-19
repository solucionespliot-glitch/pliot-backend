-- Migration: 003_api_keys
-- Description: API keys and security alerts tables

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       TEXT        UNIQUE NOT NULL,
  key_hash     TEXT        NOT NULL,
  device_id    UUID        REFERENCES devices(id),
  scopes       JSONB       NOT NULL DEFAULT '[]',
  enabled      BOOLEAN     DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys (key_id);

-- Security Alerts
CREATE TABLE IF NOT EXISTS security_alerts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  attempted_device_id TEXT,
  endpoint            TEXT,
  ip_address          TEXT,
  alert_type          TEXT,
  resolved            BOOLEAN     DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_alerts_created_at ON security_alerts (created_at);
CREATE INDEX IF NOT EXISTS idx_security_alerts_alert_type ON security_alerts (alert_type);
