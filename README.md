# hermes-executor

A Claude Code plugin that delegates coding tasks to the local [Hermes Agent](https://github.com/NousResearch/hermes-agent) CLI, with background jobs, session resume, timeout handling and cancellation.

## Requirements

- Node.js 20+ and macOS or Linux.
- Hermes Agent with `chat --query-file`, `--format stream-json`, `--oneshot`, `--in`, `--cli` and `--yolo` support. CLI contract verified locally against v0.21.4 (2026.9.21).
- A provider configured in Hermes (`hermes setup`). The configured model is used unless overridden.

See the [Hermes CLI reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md) for installation and configuration details.

## Install

In Claude Code:

```text
/plugin marketplace add https://github.com/nguyengiatam/hermes-executor.git
/plugin install hermes-executor@hermes-executor-marketplace
```

For local development, clone the repository and load it directly:

```bash
git clone https://github.com/nguyengiatam/hermes-executor.git
claude --plugin-dir ./hermes-executor
```

## Quick start

Run commands from the repository you want Hermes to work on:

```text
/hermes-executor:setup
/hermes-executor:exec Add unit tests for the authentication module
/hermes-executor:status
/hermes-executor:result
/hermes-executor:exec --resume --wait Explain the changes from the previous task
/hermes-executor:cancel
```

## Commands

| Command | Purpose |
|---|---|
| `exec <task>` | Run in background by default; `--wait` waits for the result. |
| `status [job-id]` | Recent jobs, or detailed metadata and recent JSONL events. |
| `result [job-id] [--raw]` | Full final response, errors and tokens; optionally raw JSONL. |
| `cancel [job-id]` | Request cancellation of a job, or the latest running job. |
| `setup` | Check installation/version and required flags without an inference call. |

`status`, `result` and `cancel` accept the job id printed by `exec`. Without an id, `result` selects the latest job and `cancel` selects the latest running job. Cancellation is asynchronous; check `status` to confirm completion.

## Model and provider selection

You can select a model and provider for each task. Creating a Hermes profile is not required:

```text
/hermes-executor:exec --provider openrouter --model anthropic/claude-sonnet-4.6 Review the authentication module
/hermes-executor:exec --wait --model <model-id> Explain the repository architecture
```

The model must be available through the selected provider, and its credentials must already be configured in Hermes. When `--model` or `--provider` is omitted, Hermes resolves it from its own configuration and environment. Set your defaults using `hermes setup` or `hermes model` in a terminal.

These overrides apply only to the current invocation. The plugin does not expose a `--profile` option in this version.

## Execution options

| Option | Behavior |
|---|---|
| `--background` | Run in the background; default. |
| `--wait` | Wait for completion and show the full result. |
| `--resume` | Continue the most recent recorded Hermes session in this repository. |
| `--session <id>` | Continue a specific Hermes session. |
| `--fresh` | Start a new session; conflicts with `--resume` and `--session`. |
| `--model <model-id>` | Override the model for this run. |
| `--provider <provider>` | Override the provider for this run. |
| `--toolsets <names>` | Select comma-separated Hermes toolsets. |
| `--reasoning <level>` | Set Hermes reasoning effort for this run. |
| `--timeout <duration>` | Set the runtime deadline; default `85m`. Accepts `90s`, `30m`, `2h`, etc. |

`--resume` refuses to dispatch when no session has been recorded in the current repository. A session with a recorded running job cannot be resumed until that job ends.

The `hermes-runner` agent forwards tasks through the same runtime; the bundled [hermes-cli-runtime skill](skills/hermes-cli-runtime/SKILL.md) documents its contract.

## Direct runtime use

```bash
node scripts/hermes-runtime.mjs setup --json
node scripts/hermes-runtime.mjs exec --wait --timeout 5m -- 'Explain the repository architecture'
node scripts/hermes-runtime.mjs exec --task-file /absolute/path/task.md
node scripts/hermes-runtime.mjs result --raw
```

For arbitrary multiline tasks, use `--task-file`. Plugin commands use Write to create a task file so shell syntax in prompts remains literal.

Run the script from your target repository using its absolute path when the plugin lives elsewhere.

## Jobs and results

Jobs live under `~/.hermes-executor/<repo-hash>/jobs/`; set `HERMES_EXECUTOR_HOME` to override storage. Set `HERMES_BIN` to an executable path to override Hermes. Logs and prompts stay on disk for inspection. A detached supervisor records exit status, enforces the timeout without polling, and terminates the Hermes process group for cancel/timeout. A successful status requires both exit code zero and a successful JSONL result event.

Headless invocation includes `--yolo`, which auto-approves Hermes command execution. Dispatch only tasks you authorize Hermes to perform with your local access. Hook trust still follows Hermes configuration.

Possible statuses are `running`, `finished`, `failed`, `empty`, `incomplete`, `timeout` and `cancelled`. `--wait` exits with a nonzero code for every status except `finished`. The final JSONL result supplies the full response, token counts and session id; `result --raw` prints all stored events.

## Troubleshooting

- Run `/hermes-executor:setup` to verify installation and required CLI flags. This checks CLI compatibility; it does not verify provider credentials or call a model.
- If authentication fails, run `hermes setup` in a terminal and configure the intended provider.
- If Hermes is not on PATH, set `HERMES_BIN` to its executable path before starting Claude Code.
- If the installed Hermes CLI lacks a required flag, update Hermes and run setup again.
- If a job fails or produces no final result, inspect `/hermes-executor:result <job-id>` and the saved stderr/supervisor logs.

## Validation

```bash
node --test tests/runtime.test.mjs
node scripts/hermes-runtime.mjs setup --json
```

Tests use a fake Hermes executable and isolated temporary repositories/storage; they do not call a model.

## License

[MIT](LICENSE).
