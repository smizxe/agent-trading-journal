#!/usr/bin/env node
// agent-trading-journal CLI. No arguments = run the MCP server over stdio (what MCP clients spawn).
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const [cmd = 'mcp', ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : undefined; };
const cliPath = fileURLToPath(import.meta.url);

const HELP = `agent-trading-journal — AI-agent-native trading journal (MCP server + local dashboard)

Usage:
  agent-trading-journal [mcp]              run the MCP server on stdio (used by Claude Code / Codex / any MCP client)
  agent-trading-journal dashboard          start the dashboard at http://localhost:3777 (JOURNAL_PORT to change)
  agent-trading-journal demo               fill a separate demo data dir with synthetic trades and open the dashboard
  agent-trading-journal import <file> --account <name> [--strategy <slug>] [--dry-run]
  agent-trading-journal setup              print config snippets for Claude Code, Claude Desktop and Codex

Data: JOURNAL_DATA_DIR (default ~/.agent-trading-journal) holds journal.db + screenshots/.`;

switch (cmd) {
  case 'mcp': {
    const { runMcp } = await import('../src/mcp.js');
    await runMcp();
    break;
  }
  case 'dashboard': {
    const { startWeb } = await import('../src/web.js');
    const r = await startWeb();
    if (!r.ok) { console.error(`Could not start dashboard: ${r.reason}`); process.exit(1); }
    console.log(`Dashboard: ${r.url}  (Ctrl+C to stop)`);
    break;
  }
  case 'demo': {
    process.env.JOURNAL_DATA_DIR ||= path.join(os.homedir(), '.agent-trading-journal-demo');
    const { openDb } = await import('../src/db.js');
    const { seedDemo } = await import('../src/demo.js');
    const db = openDb();
    const hasData = db.prepare('SELECT COUNT(*) AS n FROM trades').get().n > 0;
    if (!hasData) console.log('Seeded demo data:', seedDemo(db));
    db.close();
    console.log(`Demo data dir: ${process.env.JOURNAL_DATA_DIR}`);
    if (!flag('no-serve')) {
      const { startWeb } = await import('../src/web.js');
      const r = await startWeb();
      console.log(r.ok ? `Dashboard: ${r.url}  (Ctrl+C to stop)` : `Could not start dashboard: ${r.reason}`);
    }
    break;
  }
  case 'import': {
    const account = flag('account');
    if (!rest[0] || rest[0].startsWith('--') || !account) { console.error('Usage: agent-trading-journal import <file> --account <name> [--strategy <slug>] [--dry-run]'); process.exit(1); }
    const { openDb } = await import('../src/db.js');
    const { importStatement } = await import('../src/importer.js');
    try {
      console.log(JSON.stringify(importStatement(openDb(), { path: rest[0], account, strategy: flag('strategy'), mode: flag('mode'), dry_run: !!flag('dry-run') }), null, 2));
    } catch (e) { console.error(`Import failed: ${e.message}`); process.exit(1); }
    break;
  }
  case 'setup': {
    const node = process.execPath.replace(/\\/g, '/');
    const script = cliPath.replace(/\\/g, '/');
    console.log(`# Claude Code (project .mcp.json, or: claude mcp add journal -- npx -y agent-trading-journal)
{
  "mcpServers": {
    "journal": { "type": "stdio", "command": "npx", "args": ["-y", "agent-trading-journal"] }
  }
}

# Local checkout instead of npx
{ "command": "${node}", "args": ["${script}"] }

# Claude Desktop (claude_desktop_config.json) — same "mcpServers" block as above.

# Codex CLI (~/.codex/config.toml)
[mcp_servers.journal]
command = "npx"
args = ["-y", "agent-trading-journal"]
# env = { JOURNAL_DATA_DIR = "/path/to/your/journal-data" }

Then tell your agent: "set up my trading journal" — it will run the onboarding interview.`);
    break;
  }
  case '--version': case '-v': {
    const { readFileSync } = await import('node:fs');
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    break;
  }
  default:
    console.log(HELP);
    if (!['help', '--help', '-h'].includes(cmd)) process.exit(1);
}
