---
name: budget
description: Show tokenjar token budgets and usage per bucket.
argument-hint: "[status]"
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/tokenjar.js" budget --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

The text above is the output of the tokenjar CLI. Show it to the user exactly as
it is, inside a plain code block, with no commentary before or after. Do not run
any tools.
