# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/smizxe/agent-trading-journal
cd agent-trading-journal
npm install
npm test          # domain tests + end-to-end MCP test over stdio
npm run demo      # demo data in a separate folder + dashboard on :3777
```

Node ≥ 22, plain ESM JavaScript, no build step. See [AGENTS.md](AGENTS.md) for the layout. It is written for AI coding agents, but works just as well for humans.

## Good first contributions

- **Presets**: a new `presets/*.json` for a widely known, public strategy style. Keep it textbook, since presets are starting points, not signals. Every field needs a `guide` explaining how an agent reads it from a chart.
- **Onboarding**: improvements to [docs/ONBOARDING.md](docs/ONBOARDING.md), such as better questions or clearer steps for turning answers into fields and rules.
- **Dashboard translations**: add a language to the `I18N` object in `public/index.html`.
- **Import formats**: parsing lives upstream in [`@luxalgo/journal-importers`](https://github.com/LuxAlgo/trade-journal). Broker format fixes belong there.

## Rules

- A new behaviour comes with a test.
- Schema changes go in a new entry appended to `MIGRATIONS` in `src/db.js`. Never edit a shipped migration.
- Strategy-specific logic doesn't go in code. It goes in a strategy definition.
- MCP tool descriptions are read by agents, so keep them short and exact.
- No performance claims in docs or presets.
