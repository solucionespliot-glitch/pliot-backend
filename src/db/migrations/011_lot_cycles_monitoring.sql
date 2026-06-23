-- Migration: 011_lot_cycles_monitoring
-- Description: Ciclos productivos, monitoreo fitosanitario y trazabilidad por lote
-- Fecha: 2026-06-23

-- ── 1. Temperaturas base por cultivo ─────────────────────────────────────────
-- Global para toda la plataforma (sin organization_id).
-- Fuente: McMaster & Wilhelm 1997, USDA, INTA.
CREATE TABLE IF NOT EXISTS crop_base_temps (
  crop_type  TEXT             PRIMARY KEY,
  base_temp  DOUBLE PRECISION NOT NULL,
  notes      TEXT
);

INSERT INTO crop_base_temps (crop_type, base_temp) VALUES
  ('Tomate',      10),
  ('Pimiento',    10),
  ('Berenjena',   10),
  ('Pepino',      10),
  ('Zapallo',     10),
  ('Chaucha',     10),
  ('Lechuga',      4),
  ('Espinaca',     4),
  ('Apio',         4),
  ('Perejil',      4),
  ('Acelga',       4),
  ('Zanahoria',    4),
  ('Remolacha',    4),
  ('Cebolla',      7),
  ('Papa',         7),
  ('Frutilla',     7),
  ('Ajo',          0),
  ('Girasol',      6),
  ('Soja',        10),
  ('Maíz dulce',  10)
ON CONFLICT (crop_type) DO NOTHING;

-- ── 2. Ciclos productivos ─────────────────────────────────────────────────────
-- Un lote puede tener múltiples ciclos a lo largo del tiempo.
-- El ciclo activo tiene ended_at = NULL.
-- base_temp se copia de crop_base_temps al crear para que el histórico sea inmutable
-- (si cambia la tabla global en el futuro, los ciclos viejos conservan su valor original).
-- name es obligatorio: el usuario elige de la lista de cultivos o escribe libremente.
CREATE TABLE IF NOT EXISTS lot_cycles (
  id                        UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id                    UUID             NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  name                      TEXT             NOT NULL,          -- ej: "Tomate primavera 2026"
  crop_type                 TEXT             NOT NULL,          -- cultivo principal del ciclo
  base_temp                 DOUBLE PRECISION,                   -- copiado de crop_base_temps al crear
  started_at                DATE             NOT NULL,          -- fecha de siembra o trasplante
  ended_at                  DATE,                               -- fecha de cosecha; NULL = ciclo activo
  monitoring_frequency_days INTEGER          NOT NULL DEFAULT 7,-- frecuencia esperada de monitoreo en días
  notes                     TEXT,
  created_by                TEXT,                               -- auth0_sub de quien abrió el ciclo
  created_at                TIMESTAMPTZ      DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lot_cycles_lot_id   ON lot_cycles (lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_cycles_ended_at ON lot_cycles (ended_at);

-- ── 3. Vincular lot_events al ciclo y agregar campos de aplicación ────────────
-- cycle_id: NULL para eventos sin ciclo asignado (retrocompatible).
-- product_name, dose, phi_days: solo aplican a event_type = 'application'.
-- phi_days (período de carencia): el sistema puede alertar si se registra
-- una cosecha antes de que hayan pasado phi_days desde la aplicación.
ALTER TABLE lot_events
  ADD COLUMN IF NOT EXISTS cycle_id     UUID    REFERENCES lot_cycles(id),
  ADD COLUMN IF NOT EXISTS product_name TEXT,
  ADD COLUMN IF NOT EXISTS dose         TEXT,
  ADD COLUMN IF NOT EXISTS phi_days     INTEGER;

CREATE INDEX IF NOT EXISTS idx_lot_events_cycle_id ON lot_events (cycle_id);

-- ── 4. Ítems de monitoreo por cultivo ─────────────────────────────────────────
-- Define qué se mide, cómo se mide y el umbral de acción para cada cultivo.
-- Global para toda la plataforma. El formulario de monitoreo se genera
-- dinámicamente a partir de esta tabla (una sección por category, ordenado por sort_order).
CREATE TABLE IF NOT EXISTS crop_monitoring_items (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_type        TEXT    NOT NULL,
  item_key         TEXT    NOT NULL,
  label            TEXT    NOT NULL,
  category         TEXT    NOT NULL CHECK (category IN ('pest', 'disease', 'metric')),
  scale_type       TEXT    NOT NULL CHECK (scale_type IN ('count', 'scale_0_5', 'percent', 'boolean')),
  threshold_value  DOUBLE PRECISION,  -- NULL si el umbral es contextual (ej: trips según ddt)
  threshold_notes  TEXT,              -- descripción del umbral en lenguaje natural
  sort_order       INTEGER DEFAULT 0,
  UNIQUE (crop_type, item_key)
);

CREATE INDEX IF NOT EXISTS idx_crop_monitoring_items_crop ON crop_monitoring_items (crop_type);

-- Seed: ítems de monitoreo para Tomate
INSERT INTO crop_monitoring_items
  (crop_type, item_key, label, category, scale_type, threshold_value, threshold_notes, sort_order)
VALUES
  -- Plagas
  ('Tomate', 'polilla_foliolos',  'Polilla (foliolos daño fresco)',  'pest',    'count',     2,    '> 2 foliolos con daño fresco',                  1),
  ('Tomate', 'mb_tria_adultos',   'MB Trialeurodes (adultos)',        'pest',    'count',     10,   '> 10 adultos por planta',                       2),
  ('Tomate', 'mb_tria_ninfas',    'MB Trialeurodes (ninfas)',         'pest',    'count',     8,    '> 8 ninfas por hoja',                           3),
  ('Tomate', 'mb_bem_adultos',    'MB Bemisia (adultos)',             'pest',    'count',     5,    '> 5 adultos por planta',                        4),
  ('Tomate', 'mb_bem_ninfas',     'MB Bemisia (ninfas)',              'pest',    'count',     4,    '> 4 ninfas por hoja',                           5),
  ('Tomate', 'trips_adultos',     'Trips (adultos/planta)',           'pest',    'count',     1,    '0-40 ddt: >1 / >40 ddt: >1 por planta',         6),
  ('Tomate', 'trips_ninfas_pct',  'Trips (% plantas con ninfa)',     'pest',    'percent',   50,   '0-40 ddt: cualquiera / >40 ddt: >50%',          7),
  ('Tomate', 'aranuela_pct',      'Arañuela roja (% plantas foco)',  'pest',    'percent',   50,   '> 50% plantas afectadas en foco',               8),
  ('Tomate', 'acaro_bronceado',   'Ácaro del bronceado',             'pest',    'boolean',   1,    'Cualquier síntoma = umbral superado',            9),
  -- Enfermedades
  ('Tomate', 'moho_gris',         'Moho gris (Botrytis)',            'disease', 'scale_0_5', 2,    'Escala flores: 0=sana … 5=75-100% flores',     10),
  ('Tomate', 'oidiopsis',         'Oidiopsis',                       'disease', 'scale_0_5', 2,    'Escala hojas: 0=sana … 5=100% hojas',          11),
  ('Tomate', 'moho_hoja',         'Moho de la hoja (Cladosporium)',  'disease', 'scale_0_5', 2,    'Escala hojas',                                 12),
  ('Tomate', 'tizon_temprano',    'Tizón temprano (Alternaria)',     'disease', 'scale_0_5', 2,    'Escala hojas',                                 13),
  ('Tomate', 'mancha_gris',       'Mancha gris (Stemphylium)',       'disease', 'scale_0_5', 2,    'Escala hojas',                                 14),
  ('Tomate', 'tizon_tardio',      'Tizón tardío (Phytophthora)',     'disease', 'scale_0_5', 2,    'Escala hojas',                                 15),
  ('Tomate', 'mancha_bacteriana', 'Mancha bacteriana (Xanthomonas)', 'disease', 'scale_0_5', 2,    'Escala hojas',                                 16),
  ('Tomate', 'peca_bacteriana',   'Peca bacteriana (Pseudomonas)',   'disease', 'scale_0_5', 2,    'Escala hojas',                                 17),
  -- Métrica de cultivo
  ('Tomate', 'pct_marcado',       '% Marcado (cuaje flores)',        'metric',  'percent',   NULL, 'Informativo, sin umbral de acción',             18)
ON CONFLICT (crop_type, item_key) DO NOTHING;

-- ── 5. Planillas de monitoreo semanal ─────────────────────────────────────────
-- Una planilla por visita, pertenece a un ciclo.
-- scores JSONB: { item_key: valor, ... } — estructura validada en backend según crop_type.
-- sampling_effort JSONB: campo reservado para registrar esfuerzo de muestreo
--   (ej: { "n_plants": 20, "n_leaves": 3, "zones": ["norte", "sur"] }).
--   Por ahora puede quedar NULL; se definirá su estructura cuando se implemente.
CREATE TABLE IF NOT EXISTS cycle_monitorings (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id             UUID        NOT NULL REFERENCES lot_cycles(id) ON DELETE CASCADE,
  monitored_at         DATE        NOT NULL,
  week_number          INTEGER,               -- semana dentro del ciclo (calculada al insertar)
  days_from_transplant INTEGER,              -- ddt al momento del monitoreo (para lógica de trips)
  scores               JSONB       NOT NULL,  -- { item_key: valor, ... }
  sampling_effort      JSONB,                -- reservado para esfuerzo de muestreo
  notes                TEXT,
  created_by           TEXT,                  -- auth0_sub
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cycle_monitorings_cycle_id     ON cycle_monitorings (cycle_id);
CREATE INDEX IF NOT EXISTS idx_cycle_monitorings_monitored_at ON cycle_monitorings (monitored_at);

-- ── 6. Focos georreferenciados ────────────────────────────────────────────────
-- Registra dónde se encontró un foco de plaga/enfermedad en un monitoreo.
-- location_text es texto libre por ahora.
-- A futuro: agregar lat/lon o referencia a polígono del lote.
CREATE TABLE IF NOT EXISTS monitoring_foci (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  monitoring_id UUID        NOT NULL REFERENCES cycle_monitorings(id) ON DELETE CASCADE,
  item_key      TEXT        NOT NULL,   -- qué plaga o enfermedad
  location_text TEXT,                   -- ej: "Zona norte, lomos 3 al 7"
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_foci_monitoring_id ON monitoring_foci (monitoring_id);
