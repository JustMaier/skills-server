# Setup Guide: Skills Server Client for Claude Code

This guide walks through installing the skills server client as a Claude Code skill so that Claude Code can interact with your remote skills server.

## Step 1: Clone the repository

```bash
git clone <repo-url>
cd skills-server
npm install
```

## Step 2: Start the skills server

Follow the [server README](../../packages/server/README.md) to configure and start the server:

```bash
cd packages/server
cp .env.example .env
# Edit .env to set ENCRYPTION_KEY, HMAC_SECRET, and ADMIN_API_KEY
npm run dev
```

The server will start at `http://localhost:3000` by default.

## Step 3: Create an agent via the admin UI or API

Open the admin UI at `http://localhost:3000` and create a new agent. Save the API key -- it is shown only once.

Or use the API:

```bash
curl -X POST http://localhost:3000/api/v1/agents \
  -H "Authorization: Bearer <admin-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "claude-code-agent"}'
```

Save the `apiKey` from the response.

## Step 4: Grant skills to the agent

In the admin UI, go to the Permissions tab and grant the desired skills to your agent. Or use the API:

```bash
# List available skills
curl http://localhost:3000/api/v1/admin/skills \
  -H "Authorization: Bearer <admin-api-key>"

# Grant a skill to the agent
curl -X POST http://localhost:3000/api/v1/agents/<agent-id>/skills/<skill-id> \
  -H "Authorization: Bearer <admin-api-key>"
```

## Step 5: Copy the client to your Claude Code skills directory

```bash
# From the monorepo root
mkdir -p .claude/skills/skills-server

cp packages/client-claude-code/SKILL.md .claude/skills/skills-server/SKILL.md
cp packages/client-claude-code/skills-cli.mjs .claude/skills/skills-server/skills-cli.mjs
```

Or for user-level installation (available across all projects):

```bash
mkdir -p ~/.claude/skills/skills-server

cp packages/client-claude-code/SKILL.md ~/.claude/skills/skills-server/SKILL.md
cp packages/client-claude-code/skills-cli.mjs ~/.claude/skills/skills-server/skills-cli.mjs
```

## Step 6: Set environment variables

Add the following to your shell profile or a `.env` file that Claude Code can read:

```bash
export SKILLS_SERVER_URL=http://localhost:3000
export SKILLS_SERVER_API_KEY=sk-agent-your-key-here
```

Replace the API key with the one from Step 3.

## Step 7: Verify the setup

Test the CLI directly to confirm everything works:

```bash
# Set the env vars for this shell session
export SKILLS_SERVER_URL=http://localhost:3000
export SKILLS_SERVER_API_KEY=sk-agent-your-key-here

# List available skills
node .claude/skills/skills-server/skills-cli.mjs list

# Load a skill
node .claude/skills/skills-server/skills-cli.mjs load hello

# Execute a script
node .claude/skills/skills-server/skills-cli.mjs exec hello hello.mjs "world"
```

You should see JSON output for each command.

## Step 8: Use in Claude Code

Start Claude Code in your project. The agent will discover the `skills-server` skill automatically. You can prompt it with:

```
List the available remote skills from the skills server.
```

Claude Code will run `skills-cli.mjs list`, read the output, and report the available skills. From there, it can load individual skill instructions and execute scripts as needed.
