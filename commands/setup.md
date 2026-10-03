---
description: Check Hermes installation and CLI compatibility
argument-hint: ""
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-runtime.mjs" setup --json
```

Report installed, compatible, hermesBin and version. This check does not call a model or verify credentials. If Hermes is missing, direct the user to https://github.com/NousResearch/hermes-agent. If installed but incompatible, suggest updating Hermes. If authentication is not configured, the user can run `hermes setup` interactively.
