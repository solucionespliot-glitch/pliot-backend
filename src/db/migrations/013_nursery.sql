-- Migration: 013_nursery
-- Description: Nursery (plantinera) management — tray tracking, orders, customers,
--              grafting sessions, plant counts, events, and ZPL QR printing support.
-- Date: 2026-07-15

-- ── 1. Seasons ────────────────────────────────────────────────────────────────
-- Groups orders by growing season for reporting and filtering.
CREATE TABLE IF NOT EXISTS nursery_seasons (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,  -- e.g. "Temporada Verano 2026/27"
  start_date      DATE,
  end_date        DATE,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_seasons_org ON nursery_seasons (organization_id);

-- ── 2. Customers ──────────────────────────────────────────────────────────────
-- Customers who place nursery orders. Can be individuals or companies.
-- tax_id_type + tax_id used for billing / ERP integration.
CREATE TABLE IF NOT EXISTS nursery_customers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  contact_name     TEXT,                    -- person to contact (for companies)
  email            TEXT,
  phone            TEXT,
  tax_id_type      TEXT        CHECK (tax_id_type IN ('cuit', 'cuil', 'dni', 'passport', 'other')),
  tax_id           TEXT,
  fiscal_condition TEXT,                    -- e.g. "Responsable Inscripto", "Monotributista"
  billing_address  TEXT,
  delivery_address TEXT,
  notes            TEXT,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  erp_customer_id  TEXT,                    -- reference in external ERP (NULL until connected)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_customers_org    ON nursery_customers (organization_id);
CREATE INDEX IF NOT EXISTS idx_nursery_customers_active ON nursery_customers (organization_id, active);

-- ── 3. Orders ─────────────────────────────────────────────────────────────────
-- A nursery order groups one or more batches (one per crop/variety) for a single
-- customer. The order lifecycle is independent of the production status of each batch.
-- A single order can have multiple partial deliveries to different recipients.
CREATE TABLE IF NOT EXISTS nursery_orders (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id                 UUID        NOT NULL REFERENCES sites(id),
  season_id               UUID        REFERENCES nursery_seasons(id),
  customer_id             UUID        REFERENCES nursery_customers(id),
  order_date              DATE        NOT NULL DEFAULT CURRENT_DATE,
  tentative_delivery_date DATE,
  status                  TEXT        NOT NULL DEFAULT 'confirmed'
                            CHECK (status IN ('quoted', 'confirmed', 'in_production',
                                              'partial_delivered', 'completed', 'cancelled')),
  internal_notes          TEXT,
  customer_notes          TEXT,        -- visible to customer in future portal
  -- ERP integration fields (populated when connected to billing system)
  erp_order_id            TEXT,
  erp_invoice_id          TEXT,
  erp_sync_status         TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (erp_sync_status IN ('pending', 'synced', 'error')),
  erp_synced_at           TIMESTAMPTZ,
  erp_sync_error          TEXT,
  created_by              TEXT,        -- auth0_sub
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_orders_org      ON nursery_orders (organization_id);
CREATE INDEX IF NOT EXISTS idx_nursery_orders_customer ON nursery_orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_nursery_orders_status   ON nursery_orders (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_nursery_orders_date     ON nursery_orders (organization_id, order_date);
CREATE INDEX IF NOT EXISTS idx_nursery_orders_delivery ON nursery_orders (organization_id, tentative_delivery_date);

-- ── 4. Order documents ────────────────────────────────────────────────────────
-- Attachments per order: quotes, signed delivery notes, contracts, photos, etc.
CREATE TABLE IF NOT EXISTS nursery_order_documents (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID        NOT NULL REFERENCES nursery_orders(id) ON DELETE CASCADE,
  document_type TEXT        NOT NULL
                  CHECK (document_type IN ('quote', 'contract', 'delivery_note',
                                           'invoice', 'photo', 'other')),
  file_url      TEXT        NOT NULL,
  description   TEXT,
  uploaded_by   TEXT,        -- auth0_sub
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_order_docs_order ON nursery_order_documents (order_id);

-- ── 5. Nursery locations catalog ──────────────────────────────────────────────
-- Admin-defined locations: greenhouse → bench → subbench.
-- Each location can reference a Pliot node for climate history queries.
-- Populated via SQL by admin — no CRUD frontend for now.
CREATE TABLE IF NOT EXISTS nursery_locations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id           UUID        NOT NULL REFERENCES sites(id),
  greenhouse        TEXT        NOT NULL,   -- e.g. "Invernadero 1"
  bench             TEXT        NOT NULL,   -- e.g. "Mesada A"
  subbench          TEXT,                   -- optional subdivision, e.g. "Sector 3"
  reference_node_id UUID        REFERENCES devices(id),  -- Pliot node for this location
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  display_order     INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_locations_org    ON nursery_locations (organization_id, site_id);
CREATE INDEX IF NOT EXISTS idx_nursery_locations_active ON nursery_locations (organization_id, active);

-- ── 6. Batches ────────────────────────────────────────────────────────────────
-- A batch is one crop/variety sowing run, linked to an order.
-- batch_type = 'standard': full lifecycle sowing → germination → nursery → delivered.
-- batch_type = 'grafted':  created by a grafting session, starts at grafting_chamber.
--
-- Planned vs real: planned_* is set when the order is placed (calculated from seeds/tray_size).
-- total_seeds_sown / total_trays_sown are updated as sowing actually happens.
-- If fewer trays are sown than planned (e.g. seed shortage), operators record eliminations.
--
-- reference_node_id: the current Pliot node associated with this batch.
-- Updated at each stage transition to allow reconstruction of full climate history.
--
-- partial_tray_seeds: seeds that go in the last (incomplete) tray.
-- If partial_tray_seeds > 0, the backend warns the user before generating QR labels
-- ("last tray will have X empty cells — continue?").
CREATE TABLE IF NOT EXISTS nursery_batches (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id                    UUID        NOT NULL REFERENCES sites(id),
  order_id                   UUID        REFERENCES nursery_orders(id),
  batch_type                 TEXT        NOT NULL DEFAULT 'standard'
                               CHECK (batch_type IN ('standard', 'grafted')),
  -- Set after a grafting session creates this batch (FK added after grafting_sessions table)
  parent_grafting_session_id UUID,
  -- Crop and seed info
  crop                       TEXT        NOT NULL,
  hybrid_variety             TEXT        NOT NULL,
  seed_lot_number            TEXT,        -- external lot number from the seed envelope
  seed_envelope_photo_url    TEXT,
  purchase_date              DATE,
  -- Sowing configuration
  tray_size                  INTEGER     NOT NULL CHECK (tray_size IN (72, 128, 162, 228)),
  substrate                  TEXT,
  -- Planned quantities (set when order is confirmed)
  total_seeds_planned        INTEGER,
  total_trays_planned        INTEGER,     -- ceil(total_seeds_planned / tray_size)
  partial_tray_seeds         INTEGER,     -- seeds in the last partial tray; 0 if exact
  -- Real quantities (updated during and after sowing)
  total_seeds_sown           INTEGER,
  total_trays_sown           INTEGER,
  -- Pricing at time of order (for ERP billing summary)
  unit_price                 NUMERIC(12, 4),
  currency                   TEXT        DEFAULT 'ARS',
  price_notes                TEXT,
  -- Status
  -- standard: ordered → sowing → germination → nursery → delivered
  -- grafted:  grafting_chamber → nursery → delivered
  -- consumed: this batch was used as input in a grafting session
  -- cancelled: production cancelled before completion
  status                     TEXT        NOT NULL DEFAULT 'ordered'
                               CHECK (status IN ('ordered', 'sowing', 'germination',
                                                 'grafting_chamber', 'nursery',
                                                 'delivered', 'cancelled', 'consumed')),
  -- Current Pliot node for climate history queries; updated at each stage transition
  reference_node_id          UUID        REFERENCES devices(id),
  -- Stage timestamps and nodes
  sowing_date                DATE,
  sowing_node_id             UUID        REFERENCES devices(id),
  germination_entry_at       TIMESTAMPTZ,
  germination_exit_at        TIMESTAMPTZ,
  germination_node_id        UUID        REFERENCES devices(id),
  nursery_placed_at          TIMESTAMPTZ,
  notes                      TEXT,
  created_by                 TEXT,        -- auth0_sub
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_batches_org    ON nursery_batches (organization_id);
CREATE INDEX IF NOT EXISTS idx_nursery_batches_order  ON nursery_batches (order_id);
CREATE INDEX IF NOT EXISTS idx_nursery_batches_status ON nursery_batches (organization_id, status);

-- ── 7. Trays ──────────────────────────────────────────────────────────────────
-- Individual trays generated when sowing is confirmed for a batch.
-- qr_code = tray UUID cast to text, encoded in the printed ZPL label.
-- plant_capacity = tray_size for all trays except the last partial one.
--
-- Elimination modes (all require producer approval):
--   1. QR scan:      operator scans tray → marks this row is_eliminated = true
--   2. Bulk count:   identity unknown → recorded in nursery_events as 'bulk_elimination'
--   3. Scan survivors: operator scans all surviving trays; backend marks the rest eliminated
--
-- elimination_approval_status:
--   pending  → operator submitted, waiting for producer
--   approved → producer confirmed, is_eliminated set to true
--   rejected → producer rejected, tray remains active
CREATE TABLE IF NOT EXISTS nursery_trays (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID        NOT NULL REFERENCES organizations(id),
  batch_id                    UUID        NOT NULL REFERENCES nursery_batches(id) ON DELETE CASCADE,
  tray_number                 INTEGER     NOT NULL,   -- sequential within batch (1..N)
  qr_code                     TEXT        NOT NULL UNIQUE,  -- = id::text, printed on ZPL label
  plant_capacity              INTEGER     NOT NULL,   -- actual cells (may be < tray_size for last tray)
  status                      TEXT        NOT NULL DEFAULT 'sowing'
                                CHECK (status IN ('sowing', 'germination', 'grafting_chamber',
                                                  'nursery', 'delivered', 'eliminated')),
  -- Current Pliot node assigned to this tray
  current_node_id             UUID        REFERENCES devices(id),
  -- Elimination (identity-known path; bulk eliminations go to nursery_events)
  is_eliminated               BOOLEAN     NOT NULL DEFAULT FALSE,
  elimination_reason          TEXT        CHECK (elimination_reason IN (
                                            'seed_shortage', 'broken', 'theft',
                                            'gifted', 'pest', 'disease', 'other')),
  elimination_notes           TEXT,
  eliminated_at               TIMESTAMPTZ,
  eliminated_by               TEXT,        -- auth0_sub of operator who requested
  elimination_approval_status TEXT        CHECK (elimination_approval_status IN
                                            ('pending', 'approved', 'rejected')),
  elimination_approved_by     TEXT,        -- auth0_sub of producer who approved
  elimination_approved_at     TIMESTAMPTZ,
  -- Stage transition timestamps and nodes (individual tray level)
  germination_entry_at        TIMESTAMPTZ,
  germination_exit_at         TIMESTAMPTZ,
  germination_node_id         UUID        REFERENCES devices(id),
  grafting_chamber_entry_at   TIMESTAMPTZ,
  grafting_chamber_exit_at    TIMESTAMPTZ,
  grafting_chamber_node_id    UUID        REFERENCES devices(id),
  nursery_placed_at           TIMESTAMPTZ,
  nursery_location_id         UUID        REFERENCES nursery_locations(id),
  delivered_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, tray_number)
);

CREATE INDEX IF NOT EXISTS idx_nursery_trays_batch     ON nursery_trays (batch_id);
CREATE INDEX IF NOT EXISTS idx_nursery_trays_qr        ON nursery_trays (qr_code);
CREATE INDEX IF NOT EXISTS idx_nursery_trays_status    ON nursery_trays (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_nursery_trays_location  ON nursery_trays (nursery_location_id);
CREATE INDEX IF NOT EXISTS idx_nursery_trays_elim      ON nursery_trays (batch_id, is_eliminated);
-- Partial index for the approval queue — only rows with pending eliminations
CREATE INDEX IF NOT EXISTS idx_nursery_trays_elim_pend ON nursery_trays (organization_id)
  WHERE elimination_approval_status = 'pending';

-- ── 8. Grafting sessions ──────────────────────────────────────────────────────
-- Links a rootstock batch (pie) and a scion batch (copa) for grafting.
-- Both parent batches must be at status = 'nursery' before grafting can start.
--
-- Flow:
--   1. Create session linking rootstock + scion batches
--   2. Record grafts_attempted and grafts_survived (prendimiento)
--   3. Confirm session → system creates result_batch (grafted) with new QR trays
--      User selects result_tray_size (typically plants go 1 per 2 cells)
--   4. Parent batches transition to status = 'consumed'
--   5. Result batch proceeds: grafting_chamber → nursery → delivered
--
-- Key metrics:
--   - Germination % of pie:  from nursery_plant_counts on rootstock_batch trays
--   - Germination % of copa: from nursery_plant_counts on scion_batch trays
--   - Prendimiento %:        survival_pct (generated column below)
CREATE TABLE IF NOT EXISTS nursery_grafting_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id             UUID        NOT NULL REFERENCES sites(id),
  order_id            UUID        REFERENCES nursery_orders(id),
  rootstock_batch_id  UUID        NOT NULL REFERENCES nursery_batches(id),  -- pie
  scion_batch_id      UUID        NOT NULL REFERENCES nursery_batches(id),  -- copa
  result_batch_id     UUID        REFERENCES nursery_batches(id),           -- set on confirmation
  grafting_date       DATE,
  grafting_node_id    UUID        REFERENCES devices(id),
  -- Prendimiento metrics
  grafts_attempted    INTEGER,
  grafts_survived     INTEGER,
  survival_pct        NUMERIC(5, 2) GENERATED ALWAYS AS (
                        CASE WHEN grafts_attempted > 0
                          THEN ROUND((grafts_survived::NUMERIC / grafts_attempted) * 100, 2)
                          ELSE NULL END
                      ) STORED,
  -- Post-graft recovery chamber
  chamber_entry_at    TIMESTAMPTZ,
  chamber_exit_at     TIMESTAMPTZ,
  chamber_node_id     UUID        REFERENCES devices(id),
  -- Tray config for the result batch (chosen by user at session confirmation)
  result_tray_size    INTEGER     CHECK (result_tray_size IN (72, 128, 162, 228)),
  status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'in_progress', 'chamber', 'completed', 'cancelled')),
  notes               TEXT,
  created_by          TEXT,        -- auth0_sub
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_grafting_org       ON nursery_grafting_sessions (organization_id);
CREATE INDEX IF NOT EXISTS idx_nursery_grafting_rootstock ON nursery_grafting_sessions (rootstock_batch_id);
CREATE INDEX IF NOT EXISTS idx_nursery_grafting_scion     ON nursery_grafting_sessions (scion_batch_id);
CREATE INDEX IF NOT EXISTS idx_nursery_grafting_result    ON nursery_grafting_sessions (result_batch_id);

-- Now that nursery_grafting_sessions exists, add the FK from nursery_batches
ALTER TABLE nursery_batches
  ADD CONSTRAINT fk_nursery_batches_grafting_session
  FOREIGN KEY (parent_grafting_session_id)
  REFERENCES nursery_grafting_sessions(id);

-- ── 9. Deliveries ─────────────────────────────────────────────────────────────
-- An order can have multiple partial deliveries, each to a potentially different recipient.
-- The customer (who ordered and will be billed) is on the order.
-- The recipient (who physically receives) may differ — stored per delivery.
CREATE TABLE IF NOT EXISTS nursery_deliveries (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID        NOT NULL REFERENCES nursery_orders(id) ON DELETE CASCADE,
  delivered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipient_name       TEXT        NOT NULL,
  recipient_contact    TEXT,
  recipient_id_doc     TEXT,        -- DNI or document for the delivery note (remito)
  delivery_note_number TEXT,        -- remito number
  notes                TEXT,
  created_by           TEXT,        -- auth0_sub
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_deliveries_order ON nursery_deliveries (order_id);
CREATE INDEX IF NOT EXISTS idx_nursery_deliveries_date  ON nursery_deliveries (delivered_at);

-- ── 10. Delivery line items ───────────────────────────────────────────────────
-- Which trays were included in each delivery and how many plants were delivered.
-- plants_delivered may be less than tray plant_capacity if the tray had losses.
CREATE TABLE IF NOT EXISTS nursery_delivery_trays (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id      UUID    NOT NULL REFERENCES nursery_deliveries(id) ON DELETE CASCADE,
  tray_id          UUID    NOT NULL REFERENCES nursery_trays(id),
  plants_delivered INTEGER NOT NULL CHECK (plants_delivered > 0),
  UNIQUE (delivery_id, tray_id)
);

CREATE INDEX IF NOT EXISTS idx_nursery_delivery_trays_delivery ON nursery_delivery_trays (delivery_id);
CREATE INDEX IF NOT EXISTS idx_nursery_delivery_trays_tray     ON nursery_delivery_trays (tray_id);

-- ── 11. Events ────────────────────────────────────────────────────────────────
-- Agricultural and lifecycle events per batch or individual tray.
-- Mirrors lot_events pattern: event_type, occurred_at, notes, data JSONB.
--
-- tray_id NULL → event applies to the whole batch.
-- source = 'manual' for now; 'sensor' / 'automatic' when inputs are connected.
--
-- For event_type = 'application': product_name, dose, phi_days are populated.
-- phi_days (período de carencia): future alert if delivery occurs before phi elapses.
--
-- 'bulk_elimination' is for trays lost without QR identity:
--   data = { "quantity": N, "reason": "seed_shortage|broken|..." }
--   The count is subtracted from the batch active total; no specific tray rows are marked.
CREATE TABLE IF NOT EXISTS nursery_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          UUID        NOT NULL REFERENCES nursery_batches(id) ON DELETE CASCADE,
  tray_id           UUID        REFERENCES nursery_trays(id),   -- NULL = whole batch
  event_type        TEXT        NOT NULL
                      CHECK (event_type IN (
                        'irrigation',        -- riego
                        'fertilization',     -- fertilización
                        'application',       -- aplicación de producto fitosanitario
                        'observation',       -- observación general
                        'photo',             -- registro fotográfico
                        'treatment',         -- tratamiento no fitosanitario
                        'note',              -- nota libre
                        'bulk_elimination'   -- trays eliminated without QR identity
                      )),
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Pliot node at the time of the event (for climate correlation)
  reference_node_id UUID        REFERENCES devices(id),
  notes             TEXT,
  photo_url         TEXT,
  data              JSONB,       -- flexible extra fields per event_type
  -- Application event fields (mirrors lot_events 011 pattern)
  product_name      TEXT,
  dose              TEXT,
  phi_days          INTEGER,     -- pre-harvest interval in days
  -- Source: manual entry today; sensor/automatic in the future
  source            TEXT        NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual', 'sensor', 'automatic')),
  created_by        TEXT,        -- auth0_sub
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_events_batch    ON nursery_events (batch_id);
CREATE INDEX IF NOT EXISTS idx_nursery_events_tray     ON nursery_events (tray_id);
CREATE INDEX IF NOT EXISTS idx_nursery_events_type     ON nursery_events (batch_id, event_type);
CREATE INDEX IF NOT EXISTS idx_nursery_events_occurred ON nursery_events (batch_id, occurred_at);

-- ── 12. Plant counts ──────────────────────────────────────────────────────────
-- Emergence counts taken per tray during the nursery stage.
-- Multiple counts per tray are allowed to track progress over time.
-- germination_pct is a generated column: emerged_plants / total_cells × 100.
-- photo_url is stored for future AI-based counting (count_method = 'ai').
CREATE TABLE IF NOT EXISTS nursery_plant_counts (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tray_id         UUID           NOT NULL REFERENCES nursery_trays(id) ON DELETE CASCADE,
  count_date      DATE           NOT NULL DEFAULT CURRENT_DATE,
  total_cells     INTEGER        NOT NULL,   -- snapshot of plant_capacity at count time
  emerged_plants  INTEGER        NOT NULL CHECK (emerged_plants >= 0),
  germination_pct NUMERIC(5, 2)  GENERATED ALWAYS AS (
                    CASE WHEN total_cells > 0
                      THEN ROUND((emerged_plants::NUMERIC / total_cells) * 100, 2)
                      ELSE 0 END
                  ) STORED,
  photo_url       TEXT,          -- photo alongside count; future AI input
  count_method    TEXT           NOT NULL DEFAULT 'manual'
                    CHECK (count_method IN ('manual', 'ai')),
  ai_confidence   NUMERIC(4, 3), -- populated when count_method = 'ai'
  notes           TEXT,
  created_by      TEXT,          -- auth0_sub
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nursery_plant_counts_tray ON nursery_plant_counts (tray_id);
CREATE INDEX IF NOT EXISTS idx_nursery_plant_counts_date ON nursery_plant_counts (tray_id, count_date);

-- ── 13. Feature flag ──────────────────────────────────────────────────────────
-- Enable the nursery module per organization (same pattern as migration 012).
-- The features column already exists on organizations from migration 012.
-- To enable for an org:
--   UPDATE organizations SET features = features || '{"nursery": true}' WHERE slug = 'xxx';
-- Superusers bypass all feature gates (checked in requireFeature middleware).
