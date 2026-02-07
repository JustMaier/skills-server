# Claude Code Skills: Technical Research Summary

Research compiled for the skills-server project. Covers the skill system architecture, file formats, discovery/invocation mechanics, and patterns relevant to building a centralized skills server.

---

## 1. What Are Claude Code Skills?

Skills are filesystem-based instruction packages that extend Claude Code's capabilities. Each skill is a directory containing a `SKILL.md` file (required) plus optional supporting files (scripts, references, templates). Skills provide Claude with task-specific instructions, domain knowledge, or step-by-step workflows.

Skills unify what were previously two separate concepts: **slash commands** (user-invoked via `/command-name`) and **auto-loaded context** (Claude-invoked based on semantic matching). Since Claude Code v2.1.3, both mechanisms are handled by the same skill system. A file at `.claude/commands/review.md` and a skill at `.claude/skills/review/SKILL.md` both create `/review` and work identically.

Claude Code skills follow the **Agent Skills open standard** (agentskills.io), which is also adopted by Microsoft Copilot, OpenAI Codex, Cursor, and others.

## 2. Directory Layout and File Structure

### Minimum Viable Skill

```
skill-name/
  SKILL.md          # Required. Instructions + YAML frontmatter.
```

### Full Structure

```
skill-name/
  SKILL.md           # Main instructions (required)
  template.md        # Template for Claude to fill in
  examples/
    sample.md        # Example output showing expected format
  scripts/
    validate.sh      # Script Claude can execute via Bash tool
    helper.py        # Python utility
  references/
    REFERENCE.md     # Detailed API docs loaded on demand
    domain.md        # Domain-specific reference
  assets/
    schema.json      # Static resources, lookup tables, etc.
```

### Where Skills Live (Priority Order)

| Location    | Path                                             | Scope                          |
|-------------|--------------------------------------------------|--------------------------------|
| Enterprise  | Managed settings (admin-deployed)                | All users in the organization  |
| Personal    | `~/.claude/skills/<skill-name>/SKILL.md`         | All of a user's projects       |
| Project     | `.claude/skills/<skill-name>/SKILL.md`           | Single project only            |
| Plugin      | `<plugin>/skills/<skill-name>/SKILL.md`          | Where plugin is enabled        |
| Nested      | `packages/foo/.claude/skills/<name>/SKILL.md`    | Monorepo subdirectory          |
| Additional  | Via `--add-dir` flag                             | Added directories              |

When skills share the same name across levels, higher-priority locations win: enterprise > personal > project. Plugin skills use a `plugin-name:skill-name` namespace to avoid conflicts.

## 3. SKILL.md Format

Every `SKILL.md` has two parts: YAML frontmatter (between `---` markers) and Markdown body content.

### Frontmatter Fields

```yaml
---
name: my-skill-name
description: What this skill does and when to use it
argument-hint: [issue-number]
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Grep, Bash(git:*)
model: sonnet
context: fork
agent: Explore
hooks: { ... }
---
```

| Field                        | Required    | Description |
|------------------------------|-------------|-------------|
| `name`                       | No          | Display name and `/slash-command`. Defaults to directory name. Lowercase, hyphens, max 64 chars. |
| `description`                | Recommended | What the skill does and when to use it. Claude uses this for auto-invocation matching. Max 1024 chars. |
| `argument-hint`              | No          | Hint shown in autocomplete, e.g. `[issue-number]`. |
| `disable-model-invocation`   | No          | `true` = only the user can invoke. Prevents Claude from auto-loading. Default: `false`. |
| `user-invocable`             | No          | `false` = hidden from `/` menu. For background knowledge only Claude should use. Default: `true`. |
| `allowed-tools`              | No          | Space-delimited tool whitelist when skill is active. |
| `model`                      | No          | Model override when skill is active. |
| `context`                    | No          | `fork` = run in isolated subagent context. Default: `main` (inline). |
| `agent`                      | No          | Subagent type when `context: fork`. Options: `Explore`, `Plan`, `general-purpose`, or custom. |
| `hooks`                      | No          | Lifecycle hooks scoped to this skill. |
| `license`                    | No          | License name or reference (Agent Skills spec field). |
| `compatibility`              | No          | Environment requirements description. |
| `metadata`                   | No          | Arbitrary key-value pairs. |

### Agent Skills Open Standard Required Fields

The agentskills.io spec requires `name` and `description`. Claude Code relaxes this (both optional) but the standard mandates them. The `name` must match the parent directory name in the spec.

### Body Content

The Markdown body after frontmatter contains the actual instructions. No format restrictions. Recommended sections: step-by-step instructions, input/output examples, edge cases.

### String Substitutions

| Variable               | Description |
|------------------------|-------------|
| `$ARGUMENTS`           | All arguments passed when invoking the skill |
| `$ARGUMENTS[N]` / `$N`| Specific argument by 0-based index |
| `${CLAUDE_SESSION_ID}` | Current session ID |
| `${CLAUDE_PLUGIN_ROOT}`| Plugin root directory path |

### Dynamic Context Injection

The `` !`command` `` syntax runs shell commands before the skill content is sent to Claude. Output replaces the placeholder. This is preprocessing, not agent execution.

```yaml
## Context
- PR diff: !`gh pr diff`
- Changed files: !`gh pr diff --name-only`
```

## 4. How Skills Get Discovered, Loaded, and Invoked

### Discovery

1. Claude Code scans skill directories at startup (and on hot-reload).
2. For each skill found, it extracts `name` and `description` from YAML frontmatter.
3. These metadata pairs are assembled into an `<available_skills>` section embedded in the Skill tool definition.
4. Skills are tagged with a `location` attribute (`user`, `project`, `plugin`).
5. Hot-reload: changes to skill files are detected and applied immediately without session restart.

### Context Budget

Skill descriptions are loaded into context so Claude knows what is available. A character budget (2% of context window, fallback 16,000 chars) limits how many skill descriptions fit. Override with `SLASH_COMMAND_TOOL_CHAR_BUDGET` env var.

### Progressive Disclosure (Three Phases)

1. **Metadata** (~100 tokens): `name` and `description` loaded at startup for all skills.
2. **Instructions** (< 5000 tokens recommended): Full `SKILL.md` body loaded when skill is activated.
3. **Resources** (as needed): Supporting files loaded only when required during execution.

### Invocation Paths

There are three ways a skill gets invoked:

1. **Direct user invocation**: User types `/skill-name [args]` in the REPL.
2. **Claude auto-invocation**: Claude calls the Skill tool when the task semantically matches a skill's description.
3. **Subagent preload**: Skills listed in an agent's frontmatter are loaded at agent startup.

### The Skill Tool

Claude accesses skills through a tool called `Skill` with parameters:
- `skill`: The skill name (required). E.g., `"pdf"` or `"plugin-name:skill-name"`.
- `args`: Optional arguments string.

When the Skill tool is called, the response includes:
1. A `tool_result` confirmation with command status and skill name.
2. The skill's base path (for relative script execution).
3. The full `SKILL.md` body content (frontmatter stripped).
4. If `$ARGUMENTS` is not in the content, arguments are appended as `ARGUMENTS: <value>`.

The skill content is injected as a tool result message, not by modifying the system prompt. This enables on-demand capability expansion.

### Invocation Control Matrix

| Frontmatter                      | User can invoke | Claude can invoke | Context loading |
|----------------------------------|----------------|-------------------|-----------------|
| (default)                        | Yes            | Yes               | Description always loaded; full content on invoke |
| `disable-model-invocation: true` | Yes            | No                | Description not in context |
| `user-invocable: false`          | No             | Yes               | Description always loaded; full content on invoke |

### Execution Modes

- **Inline (`context: main`)**: Skill instructions are added to the current conversation. Claude can use the instructions alongside existing context.
- **Forked (`context: fork`)**: Skill runs in an isolated subagent. No access to conversation history. Full instructions load in the subagent only. Results summarized and returned to main conversation.

## 5. How Skills Interact with Tools

### Tool Restriction

`allowed-tools` limits which tools Claude can use when a skill is active. This creates sandboxed execution modes:

```yaml
allowed-tools: Read, Grep, Glob  # Read-only mode
allowed-tools: Bash(git:*) Read  # Git operations only
```

The allowed tools are intersected with session permissions, so skills cannot grant more access than the session allows.

### Permission Model

- Skills with `allowed-tools` or `hooks` require user approval.
- Skills without additional permissions are auto-allowed (v2.1.19+).
- Project directory skills from untrusted directories trigger trust warnings.
- The `Skill` tool itself can be allowed/denied in permission rules:
  - `Skill(commit)` = exact match
  - `Skill(deploy *)` = prefix match with any args

### Scripts

Skills can bundle executable scripts (Python, Bash, JS) in their directory. Claude runs these via the Bash tool. Scripts execute in the agent's environment (or, in the server concept, on the server).

## 6. Patterns for Remote/Centralized Skill Serving

### Existing Distribution Mechanisms

**Plugin Marketplaces**: Claude Code has a built-in plugin marketplace system. A `marketplace.json` file lists plugins with their sources (relative paths, GitHub repos, git URLs). Users add marketplaces and install plugins. Plugins are copied to a local cache.

**Managed Settings (Enterprise)**: Organizations can deploy skills to all users via managed settings, with strict marketplace allowlists.

**Plugin MCP Servers**: Plugins can bundle MCP servers that provide tools to Claude. This is the closest existing pattern to a remote execution model.

### Key Patterns Relevant to a Skills Server

**1. API-First Skill Registry**
The skills server would expose an API that agents call to:
- Authenticate with an agent ID/key
- List available skills (returns name + description for context budget)
- Fetch full skill content (SKILL.md body) when invoking a skill
- Execute scripts server-side and return results

This mirrors the progressive disclosure model: metadata at discovery, full content at activation, resource loading at execution.

**2. MCP Server as Integration Layer**
The most natural integration point is an MCP server that:
- Exposes a `list_skills` tool (returns skill metadata)
- Exposes a `invoke_skill` tool (returns full skill content)
- Exposes a `run_script` tool (executes skill scripts on the server, returns output)

Claude Code natively supports remote MCP servers. An MCP-based skills server would be immediately compatible.

**3. Environment Variable / Secrets Management**
Each agent identity would have:
- A set of granted skills
- A set of environment variables/secrets scoped per skill
- Permission boundaries (which env vars each agent can access)

This maps to the existing `allowed-tools` and permission model but extends it to secret management.

**4. Skill Content Serving vs. Script Execution**
Two distinct concerns:
- **Skill content** (SKILL.md + references): Prompt text that gets injected into the agent's context. This is just text delivery.
- **Script execution**: Running bundled scripts. In local Claude Code, scripts run on the user's machine. A server would run these remotely, returning stdout/stderr.

**5. Versioning**
The Agent Skills spec supports `metadata.version`. The marketplace system supports pinning to git refs/SHAs. A server could serve version-tagged skill directories.

**6. Webhook/Git-Based Skill Ingestion**
Skills are just directories with SKILL.md files. A server could:
- Watch a git repo for changes (webhook)
- Pull latest skill directories
- Serve them via API
- Optionally validate with `skills-ref validate`

### Marketplace JSON Schema (Reference)

```json
{
  "name": "marketplace-name",
  "owner": { "name": "Team Name", "email": "team@example.com" },
  "metadata": { "description": "...", "version": "1.0.0", "pluginRoot": "./plugins" },
  "plugins": [
    {
      "name": "plugin-name",
      "source": "./plugins/plugin-name",
      "description": "...",
      "version": "1.0.0"
    }
  ]
}
```

---

## Sources

- Official Claude Code Skills Docs: https://code.claude.com/docs/en/skills
- Agent Skills Specification: https://agentskills.io/specification
- Agent Skills GitHub: https://github.com/agentskills/agentskills
- Anthropic Skills Repo: https://github.com/anthropics/skills
- Claude Code Plugins Docs: https://code.claude.com/docs/en/plugins
- Plugin Marketplaces Docs: https://code.claude.com/docs/en/plugin-marketplaces
- DeepWiki Skill System Analysis: https://deepwiki.com/anthropics/claude-code/3.7-custom-slash-commands
- Mikhail Shilkov Skills Deep Dive: https://mikhail.io/2025/10/claude-code-skills/
- Skills vs Slash Commands Merger: https://medium.com/@joe.njenga/claude-code-merges-slash-commands-into-skills-dont-miss-your-update-8296f3989697
- Claude Code Customization Guide: https://alexop.dev/posts/claude-code-customization-guide-claudemd-skills-subagents/
- First Principles Skills Deep Dive: https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/
