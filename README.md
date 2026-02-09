# ai-skills

A centralized skills server and client SDKs for AI agents. Agents authenticate with API keys, discover skills, read instructions, and execute scripts over HTTP. Secrets stay on the server — agents never see raw values.

## Packages

| Package | Description |
|---|---|
| [`packages/server`](packages/server/README.md) | Hono + SQLite skills server with admin UI and OpenAPI docs |
| [`packages/client-claude-code`](packages/client-claude-code/README.md) | Claude Code skill — CLI wrapper for the server API |
| [`packages/client-openrouter`](packages/client-openrouter/README.md) | OpenRouter SDK client — `load_skill` / `use_skill` tools with streaming |
| [`packages/client-agent-sdk`](packages/client-agent-sdk/README.md) | Claude Agent SDK client — MCP server with three tools |

## Prerequisites

- Node.js 22+
- npm 7+ (workspaces support)

## Setup

```bash
git clone <repo-url> && cd ai-skills
npm install
```

## Start the Server

```bash
cd packages/server

# Generate secrets (first time only)
cp .env.example .env
node -e "
  const c = require('crypto');
  console.log('ENCRYPTION_KEY=' + c.randomBytes(32).toString('hex'));
  console.log('HMAC_SECRET=' + c.randomBytes(32).toString('hex'));
  console.log('ADMIN_API_KEY=sk-admin-' + c.randomBytes(16).toString('hex'));
" >> .env

# Start
npm run dev
```

The server runs at `http://localhost:3000`. Open `/` for the admin UI or `/api/v1/docs` for the API reference.

## Create an Agent

Before any client can connect, create an agent and grant it access to skills:

```bash
ADMIN_KEY="<your-admin-api-key-from-.env>"
BASE="http://localhost:3000/api/v1"

# Create an agent (save the apiKey — it's shown only once)
curl -X POST "$BASE/agents" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent"}'

# List skills to get their IDs
curl "$BASE/admin/skills" -H "Authorization: Bearer $ADMIN_KEY"

# Grant skills to the agent
curl -X PUT "$BASE/agents/<agent-id>/skills" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"skillIds": ["<skill-id-1>", "<skill-id-2>"]}'
```

Or do all of this through the admin UI at `http://localhost:3000`.

## Connect a Client

### Claude Code

Copy the skill files into your Claude Code skills directory:

```bash
mkdir -p .claude/skills/skills-server
cp packages/client-claude-code/SKILL.md .claude/skills/skills-server/
cp packages/client-claude-code/skills-cli.mjs .claude/skills/skills-server/
```

Set the environment variables and tell Claude Code to use the skill:

```bash
export SKILLS_SERVER_URL=http://localhost:3000
export SKILLS_SERVER_API_KEY=sk-agent-your-key-here
```

Claude Code will discover the skill automatically. Ask it to "list the available skills" to verify.

### OpenRouter SDK

```bash
cd packages/client-openrouter
npm run build
```

```typescript
import { OpenRouter } from '@openrouter/sdk';
import { createSkillsProvider, createSdkTools } from '@skills-server/client-openrouter';

const provider = await createSkillsProvider('http://localhost:3000', 'sk-agent-...');
const tools = createSdkTools(provider);

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
const result = client.callModel({
  model: 'anthropic/claude-sonnet-4',
  input: 'What skills are available?',
  tools,
});

console.log(await result.getMessage());
```

A full chat app with streaming is in [`packages/client-openrouter/example/`](packages/client-openrouter/README.md#example-app).

### Claude Agent SDK

```bash
cd packages/client-agent-sdk
npm run build
```

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSkillsServerConfig } from '@skills-server/client-agent-sdk';

const config = createSkillsServerConfig('http://localhost:3000', 'sk-agent-...');

for await (const message of query({
  prompt: 'List the available skills, then run the hello script',
  options: { ...config, maxTurns: 10 },
})) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') process.stdout.write(block.text);
    }
  }
}
```

A chat server with SSE streaming and a web UI is in [`packages/client-agent-sdk/example/`](packages/client-agent-sdk/README.md#running-the-example).

## Run an Example End-to-End

With the server running and an agent created:

```bash
# Agent SDK example
cd packages/client-agent-sdk
npm run build
cd example
cp .env.example .env
# Edit .env: set SKILLS_SERVER_URL and SKILLS_SERVER_API_KEY
npm install
npm start
# Open http://localhost:3002
```

```bash
# OpenRouter example
cd packages/client-openrouter
npm run build
cd example
cp .env.example .env
# Edit .env: set SKILLS_SERVER_URL, SKILLS_SERVER_API_KEY, and OPENROUTER_API_KEY
npm install
npm start
# Open http://localhost:3001
```

## Project Structure

```
ai-skills/
  packages/
    server/              # Skills server (Hono + Drizzle + SQLite)
    client-claude-code/  # Claude Code skill (CLI wrapper)
    client-openrouter/   # OpenRouter SDK client (TypeScript)
    client-agent-sdk/    # Claude Agent SDK client (TypeScript)
```

## License

MIT
