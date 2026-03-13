# thepopebot — Package Source Reference

Technical reference for AI assistants modifying the thepopebot NPM package source code.

**Architecture**: Event Handler (Next.js) creates `job/*` branches → GitHub Actions runs Docker agent (Pi or Claude Code) → task executed → PR created → auto-merge → notification. Agent jobs log to `logs/{JOB_ID}/`.

## Deployment Model

The npm package (`api/`, `lib/`, `config/`, `bin/`) is published to npm. In production:

- **Event handler**: Docker image bakes the npm package, Next.js app source (`web/`), and `.next` build output. User project directories (`config/`, `skills/`, `.env`, `data/`, etc.) are individually volume-mounted into `/app`. The full project is also mounted at `/project` for git access. Runs `server.js` via PM2 behind Traefik reverse proxy.
- **`lib/paths.js`**: Central path resolver — ALL paths resolve from `process.cwd()`. This is how the installed npm package finds the volume-mounted user project files.
- **Job containers**: Ephemeral Docker containers clone `job/*` branches separately — NOT volume-mounted. See `docker/CLAUDE.md`.
- **Local install**: Gives users CLI tools (`init`, `setup`, `upgrade`) and configuration scaffolding.

## Package vs. Templates — Where Code Goes

All event handler logic, API routes, library code, and core functionality lives in the **npm package** (`api/`, `lib/`, `config/`, `bin/`). This is what users import when they `import ... from 'thepopebot/...'`.

The `templates/` directory contains **only files that get scaffolded into user projects** via `npx thepopebot init`. Templates are for user-editable configuration and thin wiring — things users are expected to customize or override. Never add core logic to templates.

**When adding or modifying event handler code, always put it in the package itself (e.g., `api/`, `lib/`), not in `templates/`.** Templates should only contain:
- Configuration files users edit (`config/SOUL.md`, `config/CRONS.json`, etc.)
- GitHub Actions workflows
- Docker compose (`docker-compose.yml`)
- CLAUDE.md files for AI assistant context in user projects

Next.js app source files (`app/`, `next.config.mjs`, `server.js`, etc.) live in `web/` at the package root. These are built into the Docker image — NOT scaffolded to user projects.

### Managed Paths

Files in managed directories are auto-synced (created, updated, **and deleted**) by `init` to match the package templates exactly. Users should not edit these files — changes will be overwritten on upgrade. Managed paths are defined in `bin/managed-paths.js`:

- `.github/workflows/` — CI/CD workflows
- `docker-compose.yml`, `.dockerignore` — Docker config
- `.gitignore` — Git ignore rules
- `CLAUDE.md` — AI assistant context

## Directory Structure

```
/
├── api/                        # GET/POST handlers for all /api/* routes
├── lib/
│   ├── actions.js              # Shared action executor (agent, command, webhook)
│   ├── cron.js                 # Cron scheduler (loads CRONS.json)
│   ├── triggers.js             # Webhook trigger middleware (loads TRIGGERS.json)
│   ├── paths.js                # Central path resolver (resolves from process.cwd())
│   ├── ai/                     # LLM integration (agent, model, tools, streaming)
│   ├── auth/                   # NextAuth config, helpers, middleware, server actions, components
│   ├── channels/               # Channel adapters (base class, Telegram, factory)
│   ├── chat/                   # Chat route handler, server actions, React UI components
│   ├── cluster/                # Worker clusters (roles, triggers, Docker containers)
│   ├── code/                   # Code workspaces (server actions, terminal view, WebSocket proxy)
│   ├── db/                     # SQLite via Drizzle (schema, migrations, api-keys)
│   ├── tools/                  # Job creation, GitHub API, Telegram, Docker, Whisper
│   ├── voice/                  # Voice input (AssemblyAI streaming transcription)
│   └── utils/
│       └── render-md.js        # Markdown {{include}} processor
├── config/
│   ├── index.js                # withThepopebot() Next.js config wrapper
│   └── instrumentation.js      # Server startup hook (loads .env, starts crons)
├── bin/                        # CLI entry point (init, setup, reset, diff, upgrade)
├── setup/                      # Interactive setup wizard
├── web/                        # Next.js app source (baked into Docker image, NOT scaffolded)
│   ├── app/                    # Next.js app directory (pages, layouts, routes)
│   ├── server.js               # Custom Next.js server with WebSocket proxy
│   ├── next.config.mjs         # Next.js config wrapper
│   ├── instrumentation.js      # Server startup hook
│   ├── middleware.js            # Auth middleware
│   └── postcss.config.mjs      # PostCSS/Tailwind config
├── templates/                  # Scaffolded to user projects (see rule above)
├── docs/                       # Extended documentation
└── package.json
```

## NPM Package Exports

Exports defined in `package.json` `exports` field. Pattern: `thepopebot/{module}` maps to source files in `api/`, `lib/`, `config/`. Includes `./cluster/*`, `./voice/*` exports. Add new exports there when creating new importable modules.

## Build System

Run `npm run build` before publish. esbuild compiles `lib/chat/components/**/*.jsx`, `lib/auth/components/**/*.jsx`, `lib/code/*.jsx`, `lib/cluster/components/**/*.jsx` to ES modules.

## Database

SQLite via Drizzle ORM at `data/thepopebot.sqlite` (override with `DATABASE_PATH`). Auto-initialized on server start. See `lib/db/CLAUDE.md` for schema details, CRUD patterns, and column naming.

### Migration Rules

**All schema changes MUST go through the migration workflow.**

- **NEVER** write raw `CREATE TABLE`, `ALTER TABLE`, or any DDL SQL manually
- **NEVER** modify `initDatabase()` to add schema changes
- **ALWAYS** make schema changes by editing `lib/db/schema.js` then running `npm run db:generate`

## Security: /api vs Server Actions

**`/api` routes are for external callers only.** They authenticate via `x-api-key` header or webhook secrets (Telegram, GitHub). Never add session/cookie auth to `/api` routes.

**Browser UI uses Server Actions.** All authenticated browser-to-server calls MUST use Next.js Server Actions (`'use server'` functions in `lib/chat/actions.js` or `lib/auth/actions.js`), not `/api` fetch calls. Server Actions use the `requireAuth()` pattern which validates the session cookie internally.

**Exception: chat streaming.** The AI SDK's `DefaultChatTransport` requires an HTTP endpoint. Chat has its own route handler at `lib/chat/api.js` (mapped to `/stream/chat`) with session auth, outside `/api`.

| Caller | Mechanism | Auth | Location |
|--------|-----------|------|----------|
| External (cURL, GitHub Actions, Telegram) | `/api` route handler | `x-api-key` or webhook secret | `api/index.js` |
| Browser UI (data/mutations) | Server Action | `requireAuth()` session check | `lib/chat/actions.js`, `lib/auth/actions.js` |
| Browser UI (chat streaming) | Dedicated route handler | `auth()` session check | `lib/chat/api.js` |

## Action Dispatch System

Shared executor for cron jobs and webhook triggers (`lib/actions.js`). Three action types: `agent` (Docker LLM container), `command` (shell command), `webhook` (HTTP request). See `lib/CLAUDE.md` for detailed dispatch format, cron/trigger config, and template tokens.

## LLM Providers

See `lib/ai/CLAUDE.md` for the provider table and model defaults. Key: `LLM_PROVIDER` + `LLM_MODEL` env vars, `LLM_MAX_TOKENS` defaults to 4096.

## Workspaces

- **Code Workspaces**: Interactive Docker containers with in-browser terminal. See `lib/code/CLAUDE.md`.
- **Cluster Workspaces**: Groups of Docker containers spawned from role definitions with triggers. See `lib/cluster/CLAUDE.md`.

Both use `lib/tools/docker.js` for container lifecycle via Unix socket API.

## Skills System

Plugin directories under `skills/`. Activate by symlinking into `skills/active/`. Each skill has `SKILL.md` with YAML frontmatter (`name`, `description`). The `{{skills}}` template variable in markdown files resolves active skill descriptions at runtime. Default active skills: `llm-secrets`, `modify-self`.

## Template Config & Markdown Includes

See `config/CLAUDE.md` for config file details and the `{{ include }}` / `{{variable}}` system.

## Config Variable Architecture

`LLM_MODEL` and `LLM_PROVIDER` exist in two separate systems using the same names:

- **`.env`** — read by the event handler (chat). Set by `setup/lib/sync.mjs`.
- **GitHub repository variables** — read by `run-job.yml` (agent jobs). Set by `setup/lib/sync.mjs`.

These are independent environments. They use the same variable names. They can hold different values (e.g. chat uses sonnet, jobs use opus). Do NOT create separate `AGENT_LLM_*` variable names — just set different values in `.env` vs GitHub variables.
