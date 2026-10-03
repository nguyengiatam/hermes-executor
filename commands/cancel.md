---
description: Cancel a running Hermes job
argument-hint: "[job-id]"
allowed-tools: Bash(node:*)
---

Invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-runtime.mjs" cancel` with the optional job id as one shell-quoted argument. Validate the id contains only digits, lowercase hex and hyphens. With no id, request cancellation of the latest running job. Present the output. Cancellation is asynchronous; do not claim completion before status confirms it.

User request:
$ARGUMENTS
