# Changelog

## 0.1.0 (first public release)

- Idempotent, append-only usage ledger built from local Claude Code transcripts (main and subagent sessions)
- Buckets by folder glob, with a default bucket and per-session override (`/budget set`)
- Daily / weekly / monthly budgets with reset days, warn threshold, and warn or block mode
- Weighted API-equivalent metric (configurable weights), or raw / output tokens
- UserPromptSubmit warnings and blocking; `/budget extend` for one-off increases
- Status line with chaining of an existing status line
- `/budget status`, `usage`, `rebucket`, `init`, `statusline install|uninstall`
- `spend` skill so Claude can answer questions about your usage
- Optional sync-folder mode: one ledger file per machine, conflict-copy and name-collision detection
- No dependencies, no network, no telemetry
