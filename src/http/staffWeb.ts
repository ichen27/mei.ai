import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type Router } from 'express';

/**
 * Serves the built staff dashboard from the API server, so one process and one
 * address carry both. Returns null when the dashboard has not been built.
 *
 * The page at /staff is the authenticated staff workspace. The site root
 * redirects there, because the root of the same build is the public demo,
 * which needs the separate demo server.
 */
export function createStaffWebRouter(dir: string): Router | null {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) return null;

  const router = express.Router();
  router.get('/', (_req, res) => res.redirect(302, '/staff'));
  router.use(express.static(root, { index: false }));
  router.get(['/staff', '/staff/*'], (_req, res) => res.sendFile(index));
  return router;
}
