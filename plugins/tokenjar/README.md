# tokenjar

Token budgets per bucket (work, fun, creative, ...) for Claude Code. Tracks usage from local transcripts,
shows progress in the status line, and warns or blocks when a bucket is used up.

**Privacy:** 100% local. No network calls, no telemetry. Only token counts and metadata are stored, never
prompt or response content.

Quick start: `/budget init`, edit `budgets.yaml`, then `/budget statusline install` and `/budget`.

Requires Node.js 18+ on your `PATH`. Full documentation: see the README at the root of the repository.
