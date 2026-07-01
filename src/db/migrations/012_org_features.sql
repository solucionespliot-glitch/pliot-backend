-- Migration 012: org-level feature flags
-- Features are stored as JSONB on organizations for easy extensibility.
-- To enable a feature for an org:
--   UPDATE organizations SET features = features || '{"lots": true}' WHERE slug = 'xxx';
-- Superusers always bypass feature gates (checked in requireFeature middleware).

ALTER TABLE organizations
ADD COLUMN features jsonb NOT NULL DEFAULT '{}'::jsonb;
