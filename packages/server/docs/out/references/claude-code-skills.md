# Claude Code Skills: Reference

## What Skills Are

Skills are filesystem-based instruction packages that extend Claude Code. Each skill is a directory with a `SKILL.md` file plus optional scripts, references, and templates. Skills follow the Agent Skills open standard (agentskills.io), adopted by Claude Code, Copilot, Codex, and Cursor.

Since v2.1.3, skills and slash commands are unified. A skill at `.claude/skills/review/SKILL.md` creates `/review` and can also be auto-invoked by Claude.

## SKILL.md Format

Two parts: YAML frontmatter and markdown body.

```yaml
---
name: my-skill
description: What it does and when to use it
argument-hint: [issue-number]
allowed-tools: Read, Grep, Bash(git:*)
context: fork
agent: Explore
---

Instructions go here. Supports $ARGUMENTS and !`shell` injection.
```

Key frontmatter fields:
- `name` — defaults to directory name
- `description` — used for auto-invocation matching (max 1024 chars)
- `allowed-tools` — sandboxes which tools Claude can use
- `context: fork` — runs in isolated subagent
- `disable-model-invocation: true` — user-only invocation
- `user-invocable: false` — Claude-only, hidden from `/` menu

## Discovery and Loading

Claude Code scans skill directories at startup. Three-phase progressive disclosure:

1. **Metadata** (~100 tokens) — name + description for all skills, loaded into a context budget (2% of window)
2. **Instructions** (<5K tokens) — full SKILL.md body, loaded on invocation
3. **Resources** (as needed) — supporting files loaded during execution

Three invocation paths: user types `/skill-name`, Claude auto-invokes via Skill tool, or subagent preloads skill at startup.

## Skill Locations (Priority Order)

Enterprise managed > Personal (`~/.claude/skills/`) > Project (`.claude/skills/`) > Plugin. Plugin skills use `plugin-name:skill-name` namespace. Monorepo subdirectories auto-discovered.

## Tool Interaction

- `allowed-tools` intersects with session permissions — skills cannot escalate access
- Scripts in the skill directory run via the Bash tool
- The `Skill` tool itself can be permission-controlled: `Skill(commit)` for exact match

## Distribution Mechanisms

- **Plugin marketplaces** — `marketplace.json` lists plugins with GitHub/git sources
- **Managed settings** — enterprise deployment to all users
- **Plugin MCP servers** — plugins bundle MCP servers for external tool integration

## Patterns for Remote Serving

The progressive disclosure model maps directly to a server API:
- **List skills** returns metadata (name + description) — the discovery phase
- **Get skill** returns full SKILL.md content — the loading phase
- **Execute script** runs server-side and returns stdout/stderr — the execution phase

MCP is the most natural integration layer. Claude Code natively supports remote MCP servers. An MCP-based skills server with `list_skills`, `invoke_skill`, and `run_script` tools would work without modifying Claude Code.

Environment variables extend the existing permission model: each agent identity gets granted skills and scoped secrets.

## Sources

- https://code.claude.com/docs/en/skills
- https://agentskills.io/specification
- https://code.claude.com/docs/en/plugins
- https://code.claude.com/docs/en/plugin-marketplaces
