# Skills Server: Implementation Plan

A centralized server that hosts skills for AI agents. Agents authenticate with an API key, discover skills they have access to, read skill instructions, and execute scripts — all remotely. Environment variables are encrypted at rest and scoped per-agent.

Agents connect via a downloadable SKILL.md that teaches them how to register and use the server's REST API. No MCP server needed — skills are the integration layer.

## Problem

Teams running multiple AI agents need centralized skill management. Today each agent runs skills locally, which means:
- Skills drift out of sync across agents
- No central control over which agents use which skills
- No way to manage secrets per-agent
- Scripts execute in the agent's environment, not a controlled one

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Skills Server                      │
│                                                      │
│  REST API (/api/v1)                                  │
│  ├─ Agent-facing: list, load, execute skills         │
│  ├─ Management: agents, env vars, permissions        │
│  ├─ Admin: skill reload, diagnostics                 │
│  └─ OpenAPI spec + Scalar docs                       │
│                                                      │
│  Services                                            │
│  ├─ Skill discovery & parsing (from openrouter-skills)│
│  ├─ Script executor (execFile, security constraints) │
│  ├─ Auth middleware (API key → agent identity)       │
│  └─ Crypto (AES-256-GCM for env var values)         │
│                                                      │
│  SQLite (WAL mode)            Skills Directory       │
│  ├─ agents                    ├─ discord/            │
│  ├─ skills                    │   ├─ SKILL.md        │
│  ├─ env_vars                  │   └─ discord.mjs     │
│  ├─ agent_skills              ├─ weather/            │
│  ├─ agent_env_vars            │   ├─ SKILL.md        │
│  └─ execution_logs            │   └─ weather.mjs     │
└─────────────────────────────────────────────────────┘

Agents integrate via a downloadable SKILL.md that contains
instructions for calling the REST API. No MCP needed.
```

## Agent Integration Model

Instead of MCP, agents use a SKILL.md file served by the server itself. An agent (or its operator) downloads or points to this skill, which teaches the agent how to:

1. Authenticate with `Authorization: Bearer <api-key>`
2. List available skills (`GET /api/v1/skills`)
3. Load skill instructions (`GET /api/v1/skills/:name`)
4. Execute scripts (`POST /api/v1/skills/:name/execute`)

This works with Claude Code, OpenRouter agents, or any agent that supports skills/tools.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Framework | Hono + `@hono/zod-openapi` |
| Database | SQLite via `better-sqlite3` + Drizzle ORM |
| Validation | Zod (single source for schemas + OpenAPI) |
| API docs | Scalar (`@scalar/hono-api-reference`) |
| Admin UI | Single `index.html` with Alpine.js |
| Runtime | Node.js 20+ |
| Language | TypeScript (strict) |

## Data Model

```sql
-- Agents: each AI agent or agent group
agents (
  id          TEXT PRIMARY KEY,    -- UUID
  name        TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,      -- HMAC-SHA-256 of the API key (server-side secret)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)

-- Skills: metadata synced from the skills directory
skills (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL, -- Matches folder name
  description TEXT,
  dir_path    TEXT NOT NULL,        -- Absolute path on disk (never exposed via API)
  scripts     TEXT NOT NULL,        -- JSON array of discovered script filenames
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)

-- Environment variables: encrypted values
env_vars (
  id              TEXT PRIMARY KEY,
  key             TEXT UNIQUE NOT NULL,  -- Variable name (e.g. DISCORD_TOKEN)
  encrypted_value TEXT NOT NULL,         -- AES-256-GCM ciphertext
  description     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)

-- Junction: which agents can use which skills
agent_skills (
  agent_id  TEXT REFERENCES agents(id) ON DELETE CASCADE,
  skill_id  TEXT REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
)

-- Junction: which agents can see which env vars
agent_env_vars (
  agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
  env_var_id  TEXT REFERENCES env_vars(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, env_var_id)
)

-- Execution log: audit trail for every script run
execution_logs (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT REFERENCES agents(id),
  skill_name  TEXT NOT NULL,
  script      TEXT NOT NULL,
  args        TEXT,                -- JSON array
  exit_code   INTEGER,
  error       TEXT,               -- Error code if failed
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
)
```

Database initialization enables WAL mode (`PRAGMA journal_mode = WAL`) for concurrent read/write safety.

## API Design

All routes use Zod schemas for request/response validation. OpenAPI spec auto-generated at `/api/v1/openapi.json`. Scalar UI at `/api/v1/docs`.

### Agent-Facing Endpoints

These are what AI agents call to use skills.

```
GET    /api/v1/skills               → List skills (name, description, scripts[], filtered by agent perms)
GET    /api/v1/skills/:name         → Get skill (parsed frontmatter + markdown body, not raw SKILL.md)
POST   /api/v1/skills/:name/execute → Execute a script within a skill
```

**List response** includes scripts so agents know what they can execute without loading:
```json
[
  { "name": "discord", "description": "Post messages to Discord.", "scripts": ["discord.mjs"] }
]
```

**Get skill response** returns parsed frontmatter separately from body:
```json
{
  "name": "discord",
  "description": "Post messages to Discord.",
  "frontmatter": { "name": "discord", "description": "..." },
  "content": "## Usage\n\nList channels:\n...",
  "scripts": ["discord.mjs"],
  "updatedAt": 1738886400
}
```

**Execute request:**
```json
{
  "script": "discord.mjs",
  "args": ["channels", "list"]
}
```

**Execute response** mirrors `SkillExecutionResult` with full diagnostics:
```json
{
  "success": true,
  "stdout": "...",
  "stderr": "",
  "exitCode": 0,
  "error": null,
  "durationMs": 142
}
```

Error codes are machine-readable: `SkillNotFound`, `ScriptNotFound`, `ScriptNotAllowed`, `InvalidArgs`, `ExecutionTimeout`, `ExecutionFailed`. Agents use these to self-correct.

### Management Endpoints

```
-- Agents
POST   /api/v1/agents              → Create agent (returns API key once)
GET    /api/v1/agents               → List agents
GET    /api/v1/agents/:id           → Get agent
PATCH  /api/v1/agents/:id           → Update agent
DELETE /api/v1/agents/:id           → Delete agent
POST   /api/v1/agents/:id/rotate   → Rotate API key

-- Skills (admin view)
GET    /api/v1/admin/skills         → List all skills with metadata + parse errors
POST   /api/v1/admin/skills/reload  → Rescan skills directory

-- Environment Variables
POST   /api/v1/env-vars             → Create env var (value encrypted on write)
GET    /api/v1/env-vars             → List env vars (keys only, no values)
PATCH  /api/v1/env-vars/:id         → Update env var value
DELETE /api/v1/env-vars/:id         → Delete env var

-- Permissions (bulk)
PUT    /api/v1/agents/:id/skills          → Set agent's granted skills (full replace)
PUT    /api/v1/agents/:id/env-vars        → Set agent's granted env vars (full replace)
GET    /api/v1/agents/:id/permissions     → View agent's full permission set

-- Permissions (incremental)
POST   /api/v1/agents/:id/skills/:skillId       → Grant a single skill
DELETE /api/v1/agents/:id/skills/:skillId       → Revoke a single skill
POST   /api/v1/agents/:id/env-vars/:envVarId   → Grant a single env var
DELETE /api/v1/agents/:id/env-vars/:envVarId   → Revoke a single env var

-- Reverse lookups
GET    /api/v1/env-vars/:id/agents        → Which agents have this env var
GET    /api/v1/skills/:name/agents        → Which agents have this skill (admin)

-- Execution logs
GET    /api/v1/execution-logs             → List recent executions (filterable by agent, skill)
```

### Authentication

Agent-facing endpoints require `Authorization: Bearer <api-key>`. The server computes HMAC-SHA-256 of the key (using a server-side secret) and looks up the agent by hash. No session state. HMAC prevents offline brute-force if the database leaks.

Management endpoints require a separate admin API key, configured via `ADMIN_API_KEY` environment variable. Admin middleware checks this before agent CRUD, env var management, and permission changes. The admin UI at `/` is protected by the same admin key (sent as a cookie or header).

Internal paths (`dir_path`, absolute filesystem locations) are never exposed in API responses. Skills are referenced by `name` or `id` only.

## Environment Variable Flow

1. Admin creates an env var via API: `POST /api/v1/env-vars { key: "DISCORD_TOKEN", value: "xoxb-..." }`
2. Server encrypts value with AES-256-GCM, stores ciphertext in SQLite
3. Admin grants the env var to an agent: `PUT /api/v1/agents/:id/env-vars { env_var_ids: [...] }`
4. Agent calls execute to run `discord.mjs`
5. Server looks up which env vars the agent has access to
6. Server decrypts those values in memory
7. Server passes them as the `env` option to `execFile`
8. Script runs with those env vars, returns output
9. Decrypted values are never returned to the agent

The admin UI shows env var names and assignments but never displays values after initial creation.

## Skill Discovery and Reload

### Startup Scan

On startup, the server scans the configured skills directory (same SKILL.md + scripts structure as `openrouter-skills-as-tools`). It:

1. Reads each subdirectory for `SKILL.md`
2. Parses frontmatter (name, description)
3. Discovers scripts by extension (`.mjs`, `.js`, `.sh`)
4. Upserts skill records into SQLite
5. Records any parse errors for skills with malformed SKILL.md

### Request-Time Staleness Check

Following the pattern from `openrouter-skills-as-tools`, the server checks SKILL.md mtime on each request:
- If mtime changed since last parse, re-parse the skill
- If a requested skill is not in the map, rescan the directory for new skills
- If a requested script is not in the allowlist, force re-parse and re-check

No file watcher needed. Changes are picked up on the next request.

### Admin Reload

The `POST /api/v1/admin/skills/reload` endpoint triggers a full rescan. The admin skills list (`GET /api/v1/admin/skills`) includes parse errors so operators can see broken skills.

## Admin UI

A single `index.html` served at `/` with Alpine.js. No build step. Pages:

- **Skills** — browse discovered skills, view descriptions and scripts, see parse errors for broken skills
- **Agents** — create/edit agents, view API keys (shown once on creation)
- **Environment Variables** — create/edit keys, set values (write-only display)
- **Permissions** — assign skills and env vars to agents (checkboxes)
- **Logs** — recent execution history (filterable by agent, skill)

The UI calls the REST API exclusively. Protected by admin auth.

## Project Structure

```
skills-server/
  src/
    index.ts                  # Entry point: start server
    app.ts                    # Hono app, middleware, static files
    db/
      schema.ts               # Drizzle schema definitions
      index.ts                # DB connection + migrations
    routes/
      agent-facing.ts         # Skill list, content, execute
      agents.ts               # Agent CRUD
      skills-admin.ts         # Skills admin + reload + diagnostics
      env-vars.ts             # Env var CRUD
      permissions.ts          # Grant/revoke skills and env vars
      execution-logs.ts       # Execution log queries
    services/
      discovery.ts            # Skill directory scanning + staleness checks
      executor.ts             # Script execution (port from openrouter-skills)
      crypto.ts               # AES-256-GCM encrypt/decrypt
      auth.ts                 # API key middleware (agent + admin)
    public/
      index.html              # Admin UI
  skills/                     # Default skills directory
  drizzle.config.ts
  package.json
  tsconfig.json
```

## Implementation Phases

### Phase 1: Core Server

1. Initialize project (package.json, tsconfig, Hono, Drizzle, SQLite)
2. Define Drizzle schema and run initial migration
3. Port skill discovery and script executor from `openrouter-skills-as-tools`
4. Implement auth middleware (API key → agent lookup, admin key)
5. Build agent-facing routes (list skills, get content, execute)
6. Build management routes (agents CRUD, env vars CRUD, permissions)
7. Add crypto service for env var encryption
8. Wire env var injection into executor
9. Add execution logging
10. Add skill diagnostics (parse errors in admin endpoints)
11. Serve OpenAPI spec and Scalar docs
12. Create the downloadable SKILL.md for agent integration
13. Add rate limiting TODOs at middleware attachment points

### Phase 2: Admin UI

14. Build single-page admin UI with Alpine.js
15. Skills browser (with parse error display), agent management, env var management, permissions grid, execution logs

### Phase 3: Skill Ingestion

16. Add git-based skill pulling (webhook or manual trigger)

## Design Decisions

**Why no MCP?** Agents already understand skills. A downloadable SKILL.md that teaches agents to call the REST API is simpler and works with any agent platform. MCP can be added later if needed.

**Why Hono?** Its `@hono/zod-openapi` package defines routes, validation, and OpenAPI metadata in one place. No glue code between schema and spec.

**Why SQLite?** Self-hosted server, no external dependencies. Single file backup. Fast enough for this workload.

**Why API keys over OAuth?** Primary consumers are AI agents, not browser users. API keys are stateless and simple.

**Why request-time staleness instead of file watching?** Matches the proven pattern from `openrouter-skills-as-tools`. Simpler, no watcher daemon, changes are picked up on the next request.

**Why encrypt env vars?** Defense in depth. If the database leaks, values remain protected. The encryption key lives outside the database.

**Why no execution sandboxing in v1?** Docker adds deployment complexity and doesn't work everywhere. For v1, trust the skills directory. Scripts run under the server's OS user with `execFile` (no shell). Future versions can add container isolation.

**Why reuse openrouter-skills patterns?** The skill format, discovery logic, and executor are proven. Port the relevant modules rather than depending on the npm package (the server has different concerns like multi-tenancy).
