import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, openDbReadonly, APP_DIR } from './db.js';
import * as J from './journal.js';
import { getStats } from './stats.js';
import { checkRisk } from './risk.js';
import { importStatement, SUPPORTED_FORMATS } from './importer.js';
import { exportReview } from './review.js';
import { WORKFLOWS, onboardingGuide } from './prompts.js';
import { startWeb, stopWeb, isWebRunning, webUrl, WEB_PORT } from './web.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;

const INSTRUCTIONS = `Agent Trading Journal — you are the one who writes the journal. The user trades and shows you charts; you log, check and review.
- Call get_setup_status first in a conversation. If onboarded=false, run the onboarding interview (get_onboarding_guide) before logging trades.
- Before logging, call get_strategy so custom fields and rule keys match the user's own definition. Never invent field keys.
- Screenshots: read what's visible, ask for what isn't, check every rule (pass/fail/na) and attach images with add_screenshot.
- R = result in multiples of planned risk. Separate facts on the chart from your interpretation. Analysis only; the user makes every trading decision.
- Workflows: get_workflow (log_trade_from_screenshot, weekly_review, pre_session_check). Dashboard: start_dashboard only when asked.`;

const db = openDb();
const server = new McpServer({ name: 'agent-trading-journal', version: VERSION }, { instructions: INSTRUCTIONS });

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const err = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });
/** Register a tool whose handler is a plain (sync or async) function; errors become tool errors. */
function tool(name, title, description, inputSchema, fn) {
  server.registerTool(name, { title, description, inputSchema }, async (a) => {
    try { return ok(await fn(a)); } catch (e) { return err(e.message); }
  });
}

// ---------------------------------------------------------------- schemas

const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ruleResult = z.union([z.enum(['pass', 'fail', 'na']), z.object({ result: z.enum(['pass', 'fail', 'na']), note: z.string().optional() })]);
const filters = {
  session_id: z.number().int().optional(),
  symbol: z.string().optional(),
  mode: z.enum(['backtest', 'forward', 'live']).optional(),
  account: z.string().optional().describe('account name'),
  strategy: z.string().optional().describe('strategy slug'),
  from: z.string().optional().describe('YYYY-MM-DD (trade date)'),
  to: z.string().optional().describe('YYYY-MM-DD (trade date)'),
  tag: z.string().optional(),
  fields: z.record(fieldValue).optional().describe('filter on custom field values, e.g. {"setup_type":"pullback"}'),
};
const TRADE_INPUT = {
  strategy: z.string().optional().describe('strategy slug — defaults to the session strategy'),
  chart_time: z.string().optional().describe('entry time on the chart, "YYYY-MM-DD HH:mm" in the trader\'s timezone'),
  closed_at: z.string().optional(),
  status: z.enum(['taken', 'skipped']).optional().describe('default taken; a valid setup the user stayed out of = skipped'),
  direction: z.enum(['buy', 'sell']).optional(),
  entry: z.number().optional(), sl: z.number().optional(), tp: z.number().optional(), tp2: z.number().optional(),
  exit_price: z.number().optional().describe('average exit price; R is derived from entry/sl when result_r is not given'),
  quantity: z.number().optional(),
  rr_planned: z.number().optional().describe('derived from entry/sl/tp when omitted'),
  outcome: z.enum(['win', 'loss', 'be']).optional().describe('derived from result_r when omitted; leave empty while open'),
  result_r: z.number().optional().describe('realised R, net of fees when known'),
  pnl: z.number().optional().describe('realised P&L in account currency'),
  mae_r: z.number().optional().describe('max adverse excursion in R (how far it went against you)'),
  mfe_r: z.number().optional().describe('max favourable excursion in R (how far it went your way)'),
  partial_taken: z.boolean().optional(), moved_be: z.boolean().optional(),
  exit_reason: z.string().optional(),
  skip_reason: z.string().optional().describe('required when status=skipped'),
  skip_correct: z.boolean().optional().describe('later review: was skipping right?'),
  fields: z.record(fieldValue).optional().describe('custom fields defined by the strategy (see get_strategy), e.g. {"setup_type":"pullback","news_nearby":false}'),
  rules: z.record(ruleResult).optional().describe('rule checks by rule key: "pass" | "fail" | "na" (or {result, note})'),
  mistakes: z.string().optional().describe('discipline / execution mistakes'),
  confidence: z.number().int().min(1).max(5).optional(),
  notes: z.string().optional(),
  tags: z.string().optional().describe('comma-separated'),
};
const STRATEGY_DEF = {
  slug: z.string().optional().describe('short id; derived from name when omitted. Same slug = update (version bumps if fields/rules change)'),
  name: z.string(),
  description: z.string().optional(),
  markets: z.string().optional(),
  timeframes: z.string().optional(),
  plan: z.record(z.string()).optional().describe('summary, bias, setup, entry, stop, targets, management, no_trade'),
  fields: z.array(z.object({
    key: z.string(), label: z.string().optional(), type: z.enum(['enum', 'bool', 'number', 'text']),
    options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string().optional() })])).optional(),
    guide: z.string().optional().describe('how to read it from a chart, or "ask the user"'),
    required: z.boolean().optional(), breakdown: z.boolean().optional(),
  })).optional(),
  rules: z.array(z.object({
    key: z.string().optional(), text: z.string(), guide: z.string().optional(), severity: z.enum(['must', 'should']).optional(),
  })).optional(),
};

// ---------------------------------------------------------------- setup & onboarding

tool('get_setup_status', 'Setup status (call first)', 'Profile, strategies, accounts and counts. Tells you whether onboarding is needed.', {},
  () => J.setupStatus(db));
tool('get_onboarding_guide', 'Onboarding interview guide', 'The interview script for setting the journal up around this trader. Follow it when get_setup_status says onboarding is needed.', {},
  () => onboardingGuide());
tool('get_workflow', 'Get a workflow', `Step-by-step instructions for a packaged workflow: ${Object.keys(WORKFLOWS).join(', ')}.`,
  { name: z.enum(Object.keys(WORKFLOWS)) }, (a) => WORKFLOWS[a.name].text());
tool('set_profile', 'Save trader profile', 'Upsert trader profile entries (language, markets, style, sessions, timezone, experience, goals, weaknesses, ...). null deletes a key.',
  { entries: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])) }, (a) => J.setProfile(db, a.entries));

// ---------------------------------------------------------------- strategies

const PRESET_DIR = path.join(APP_DIR, 'presets');
const readPreset = (name) => {
  const file = path.join(PRESET_DIR, path.basename(name).replace(/\.json$/, '') + '.json');
  if (!fs.existsSync(file)) throw new Error(`preset "${name}" not found`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
tool('list_presets', 'List strategy presets', 'Example strategies to start from (always adapt them to the user).', {},
  () => fs.readdirSync(PRESET_DIR).filter(f => f.endsWith('.json')).map(f => {
    const p = readPreset(f);
    return { preset: f.replace(/\.json$/, ''), name: p.name, description: p.description, markets: p.markets, fields: p.fields?.length ?? 0, rules: p.rules?.length ?? 0 };
  }));
tool('import_preset', 'Import a preset as a strategy', 'Copy a preset into the journal as a strategy (optionally under a new slug/name), then edit it with upsert_strategy.',
  { preset: z.string(), slug: z.string().optional(), name: z.string().optional() },
  (a) => { const p = readPreset(a.preset); return J.upsertStrategy(db, { ...p, slug: a.slug ?? p.slug, name: a.name ?? p.name }); });
tool('upsert_strategy', 'Create / update a strategy', 'Save the full strategy definition: plan, custom fields (what to measure per trade) and rules (entry checklist). Fields/rules left out are archived, not deleted.',
  STRATEGY_DEF, (a) => J.upsertStrategy(db, a));
tool('get_strategy', 'Get a strategy', 'Full definition with field guides and rules. Call before logging trades.',
  { strategy: z.string().describe('slug or name'), include_archived: z.boolean().optional() },
  (a) => J.getStrategy(db, a.strategy, { includeArchived: a.include_archived }));
tool('list_strategies', 'List strategies', 'All strategies with version, number of fields/rules and trades.', {}, () => J.listStrategies(db));
tool('export_strategy', 'Export a strategy', 'Portable JSON of a strategy (same format as presets) — to back up or share.',
  { strategy: z.string(), path: z.string().optional().describe('optional .json file path to write') },
  (a) => {
    const def = J.exportStrategy(db, a.strategy);
    if (!a.path) return def;
    if (path.extname(a.path).toLowerCase() !== '.json') throw new Error('path must end with .json');
    fs.writeFileSync(path.resolve(a.path), JSON.stringify(def, null, 2) + '\n');
    return { written: path.resolve(a.path) };
  });

// ---------------------------------------------------------------- accounts & risk

tool('upsert_account', 'Create / update an account', 'Trading account with its risk limits (prop-firm style). Same name = update; omitted fields stay unchanged.', {
  name: z.string(),
  type: z.enum(['personal', 'prop', 'demo', 'other']).optional(),
  currency: z.string().optional(), starting_balance: z.number().optional(),
  risk_per_trade_pct: z.number().optional().describe('e.g. 0.5 = 0.5% per trade'),
  max_daily_loss_pct: z.number().optional(), max_total_drawdown_pct: z.number().optional(), profit_target_pct: z.number().optional(),
  max_trades_per_day: z.number().int().optional(), max_consecutive_losses: z.number().int().optional(),
  notes: z.string().optional(),
}, (a) => J.upsertAccount(db, a));
tool('list_accounts', 'List accounts', 'Accounts with their limits.', {}, () => J.listAccounts(db));
tool('check_risk', 'Check account risk limits', 'Today\'s R and estimated % vs the account\'s daily loss / drawdown / trade-count / loss-streak limits. status: ok | caution | stop.',
  { account: z.string(), date: z.string().optional().describe('YYYY-MM-DD, default today') }, (a) => checkRisk(db, a.account, a.date));

// ---------------------------------------------------------------- sessions & trades

tool('start_session', 'Start a session', 'A backtest / forward / live session. Returns session_id for log_trade.', {
  date: z.string().optional().describe('YYYY-MM-DD, default today'),
  symbol: z.string(),
  mode: z.enum(['backtest', 'forward', 'live']).default('backtest'),
  strategy: z.string().optional().describe('strategy slug — trades inherit it'),
  account: z.string().optional().describe('account name (created if new) — for forward/live'),
  timeframes: z.string().optional(),
  data_from: z.string().optional().describe('backtest: start of the replayed range'),
  data_to: z.string().optional(),
  tool_version: z.string().optional().describe('indicator / tool version used'),
  settings_json: z.string().optional().describe('JSON of settings that differ from the defaults'),
  notes: z.string().optional(),
}, (a) => J.startSession(db, a));
tool('list_sessions', 'List sessions', 'Sessions with trade count, win count and total R.',
  { mode: filters.mode, strategy: filters.strategy, account: filters.account }, (a) => J.listSessions(db, a));
tool('log_trade', 'Log a trade or skipped setup', 'Log one trade into a session with custom fields and rule checks. Skipped setups count too (status=skipped + skip_reason). RR, R and outcome are derived when possible.',
  { session_id: z.number().int(), ...TRADE_INPUT }, (a) => J.logTrade(db, a));
tool('update_trade', 'Update a trade', 'Change any field, custom field or rule check. Send only what changes.',
  { trade_id: z.number().int(), ...TRADE_INPUT }, (a) => J.updateTrade(db, a));
tool('delete_trade', 'Delete a trade', 'Delete a trade logged by mistake (with its rule checks and screenshot records).',
  { trade_id: z.number().int() }, (a) => J.deleteTrade(db, a.trade_id));
tool('query_trades', 'Query trades', 'Trades matching filters, newest first.',
  { ...filters, status: z.enum(['taken', 'skipped']).optional(), outcome: z.enum(['win', 'loss', 'be']).optional(), limit: z.number().int().min(1).max(500).default(100) },
  (a) => J.queryTrades(db, a));
tool('get_trade', 'Get a trade', 'One trade with fields, rule checks, screenshots and lessons.', { trade_id: z.number().int() }, (a) => J.getTrade(db, a.trade_id));
tool('add_screenshot', 'Attach a screenshot', 'Copy an image (png/jpg/gif/webp, absolute path) into the journal and attach it to a trade.',
  { trade_id: z.number().int(), source_path: z.string(), caption: z.string().optional().describe('timeframe, before/after entry, ...') },
  (a) => J.addScreenshot(db, a));

// ---------------------------------------------------------------- lessons

tool('add_lesson', 'Add a lesson', `Record a lesson linked to a session and/or trade. Suggested categories: ${J.LESSON_CATEGORIES.join(', ')}.`,
  { category: z.string(), text: z.string(), session_id: z.number().int().optional(), trade_id: z.number().int().optional(), strategy: z.string().optional() },
  (a) => J.addLesson(db, a));
tool('update_lesson', 'Update a lesson', 'Edit text or category.', { lesson_id: z.number().int(), text: z.string().optional(), category: z.string().optional() },
  (a) => J.updateLesson(db, a));
tool('delete_lesson', 'Delete a lesson', 'Delete a lesson recorded by mistake.', { lesson_id: z.number().int() }, (a) => J.deleteLesson(db, a.lesson_id));
tool('list_lessons', 'List lessons', 'Lessons, newest first.', {
  session_id: z.number().int().optional(), trade_id: z.number().int().optional(), category: z.string().optional(),
  strategy: z.string().optional(), mode: filters.mode, account: z.string().optional(), limit: z.number().int().optional(),
}, (a) => J.listLessons(db, a));

// ---------------------------------------------------------------- analysis, import, export

tool('get_stats', 'Stats', 'Win rate, total R, expectancy, profit factor, payoff, drawdown, streaks, Edge Score, breakdowns (direction, symbol, weekday, hour, every custom field), rule adherence, calendar, equity curve.',
  filters, (a) => getStats(db, a));
tool('run_sql_readonly', 'Read-only SQL', 'Any SELECT for ad-hoc analysis. Tables: profile, strategies, strategy_fields, strategy_rules, accounts, sessions, trades (custom fields in fields_json → json_extract), trade_rule_checks, attachments, lessons.',
  { sql: z.string().describe('SELECT/WITH only') }, (a) => {
    if (!/^\s*(select|with)\b/i.test(a.sql)) throw new Error('only SELECT/WITH is allowed');
    const ro = openDbReadonly();
    try { return ro.prepare(a.sql).all(); } finally { ro.close(); }
  });
tool('import_statement', 'Import a broker statement', `Import closed trades from an export file. Formats: ${SUPPORTED_FORMATS.join(', ')}. Duplicates are skipped. Run with dry_run first.`, {
  path: z.string().describe('absolute path to the exported file'),
  account: z.string(),
  strategy: z.string().optional(),
  mode: z.enum(['backtest', 'forward', 'live']).optional().describe('default live'),
  timezone: z.string().optional().describe('IANA timezone for chart_time (default: profile timezone)'),
  file_timezone: z.string().optional().describe('timezone of naive timestamps in the file, if different'),
  symbol: z.string().optional().describe('only for files without a symbol column'),
  multipliers: z.record(z.number()).optional().describe('contract multipliers per symbol for futures'),
  dry_run: z.boolean().optional(),
}, (a) => importStatement(db, a));
tool('export_review', 'Export a review (Markdown)', 'Markdown review of a scope (Obsidian-friendly). Returns the text, or writes it to path.',
  { ...filters, title: z.string().optional(), path: z.string().optional().describe('.md file to write') },
  ({ title, path: out, ...f }) => exportReview(db, f, { title, path: out }));

// ---------------------------------------------------------------- dashboard

tool('start_dashboard', 'Start dashboard', `Start the local web dashboard (${webUrl()}). Only when the user asks.`, {},
  async () => { const r = await startWeb(); if (!r.ok) throw new Error(r.reason); return { url: r.url, already: !!r.already }; });
tool('stop_dashboard', 'Stop dashboard', 'Stop the dashboard started by this server.', {},
  async () => { const r = await stopWeb(); if (!r.ok) throw new Error(r.reason); return { stopped: true }; });
tool('dashboard_status', 'Dashboard status', 'Whether the dashboard started by this server is running.', {},
  () => ({ running: isWebRunning(), url: webUrl(), port: WEB_PORT }));

// ---------------------------------------------------------------- prompts

for (const [name, w] of Object.entries(WORKFLOWS)) {
  server.registerPrompt(name, { title: w.title, description: w.description }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: w.text() } }],
  }));
}

// stdout belongs to the MCP protocol — logs go to stderr.
export async function runMcp() {
  if (process.env.JOURNAL_WEB === '1') {
    const r = await startWeb();
    console.error(r.ok ? `[journal] dashboard: ${r.url}` : `[journal] could not start dashboard — ${r.reason}`);
  }
  await server.connect(new StdioServerTransport());
}
