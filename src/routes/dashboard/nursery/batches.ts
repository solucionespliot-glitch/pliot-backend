import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../../db';
import { requireAuth, requireOrg } from '../../../middleware/auth';

const router = Router();

// Discrete tray sizes supported by the nursery
const TRAY_SIZES = [72, 128, 162, 228] as const;

// Valid one-way status transitions for standard batches
const VALID_TRANSITIONS: Record<string, string[]> = {
  ordered:           ['sowing', 'cancelled'],
  sowing:            ['germination', 'cancelled'],
  germination:       ['nursery', 'cancelled'],
  grafting_chamber:  ['nursery', 'cancelled'],
  nursery:           ['delivered', 'cancelled'],
};

const createBatchSchema = z.object({
  crop:                z.string().trim().min(1).max(200),
  hybrid_variety:      z.string().trim().min(1).max(200),
  seed_lot_number:     z.string().trim().max(100).optional(),
  purchase_date:       z.string().date().optional(),
  tray_size:           z.number().refine((v): v is typeof TRAY_SIZES[number] => (TRAY_SIZES as readonly number[]).includes(v), {
                         message: 'tray_size must be one of 72, 128, 162, 228',
                       }),
  substrate:           z.string().trim().max(200).optional(),
  total_seeds_planned: z.number().int().positive(),
  unit_price:          z.number().nonnegative().optional(),
  currency:            z.enum(['ARS', 'USD']).optional(),
  price_notes:         z.string().trim().max(500).optional(),
  notes:               z.string().trim().max(2000).optional(),
});

const confirmSowingSchema = z.object({
  sowing_date:       z.string().date(),
  sowing_node_id:    z.string().uuid().optional(),
  total_seeds_sown:  z.number().int().positive(),
  substrate:         z.string().trim().max(200).optional(),
  // Required when the last tray will be partial (empty cells).
  // Frontend sends this after the user confirms the warning dialog.
  confirmed_partial: z.boolean().optional(),
});

const transitionSchema = z.object({
  to_status:   z.enum(['sowing', 'germination', 'nursery', 'delivered', 'cancelled']),
  node_id:     z.string().uuid().optional(),
  occurred_at: z.string().datetime().optional(),
  // When true, propagates the transition to all active (non-eliminated) trays
  apply_to_trays: z.boolean().optional().default(true),
});

const createEventSchema = z.object({
  event_type:        z.enum([
    'irrigation', 'fertilization', 'application',
    'observation', 'photo', 'treatment', 'note', 'bulk_elimination',
  ]),
  occurred_at:       z.string().datetime().optional(),
  reference_node_id: z.string().uuid().optional(),
  notes:             z.string().trim().max(2000).optional(),
  photo_url:         z.string().url().optional(),
  data:              z.record(z.unknown()).optional(),
  // Application-specific fields
  product_name:      z.string().trim().max(200).optional(),
  dose:              z.string().trim().max(100).optional(),
  phi_days:          z.number().int().nonnegative().optional(),
});

// ── POST /dashboard/nursery/orders/:order_id/batches ─────────────────────────
// Creates a new batch (one crop/variety) within an order.
// Calculates planned tray count and flags partial last tray.
router.post('/nursery/orders/:order_id/batches', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = createBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { order_id }      = req.params;
  const { organization_id, auth0_sub } = req.user!;
  const { crop, hybrid_variety, seed_lot_number, purchase_date, tray_size,
          substrate, total_seeds_planned, unit_price, currency, price_notes, notes } = parsed.data;

  // Verify order belongs to this org
  const { rows: orderRows } = await pool.query(
    `SELECT id, site_id FROM nursery_orders WHERE id = $1 AND organization_id = $2`,
    [order_id, organization_id],
  );
  if (!orderRows[0]) { res.status(404).json({ error: 'Order not found' }); return; }

  // Calculate planned tray breakdown
  const total_trays_planned = Math.ceil(total_seeds_planned / tray_size);
  const seeds_in_last_tray  = total_seeds_planned % tray_size;
  // partial_tray_seeds = 0 means last tray is exactly full
  const partial_tray_seeds  = seeds_in_last_tray === 0 ? 0 : seeds_in_last_tray;

  try {
    const { rows } = await pool.query(
      `INSERT INTO nursery_batches
         (organization_id, site_id, order_id, crop, hybrid_variety, seed_lot_number,
          purchase_date, tray_size, substrate, total_seeds_planned,
          total_trays_planned, partial_tray_seeds, unit_price, currency,
          price_notes, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [organization_id, orderRows[0].site_id, order_id,
       crop, hybrid_variety,
       seed_lot_number ?? null,
       purchase_date   ?? null,
       tray_size, substrate ?? null,
       total_seeds_planned, total_trays_planned, partial_tray_seeds,
       unit_price  ?? null,
       currency    ?? 'ARS',
       price_notes ?? null,
       notes       ?? null,
       auth0_sub],
    );
    res.status(201).json({ batch: rows[0] });
  } catch (err) {
    console.error('[POST /nursery/orders/:order_id/batches]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/batches/:id ───────────────────────────────────────
// Returns batch detail including active tray list and latest event.
router.get('/nursery/batches/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id }            = req.params;
  const { organization_id } = req.user!;

  try {
    const { rows: batchRows } = await pool.query(
      `SELECT b.*,
              d.device_id AS reference_node_device_id
         FROM nursery_batches b
         LEFT JOIN devices d ON d.id = b.reference_node_id
        WHERE b.id = $1 AND b.organization_id = $2`,
      [id, organization_id],
    );
    if (!batchRows[0]) { res.status(404).json({ error: 'Batch not found' }); return; }

    // Trays summary (active and eliminated counts, list of active)
    const { rows: trayRows } = await pool.query(
      `SELECT t.*,
              l.greenhouse, l.bench, l.subbench
         FROM nursery_trays t
         LEFT JOIN nursery_locations l ON l.id = t.nursery_location_id
        WHERE t.batch_id = $1
        ORDER BY t.tray_number`,
      [id],
    );

    // Latest events (last 5)
    const { rows: eventRows } = await pool.query(
      `SELECT id, event_type, occurred_at, notes, product_name, dose, source, created_by
         FROM nursery_events
        WHERE batch_id = $1
        ORDER BY occurred_at DESC
        LIMIT 5`,
      [id],
    );

    const activeTrays      = trayRows.filter(t => !t.is_eliminated);
    const eliminatedTrays  = trayRows.filter(t => t.is_eliminated);
    const pendingApprovals = trayRows.filter(t => t.elimination_approval_status === 'pending');

    res.json({
      batch:              batchRows[0],
      trays: {
        active:           activeTrays,
        eliminated:       eliminatedTrays,
        pending_approval: pendingApprovals,
        total:            trayRows.length,
      },
      recent_events:      eventRows,
    });
  } catch (err) {
    console.error('[GET /nursery/batches/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/batches/:id/confirm-sowing ───────────────────────
// Confirms sowing for a batch. Generates individual tray rows with QR codes.
// Batch must be in 'ordered' status.
//
// If the last tray will have empty cells (partial), the endpoint returns a
// warning instead of creating the trays, unless confirmed_partial = true.
// This gives the frontend a chance to show a confirmation dialog.
router.post('/nursery/batches/:id/confirm-sowing', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = confirmSowingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { id }            = req.params;
  const { organization_id, auth0_sub } = req.user!;
  const { sowing_date, sowing_node_id, total_seeds_sown, substrate, confirmed_partial } = parsed.data;

  try {
    const { rows: batchRows } = await pool.query(
      `SELECT * FROM nursery_batches WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!batchRows[0]) { res.status(404).json({ error: 'Batch not found' }); return; }

    const batch = batchRows[0];
    if (batch.status !== 'ordered') {
      res.status(400).json({ error: `Batch is already in status '${batch.status}'. Cannot confirm sowing.` });
      return;
    }

    const tray_size         = batch.tray_size as number;
    const total_trays       = Math.ceil(total_seeds_sown / tray_size);
    const seeds_in_last     = total_seeds_sown % tray_size;
    const partial_seeds     = seeds_in_last === 0 ? 0 : seeds_in_last;
    const empty_cells       = partial_seeds === 0 ? 0 : tray_size - partial_seeds;

    // If last tray is partial, require explicit confirmation before generating trays
    if (empty_cells > 0 && !confirmed_partial) {
      res.json({
        warning:              true,
        message:              `La última bandeja tendrá ${empty_cells} celdas vacías (${partial_seeds}/${tray_size} semillas). ¿Continuar?`,
        empty_cells,
        partial_seeds,
        total_trays_to_create: total_trays,
        requires_confirmation: true,
      });
      return;
    }

    // Generate tray rows in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update batch to sowing status
      await client.query(
        `UPDATE nursery_batches
            SET status            = 'sowing',
                sowing_date       = $1,
                sowing_node_id    = $2,
                reference_node_id = $2,
                total_seeds_sown  = $3,
                total_trays_sown  = $4,
                partial_tray_seeds = $5,
                substrate         = COALESCE($6, substrate),
                updated_at        = NOW()
          WHERE id = $7`,
        [sowing_date, sowing_node_id ?? null, total_seeds_sown,
         total_trays, partial_seeds, substrate ?? null, id],
      );

      // Insert one row per tray; last tray may have fewer cells than tray_size
      const insertedTrays: unknown[] = [];
      for (let n = 1; n <= total_trays; n++) {
        const isLast         = n === total_trays;
        const plant_capacity = isLast && partial_seeds > 0 ? partial_seeds : tray_size;

        const { rows: trayRows } = await client.query(
          `INSERT INTO nursery_trays
             (organization_id, batch_id, tray_number, qr_code, plant_capacity,
              current_node_id, created_by)
           VALUES ($1, $2, $3, gen_random_uuid()::text, $4, $5, $6)
           RETURNING id, tray_number, qr_code, plant_capacity, status`,
          [organization_id, id, n, plant_capacity,
           sowing_node_id ?? null, auth0_sub],
        );
        insertedTrays.push(trayRows[0]);
      }

      // Auto-advance order status to in_production if it was confirmed
      await client.query(
        `UPDATE nursery_orders
            SET status     = 'in_production',
                updated_at = NOW()
          WHERE id = (SELECT order_id FROM nursery_batches WHERE id = $1)
            AND status = 'confirmed'`,
        [id],
      );

      await client.query('COMMIT');
      res.status(201).json({
        message: `${total_trays} bandejas generadas.`,
        trays:   insertedTrays,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /nursery/batches/:id/confirm-sowing]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/batches/:id/transition ───────────────────────────
// Advances the batch to the next stage.
// Validates the transition is allowed (one-way state machine).
// Optionally propagates the new status to all active trays.
router.post('/nursery/batches/:id/transition', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = transitionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { id }            = req.params;
  const { organization_id } = req.user!;
  const { to_status, node_id, occurred_at, apply_to_trays } = parsed.data;
  const ts = occurred_at ? new Date(occurred_at) : new Date();

  try {
    const { rows: batchRows } = await pool.query(
      `SELECT id, status FROM nursery_batches WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!batchRows[0]) { res.status(404).json({ error: 'Batch not found' }); return; }

    const current = batchRows[0].status as string;
    const allowed = VALID_TRANSITIONS[current] ?? [];
    if (!allowed.includes(to_status)) {
      res.status(400).json({
        error: `Cannot transition from '${current}' to '${to_status}'. Allowed: ${allowed.join(', ')}`,
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Stage-specific timestamp and node columns on the batch
      const stageUpdates: Record<string, string> = {
        germination:      `germination_entry_at = $3, germination_node_id = $4`,
        nursery:          `nursery_placed_at = $3`,
        grafting_chamber: `germination_entry_at = $3`,
      };
      const extraSet = stageUpdates[to_status] ?? '';

      await client.query(
        `UPDATE nursery_batches
            SET status            = $1,
                reference_node_id = COALESCE($2, reference_node_id),
                ${extraSet ? extraSet + ',' : ''}
                updated_at        = NOW()
          WHERE id = $${extraSet ? '5' : '3'} AND organization_id = $${extraSet ? '6' : '4'}`,
        extraSet
          ? [to_status, node_id ?? null, ts, node_id ?? null, id, organization_id]
          : [to_status, node_id ?? null, id, organization_id],
      );

      // Propagate to active trays if requested
      if (apply_to_trays) {
        await client.query(
          `UPDATE nursery_trays
              SET status         = $1,
                  current_node_id = COALESCE($2, current_node_id),
                  updated_at     = NOW()
            WHERE batch_id = $3
              AND is_eliminated = false
              AND status NOT IN ('delivered', 'eliminated')`,
          [to_status, node_id ?? null, id],
        );
      }

      await client.query('COMMIT');
      res.json({ ok: true, status: to_status });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /nursery/batches/:id/transition]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/batches/:id/qr-sheet ──────────────────────────────
// Returns ZPL for all trays of a batch, ready to send to a Zebra printer.
// Label size: 2" × 1" at 203 DPI (406 × 203 dots).
// Each label encodes the tray's qr_code (UUID) as a QR code plus human-readable info.
router.get('/nursery/batches/:id/qr-sheet', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id }            = req.params;
  const { organization_id } = req.user!;

  try {
    const { rows: batchRows } = await pool.query(
      `SELECT id, crop, hybrid_variety, seed_lot_number, sowing_date, total_trays_sown
         FROM nursery_batches
        WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!batchRows[0]) { res.status(404).json({ error: 'Batch not found' }); return; }

    const { rows: trayRows } = await pool.query(
      `SELECT tray_number, qr_code, plant_capacity
         FROM nursery_trays
        WHERE batch_id = $1 AND is_eliminated = false
        ORDER BY tray_number`,
      [id],
    );

    if (trayRows.length === 0) {
      res.status(400).json({ error: 'No trays found for this batch. Confirm sowing first.' });
      return;
    }

    const batch       = batchRows[0];
    const totalTrays  = trayRows.length;
    const sowingDate  = batch.sowing_date
      ? new Date(batch.sowing_date).toLocaleDateString('es-AR')
      : '-';
    const lotNumber   = batch.seed_lot_number ?? '-';

    // Build ZPL: one label per tray, concatenated
    // ^BQN,2,4 = QR code, normal orientation, module size 4
    // ^A0N = scalable font, orientation normal
    const zpl = trayRows.map(tray => {
      const label     = `${batch.crop} ${batch.hybrid_variety}`;
      const bandeja   = `Bandeja ${tray.tray_number}/${totalTrays}`;
      const capacidad = `${tray.plant_capacity} plantas`;

      return [
        '^XA',
        '^MMT',
        '^PW406',
        '^LL203',
        '^LS0',
        // QR code (left side, 100x100 area)
        `^FO10,10^BQN,2,4^FDMA,${tray.qr_code}^FS`,
        // Crop name + hybrid
        `^FO120,12^A0N,22,22^FD${label.slice(0, 22)}^FS`,
        // Tray number / total
        `^FO120,40^A0N,20,20^FD${bandeja}^FS`,
        // Plant capacity
        `^FO120,65^A0N,18,18^FD${capacidad}^FS`,
        // Sowing date
        `^FO120,88^A0N,16,16^FDSiembra: ${sowingDate}^FS`,
        // Seed lot number (bottom)
        `^FO10,170^A0N,14,14^FDLote semilla: ${lotNumber.slice(0, 30)}^FS`,
        '^XZ',
      ].join('\n');
    }).join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="qr-batch-${id.slice(0, 8)}.zpl"`);
    res.send(zpl);
  } catch (err) {
    console.error('[GET /nursery/batches/:id/qr-sheet]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/batches/:id/events ───────────────────────────────
// Adds an agricultural or operational event to a batch.
// tray_id in body is optional: if omitted, the event applies to the whole batch.
router.post('/nursery/batches/:id/events', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { id }            = req.params;
  const { organization_id, auth0_sub } = req.user!;
  const { event_type, occurred_at, reference_node_id, notes, photo_url,
          data, product_name, dose, phi_days } = parsed.data;

  // For bulk_elimination events, data.quantity is required
  if (event_type === 'bulk_elimination') {
    const qty = (data as { quantity?: unknown })?.quantity;
    if (typeof qty !== 'number' || qty < 1) {
      res.status(400).json({ error: 'bulk_elimination requires data.quantity (positive integer)' });
      return;
    }
  }

  try {
    const { rows: batchRows } = await pool.query(
      `SELECT id FROM nursery_batches WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!batchRows[0]) { res.status(404).json({ error: 'Batch not found' }); return; }

    const { rows } = await pool.query(
      `INSERT INTO nursery_events
         (batch_id, event_type, occurred_at, reference_node_id, notes,
          photo_url, data, product_name, dose, phi_days, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, event_type, occurred_at, notes, created_at`,
      [id, event_type,
       occurred_at        ?? new Date().toISOString(),
       reference_node_id  ?? null,
       notes              ?? null,
       photo_url          ?? null,
       data               ? JSON.stringify(data) : null,
       product_name       ?? null,
       dose               ?? null,
       phi_days           ?? null,
       auth0_sub],
    );
    res.status(201).json({ event: rows[0] });
  } catch (err) {
    console.error('[POST /nursery/batches/:id/events]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
