import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        auth0_sub: string;
        organization_id: string;
        role: string;
        site_ids: string[];
        scopes: string[];
      };
    }
  }
}
