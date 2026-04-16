# Coding Agents

Coding agents are the AI backends that power code workspaces and agent jobs. They run inside Docker containers and interact with your Git repository — writing code, running commands, creating PRs.

thepopebot supports 6 coding agent backends. Each has its own Docker image and authentication method. You enable and configure them in Admin > Event Handler > Coding Agents.

## Supported Backends

| Backend | Config key | What it is | Auth modes |
|---------|-----------|------------|------------|
| Claude Code | `claude-code` (default) | Anthropic's official CLI agent | OAuth token or API key |
| Pi | `pi-coding-agent` | Third-party agent by @mariozechner | API key (any provider) |
| Gemini CLI | `gemini-cli` | Google's CLI agent | API key (Google) |
| Codex CLI | `codex-cli` | OpenAI's CLI agent | OAuth token or API key |
| OpenCode | `opencode` | Open-source agent | API key (any provider) |
| Kimi CLI | `kimi-cli` | Moonshot's CLI agent | API key (any provider) |

## Configuration

All config is DB-backed. Managed at Admin > Event Handler > Coding Agents.

**Default agent**: `CODING_AGENT` config key (default: `claude-code`). This is what runs when the AI launches a code workspace or agent job.

**Per-agent settings** (each has its own card in the admin UI):
- Enable/disable toggle
- Auth mode (OAuth or API key, where applicable)
- Backend provider (for agents that support multiple LLM providers)
- Model override

Config keys follow the pattern `CODING_AGENT_{BACKEND}_{SETTING}`:

### Claude Code

- `CODING_AGENT_CLAUDE_CODE_ENABLED` (default: `true`)
- `CODING_AGENT_CLAUDE_CODE_AUTH` (default: `oauth`) — `oauth` or `api-key`
- `CODING_AGENT_CLAUDE_CODE_BACKEND` — which LLM provider Claude Code uses (can be non-Anthropic via proxy)
- `CODING_AGENT_CLAUDE_CODE_MODEL` — model override

### Pi

- `CODING_AGENT_PI_ENABLED` (default: `false`)
- `CODING_AGENT_PI_PROVIDER` — LLM provider for Pi
- `CODING_AGENT_PI_MODEL` — model override

### Gemini CLI

- `CODING_AGENT_GEMINI_CLI_ENABLED` (default: `false`)
- `CODING_AGENT_GEMINI_CLI_MODEL` — model override

### Codex CLI

- `CODING_AGENT_CODEX_CLI_ENABLED` (default: `false`)
- `CODING_AGENT_CODEX_CLI_AUTH` (default: `api-key`) — `oauth` or `api-key`
- `CODING_AGENT_CODEX_CLI_MODEL` — model override

### OpenCode

- `CODING_AGENT_OPENCODE_ENABLED` (default: `false`)
- `CODING_AGENT_OPENCODE_PROVIDER` — LLM provider for OpenCode
- `CODING_AGENT_OPENCODE_MODEL` — model override

## OAuth Tokens

Claude Code and Codex CLI support OAuth authentication (subscription-based, not pay-per-token).

**Claude Code OAuth**: Claude Pro ($20/mo) or Max ($100+/mo) subscribers can generate tokens:

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

Token starts with `sk-ant-oat01-`. Add it in Admin > Event Handler > Coding Agents > Claude Code.

**Codex OAuth**: Similar flow for OpenAI subscribers.

**Multi-token rotation**: You can add multiple OAuth tokens. The system uses LRU (least-recently-used) rotation — each container launch picks the token that hasn't been used the longest. This helps distribute usage across subscription accounts.

## Claude Code with Non-Anthropic Providers

Claude Code natively only supports Anthropic models. thepopebot extends this via two routing mechanisms:

**Anthropic-compatible endpoints**: Providers that expose an Anthropic-format API (DeepSeek, MiniMax, Kimi, OpenRouter) can be used directly. The system sets `ANTHROPIC_BASE_URL` to the provider's endpoint.

**LiteLLM proxy**: Providers that only offer OpenAI-format APIs (OpenAI, Google, Mistral, xAI) are routed through the LiteLLM sidecar container that translates between API formats. LiteLLM is included in both the default and SSL Docker Compose configurations.

This means Claude Code can be powered by almost any LLM provider, not just Anthropic.

## Agent Job Secrets

Agent containers receive credentials automatically based on their configured auth mode. Additionally, custom secrets (3rd-party API keys needed by agent tasks) can be added at Admin > Event Handler > Agent Jobs. These are encrypted in the database and injected as environment variables into every container.

## Docker Images

Each backend has its own Docker image built on a shared base:

- `stephengpope/thepopebot:coding-agent-base-{version}`
- `stephengpope/thepopebot:coding-agent-claude-code-{version}`
- `stephengpope/thepopebot:coding-agent-pi-coding-agent-{version}`
- `stephengpope/thepopebot:coding-agent-gemini-cli-{version}`
- `stephengpope/thepopebot:coding-agent-codex-cli-{version}`
- `stephengpope/thepopebot:coding-agent-opencode-{version}`
- `stephengpope/thepopebot:coding-agent-kimi-cli-{version}`

All images include Node.js 22, Git, GitHub CLI, and Playwright + Chromium.

---

## Technical Integration Details

This section describes how each coding agent is integrated at the code level — Docker images, authentication flow, CLI invocation, session management, and browser automation.

### Integration Architecture

All coding agents share a unified container architecture with two selection axes:

1. **`RUNTIME`** — the workflow (what steps run): `agent-job`, `headless`, `interactive`, `cluster-worker`, `command/*`
2. **`AGENT`** — the coding agent (what tool does the work): `claude-code`, `pi-coding-agent`, `gemini-cli`, `codex-cli`, `opencode`, `kimi-cli`

The base Docker image (`docker/coding-agent/Dockerfile`) installs shared dependencies (Ubuntu 24.04, Node.js 22, Git, GitHub CLI, ttyd, tmux, Playwright + Chromium). Each agent-specific Dockerfile extends it by installing the agent's CLI tool and setting `ENV AGENT=<name>`.

At container startup, `entrypoint.sh` validates both `RUNTIME` and `AGENT`, then sources numbered shell scripts from `/scripts/${RUNTIME}/` in order. At agent-specific steps (auth, setup, run, interactive, merge-back), the runtime scripts delegate to `/scripts/agents/${AGENT}/` scripts.

```
entrypoint.sh
  └── /scripts/${RUNTIME}/*.sh  (workflow steps, executed in order)
        └── /scripts/agents/${AGENT}/*.sh  (agent-specific behavior)
```

### Agent Selection and Dispatch

The event handler selects which agent to use through this resolution order:

1. **Per-job override** — `agentBackend` parameter in `createAgentJob()` or workspace creation
2. **Default config** — `CODING_AGENT` config key in the database (set via Admin UI)
3. **Fallback** — `claude-code`

The agent name determines the Docker image tag (`coding-agent-{agent}-{version}`), which container scripts run, and which authentication credentials are injected. This happens in `lib/tools/docker.js` via `buildAgentAuthEnv(agent)`.

### Agent Job Execution Flow

When an agent job is created (via API, cron, trigger, or chat):

```
Event Handler
  ├─ Generate UUID → branch name agent-job/{uuid}
  ├─ Generate title via LLM
  ├─ Push config (agent-job.config.json) to GitHub branch
  └─ Launch container (runAgentJobContainer)
       ├─ Image: coding-agent-{agent}-{version}
       ├─ Env: RUNTIME=agent-job, auth credentials, job metadata
       └─ entrypoint.sh executes:
            1. setup-git.sh      → Configure git identity
            2. load-config.sh    → Read agent-job.config.json
            3. checkout-branch.sh → Clone repo, checkout branch
            4. agent-auth.sh     → Agent-specific auth setup
            5. agent-setup.sh    → Agent-specific config (trust, MCP, system prompt)
            6. run-agent.sh      → Execute agent with task prompt
            7. commit.sh         → Stage and commit changes
            8. push.sh           → Push branch to origin
            9. create-pr.sh      → Create pull request
```

---

### Claude Code Integration

**CLI tool**: `@anthropic-ai/claude-code` → `claude` command

**Docker image** (`Dockerfile.claude-code`):
```dockerfile
RUN npm install -g @anthropic-ai/claude-code
ENV AGENT=claude-code
```

**Authentication** (`buildAgentAuthEnv` in `lib/tools/docker.js` + `scripts/agents/claude-code/auth.sh`):

The event handler resolves credentials based on the configured backend:

- **Anthropic (default)**: OAuth (`CLAUDE_CODE_OAUTH_TOKEN`) takes priority over API key (`ANTHROPIC_API_KEY`). The shell script unsets conflicting env vars to ensure the correct auth mode is used.
- **Anthropic-compatible providers** (DeepSeek, MiniMax, Kimi, OpenRouter): Sets `ANTHROPIC_BASE_URL` to the provider's endpoint and passes the API key as `ANTHROPIC_AUTH_TOKEN`.
- **OpenAI-format providers** (OpenAI, Google, Mistral, xAI): Routes through the LiteLLM sidecar container (`http://litellm:4000`) which translates between API formats. Model names are prefixed with the LiteLLM provider prefix.
- **Custom providers**: Also routed through LiteLLM.

**Headless execution** (`scripts/agents/claude-code/run.sh`):
```bash
claude -p "$PROMPT" --verbose --output-format stream-json \
  [--model "$LLM_MODEL"] \
  [--append-system-prompt "$SYSTEM_PROMPT"] \
  [--permission-mode plan] \
  [--dangerously-skip-permissions] \
  [--resume "$SESSION_ID"]
```

**Interactive mode** (`scripts/agents/claude-code/interactive.sh`):
- Launches `claude` inside tmux with session name `claude-${PORT}`
- Serves via ttyd on the assigned port (default 7681)
- Supports `--resume` for session continuation

**Session tracking**: Uses Claude Code's native `SessionStart` hook system. The hook script (registered in `~/.claude/settings.json`) receives JSON on stdin containing the `session_id`, validates the session JSONL file exists, and writes the ID to a port-keyed file at `/home/coding-agent/.claude-ttyd-sessions/${PORT}`.

**System prompt**: Passed via `--append-system-prompt` flag in `run.sh`. For agent jobs, built from `agent-job/SOUL.md` + `agent-job/SYSTEM.md` with `{{datetime}}` substitution.

**MCP/Playwright registration** (`scripts/agents/claude-code/setup.sh`):
```bash
claude mcp add --transport stdio playwright -- \
  npx -y @playwright/mcp@0.0.70 --headless --browser chromium \
  --output-dir /home/coding-agent/workspace/.tmp
```

**Permission modes**: Supports `plan` (restricted) and `code` (full access via `--dangerously-skip-permissions`).

---

### Pi Coding Agent Integration

**CLI tool**: `@mariozechner/pi-coding-agent` → `pi` command

**Docker image** (`Dockerfile.pi-coding-agent`):
```dockerfile
RUN npm install -g @mariozechner/pi-coding-agent @playwright/cli@0.1.3
ENV PLAYWRIGHT_MCP_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1217/chrome-linux/chrome
ENV PLAYWRIGHT_MCP_OUTPUT_DIR=/home/coding-agent/workspace/.tmp
```

**Authentication** (`buildAgentAuthEnv` in `lib/tools/docker.js` + `scripts/agents/pi-coding-agent/auth.sh`):

Pi uses a multi-provider auth pattern shared with OpenCode and Kimi CLI. The event handler reads `CODING_AGENT_PI_PROVIDER` to determine which API key to inject:

| Provider | Environment variable |
|----------|---------------------|
| anthropic | `ANTHROPIC_API_KEY` |
| openai | `OPENAI_API_KEY` |
| google | `GOOGLE_API_KEY` |
| deepseek | `DEEPSEEK_API_KEY` |
| custom | `CUSTOM_OPENAI_BASE_URL` + `CUSTOM_API_KEY` |

The shell `auth.sh` is a no-op — Pi reads API keys directly from environment variables.

**Headless execution** (`scripts/agents/pi-coding-agent/run.sh`):
```bash
pi -p "$PROMPT" --mode json \
  [-m "$LLM_MODEL"] \
  [--provider custom] \
  [--session-dir /home/coding-agent/.pi-ttyd-sessions/7681 -c]
```

**Interactive mode** (`scripts/agents/pi-coding-agent/interactive.sh`):
- Launches `pi` inside tmux with session name `pi-${PORT}`
- Serves via ttyd on the assigned port

**Session tracking**: Uses a directory-based approach instead of session IDs. Each terminal tab gets its own session directory via `--session-dir /home/coding-agent/.pi-ttyd-sessions/${PORT}`. The `-c` (continue) flag resumes the latest session within that directory. No hooks or plugins needed — the filesystem IS the session mapping.

**System prompt**: Written to `${WORKSPACE_DIR}/.pi/SYSTEM.md`. Pi auto-loads this file if present.

**MCP/Playwright registration**: Pi uses a skill-based approach instead of MCP. Playwright is activated by symlinking the `playwright-cli` skill from `skills/library/` into `skills/active/`.

**Permission modes**: Not supported. Pi does not have a plan/restricted mode.

---

### Gemini CLI Integration

**CLI tool**: `@google/gemini-cli` → `gemini` command

**Docker image** (`Dockerfile.gemini-cli`):
```dockerfile
RUN npm install -g @google/gemini-cli
```

**Authentication** (`buildAgentAuthEnv` in `lib/tools/docker.js` + `scripts/agents/gemini-cli/auth.sh`):

Backend is always Google. The event handler injects `GOOGLE_API_KEY`. The shell `auth.sh` maps `GOOGLE_API_KEY` → `GEMINI_API_KEY` and configures `~/.gemini/settings.json` with `selectedType: "gemini-api-key"`.

**Headless execution** (`scripts/agents/gemini-cli/run.sh`):
```bash
gemini -p "$PROMPT" --output-format stream-json \
  --approval-mode [yolo|plan] \
  [-m "$LLM_MODEL"] \
  [--resume "$SESSION_ID"]
```

**Interactive mode** (`scripts/agents/gemini-cli/interactive.sh`):
- Launches `gemini` inside tmux with session name `gemini-${PORT}`
- Serves via ttyd on the assigned port

**Session tracking**: Uses the `AfterAgent` hook (not `SessionStart`, because the session file doesn't exist yet at session start). The hook script finds the most recent `session-*.json` file in `~/.gemini/tmp/workspace/chats/`, extracts the short UUID from the filename, resolves the full UUID via `gemini --list-sessions`, and writes it to `/home/coding-agent/.gemini-ttyd-sessions/${PORT}`.

**System prompt**: Written to `~/.gemini/SYSTEM.md` and exported as `GEMINI_SYSTEM_MD` env var.

**MCP/Playwright registration** (`scripts/agents/gemini-cli/setup.sh`):
```bash
gemini mcp add playwright npx -y @playwright/mcp@0.0.70 \
  --headless --browser chromium \
  --output-dir /home/coding-agent/workspace/.tmp --trust
```

**Permission modes**: Supports `yolo` (full access, default) and `plan` (restricted via `--approval-mode plan`).

---

### Codex CLI Integration

**CLI tool**: `@openai/codex` → `codex` command

**Docker image** (`Dockerfile.codex-cli`):
```dockerfile
RUN npm install -g @openai/codex
```

**Authentication** (`buildAgentAuthEnv` in `lib/tools/docker.js` + `scripts/agents/codex-cli/auth.sh`):

Backend is always OpenAI. Two auth modes:
- **OAuth** (`CODEX_OAUTH_TOKEN`): Subscription-based token
- **API key** (`OPENAI_API_KEY`): Pay-per-token

Unlike other agents, Codex does NOT read `OPENAI_API_KEY` from environment. The shell `auth.sh` pipes the API key into `codex login --with-api-key` to store it in `~/.codex/auth.json`.

**Headless execution** (`scripts/agents/codex-cli/run.sh`):
```bash
codex exec [resume "$SESSION_ID"] "$PROMPT" \
  --json \
  --dangerously-bypass-approvals-and-sandbox \
  [-m "$LLM_MODEL"]
```

**Interactive mode** (`scripts/agents/codex-cli/interactive.sh`):
- Launches `codex` inside tmux with session name `codex-${PORT}`
- Serves via ttyd on the assigned port

**Session tracking**: Uses Codex's native `SessionStart` hook system. The hook (registered in `~/.codex/hooks.json` with `codex_hooks = true` feature flag in `~/.codex/config.toml`) receives JSON on stdin with `session_id`, validates the session file exists via `find ~/.codex/sessions`, and writes the ID to `/home/coding-agent/.codex-ttyd-sessions/${PORT}`. Resume uses `codex resume $SESSION_ID` (interactive) or `codex exec resume $SESSION_ID` (headless).

**System prompt**: Written to `${WORKSPACE_DIR}/AGENTS.md` in the workspace root. Codex auto-loads this file.

**MCP/Playwright registration** (`scripts/agents/codex-cli/setup.sh`):

Registered in `~/.codex/config.toml`:
```toml
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@0.0.70", "--headless", "--browser", "chromium", "--output-dir", "/home/coding-agent/workspace/.tmp"]

[mcp_servers.playwright.env]
PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers"
```

**Permission modes**: Supports `--dangerously-bypass-approvals-and-sandbox` for full access.

---

### OpenCode Integration

**CLI tool**: `opencode-ai` → `opencode` command

**Docker image** (`Dockerfile.opencode`):
```dockerfile
RUN npm install -g opencode-ai@latest bun
```

Bun is required for OpenCode's plugin system.

**Authentication** (`buildAgentAuthEnv` in `lib/tools/docker.js` + `scripts/agents/opencode/auth.sh`):

OpenCode uses the same multi-provider auth pattern as Pi and Kimi CLI. The event handler reads `CODING_AGENT_OPENCODE_PROVIDER` to determine which API key to inject. The shell `auth.sh` is a no-op — OpenCode reads API keys directly from environment variables.

**Headless execution** (`scripts/agents/opencode/run.sh`):
```bash
opencode run --format json \
  [-m "$LLM_MODEL"] \
  [--session "$SESSION_ID"] \
  "$PROMPT"
```

**Interactive mode** (`scripts/agents/opencode/interactive.sh`):
- Launches `opencode` inside tmux with session name `opencode-${PORT}`
- Serves via ttyd on the assigned port

**Session tracking**: Uses a custom JavaScript plugin instead of hooks. The plugin (`${WORKSPACE_DIR}/.opencode/plugins/session-tracker.mjs`) is an ESM module registered in `.opencode/opencode.jsonc`. It listens for events and captures `sessionID` from the first event's `event.properties.sessionID`, writing it to `/home/coding-agent/.opencode-ttyd-sessions/${PORT}`. Sessions are validated via `opencode session list --format json`.

**System prompt**: Written to `${WORKSPACE_DIR}/AGENTS.md` in the workspace root.

**MCP/Playwright registration** (`scripts/agents/opencode/setup.sh`):

Registered in `~/.config/opencode/opencode.json`:
```json
{
  "mcp": {
    "playwright": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.70", "--headless", "--browser", "chromium",
               "--output-dir", "/home/coding-agent/workspace/.tmp"],
      "enabled": true
    }
  }
}
```

Note: OpenCode's config is split between the workspace (`.opencode/opencode.jsonc` for plugins) and home (`~/.config/opencode/opencode.json` for MCP servers). The `opencode.jsonc` format rejects unrecognized keys like `mcpServers`.

**Permission modes**: Not supported.

---

### Kimi CLI Integration

**CLI tool**: `kimi-cli` (Python package via uv) → `kimi` command

**Docker image** (`Dockerfile.kimi-cli`):
```dockerfile
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN UV_TOOL_DIR=/opt/uv-tools /root/.local/bin/uv tool install --python 3.13 kimi-cli
```

Kimi CLI is a Python tool installed via uv (not npm).

**Authentication** (`buildAgentAuthEnv` in `lib/tools/docker.js` + `scripts/agents/kimi-cli/auth.sh`):

Kimi CLI uses the same multi-provider auth pattern as Pi and OpenCode. The event handler reads `CODING_AGENT_KIMI_CLI_PROVIDER` to determine which API key to inject. The shell `auth.sh` is a no-op — Kimi reads API keys from environment. The `setup.sh` dynamically generates `~/.kimi/config.toml` with provider config, API key, model, and `default_yolo = true`.

**Headless execution** (`scripts/agents/kimi-cli/run.sh`):
```bash
kimi --print -p "$PROMPT" --output-format stream-json \
  [-m "$LLM_MODEL"] \
  [--session "$SESSION_ID"]
```

**Interactive mode** (`scripts/agents/kimi-cli/interactive.sh`):
- Launches `kimi` inside tmux with session name `kimi-${PORT}`
- Serves via ttyd on the assigned port

**Session tracking**: Uses native `SessionStart` hooks following the same pattern as Claude Code and Codex CLI. The hook is registered in `~/.kimi/config.toml` under the `[[hooks]]` section. It receives JSON on stdin containing a `session_id` field, extracts it using `grep`/`cut` (rather than `jq`), and writes to `/home/coding-agent/.kimi-ttyd-sessions/${PORT}`. Sessions are validated via `kimi session list`.

**System prompt**: Written to `${WORKSPACE_DIR}/AGENTS.md` in the workspace root.

**MCP/Playwright registration** (`scripts/agents/kimi-cli/setup.sh`):
```bash
kimi mcp add --transport stdio \
  -e PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  playwright -- npx -y @playwright/mcp@0.0.70 \
  --headless --browser chromium \
  --output-dir /home/coding-agent/workspace/.tmp
```

**Permission modes**: Not supported. Uses `default_yolo = true` in config.

---

### Comparison Table

| Feature | Claude Code | Pi | Gemini CLI | Codex CLI | OpenCode | Kimi CLI |
|---------|------------|-----|------------|-----------|----------|----------|
| **CLI package** | `@anthropic-ai/claude-code` | `@mariozechner/pi-coding-agent` | `@google/gemini-cli` | `@openai/codex` | `opencode-ai` | `kimi-cli` (Python) |
| **Auth setup** | Priority swap (OAuth > API key) | No-op (reads env) | Key mapping | `codex login` command | No-op (reads env) | No-op (reads env) |
| **Multi-provider** | Yes (via proxy) | Yes (native) | No (Google only) | No (OpenAI only) | Yes (native) | Yes (native) |
| **Permission modes** | plan / code | None | plan / yolo | bypass-approvals | None | None |
| **System prompt** | `--append-system-prompt` flag | `.pi/SYSTEM.md` | `~/.gemini/SYSTEM.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` |
| **Session tracking** | Hook (JSON stdin) | Directory-based | Hook (file parse) | Hook (JSON stdin) | Plugin (JS) | Hook (JSON stdin) |
| **MCP registration** | `claude mcp add` | Skill symlink | `gemini mcp add` | `config.toml` | `config.json` | `kimi mcp add` |
| **Config format** | JSON | N/A | JSON | TOML | JSON/JSONC | TOML |
| **Headless command** | `claude -p` | `pi -p` | `gemini -p` | `codex exec` | `opencode run` | `kimi --print -p` |

### Key Source Files

| File | Purpose |
|------|---------|
| `lib/tools/docker.js` | Container lifecycle, image selection, `buildAgentAuthEnv()` for credential injection |
| `lib/tools/create-agent-job.js` | Agent job creation, branch setup, container launch |
| `lib/code/actions.js` | Code workspace management (start, stop, recover containers) |
| `lib/actions.js` | Action dispatcher (agent, command, webhook action types) |
| `lib/llm-providers.js` | Provider definitions, model capabilities, LiteLLM proxy config |
| `lib/chat/components/settings-coding-agents-page.jsx` | Admin UI for agent configuration |
| `docker/coding-agent/Dockerfile` | Base image (shared dependencies) |
| `docker/coding-agent/Dockerfile.{agent}` | Agent-specific image (CLI installation) |
| `docker/coding-agent/entrypoint.sh` | Container startup orchestration |
| `docker/coding-agent/scripts/agents/{agent}/` | Agent-specific shell scripts (auth, setup, run, interactive, merge-back, start-coding-session) |
