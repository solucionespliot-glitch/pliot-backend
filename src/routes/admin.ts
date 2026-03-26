import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireOrg, requireRole } from '../middleware/auth';
import { pool } from '../db';

const router = Router();

// GET /dashboard/admin/security-alerts
router.get('/security-alerts', requireAuth, requireOrg, (_req: Request, res: Response) => {
  try {
    res.json({ alerts: [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/admin/organizations
router.get('/organizations', requireAuth, requireOrg, requireRole(['superuser']), async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE enabled = true ORDER BY name`,
    );
    res.json({ organizations: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

const ImpersonateSchema = z.object({
  organization_id: z.string().uuid(),
});

// POST /dashboard/admin/impersonate — superuser only
// Instructs the frontend which organization_id to pass in X-Impersonate-Org
router.post(
  '/impersonate',
  requireAuth,
  requireOrg,
  requireRole(['superuser']),
  (req: Request, res: Response) => {
    const parsed = ImpersonateSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    res.json({
      ok:              true,
      organization_id: parsed.data.organization_id,
      note:            'Pass this organization_id in the X-Impersonate-Org header on subsequent requests to act on behalf of that organization.',
    });
  },
);

export default router;
