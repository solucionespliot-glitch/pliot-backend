-- Seed: Pliot org — WiFi nodes + nodos LoRa faltantes en BabyPlant
-- ─────────────────────────────────────────────────────────────────
-- IDs de referencia:
--   Pliot org:       aa000000-0000-0000-0000-000000000001
--   Pliot site:      aa000000-0000-0000-0000-000000000002  (ex Finca Demo Norte → WiFiNodos)
--   BabyPlant org:   bb000000-0000-0000-0000-000000000001
--   BabyPlant site:  bb000000-0000-0000-0000-000000000002

-- ─── 1. Renombrar org y site de Pliot ────────────────────────────────────────

UPDATE organizations
SET name = 'Pliot', slug = 'pliot'
WHERE id = 'aa000000-0000-0000-0000-000000000001';

UPDATE sites
SET name = 'WiFiNodos'
WHERE id = 'aa000000-0000-0000-0000-000000000002';

-- ─── 2. Nodos WiFi (AWN-xxx) → org Pliot ─────────────────────────────────────

INSERT INTO devices (
    id, device_id, legacy_device_name, device_type,
    organization_id, site_id, zone_id,
    enabled, transport_type, battery_powered
)
SELECT
    gen_random_uuid(),
    n, n,
    'wifi_sensor',
    'aa000000-0000-0000-0000-000000000001',
    'aa000000-0000-0000-0000-000000000002',
    NULL,
    true, 'wifi', true
FROM unnest(ARRAY[
    'AWN-366','AWN-374','AWN-340','AWN-342','AWN-346',
    'AWN-375','AWN-400','AWN-408','AWN-412'
]) AS n
ON CONFLICT (device_id) DO NOTHING;

-- ─── 3. Nodos LoRa faltantes → BabyPlant ─────────────────────────────────────

INSERT INTO devices (
    id, device_id, legacy_device_name, device_type,
    organization_id, site_id, zone_id,
    enabled, transport_type, battery_powered
)
SELECT
    gen_random_uuid(),
    n, n,
    'lora_sensor',
    'bb000000-0000-0000-0000-000000000001',
    'bb000000-0000-0000-0000-000000000002',
    NULL,
    true, 'lora', true
FROM unnest(ARRAY[
    'ASN-MVP-101','ASN-MVP-103','SSN-MVP-105'
]) AS n
ON CONFLICT (device_id) DO NOTHING;
