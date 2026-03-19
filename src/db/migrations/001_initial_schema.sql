-- Migration: 001_initial_schema
-- Description: Initial schema for organizations, sites, and zones

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Organizations
CREATE TABLE IF NOT EXISTS organizations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT        UNIQUE NOT NULL,
  name         TEXT        NOT NULL,
  plan_level   INTEGER     DEFAULT 1,
  enabled      BOOLEAN     DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Sites
CREATE TABLE IF NOT EXISTS sites (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id),
  name            TEXT        NOT NULL,
  latitude        NUMERIC,
  longitude       NUMERIC,
  timezone        TEXT        DEFAULT 'America/Argentina/Buenos_Aires',
  enabled         BOOLEAN     DEFAULT TRUE,
  metadata        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Zones
CREATE TABLE IF NOT EXISTS zones (
  id         UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    UUID     NOT NULL REFERENCES sites(id),
  name       TEXT     NOT NULL,
  zone_type  TEXT     CHECK (zone_type IN ('greenhouse', 'open_field', 'sector', 'other')),
  geometry   JSONB,
  enabled    BOOLEAN  DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
