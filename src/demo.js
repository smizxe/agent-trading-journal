// Synthetic demo data (deterministic) so a new user sees a filled dashboard before logging anything real.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './db.js';
import * as J from './journal.js';

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export function seedDemo(db, { days = 60 } = {}) {
  if (db.prepare('SELECT COUNT(*) AS n FROM trades').get().n) throw new J.JournalError('this journal already has trades — seed demo data into an empty data dir (JOURNAL_DATA_DIR)');
  const rand = rng(42);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];

  J.setProfile(db, {
    language: 'English', markets: 'EURUSD, GBPUSD, USDJPY', style: 'intraday', sessions: 'London + New York',
    timezone: 'Europe/London', experience: 'Demo profile', goals: 'Prove the pullback strategy over 100 trades', demo: true,
  });
  const preset = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'presets', 'trend-pullback.json'), 'utf8'));
  const st = J.upsertStrategy(db, preset);
  J.upsertAccount(db, { name: 'Demo Prop 10K', type: 'prop', currency: 'USD', starting_balance: 10000, risk_per_trade_pct: 0.5,
    max_daily_loss_pct: 4, max_total_drawdown_pct: 8, profit_target_pct: 8, max_trades_per_day: 3, max_consecutive_losses: 3,
    notes: 'Fictional account for the demo' });

  const symbols = ['EURUSD', 'GBPUSD', 'USDJPY'];
  const start = new Date(); start.setUTCDate(start.getUTCDate() - days);
  let trades = 0;
  for (let d = 0; d < days; d++) {
    const date = new Date(start); date.setUTCDate(start.getUTCDate() + d);
    if ([0, 6].includes(date.getUTCDay()) || rand() < 0.25) continue;
    const day = date.toISOString().slice(0, 10);
    const mode = d < days * 0.4 ? 'backtest' : 'live';
    const symbol = pick(symbols);
    const { session_id } = J.startSession(db, { date: day, symbol, mode, strategy: st.slug, account: mode === 'live' ? 'Demo Prop 10K' : undefined, timeframes: 'H4 / H1' });
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const hour = String(7 + Math.floor(rand() * 10)).padStart(2, '0');
      const fields = {
        pullback_to: pick(['ema20', 'ema20', 'ema50', 'structure']), trigger: pick(['engulfing', 'pin_bar', 'break_of_high']),
        trend_strength: pick(['strong', 'strong', 'moderate', 'weak']), pullback_depth_pct: Math.round((0.2 + rand() * 0.6) * 100) / 100,
      };
      if (rand() < 0.12) {
        J.logTrade(db, { session_id, status: 'skipped', chart_time: `${day} ${hour}:15`, fields,
          skip_reason: pick(['News in 20 minutes', 'Trend not clear on H4', 'Already 2 trades today']), skip_correct: rand() < 0.7 });
        continue;
      }
      const rules = { trend_defined: rand() < 0.85 ? 'pass' : 'fail', with_trend: rand() < 0.9 ? 'pass' : 'fail',
        trigger_closed: rand() < 0.8 ? 'pass' : 'fail', min_rr: 'pass', no_news: rand() < 0.85 ? 'pass' : 'fail' };
      const broken = Object.entries(rules).filter(([k, v]) => v === 'fail' && k !== 'no_news').length;
      let pWin = 0.46 - broken * 0.15 + (fields.trend_strength === 'strong' ? 0.08 : fields.trend_strength === 'weak' ? -0.12 : 0);
      const roll = rand();
      const rr = Math.round((1.5 + rand() * 1.5) * 10) / 10;
      const result_r = roll < pWin ? rr : roll < pWin + 0.08 ? 0 : -1;
      const direction = rand() < 0.55 ? 'buy' : 'sell';
      const entry = symbol === 'USDJPY' ? 145 + rand() * 10 : 1.05 + rand() * 0.2;
      const riskDist = symbol === 'USDJPY' ? 0.15 + rand() * 0.2 : 0.001 + rand() * 0.002;
      const sgn = direction === 'buy' ? 1 : -1;
      J.logTrade(db, {
        session_id, direction, chart_time: `${day} ${hour}:${pick(['05', '20', '35', '50'])}`, fields, rules,
        entry: round(entry), sl: round(entry - sgn * riskDist), tp: round(entry + sgn * riskDist * rr), result_r,
        mae_r: Math.round(rand() * (result_r < 0 ? 1 : 0.8) * 100) / 100,
        mfe_r: Math.round((result_r > 0 ? rr + rand() * 1.5 : rand() * 1.2) * 100) / 100,
        moved_be: result_r === 0, mistakes: broken ? pick(['Entered before candle close', 'Traded against the H4 trend']) : undefined,
      });
      trades++;
    }
  }
  const firstLoss = db.prepare("SELECT id FROM trades WHERE outcome = 'loss' ORDER BY id LIMIT 1").get();
  J.addLesson(db, { category: 'discipline', text: 'Wait for the trigger candle to close. Early entries show up again and again in the broken-rule trades.', trade_id: firstLoss?.id });
  J.addLesson(db, { category: 'strategy', text: 'Weak trends drag expectancy down: consider making "strong or moderate trend" a must-rule.', strategy: st.slug });
  return { trades, strategy: st.slug, account: 'Demo Prop 10K' };
}

const round = (x) => Math.round(x * 100000) / 100000;
