--- Seed: Global fogger presets
-- 3 default presets available to all organizations

INSERT INTO fogger_presets (id, organization_id, name, description, duration_sec, interval_sec, active)
VALUES
    (
        'a1000000-0000-0000-0000-000000000001',
        NULL,
        'Ciclo corto',
        'Pulsos cortos para humidificación leve. Ideal para días con baja temperatura.',
        30,
        300,
        true
    ),
    (
        'a1000000-0000-0000-0000-000000000002',
        NULL,
        'Ciclo estándar',
        'Balance entre humidificación y consumo. Uso general para verano.',
        60,
        600,
        true
    ),
    (
        'a1000000-0000-0000-0000-000000000003',
        NULL,
        'Ciclo intensivo',
        'Máxima humidificación para días de calor extremo o estrés hídrico.',
        120,
        600,
        true
    )
ON CONFLICT (id) DO NOTHING;