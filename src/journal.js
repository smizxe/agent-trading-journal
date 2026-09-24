// Domain layer: every write goes through here (MCP tools, importer, demo seeder, tests).
// Functions throw JournalError with an agent-readable message on bad input.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './db.js';

export class JournalError extends Error {}
const fail = (msg) => { throw new JournalError(msg); };

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (s, fallback = null) => { if (!s) return fallback; try { return JSON.parse(s); } catch { return fallback; } };
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const TRADE_DATE = `COALESCE(substr(t.chart_time, 1, 10), s.date)`;

// ---------------------------------------------------------------- profile

export function getProfile(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM profile ORDER BY key').all().map(r => [r.key, parse(r.value, r.value)]));
}

export function setProfile(db, entries) {
  const up = db.prepare(`INSERT INTO profile (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM profile WHERE key = ?');
  db.transaction(() => {
    for (const [k, v] of Object.entries(entries)) {
      if (v === null) del.run(k); else up.run(k, JSON.stringify(v));
    }
  })();
  return getProfile(db);
}

// ---------------------------------------------------------------- strategies

function normalizeOptions(options) {
  if (!options) return null;
  return options.map(o => typeof o === 'string' ? { value: o, label: o } : { value: String(o.value), label: o.label ?? String(o.value) });
}

function normalizeField(f, i) {
  const key = f.key ? slugify(f.key).replace(/-/g, '_') : fail(`field #${i + 1} needs a key`);
  if (!['enum', 'bool', 'number', 'text'].includes(f.type)) fail(`field "${key}": type must be enum | bool | number | text`);
  const options = normalizeOptions(f.options);
  if (f.type === 'enum' && !options?.length) fail(`field "${key}": enum fields need options`);
  return {
    key, label: f.label || key, type: f.type, options: f.type === 'enum' ? options : null,
    guide: f.guide ?? null, required: f.required ? 1 : 0, breakdown: f.breakdown === false ? 0 : 1, position: i,
  };
}

function normalizeRule(r, i) {
  const text = r.text || fail(`rule #${i + 1} needs text`);
  const key = slugify(r.key || text).replace(/-/g, '_').slice(0, 40);
  return { key, text, guide: r.guide ?? null, severity: r.severity === 'should' ? 'should' : 'must', position: i };
}

export function resolveStrategy(db, ref, { required = true } = {}) {
  if (ref === undefined || ref === null || ref === '') return required ? fail('strategy is required') : null;
  const row = typeof ref === 'number'
    ? db.prepare('SELECT * FROM strategies WHERE id = ?').get(ref)
    : db.prepare('SELECT * FROM strategies WHERE slug = ? OR lower(name) = lower(?)').get(String(ref), String(ref));
  if (!row) {
    const known = db.prepare('SELECT slug FROM strategies').all().map(r => r.slug);
    fail(`strategy "${ref}" not found. Known: ${known.join(', ') || '(none — run onboarding or import a preset)'}`);
  }
  return row;
}

/** Create or update a strategy from a portable definition (same shape as presets/*.json). */
export function upsertStrategy(db, def) {
  const name = def.name || fail('strategy needs a name');
  const slug = slugify(def.slug || name);
  const fields = (def.fields ?? []).map(normalizeField);
  const rules = (def.rules ?? []).map(normalizeRule);
  for (const list of [fields, rules]) {
    const seen = new Set();
    for (const x of list) { if (seen.has(x.key)) fail(`duplicate key "${x.key}"`); seen.add(x.key); }
  }
  const plan = def.plan ?? null;

  return db.transaction(() => {
    let st = db.prepare('SELECT * FROM strategies WHERE slug = ?').get(slug);
    let changed = false;
    if (!st) {
      const info = db.prepare(`INSERT INTO strategies (slug, name, description, markets, timeframes, definition_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(slug, name, def.description ?? null, def.markets ?? null, def.timeframes ?? null, json(plan));
      st = { id: Number(info.lastInsertRowid), version: 1 };
    } else {
      const before = exportStrategy(db, st.id);
      db.prepare(`UPDATE strategies SET name = ?, description = ?, markets = ?, timeframes = ?, definition_json = ?, active = 1,
        updated_at = datetime('now') WHERE id = ?`)
        .run(name, def.description ?? null, def.markets ?? null, def.timeframes ?? null, json(plan), st.id);
      changed = true; // version bump decided below by comparing fields/rules
      st.before = before;
    }

    const upField = db.prepare(`INSERT INTO strategy_fields (strategy_id, key, label, type, options_json, guide, required, breakdown, position, archived)
      VALUES (@strategy_id, @key, @label, @type, @options_json, @guide, @required, @breakdown, @position, 0)
      ON CONFLICT(strategy_id, key) DO UPDATE SET label = excluded.label, type = excluded.type, options_json = excluded.options_json,
        guide = excluded.guide, required = excluded.required, breakdown = excluded.breakdown, position = excluded.position, archived = 0`);
    for (const f of fields) upField.run({ ...f, options_json: json(f.options), strategy_id: st.id });
    const keepF = fields.map(f => f.key);
    db.prepare(`UPDATE strategy_fields SET archived = 1 WHERE strategy_id = ? AND key NOT IN (${keepF.map(() => '?').join(',') || "''"})`).run(st.id, ...keepF);

    const upRule = db.prepare(`INSERT INTO strategy_rules (strategy_id, key, text, guide, severity, position, archived)
      VALUES (@strategy_id, @key, @text, @guide, @severity, @position, 0)
      ON CONFLICT(strategy_id, key) DO UPDATE SET text = excluded.text, guide = excluded.guide, severity = excluded.severity,
        position = excluded.position, archived = 0`);
    for (const r of rules) upRule.run({ ...r, strategy_id: st.id });
    const keepR = rules.map(r => r.key);
    db.prepare(`UPDATE strategy_rules SET archived = 1 WHERE strategy_id = ? AND key NOT IN (${keepR.map(() => '?').join(',') || "''"})`).run(st.id, ...keepR);

    // Version bumps only when the measurable definition (fields/rules) changed — trades keep the version they were logged under.
    if (changed) {
      const after = exportStrategy(db, st.id);
      const sig = (d) => JSON.stringify({ f: d.fields, r: d.rules });
      if (sig(after) !== sig(st.before)) db.prepare('UPDATE strategies SET version = version + 1 WHERE id = ?').run(st.id);
    }
    return getStrategy(db, st.id);
  })();
}

export function getStrategy(db, ref, { includeArchived = false } = {}) {
  const st = resolveStrategy(db, ref);
  const arch = includeArchived ? '' : 'AND archived = 0';
  const fields = db.prepare(`SELECT * FROM strategy_fields WHERE strategy_id = ? ${arch} ORDER BY archived, position`).all(st.id)
    .map(f => ({ key: f.key, label: f.label, type: f.type, options: parse(f.options_json), guide: f.guide,
      required: !!f.required, breakdown: !!f.breakdown, ...(f.archived ? { archived: true } : {}) }));
  const rules = db.prepare(`SELECT * FROM strategy_rules WHERE strategy_id = ? ${arch} ORDER BY archived, position`).all(st.id)
    .map(r => ({ key: r.key, text: r.text, guide: r.guide, severity: r.severity, ...(r.archived ? { archived: true } : {}) }));
  return {
    id: st.id, slug: st.slug, name: st.name, description: st.description, markets: st.markets, timeframes: st.timeframes,
    plan: parse(st.definition_json), version: st.version, active: !!st.active, fields, rules,
  };
}

/** Portable JSON (no ids) — shareable, and the same format presets use. */
export function exportStrategy(db, ref) {
  const { id, version, active, ...def } = getStrategy(db, ref);
  return def;
}

export function listStrategies(db) {
  return db.prepare(`
    SELECT st.id, st.slug, st.name, st.description, st.version, st.active,
      (SELECT COUNT(*) FROM trades t WHERE t.strategy_id = st.id) AS trades,
      (SELECT COUNT(*) FROM strategy_fields f WHERE f.strategy_id = st.id AND f.archived = 0) AS fields,
      (SELECT COUNT(*) FROM strategy_rules r WHERE r.strategy_id = st.id AND r.archived = 0) AS rules
    FROM strategies st ORDER BY st.active DESC, st.name`).all();
}

// ---------------------------------------------------------------- accounts

const ACCOUNT_COLS = ['type', 'currency', 'starting_balance', 'risk_per_trade_pct', 'max_daily_loss_pct',
  'max_total_drawdown_pct', 'profit_target_pct', 'max_trades_per_day', 'max_consecutive_losses', 'notes'];

export function upsertAccount(db, a) {
  const name = a.name || fail('account needs a name');
  const existing = db.prepare('SELECT * FROM accounts WHERE name = ?').get(name);
  if (!existing) {
    const row = Object.fromEntries(ACCOUNT_COLS.map(c => [c, a[c] ?? null]));
    row.type ??= 'personal';
    db.prepare(`INSERT INTO accounts (name, ${ACCOUNT_COLS.join(', ')}) VALUES (@name, ${ACCOUNT_COLS.map(c => '@' + c).join(', ')})`)
      .run({ ...row, name });
  } else {
    const cols = ACCOUNT_COLS.filter(c => a[c] !== undefined);
    if (cols.length) db.prepare(`UPDATE accounts SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...Object.fromEntries(cols.map(c => [c, a[c]])), id: existing.id });
  }
  return db.prepare('SELECT * FROM accounts WHERE name = ?').get(name);
}

export function resolveAccount(db, name, { create = false } = {}) {
  if (!name) return null;
  const row = db.prepare('SELECT * FROM accounts WHERE name = ?').get(name);
  if (row) return row;
  if (create) return upsertAccount(db, { name });
  const known = db.prepare('SELECT name FROM accounts').all().map(r => r.name);
  fail(`account "${name}" not found. Known: ${known.join(', ') || '(none)'}`);
}

export const listAccounts = (db) => db.prepare('SELECT * FROM accounts ORDER BY name').all();

// ---------------------------------------------------------------- sessions

export function startSession(db, a) {
  const strategy = a.strategy ? resolveStrategy(db, a.strategy) : null;
  const account = a.account ? resolveAccount(db, a.account, { create: true }) : null;
  const info = db.prepare(`INSERT INTO sessions (date, mode, symbol, strategy_id, account_id, timeframes, data_from, data_to, tool_version, settings_json, notes)
    VALUES (@date, @mode, @symbol, @strategy_id, @account_id, @timeframes, @data_from, @data_to, @tool_version, @settings_json, @notes)`).run({
    date: a.date || new Date().toISOString().slice(0, 10), mode: a.mode || 'backtest', symbol: a.symbol || fail('symbol is required'),
    strategy_id: strategy?.id ?? null, account_id: account?.id ?? null, timeframes: a.timeframes ?? null,
    data_from: a.data_from ?? null, data_to: a.data_to ?? null, tool_version: a.tool_version ?? null,
    settings_json: a.settings_json ?? null, notes: a.notes ?? null,
  });
  return { session_id: Number(info.lastInsertRowid), strategy: strategy?.slug ?? null, account: account?.name ?? null };
}

export function listSessions(db, f = {}) {
  const conds = [], p = {};
  if (f.mode) { conds.push('s.mode = @mode'); p.mode = f.mode; }
  if (f.strategy) { conds.push('s.strategy_id = @sid'); p.sid = resolveStrategy(db, f.strategy).id; }
  if (f.account) { conds.push('a.name = @account'); p.account = f.account; }
  return db.prepare(`
    SELECT s.*, st.slug AS strategy, st.name AS strategy_name, a.name AS account,
      COUNT(t.id) AS trades,
      SUM(CASE WHEN t.status = 'taken' AND t.outcome IS NOT NULL THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN t.outcome = 'win' THEN 1 ELSE 0 END) AS wins,
      ROUND(COALESCE(SUM(CASE WHEN t.status = 'taken' THEN t.result_r END), 0), 2) AS total_r
    FROM sessions s
    LEFT JOIN strategies st ON st.id = s.strategy_id
    LEFT JOIN accounts a ON a.id = s.account_id
    LEFT JOIN trades t ON t.session_id = s.id
    ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
    GROUP BY s.id ORDER BY s.date DESC, s.id DESC`).all(p);
}

// ---------------------------------------------------------------- trades

export const CORE_TRADE_COLS = ['chart_time', 'closed_at', 'status', 'direction', 'entry', 'sl', 'tp', 'tp2', 'exit_price', 'quantity',
  'rr_planned', 'outcome', 'result_r', 'pnl', 'mae_r', 'mfe_r', 'partial_taken', 'moved_be', 'exit_reason', 'skip_reason',
  'skip_correct', 'mistakes', 'confidence', 'notes', 'tags'];
const BOOL_COLS = new Set(['partial_taken', 'moved_be', 'skip_correct']);

function strategyMeta(db, strategyId) {
  if (!strategyId) return null;
  const s = getStrategy(db, strategyId, { includeArchived: true });
  return { ...s, fieldMap: new Map(s.fields.map(f => [f.key, f])), ruleMap: new Map(s.rules.map(r => [r.key, r])) };
}

/** Validate + coerce custom field values against the strategy definition. */
export function validateFields(meta, values) {
  const out = {}, warnings = [];
  if (!values || !Object.keys(values).length) return { out, warnings };
  if (!meta) fail('custom fields need a strategy — set one on the session or pass strategy');
  for (const [rawKey, v] of Object.entries(values)) {
    const f = meta.fieldMap.get(rawKey);
    if (!f) fail(`unknown field "${rawKey}" for strategy "${meta.slug}". Fields: ${meta.fields.filter(x => !x.archived).map(x => x.key).join(', ')}`);
    if (f.archived) warnings.push(`field "${f.key}" is archived in the current strategy version`);
    if (v === null || v === undefined || v === '') { out[f.key] = null; continue; }
    if (f.type === 'enum') {
      const s = String(v).toLowerCase();
      const opt = f.options.find(o => o.value.toLowerCase() === s) || f.options.find(o => o.label.toLowerCase() === s);
      if (!opt) fail(`field "${f.key}": "${v}" is not an option. Options: ${f.options.map(o => `${o.value} (${o.label})`).join(', ')}`);
      out[f.key] = opt.value;
    } else if (f.type === 'bool') {
      const s = String(v).toLowerCase();
      if (['true', '1', 'yes', 'y', 'có', 'co'].includes(s)) out[f.key] = true;
      else if (['false', '0', 'no', 'n', 'không', 'khong'].includes(s)) out[f.key] = false;
      else fail(`field "${f.key}" expects true/false, got "${v}"`);
    } else if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) fail(`field "${f.key}" expects a number, got "${v}"`);
      out[f.key] = n;
    } else out[f.key] = String(v);
  }
  return { out, warnings };
}

function normalizeRuleChecks(meta, rules) {
  if (!rules || !Object.keys(rules).length) return [];
  if (!meta) fail('rule checks need a strategy');
  return Object.entries(rules).map(([key, v]) => {
    const rule = meta.ruleMap.get(key);
    if (!rule) fail(`unknown rule "${key}" for strategy "${meta.slug}". Rules: ${meta.rules.filter(r => !r.archived).map(r => r.key).join(', ')}`);
    const result = typeof v === 'string' ? v : v?.result;
    if (!['pass', 'fail', 'na'].includes(result)) fail(`rule "${key}": result must be pass | fail | na`);
    return { key, result, note: typeof v === 'object' ? v.note ?? null : null };
  });
}

function writeRuleChecks(db, tradeId, strategyId, checks) {
  const up = db.prepare(`INSERT INTO trade_rule_checks (trade_id, rule_id, result, note)
    VALUES (?, (SELECT id FROM strategy_rules WHERE strategy_id = ? AND key = ?), ?, ?)
    ON CONFLICT(trade_id, rule_id) DO UPDATE SET result = excluded.result, note = excluded.note`);
  for (const c of checks) up.run(tradeId, strategyId, c.key, c.result, c.note);
}

/** Fill in what can be derived: planned RR, R from exit price, outcome from R. */
function derive(t) {
  const risk = t.entry != null && t.sl != null ? Math.abs(t.entry - t.sl) : null;
  if (t.rr_planned == null && risk && t.tp != null) t.rr_planned = round2(Math.abs(t.tp - t.entry) / risk);
  if (t.result_r == null && risk && t.exit_price != null && t.direction) {
    t.result_r = round2((t.direction === 'buy' ? t.exit_price - t.entry : t.entry - t.exit_price) / risk);
  }
  if (t.outcome == null && t.status === 'taken' && t.result_r != null) t.outcome = t.result_r > 0 ? 'win' : t.result_r < 0 ? 'loss' : 'be';
  return t;
}

function toRow(a) {
  const row = {};
  for (const c of CORE_TRADE_COLS) {
    let v = a[c];
    if (v === undefined) continue;
    if (BOOL_COLS.has(c) && typeof v === 'boolean') v = v ? 1 : 0;
    row[c] = v;
  }
  return row;
}

export function logTrade(db, a) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(a.session_id) || fail(`session_id ${a.session_id} does not exist`);
  const status = a.status ?? 'taken';
  if (status === 'skipped' && !a.skip_reason) fail('status=skipped requires skip_reason');
  if (status === 'taken' && !a.direction) fail('status=taken requires direction');
  const strategyId = a.strategy ? resolveStrategy(db, a.strategy).id : session.strategy_id;
  const meta = strategyMeta(db, strategyId);
  const { out: fields, warnings } = validateFields(meta, a.fields);
  const checks = normalizeRuleChecks(meta, a.rules);
  if (meta && status === 'taken') {
    const missing = meta.fields.filter(f => f.required && !f.archived && fields[f.key] == null).map(f => f.key);
    if (missing.length) warnings.push(`required fields not set: ${missing.join(', ')}`);
  }
  const row = derive({ ...Object.fromEntries(CORE_TRADE_COLS.map(c => [c, null])), ...toRow(a), status });

  return db.transaction(() => {
    const trade_no = db.prepare('SELECT COALESCE(MAX(trade_no), 0) + 1 AS n FROM trades WHERE session_id = ?').get(session.id).n;
    const info = db.prepare(`INSERT INTO trades (session_id, trade_no, strategy_id, strategy_version, fields_json, source, external_key, ${CORE_TRADE_COLS.join(', ')})
      VALUES (@session_id, @trade_no, @strategy_id, @strategy_version, @fields_json, @source, @external_key, ${CORE_TRADE_COLS.map(c => '@' + c).join(', ')})`)
      .run({ ...row, session_id: session.id, trade_no, strategy_id: strategyId ?? null, strategy_version: meta?.version ?? null,
        fields_json: Object.keys(fields).length ? JSON.stringify(dropNulls(fields)) : null,
        source: a.source ?? 'agent', external_key: a.external_key ?? null });
    const trade_id = Number(info.lastInsertRowid);
    writeRuleChecks(db, trade_id, strategyId, checks);
    return { trade_id, trade_no, rr_planned: row.rr_planned, result_r: row.result_r, outcome: row.outcome, ...(warnings.length ? { warnings } : {}) };
  })();
}

export function updateTrade(db, a) {
  const cur = db.prepare('SELECT * FROM trades WHERE id = ?').get(a.trade_id) || fail(`trade_id ${a.trade_id} does not exist`);
  const strategyId = a.strategy ? resolveStrategy(db, a.strategy).id : cur.strategy_id;
  const meta = strategyMeta(db, strategyId);
  const { out: fields, warnings } = validateFields(meta, a.fields);
  const checks = normalizeRuleChecks(meta, a.rules);
  const patch = toRow(a);
  const merged = derive({ ...cur, ...patch });
  for (const c of ['rr_planned', 'result_r', 'outcome']) if (merged[c] !== cur[c] && patch[c] === undefined) patch[c] = merged[c];
  const cols = Object.keys(patch);
  if (!cols.length && !Object.keys(fields).length && !checks.length && !a.strategy) fail('no fields to update');

  db.transaction(() => {
    if (cols.length) db.prepare(`UPDATE trades SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...patch, id: cur.id });
    if (Object.keys(fields).length) {
      const next = dropNulls({ ...parse(cur.fields_json, {}), ...fields });
      db.prepare('UPDATE trades SET fields_json = ? WHERE id = ?').run(Object.keys(next).length ? JSON.stringify(next) : null, cur.id);
    }
    if (a.strategy) db.prepare('UPDATE trades SET strategy_id = ?, strategy_version = ? WHERE id = ?').run(strategyId, meta.version, cur.id);
    writeRuleChecks(db, cur.id, strategyId, checks);
  })();
  return { updated: cur.id, fields: [...cols, ...Object.keys(fields).map(k => 'fields.' + k), ...checks.map(c => 'rules.' + c.key)],
    ...(warnings.length ? { warnings } : {}) };
}

/** Shared WHERE builder for trades joined with sessions (alias t, s, a). Used by queries and stats. */
export function tradeFilter(db, f = {}) {
  const conds = [], p = {};
  if (f.session_id) { conds.push('t.session_id = @session_id'); p.session_id = f.session_id; }
  if (f.symbol) { conds.push('s.symbol = @symbol'); p.symbol = f.symbol; }
  if (f.mode) { conds.push('s.mode = @mode'); p.mode = f.mode; }
  if (f.account) { conds.push('a.name = @account'); p.account = f.account; }
  if (f.strategy) { conds.push('t.strategy_id = @strategy_id'); p.strategy_id = resolveStrategy(db, f.strategy).id; }
  if (f.status) { conds.push('t.status = @status'); p.status = f.status; }
  if (f.outcome) { conds.push('t.outcome = @outcome'); p.outcome = f.outcome; }
  if (f.from) { conds.push(`${TRADE_DATE} >= @from`); p.from = f.from; }
  if (f.to) { conds.push(`${TRADE_DATE} <= @to`); p.to = f.to; }
  if (f.tag) { conds.push(`(',' || replace(t.tags, ' ', '') || ',') LIKE @tag`); p.tag = `%,${String(f.tag).replace(/\s/g, '')},%`; }
  for (const [i, [k, v]] of Object.entries(Object.entries(f.fields ?? {}))) {
    if (!/^[a-z0-9_]+$/.test(k)) fail(`bad field key "${k}"`);
    conds.push(`json_extract(t.fields_json, '$.${k}') = @fv${i}`);
    p['fv' + i] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params: p };
}

export const TRADE_SELECT = `
  SELECT t.*, s.symbol, s.date AS session_date, s.mode, ${TRADE_DATE} AS trade_date,
    st.slug AS strategy, st.name AS strategy_name, a.name AS account,
    (SELECT COUNT(*) FROM attachments x WHERE x.trade_id = t.id) AS screenshot_count
  FROM trades t
  JOIN sessions s ON s.id = t.session_id
  LEFT JOIN strategies st ON st.id = t.strategy_id
  LEFT JOIN accounts a ON a.id = s.account_id`;

export function hydrate(row) {
  if (!row) return row;
  row.fields = parse(row.fields_json, {});
  delete row.fields_json;
  return row;
}

export function queryTrades(db, f = {}) {
  const { where, params } = tradeFilter(db, f);
  return db.prepare(`${TRADE_SELECT} ${where} ORDER BY ${TRADE_DATE} DESC, t.chart_time DESC, t.id DESC LIMIT @limit`)
    .all({ ...params, limit: f.limit ?? 100 }).map(hydrate);
}

export function getTrade(db, id) {
  const trade = hydrate(db.prepare(`${TRADE_SELECT} WHERE t.id = ?`).get(id)) || fail(`trade_id ${id} does not exist`);
  trade.rule_checks = db.prepare(`SELECT r.key, r.text, r.severity, c.result, c.note FROM trade_rule_checks c
    JOIN strategy_rules r ON r.id = c.rule_id WHERE c.trade_id = ? ORDER BY r.position`).all(id);
  trade.screenshots = db.prepare('SELECT * FROM attachments WHERE trade_id = ? ORDER BY id').all(id);
  trade.lessons = db.prepare('SELECT * FROM lessons WHERE trade_id = ? ORDER BY id').all(id);
  return trade;
}

export function deleteTrade(db, id) {
  const cur = db.prepare('SELECT id FROM trades WHERE id = ?').get(id) || fail(`trade_id ${id} does not exist`);
  db.prepare('DELETE FROM trades WHERE id = ?').run(cur.id);
  return { deleted: cur.id };
}

// ---------------------------------------------------------------- screenshots & lessons

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function addScreenshot(db, a) {
  db.prepare('SELECT id FROM trades WHERE id = ?').get(a.trade_id) || fail(`trade_id ${a.trade_id} does not exist`);
  const src = path.resolve(a.source_path);
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXT.has(ext)) fail(`only image files are accepted (${[...IMAGE_EXT].join(', ')})`);
  if (!fs.existsSync(src)) fail(`file not found: ${src}`);
  const st = fs.statSync(src);
  if (!st.isFile()) fail(`not a file: ${src}`);
  if (st.size > MAX_IMAGE_BYTES) fail('image larger than 25 MB');
  const dir = paths().screenshots;
  fs.mkdirSync(dir, { recursive: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE trade_id = ?').get(a.trade_id).n + 1;
  let filename = `trade-${a.trade_id}-${n}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, filename)); i++) filename = `trade-${a.trade_id}-${n}-${i}${ext}`;
  fs.copyFileSync(src, path.join(dir, filename));
  const info = db.prepare('INSERT INTO attachments (trade_id, path, caption) VALUES (?, ?, ?)').run(a.trade_id, filename, a.caption ?? null);
  return { attachment_id: Number(info.lastInsertRowid), path: filename };
}

export const LESSON_CATEGORIES = ['discipline', 'strategy', 'market', 'risk', 'psychology', 'execution'];

export function addLesson(db, a) {
  const strategyId = a.strategy ? resolveStrategy(db, a.strategy).id
    : a.trade_id ? db.prepare('SELECT strategy_id FROM trades WHERE id = ?').get(a.trade_id)?.strategy_id
    : a.session_id ? db.prepare('SELECT strategy_id FROM sessions WHERE id = ?').get(a.session_id)?.strategy_id : null;
  const info = db.prepare('INSERT INTO lessons (session_id, trade_id, strategy_id, category, text) VALUES (?, ?, ?, ?, ?)')
    .run(a.session_id ?? null, a.trade_id ?? null, strategyId ?? null, a.category, a.text);
  return { lesson_id: Number(info.lastInsertRowid) };
}

export function updateLesson(db, a) {
  const cols = ['text', 'category'].filter(c => a[c] !== undefined);
  if (!cols.length) fail('no fields to update');
  const info = db.prepare(`UPDATE lessons SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`)
    .run({ ...Object.fromEntries(cols.map(c => [c, a[c]])), id: a.lesson_id });
  return info.changes ? { updated: a.lesson_id, fields: cols } : fail(`lesson_id ${a.lesson_id} does not exist`);
}

export function deleteLesson(db, id) {
  return db.prepare('DELETE FROM lessons WHERE id = ?').run(id).changes ? { deleted: id } : fail(`lesson_id ${id} does not exist`);
}

export function listLessons(db, f = {}) {
  const conds = [], p = {};
  if (f.session_id) { conds.push('(l.session_id = @session_id OR t.session_id = @session_id)'); p.session_id = f.session_id; }
  if (f.trade_id) { conds.push('l.trade_id = @trade_id'); p.trade_id = f.trade_id; }
  if (f.category) { conds.push('l.category = @category'); p.category = f.category; }
  if (f.strategy) { conds.push('l.strategy_id = @strategy_id'); p.strategy_id = resolveStrategy(db, f.strategy).id; }
  if (f.mode) { conds.push('COALESCE(s1.mode, s2.mode) = @mode'); p.mode = f.mode; }
  if (f.account) { conds.push('COALESCE(a1.name, a2.name) = @account'); p.account = f.account; }
  return db.prepare(`
    SELECT l.*, t.trade_no, t.session_id AS trade_session_id
    FROM lessons l
    LEFT JOIN trades t ON t.id = l.trade_id
    LEFT JOIN sessions s1 ON s1.id = l.session_id LEFT JOIN accounts a1 ON a1.id = s1.account_id
    LEFT JOIN sessions s2 ON s2.id = t.session_id LEFT JOIN accounts a2 ON a2.id = s2.account_id
    ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
    ORDER BY l.id DESC LIMIT @limit`).all({ ...p, limit: f.limit ?? 200 });
}

// ---------------------------------------------------------------- setup status

/** What the agent should call first: tells it whether onboarding is needed. */
export function setupStatus(db) {
  const profile = getProfile(db);
  const strategies = listStrategies(db);
  const accounts = listAccounts(db).map(a => a.name);
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM trades) AS trades,
    (SELECT COUNT(*) FROM lessons) AS lessons`).get();
  const missing = [];
  if (!Object.keys(profile).length) missing.push('trader profile');
  if (!strategies.length) missing.push('at least one strategy');
  return {
    onboarded: missing.length === 0,
    next_step: missing.length
      ? `Onboarding needed (${missing.join(' + ')}). Call get_onboarding_guide and interview the user before logging trades.`
      : 'Ready. Call get_strategy for the active strategy before logging trades so fields/rules match.',
    profile, strategies, accounts, counts, data_dir: paths().dataDir,
  };
}

function dropNulls(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)); }
export function round2(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}
