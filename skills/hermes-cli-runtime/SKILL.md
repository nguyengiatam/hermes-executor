---
name: hermes-cli-runtime
description: Use when invoking Hermes Agent as a headless executor from Claude Code; documents job tracking, JSONL events, timeout, cancellation and resume.
---

# Hermes executor runtime

Invoke the bundled runtime with Node.js 20+ from the target repository. Hermes must be on PATH, or selected by `HERMES_BIN` (an executable path, not a shell command). Never hardcode a model; Hermes uses the user's configuration by default.

Verified against Hermes Agent v0.21.4 (2026.9.21):

```text
hermes chat --cli --oneshot --format stream-json --yolo --in <repo> --query-file <prompt.md>
  [--resume <session-id>] [--model <model>] [--provider <provider>]
  [--toolsets <comma-separated names>] [--reasoning <level>]
```

`--yolo` bypasses Hermes command approval prompts to permit headless execution. Hermes can edit files and run commands with the user's local access. Use only for tasks the user has authorized. Existing Hermes configuration, rules, memory, skills and hooks retain their normal behavior. Hooks requiring initial trust may need approval in an interactive Hermes session first.

Runtime commands: `exec`, `status`, `result`, `cancel`, `setup`, `resume-candidate`.

`exec` accepts `--background` (default), `--wait`, `--resume`, `--fresh`, `--session <id>`, `--model`, `--provider`, `--toolsets`, `--reasoning`, `--timeout` and `--task-file`. Timeout defaults to `85m`; accepts positive durations like `90s`, `30m`, `2h`. Resume uses the latest recorded session in this repository; explicit session selects a Hermes session directly. Fresh conflicts with resume/session. Never use global `latest` to resume unrelated work.

For arbitrary user text, write a unique task file with the Write tool and pass its absolute path to `--task-file`. Do not interpolate `$ARGUMENTS` into a shell command. The runtime copies the full prompt into its private job directory and invokes Hermes with an argument array, without a shell. Direct terminal users may supply a quoted task after `--`.

Jobs are scoped by git repository root (current directory outside git), under `~/.hermes-executor/<repo-hash>/jobs/<job-id>/`. `HERMES_EXECUTOR_HOME` overrides the storage root. Each job has atomic `job.json` metadata, `prompt.md`, `output.jsonl`, `stderr.log`, and background `supervisor.log`. Each supervisor owns its job metadata; status/result are read-only.

A detached Node supervisor tracks the actual Hermes exit and enforces deadlines even if the user never polls. Cancel creates a marker for the supervisor. Timeout/cancel terminate the Hermes process group, with SIGKILL after a 1.5 second grace period. POSIX process groups are required (macOS/Linux). Cancellation is asynchronous.

JSONL: `system`/`init` identifies the model/session; `text` carries streamed deltas; `tool_use` has name/input; `tool_result` has output/is_error; final `result` has session_id, exit_code, text, tokens and optional error. Prefer final result text over concatenated deltas. Failed tool calls alone do not imply a failed run: Hermes may recover.

Statuses: `running`, `finished` (exit 0 plus a successful terminal result), `failed` (spawn error, nonzero process/result exit or result error), `empty` (no events), `incomplete` (missing terminal result or lost supervisor), `timeout`, `cancelled`. Wait mode exits nonzero unless finished. `result --raw` emits stored JSONL.

`setup --json` checks the executable version and required CLI flags without calling a model, starting an interactive setup wizard or reading credentials. It does not guarantee provider authentication.
