import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../../db';
import { requireAuth, requireOrg } from '../../../middleware/auth';

const router = Router();

const createOrderSchema = z.object({
  site_id:                 z.string().uuid(),
  customer_id:             z.string().uuid().optional(),
  season_id:               z.string().uuid().optional(),
  order_date:              z.string().date().optional(),
  tentative_delivery_date: z.string().date().optional(),
  internal_notes:          z.string().trim().max(2000).optional(),
  customer_notes:          z.string().trim().max(2000).optional(),
});

const updateOrderStatusSchema = z.object({
  status: z.enum(['quoted', 'confirmed', 'in_production', 'partial_delivered', 'completed', 'cancelled']),
  internal_notes: z.string().trim().max(2000).optional(),
});

// ── GET /dashboard/nursery/orders ─────────────────────────────────────────────
// Lists orders for the org with optional filters.
// Filters: status, customer_id, date_from, date_to (on order_date).
// Returns each order with customer name and a summary of its batches.
router.get('/nursery/orders', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { organization_id } = req.user!;
  const { status, customer_id, date_from, date_to, site_id } = req.query;

  // Build dynamic WHERE clauses beyond the mandatory org filter
  const conditions: string[] = ['o.organization_id = $1'];
  const params: unknown[]    = [organization_id];
  let   idx                  = 2;

  if (status)      { conditions.push(`o.status = $${idx++}`);         params.push(status); }
  if (customer_id) { conditions.push(`o.customer_id = $${idx++}`);    params.push(customer_id); }
  if (site_id)     { conditions.push(`o.site_id = $${idx++}`);        params.push(site_id); }
  if (date_from)   { conditions.push(`o.order_date >= $${idx++}`);    params.push(date_from); }
  if (date_to)     { conditions.push(`o.order_date <= $${idx++}`);    params.push(date_to); }

  try {
    const { rows } = await pool.query(
      `SELECT
          o.id,
          o.order_date,
          o.tentative_delivery_date,
          o.status,
          o.internal_notes,
          o.created_at,
          o.updated_at,
          -- Customer info
          c.id   AS customer_id,
          c.name AS customer_name,
          c.phone AS customer_phone,
          -- Batch summary aggregated per order
          COUNT(b.id)                                          AS batch_count,
          SUM(b.total_seeds_planned)                           AS total_seeds_planned,
          SUM(b.total_trays_planned)                           AS total_trays_planned,
          SUM(b.total_trays_sown)                              AS total_trays_sown,
          ARRAY_AGG(DISTINCT b.status) FILTER (WHERE b.id IS NOT NULL) AS batch_statuses
        FROM nursery_orders o
        LEFT JOIN nursery_customers c ON c.id = o.customer_id
        LEFT JOIN nursery_batches  b ON b.order_id = o.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY o.id, c.id, c.name, c.phone
       ORDER BY o.order_date DESC, o.created_at DESC`,
      params,
    );
    res.json({ orders: rows });
  } catch (err) {
    console.error('[GET /nursery/orders]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/orders ────────────────────────────────────────────
router.post('/nursery/orders', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { site_id, customer_id, season_id, order_date,
          tentative_delivery_date, internal_notes, customer_notes } = parsed.data;
  const { organization_id, auth0_sub } = req.user!;

  try {
    const { rows } = await pool.query(
      `INSERT INTO nursery_orders
         (organization_id, site_id, customer_id, season_id, order_date,
          tentative_delivery_date, internal_notes, customer_notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, order_date, tentative_delivery_date, status, internal_notes, customer_notes, created_at`,
      [organization_id, site_id,
       customer_id             ?? null,
       season_id               ?? null,
       order_date              ?? new Date().toISOString().slice(0, 10),
       tentative_delivery_date ?? null,
       internal_notes          ?? null,
       customer_notes          ?? null,
       auth0_sub],
    );
    res.status(201).json({ order: rows[0] });
  } catch (err) {
    console.error('[POST /nursery/orders]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/orders/:id ────────────────────────────────────────
// Returns the order with customer info and all its batches.
router.get('/nursery/orders/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id }            = req.params;
  const { organization_id } = req.user!;

  try {
    // Order + customer
    const { rows: orderRows } = await pool.query(
      `SELECT
          o.*,
          c.name             AS customer_name,
          c.contact_name     AS customer_contact,
          c.email            AS customer_email,
          c.phone            AS customer_phone,
          c.tax_id_type,
          c.tax_id,
          c.fiscal_condition,
          c.billing_address,
          c.delivery_address
        FROM nursery_orders o
        LEFT JOIN nursery_customers c ON c.id = o.customer_id
       WHERE o.id = $1 AND o.organization_id = $2`,
      [id, organization_id],
    );
    if (!orderRows[0]) { res.status(404).json({ error: 'Order not found' }); return; }

    // Batches for this order
    const { rows: batchRows } = await pool.query(
      `SELECT
          b.id, b.batch_type, b.crop, b.hybrid_variety, b.tray_size,
          b.total_seeds_planned, b.total_trays_planned, b.partial_tray_seeds,
          b.total_seeds_sown, b.total_trays_sown,
          b.status, b.sowing_date, b.unit_price, b.currency,
          b.created_at,
          -- Count active (non-eliminated) trays
          COUNT(t.id) FILTER (WHERE t.is_eliminated = false) AS active_trays
        FROM nursery_batches b
        LEFT JOIN nursery_trays t ON t.batch_id = b.id
       WHERE b.order_id = $1
       GROUP BY b.id
       ORDER BY b.created_at`,
      [id],
    );

    res.json({ order: orderRows[0], batches: batchRows });
  } catch (err) {
    console.error('[GET /nursery/orders/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /dashboard/nursery/orders/:id/status ───────────────────────────────
// Advances or updates the order status (e.g. confirmed → in_production, cancelled).
router.patch('/nursery/orders/:id/status', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = updateOrderStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { id }            = req.params;
  const { organization_id } = req.user!;
  const { status, internal_notes } = parsed.data;

  try {
    const { rows } = await pool.query(
      `UPDATE nursery_orders
          SET status         = $1,
              internal_notes = COALESCE($2, internal_notes),
              updated_at     = NOW()
        WHERE id = $3 AND organization_id = $4
        RETURNING id, status, internal_notes, updated_at`,
      [status, internal_notes ?? null, id, organization_id],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Order not found' }); return; }
    res.json({ order: rows[0] });
  } catch (err) {
    console.error('[PATCH /nursery/orders/:id/status]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
