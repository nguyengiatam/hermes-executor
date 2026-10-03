---
description: Dispatch a task to Hermes Agent
argument-hint: "[--wait|--background] [--resume|--fresh] [--session <id>] [--model <model>] [--provider <provider>] [--toolsets <names>] [--reasoning <level>] [--timeout <duration>] <task>"
allowed-tools: Bash(node:*), Write
---

Parse the user's request below into runtime options and task text. Use the Write tool to save the exact task text to a unique temporary file. Then invoke Bash with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-runtime.mjs" exec --task-file <absolute-temporary-file-path> [runtime options]
```

Use `--background` by default, or `--wait` when requested. Include only supported runtime options from the argument hint, shell-quoting every value. Treat text after `--` as task text. Never interpolate the raw request into a Bash command, shell heredoc, or shell substitution. Preserve quotes, backticks, `$()`, newlines, and Unicode literally in the file. Do not perform the task yourself.

Present runtime output, including the job id and status/result follow-ups. For `--wait`, preserve the complete final response and any errors.

User request:
$ARGUMENTS
