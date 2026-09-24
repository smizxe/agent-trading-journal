// Domain tests against a throwaway data dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atj-test-'));
process.env.JOURNAL_DATA_DIR = tmp;
const { openDb } = await import('../src/db.js');
const J = await import('../src/journal.js');
const { getStats } = await import('../src/stats.js');
const { checkRisk } = await import('../src/risk.js');
const { importStatement } = await import('../src/importer.js');
const { reviewMarkdown } = await import('../src/review.js');
const { seedDemo } = await import('../src/demo.js');
const db = openDb();
// Neutral test strategy (not a real trading method) covering every field type.
const preset = {
  slug: 'test-breakout', name: 'Test breakout', description: 'fixture',
  fields: [
    { key: 'setup_type', label: 'Setup type', type: 'enum', required: true, options: [
      { value: 'range_break', label: 'Range break' }, { value: 'retest', label: 'Retest' }, { value: 'squeeze', label: 'Squeeze' }] },
    { key: 'session', label: 'Session', type: 'enum', options: ['asia', 'europe', 'us'] },
    { key: 'volume_spike', label: 'Volume spike', type: 'bool' },
    { key: 'atr_multiple', label: 'Range / ATR', type: 'number' },
    { key: 'news_nearby', label: 'News nearby', type: 'bool' },
  ],
  rules: [
    { key: 'trend_filter', text: 'Break is in the direction of the daily trend', severity: 'must' },
    { key: 'close_outside', text: 'Candle closed outside the range', severity: 'must' },
    { key: 'retest_held', text: 'Retest held before entry', severity: 'must' },
    { key: 'min_rr', text: 'Planned RR at least 2', severity: 'must' },
    { key: 'no_news', text: 'No high-impact news within 30 minutes', severity: 'should' },
  ],
};

test('setup status asks for onboarding on an empty journal', () => {
  const s = J.setupStatus(db);
  assert.equal(s.onboarded, false);
  assert.match(s.next_step, /get_onboarding_guide/);
});

test('every preset is a valid strategy definition', () => {
  for (const f of fs.readdirSync(new URL('../presets/', import.meta.url))) {
    const def = JSON.parse(fs.readFileSync(new URL(`../presets/${f}`, import.meta.url), 'utf8'));
    const s = J.upsertStrategy(db, { ...def, slug: 'check-' + def.slug });
    assert.ok(s.fields.length >= 3 && s.rules.length >= 4, f);
  }
});

test('strategy upsert: version bumps only when fields/rules change; removed fields are archived', () => {
  const s1 = J.upsertStrategy(db, preset);
  assert.equal(s1.version, 1);
  assert.equal(J.upsertStrategy(db, { ...preset, description: 'wording only' }).version, 1);
  const s3 = J.upsertStrategy(db, { ...preset, fields: preset.fields.slice(0, -1) });
  assert.equal(s3.version, 2);
  assert.equal(J.getStrategy(db, 'test-breakout', { includeArchived: true }).fields.find(f => f.key === 'news_nearby').archived, true);
  J.upsertStrategy(db, preset); // restore
});

test('profile + account + session; onboarding complete', () => {
  J.setProfile(db, { language: 'English', timezone: 'America/New_York' });
  J.upsertAccount(db, { name: 'Prop 5K', type: 'prop', starting_balance: 5000, risk_per_trade_pct: 1, max_daily_loss_pct: 2.5,
    max_total_drawdown_pct: 5, max_trades_per_day: 2, max_consecutive_losses: 2 });
  assert.equal(J.setupStatus(db).onboarded, true);
});

let sid, t1;
test('log trade: fields validated/coerced by label, rules stored, RR/R/outcome derived', () => {
  sid = J.startSession(db, { date: '2026-09-21', symbol: 'NQ', mode: 'live', strategy: 'test-breakout', account: 'Prop 5K' }).session_id;
  const r = J.logTrade(db, {
    session_id: sid, direction: 'buy', chart_time: '2026-09-21 14:05', entry: 100, sl: 99, tp: 103, exit_price: 103,
    fields: { setup_type: 'Range break', session: 'europe', volume_spike: 'yes', atr_multiple: '1.4' },
    rules: { trend_filter: 'pass', close_outside: 'pass', retest_held: { result: 'fail', note: 'entered early' }, min_rr: 'pass' },
  });
  t1 = r.trade_id;
  assert.equal(r.rr_planned, 3);
  assert.equal(r.result_r, 3);
  assert.equal(r.outcome, 'win');
  const t = J.getTrade(db, t1);
  assert.deepEqual(t.fields, { setup_type: 'range_break', session: 'europe', volume_spike: true, atr_multiple: 1.4 });
  assert.equal(t.rule_checks.find(c => c.key === 'retest_held').note, 'entered early');
  assert.equal(t.strategy_version, J.getStrategy(db, 'test-breakout').version); // 3: removed a field (v2), then restored it (v3)
});

test('bad input produces agent-readable errors', () => {
  assert.throws(() => J.logTrade(db, { session_id: sid, direction: 'buy', fields: { nope: 1 } }), /unknown field "nope".*Fields: setup_type/);
  assert.throws(() => J.logTrade(db, { session_id: sid, direction: 'buy', fields: { setup_type: 'banana' } }), /Options: range_break \(Range break\)/);
  assert.throws(() => J.logTrade(db, { session_id: sid, direction: 'buy', rules: { made_up: 'pass' } }), /unknown rule/);
  assert.throws(() => J.logTrade(db, { session_id: sid, status: 'skipped' }), /skip_reason/);
  assert.throws(() => J.logTrade(db, { session_id: sid }), /direction/);
  const w = J.logTrade(db, { session_id: sid, direction: 'sell', chart_time: '2026-09-21 16:00', result_r: -1, fields: { session: 'us' } });
  assert.match(w.warnings.join(), /required fields not set: setup_type/);
});

test('update trade merges fields and rule checks', () => {
  J.updateTrade(db, { trade_id: t1, fields: { session: 'us', volume_spike: null }, rules: { retest_held: 'pass' }, notes: 'fixed' });
  const t = J.getTrade(db, t1);
  assert.equal(t.fields.session, 'us');
  assert.equal('volume_spike' in t.fields, false);
  assert.equal(t.rule_checks.find(c => c.key === 'retest_held').result, 'pass');
  assert.equal(t.notes, 'fixed');
  assert.equal(J.queryTrades(db, { fields: { session: 'us' } }).length, 2);
});

test('stats: field breakdowns, rule adherence, calendar, streaks', () => {
  J.logTrade(db, { session_id: sid, direction: 'buy', chart_time: '2026-09-22 09:00', result_r: -1,
    fields: { setup_type: 'squeeze' }, rules: { trend_filter: 'fail', close_outside: 'pass' } });
  J.logTrade(db, { session_id: sid, status: 'skipped', skip_reason: 'news', skip_correct: true });
  const s = getStats(db, { strategy: 'test-breakout' });
  assert.equal(s.taken, 3);
  assert.equal(s.total_r, 1);
  assert.equal(s.skipped.correct, 1);
  const setup = s.fields.find(f => f.key === 'setup_type');
  assert.equal(setup.groups.find(g => g.key === 'range_break').label, 'Range break');
  const trend = s.rules.rules.find(r => r.key === 'trend_filter');
  assert.equal(trend.fail, 1);
  assert.equal(trend.expectancy_when_fail, -1);
  assert.equal(s.rules.followed.trades, 1);
  assert.equal(s.rules.broken.trades, 1);
  assert.equal(s.calendar.length, 2);
  assert.equal(s.streaks.longest_loss, 2);
  assert.equal(s.edge_score.score, null);
});

test('risk guard: daily loss, loss streak, trade count', () => {
  const r = checkRisk(db, 'Prop 5K', '2026-09-21');
  assert.equal(r.today.r, 2);
  assert.equal(r.status, 'stop'); // 2 trades = max_trades_per_day
  const r2 = checkRisk(db, 'Prop 5K', '2026-09-22');
  assert.equal(r2.overall.loss_streak, 2);
  assert.ok(r2.alerts.some(a => /losses in a row/.test(a.msg)));
});

test('screenshots: images only', () => {
  const png = path.join(tmp, 'shot.png');
  fs.writeFileSync(png, zlib.deflateSync(Buffer.from('x')));
  assert.equal(J.addScreenshot(db, { trade_id: t1, source_path: png }).path, `trade-${t1}-1.png`);
  const txt = path.join(tmp, 'secret.txt'); fs.writeFileSync(txt, 'x');
  assert.throws(() => J.addScreenshot(db, { trade_id: t1, source_path: txt }), /only image files/);
});

test('import TradingView statement (LuxAlgo parsers): dry run, import, dedupe, R from account risk', () => {
  const file = new URL('./fixtures/tradingview-sample.csv', import.meta.url);
  J.upsertAccount(db, { name: 'Paper', starting_balance: 100000, risk_per_trade_pct: 0.5 });
  const dry = importStatement(db, { path: fileURLPath(file), account: 'Paper', dry_run: true, timezone: 'America/New_York' });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.new_trades > 3, JSON.stringify(dry));
  const res = importStatement(db, { path: fileURLPath(file), account: 'Paper', timezone: 'America/New_York' });
  assert.equal(res.imported, dry.new_trades);
  const again = importStatement(db, { path: fileURLPath(file), account: 'Paper' });
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, res.imported);
  const t = J.getTrade(db, res.trade_ids[0]);
  assert.equal(t.source, 'import');
  assert.equal(t.result_r, Math.round(t.pnl / 500 * 100) / 100);
  assert.match(t.chart_time, /^2025-03-0\d \d{2}:\d{2}$/);
});

test('review markdown has summary, rules and trades', () => {
  const md = reviewMarkdown(db, { strategy: 'test-breakout' });
  assert.match(md, /## Summary/);
  assert.match(md, /## Rule adherence/);
  assert.match(md, /Break is in the direction of the daily trend/);
});

test('demo seeder fills an empty journal with a usable dataset', () => {
  const demoDb = openDb(path.join(tmp, 'demo.db'));
  const r = seedDemo(demoDb);
  assert.ok(r.trades > 30);
  const s = getStats(demoDb, {});
  assert.ok(s.edge_score.score !== null);
  assert.ok(s.rules.followed.expectancy_r > s.rules.broken.expectancy_r, 'demo data should show rule-following pays');
  assert.throws(() => seedDemo(demoDb), /already has trades/);
});

function fileURLPath(u) { return decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1'); }
