---
name: skills-server
description: Connect to a centralized skills server to discover, load, and execute remote skills. Provides a CLI wrapper for the skills server HTTP API.
---

# Skills Server Client

You have access to a remote skills server that hosts skills (scripts, tools, integrations) centrally. Use the `skills-cli.mjs` script to interact with it. The CLI handles authentication and API communication automatically.

## Prerequisites

Two environment variables must be set:

- `SKILLS_SERVER_URL` -- the base URL of the skills server (e.g. `http://localhost:3000`)
- `SKILLS_SERVER_API_KEY` -- the agent API key issued by the server admin

The CLI reads these from the environment. If either is missing, the CLI will exit with an error.

## Workflow

Follow these steps in order when working with remote skills:

### Step 1: List available skills

```bash
node skills-cli.mjs list
```

Returns a JSON array of skills you have access to. Each entry has `name`, `description`, and `scripts` (the executable script filenames).

### Step 2: Load a skill's instructions

```bash
node skills-cli.mjs load <skill-name>
```

Returns the full skill definition including its markdown instructions in the `content` field. Read the `content` carefully -- it tells you how to use the skill and what arguments each script expects.

### Step 3: Execute a script

```bash
node skills-cli.mjs exec <skill-name> <script-name> [args...]
```

Runs a script on the server and returns the execution result as JSON with fields: `success`, `stdout`, `stderr`, `exitCode`, `error`, `durationMs`.

### Step 4: Read the output

- On success: `success` is `true`, read `stdout` for the script's output.
- On failure: `success` is `false`, check `error` for the error code and `stderr` for details.

## Examples

```bash
# List all skills
node skills-cli.mjs list

# Load the weather skill to read its instructions
node skills-cli.mjs load weather

# Execute the weather script with an argument
node skills-cli.mjs exec weather weather.mjs "New York"

# Execute a script with multiple arguments
node skills-cli.mjs exec my-skill run.mjs arg1 arg2 arg3
```

## Error Codes

When execution fails, the `error` field in the response contains one of these codes:

| Code | Meaning |
|---|---|
| `ScriptNotFound` | The script file does not exist within the skill directory. |
| `ScriptNotAllowed` | The script path is invalid or not permitted (e.g. path traversal attempt). |
| `InvalidArgs` | The arguments passed to the script are not valid strings. |
| `ExecutionTimeout` | The script exceeded the 30-second timeout and was killed. |
| `ExecutionFailed` | The script ran but exited with a non-zero exit code. Check `stderr`. |

HTTP-level errors you may encounter:

| HTTP Status | Meaning |
|---|---|
| 401 | Invalid or missing API key. Check `SKILLS_SERVER_API_KEY`. |
| 403 | You do not have permission to access this skill. Contact the admin. |
| 404 | The skill name does not exist on the server. Run `list` to see available skills. |

## Tips

- Always run `list` first to see what skills are available to you.
- Always run `load` before `exec` -- the skill instructions tell you which scripts exist and what arguments they expect.
- Check the `scripts` array from `list` or `load` to know the exact script filenames.
- If a script fails, read `stderr` for debugging information.
- The CLI outputs JSON to stdout. Parse it to extract the information you need.
