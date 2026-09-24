import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, paths, APP_DIR } from './db.js';
import * as J from './journal.js';
import { getStats } from './stats.js';
import { checkRisk } from './risk.js';

export const WEB_PORT = Number(process.env.JOURNAL_PORT || 3777);
const INDEX_HTML = path.join(APP_DIR, 'public', 'index.html');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// JSON can't carry Infinity (profit factor with no losses) — send it as a string the client understands.
const send = (c, data, status = 200) => c.body(JSON.stringify(data, (k, v) => v === Infinity ? 'Infinity' : v), status,
  { 'Content-Type': 'application/json; charset=utf-8' });

function filtersFrom(q) {
  const f = {};
  for (const k of ['symbol', 'mode', 'account', 'strategy', 'from', 'to', 'tag']) if (q[k]) f[k] = q[k];
  if (q.session_id) f.session_id = Number(q.session_id);
  return f;
}

function buildApp() {
  const db = openDb();
  const app = new Hono();
  app.onError((e, c) => send(c, { error: e.message }, e instanceof J.JournalError ? 400 : 500));

  app.get('/', (c) => c.html(fs.readFileSync(INDEX_HTML, 'utf8')));
  app.get('/api/meta', (c) => send(c, {
    profile: J.getProfile(db),
    strategies: J.listStrategies(db).map(s => ({ ...J.getStrategy(db, s.id, { includeArchived: true }), trades: s.trades })),
    accounts: J.listAccounts(db),
    sessions: J.listSessions(db),
  }));
  app.get('/api/stats', (c) => send(c, getStats(db, filtersFrom(c.req.query()))));
  app.get('/api/trades', (c) => send(c, J.queryTrades(db, { ...filtersFrom(c.req.query()), limit: 500 })));
  app.get('/api/trades/:id', (c) => send(c, J.getTrade(db, Number(c.req.param('id')))));
  app.get('/api/lessons', (c) => send(c, J.listLessons(db, filtersFrom(c.req.query()))));
  app.get('/api/locales', (c) => send(c, loadLocales()));
  app.get('/api/risk', (c) => send(c, checkRisk(db, c.req.query('account'), c.req.query('date') || undefined)));
  app.get('/screenshots/:file', (c) => {
    const file = path.basename(c.req.param('file'));
    const full = path.join(paths().screenshots, file);
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type || !fs.existsSync(full)) return c.text('not found', 404);
    return c.body(fs.readFileSync(full), 200, { 'Content-Type': type });
  });
  return app;
}

/** Extra UI languages: every <code>.json in the locales dir (English is built into the page). Bad files are skipped. */
function loadLocales() {
  const dir = paths().locales, out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const code = path.basename(f, '.json');
    if (!f.endsWith('.json') || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(code) || code === 'en') continue;
    try {
      const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (dict && typeof dict === 'object' && !Array.isArray(dict)) out[code] = dict;
    } catch { /* ignore malformed locale */ }
  }
  return out;
}

let running = null;

export const webUrl = () => `http://localhost:${WEB_PORT}`;
export const isWebRunning = () => running !== null;

/** Start the dashboard. Resolves {ok, url, already?, reason?} — never throws. */
export function startWeb() {
  if (running) return Promise.resolve({ ok: true, url: webUrl(), already: true });
  return new Promise((resolve) => {
    const srv = serve({ fetch: buildApp().fetch, port: WEB_PORT, hostname: '127.0.0.1' }, () => {
      running = srv;
      resolve({ ok: true, url: webUrl() });
    });
    srv.on('error', (e) => {
      running = null;
      resolve({
        ok: false,
        reason: e.code === 'EADDRINUSE'
          ? `port ${WEB_PORT} is busy — the dashboard may already be running (try ${webUrl()}), or set JOURNAL_PORT`
          : `${e.code}: ${e.message}`,
      });
    });
  });
}

export function stopWeb() {
  return new Promise((resolve) => {
    if (!running) return resolve({ ok: false, reason: 'dashboard is not running in this process' });
    running.close(() => { running = null; resolve({ ok: true }); });
  });
}
