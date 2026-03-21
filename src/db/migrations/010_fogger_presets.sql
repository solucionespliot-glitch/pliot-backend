-- Migration: 010_fogger_presets
-- Description: Fogger behavior presets (global Pliot presets + per-org custom presets)

CREATE TABLE IF NOT EXISTS fogger_presets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        REFERENCES organizations(id),
  name            TEXT        NOT NULL,
  behavior_config JSONB       NOT NULL,
  is_global       BOOLEAN     DEFAULT FALSE,
  is_active       BOOLEAN     DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fogger_presets_organization_id ON fogger_presets (organization_id);
CREATE INDEX IF NOT EXISTS idx_fogger_presets_is_global       ON fogger_presets (is_global) WHERE is_global = TRUE;
