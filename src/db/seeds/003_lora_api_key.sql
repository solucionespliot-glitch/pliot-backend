-- Seed: API key for pliot.ar → /api/v5/lora ingest
-- key_id:  'pliot-lora'
-- raw key: 'pliot-lora-ingest-2026'   ← use this in nginx X-API-Key header
-- format:  X-API-Key: pliot-lora:pliot-lora-ingest-2026

INSERT INTO api_keys (id, key_id, key_hash, scopes, enabled)
VALUES (
    gen_random_uuid(),
    'pliot-lora',
    '$2b$10$Cicy22hPl6zUb6E5XZRqBu5W1VfJaDFfco1y9/VOb6lCONzBgob8K',
    '["ingest"]'::jsonb,
    true
)
ON CONFLICT (key_id) DO NOTHING;
