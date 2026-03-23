import { Router, Request, Response } from 'express';
import { requireAuth, requireOrg } from '../../middleware/auth';

const router = Router();

// GET /dashboard/settings/notifications
router.get('/notifications', requireAuth, requireOrg, (_req: Request, res: Response) => {
  try {
    res.json({ contacts: [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /dashboard/settings/notifications
router.post('/notifications', requireAuth, requireOrg, (req: Request, res: Response) => {
  try {
    res.json({ ok: true, contact: req.body });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/settings/devices/quota — must come before /devices to avoid route conflict
router.get('/devices/quota', requireAuth, requireOrg, (_req: Request, res: Response) => {
  try {
    res.json({ used: 0, limit: 10 });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /dashboard/settings/devices
router.get('/devices', requireAuth, requireOrg, (_req: Request, res: Response) => {
  try {
    res.json({ devices: [] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /dashboard/settings/devices
router.post('/devices', requireAuth, requireOrg, (_req: Request, res: Response) => {
  try {
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
