# @skills-server/client-agent-sdk

Claude Agent SDK client for the skills server. Connects your Claude Agent SDK agents to a remote skills server, exposing remote skills as MCP tools that the agent can discover, read, and execute.

## Installation

```bash
npm install @skills-server/client-agent-sdk
```

Peer dependencies (install separately):

```bash
npm install @anthropic-ai/claude-agent-sdk zod
```

## Quick Start

The fastest way to get started is with `createSkillsServerConfig()`, which pre-fetches available skills and returns an object you can spread directly into `query()` options. The returned `systemPrompt` uses the `claude_code` preset with the skills catalog appended, so the agent knows what's available from the first turn.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSkillsServerConfig } from "@skills-server/client-agent-sdk";

const config = await createSkillsServerConfig(
  "http://localhost:3000",   // skills server URL
  "your-agent-api-key",     // agent API key
);

for await (const message of query({
  prompt: "List the available skills and run the hello script",
  options: {
    ...config,
    maxTurns: 10,
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
  if (message.type === "result" && message.subtype === "success") {
    console.log("\n\nResult:", message.result);
  }
}
```

## Advanced Usage

If you need to combine the skills server with other MCP servers or customize the configuration, use `createSkillsServer()` directly:

```typescript
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { createSkillsServer } from "@skills-server/client-agent-sdk";
import { z } from "zod";

// Create the skills server MCP instance
const skillsServer = createSkillsServer("http://localhost:3000", "your-api-key");

// Create your own custom MCP server
const customServer = createSdkMcpServer({
  name: "custom-tools",
  version: "1.0.0",
  tools: [
    tool("my_tool", "Does something custom", { input: z.string() }, async (args) => {
      return { content: [{ type: "text", text: `Processed: ${args.input}` }] };
    }),
  ],
});

// Combine both servers in the query options
for await (const message of query({
  prompt: "Use both skill tools and custom tools",
  options: {
    mcpServers: {
      "skills-server": skillsServer,
      "custom-tools": customServer,
    },
    allowedTools: [
      "mcp__skills-server__list_skills",
      "mcp__skills-server__load_skill",
      "mcp__skills-server__execute_skill",
      "mcp__custom-tools__my_tool",
    ],
    maxTurns: 10,
  },
})) {
  // handle messages...
}
```

## Tools

The package registers three MCP tools under the `skills-server` namespace:

### `mcp__skills-server__list_skills`

Lists all skills the agent has access to on the remote server. Takes no arguments. Returns each skill's name, description, and available scripts.

### `mcp__skills-server__load_skill`

Loads a skill's full instructions and content.

| Parameter | Type   | Description              |
|-----------|--------|--------------------------|
| `name`    | string | Name of the skill to load |

Returns the skill's markdown content, frontmatter metadata, available scripts, and last updated timestamp.

### `mcp__skills-server__execute_skill`

Executes a script from a skill on the remote server.

| Parameter | Type     | Description                              |
|-----------|----------|------------------------------------------|
| `name`    | string   | Name of the skill                        |
| `script`  | string   | Script filename to run                   |
| `args`    | string[] | Arguments to pass to the script (default: []) |

Returns the script's exit code, stdout, stderr, duration, and success status.

## Tool Naming Convention

The Claude Agent SDK uses the pattern `mcp__<server-name>__<tool-name>` for MCP tool identifiers. Since this package registers its server as `skills-server`, all tool names follow the format:

```
mcp__skills-server__<tool_name>
```

## Running the Example

```bash
# From packages/client-agent-sdk/
npm run build

# Set environment variables
export SKILLS_SERVER_URL=http://localhost:3000
export SKILLS_SERVER_API_KEY=your-agent-api-key

# Run the example
npx tsx example/agent.ts
```

See `example/.env.example` for the required environment variables.

## API Reference

### `await createSkillsServerConfig(serverUrl, apiKey)`

Creates an MCP server, pre-fetches the skills catalog, and returns a configuration object ready to spread into `query()` options.

**Parameters:**
- `serverUrl` (string) -- Base URL of the skills server
- `apiKey` (string) -- Bearer token for agent authentication

**Returns:** `{ mcpServers, allowedTools, systemPrompt, skillsCatalog }` -- spread this into `query()` options. The `systemPrompt` uses the `claude_code` preset with the skills catalog appended. The raw `skillsCatalog` string is also available for manual composition.

### `createSkillsServer(serverUrl, apiKey)`

Creates the raw MCP server instance. Use this when you need to combine the skills server with other MCP servers or want full control over the query configuration.

**Parameters:**
- `serverUrl` (string) -- Base URL of the skills server
- `apiKey` (string) -- Bearer token for agent authentication

**Returns:** An MCP server instance compatible with `query()`.

### Types

```typescript
interface SkillSummary {
  name: string;
  description: string | null;
  scripts: string[];
}

interface SkillDetail {
  name: string;
  description: string;
  content: string;
  scripts: string[];
  frontmatter: Record<string, string>;
  updatedAt: number;
}

interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
  durationMs: number;
}

interface SkillsServerConfig {
  serverUrl: string;
  apiKey: string;
}
```

## License

MIT
