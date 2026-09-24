// Account guard: compares today's results against the account's own limits (prop-firm style rules).
// Estimates only — R × risk% approximates the balance change; the broker/prop firm dashboard is the source of truth.
import { resolveAccount, round2 } from './journal.js';

export function checkRisk(db, accountName, date = new Date().toISOString().slice(0, 10)) {
  const acc = resolveAccount(db, accountName);
  const trades = db.prepare(`
    SELECT t.*, COALESCE(substr(t.chart_time, 1, 10), s.date) AS trade_date
    FROM trades t JOIN sessions s ON s.id = t.session_id
    WHERE s.account_id = ? AND t.status = 'taken'
    ORDER BY trade_date, t.chart_time, t.id`).all(acc.id);

  const today = trades.filter(t => t.trade_date === date);
  const closedToday = today.filter(t => t.outcome !== null);
  const dayR = closedToday.reduce((a, t) => a + (t.result_r ?? 0), 0);
  const cumR = trades.filter(t => t.outcome !== null).reduce((a, t) => a + (t.result_r ?? 0), 0);
  let lossStreak = 0;
  for (const t of [...trades].reverse()) { if (t.outcome === null || t.outcome === 'be') continue; if (t.outcome === 'loss') lossStreak++; else break; }

  const riskPct = acc.risk_per_trade_pct;
  const pct = (r) => riskPct ? round2(r * riskPct) : null;
  const dayPct = pct(dayR), totalPct = pct(cumR);
  const alerts = [];
  let status = 'ok';
  const flag = (level, msg) => { alerts.push({ level, msg }); if (level === 'stop' || (level === 'caution' && status === 'ok')) status = level; };

  if (acc.max_daily_loss_pct && dayPct !== null) {
    const used = -Math.min(0, dayPct) / acc.max_daily_loss_pct;
    if (used >= 1) flag('stop', `daily loss limit hit: ${dayPct}% vs −${acc.max_daily_loss_pct}%`);
    else if (used >= 0.5) flag('caution', `used ${Math.round(used * 100)}% of the daily loss limit (${dayPct}% of −${acc.max_daily_loss_pct}%)`);
    const roomTrades = riskPct ? Math.floor((acc.max_daily_loss_pct + Math.min(0, dayPct)) / riskPct) : null;
    if (roomTrades !== null && used < 1) alerts.push({ level: 'info', msg: `room today: about ${roomTrades} more full-risk loss(es) before the daily limit` });
  }
  if (acc.max_total_drawdown_pct && totalPct !== null) {
    const used = -Math.min(0, totalPct) / acc.max_total_drawdown_pct;
    if (used >= 1) flag('stop', `max drawdown hit: ${totalPct}% vs −${acc.max_total_drawdown_pct}%`);
    else if (used >= 0.5) flag('caution', `used ${Math.round(used * 100)}% of max drawdown (${totalPct}% of −${acc.max_total_drawdown_pct}%)`);
  }
  if (acc.max_trades_per_day && today.length >= acc.max_trades_per_day) flag('stop', `max trades per day reached (${today.length}/${acc.max_trades_per_day})`);
  if (acc.max_consecutive_losses && lossStreak >= acc.max_consecutive_losses) flag('stop', `${lossStreak} losses in a row — your rule says stop at ${acc.max_consecutive_losses}`);
  if (!riskPct && (acc.max_daily_loss_pct || acc.max_total_drawdown_pct)) alerts.push({ level: 'info', msg: 'set risk_per_trade_pct on the account to convert R into % for the loss limits' });

  return {
    account: acc.name, date, status, alerts,
    today: { trades: today.length, closed: closedToday.length, open: today.length - closedToday.length, r: round2(dayR), pct: dayPct },
    overall: { r: round2(cumR), pct: totalPct, loss_streak: lossStreak,
      profit_target_progress: acc.profit_target_pct && totalPct !== null ? round2(totalPct / acc.profit_target_pct * 100) : null },
    limits: {
      risk_per_trade_pct: riskPct, max_daily_loss_pct: acc.max_daily_loss_pct, max_total_drawdown_pct: acc.max_total_drawdown_pct,
      profit_target_pct: acc.profit_target_pct, max_trades_per_day: acc.max_trades_per_day, max_consecutive_losses: acc.max_consecutive_losses,
    },
    note: 'Estimate from logged trades (R × risk%). Check the broker/prop-firm dashboard before acting.',
  };
}
