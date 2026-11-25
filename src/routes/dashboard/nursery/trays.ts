import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../../db';
import { requireAuth, requireOrg, requireRole } from '../../../middleware/auth';

const router = Router();

// Valid one-way status transitions for individual trays (mirrors batch state machine)
const TRAY_VALID_TRANSITIONS: Record<string, string[]> = {
  sowing:           ['germination'],
  germination:      ['nursery'],
  grafting_chamber: ['nursery'],
  nursery:          ['delivered'],
};

const trayTransitionSchema = z.object({
  to_status:   z.enum(['germination', 'nursery', 'delivered']),
  node_id:     z.string().uuid().optional(),
  occurred_at: z.string().datetime().optional(),
  notes:       z.string().trim().max(1000).optional(),
});

const eliminateSchema = z.object({
  reason: z.enum(['seed_shortage', 'broken', 'theft', 'gifted', 'pest', 'disease', 'other']),
  notes:  z.string().trim().max(1000).optional(),
  // When true, applies the elimination request to all active trays in the same batch.
  // Used when the operator scans one tray and clicks "Aplicar a todo el lote".
  apply_to_batch: z.boolean().optional().default(false),
});

const approveEliminationSchema = z.object({
  // approved: true = confirm elimination; false = reject request
  approved: z.boolean(),
  notes:    z.string().trim().max(500).optional(),
  // When true, approves all pending elimination requests for the same batch
  apply_to_batch: z.boolean().optional().default(false),
});

const plantCountSchema = z.object({
  count_date:     z.string().date().optional(),
  emerged_plants: z.number().int().nonnegative(),
  photo_url:      z.string().url().optional(),
  notes:          z.string().trim().max(1000).optional(),
});

// ── GET /dashboard/nursery/trays/by-qr/:qrCode ───────────────────────────────
// Primary QR scan endpoint. Returns tray info plus its batch and order context.
// This is the first call made when a user scans a tray QR code.
router.get('/nursery/trays/by-qr/:qrCode', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { qrCode }        = req.params;
  const { organization_id } = req.user!;

  try {
    const { rows } = await pool.query(
      `SELECT
          t.id,
          t.tray_number,
          t.qr_code,
          t.plant_capacity,
          t.status,
          t.is_eliminated,
          t.elimination_approval_status,
          t.nursery_placed_at,
          t.germination_entry_at,
          t.germination_exit_at,
          t.delivered_at,
          -- Batch context
          b.id               AS batch_id,
          b.crop,
          b.hybrid_variety,
          b.tray_size,
          b.status           AS batch_status,
          b.total_trays_sown AS batch_total_trays,
          -- Order context
          o.id               AS order_id,
          o.tentative_delivery_date,
          -- Location (if placed in nursery)
          l.greenhouse,
          l.bench,
          l.subbench,
          -- Reference node
          d.device_id        AS node_device_id
        FROM nursery_trays t
        JOIN nursery_batches b ON b.id = t.batch_id
        LEFT JOIN nursery_orders   o ON o.id = b.order_id
        LEFT JOIN nursery_locations l ON l.id = t.nursery_location_id
        LEFT JOIN devices          d ON d.id = t.current_node_id
       WHERE t.qr_code = $1 AND t.organization_id = $2`,
      [qrCode, organization_id],
    );
    if (!rows[0]) { res.status(404).json({ error: 'Tray not found' }); return; }

    // Latest plant count for this tray
    const { rows: countRows } = await pool.query(
      `SELECT emerged_plants, germination_pct, count_date, count_method
         FROM nursery_plant_counts
        WHERE tray_id = $1
        ORDER BY count_date DESC
        LIMIT 1`,
      [rows[0].id],
    );

    res.json({ tray: rows[0], latest_count: countRows[0] ?? null });
  } catch (err) {
    console.error('[GET /nursery/trays/by-qr/:qrCode]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/trays/:id ─────────────────────────────────────────
// Returns full tray detail with all plant counts and events.
router.get('/nursery/trays/:id', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id }            = req.params;
  const { organization_id } = req.user!;

  try {
    const { rows: trayRows } = await pool.query(
      `SELECT t.*, b.crop, b.hybrid_variety, b.tray_size, b.status AS batch_status
         FROM nursery_trays t
         JOIN nursery_batches b ON b.id = t.batch_id
        WHERE t.id = $1 AND t.organization_id = $2`,
      [id, organization_id],
    );
    if (!trayRows[0]) { res.status(404).json({ error: 'Tray not found' }); return; }

    const { rows: countRows } = await pool.query(
      `SELECT id, count_date, total_cells, emerged_plants, germination_pct,
              photo_url, count_method, notes, created_at
         FROM nursery_plant_counts
        WHERE tray_id = $1
        ORDER BY count_date DESC`,
      [id],
    );

    res.json({ tray: trayRows[0], plant_counts: countRows });
  } catch (err) {
    console.error('[GET /nursery/trays/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/trays/:id/eliminate ──────────────────────────────
// Operator requests elimination of a tray (or all trays in the batch).
// Sets elimination_approval_status = 'pending'. Requires producer approval.
router.post('/nursery/trays/:id/eliminate', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = eliminateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { id }            = req.params;
  const { organization_id, auth0_sub } = req.user!;
  const { reason, notes, apply_to_batch } = parsed.data;

  try {
    const { rows: trayRows } = await pool.query(
      `SELECT id, batch_id, is_eliminated, elimination_approval_status
         FROM nursery_trays
        WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!trayRows[0]) { res.status(404).json({ error: 'Tray not found' }); return; }
    if (trayRows[0].is_eliminated) {
      res.status(400).json({ error: 'Tray is already eliminated' });
      return;
    }
    if (trayRows[0].elimination_approval_status === 'pending') {
      res.status(400).json({ error: 'Elimination already pending approval' });
      return;
    }

    // Determine which tray IDs to mark — single or whole batch
    let trayIds: string[] = [id];
    if (apply_to_batch) {
      const { rows: batchTrays } = await pool.query(
        `SELECT id FROM nursery_trays
          WHERE batch_id = $1
            AND is_eliminated = false
            AND elimination_approval_status IS NULL
            AND organization_id = $2`,
        [trayRows[0].batch_id, organization_id],
      );
      trayIds = batchTrays.map(r => r.id as string);
    }

    await pool.query(
      `UPDATE nursery_trays
          SET elimination_reason          = $1,
              elimination_notes           = $2,
              eliminated_by               = $3,
              elimination_approval_status = 'pending',
              updated_at                  = NOW()
        WHERE id = ANY($4) AND organization_id = $5`,
      [reason, notes ?? null, auth0_sub, trayIds, organization_id],
    );

    res.json({ ok: true, pending_count: trayIds.length });
  } catch (err) {
    console.error('[POST /nursery/trays/:id/eliminate]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/trays/:id/approve-elimination ────────────────────
// Producer approves or rejects a pending elimination request.
// Role required: producer or above.
router.post(
  '/nursery/trays/:id/approve-elimination',
  requireAuth,
  requireOrg,
  requireRole(['producer', 'distributor', 'superuser']),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = approveEliminationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    const { id }            = req.params;
    const { organization_id, auth0_sub } = req.user!;
    const { approved, notes: approvalNotes, apply_to_batch } = parsed.data;

    try {
      const { rows: trayRows } = await pool.query(
        `SELECT id, batch_id, elimination_approval_status
           FROM nursery_trays
          WHERE id = $1 AND organization_id = $2`,
        [id, organization_id],
      );
      if (!trayRows[0]) { res.status(404).json({ error: 'Tray not found' }); return; }
      if (trayRows[0].elimination_approval_status !== 'pending') {
        res.status(400).json({ error: 'No pending elimination request for this tray' });
        return;
      }

      // Determine scope: single tray or all pending in batch
      let trayIds: string[] = [id];
      if (apply_to_batch) {
        const { rows: batchTrays } = await pool.query(
          `SELECT id FROM nursery_trays
            WHERE batch_id = $1
              AND elimination_approval_status = 'pending'
              AND organization_id = $2`,
          [trayRows[0].batch_id, organization_id],
        );
        trayIds = batchTrays.map(r => r.id as string);
      }

      if (approved) {
        // Mark as eliminated
        await pool.query(
          `UPDATE nursery_trays
              SET is_eliminated               = true,
                  status                      = 'eliminated',
                  elimination_approval_status = 'approved',
                  elimination_approved_by     = $1,
                  elimination_approved_at     = NOW(),
                  eliminated_at               = NOW(),
                  elimination_notes           = COALESCE($2, elimination_notes),
                  updated_at                  = NOW()
            WHERE id = ANY($3) AND organization_id = $4`,
          [auth0_sub, approvalNotes ?? null, trayIds, organization_id],
        );
      } else {
        // Reject — clear the pending request
        await pool.query(
          `UPDATE nursery_trays
              SET elimination_approval_status = 'rejected',
                  elimination_approved_by     = $1,
                  elimination_approved_at     = NOW(),
                  elimination_notes           = COALESCE($2, elimination_notes),
                  updated_at                  = NOW()
            WHERE id = ANY($3) AND organization_id = $4`,
          [auth0_sub, approvalNotes ?? null, trayIds, organization_id],
        );
      }

      res.json({ ok: true, approved, affected: trayIds.length });
    } catch (err) {
      console.error('[POST /nursery/trays/:id/approve-elimination]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── POST /dashboard/nursery/trays/:id/counts ─────────────────────────────────
// Records a plant emergence count for a tray (nursery stage).
// Multiple counts per tray are allowed to track progress over time.
router.post('/nursery/trays/:id/counts', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = plantCountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { id }            = req.params;
  const { organization_id, auth0_sub } = req.user!;
  const { count_date, emerged_plants, photo_url, notes } = parsed.data;

  try {
    const { rows: trayRows } = await pool.query(
      `SELECT id, plant_capacity, status FROM nursery_trays
        WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!trayRows[0]) { res.status(404).json({ error: 'Tray not found' }); return; }

    const { plant_capacity } = trayRows[0];
    if (emerged_plants > plant_capacity) {
      res.status(400).json({
        error: `emerged_plants (${emerged_plants}) cannot exceed plant_capacity (${plant_capacity})`,
      });
      return;
    }

    const { rows } = await pool.query(
      `INSERT INTO nursery_plant_counts
         (tray_id, count_date, total_cells, emerged_plants, photo_url, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, count_date, total_cells, emerged_plants, germination_pct,
                 photo_url, count_method, created_at`,
      [id,
       count_date     ?? new Date().toISOString().slice(0, 10),
       plant_capacity,
       emerged_plants,
       photo_url      ?? null,
       notes          ?? null,
       auth0_sub],
    );
    res.status(201).json({ count: rows[0] });
  } catch (err) {
    console.error('[POST /nursery/trays/:id/counts]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/pending-eliminations ───────────────────────────────
// Returns all trays with pending elimination requests for the org.
// Used by producers to see the approval queue.
router.get('/nursery/pending-eliminations', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { organization_id } = req.user!;
  try {
    const { rows } = await pool.query(
      `SELECT
          t.id,
          t.tray_number,
          t.qr_code,
          t.elimination_reason,
          t.elimination_notes,
          t.eliminated_by,
          t.updated_at AS requested_at,
          b.id         AS batch_id,
          b.crop,
          b.hybrid_variety
        FROM nursery_trays t
        JOIN nursery_batches b ON b.id = t.batch_id
       WHERE t.organization_id = $1
         AND t.elimination_approval_status = 'pending'
       ORDER BY t.updated_at DESC`,
      [organization_id],
    );
    res.json({ pending: rows });
  } catch (err) {
    console.error('[GET /nursery/pending-eliminations]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /dashboard/nursery/trays/:id/transition ──────────────────────────────
// Transitions a single tray to the next status, independently of the batch.
// This breaks batch homogeneity: the parent batch is marked is_homogeneous = false
// so the UI knows it must track trays individually.
//
// Use this when one tray needs to advance ahead of or separately from the rest of
// the batch (e.g. a tray moved to nursery while others are still in germination).
router.post('/nursery/trays/:id/transition', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const parsed = trayTransitionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { id }                     = req.params;
  const { organization_id, auth0_sub } = req.user!;
  const { to_status, node_id, occurred_at, notes } = parsed.data;
  const ts = occurred_at ? new Date(occurred_at) : new Date();

  try {
    const { rows: trayRows } = await pool.query(
      `SELECT t.id, t.status, t.batch_id
         FROM nursery_trays t
        WHERE t.id = $1 AND t.organization_id = $2`,
      [id, organization_id],
    );
    if (!trayRows[0]) { res.status(404).json({ error: 'Tray not found' }); return; }

    const tray    = trayRows[0];
    const current = tray.status as string;

    if (tray.is_eliminated) {
      res.status(400).json({ error: 'Cannot transition an eliminated tray' });
      return;
    }

    const allowed = TRAY_VALID_TRANSITIONS[current] ?? [];
    if (!allowed.includes(to_status)) {
      res.status(400).json({
        error: `Cannot transition tray from '${current}' to '${to_status}'. Allowed: ${allowed.join(', ') || 'none'}`,
      });
      return;
    }

    // Stage-specific timestamp columns on the tray
    const stageTimestamps: Record<string, string> = {
      germination: `germination_entry_at = $3`,
      nursery:     `nursery_placed_at = $3`,
      delivered:   `delivered_at = $3`,
    };
    const extraSet = stageTimestamps[to_status] ?? '';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update the tray's status and stage timestamp
      await client.query(
        `UPDATE nursery_trays
            SET status          = $1,
                current_node_id = COALESCE($2, current_node_id),
                ${extraSet ? extraSet + ',' : ''}
                updated_at      = NOW()
          WHERE id = $${extraSet ? '4' : '3'} AND organization_id = $${extraSet ? '5' : '4'}`,
        extraSet
          ? [to_status, node_id ?? null, ts, id, organization_id]
          : [to_status, node_id ?? null, id, organization_id],
      );

      // Log the individual tray transition
      await client.query(
        `INSERT INTO nursery_tray_transitions
           (tray_id, batch_id, from_status, to_status, source, node_id, notes, created_by, occurred_at)
         VALUES ($1, $2, $3, $4, 'individual', $5, $6, $7, $8)`,
        [id, tray.batch_id, current, to_status, node_id ?? null, notes ?? null, auth0_sub, ts],
      );

      // Mark the parent batch as non-homogeneous because a tray diverged
      await client.query(
        `UPDATE nursery_batches
            SET is_homogeneous            = false,
                homogeneous_broken_at     = NOW(),
                homogeneous_broken_reason = 'individual_transition',
                updated_at                = NOW()
          WHERE id = $1 AND is_homogeneous = true`,
        [tray.batch_id],
      );

      await client.query('COMMIT');
      res.json({ ok: true, tray_id: id, from_status: current, to_status });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[POST /nursery/trays/:id/transition]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /dashboard/nursery/trays/:id/transitions ──────────────────────────────
// Returns the full status transition history for a tray, ordered chronologically.
router.get('/nursery/trays/:id/transitions', requireAuth, requireOrg, async (req: Request, res: Response): Promise<void> => {
  const { id }              = req.params;
  const { organization_id } = req.user!;

  try {
    // Verify tray belongs to this org
    const { rows: check } = await pool.query(
      `SELECT id FROM nursery_trays WHERE id = $1 AND organization_id = $2`,
      [id, organization_id],
    );
    if (!check[0]) { res.status(404).json({ error: 'Tray not found' }); return; }

    const { rows } = await pool.query(
      `SELECT tt.id, tt.from_status, tt.to_status, tt.source, tt.notes,
              tt.occurred_at, tt.created_by,
              d.device_id AS node_device_id
         FROM nursery_tray_transitions tt
         LEFT JOIN devices d ON d.id = tt.node_id
        WHERE tt.tray_id = $1
        ORDER BY tt.occurred_at ASC`,
      [id],
    );
    res.json({ transitions: rows });
  } catch (err) {
    console.error('[GET /nursery/trays/:id/transitions]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
