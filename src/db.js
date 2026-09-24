import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(__dirname, '..');

/**
 * Where data lives. Resolved on every call so tests and the CLI can switch it via env.
 * - JOURNAL_DATA_DIR: folder holding journal.db + screenshots/ (default ~/.agent-trading-journal)
 * - JOURNAL_DB / JOURNAL_SCREENSHOTS: override either path individually
 * - JOURNAL_LOCALES_DIR: extra dashboard languages as <code>.json (default <data dir>/locales)
 */
export function paths() {
  const dataDir = process.env.JOURNAL_DATA_DIR || path.join(os.homedir(), '.agent-trading-journal');
  return {
    dataDir,
    db: process.env.JOURNAL_DB || path.join(dataDir, 'journal.db'),
    screenshots: process.env.JOURNAL_SCREENSHOTS || path.join(dataDir, 'screenshots'),
    locales: process.env.JOURNAL_LOCALES_DIR || path.join(dataDir, 'locales'),
  };
}

const MIGRATIONS = [
  // v1 — generic schema: the user's strategy (fields + rules) is data, not code.
  `
  CREATE TABLE profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE strategies (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    markets TEXT,
    timeframes TEXT,
    definition_json TEXT,            -- free-form plan: bias, setup, entry, stop, targets, management, no_trade
    version INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-strategy custom trade attributes (e.g. setup type, session, confirmation). Values live in trades.fields_json.
  CREATE TABLE strategy_fields (
    id INTEGER PRIMARY KEY,
    strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('enum','bool','number','text')),
    options_json TEXT,               -- enum only: [{"value":"pullback","label":"Pullback"}]
    guide TEXT,                      -- how the agent should read this from a chart
    required INTEGER NOT NULL DEFAULT 0,
    breakdown INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE (strategy_id, key)
  );

  -- Entry checklist. Each trade can record pass/fail/na per rule → adherence stats.
  CREATE TABLE strategy_rules (
    id INTEGER PRIMARY KEY,
    strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    guide TEXT,
    severity TEXT NOT NULL DEFAULT 'must' CHECK (severity IN ('must','should')),
    position INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE (strategy_id, key)
  );

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'personal' CHECK (type IN ('personal','prop','demo','other')),
    currency TEXT,
    starting_balance REAL,
    risk_per_trade_pct REAL,
    max_daily_loss_pct REAL,
    max_total_drawdown_pct REAL,
    profit_target_pct REAL,
    max_trades_per_day INTEGER,
    max_consecutive_losses INTEGER,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'backtest' CHECK (mode IN ('backtest','forward','live')),
    symbol TEXT NOT NULL,
    strategy_id INTEGER REFERENCES strategies(id),
    account_id INTEGER REFERENCES accounts(id),
    timeframes TEXT,
    data_from TEXT, data_to TEXT,
    tool_version TEXT,
    settings_json TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    trade_no INTEGER NOT NULL,
    strategy_id INTEGER REFERENCES strategies(id),
    strategy_version INTEGER,
    chart_time TEXT,
    closed_at TEXT,
    status TEXT NOT NULL DEFAULT 'taken' CHECK (status IN ('taken','skipped')),
    direction TEXT CHECK (direction IN ('buy','sell')),
    entry REAL, sl REAL, tp REAL, tp2 REAL, exit_price REAL, quantity REAL,
    rr_planned REAL,
    outcome TEXT CHECK (outcome IN ('win','loss','be')),
    result_r REAL,
    pnl REAL,
    mae_r REAL, mfe_r REAL,
    partial_taken INTEGER, moved_be INTEGER,
    exit_reason TEXT,
    skip_reason TEXT,
    skip_correct INTEGER,
    fields_json TEXT,
    mistakes TEXT,
    confidence INTEGER CHECK (confidence BETWEEN 1 AND 5),
    notes TEXT,
    tags TEXT,
    source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','import','manual')),
    external_key TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_id, trade_no)
  );

  CREATE TABLE trade_rule_checks (
    trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    rule_id INTEGER NOT NULL REFERENCES strategy_rules(id),
    result TEXT NOT NULL CHECK (result IN ('pass','fail','na')),
    note TEXT,
    PRIMARY KEY (trade_id, rule_id)
  );

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    caption TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE lessons (
    id INTEGER PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id),
    trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,
    strategy_id INTEGER REFERENCES strategies(id),
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX idx_trades_session ON trades(session_id);
  CREATE INDEX idx_trades_strategy ON trades(strategy_id);
  CREATE INDEX idx_attachments_trade ON attachments(trade_id);
  CREATE INDEX idx_lessons_trade ON lessons(trade_id);
  CREATE INDEX idx_rule_checks_rule ON trade_rule_checks(rule_id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(file = paths().db) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function openDbReadonly(file = paths().db) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('query_only = ON');
  return db;
}
