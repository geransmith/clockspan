import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { loadSettings, mergeSettings } from '../settings.js';
import { DEFAULT_SETTINGS } from '../../shared/settings.js';

export function settingsRouter(db: DB): Router {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(loadSettings(db, currentUser(req).id));
  });

  r.put('/', (req, res) => {
    const user = currentUser(req);
    const next = mergeSettings(loadSettings(db, user.id), req.body);
    db.prepare(
      `INSERT INTO settings (user_id, json) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET json = excluded.json`,
    ).run(user.id, JSON.stringify(next));
    res.json(next);
  });

  // With no row, a read serves DEFAULT_SETTINGS, so dropping the row is the reset. The
  // response is what the next GET will serve.
  r.delete('/', (req, res) => {
    db.prepare(`DELETE FROM settings WHERE user_id = ?`).run(currentUser(req).id);
    res.json(DEFAULT_SETTINGS);
  });

  return r;
}
