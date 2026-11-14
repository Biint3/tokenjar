---
name: spend
description: Answer questions about the user's own Claude Code token usage and budgets tracked by tokenjar, such as "how much have I spent on work this week?", "which project used the most tokens?", "am I close to my fun budget?" or "how does this week compare to last week?".
---

Below is the user's current tokenjar data (local token counts only, no
conversation content), generated just now:

```json
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/tokenjar.js" query`
```

Answer the user's question from this data:

- Amounts are in the metric named in `metric_meaning`. With the default
  `weighted` metric they are API-equivalent "input-token equivalents", not raw
  token counts and not money. Say so briefly when it matters.
- `buckets` has the current period per bucket (`used`, `limit`, `percent`,
  `remaining`, `resets`), `previous_period_used`, and all-time totals.
  `last_14_days` is per local day. `projects` groups usage by session folder.
- Budgets are the user's own self-imposed targets, not their Claude plan's
  quota. Don't claim anything about plan limits.
- Use compact numbers (1.2M, 340k) and keep the answer short. If the data
  can't answer the question, say what is missing and suggest `/budget status`.
- Mention `/budget extend <bucket> <amount>` or `/budget set <bucket>` only if
  the user asks how to get more room or move a session.
