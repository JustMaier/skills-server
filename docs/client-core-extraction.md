# Extract `@skills-server/client-core`

Extract shared skills-server HTTP interaction logic from `client-agent-sdk` and
`client-openrouter` into a common `@skills-server/client-core` package.

`client-claude-code` stays untouched — it's a zero-dependency standalone script
by design.

---

## What moves into client-core

### 1. Types (`src/types.ts`)

The two packages already define nearly identical types. Unified versions:

```ts
/**
 * Summary returned by GET /api/v1/skills.
 */
export interface SkillSummary {
  name: string;
  description: string | null;
  scripts: string[];
}

/**
 * Full skill detail returned by GET /api/v1/skills/{name}.
 */
export interface SkillDetail {
  name: string;
  description: string;
  content: string;
  scripts: string[];
  frontmatter: Record<string, string>;
  updatedAt: number;
}

/**
 * Result from POST /api/v1/skills/{name}/execute.
 */
export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
  durationMs: number;
}

/**
 * Thin result shape returned to models from tool calls.
 */
export interface ToolResult {
  ok: boolean;
  result?: string;
  error?: string;
  message?: string;
}
```

> Note: openrouter calls it `SkillExecutionResult` / `SkillToolResult`, agent-sdk
> calls it `ExecutionResult`. Core uses shorter names since they're already
> namespaced by package. The SDK-specific types (`SkillsProvider`, `TurnEvent`,
> `TurnOutput`, `ProviderOptions`) stay in their respective packages.

### 2. HTTP client (`src/client.ts`)

Both packages have an `apiFetch` / `request` helper that does the same thing:
normalize the base URL, set Bearer auth + JSON headers, throw on non-2xx.

```ts
export class SkillsClient {
  private baseUrl: string;
  private apiKey: string;

  /** Cached skill list + catalog, populated by refresh(). */
  skills: SkillSummary[];
  skillsCatalog: string;

  constructor(serverUrl: string, apiKey: string);

  /** Authenticated fetch. Throws on non-2xx. */
  request<T>(path: string, options?: RequestInit): Promise<T>;

  /** GET /api/v1/skills — list skills visible to this agent. */
  listSkills(): Promise<SkillSummary[]>;

  /** GET /api/v1/skills/{name} — full skill content + metadata. */
  loadSkill(name: string): Promise<SkillDetail>;

  /** POST /api/v1/skills/{name}/execute — run a script. */
  executeSkill(name: string, script: string, args?: string[]): Promise<ExecutionResult>;

  /**
   * Re-fetch the skill list from the server and rebuild the cached catalog.
   * Call this when permissions change or skills are added/removed.
   * Accepts optional include/exclude filters applied to the fetched list.
   */
  refresh(options?: { include?: string[]; exclude?: string[] }): Promise<void>;
}
```

This replaces:
- `apiFetch<T>()` closure in `client-agent-sdk/src/tools.ts` (lines 37-54)
- `request<T>()` function in `client-openrouter/src/provider.ts` (lines 50-78)
- The duplicate raw `fetch()` call in `createSkillsServerConfig` (lines 225-243)

### 3. Catalog builder (`src/catalog.ts`)

Both packages build the same markdown catalog string from a `SkillSummary[]`:

```ts
/**
 * Build a markdown skills catalog for system-prompt injection.
 *
 * Returns empty string if skills array is empty.
 */
export function buildCatalog(skills: SkillSummary[]): string;
```

Output format (already identical between both packages):
```
## Available Skills

Use `load_skill` to read a skill's full instructions before using it.

- **hello**: Say hello [scripts: hello.mjs]
- **weather**: Get weather data [scripts: weather.mjs]
```

### 4. Result helpers (`src/results.ts`)

```ts
/**
 * Reshape an ExecutionResult to the thin ToolResult format for models.
 */
export function toToolResult(r: ExecutionResult): ToolResult;

/**
 * Create a failure ExecutionResult (for client-side errors before HTTP).
 */
export function failResult(error: string, stderr?: string): ExecutionResult;
```

`toToolResult` is currently exported from `client-openrouter/src/provider.ts`.
`failResult` (currently `fail()`) is internal to the same file.

### 5. Filter helpers (`src/filter.ts`)

```ts
/**
 * Test if a skill name passes include/exclude glob filters.
 */
export function matchesFilter(
  name: string,
  include?: string[],
  exclude?: string[],
): boolean;
```

Currently only in openrouter, but useful for agent-sdk too.

---

## Package structure

```
packages/client-core/
├── src/
│   ├── index.ts       # Public re-exports
│   ├── types.ts       # SkillSummary, SkillDetail, ExecutionResult, ToolResult
│   ├── client.ts      # SkillsClient class
│   ├── catalog.ts     # buildCatalog()
│   ├── results.ts     # toToolResult(), failResult()
│   └── filter.ts      # matchesFilter(), matchGlob()
├── package.json
└── tsconfig.json
```

**package.json** — zero runtime dependencies, same as the other client packages:

```json
{
  "name": "@skills-server/client-core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  },
  "engines": { "node": ">=18.0.0" }
}
```

---

## How each client changes

### client-agent-sdk

**Before:** `tools.ts` contains its own `apiFetch`, catalog builder, and types.

**After:**
```ts
import {
  SkillsClient,
  buildCatalog,
  type SkillSummary,
  type SkillDetail,
  type ExecutionResult,
} from '@skills-server/client-core';
```

- `createSkillsServer()` — instantiates `SkillsClient`, passes it into MCP tool
  handlers. The MCP-specific formatting (textResult/errorResult) stays here.
- `createSkillsServerConfig()` — uses `client.listSkills()` + `buildCatalog()`
  instead of a raw fetch. Eliminates the duplicate fetch call.
- `types.ts` — deleted. Re-exports core types from `index.ts`.

### client-openrouter

**Before:** `provider.ts` contains `request()`, `matchesFilter()`, `fail()`,
`toToolResult()`, and catalog builder logic inline.

**After:**
```ts
import {
  SkillsClient,
  buildCatalog,
  matchesFilter,
  toToolResult,
  failResult,
  type SkillSummary,
  type SkillDetail,
  type ExecutionResult,
  type ToolResult,
} from '@skills-server/client-core';
```

- `createSkillsProvider()` — uses `SkillsClient` for all HTTP calls. Filter and
  catalog logic delegates to core functions.
- `createSdkTools()`, `createManualTools()`, `processTurn()` — unchanged
  (OpenRouter SDK-specific).
- `types.ts` — keeps `SkillsProvider`, `ProviderOptions`, `TurnEvent`,
  `TurnOutput` (SDK-specific). Re-exports core types.

### client-claude-code

**No changes.** Stays as a standalone zero-dependency script.

---

## Implementation order

1. **Create `packages/client-core`** — types, client, catalog, results, filter
2. **Build and verify** — `npm run build` in client-core
3. **Refactor `client-agent-sdk`** — import from core, delete duplicated code
4. **Refactor `client-openrouter`** — import from core, delete duplicated code
5. **Run E2E tests** for both clients against a running server
6. **Update root workspace** — verify `npm install` links everything

---

## Refresh mechanism

`SkillsClient` caches the skill list and catalog after `refresh()` is called.
SDK clients hold a reference to the same `SkillsClient` instance, so calling
`client.refresh()` updates `client.skills` and `client.skillsCatalog` in place.

- **Manual only** — no polling, no timers. The caller decides when to refresh.
- Both SDK clients expose `refresh()` by delegating to the underlying
  `SkillsClient.refresh()`.
- The openrouter `SkillsProvider.refresh()` already does this; agent-sdk's
  `createSkillsServerConfig` currently has no refresh path, so we add one by
  returning the client instance in the config object.

---

## Open questions

- **Naming**: `ToolResult` vs `SkillToolResult`? The plan uses `ToolResult` since
  it's already scoped by package name. Either works.
- **Filter in agent-sdk**: Currently agent-sdk doesn't support include/exclude
  filters. Should we add that while we're here, or leave it for later?
