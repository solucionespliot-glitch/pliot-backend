import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db';

export function requireApiKeyScope(scope: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers['x-api-key'] as string | undefined;

    if (!header || !header.includes(':')) {
      res.status(401).json({ error: 'Missing or malformed X-API-Key header (expected key_id:raw_key)' });
      return;
    }

    const colonIdx = header.indexOf(':');
    const keyId    = header.slice(0, colonIdx);
    const rawKey   = header.slice(colonIdx + 1);

    const { rows } = await pool.query(
      `SELECT key_hash, scopes, enabled, expires_at
         FROM api_keys
        WHERE key_id = $1`,
      [keyId],
    );

    const apiKey = rows[0];

    if (
      !apiKey ||
      !apiKey.enabled ||
      (apiKey.expires_at && new Date(apiKey.expires_at) < new Date())
    ) {
      res.status(401).json({ error: 'Invalid or expired API key' });
      return;
    }

    const valid = await bcrypt.compare(rawKey, apiKey.key_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    const scopes: string[] = Array.isArray(apiKey.scopes) ? apiKey.scopes : [];
    if (!scopes.includes(scope)) {
      res.status(403).json({ error: `API key does not have '${scope}' scope` });
      return;
    }

    pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_id = $1', [keyId]).catch(() => {});

    next();
  };
}
