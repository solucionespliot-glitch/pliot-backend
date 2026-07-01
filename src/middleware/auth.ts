import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { pool } from '../db';

// Roles in ascending privilege order
const ROLE_HIERARCHY = ['operator', 'advisor', 'producer', 'distributor', 'superuser'];

const jwksClient = jwksRsa({
  jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
  cache: true,
  rateLimit: true,
});

function getSigningKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key?.getPublicKey());
  });
}

// ─── requireAuth ─────────────────────────────────────────────────────────────
// Validates Auth0 JWT, looks up user_roles, attaches req.user

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
      jwt.verify(
        token,
        getSigningKey,
        {
          audience: process.env.AUTH0_AUDIENCE,
          issuer:   `https://${process.env.AUTH0_DOMAIN}/`,
          algorithms: ['RS256'],
        },
        (err, payload) => {
          if (err) return reject(err);
          resolve(payload as jwt.JwtPayload);
        },
      );
    });

    const auth0Sub = decoded.sub!;

    const { rows } = await pool.query(
      `SELECT organization_id, role, site_ids, scopes, enabled
         FROM user_roles
        WHERE auth0_sub = $1`,
      [auth0Sub],
    );

    const userRow = rows[0];

    if (!userRow || !userRow.enabled) {
      res.status(403).json({ error: 'User not found or disabled' });
      return;
    }

    req.user = {
      auth0_sub:       auth0Sub,
      organization_id: userRow.organization_id,
      role:            userRow.role,
      site_ids:        userRow.site_ids  ?? [],
      scopes:          userRow.scopes    ?? [],
    };

    next();
  } catch (err) {
    console.error('[requireAuth] JWT verification failed:', err);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── requireOrg ──────────────────────────────────────────────────────────────
// Enforces organization-level tenancy.
// Superusers may impersonate another org via X-Impersonate-Org header.

export function requireOrg(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.user.role === 'superuser') {
    const impersonateOrg = req.headers['x-impersonate-org'] as string | undefined;
    if (impersonateOrg) {
      req.user.organization_id = impersonateOrg;
    }
  }

  next();
}

// ─── requireFeature ──────────────────────────────────────────────────────────
// Gates a route behind an org-level feature flag stored in organizations.features.
// Superusers always bypass this check.

export function requireFeature(feature: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Superusers see everything
    if (req.user.role === 'superuser') { next(); return; }

    if (!req.user.organization_id) {
      res.status(403).json({ error: 'Feature not available' });
      return;
    }

    try {
      const { rows } = await pool.query(
        'SELECT features FROM organizations WHERE id = $1',
        [req.user.organization_id],
      );

      if (!rows[0] || !rows[0].features[feature]) {
        res.status(403).json({ error: 'Feature not available for your plan' });
        return;
      }

      next();
    } catch (err) {
      console.error('[requireFeature] DB error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ─── requireRole ─────────────────────────────────────────────────────────────
// Accepts an array of allowed roles. 403 if user role is not in the list.

export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: `Insufficient role. Required one of: ${allowedRoles.join(', ')}`,
      });
      return;
    }

    next();
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function roleRank(role: string): number {
  return ROLE_HIERARCHY.indexOf(role);
}
