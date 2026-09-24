// Derived metrics — nothing here is stored; everything is computed per query and is R-based
// (R = result in multiples of the planned risk), so it works across instruments and account sizes.
import { tradeFilter, TRADE_SELECT, hydrate, getStrategy, round2 } from './journal.js';

export const EDGE_SCORE_VERSION = 'R1';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function getStats(db, filters = {}) {
  const { where, params } = tradeFilter(db, filters);
  const rows = db.prepare(`${TRADE_SELECT} ${where} ORDER BY trade_date, t.chart_time, t.id`).all(params).map(hydrate);

  const taken = rows.filter(r => r.status === 'taken');
  const closed = taken.filter(r => r.outcome !== null);
  const withR = closed.filter(r => r.result_r !== null);
  const wins = closed.filter(r => r.outcome === 'win');
  const losses = closed.filter(r => r.outcome === 'loss');
  const totalR = sum(withR, r => r.result_r);
  const winR = withR.filter(r => r.result_r > 0), lossR = withR.filter(r => r.result_r < 0);
  const grossWin = sum(winR, r => r.result_r), grossLoss = Math.abs(sum(lossR, r => r.result_r));
  const avgWin = winR.length ? grossWin / winR.length : null;
  const avgLoss = lossR.length ? grossLoss / lossR.length : null;

  let equity = 0, peak = 0, maxDD = 0;
  const equityCurve = withR.map(r => {
    equity += r.result_r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity);
    return { trade_id: r.id, session_id: r.session_id, trade_no: r.trade_no, date: r.trade_date, r: r.result_r, equity: round2(equity) };
  });

  const skipped = rows.filter(r => r.status === 'skipped');
  const skipReviewed = skipped.filter(r => r.skip_correct !== null);
  const calendar = groupBy(withR, r => r.trade_date).map(([date, rs]) => ({
    date, trades: rs.length, wins: rs.filter(r => r.outcome === 'win').length, losses: rs.filter(r => r.outcome === 'loss').length,
    total_r: round2(sum(rs, r => r.result_r)),
  }));

  const stats = {
    filters,
    trades_total: rows.length,
    taken: closed.length,
    open: taken.filter(r => r.outcome === null).length,
    wins: wins.length, losses: losses.length, breakeven: closed.filter(r => r.outcome === 'be').length,
    missing_r: closed.length - withR.length,
    win_rate: closed.length ? round2(wins.length / closed.length * 100) : null,
    total_r: round2(totalR),
    expectancy_r: withR.length ? round2(totalR / withR.length) : null,
    profit_factor: grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? Infinity : null),
    avg_win_r: avgWin === null ? null : round2(avgWin),
    avg_loss_r: avgLoss === null ? null : round2(-avgLoss),
    payoff_ratio: avgWin !== null && avgLoss ? round2(avgWin / avgLoss) : null,
    max_drawdown_r: round2(maxDD),
    recovery_factor: maxDD > 0 ? round2(totalR / maxDD) : null,
    streaks: streaks(closed),
    pnl_total: closed.some(r => r.pnl !== null) ? round2(sum(closed, r => r.pnl ?? 0)) : null,
    mae_mfe: maeMfe(withR),
    skipped: {
      total: skipped.length, reviewed: skipReviewed.length,
      correct: skipReviewed.filter(r => r.skip_correct === 1).length,
      wrong: skipReviewed.filter(r => r.skip_correct === 0).length,
    },
    breakdown: {
      direction: groupStats(closed, r => r.direction ?? '(unset)'),
      symbol: groupStats(closed, r => r.symbol),
      strategy: groupStats(closed, r => r.strategy ?? '(none)'),
      weekday: groupStats(closed.filter(r => r.chart_time), r => weekdayOf(r.chart_time), WEEKDAYS),
      hour: groupStats(closed.filter(r => hasTime(r.chart_time)), r => r.chart_time.slice(11, 13) + ':00').sort((a, b) => a.key.localeCompare(b.key)),
    },
    fields: fieldBreakdowns(db, closed),
    rules: ruleAdherence(db, closed),
    calendar,
    equity_curve: equityCurve,
  };
  stats.edge_score = edgeScore(stats);
  return stats;
}

function fieldBreakdowns(db, closed) {
  const strategyIds = [...new Set(closed.map(r => r.strategy_id).filter(Boolean))];
  const defs = new Map(); // field key → { ...field, owners: strategies defining it }
  for (const id of strategyIds) {
    for (const f of getStrategy(db, id, { includeArchived: true }).fields) {
      if (!f.breakdown || f.type === 'text') continue;
      if (!defs.has(f.key)) defs.set(f.key, { ...f, owners: new Set() });
      defs.get(f.key).owners.add(id);
    }
  }
  return [...defs.values()].map(f => {
    const relevant = closed.filter(r => f.owners.has(r.strategy_id));
    const label = (v) => {
      if (v === undefined || v === null) return '(unset)';
      if (f.type === 'enum') return f.options.find(o => o.value === v)?.label ?? String(v);
      if (f.type === 'bool') return v ? 'yes' : 'no';
      return String(v);
    };
    const keyOf = (r) => {
      const v = r.fields?.[f.key];
      if (f.type === 'number' && v !== undefined && v !== null) return bucket(v);
      return v === undefined || v === null ? '(unset)' : String(v);
    };
    const groups = groupStats(relevant, keyOf).map(g => ({
      ...g, label: f.type === 'number' || g.key === '(unset)' ? g.key : label(f.type === 'bool' ? g.key === 'true' : g.key),
    }));
    if (f.type === 'number') groups.sort((a, b) => bucketStart(a.key) - bucketStart(b.key));
    return { key: f.key, label: f.label, type: f.type, groups };
  }).filter(b => b.groups.some(g => g.key !== '(unset)'));
}

function ruleAdherence(db, closed) {
  if (!closed.length) return { rules: [], followed: null, broken: null };
  const ids = closed.map(r => r.id);
  const checks = db.prepare(`SELECT c.trade_id, c.result, r.key, r.text, r.severity, r.strategy_id, r.position
    FROM trade_rule_checks c JOIN strategy_rules r ON r.id = c.rule_id
    WHERE c.trade_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (!checks.length) return { rules: [], followed: null, broken: null };
  const byId = new Map(closed.map(r => [r.id, r]));

  const perRule = groupBy(checks, c => `${c.strategy_id}:${c.key}`).map(([, cs]) => {
    const pass = cs.filter(c => c.result === 'pass'), failed = cs.filter(c => c.result === 'fail');
    const rOf = (list) => list.map(c => byId.get(c.trade_id)?.result_r).filter(v => v !== null && v !== undefined);
    const passR = rOf(pass), failR = rOf(failed);
    return {
      key: cs[0].key, text: cs[0].text, severity: cs[0].severity, position: cs[0].position,
      checked: pass.length + failed.length, pass: pass.length, fail: failed.length,
      pass_rate: pass.length + failed.length ? round2(pass.length / (pass.length + failed.length) * 100) : null,
      expectancy_when_pass: passR.length ? round2(avg(passR)) : null,
      expectancy_when_fail: failR.length ? round2(avg(failR)) : null,
    };
  }).sort((a, b) => a.position - b.position);

  const tradeBroken = new Map();
  for (const c of checks) {
    if (c.severity !== 'must') continue;
    tradeBroken.set(c.trade_id, (tradeBroken.get(c.trade_id) ?? false) || c.result === 'fail');
  }
  const summarize = (list) => {
    const withR = list.filter(r => r.result_r !== null);
    return {
      trades: list.length,
      win_rate: list.length ? round2(list.filter(r => r.outcome === 'win').length / list.length * 100) : null,
      total_r: round2(sum(withR, r => r.result_r)),
      expectancy_r: withR.length ? round2(sum(withR, r => r.result_r) / withR.length) : null,
    };
  };
  const checked = closed.filter(r => tradeBroken.has(r.id));
  return {
    rules: perRule,
    followed: summarize(checked.filter(r => !tradeBroken.get(r.id))),
    broken: summarize(checked.filter(r => tradeBroken.get(r.id))),
  };
}

/**
 * Edge Score (R1): a 0–100 composite, adapted to R multiples from LuxAlgo's open Edge Score v2
 * (MIT, github.com/LuxAlgo/trade-journal/blob/main/docs/edge-score.md). Withheld under 5 trades.
 */
export function edgeScore(s) {
  const n = s.equity_curve.length;
  if (n < 5) return { version: EDGE_SCORE_VERSION, score: null, trades: n, reason: 'needs at least 5 closed trades with R' };
  const lin = (x, full) => x === null || x === undefined ? 0 : Math.max(0, Math.min(1, x / full)) * 100;
  const dayWins = s.calendar.map(d => d.total_r).filter(r => r > 0);
  const share = dayWins.length ? Math.max(...dayWins) / sum(dayWins, x => x) : 1;
  const components = {
    win_rate: { value: s.win_rate, score: lin(s.win_rate, 60), weight: 15 },
    profit_factor: { value: s.profit_factor, score: s.profit_factor === Infinity ? 100 : lin(s.profit_factor, 3), weight: 25 },
    payoff_ratio: { value: s.payoff_ratio, score: s.payoff_ratio === null ? (s.avg_win_r ? 100 : 0) : lin(s.payoff_ratio, 2.5), weight: 20 },
    drawdown: { value: s.max_drawdown_r, score: Math.max(0, 1 - s.max_drawdown_r / 10) * 100, weight: 15 },
    recovery_factor: { value: s.recovery_factor, score: s.recovery_factor === null ? (s.total_r > 0 ? 100 : 0) : lin(s.recovery_factor, 3), weight: 10 },
    consistency: { value: round2(share), score: share <= 0.15 ? 100 : Math.max(0, (1 - share) / 0.85) * 100, weight: 15 },
  };
  const total = Object.values(components).reduce((a, c) => a + c.score * c.weight, 0) / Object.values(components).reduce((a, c) => a + c.weight, 0);
  for (const c of Object.values(components)) c.score = round2(c.score);
  return { version: EDGE_SCORE_VERSION, score: round2(total), trades: n, components };
}

function streaks(closed) {
  let longestWin = 0, longestLoss = 0, cur = 0, curType = null;
  for (const r of closed) {
    if (r.outcome === 'be') continue;
    if (r.outcome === curType) cur++; else { curType = r.outcome; cur = 1; }
    if (curType === 'win') longestWin = Math.max(longestWin, cur); else longestLoss = Math.max(longestLoss, cur);
  }
  return { longest_win: longestWin, longest_loss: longestLoss, current: curType ? { type: curType, length: cur } : null };
}

function maeMfe(withR) {
  const mae = withR.filter(r => r.mae_r !== null), mfe = withR.filter(r => r.mfe_r !== null);
  if (!mae.length && !mfe.length) return null;
  return {
    trades_with_mae: mae.length, avg_mae_r: mae.length ? round2(avg(mae.map(r => r.mae_r))) : null,
    trades_with_mfe: mfe.length, avg_mfe_r: mfe.length ? round2(avg(mfe.map(r => r.mfe_r))) : null,
    // Winners that went further than the target: how much R was left on the table on average.
    avg_left_on_table_r: mfe.filter(r => r.result_r > 0).length
      ? round2(avg(mfe.filter(r => r.result_r > 0).map(r => r.mfe_r - r.result_r))) : null,
  };
}

function groupStats(list, keyFn, order) {
  const out = groupBy(list, keyFn).map(([key, rs]) => {
    const w = rs.filter(r => r.outcome === 'win').length;
    const withR = rs.filter(r => r.result_r !== null);
    const total = sum(withR, r => r.result_r);
    return { key, trades: rs.length, wins: w, win_rate: round2(w / rs.length * 100), total_r: round2(total),
      expectancy_r: withR.length ? round2(total / withR.length) : null };
  });
  return order ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : out.sort((a, b) => b.trades - a.trades);
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return [...m.entries()];
}

function bucket(v) {
  const edges = [0, 0.25, 0.5, 0.618, 0.75, 1, 1.5, 2, 3, 5, 10];
  if (v < 0) return '< 0';
  for (let i = 1; i < edges.length; i++) if (v < edges[i]) return `${edges[i - 1]}–${edges[i]}`;
  return `≥ ${edges.at(-1)}`;
}

function bucketStart(key) {
  if (key === '< 0') return -Infinity;
  if (key === '(unset)') return Infinity;
  return parseFloat(key.replace('≥ ', ''));
}

const hasTime =(s) => typeof s === 'string' && /\d{2}:\d{2}/.test(s.slice(10));
function weekdayOf(s) {
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00Z');
  return isNaN(d) ? '(unknown)' : WEEKDAYS[d.getUTCDay()];
}
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const avg = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
