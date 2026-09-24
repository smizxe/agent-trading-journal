# Changelog

## 0.1.0 (2026-09-24)

First public release.

- MCP server with 32 tools and 4 workflow prompts (onboarding, log trade from screenshot, weekly review, pre-session check).
- Onboarding interview that turns the trader's own strategy into custom fields and a rule checklist; strategies are versioned.
- R-based stats: per-field breakdowns, rule adherence (expectancy when rules are followed vs broken), daily calendar, streaks, MAE/MFE, Edge Score R1.
- Account risk guard for prop-firm style limits (`check_risk`).
- Statement import (MetaTrader 4/5, TradingView, IBKR, NinjaTrader, Tradovate and more) via `@luxalgo/journal-importers`.
- Markdown review export; local dashboard (EN/VI); demo data; CLI (`mcp`, `dashboard`, `demo`, `import`, `setup`).
