# OpenRouter Skills-as-Tools: Architecture Reference

Reference for the `openrouter-skills-as-tools` library at `C:\Dev\Repos\ai\openrouter-skills-as-tools`.

## What It Does

Gives OpenRouter SDK agents directory-based skills. An agent discovers skills at startup, reads instructions on demand, and executes scripts securely. Two tools — `load_skill` and `use_skill` — handle the entire flow.

## Core Modules

| Module | Lines | Responsibility |
|--------|-------|---------------|
| `parser.ts` | 228 | Discovers skill directories, parses SKILL.md frontmatter, collects scripts |
| `executor.ts` | 228 | Runs scripts via `execFile` with path containment, timeouts, output caps |
| `provider.ts` | 443 | Creates tools, manages skill state, handles hot-reload |
| `index.ts` | 23 | Public exports |

## Skill Format

Each skill is a directory containing `SKILL.md` and executable scripts (`.mjs`, `.js`, `.sh`):

```
skills/
  discord/
    SKILL.md          # YAML frontmatter + markdown instructions
    discord.mjs       # Executable script
    scripts/          # Optional subfolder for additional scripts
```

SKILL.md uses simple YAML frontmatter with two fields:
- `name` — defaults to folder name
- `description` — defaults to first paragraph of content

The markdown body becomes the instructions injected into the model's context.

## Two-Tool Model

**`load_skill`** reads a skill's SKILL.md content and injects it into the model's instructions via `nextTurnParams`. Called once per skill per session. The provider checks SKILL.md mtime and re-parses if changed.

**`use_skill`** executes a script within a loaded skill. Parameters: `skill` (name), `script` (filename), `args` (string array), `remember` (boolean). Returns stdout on success, error code on failure.

The `remember` flag controls conversation history: `true` keeps the result for future reference (e.g., channel IDs), `false` discards it after display.

## Execution Security

The executor enforces six constraints:

1. **No shell** — `execFile`, not `exec`. No expansion or injection.
2. **Script allowlist** — only scripts discovered by extension can run.
3. **Path containment** — rejects `../`, `/absolute`, `\backslash`. Resolved paths must stay within skill directory.
4. **Timeouts** — default 30s, kills the process on expiry.
5. **Output caps** — default 20KB per stream (stdout/stderr).
6. **Environment isolation** — pass `env` to replace `process.env` entirely.

## Provider API

```typescript
// One-step: returns SDK-compatible tools
const tools = await createSkillsTools('./skills', options);

// Two-step: access skill metadata before creating tools
const provider = await createSkillsProvider('./skills', options);
const tools = createSdkTools(provider);
```

Options: `include`, `exclude`, `timeout`, `maxOutput`, `cwd`, `env`.

Provider supports multiple skill directories. First occurrence wins on name conflicts. Non-existent directories are skipped.

## Hot Reload

- `load_skill` checks SKILL.md mtime, re-parses on change
- Unknown skill triggers full directory rescan
- `use_skill` with unknown script forces re-parse even if mtime unchanged
- New skills added while running are discovered on next `load_skill` miss

## Data Structures

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  content: string;       // Markdown body
  dirPath: string;       // Absolute path
  scripts: string[];     // Discovered filenames
}

interface SkillExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;        // SkillNotFound | ScriptNotFound | ScriptNotAllowed |
}                        // InvalidArgs | ExecutionTimeout | ExecutionFailed
```

## Example App

The example at `example/server.mjs` (283 lines) demonstrates:
- Multi-directory skill loading (project + user home)
- Manual multi-turn loop with SSE streaming
- Session management (in-memory, per-client)
- History filtering based on `remember` flag
- Tool call visibility in the UI

API: `POST /api/chat` (SSE), `GET /api/config`.

## Key Patterns for the Skills Server

The library already solves skill discovery, parsing, execution, and security locally. The skills server needs to:

1. Expose skill metadata and content over HTTP (replacing local file reads)
2. Execute scripts server-side (replacing local `execFile`)
3. Add authentication and per-agent permission filtering
4. Inject per-agent environment variables into the executor's `env` option
5. Reuse the existing `SkillDefinition`, `SkillExecutionResult`, and error code patterns
