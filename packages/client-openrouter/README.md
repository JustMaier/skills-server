# @skills-server/client-openrouter

OpenRouter SDK client for the skills server. Connects AI agents to remote skills via the skills server HTTP API, exposing them as OpenRouter SDK tools.

This package is modeled after [openrouter-skills](https://github.com/justmaier/openrouter-skills) but uses a remote skills server instead of the local filesystem.

## Install

```bash
npm install @skills-server/client-openrouter
```

Peer dependencies:

```bash
npm install @openrouter/sdk zod
```

## Quick Start

```typescript
import { OpenRouter } from '@openrouter/sdk';
import { createSkillsProvider, createSdkTools } from '@skills-server/client-openrouter';

const provider = await createSkillsProvider(
  'http://localhost:3000',       // skills server URL
  'your-agent-api-key',          // agent API key
);

const tools = createSdkTools(provider);
const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const result = client.callModel({
  model: 'anthropic/claude-sonnet-4',
  input: 'What skills do you have?',
  tools,
});

const message = await result.getMessage();
console.log(message.content);
```

## API

### `createSkillsProvider(serverUrl, apiKey, options?)`

Creates a `SkillsProvider` backed by a remote skills server.

```typescript
const provider = await createSkillsProvider(
  'http://localhost:3000',
  'agent-api-key',
  {
    include: ['weather*'],  // optional: only include matching skills
    exclude: ['internal*'], // optional: exclude matching skills
  },
);

console.log(provider.skillNames); // ['weather']
```

The provider exposes:

| Property | Type | Description |
|---|---|---|
| `skillNames` | `string[]` | Names of available skills |
| `skills` | `Map<string, SkillDetail>` | Loaded skill definitions (populated lazily) |
| `handleToolCall(name, args)` | `Promise<SkillExecutionResult>` | Execute a tool call |

The `handleToolCall` method supports two tool names:

- `load_skill` with `{ skill: string }` -- fetches full skill content from the server
- `use_skill` with `{ skill, script, args }` -- executes a script on the server

### `createSdkTools(provider)`

Creates OpenRouter SDK tool instances for automatic tool execution.

```typescript
const tools = createSdkTools(provider);

const result = client.callModel({
  model: 'anthropic/claude-sonnet-4',
  input: 'Check the weather in Tokyo',
  tools,
  maxToolRounds: 5,
});

const message = await result.getMessage();
```

The returned tools:

- **`load_skill`** -- Loads a skill's instructions. Uses `nextTurnParams` to inject the skill content into the model's system prompt so it persists across turns.
- **`use_skill`** -- Runs a script from a previously loaded skill. Accepts a `remember` boolean (default: `false`) that controls whether the tool call is included in conversation history.

### `createManualTools(sdkTools)`

Wraps SDK tools with `execute: false` for use in a custom multi-turn loop. This gives you full control over streaming and tool execution between turns.

```typescript
const sdkTools = createSdkTools(provider);
const manualTools = createManualTools(sdkTools);

// Custom multi-turn loop
let instructions = 'You are a helpful assistant.';
const history = [];

for (let step = 0; step < 10; step++) {
  const result = client.callModel({
    model: 'anthropic/claude-sonnet-4',
    instructions,
    input: history,
    tools: manualTools,
  });

  // Stream text deltas
  for await (const delta of result.getTextStream()) {
    process.stdout.write(delta);
  }

  const response = await result.getResponse();
  const toolCalls = (response.output ?? []).filter(o => o.type === 'function_call');

  if (toolCalls.length === 0) break;

  for (const tc of toolCalls) {
    const args = JSON.parse(tc.arguments ?? '{}');
    const execResult = await provider.handleToolCall(tc.name, args);
    const toolResult = toToolResult(execResult);

    // Inject skill instructions on load
    if (tc.name === 'load_skill' && execResult.success) {
      instructions += `\n\n[Skill: ${args.skill}]\n${execResult.stdout}`;
    }

    history.push({ type: 'function_call', callId: tc.callId, name: tc.name, arguments: tc.arguments });
    history.push({ type: 'function_call_output', callId: tc.callId, output: JSON.stringify(toolResult) });
  }
}
```

### `toToolResult(result)`

Converts a `SkillExecutionResult` to the thin `SkillToolResult` shape for models.

```typescript
import { toToolResult } from '@skills-server/client-openrouter';

const execResult = await provider.handleToolCall('use_skill', {
  skill: 'weather',
  script: 'weather.mjs',
  args: ['Tokyo'],
});

const toolResult = toToolResult(execResult);
// { ok: true, result: '...' }  or  { ok: false, error: '...', message: '...' }
```

### `processTurn(result, onEvent?)`

Helper for processing a `callModel` result with streaming events. Handles the common pattern of iterating items for UI display while collecting history.

```typescript
const result = client.callModel({
  model: 'anthropic/claude-sonnet-4',
  input: messages,
  tools: sdkTools,
});

const { text, history } = await processTurn(result, (event) => {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
  if (event.type === 'tool_call') console.log(`Calling: ${event.name}`);
  if (event.type === 'tool_result') console.log(`Result: ${event.result}`);
});

messages.push(...history);
messages.push({ role: 'assistant', content: text });
```

## Types

```typescript
interface SkillSummary {
  name: string;
  description: string | null;
  scripts: string[];
}

interface SkillDetail {
  name: string;
  description: string;
  frontmatter: Record<string, string>;
  content: string;
  scripts: string[];
  updatedAt: number;
}

interface SkillExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
  durationMs: number;
}

interface SkillToolResult {
  ok: boolean;
  result?: string;
  error?: string;
  message?: string;
}

interface ProviderOptions {
  include?: string[];
  exclude?: string[];
}

interface SkillsProvider {
  handleToolCall(name: string, args: Record<string, unknown>): Promise<SkillExecutionResult>;
  skillNames: string[];
  skills: Map<string, SkillDetail>;
}
```

## Example App

A full working chat application is included in `example/`.

### Setup

```bash
# From the package root
npm run build

# Set up the example
cd example
cp .env.example .env
# Edit .env with your keys
npm install
npm start
```

The example runs a Node.js HTTP server with:

- SSE streaming chat at `POST /api/chat`
- Static file serving for the chat UI
- Session management (in-memory)
- Multi-turn tool loop with OpenRouter SDK

Open `http://localhost:3001` in your browser to use the chat interface.

### Prerequisites

1. A running skills server with at least one skill configured
2. An agent API key with access to those skills
3. An OpenRouter API key

## License

MIT
