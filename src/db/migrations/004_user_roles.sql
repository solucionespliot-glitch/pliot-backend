-- Migration: 004_user_roles
-- Description: User roles for multi-tenant JWT-based auth

CREATE TABLE IF NOT EXISTS user_roles (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth0_sub       TEXT        UNIQUE NOT NULL,
  organization_id UUID        REFERENCES organizations(id),
  role            TEXT        CHECK (role IN ('superuser','distributor','producer','advisor','operator')),
  site_ids        JSONB,
  scopes          JSONB,
  enabled         BOOLEAN     DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_roles_auth0_sub       ON user_roles (auth0_sub);
CREATE INDEX IF NOT EXISTS idx_user_roles_organization_id ON user_roles (organization_id);
