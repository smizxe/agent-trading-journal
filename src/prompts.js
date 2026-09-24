// Packaged agent workflows. Exposed as MCP prompts (slash commands in clients that support them)
// and as plain text through the get_workflow tool for clients that don't.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './db.js';

export const onboardingGuide = () => fs.readFileSync(path.join(APP_DIR, 'docs', 'ONBOARDING.md'), 'utf8');

export const WORKFLOWS = {
  onboarding: {
    title: 'Onboard: set the journal up around your trading',
    description: 'Interview the trader (profile, accounts & risk, strategy) and save a strategy with fields + rules.',
    text: () => onboardingGuide(),
  },
  log_trade_from_screenshot: {
    title: 'Log a trade from a chart screenshot',
    description: 'Read the screenshot, fill strategy fields, check every rule, log the trade and attach the image.',
    text: () => `Log the trade (or skipped setup) the user just shared.

1. If no session is open for this symbol/day, ask whether to start one (start_session: mode backtest/forward/live, strategy, account).
2. Call get_strategy for the session's strategy. Read its fields (with guides) and rules.
3. Read the screenshot(s). For every field, fill what you can SEE; ask the user only for what isn't visible (keep it to 1 short message).
4. For every rule, decide pass / fail / na. When a rule fails, say which one and why, in one line each. Don't soften it.
5. Prices: entry, sl, tp (tp2 if any). The tool derives RR, and R from exit_price when given.
6. Call log_trade (status=skipped + skip_reason if they stayed out). Then add_screenshot for each image, using the absolute file path.
7. Reply with a 3-line summary: setup, rule result (x/y must-rules passed), anything suspicious. If a lesson stands out, propose it; call add_lesson only if the user agrees.
Separate what is on the chart (fact) from your reading of it (interpretation).`,
  },
  weekly_review: {
    title: 'Weekly review',
    description: 'Stats, rule adherence and field breakdowns for the last 7 days (or a given range), then 3 concrete takeaways.',
    text: () => `Run a review for the last 7 days (or the range the user gives).

1. get_stats with from/to (plus strategy/account/mode if relevant).
2. Report: closed trades, win rate, total R, expectancy, max drawdown, Edge Score (explain it's withheld under 5 trades).
3. Rule adherence: compare "all must-rules followed" with "at least one broken". Name the most-broken rule and its cost in R.
4. Field breakdowns: point out the best and worst value per field, but only when each group has 5 or more trades. Otherwise say the sample is too small.
5. Skipped setups: how many were reviewed, and whether skipping was right.
6. Give 3 takeaways, each tied to a number. Propose at most 1 strategy change (a new rule, or a field promoted to a rule) and ask before changing anything.
7. Offer export_review to save the review as Markdown.
Small samples: say so plainly. Don't turn 4 trades into a conclusion.`,
  },
  pre_session_check: {
    title: 'Pre-session check',
    description: 'Before trading: account limits, recent streak, last lessons and today\'s rules.',
    text: () => `Before the user trades today:

1. check_risk for their account (ask which one if there are several). If status is "stop", say it first and clearly.
2. list_lessons (latest 5 for this strategy). Pick the 2 most relevant to today.
3. get_strategy: list the must-rules as a short checklist and the no_trade conditions from the plan.
4. Ask one question: "Anything today that puts you in a no-trade condition (news, fatigue, tilt)?"
Keep the whole message under 15 lines.`,
  },
};
