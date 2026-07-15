-- Migration: 008_lora_abp_keys
-- Description: ABP session keys for LoRa nodes forwarded by the GL controller firmware.
-- The GL controller sends raw LoRaWAN frames to /api/v5/lora with deviceName = DevAddr (hex).
-- The ingest handler looks up this table to decrypt the frame payload using AppSKey/NwkSKey.

-- NOTE: this table was created directly in the DB before this migration was written.
-- The actual schema uses fixed-length CHAR columns (not TEXT) and has no updated_at.
-- This script is kept for documentation and re-creation purposes only.
CREATE TABLE IF NOT EXISTS lora_abp_keys (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dev_addr    CHARACTER(8)   UNIQUE NOT NULL,  -- uppercase hex, exactly 8 chars e.g. '01FF0301'
  app_s_key   CHARACTER(32)  NOT NULL,          -- 32-char hex (16 bytes AES-128)
  nwk_s_key   CHARACTER(32)  NOT NULL,          -- 32-char hex (16 bytes AES-128)
  device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lora_abp_keys_dev_addr ON lora_abp_keys (dev_addr);
