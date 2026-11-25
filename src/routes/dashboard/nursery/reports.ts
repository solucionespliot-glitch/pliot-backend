import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../../db';
import { requireAuth, requireOrg } from '../../../middleware/auth';

const router = Router();

const yearSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

function currentYear(): number {
  return new Date().getFullYear();
}

// Fills missing months (1–12) with count = 0 so the response always has 12 rows.
function toMonthlySeries(rows: { month: number; count: number }[]): { month: number; count: number }[] {
  const map = new Map(rows.map(r => [r.month, r.count]));
  return Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: map.get(i + 1) ?? 0 }));
}

// ── GET /dashboard/nursery/reports/monthly-totals ─────────────────────────────
// Returns per-month counts of trays created and trays delivered for a given year.
// ?year=2026   (defaults to current year)
//
// "created"   = when the tray row was inserted (i.e. when sowing was confirmed)
// "delivered" = when nursery_trays.delivered_at was set (batch or individual delivery)
router.get('/nursery/reports/monthly-totals', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = yearSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const year = parsed.data.year ?? currentYear();
  const { organization_id } = req.user!;

  try {
    // Trays created per month: use tray created_at, filtered through batch org
    const { rows: createdRows } = await pool.query(
      `SELECT EXTRACT(MONTH FROM t.created_at)::int AS month,
              COUNT(*)::int AS count
         FROM nursery_trays t
         JOIN nursery_batches b ON b.id = t.batch_id
        WHERE b.organization_id = $1
          AND EXTRACT(YEAR FROM t.created_at) = $2
        GROUP BY 1
        ORDER BY 1`,
      [organization_id, year],
    );

    // Trays delivered per month
    const { rows: deliveredRows } = await pool.query(
      `SELECT EXTRACT(MONTH FROM t.delivered_at)::int AS month,
              COUNT(*)::int AS count
         FROM nursery_trays t
         JOIN nursery_batches b ON b.id = t.batch_id
        WHERE b.organization_id = $1
          AND t.delivered_at IS NOT NULL
          AND EXTRACT(YEAR FROM t.delivered_at) = $2
        GROUP BY 1
        ORDER BY 1`,
      [organization_id, year],
    );

    res.json({
      year,
      created:   toMonthlySeries(createdRows),
      delivered: toMonthlySeries(deliveredRows),
      asOf:      new Date().toISOString(),
    });
  } catch (err) {
    console.error('[GET /nursery/reports/monthly-totals]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/reports/avg-cycle-days ─────────────────────────────
// Returns average days from sowing to delivery, grouped by crop and variety.
// Only counts trays that have both a sowing_date on the batch and a delivered_at.
// ?year=2026   (filters by delivery year; defaults to current year)
router.get('/nursery/reports/avg-cycle-days', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = yearSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const year = parsed.data.year ?? currentYear();
  const { organization_id } = req.user!;

  try {
    const { rows } = await pool.query(
      `SELECT
          b.crop,
          b.hybrid_variety,
          COUNT(t.id)::int AS delivered_trays,
          ROUND(AVG(
            EXTRACT(EPOCH FROM (t.delivered_at - b.sowing_date::timestamptz)) / 86400
          ))::int AS avg_days
         FROM nursery_trays t
         JOIN nursery_batches b ON b.id = t.batch_id
        WHERE b.organization_id = $1
          AND t.delivered_at IS NOT NULL
          AND b.sowing_date IS NOT NULL
          AND EXTRACT(YEAR FROM t.delivered_at) = $2
        GROUP BY b.crop, b.hybrid_variety
        ORDER BY b.crop, b.hybrid_variety`,
      [organization_id, year],
    );

    res.json({
      year,
      rows,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[GET /nursery/reports/avg-cycle-days]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/reports/deliveries-by-recipient ────────────────────
// Returns total trays and plants delivered, grouped by recipient name.
// Uses nursery_deliveries + nursery_delivery_trays so it reflects the actual
// recipient (who physically received), not necessarily the billing customer.
// ?year=2026   (filters by delivery year; defaults to current year)
router.get('/nursery/reports/deliveries-by-recipient', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = yearSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const year = parsed.data.year ?? currentYear();
  const { organization_id } = req.user!;

  try {
    const { rows } = await pool.query(
      `SELECT
          d.recipient_name,
          COUNT(dt.tray_id)::int        AS tray_count,
          SUM(dt.plants_delivered)::int AS total_plants
         FROM nursery_deliveries d
         JOIN nursery_delivery_trays dt ON dt.delivery_id = d.id
         JOIN nursery_orders o ON o.id = d.order_id
        WHERE o.organization_id = $1
          AND EXTRACT(YEAR FROM d.delivered_at) = $2
        GROUP BY d.recipient_name
        ORDER BY tray_count DESC`,
      [organization_id, year],
    );

    res.json({
      year,
      rows,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[GET /nursery/reports/deliveries-by-recipient]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
