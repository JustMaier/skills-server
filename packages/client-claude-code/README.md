# @skills-server/client-claude-code

A Claude Code skill that connects to a remote [skills server](../../packages/server/README.md), allowing Claude Code to discover, load, and execute skills hosted centrally.

## What This Is

This package provides:

- **SKILL.md** -- A Claude Code skill file that teaches the agent how to use the skills server
- **skills-cli.mjs** -- A standalone Node.js CLI that wraps the skills server HTTP API

When installed as a Claude Code skill, it gives the agent a three-step workflow: list available skills, load a skill's instructions, then execute its scripts -- all via a single CLI tool.

## Prerequisites

- Node.js 18 or later (uses native `fetch`)
- A running skills server instance
- An agent API key issued by the skills server admin

## Configuration

Set two environment variables:

```bash
export SKILLS_SERVER_URL=http://localhost:3000
export SKILLS_SERVER_API_KEY=sk-agent-your-key-here
```

Or copy `.env.example` and fill in your values.

## Installation as a Claude Code Skill

### Option 1: Copy to your project skills directory

```bash
# From your project root
mkdir -p .claude/skills/skills-server
cp packages/client-claude-code/SKILL.md .claude/skills/skills-server/SKILL.md
cp packages/client-claude-code/skills-cli.mjs .claude/skills/skills-server/skills-cli.mjs
```

### Option 2: Copy to your user-level skills directory

```bash
mkdir -p ~/.claude/skills/skills-server
cp packages/client-claude-code/SKILL.md ~/.claude/skills/skills-server/SKILL.md
cp packages/client-claude-code/skills-cli.mjs ~/.claude/skills/skills-server/skills-cli.mjs
```

### Option 3: Symlink for development

```bash
# From the monorepo root
ln -s "$(pwd)/packages/client-claude-code" .claude/skills/skills-server
```

## Usage

Once installed, Claude Code will automatically discover the skill. The agent will:

1. **List skills** to see what is available:
   ```bash
   node skills-cli.mjs list
   ```
   Returns: `[{ "name": "weather", "description": "...", "scripts": ["weather.mjs"] }]`

2. **Load a skill** to read its instructions:
   ```bash
   node skills-cli.mjs load weather
   ```
   Returns the full skill definition with `content` (markdown instructions), `scripts`, and `frontmatter`.

3. **Execute a script** within a skill:
   ```bash
   node skills-cli.mjs exec weather weather.mjs "London"
   ```
   Returns: `{ "success": true, "stdout": "...", "exitCode": 0, ... }`

4. **Get help**:
   ```bash
   node skills-cli.mjs help
   ```

## How It Works

The CLI is a thin wrapper around the skills server's agent-facing HTTP API:

| CLI Command | HTTP Request |
|---|---|
| `list` | `GET /api/v1/skills` |
| `load <name>` | `GET /api/v1/skills/{name}` |
| `exec <name> <script> [args]` | `POST /api/v1/skills/{name}/execute` |

All requests include the `Authorization: Bearer <api-key>` header automatically. The agent never needs to construct HTTP requests directly.

## Error Handling

The CLI exits with a non-zero status code on errors and prints diagnostics to stderr:

- **Missing env vars** -- exits immediately with a message listing which variables are not set
- **Network failures** -- prints the connection error and the URL that failed
- **HTTP errors** -- prints the status code and the error message from the server
- **Unknown commands** -- prints usage help

## Server Setup

If you do not have a skills server running yet, see the [server README](../../packages/server/README.md) for setup instructions.

## License

MIT
