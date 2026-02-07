# Architecture Patterns: Reference

Research on architecture patterns for building a centralized skills server.

## Landscape

**MCP (Model Context Protocol)** is the closest precedent. An open protocol (now under the Linux Foundation) that standardizes how AI apps discover and invoke tools from external servers. Claude Code, Cursor, Windsurf, and VS Code Copilot all speak MCP natively. The TypeScript SDK (`@modelcontextprotocol/sdk`) supports remote servers over Streamable HTTP with session management.

**The existing `openrouter-skills-as-tools` library** already implements skill discovery, parsing, and execution locally. The server lifts this pattern to a remote, multi-tenant service.

**Docker/sandbox platforms** (E2B, Modal, Cloudflare Sandbox SDK) offer containerized execution. Overkill for v1 but inform the future direction for isolation.

## Where This Server Adds Value

MCP servers host tools but do not handle multi-tenant agent identity, per-agent environment variable injection, or administrative management. This server fills that gap: a management and permissions layer on top of the skill execution pattern.

## Tech Stack Recommendation

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | **Hono** + `@hono/zod-openapi` | Zod-native OpenAPI generation, fast, zero deps |
| Database | **SQLite** via `better-sqlite3` + **Drizzle ORM** | No external DB. Single file. Type-safe queries. |
| Validation | **Zod** | Already a peer dep of the skills library |
| Auth | **API keys** (Bearer token) | Simpler than OAuth for agent-to-server. Keys hashed with SHA-256. |
| Secrets | **AES-256-GCM** | Encrypt env var values at rest. Server-managed key. |
| Admin UI | **Single `index.html`** with Alpine.js | No build step, reactive enough for CRUD |
| API Docs | **Scalar** via `@scalar/hono-api-reference` | Modern OpenAPI UI, drop-in Hono middleware |
| MCP | `@modelcontextprotocol/sdk` | Secondary transport alongside REST |

### Why Hono Over Express/Fastify

Hono's `@hono/zod-openapi` defines routes, validation, and OpenAPI metadata in one place. Express requires manual OpenAPI wiring. Fastify uses JSON Schema (not Zod). Hono is also smaller (~14KB, zero deps) and runs on Node, Bun, Deno, and edge runtimes.

## Authentication Pattern

Each agent gets an API key (`sk-agent-<random>`). Sent as `Authorization: Bearer <key>`. Server looks up the hashed key to identify the agent and its permissions.

Data model:
```
agents       { id, name, api_key_hash, created_at }
skills       { id, name, description, dir_path }
env_vars     { id, key, encrypted_value }
agent_skills { agent_id, skill_id }
agent_env    { agent_id, env_var_id }
```

Future: add OAuth 2.1 if MCP mandates it for remote servers.

## Environment Variable Security

1. Encrypt values with AES-256-GCM before storing in SQLite
2. Server-side encryption key loaded from `ENCRYPTION_KEY` env var
3. On script execution, decrypt only the vars granted to the calling agent
4. Pass decrypted vars as the `env` option to `execFile` (the executor already supports this)
5. Values never leave the server — agents never see raw values

The management API is write-only for values: you can set/update but never read plaintext back.

## Dual Interface Architecture

```
REST API ──────> /api/v1/*  (Management: agents, skills, env vars, permissions)
MCP Protocol ──> /mcp       (Agent-facing: tools/list filtered by permissions, tools/call with env injection)
REST API ──────> /api/v1/*  (Agent-facing alternative for non-MCP agents)
```

Build REST first (management plane + simple agent integration). Add MCP as a second interface that reuses the same permission checks and executor.

## Skill Ingestion

**v1:** Scan a configured skills directory at startup. Store metadata in SQLite. Expose a `/api/v1/skills/reload` endpoint.

**v1.1:** Pull from a git repo on webhook or schedule.

**Future:** Registry with versioning, validation, and publishing.

## Recommended Project Structure

```
skills-server/
  src/
    index.ts                # Entry point
    app.ts                  # Hono app, middleware
    db/
      schema.ts             # Drizzle schema
      migrations/
      index.ts              # DB connection
    routes/
      agents.ts             # Agent CRUD
      skills.ts             # Skill CRUD + reload
      env-vars.ts           # Env var CRUD
      permissions.ts        # Agent-skill and agent-env grants
      execute.ts            # Skill execution (REST)
    mcp/
      server.ts             # MCP server factory
      handler.ts            # Hono route for MCP transport
    services/
      skills.ts             # Discovery, parsing (reuse from openrouter-skills)
      executor.ts           # Script execution (reuse from openrouter-skills)
      crypto.ts             # AES-256-GCM for env vars
      auth.ts               # API key validation middleware
    public/
      index.html            # Admin UI
  skills/                   # Default skills directory
  drizzle.config.ts
  package.json
  tsconfig.json
```
