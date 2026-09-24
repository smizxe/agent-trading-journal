// End-to-end: spawn the real MCP server over stdio, drive it like an agent would, then hit the dashboard API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atj-mcp-'));
const PORT = 3799;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), 'mcp'],
  env: { ...process.env, JOURNAL_DATA_DIR: tmp, JOURNAL_PORT: String(PORT) },
  stderr: 'pipe',
});
const client = new Client({ name: 'test', version: '0' });
await client.connect(transport);
after(() => client.close());

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
};

test('server exposes instructions, tools and workflow prompts', async () => {
  assert.match(client.getInstructions(), /get_setup_status first/);
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const t of ['get_setup_status', 'get_onboarding_guide', 'upsert_strategy', 'log_trade', 'check_risk', 'import_statement', 'export_review', 'get_stats'])
    assert.ok(tools.includes(t), t);
  const prompts = (await client.listPrompts()).prompts.map(p => p.name).sort();
  assert.deepEqual(prompts, ['log_trade_from_screenshot', 'onboarding', 'pre_session_check', 'weekly_review']);
  const onboarding = await client.getPrompt({ name: 'onboarding' });
  assert.match(onboarding.messages[0].content.text, /Onboarding interview/);
});

test('onboarding flow: status → guide → profile → preset → account', async () => {
  assert.equal((await call('get_setup_status')).onboarded, false);
  assert.match(await call('get_onboarding_guide'), /Phase 4/);
  const presets = await call('list_presets');
  assert.ok(presets.find(p => p.preset === 'trend-pullback'));
  await call('set_profile', { entries: { language: 'English', timezone: 'UTC', markets: 'EURUSD' } });
  const st = await call('import_preset', { preset: 'trend-pullback', slug: 'my-pullback', name: 'My pullback' });
  assert.equal(st.slug, 'my-pullback');
  await call('upsert_account', { name: 'Live', risk_per_trade_pct: 1, max_daily_loss_pct: 3 });
  assert.equal((await call('get_setup_status')).onboarded, true);
});

test('agent logs trades with fields + rules; errors come back as tool errors', async () => {
  const { session_id } = await call('start_session', { symbol: 'EURUSD', mode: 'live', strategy: 'my-pullback', account: 'Live', date: '2026-09-23' });
  for (const [i, r] of [[1, 2], [2, -1], [3, 1.5], [4, -1], [5, 2.5]].entries()) {
    await call('log_trade', { session_id, direction: 'buy', chart_time: `2026-09-2${3 + (i % 2)} 1${i}:00`, result_r: r[1],
      fields: { pullback_to: 'ema20', trend_strength: i % 2 ? 'weak' : 'strong' }, rules: { with_trend: i % 2 ? 'fail' : 'pass' } });
  }
  await assert.rejects(call('log_trade', { session_id, direction: 'buy', fields: { bogus: 1 } }), /unknown field "bogus"/);
  const s = await call('get_stats', { strategy: 'my-pullback' });
  assert.equal(s.taken, 5);
  assert.equal(s.total_r, 4);
  assert.ok(s.edge_score.score > 0);
  assert.equal(s.rules.broken.trades, 2);
  const risk = await call('check_risk', { account: 'Live', date: '2026-09-24' });
  assert.equal(risk.today.r, -2);
  assert.equal(risk.today.pct, -2);
  assert.equal(risk.status, 'caution');
  const wf = await call('get_workflow', { name: 'weekly_review' });
  assert.match(wf, /get_stats/);
  const md = await call('export_review', { strategy: 'my-pullback' });
  assert.match(md.markdown, /Rule adherence/);
});

test('dashboard: off by default, starts on request, serves API', async () => {
  assert.equal((await call('dashboard_status')).running, false);
  fs.mkdirSync(path.join(tmp, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'locales', 'de.json'), JSON.stringify({ _name: 'Deutsch', overview: 'Übersicht' }));
  fs.writeFileSync(path.join(tmp, 'locales', 'xx.json'), '{ not json');
  const started = await call('start_dashboard');
  assert.equal(started.url, `http://localhost:${PORT}`);
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  assert.match(html, /Agent Trading Journal/);
  const meta = await (await fetch(`http://127.0.0.1:${PORT}/api/meta`)).json();
  assert.equal(meta.strategies[0].slug, 'my-pullback');
  const stats = await (await fetch(`http://127.0.0.1:${PORT}/api/stats?strategy=my-pullback`)).json();
  assert.equal(stats.total_r, 4);
  const locales = await (await fetch(`http://127.0.0.1:${PORT}/api/locales`)).json();
  assert.deepEqual(Object.keys(locales), ['de']);
  assert.equal(locales.de.overview, 'Übersicht');
  const bad = await fetch(`http://127.0.0.1:${PORT}/api/stats?strategy=nope`);
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/screenshots/..%2Fjournal.db`)).status, 404);
  await call('stop_dashboard');
  assert.equal((await call('dashboard_status')).running, false);
});
