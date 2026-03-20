import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db';
import { requireApiKeyScope } from '../middleware/apiKeyAuth';

const router = Router();

const requireCommandScope = requireApiKeyScope('command');

// GET /api/v1.5/controllers/:id/commands
// Returns all PENDING commands for the controller identified by device_id
router.get('/:id/commands', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { rows: controllerRows } = await pool.query(
    `SELECT c.id
       FROM controllers c
       JOIN devices d ON d.id = c.device_id
      WHERE d.device_id = $1`,
    [id],
  );

  if (!controllerRows[0]) {
    res.status(404).json({ error: 'Controller not found' });
    return;
  }

  const controllerId = controllerRows[0].id;

  const { rows } = await pool.query(
    `SELECT id, cmd_id, command_type, payload, state, attempts, issued_at, expires_at
       FROM commands
      WHERE target_controller_id = $1
        AND state = 'PENDING'
      ORDER BY issued_at ASC`,
    [controllerId],
  );

  res.json({ commands: rows });
});

// POST /api/v1.5/controllers/:id/commands/:cmd_id/ack
// Controller confirms command execution
const AckSchema = z.object({
  state: z.enum(['APPLIED', 'FAILED']),
  error: z.string().optional(),
});

router.post('/:id/commands/:cmd_id/ack', requireCommandScope, async (req: Request, res: Response): Promise<void> => {
  const { cmd_id } = req.params;

  const parsed = AckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { state, error } = parsed.data;

  const result = await pool.query(
    `UPDATE commands
        SET state      = $1,
            applied_at = CASE WHEN $1 = 'APPLIED' THEN NOW() ELSE applied_at END,
            last_error = $2,
            updated_at = NOW()
      WHERE cmd_id = $3
      RETURNING id`,
    [state, error ?? null, cmd_id],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: 'Command not found' });
    return;
  }

  res.json({ ok: true });
});

export default router;
