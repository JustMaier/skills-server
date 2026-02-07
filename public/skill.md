---
name: skills-server
description: Connect to a centralized skills server to discover, load, and execute remote skills. Use this when you need to interact with skills hosted on a remote server.
---

# Skills Server

You are connected to a skills server that hosts skills remotely. Use the HTTP API endpoints below to discover what skills are available, read their instructions, and execute their scripts.

## Authentication

All requests require an `Authorization: Bearer <your-api-key>` header. Replace `<your-api-key>` with the API key provided to you.

The server URL is `$ARGUMENTS` (the first argument passed when loading this skill).

## Workflow

Follow these steps when interacting with the skills server:

1. **List available skills** to see what you can do.
2. **Load a skill** to read its full instructions.
3. **Execute scripts** as instructed by the skill.

## Endpoints

### List skills

```
GET {server}/api/v1/skills
```

```bash
curl -H "Authorization: Bearer <your-api-key>" {server}/api/v1/skills
```

Returns a JSON array of available skills:

```json
[{ "name": "...", "description": "...", "scripts": ["..."] }]
```

### Load skill instructions

```
GET {server}/api/v1/skills/{name}
```

```bash
curl -H "Authorization: Bearer <your-api-key>" {server}/api/v1/skills/{name}
```

Returns the full skill definition:

```json
{ "name": "...", "content": "...", "scripts": ["..."] }
```

Read the `content` field -- it contains the skill's usage instructions. Follow those instructions to use the skill.

### Execute a script

```
POST {server}/api/v1/skills/{name}/execute
Content-Type: application/json
```

```bash
curl -X POST \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"script": "script-name.mjs", "args": ["arg1", "arg2"]}' \
  {server}/api/v1/skills/{name}/execute
```

Returns the execution result:

```json
{ "success": true, "stdout": "...", "stderr": "...", "exitCode": 0, "error": null, "durationMs": 123 }
```

## Error Codes

| Code | Meaning |
|---|---|
| `SkillNotFound` | The requested skill does not exist on this server. |
| `ScriptNotFound` | The script name is not part of the skill's allowed scripts. |
| `ScriptNotAllowed` | The script exists but is not permitted to run. |
| `InvalidArgs` | The arguments passed to the script are invalid. |
| `ExecutionTimeout` | The script took too long and was killed. |
| `ExecutionFailed` | The script ran but exited with a non-zero exit code. |

## Tips

- Always list skills first to see what is available on the server.
- Load a skill's instructions before executing its scripts -- the instructions tell you how to use them.
- Check the `scripts` array to know which scripts you can run for a given skill.
- Read `stderr` on failure for debugging information.
- Replace `{server}` in all examples with the actual server URL from `$ARGUMENTS`.
