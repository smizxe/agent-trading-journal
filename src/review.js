// Markdown review export (Obsidian-friendly): stats, rule adherence, field breakdowns, trades, lessons.
import fs from 'node:fs';
import path from 'node:path';
import { getStats } from './stats.js';
import { queryTrades, listLessons } from './journal.js';

const fmt = (r) => r === null || r === undefined ? '—' : (r > 0 ? '+' : '') + r;

export function reviewMarkdown(db, filters = {}, { title } = {}) {
  const s = getStats(db, filters);
  const trades = queryTrades(db, { ...filters, limit: 500 }).reverse();
  const lessons = listLessons(db, { session_id: filters.session_id, strategy: filters.strategy, mode: filters.mode, account: filters.account, limit: 50 });
  const scope = Object.entries(filters).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || 'all trades';
  const today = new Date().toISOString().slice(0, 10);
  const L = [];
  L.push('---', `title: "${(title || `Trading review ${today}`).replace(/"/g, "'")}"`, `date: ${today}`, 'tags:', '  - trading-review', '---', '');
  L.push(`# ${title || `Trading review — ${today}`}`, '', `> Scope: ${scope}`, '');
  L.push('## Summary', '');
  L.push('| Closed | Win rate | Total R | Expectancy | Profit factor | Max DD | Edge Score |', '|---|---|---|---|---|---|---|');
  L.push(`| ${s.taken} (${s.wins}W/${s.losses}L/${s.breakeven}BE) | ${s.win_rate ?? '—'}% | ${fmt(s.total_r)}R | ${fmt(s.expectancy_r)}R | ${s.profit_factor === Infinity ? '∞' : s.profit_factor ?? '—'} | −${s.max_drawdown_r}R | ${s.edge_score.score ?? `— (${s.edge_score.reason})`} |`, '');
  if (s.skipped.total) L.push(`Skipped setups: ${s.skipped.total} (reviewed ${s.skipped.reviewed}: ${s.skipped.correct} right, ${s.skipped.wrong} wrong).`, '');

  if (s.rules.rules.length) {
    L.push('## Rule adherence', '');
    if (s.rules.followed && s.rules.broken) {
      L.push(`- **All must-rules followed**: ${s.rules.followed.trades} trades, win rate ${s.rules.followed.win_rate ?? '—'}%, expectancy ${fmt(s.rules.followed.expectancy_r)}R`);
      L.push(`- **At least one broken**: ${s.rules.broken.trades} trades, win rate ${s.rules.broken.win_rate ?? '—'}%, expectancy ${fmt(s.rules.broken.expectancy_r)}R`, '');
    }
    L.push('| Rule | Severity | Pass rate | E[R] pass | E[R] fail |', '|---|---|---|---|---|');
    for (const r of s.rules.rules) L.push(`| ${r.text} | ${r.severity} | ${r.pass_rate ?? '—'}% (${r.pass}/${r.checked}) | ${fmt(r.expectancy_when_pass)} | ${fmt(r.expectancy_when_fail)} |`);
    L.push('');
  }

  if (s.fields.length) {
    L.push('## By strategy field', '');
    for (const f of s.fields) {
      L.push(`### ${f.label}`, '', '| Value | Trades | Win rate | Total R | E[R] |', '|---|---|---|---|---|');
      for (const g of f.groups) L.push(`| ${g.label} | ${g.trades} | ${g.win_rate}% | ${fmt(g.total_r)} | ${fmt(g.expectancy_r)} |`);
      L.push('');
    }
  }

  L.push('## Trades', '');
  if (!trades.length) L.push('_No trades in scope._', '');
  else {
    L.push('| # | Time | Symbol | Side | Result | R | Notes |', '|---|---|---|---|---|---|---|');
    for (const t of trades) {
      const result = t.status === 'skipped' ? `skipped${t.skip_correct === 1 ? ' ✓' : t.skip_correct === 0 ? ' ✗' : ''}` : t.outcome ?? 'open';
      const note = (t.status === 'skipped' ? t.skip_reason : t.mistakes ? '⚠️ ' + t.mistakes : t.notes) ?? '';
      L.push(`| ${t.session_id}/${t.trade_no} | ${t.chart_time ?? t.trade_date} | ${t.symbol} | ${t.direction ?? '—'} | ${result} | ${fmt(t.result_r)} | ${note.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 140)} |`);
    }
    L.push('');
  }

  if (lessons.length) {
    L.push('## Lessons', '');
    for (const l of lessons) L.push(`- **${l.category}**${l.trade_no ? ` (trade ${l.trade_session_id}/${l.trade_no})` : ''}: ${l.text}`);
    L.push('');
  }
  return L.join('\n');
}

export function exportReview(db, filters, { path: out, title } = {}) {
  const md = reviewMarkdown(db, filters, { title });
  if (!out) return { markdown: md };
  const file = path.resolve(out);
  if (path.extname(file).toLowerCase() !== '.md') throw new Error('path must end with .md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md, 'utf8');
  return { written: file, bytes: Buffer.byteLength(md) };
}
