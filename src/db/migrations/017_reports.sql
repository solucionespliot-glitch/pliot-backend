-- Migration 017: report_configs and report_runs
-- Report configs: templates that define what to calculate and how often.
-- Report runs: individual generated instances (manual or scheduled).

CREATE TABLE report_configs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Scope: a config can target an org-wide site, a specific lot, or a specific cycle.
  -- Having cycle_id implies lot_id; having lot_id implies site_id.
  site_id         UUID        REFERENCES sites(id),
  lot_id          UUID        REFERENCES lots(id),
  cycle_id        UUID        REFERENCES lot_cycles(id),
  name            TEXT        NOT NULL,
  -- NULL schedule = manual-only report
  schedule        TEXT        CHECK (schedule IN ('weekly', 'monthly')),
  -- weekly: 0=Sunday … 6=Saturday; monthly: 1–31 (day of month)
  schedule_day    INTEGER,
  -- Configurable calculation parameters (thresholds, flags)
  params          JSONB       NOT NULL DEFAULT '{}',
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE report_runs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id    UUID        NOT NULL REFERENCES report_configs(id) ON DELETE CASCADE,
  period_start DATE        NOT NULL,
  period_end   DATE        NOT NULL,
  -- pending: computing; done: result available; error: computation failed
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'done', 'error')),
  result       JSONB,      -- serialized ReportRunResult, populated when status = 'done'
  error_msg    TEXT,       -- populated when status = 'error'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fetching runs of a specific config (most recent first)
CREATE INDEX idx_report_runs_config_id ON report_runs (config_id, created_at DESC);
