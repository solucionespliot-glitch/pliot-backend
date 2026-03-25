-- Seed: BabyPlant — nueva organización, site y nodos ASN-MVP
-- ─────────────────────────────────────────────────────────────
-- IDs fijos para fácil referencia:
--   org:  bb000000-0000-0000-0000-000000000001
--   site: bb000000-0000-0000-0000-000000000002

-- ─── Organization ─────────────────────────────────────────────────────────────
INSERT INTO organizations (id, slug, name, plan_level, enabled)
VALUES (
    'bb000000-0000-0000-0000-000000000001',
    'babyplant',
    'BabyPlant',
    1,
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Site ─────────────────────────────────────────────────────────────────────
INSERT INTO sites (id, organization_id, name, timezone, enabled)
VALUES (
    'bb000000-0000-0000-0000-000000000002',
    'bb000000-0000-0000-0000-000000000001',
    'BabyPlant',
    'America/Argentina/Buenos_Aires',
    true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Devices ASN-MVP ──────────────────────────────────────────────────────────
-- device_id coincide exactamente con el campo device_id que manda el nodo en /api/v5
INSERT INTO devices (
    id,
    device_id,
    legacy_device_name,
    device_type,
    organization_id,
    site_id,
    zone_id,
    enabled,
    transport_type,
    battery_powered
)
SELECT
    gen_random_uuid(),
    'ASN-MVP-' || n,
    'ASN-MVP-' || n,
    'lora_sensor',
    'bb000000-0000-0000-0000-000000000001',
    'bb000000-0000-0000-0000-000000000002',
    NULL,
    true,
    'lora',
    true
FROM unnest(ARRAY['104','015','106','110','141','142','143','144','145']) AS n
ON CONFLICT (device_id) DO NOTHING;
