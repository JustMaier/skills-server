# Skills Server

A centralized server for managing and executing AI agent skills. Agents authenticate with API keys, discover available skills, read instructions, and execute scripts remotely. An admin manages agents, skills, environment variables, and permissions through a REST API and web UI.

Built with [Hono](https://hono.dev), [Drizzle ORM](https://orm.drizzle.team), and SQLite.

## Why

When multiple AI agents need access to the same skills (scripts, tools, integrations), managing skill files across every agent becomes fragile. This server centralizes skill hosting so agents fetch instructions and execute scripts over HTTP. Environment variables stay on the server — agents never see the raw secrets.

## Quick Start

```bash
# Clone and install
git clone <repo-url> && cd skills-server
npm install

# Generate secrets for .env
cp .env.example .env
node -e "const c=require('crypto'); console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('hex')); console.log('HMAC_SECRET='+c.randomBytes(32).toString('hex')); console.log('ADMIN_API_KEY=sk-admin-'+c.randomBytes(16).toString('hex'))" >> .env

# Start the dev server (requires Node 22+)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the admin UI, or [http://localhost:3000/api/v1/docs](http://localhost:3000/api/v1/docs) for the interactive API reference.

## Configuration

All configuration is in `.env`:

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 3000) |
| `SKILLS_DIR` | No | Path to skills directory (default: `./skills`) |
| `ENCRYPTION_KEY` | Yes | 64-character hex string (32 bytes) for AES-256-GCM encryption of env var values |
| `HMAC_SECRET` | Yes | Hex string used as HMAC-SHA-256 secret for API key hashing |
| `ADMIN_API_KEY` | Yes | Admin API key for management endpoints |

## Creating Skills

A skill is a directory containing a `SKILL.md` file and one or more executable scripts:

```
skills/
  weather/
    SKILL.md          # Frontmatter + markdown instructions
    weather.mjs       # Executable script
    scripts/          # Optional subfolder for additional scripts
      setup.sh
```

### SKILL.md Format

```markdown
---
name: weather
description: Get current weather for any city.
---

## Usage

Fetch weather for a city:

\```
weather.mjs <city>
\```

The script returns temperature, wind speed, and conditions.
```

The YAML frontmatter supports `name` (defaults to folder name) and `description` (defaults to first paragraph). The markdown body is returned to agents as the skill's instructions.

### Scripts

Scripts can be `.mjs`, `.js`, or `.sh` files. They run server-side via `execFile` (no shell) with a 30-second timeout and 20KB output cap. Scripts in a `scripts/` subfolder are also discovered.

The server scans `SKILLS_DIR` on startup. Hit `POST /api/v1/admin/skills/reload` or use the admin UI to rescan after adding skills. Individual skills are also re-parsed on access when their `SKILL.md` file changes on disk.

## Permissions Model

Three concepts control what an agent can do:

1. **Agent Skills** — which skills an agent can discover and execute
2. **Agent Env Vars** — which env vars an agent has been granted
3. **Skill Env Vars** — which env vars a skill requires

When an agent executes a skill, the injected environment variables are the **intersection** of (2) and (3). This means:

- A skill only receives env vars explicitly linked to it
- An agent can only provide env vars explicitly granted to it
- If a skill has no linked env vars, none are injected (strict)

This scoping prevents a skill from accessing secrets meant for other skills, even if the agent has those secrets granted.

### Example

```
Agent "deploy-bot" has:  GITHUB_TOKEN, SLACK_WEBHOOK, AWS_KEY
Skill "github" needs:    GITHUB_TOKEN
Skill "slack" needs:     SLACK_WEBHOOK

When deploy-bot executes "github":
  → only GITHUB_TOKEN is injected

When deploy-bot executes "slack":
  → only SLACK_WEBHOOK is injected

Neither skill can see the other's secrets or AWS_KEY.
```

## Admin API

All management endpoints require `Authorization: Bearer <admin-api-key>`.

### Agents

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/agents` | Create agent (returns API key — save it, shown once) |
| `GET` | `/api/v1/agents` | List all agents |
| `GET` | `/api/v1/agents/:id` | Get agent details |
| `PATCH` | `/api/v1/agents/:id` | Rename agent |
| `DELETE` | `/api/v1/agents/:id` | Delete agent (cascades permissions) |
| `POST` | `/api/v1/agents/:id/rotate` | Rotate API key |

### Environment Variables

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/env-vars` | Create encrypted env var |
| `GET` | `/api/v1/env-vars` | List env vars (values never exposed) |
| `PATCH` | `/api/v1/env-vars/:id` | Update env var |
| `DELETE` | `/api/v1/env-vars/:id` | Delete env var |

### Skills Administration

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/skills` | List all discovered skills |
| `POST` | `/api/v1/admin/skills/reload` | Rescan skills directory |
| `GET` | `/api/v1/admin/skills/:id/env-vars` | List a skill's required env vars |
| `PUT` | `/api/v1/admin/skills/:id/env-vars` | Set a skill's required env vars |
| `POST` | `/api/v1/admin/skills/:id/env-vars/:envVarId` | Link an env var to a skill |
| `DELETE` | `/api/v1/admin/skills/:id/env-vars/:envVarId` | Unlink an env var from a skill |

### Permissions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/agents/:id/permissions` | View agent's granted skills and env vars |
| `PUT` | `/api/v1/agents/:id/skills` | Set agent's skills (full replace) |
| `PUT` | `/api/v1/agents/:id/env-vars` | Set agent's env vars (full replace) |
| `POST` | `/api/v1/agents/:id/skills/:skillId` | Grant one skill |
| `DELETE` | `/api/v1/agents/:id/skills/:skillId` | Revoke one skill |
| `POST` | `/api/v1/agents/:id/env-vars/:envVarId` | Grant one env var |
| `DELETE` | `/api/v1/agents/:id/env-vars/:envVarId` | Revoke one env var |

### Execution Logs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/execution-logs` | List recent executions (filterable by agent, skill) |

## Agent API

Agents authenticate with `Authorization: Bearer <agent-api-key>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/skills` | List skills the agent can access |
| `GET` | `/api/v1/skills/:name` | Get full skill content (markdown + scripts) |
| `POST` | `/api/v1/skills/:name/execute` | Execute a script within a skill |

### Execute Request

```json
{
  "script": "weather.mjs",
  "args": ["London"]
}
```

### Execute Response

```json
{
  "success": true,
  "stdout": "Weather for London, United Kingdom:\n  Temperature: 48.4°F\n  Wind: 5.3 mph\n  Conditions: Partly cloudy\n  Units: fahrenheit",
  "stderr": "",
  "exitCode": 0,
  "error": null,
  "durationMs": 523
}
```

## Using with Claude Code

The server ships a `SKILL.md` file at `/api/v1/skill.md` that teaches Claude Code how to interact with the API. Download it and place it in your `.claude/skills/` directory, or install it as a user skill:

```bash
# Download the integration skill
curl -o .claude/skills/skills-server/SKILL.md \
  http://localhost:3000/api/v1/skill.md

# Or reference it directly in CLAUDE.md:
# See .claude/skills/skills-server/SKILL.md for remote skills access
```

Then tell Claude Code to load the skill with your server URL and agent API key:

```
Load the skills-server skill. Server is http://localhost:3000, key is sk-agent-xxx
```

Claude Code will then be able to list, load, and execute remote skills using the HTTP API.

## Using with openrouter-skills-as-tools

The [openrouter-skills-as-tools](https://github.com/your-org/openrouter-skills-as-tools) library gives OpenRouter SDK agents directory-based skills with two tools: `load_skill` and `use_skill`. To connect it to this server instead of local files, create a thin adapter:

```javascript
import { OpenRouter } from 'openrouter';

const SKILLS_SERVER = 'http://localhost:3000';
const AGENT_KEY = 'sk-agent-xxx';

const headers = {
  'Authorization': `Bearer ${AGENT_KEY}`,
  'Content-Type': 'application/json',
};

// Define tools that proxy to the skills server
const tools = [
  {
    name: 'load_skill',
    description: 'Load a skill from the remote skills server',
    parameters: { type: 'object', properties: { skill: { type: 'string' } }, required: ['skill'] },
    async execute({ skill }) {
      const res = await fetch(`${SKILLS_SERVER}/api/v1/skills/${skill}`, { headers });
      if (!res.ok) return { error: `Skill not found: ${skill}` };
      const data = await res.json();
      return { content: data.content, scripts: data.scripts };
    },
  },
  {
    name: 'use_skill',
    description: 'Execute a script within a loaded skill',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        script: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['skill', 'script'],
    },
    async execute({ skill, script, args = [] }) {
      const res = await fetch(`${SKILLS_SERVER}/api/v1/skills/${skill}/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ script, args }),
      });
      return await res.json();
    },
  },
];
```

This replaces local file reads and `execFile` calls with HTTP requests to the skills server, keeping the same two-tool model agents already understand.

## Admin UI

The admin UI at `/` is a single-page Alpine.js application with five tabs:

- **Skills** — view discovered skills, reload from disk, configure which env vars each skill requires
- **Agents** — create/edit/delete agents, rotate API keys
- **Env Vars** — create/edit/delete encrypted environment variables
- **Permissions** — grant/revoke skills and env vars per agent with checkboxes
- **Logs** — view execution history with agent and skill filters

No build step required — it's a single `index.html` file served from `public/`.

## Security

- **API key hashing** — agent keys are HMAC-SHA-256 hashed before storage; raw keys are never persisted
- **Env var encryption** — values are AES-256-GCM encrypted at rest; the admin API never returns plaintext values
- **Per-skill env var scoping** — skills only receive env vars explicitly linked to them
- **Script containment** — `execFile` (no shell), path traversal prevention, resolved paths must stay within the skill directory
- **Timing-safe comparison** — admin key comparison uses HMAC-based constant-time comparison
- **Execution limits** — 30-second timeout, 20KB output cap per stream

## Project Structure

```
skills-server/
  src/
    index.ts              # Entry point, startup, skill sync
    app.ts                # Hono app, middleware, route wiring
    db/
      schema.ts           # Drizzle ORM table definitions
      index.ts            # SQLite connection, table creation
    routes/
      agent-facing.ts     # GET/POST /api/v1/skills (agent auth)
      agents.ts           # CRUD /api/v1/agents (admin auth)
      env-vars.ts         # CRUD /api/v1/env-vars (admin auth)
      permissions.ts      # Grant/revoke /api/v1/agents/:id/* (admin auth)
      skills-admin.ts     # Skill management + skill env vars (admin auth)
      execution-logs.ts   # GET /api/v1/execution-logs (admin auth)
    services/
      auth.ts             # Agent + admin auth middleware
      crypto.ts           # HMAC, AES-256-GCM, key generation
      discovery.ts        # Skill directory scanner + staleness manager
      executor.ts         # Secure script execution
  public/
    index.html            # Admin UI (Alpine.js SPA)
    skill.md              # Agent integration SKILL.md
  skills/                 # Default skills directory
    hello/                # Example: simple echo skill
    weather/              # Example: weather API with env var scoping
  test-api.mjs            # Basic API tests (20 tests)
  test-e2e.mjs            # Full agent workflow tests (17 tests)
  test-weather.mjs        # Env var scoping tests (10 tests)
```

## Scripts

```bash
npm run dev       # Start dev server with hot reload (tsx watch)
npm run build     # Compile TypeScript to dist/
npm start         # Run production build
```

## License

MIT
