# Changelog

## 0.4.0 (tokenjar) / 0.2.1 (tokenjar-pane)

- `/budget rename <old> <new>` renames a bucket and keeps its history: past usage, `/budget set` choices
  and extensions move to the new name (recorded in the ledger, so it applies on synced machines too). It
  also works after renaming by hand, and updates `default_bucket` when that named the old bucket
- `/budget status` and the pane point out a bucket that has usage but is no longer in `budgets.yaml`, and a
  `default_bucket` that is not listed under `buckets`

## 0.3.0 (tokenjar) / 0.2.0 (tokenjar-pane)

- New optional `tokenjar-pane` plugin: a live pane beside the chat with every bucket, plan weekly / 5-hour
  bars, and buttons: use here, back to folder rules, extend, refresh, new bucket, edit budgets
- The pane passes the plan % to tokenjar on every surface, so `% of plan` limits calibrate in the VS Code
  panel too (no status line needed)
- `/budget add` adds a bucket to `budgets.yaml` without touching the rest of the file; `/budget edit` opens it
- `/budget status`, the pane and `/budget add` show how much of the weekly plan your limits add up to,
  and warn when it is more than 100%
- Fix: `/budget extend` now works on `% of plan` buckets once they are calibrated
- tokenjar keeps a stable `cli.js` launcher in its config folder for the pane

## 0.2.0

- Relate budgets to the Claude plan: the status line records the plan's weekly % (Pro/Max/Ultra), tokenjar
  estimates tokens per 1% of the weekly plan, and `/budget status` shows each bucket's approximate share
- Limits can be written as `limit: 30% of plan` (scaled to the bucket's period; tracked only while calibrating)
- `statusline.show_plan: true` appends the plan's weekly % to the status line
- `query` / `spend` skill include the plan data

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
