---
name: skills-server
description: Connect to a centralized skills server to discover, load, and execute remote skills. Supports self-service environment variables, skill registration from Git repos, and a standalone CLI.
---

# Skills Server

You are connected to a skills server that hosts skills remotely. Use the CLI or HTTP API to discover skills, read their instructions, execute their scripts, and manage your environment variables.

## Setup

The CLI (`skills-cli.mjs`) is a standalone Node.js script with zero dependencies. Configure it with two environment variables:

```bash
export SKILLS_SERVER_URL="$ARGUMENTS"   # Server URL (passed as first argument)
export SKILLS_SERVER_KEY="<your-api-key>"
```

Download the CLI from the server:

```bash
curl -o skills-cli.mjs $ARGUMENTS/public/skills-cli.mjs
chmod +x skills-cli.mjs
```

Or use `sync-local` to generate local SKILL.md stubs for all available skills:

```bash
node skills-cli.mjs sync-local --dir .claude/skills
```

## Core Workflow

### 1. Discover skills

```bash
node skills-cli.mjs list
```

### 2. Read a skill's instructions

```bash
node skills-cli.mjs load <name>
```

Read the output — it contains the skill's full usage instructions and available scripts.

### 3. Execute a script

```bash
node skills-cli.mjs exec <name> <script> [args...]
```

## Environment Variables

Skills may require environment variables (API keys, config). If execution returns a **422 error** with `missingEnvVars`, you need to create and link them:

```bash
# Create your own env var
node skills-cli.mjs env set API_KEY "sk-..." --desc "My API key"

# List your env vars to get the ID
node skills-cli.mjs env list

# Link it to the skill that needs it
node skills-cli.mjs env link <skillId> <envVarId>
```

The 422 response includes hints:
- `"reason": "missing"` — you don't have this env var yet. Create it with `env set`.
- `"reason": "not_linked"` — you have it but haven't linked it to this skill. Use `env link`.

## Skill Registry

Register skills from Git repos (requires `maintain` permission):

```bash
# Register a skill from a public repo
node skills-cli.mjs register https://github.com/user/repo --subpath my-skill --name my-skill

# Register from a private repo
node skills-cli.mjs register https://github.com/org/private-repo --authToken ghp_...

# Pull latest changes
node skills-cli.mjs sync <registryId>
```

## HTTP API Reference

All endpoints require `Authorization: Bearer <api-key>` header. Replace `{server}` with `$ARGUMENTS`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `{server}/api/v1/skills` | List available skills |
| GET | `{server}/api/v1/skills/{name}` | Load skill content |
| POST | `{server}/api/v1/skills/{name}/execute` | Execute a script |
| GET | `{server}/api/v1/self/env-vars` | List my env vars |
| POST | `{server}/api/v1/self/env-vars` | Create env var |
| PATCH | `{server}/api/v1/self/env-vars/{id}` | Update env var |
| DELETE | `{server}/api/v1/self/env-vars/{id}` | Delete env var |
| POST | `{server}/api/v1/self/skills/{skillId}/env-vars/{envVarId}` | Link env var to skill |
| DELETE | `{server}/api/v1/self/skills/{skillId}/env-vars/{envVarId}` | Unlink env var |
| POST | `{server}/api/v1/registry` | Register skill from Git repo |
| GET | `{server}/api/v1/registry` | List registry entries |
| POST | `{server}/api/v1/registry/{id}/sync` | Sync (git pull) |
| DELETE | `{server}/api/v1/registry/{id}` | Unregister skill |

## Tips

- Always `list` first, then `load` a skill before executing — the instructions tell you how to use it.
- Check `scripts` in the load response to know which scripts are available.
- If you get a 422, read the `missingEnvVars` array — it tells you exactly what to do.
- Use `--json` flag on any command for raw JSON output.
- Use `sync-local` to create local stubs so skill-scanning frameworks discover your remote skills.
