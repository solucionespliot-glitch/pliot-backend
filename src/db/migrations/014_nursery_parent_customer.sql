-- Migration 014: parent_customer_id for nursery_customers
-- Enables producer → quintas hierarchy:
--   parent (producer): has CUIT, fiscal condition, billing address
--   children (quintas): have delivery address, contact name, phone
-- parent_customer_id = NULL means top-level customer

ALTER TABLE nursery_customers
  ADD COLUMN IF NOT EXISTS parent_customer_id UUID REFERENCES nursery_customers(id) ON DELETE SET NULL;

-- Index for fast lookup of all quintas belonging to a producer
CREATE INDEX IF NOT EXISTS idx_nursery_customers_parent ON nursery_customers (parent_customer_id);
