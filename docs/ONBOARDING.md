# Onboarding interview (for the AI agent)

You are setting up a trading journal **around this specific trader**: their markets, their risk rules and their strategy. There is no generic setup. What you save here decides what every later trade is measured against.

The same text is available from the MCP tool `get_onboarding_guide` and the MCP prompt `onboarding`.

## Ground rules

- **Speak the user's language.** Detect it from their first message, confirm it, and save it as the profile key `language`. Field labels and rule texts can be in their language; keys stay `snake_case` ASCII.
- **One topic per turn, at most 3 questions per message.** Give 2–4 example answers so they can reply fast. Accept "skip" and move on.
- **Use their words.** Don't upgrade a vague answer into a precise-sounding rule. When you must turn their answer into something measurable, say so, and mark it `(assumption — confirm)`.
- **Never promise results** or judge whether a strategy is profitable. The journal exists to find that out.
- **Save as you go.** Call `set_profile` after Phase 1 and `upsert_account` after Phase 2, so a dropped conversation doesn't lose everything. Save the strategy only after the user confirms the summary in Phase 5.
- If `get_setup_status` shows the user already onboarded, don't restart. Ask what changed and update only that part.

## Phase 0: Start

1. Call `get_setup_status`.
2. Say in 2 sentences what will happen: "I'll ask about how you trade (about 10 minutes), then set up your journal so I can log trades from your chart screenshots and check them against your own rules."
3. Call `list_presets`. If a preset looks close to what they describe, offer it as a **starting point to edit**, never as the answer.

## Phase 1: The trader (→ `set_profile`)

Ask, grouped over 2–3 messages:

| Profile key | Question | Example answers |
|---|---|---|
| `language` | Which language should we use? | English / Español / Deutsch |
| `markets` | What do you trade? | EURUSD, GBPJPY / NQ futures / BTC perps / US stocks |
| `style` | How long do you usually hold a trade? | scalp (minutes) / intraday (hours) / swing (days) |
| `sessions` | When do you trade, and in which timezone? | New York open, 9:30–11:30, US Eastern |
| `timezone` | (from the answer above, as an IANA name) | America/New_York |
| `experience` | How long have you been trading, and what's your status? | 6 months, still backtesting / 3 years, funded account |
| `goals` | What do you want from this journal in the next 1–3 months? | pass a prop challenge / prove the strategy on 100 backtest trades / stop revenge trading |
| `weaknesses` | What mistakes do you catch yourself making? | moving SL, entering before confirmation, overtrading after a loss |

Save with `set_profile`. Keep answers as short strings in the user's words.

## Phase 2: Accounts and risk (→ `upsert_account`)

Ask:

1. Where do you trade? (personal live, demo, prop firm challenge, or backtest only)
2. For each real account:
   - **Risk per trade** in % of balance (`risk_per_trade_pct`).
   - **Daily loss limit** (`max_daily_loss_pct`) and **max drawdown** (`max_total_drawdown_pct`). For a prop firm, ask for the firm's numbers **and** the user's own stricter numbers. Save the stricter one and note the firm's in `notes`.
   - Profit target (`profit_target_pct`), if any.
   - Personal stop rules: max trades per day (`max_trades_per_day`), stop after N losses in a row (`max_consecutive_losses`).
   - Currency and starting balance (optional).

If they only backtest for now, skip accounts entirely. Sessions work without one.

## Phase 3: The strategy (→ `plan` in `upsert_strategy`)

Walk through the trade from the top down. Ask each block separately and write their answer into the matching `plan` key.

| `plan` key | Ask |
|---|---|
| `summary` | In one or two sentences: what is your edge, and why should it work? |
| `timeframes` (top-level `timeframes`) | Which timeframes do you use, and for what? (e.g. H4 bias, M15 setup, M1 entry) |
| `bias` | How do you decide direction? What must be true before you look for longs or shorts? |
| `setup` | What does a valid setup look like? Where do you wait for price? (a level, a pattern, a zone) |
| `entry` | What exactly triggers the entry? Market or limit order? |
| `stop` | Where does the stop go, and why there? |
| `targets` | How do you take profit? Fixed RR, a level, partials? |
| `management` | Do you move to breakeven, trail, or take partials? When? |
| `no_trade` | When do you NOT trade? (news, time of day, after X losses, when the chart looks like …) |

Useful follow-ups:
- "Show me or describe your last 2–3 trades: why did you take them?" This works well when answers are vague.
- "What would make you skip a setup that otherwise looks valid?"

If they trade several strategies, finish one completely first, then ask whether to add the next.

## Phase 4: Turn the plan into measurements

Propose these to the user; don't decide alone.

### Fields: what varies from trade to trade
Fields are the variables you will later **break results down by** ("my win rate on setup A vs B"). Propose **3–8**:

- Prefer `enum` with 2–6 options. Example: `setup_type: [breakout, pullback, reversal]`, `session: [asia, london, ny]`.
- Use `bool` for yes/no conditions the user **suspects** matter but doesn't require. Example: `news_nearby`, `gap_filled`.
- Use `number` for continuous values. Example: `fib_level`, `atr_multiple`.
- Use `text` rarely; text is not broken down.
- Each field needs a `guide`: how you (the agent) read it from a chart screenshot. If it can't be read from a chart, the guide says "ask the user".
- Mark `required: true` only for what must be known on every trade.

### Rules: the entry checklist
Rules are what the user **says must be true** before entering. Each trade later gets `pass | fail | na` per rule, and the stats compare results when rules are followed against when they are broken. Propose **4–10**:

- Each rule is **binary and checkable** from a screenshot or a simple question. "Price closed above the 20 EMA for longs" is checkable. "The market feels strong" is not; rewrite it or drop it.
- Use `severity: must` for hard rules and `should` for preferences.
- Include risk and discipline rules that aren't visible on a chart, such as "risk ≤ 1%" or "not the 3rd trade today". The guide for these says "ask the user or check with check_risk".

Fields vs rules: a rule is "must be true", a field is "I want to know whether it matters". If the user is unsure whether something is required, make it a field first. It can become a rule once the data shows it matters.

## Phase 5: Confirm and save

1. Show a compact summary in the user's language: profile (5 lines), account limits, strategy plan (1 line per block), fields table (key, label, type, options) and rules list (must/should).
2. Ask: "Anything to change?" Iterate until they confirm.
3. Call `upsert_strategy` with the full definition (the same JSON shape as `presets/*.json`). Pick a short `slug`.
4. Optionally export it for them with `export_strategy` so they can keep or share the file.

## Phase 6: First use

1. Explain the daily loop in 3 bullets:
   - Start a session: "start a backtest session on NQ".
   - Paste a screenshot per trade (or per skipped setup): I read it, fill fields, check rules, log it, and attach the image.
   - Ask for a review any time: "review this week".
2. Offer to start the dashboard (`start_dashboard`).
3. Offer a dry run: log one example trade from a screenshot they have, then delete it if it was only a test (`delete_trade`).

## Updating later

- Strategy changed? Call `upsert_strategy` again with the same `slug`. When fields or rules change, the version bumps automatically, and old trades keep the version they were logged under. Removed fields and rules are archived, not deleted.
- New account or new limits? Call `upsert_account` with the same name.
- A new insight (from reviews or lessons) that should become a rule? Propose it and get a yes before changing the strategy.
