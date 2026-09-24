# Agent instructions: Agent Trading Journal

These instructions cover two cases: an AI agent using the journal as its tool (Codex, Claude Code, any MCP client), and an agent developing this repo.

## Using the journal (MCP tools)

- **First call**: `get_setup_status`. If `onboarded` is false, run the onboarding interview in [docs/ONBOARDING.md](docs/ONBOARDING.md) (also available as the `get_onboarding_guide` tool and the `onboarding` MCP prompt). Don't log trades before the user has a strategy, unless they explicitly want to journal without one.
- **Before logging**: call `get_strategy` for the session's strategy. Use only its field keys and rule keys. If a value doesn't fit an option, ask the user; never invent a key.
- **Per trade**: read the screenshot, fill the fields you can see, check every rule (`pass` / `fail` / `na`), log it with `log_trade`, and attach images with `add_screenshot`. Skipped setups are logged too (`status: "skipped"` + `skip_reason`).
- **Workflows**: `get_workflow` returns step-by-step instructions for `log_trade_from_screenshot`, `weekly_review` and `pre_session_check`.
- **Honesty**: separate facts on the chart from your interpretation. Call out small samples. The journal is analysis only; the user makes every trading decision.

## Developing this repo

- Node ≥ 22, ESM, no build step. `npm test` runs domain tests plus an end-to-end MCP test over stdio.
- Layout:

| Path | Role |
|---|---|
| `src/db.js` | SQLite schema + migrations; data dir resolution (`JOURNAL_DATA_DIR`) |
| `src/journal.js` | domain layer: profile, strategies (fields/rules), accounts, sessions, trades, lessons. All writes go through here |
| `src/stats.js` | R-based analytics, field breakdowns, rule adherence, Edge Score |
| `src/risk.js` | account limit guard |
| `src/importer.js` | broker statement import via `@luxalgo/journal-importers` |
| `src/review.js` | Markdown review export |
| `src/prompts.js` + `docs/ONBOARDING.md` | agent workflows / MCP prompts |
| `src/mcp.js` | MCP server (tools, prompts, server instructions) |
| `src/web.js` + `public/index.html` | local dashboard (vanilla JS, EN/VI) |
| `presets/*.json` | example strategies (same format as `export_strategy`) |

- Rules of thumb:
  - A new behaviour gets a test.
  - Schema changes are new entries appended to `MIGRATIONS`; never edit a shipped migration.
  - Strategy-specific logic never goes in code. It belongs in a strategy definition.
  - Tool descriptions are part of the product: an agent reads them, so keep them short and exact.
