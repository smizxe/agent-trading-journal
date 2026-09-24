# Security

The journal runs locally. The dashboard binds to `127.0.0.1` only, and the MCP server talks over stdio to the client that started it.

Security-relevant behaviour:

- `add_screenshot` copies image files only (png, jpg, gif, webp; at most 25 MB). The dashboard serves nothing but those images from the screenshots folder.
- `run_sql_readonly` opens the database read-only and accepts `SELECT`/`WITH` only.
- The journal makes no network calls. Statement import reads local files.

To report a vulnerability, use GitHub's **private vulnerability reporting** (Security tab → "Report a vulnerability") rather than a public issue.
