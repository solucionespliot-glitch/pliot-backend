-- Seed: AWN-300 to AWN-420 real devices from pliot.ar
-- Organization: Pliot Demo Org (aa000000-0000-0000-0000-000000000001)
-- Site:         Finca Demo Norte (aa000000-0000-0000-0000-000000000002)
-- Zone:         NULL (to be assigned per device later)
-- device_id matches the deviceName field sent by the ChirpStack ingest (/api/v5/lora)

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
    'AWN-' || n,
    'AWN-' || n,
    'wifi_sensor',
    'aa000000-0000-0000-0000-000000000001',
    'aa000000-0000-0000-0000-000000000002',
    NULL,
    true,
    'wifi',
    true
FROM generate_series(300, 420) AS n
ON CONFLICT (device_id) DO NOTHING;
