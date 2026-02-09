# Phase 2: Skill Registry, Permission Levels, and Self-Service

## Context

The skills server currently works well for a single admin managing skills and agents. Phase 2 makes it production-ready for teams: agents can self-manage their env vars, skills can be registered from Git repos, and a permission system controls who can do what. The goal is that an agent authenticates once and can discover, configure, and execute skills without admin intervention for routine operations.

The user also wants a bootstrap meta-skill + CLI that teaches any agent how to interact with the server, and SDK adapter documentation for Claude Agent SDK and OpenRouter (implementation deferred).

---

## Implementation Phases

### Phase A: Foundation (Schema + File Layout)

**1. Schema migrations** — `src/db/schema.ts` + `src/db/index.ts`

Add to `agents` table:
- `permission_level TEXT NOT NULL DEFAULT 'none'` — agent-wide permission (`none`, `execute`, `maintain`, `admin`)

Add to `agent_skills` table:
- `permission_level TEXT NOT NULL DEFAULT 'execute'` — per-skill permission (`execute`, `maintain`, `admin`)

Add to `env_vars` table:
- `owner_id TEXT REFERENCES agents(id) ON DELETE CASCADE` — nullable (NULL = admin-owned)
- Drop the global `UNIQUE(key)` constraint; replace with `UNIQUE(key, COALESCE(owner_id, ''))` so multiple agents can each own the same key name

New table `skill_registry`:
```sql
id              TEXT PRIMARY KEY,
skill_id        TEXT REFERENCES skills(id) ON DELETE CASCADE,
repo_url        TEXT NOT NULL,
branch          TEXT NOT NULL DEFAULT 'main',
subpath         TEXT NOT NULL DEFAULT '/',
registered_by   TEXT REFERENCES agents(id) ON DELETE SET NULL,
last_synced     INTEGER,
status          TEXT NOT NULL DEFAULT 'active',  -- active | broken | syncing
created_at      INTEGER NOT NULL,
updated_at      INTEGER NOT NULL
```

Migration strategy: idempotent `ALTER TABLE` statements wrapped in try/catch (SQLite throws on duplicate column). For the env_vars unique index change, drop old index + create new one.

**2. Move examples**
- `skills/` -> `examples/skills/` (git mv)
- `.env.example`: `SKILLS_DIR=./examples/skills`
- `.gitignore`: add `skills/` and `repos/`
- `src/index.ts`: create `skills/` and `repos/` directories on startup if missing

**3. New env var** — `REPOS_DIR` (default `./repos`), add to `.env.example`

---

### Phase B: Permission System

**4. Permission service** — NEW `src/services/permissions.ts`

```typescript
type PermissionLevel = 'none' | 'execute' | 'maintain' | 'admin';

hasPermission(effective, required): boolean    // rank comparison
maxLevel(a, b): PermissionLevel               // returns higher of two
getEffectivePermission(agentId, skillId): PermissionLevel
  // max(agent.permissionLevel, agentSkills.level for this skill)
requirePermission(agentId, skillName, required): SkillAccessResult
  // looks up skill by name, checks effective >= required
```

**5. Update `src/routes/agent-facing.ts`**
- Import permission service
- `requireSkillAccess()`: delegate to `requirePermission(agentId, skillName, 'execute')` instead of manual junction query
- `listSkillsRoute` handler: if `agent.permissionLevel >= 'execute'`, return ALL skills (blanket access); otherwise, query per-skill grants as today

**6. Update `src/routes/agents.ts`**
- Add `permissionLevel` to create/update schemas and responses
- Validate `permissionLevel` is one of the four valid values
- Include in list/get responses

**7. Update `src/routes/permissions.ts`**
- `grantSkillRoute`: accept optional `level` field (default `'execute'`)
- `setSkillsRoute` (PUT bulk): accept `level` per entry
- `getPermissionsRoute`: include `level` in each skill grant returned
- Existing `agent_skills` inserts: add `level` column value

---

### Phase C: Self-Service Env Vars

**8. New route file** — `src/routes/self-service.ts`

Uses `agentAuth` middleware (not `adminAuth`). Mounted at `/api/v1/self`.

Endpoints:
| Method | Path | Description |
|--------|------|-------------|
| GET | `/env-vars` | List my env var keys + descriptions (never values). Filter: `ownerId = agent.id` |
| POST | `/env-vars` | Create env var with `ownerId = agent.id`. Auto-insert into `agentEnvVars`. |
| PATCH | `/env-vars/:id` | Update value/description. Verify `ownerId = agent.id`. |
| DELETE | `/env-vars/:id` | Delete. Verify `ownerId = agent.id`. Cascades from junctions. |
| POST | `/skills/:skillId/env-vars/:envVarId` | Link my env var to a skill I can execute. Verify I own the env var and have execute on the skill. |
| DELETE | `/skills/:skillId/env-vars/:envVarId` | Unlink. Same ownership check. |

**9. Wire in `src/app.ts`** — `app.route('/api/v1/self', selfServiceRoutes)`

---

### Phase D: Missing Env Var Detection

**10. Update execute handler** in `src/routes/agent-facing.ts`

Before executing, query `skill_env_vars` for required env vars and compare against what the agent satisfies. Three cases:

| Case | Response |
|------|----------|
| Agent missing env var entirely | 422 with key name + hint to create via CLI |
| Agent has env var but not linked to skill | 422 with key name + hint to link via CLI |
| All satisfied | Execute normally |

Add `422` response to `executeSkillRoute` definition with `MissingEnvVarsSchema`.

When agent-owned and admin-created env vars share a key name, agent-owned takes priority in injection (build env map with admin vars first, then overlay agent-owned).

---

### Phase E: Git-Clone Skill Registry

**11. Git service** — NEW `src/services/git.ts`
- `gitClone(repoUrl, targetDir, branch)` — `execFile('git', ['clone', '--depth', '1', '--single-branch', '--branch', branch, repoUrl, targetDir])`
- `gitPull(repoDir)` — `execFile('git', ['pull', '--ff-only'], { cwd })`
- 60-second timeout, 1MB max buffer
- Returns `{ success, stdout, stderr, exitCode }`

**12. Symlink service** — NEW `src/services/symlink.ts`
- `createSkillLink(skillsDir, skillName, targetDir)` — symlink (Unix) or junction (Windows, no admin needed)
- `removeSkillLink(skillsDir, skillName)` — unlink
- `isSkillLink(skillsDir, skillName)` — lstat check
- `verifyLink(skillsDir, skillName)` — check target still exists, return boolean

**13. Registry routes** — NEW `src/routes/registry.ts`

Factory: `createRegistryRoutes(skillsManager, skillsDir, reposDir)`

| Method | Path | Required Level | Description |
|--------|------|----------------|-------------|
| POST | `/` | `maintain` (agent-level) | Register skill from Git repo |
| GET | `/` | `execute` | List registry entries |
| GET | `/:id` | `execute` | Get entry detail |
| PATCH | `/:id` | `maintain` on skill | Update branch/subpath |
| DELETE | `/:id` | `maintain` on skill | Unregister (remove symlink, optionally delete clone) |
| POST | `/:id/sync` | `maintain` on skill | Pull latest, verify symlink, re-discover |

**Register flow** (`POST /`):
1. Check agent.permissionLevel >= maintain
2. Validate repo URL (starts with `https://` or `git@`)
3. Derive skill name from request body (or repo name)
4. Check if repo already cloned (match by normalized repo URL). If yes, reuse clone. If no, clone into `repos/{hash-of-url}/`
5. Verify `{subpath}/SKILL.md` exists in clone
6. Symlink `skills/{name}` -> `repos/{hash}/{subpath}`
7. Run `skillsManager.reload()` to pick up new skill
8. Insert registry record + skill DB record
9. Auto-grant `maintain` on new skill to the registering agent
10. Return registry entry

**Mono-repo support:** Multiple skills from the same repo share one clone. Each registration points to a different subpath. `git pull` in the shared clone updates all skills from that repo.

**Sync flow** (`POST /:id/sync`):
1. Set status = `syncing`
2. `gitPull()` in repo dir
3. Verify symlink target still has SKILL.md — if not, set status = `broken`
4. `skillsManager.reload()`
5. Set status = `active`, update `lastSynced`

**Broken symlink handling:** On discovery scan, skills with broken symlinks are excluded. Admin UI and registry list show `broken` status. Agent sees skill disappear from their list until someone updates the subpath.

**Unregistered skills:** Skills found on disk without a registry entry are treated as manual entries. They work exactly as today — no repo, no sync, just files.

**14. Wire in `src/app.ts`** + startup in `src/index.ts`
- `app.route('/api/v1/registry', createRegistryRoutes(skillsManager, skillsDir, reposDir))`
- On startup: ensure `repos/` exists, scan for broken symlinks

---

### Phase F: Bootstrap Meta-Skill + CLI

**15. CLI script** — NEW `public/skills-cli.mjs`

Standalone Node.js script, no dependencies beyond Node builtins. Reads config from env:
- `SKILLS_SERVER_URL` — server base URL
- `SKILLS_SERVER_KEY` — agent API key

Commands:
```
skills-cli.mjs list                              # GET /api/v1/skills
skills-cli.mjs load <name>                       # GET /api/v1/skills/{name}
skills-cli.mjs exec <name> <script> [args...]    # POST /api/v1/skills/{name}/execute
skills-cli.mjs env list                          # GET /api/v1/self/env-vars
skills-cli.mjs env set <key> <value> [--desc ""] # POST /api/v1/self/env-vars
skills-cli.mjs env link <skillName> <key>         # POST /api/v1/self/skills/{id}/env-vars/{id}
skills-cli.mjs env unlink <skillName> <key>       # DELETE
skills-cli.mjs register <repoUrl> [--branch] [--subpath] [--name]
skills-cli.mjs sync-skill <registryId>            # POST /api/v1/registry/{id}/sync
skills-cli.mjs sync [--dir .claude/skills]        # Generate thin SKILL.md stubs locally
skills-cli.mjs version                            # Check for updates
```

The `sync` command generates thin stub folders for frameworks that discover skills by scanning directories (Claude Code, openrouter-skills-as-tools):
```
.claude/skills/
  skills-server/SKILL.md         # Bootstrap (always present)
  skills-server/skills-cli.mjs   # The CLI
  weather/SKILL.md               # Stub: name, description, "call skills-cli.mjs load weather"
  clickup/SKILL.md               # Stub
```

**16. Update `public/skill.md`** — Rewrite to reference CLI download, self-service env vars, and the full workflow.

---

### Phase G: Admin UI Updates

**17. Update `public/index.html`**

- **Agents tab**: Add `permissionLevel` dropdown (none/execute/maintain/admin) in create form and edit view. Show as column in table.
- **Permissions tab**: Add `level` dropdown per skill grant (currently checkbox-only). Show effective permission.
- **New Registry tab** (between Skills and Agents): Table of registered skills with name, repo URL, branch, status, last synced. Register form. Sync/unregister buttons. Status badges (green active, yellow syncing, red broken).
- **Env Vars tab**: Show `owner` column (admin or agent name). Filter toggle for admin vs agent-owned.

---

### Phase H: Tests

**18. New test files** following existing pattern (Node.js scripts with fetch + assert):

- `tests/test-permissions.mjs` — Permission level system
  - Agent with `none` can't access skills, `execute` can access all, `maintain` can register, `admin` can grant
  - Per-skill level elevation works
  - Effective = max(agent, skill)

- `tests/test-self-service.mjs` — Self-service env vars
  - Create, list (no values), update, delete
  - Link/unlink env var to skill
  - Can't modify admin-owned or other agents' vars
  - Auto-grant on create

- `tests/test-missing-env.mjs` — Missing env var detection
  - Execute with missing env var returns 422 with structured error
  - After creating + linking, execute succeeds
  - "Has but not linked" case detected correctly

- `tests/test-registry.mjs` — Git registry (requires git + network)
  - Register public repo, verify skill appears
  - Sync pulls latest
  - Unregister removes skill
  - Broken symlink detection

---

## Key Files Modified

| File | Changes |
|------|---------|
| `src/db/schema.ts` | Add `permissionLevel` to agents, `level` to agentSkills, `ownerId` to envVars, new `skillRegistry` table |
| `src/db/index.ts` | Idempotent ALTER migrations, new CREATE TABLE, unique index change |
| `src/routes/agent-facing.ts` | Permission-aware `requireSkillAccess`, missing env var detection in execute |
| `src/routes/agents.ts` | `permissionLevel` in CRUD schemas + handlers |
| `src/routes/permissions.ts` | `level` field in grant/set/get schemas + handlers |
| `src/app.ts` | Wire self-service + registry routes, pass reposDir |
| `src/index.ts` | Create skills/ + repos/ dirs, startup logging |
| `.gitignore` | Add `skills/`, `repos/` |
| `.env.example` | `SKILLS_DIR=./examples/skills`, add `REPOS_DIR` |
| `public/index.html` | Permission levels, registry tab, env var ownership display |

## New Files

| File | Purpose |
|------|---------|
| `src/services/permissions.ts` | Permission level logic (hasPermission, getEffectivePermission, requirePermission) |
| `src/services/git.ts` | Git clone/pull via execFile |
| `src/services/symlink.ts` | Cross-platform symlink/junction management |
| `src/routes/self-service.ts` | Agent self-service env var CRUD + skill linking |
| `src/routes/registry.ts` | Git-backed skill registry CRUD + sync |
| `public/skills-cli.mjs` | Standalone CLI for agents |
| `public/skill.md` | Rewritten bootstrap SKILL.md |
| `tests/test-permissions.mjs` | Permission level tests |
| `tests/test-self-service.mjs` | Self-service env var tests |
| `tests/test-missing-env.mjs` | Missing env var detection tests |
| `tests/test-registry.mjs` | Registry + git sync tests |

## Future: SDK Adapters (Document Only)

For production agent deployments, native SDK adapters will replace CLI subprocess calls:
- **Claude Agent SDK adapter**: Tool definitions for `load_skill` and `use_skill` that call the HTTP API directly from the agent's process
- **OpenRouter SDK adapter**: Same tool pattern for OpenRouter-based agents
- These are documented in README as planned integrations but not implemented in Phase 2

## Verification

1. Delete `skills-server.db`, start dev server — verify migrations run, examples load from `examples/skills/`
2. Run existing tests (`tests/test-api.mjs`, `tests/test-e2e.mjs`, `tests/test-weather.mjs`) — all should pass with schema additions (backward compatible)
3. Run new test suites in order: permissions -> self-service -> missing-env -> registry
4. Browser test: walk through admin UI tabs, verify permission dropdowns, registry tab, env var ownership
5. Live agent test: authenticate as agent, create self-service env var, link to skill, execute, verify env var injection
6. Registry test: register a public GitHub repo (e.g., the examples/skills/hello skill pushed to a test repo), sync, execute
