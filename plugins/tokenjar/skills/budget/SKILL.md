---
name: budget
description: tokenjar token budgets. Show status, set this session's bucket, extend a bucket for the current period, re-file past sessions, add or rename buckets, set up the status line.
argument-hint: "[status | set <bucket> | extend <bucket> <amount> | usage | rebucket | add <name> | rename <old> <new> | edit | init | statusline install | help]"
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/tokenjar.js" budget --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

The text above is the output of the tokenjar CLI. Show it to the user exactly as
it is, inside a plain code block, with no commentary before or after. Do not run
any tools.
