-- Migration: 019_nursery_tray_transitions
-- Description: Adds per-tray status transition audit log and batch homogeneity tracking.
--              Ported from moduloPlantinera's TrayEvent / Batch.homogeneous pattern.
-- Date: 2026-11-24

-- ── 1. Tray transition log ────────────────────────────────────────────────────
-- Records every status change on individual trays, whether triggered by a
-- batch-level transition (source = 'batch') or by an individual tray action
-- (source = 'individual').
--
-- from_status = NULL: initial transition when the tray is first created (sowing).
-- occurred_at: when the transition actually happened (may differ from created_at
--              if the operator backdates an event).
CREATE TABLE IF NOT EXISTS nursery_tray_transitions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tray_id     UUID        NOT NULL REFERENCES nursery_trays(id) ON DELETE CASCADE,
  batch_id    UUID        NOT NULL REFERENCES nursery_batches(id) ON DELETE CASCADE,
  from_status TEXT,       -- NULL for the first transition (tray creation → sowing)
  to_status   TEXT        NOT NULL,
  source      TEXT        NOT NULL DEFAULT 'batch'
                CHECK (source IN ('batch', 'individual')),
  node_id     UUID        REFERENCES devices(id),
  notes       TEXT,
  created_by  TEXT,       -- auth0_sub of the user who triggered the transition
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_tray_trans_tray     ON nursery_tray_transitions (tray_id);
CREATE INDEX IF NOT EXISTS idx_nursery_tray_trans_batch    ON nursery_tray_transitions (batch_id);
CREATE INDEX IF NOT EXISTS idx_nursery_tray_trans_occurred ON nursery_tray_transitions (tray_id, occurred_at);

-- ── 2. Batch homogeneity ──────────────────────────────────────────────────────
-- is_homogeneous = true:  all active trays share the batch's current status.
--                         Transitions can be applied at the batch level safely.
-- is_homogeneous = false: at least one tray diverged from the rest.
--                         Traceability must be done tray by tray.
--
-- Once broken, homogeneity is never automatically restored.
-- homogeneous_broken_reason:
--   individual_transition — an operator transitioned a single tray independently,
--                           or a batch transition was applied without propagating to trays.
--   partial_elimination   — some trays were eliminated while others remain active,
--                           causing the batch status to diverge from some trays.
ALTER TABLE nursery_batches
  ADD COLUMN IF NOT EXISTS is_homogeneous            BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS homogeneous_broken_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS homogeneous_broken_reason TEXT
    CHECK (homogeneous_broken_reason IN ('individual_transition', 'partial_elimination'));

CREATE INDEX IF NOT EXISTS idx_nursery_batches_homogeneous
  ON nursery_batches (organization_id, is_homogeneous);
