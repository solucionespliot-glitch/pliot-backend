-- Migration 010: Fogger presets
-- Global and per-zone fogger configuration presets

CREATE TABLE IF NOT EXISTS fogger_presets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = global preset
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    duration_sec    INTEGER NOT NULL CHECK (duration_sec > 0),
    interval_sec    INTEGER NOT NULL CHECK (interval_sec > 0),
    start_time      TIME,           -- optional daily start window
    end_time        TIME,           -- optional daily end window
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fogger_presets_org ON fogger_presets(organization_id);

COMMENT ON TABLE fogger_presets IS 'Reusable fogger configurations. organization_id NULL means global/shared preset.';
