import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../../db';
import { requireAuth, requireOrg } from '../../../middleware/auth';

const router = Router();

const createCustomerSchema = z.object({
  name:             z.string().trim().min(1).max(200),
  contact_name:     z.string().trim().max(200).optional(),
  email:            z.string().email().optional(),
  phone:            z.string().trim().max(50).optional(),
  tax_id_type:      z.enum(['cuit', 'cuil', 'dni', 'passport', 'other']).optional(),
  tax_id:           z.string().trim().max(20).optional(),
  fiscal_condition: z.string().trim().max(100).optional(),
  billing_address:  z.string().trim().max(500).optional(),
  delivery_address: z.string().trim().max(500).optional(),
  notes:            z.string().trim().max(1000).optional(),
});

// ── GET /dashboard/nursery/customers ─────────────────────────────────────────
// Returns all active customers for the org, ordered by name.
router.get('/nursery/customers', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { organization_id } = req.user!;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, contact_name, email, phone,
              tax_id_type, tax_id, fiscal_condition, active, created_at
         FROM nursery_customers
        WHERE organization_id = $1 AND active = true
        ORDER BY name`,
      [organization_id],
    );
    res.json({ customers: rows });
  } catch (err) {
    console.error('[GET /nursery/customers]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/customers ────────────────────────────────────────
router.post('/nursery/customers', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { name, contact_name, email, phone, tax_id_type, tax_id,
          fiscal_condition, billing_address, delivery_address, notes } = parsed.data;
  const { organization_id } = req.user!;

  try {
    const { rows } = await pool.query(
      `INSERT INTO nursery_customers
         (organization_id, name, contact_name, email, phone, tax_id_type, tax_id,
          fiscal_condition, billing_address, delivery_address, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, contact_name, email, phone, tax_id_type, tax_id,
                 fiscal_condition, active, created_at`,
      [organization_id, name,
       contact_name     ?? null,
       email            ?? null,
       phone            ?? null,
       tax_id_type      ?? null,
       tax_id           ?? null,
       fiscal_condition ?? null,
       billing_address  ?? null,
       delivery_address ?? null,
       notes            ?? null],
    );
    res.status(201).json({ customer: rows[0] });
  } catch (err) {
    console.error('[POST /nursery/customers]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/customers/:id ─────────────────────────────────────
router.get('/nursery/customers/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { organization_id } = req.user!;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM nursery_customers WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Customer not found' }); return; }
    res.json({ customer: rows[0] });
  } catch (err) {
    console.error('[GET /nursery/customers/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
