// Statement import: broker/platform exports → round-trip trades, using LuxAlgo's MIT-licensed
// parsers (@luxalgo/journal-importers) and round-trip engine (@luxalgo/journal-core).
// Imported trades carry exact prices/P&L; the agent then enriches them (fields, rules, screenshots).
import fs from 'node:fs';
import path from 'node:path';
import { parseAuto, FORMATS } from '@luxalgo/journal-importers';
import { buildRoundTrips } from '@luxalgo/journal-core';
import { JournalError, resolveAccount, resolveStrategy, getProfile, logTrade, round2 } from './journal.js';

export const SUPPORTED_FORMATS = FORMATS.map(f => f.label ?? f.id);

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  // MetaTrader HTML reports are often UTF-16LE without BOM: every second byte is 0.
  const sample = buf.subarray(0, 400);
  const zeros = sample.filter((b, i) => i % 2 === 1 && b === 0).length;
  return zeros > sample.length / 4 ? buf.toString('utf16le') : buf.toString('utf8');
}

/** Wall-clock "YYYY-MM-DD HH:mm" in the trader's timezone, so weekday/hour stats match how they experience the day. */
function localTime(iso, timeZone) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function importStatement(db, a) {
  const file = path.resolve(a.path);
  if (!fs.existsSync(file)) throw new JournalError(`file not found: ${file}`);
  const account = resolveAccount(db, a.account, { create: true }) ?? (() => { throw new JournalError('account is required'); })();
  const strategy = a.strategy ? resolveStrategy(db, a.strategy) : null;
  const timeZone = a.timezone || getProfile(db).timezone || 'UTC';

  const parsed = parseAuto(readText(file), { timeZone: a.file_timezone || timeZone, fileName: path.basename(file), symbol: a.symbol });
  if (!parsed) throw new JournalError(`format not recognised. Supported: ${SUPPORTED_FORMATS.join(', ')}.`);
  if (parsed.errors?.length) throw new JournalError(`the file can't be imported safely: ${parsed.errors.join('; ')}`);
  if (parsed.needsSymbol && !a.symbol) throw new JournalError('this export has no symbol column — pass symbol');

  const executions = parsed.executions.map((e, i) => ({ ...e, id: `imp-${i}`, accountId: account.name, source: 'import' }));
  const trips = buildRoundTrips(executions, a.multipliers ? { multipliers: a.multipliers } : {});
  const closed = trips.filter(t => t.status !== 'open');

  const riskMoney = account.starting_balance && account.risk_per_trade_pct ? account.starting_balance * account.risk_per_trade_pct / 100 : null;
  const exists = db.prepare('SELECT 1 FROM trades WHERE external_key = ?');
  const plan = closed.map(t => {
    const externalKey = `import:${account.name}:${t.key}`;
    const chartTime = localTime(t.openedAt, timeZone);
    const r = riskMoney ? round2(t.netPnl / riskMoney) : null;
    return {
      duplicate: !!exists.get(externalKey),
      session: { date: chartTime.slice(0, 10), symbol: t.symbol },
      trade: {
        external_key: externalKey, source: 'import', status: 'taken',
        direction: t.direction === 'long' ? 'buy' : 'sell',
        chart_time: chartTime, closed_at: t.closedAt ? localTime(t.closedAt, timeZone) : null,
        entry: t.avgEntry, exit_price: t.avgExit ?? null, quantity: t.quantity,
        pnl: round2(t.netPnl), result_r: r,
        outcome: t.status === 'win' ? 'win' : t.status === 'loss' ? 'loss' : 'be',
      },
    };
  });
  const fresh = plan.filter(p => !p.duplicate);
  const summary = {
    format: parsed.format, executions: executions.length, round_trips: trips.length,
    closed: closed.length, open_positions: trips.length - closed.length,
    new_trades: fresh.length, duplicates: plan.length - fresh.length,
    skipped_rows: parsed.skippedRows, warnings: parsed.warnings,
    r_multiple: riskMoney ? `result_r = net P&L / ${round2(riskMoney)} (starting_balance × risk_per_trade_pct)`
      : 'result_r left empty — set starting_balance + risk_per_trade_pct on the account, or add sl per trade (update_trade) to get R',
  };
  if (a.dry_run) return { dry_run: true, ...summary, preview: fresh.slice(0, 5).map(p => p.trade) };

  const sessionIds = new Map();
  const findSession = db.prepare(`SELECT id FROM sessions WHERE account_id = ? AND mode = ? AND date = ? AND symbol = ? AND tool_version = 'import'`);
  const insertSession = db.prepare(`INSERT INTO sessions (date, mode, symbol, strategy_id, account_id, tool_version, notes)
    VALUES (?, ?, ?, ?, ?, 'import', ?)`);
  const mode = a.mode || 'live';
  const imported = db.transaction(() => fresh.map(p => {
    const k = `${p.session.date}|${p.session.symbol}`;
    if (!sessionIds.has(k)) {
      const row = findSession.get(account.id, mode, p.session.date, p.session.symbol);
      sessionIds.set(k, row?.id ?? Number(insertSession.run(p.session.date, mode, p.session.symbol, strategy?.id ?? null, account.id,
        `Imported from ${parsed.format} (${path.basename(file)})`).lastInsertRowid));
    }
    return logTrade(db, { ...p.trade, session_id: sessionIds.get(k), strategy: strategy?.slug }).trade_id;
  }))();
  return { ...summary, imported: imported.length, trade_ids: imported, session_ids: [...new Set(sessionIds.values())],
    next: 'Ask the user for screenshots of the imported trades to fill strategy fields and rule checks (update_trade).' };
}
