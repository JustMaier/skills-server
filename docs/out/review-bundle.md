## src/db/schema.ts
```typescript
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// ─── Agents ──────────────────────────────────────────────────────────────────

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

// ─── Skills ──────────────────────────────────────────────────────────────────

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").unique().notNull(),
  description: text("description"),
  dirPath: text("dir_path").notNull(),
  scripts: text("scripts").notNull(), // JSON array as string
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

// ─── Environment Variables ───────────────────────────────────────────────────

export const envVars = sqliteTable("env_vars", {
  id: text("id").primaryKey(),
  key: text("key").unique().notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type EnvVar = typeof envVars.$inferSelect;
export type NewEnvVar = typeof envVars.$inferInsert;

// ─── Agent <-> Skill (many-to-many) ─────────────────────────────────────────

export const agentSkills = sqliteTable(
  "agent_skills",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.skillId] })],
);

export type AgentSkill = typeof agentSkills.$inferSelect;
export type NewAgentSkill = typeof agentSkills.$inferInsert;

// ─── Agent <-> EnvVar (many-to-many) ────────────────────────────────────────

export const agentEnvVars = sqliteTable(
  "agent_env_vars",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    envVarId: text("env_var_id")
      .notNull()
      .references(() => envVars.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.envVarId] })],
);

export type AgentEnvVar = typeof agentEnvVars.$inferSelect;
export type NewAgentEnvVar = typeof agentEnvVars.$inferInsert;

// ─── Execution Logs ─────────────────────────────────────────────────────────

export const executionLogs = sqliteTable("execution_logs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  skillName: text("skill_name").notNull(),
  script: text("script").notNull(),
  args: text("args"),
  exitCode: integer("exit_code"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at").notNull(),
});

export type ExecutionLog = typeof executionLogs.$inferSelect;
export type NewExecutionLog = typeof executionLogs.$inferInsert;

```

## src/db/index.ts
```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

// Re-export everything from schema so consumers can do:
//   import { db, agents, skills, ... } from "./db/index.js";
export * from "./schema.js";

// ─── Raw SQLite connection ──────────────────────────────────────────────────

const sqlite = new Database("./skills-server.db");

// Enable WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");

// Enforce foreign key constraints (off by default in SQLite)
sqlite.pragma("foreign_keys = ON");

// ─── Create tables if they don't exist ──────────────────────────────────────

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    api_key_hash  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skills (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT,
    dir_path      TEXT NOT NULL,
    scripts       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS env_vars (
    id              TEXT PRIMARY KEY,
    key             TEXT NOT NULL UNIQUE,
    encrypted_value TEXT NOT NULL,
    description     TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS agent_env_vars (
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    env_var_id  TEXT NOT NULL REFERENCES env_vars(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, env_var_id)
  );

  CREATE TABLE IF NOT EXISTS execution_logs (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
    skill_name  TEXT NOT NULL,
    script      TEXT NOT NULL,
    args        TEXT,
    exit_code   INTEGER,
    error       TEXT,
    duration_ms INTEGER,
    created_at  INTEGER NOT NULL
  );
`);

// ─── Drizzle ORM instance ───────────────────────────────────────────────────

export const db = drizzle(sqlite, { schema });

```

## src/services/crypto.ts
```typescript
import { createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual as tsEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. HMAC-SHA-256 API key hashing
// ---------------------------------------------------------------------------

/**
 * Produce a hex-encoded HMAC-SHA-256 digest of the given API key.
 *
 * The HMAC secret is read from `process.env.HMAC_SECRET` and must be set
 * before calling this function.
 */
export function hashApiKey(key: string): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    throw new Error('HMAC_SECRET environment variable is not set');
  }
  return createHmac('sha256', secret).update(key).digest('hex');
}

// ---------------------------------------------------------------------------
// 2. AES-256-GCM encryption / decryption
// ---------------------------------------------------------------------------

const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Read and validate the 32-byte encryption key from the environment.
 *
 * `ENCRYPTION_KEY` must be a 64-character hex string (representing 32 bytes).
 */
function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  if (hex.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Received ${hex.length} characters.`,
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns a base64 string containing `iv (12 B) || authTag (16 B) || ciphertext`.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack as: iv + tag + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64 ciphertext string that was produced by {@link encrypt}.
 *
 * Expects the format `base64(iv (12 B) || authTag (16 B) || ciphertext)`.
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const packed = Buffer.from(ciphertext, 'base64');

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Ciphertext is too short to contain IV and auth tag');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// 3. Random API key generation
// ---------------------------------------------------------------------------

/**
 * Generate a random API key with the format `sk-agent-<32 hex chars>`.
 */
export function generateApiKey(): string {
  return `sk-agent-${randomBytes(16).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// 4. Constant-time string comparison
// ---------------------------------------------------------------------------

/**
 * Compare two strings in constant time to prevent timing attacks.
 *
 * Returns `false` immediately (but safely) if the strings differ in length,
 * since `crypto.timingSafeEqual` requires equal-length buffers.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return tsEqual(bufA, bufB);
}

```

## src/services/auth.ts
```typescript
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";

import { db, agents, type Agent } from "../db/index.js";
import { hashApiKey, timingSafeEqual } from "./crypto.js";

// ---------------------------------------------------------------------------
// Hono Env type – allows routes to access `c.get('agent')` with full typing
// ---------------------------------------------------------------------------

export type AuthEnv = {
  Variables: {
    agent: Agent;
  };
};

// ---------------------------------------------------------------------------
// Agent authentication middleware
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming request using a Bearer token that maps to a
 * registered agent in the database.
 *
 * On success the matched {@link Agent} record is stored on the Hono context
 * so downstream handlers can retrieve it via `c.get('agent')`.
 */
export const agentAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = header.slice("Bearer ".length);
  const hash = hashApiKey(key);

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.apiKeyHash, hash))
    .limit(1);

  if (!agent) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("agent", agent);
  await next();
});

// ---------------------------------------------------------------------------
// Admin authentication middleware
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming request against the server-level admin API key
 * stored in `process.env.ADMIN_API_KEY`.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export const adminAuth = createMiddleware(async (c, next) => {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    return c.json({ error: "Admin authentication required" }, 401);
  }

  const header = c.req.header("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Admin authentication required" }, 401);
  }

  const key = header.slice("Bearer ".length);

  if (!timingSafeEqual(key, adminKey)) {
    return c.json({ error: "Admin authentication required" }, 401);
  }

  await next();
});

```

## src/services/discovery.ts
```typescript
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed representation of a single skill directory. */
export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  dirPath: string;
  scripts: string[];
  frontmatter: Record<string, string>;
  parseError?: string;
}

/** Aggregate result from a full discovery scan. */
export interface DiscoveryResult {
  skills: SkillDefinition[];
  errors: Array<{ dir: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_FILENAME = 'SKILL.md';
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.js', '.sh']);

// ---------------------------------------------------------------------------
// Frontmatter & Markdown helpers
// ---------------------------------------------------------------------------

/**
 * Parse simple YAML frontmatter from raw text.
 *
 * Handles `key: value` lines only (no nested objects, arrays, etc.).
 * Values may be optionally quoted with single or double quotes.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract the first paragraph from markdown content.
 *
 * Skips blank lines and headings, then returns the first contiguous block of
 * non-empty, non-heading lines joined into a single string.
 */
function firstParagraph(markdown: string): string {
  const lines = markdown.split('\n');
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      started = true;
      paragraphLines.push(trimmed);
    } else {
      if (trimmed === '' || trimmed.startsWith('#')) break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(' ');
}

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md file, extracting YAML frontmatter metadata and the
 * markdown body below it.
 *
 * - `name` defaults to the parent directory name when absent from frontmatter.
 * - `description` falls back to the first paragraph of the markdown body.
 * - All frontmatter key-value pairs are returned in `frontmatter`.
 *
 * @param filePath - Absolute path to a SKILL.md file
 */
export async function parseSkillFile(
  filePath: string,
): Promise<{
  name: string;
  description: string;
  content: string;
  frontmatter: Record<string, string>;
}> {
  const raw = await readFile(filePath, 'utf-8');

  let frontmatter: Record<string, string> = {};
  let content = raw;

  // Check for YAML frontmatter delimited by --- on its own line
  if (raw.startsWith('---')) {
    const endIndex = raw.indexOf('\n---', 3);
    if (endIndex !== -1) {
      const frontmatterRaw = raw.slice(3, endIndex);
      frontmatter = parseFrontmatter(frontmatterRaw);

      // Content is everything after the closing --- line
      const afterClosing = endIndex + 4; // length of "\n---"
      content = raw.slice(afterClosing).replace(/^\r?\n/, '');
    }
  }

  // Name: frontmatter > parent directory name
  const name = frontmatter['name'] ?? basename(resolve(filePath, '..'));

  // Description: frontmatter > first paragraph of body
  const description = frontmatter['description'] || firstParagraph(content);

  return { name, description, content, frontmatter };
}

// ---------------------------------------------------------------------------
// collectScripts
// ---------------------------------------------------------------------------

/**
 * Find script files in a skill directory by extension (.mjs, .js, .sh).
 *
 * Scans the skill root directory and an optional `scripts/` subfolder.
 * Scripts found in the subfolder are prefixed with `"scripts/"` so callers
 * can distinguish them.
 *
 * @param skillDir - Absolute path to the skill directory
 * @returns Array of script filenames (e.g. `["run.mjs", "scripts/setup.sh"]`)
 */
export async function collectScripts(skillDir: string): Promise<string[]> {
  const scripts: string[] = [];

  // Collect from root
  try {
    const rootEntries = await readdir(skillDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile()) continue;
      if (SCRIPT_EXTENSIONS.has(extname(entry.name))) {
        scripts.push(entry.name);
      }
    }
  } catch {
    // Directory unreadable — return empty
  }

  // Collect from scripts/ subfolder
  const subDir = join(skillDir, 'scripts');
  try {
    const subEntries = await readdir(subDir, { withFileTypes: true });
    for (const entry of subEntries) {
      if (!entry.isFile()) continue;
      if (SCRIPT_EXTENSIONS.has(extname(entry.name))) {
        scripts.push(`scripts/${entry.name}`);
      }
    }
  } catch {
    // No scripts/ subfolder — that is fine
  }

  return scripts;
}

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

/**
 * Scan a directory for subdirectories containing a SKILL.md file.
 *
 * For each valid skill directory the SKILL.md is parsed and scripts are
 * collected. Directories that lack a SKILL.md are silently skipped.
 * Directories whose SKILL.md fails to parse are recorded in the `errors`
 * array and still included in `skills` with a `parseError` field set.
 *
 * @param skillsDir - Absolute path to the skills root directory
 * @returns All discovered skills plus any per-directory errors
 */
export async function discoverSkills(
  skillsDir: string,
): Promise<DiscoveryResult> {
  const resolvedDir = resolve(skillsDir);
  const skills: SkillDefinition[] = [];
  const errors: Array<{ dir: string; error: string }> = [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch {
    return { skills, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(resolvedDir, entry.name);
    const skillFilePath = join(skillDir, SKILL_FILENAME);

    // Check that SKILL.md exists and is a file
    try {
      const fileStat = await stat(skillFilePath);
      if (!fileStat.isFile()) continue;
    } catch {
      // No SKILL.md in this directory — skip silently
      continue;
    }

    // Parse and collect
    try {
      const [parsed, scripts] = await Promise.all([
        parseSkillFile(skillFilePath),
        collectScripts(skillDir),
      ]);

      skills.push({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        dirPath: skillDir,
        scripts,
        frontmatter: parsed.frontmatter,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      errors.push({ dir: skillDir, error: message });

      // Include a degraded entry so the caller knows the directory existed
      skills.push({
        name: entry.name,
        description: '',
        content: '',
        dirPath: skillDir,
        scripts: [],
        frontmatter: {},
        parseError: message,
      });
    }
  }

  return { skills, errors };
}

// ---------------------------------------------------------------------------
// createSkillsManager
// ---------------------------------------------------------------------------

/**
 * Create a long-lived skills manager that caches discovery results and
 * automatically re-parses individual skills when their SKILL.md file
 * changes on disk (detected via mtime comparison).
 *
 * Follows the same staleness pattern as the reference repo's
 * `refreshIfStale` / `rediscover`:
 *
 * 1. `getSkill(name)` — check SKILL.md mtime against cached value.
 *    If changed, re-parse that single skill. If the skill is not in
 *    the cache at all, perform a full rescan in case it was added after
 *    startup.
 * 2. `getAllSkills()` — return all currently cached skills.
 * 3. `reload()` — full rescan of the skills directory.
 * 4. `getErrors()` — return parse errors from the most recent scan.
 *
 * @param skillsDir - Absolute path to the skills root directory
 */
export function createSkillsManager(skillsDir: string) {
  const resolvedDir = resolve(skillsDir);

  /** name -> SkillDefinition */
  const skillsMap = new Map<string, SkillDefinition>();

  /** name -> mtimeMs of SKILL.md when last parsed */
  const mtimes = new Map<string, number>();

  /** Errors from the most recent scan */
  let lastErrors: Array<{ dir: string; error: string }> = [];

  /** Whether the initial discovery has been performed */
  let initialized = false;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Populate the cache from a DiscoveryResult. */
  async function applyResult(result: DiscoveryResult): Promise<void> {
    for (const skill of result.skills) {
      // First occurrence wins (same semantics as the reference repo)
      if (skillsMap.has(skill.name)) continue;

      skillsMap.set(skill.name, skill);

      try {
        const s = await stat(join(skill.dirPath, SKILL_FILENAME));
        mtimes.set(skill.name, s.mtimeMs);
      } catch {
        // Cannot stat — staleness checking will be unavailable for this skill
      }
    }
    lastErrors = result.errors;
  }

  /** Ensure initial discovery has run at least once. */
  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    const result = await discoverSkills(resolvedDir);
    await applyResult(result);
    initialized = true;
  }

  /**
   * Re-parse a single skill if its SKILL.md mtime has changed.
   *
   * If the skill's mtime matches the cached value the function returns
   * immediately — no disk I/O beyond a single `stat` call.
   */
  async function refreshIfStale(skillName: string): Promise<void> {
    const skill = skillsMap.get(skillName);
    if (!skill) return;

    try {
      const s = await stat(join(skill.dirPath, SKILL_FILENAME));
      const cached = mtimes.get(skillName);
      if (cached !== undefined && s.mtimeMs === cached) return;

      // Mtime changed (or was never recorded) — re-parse
      const [parsed, scripts] = await Promise.all([
        parseSkillFile(join(skill.dirPath, SKILL_FILENAME)),
        collectScripts(skill.dirPath),
      ]);

      const updated: SkillDefinition = {
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        dirPath: skill.dirPath,
        scripts,
        frontmatter: parsed.frontmatter,
      };

      skillsMap.set(skillName, updated);
      mtimes.set(skillName, s.mtimeMs);
    } catch {
      // stat or parse failed — keep the existing cached version
    }
  }

  /**
   * Full rescan: discover all skills and merge any new ones into the cache.
   * Existing entries are *not* overwritten (first-seen wins), so this is
   * safe to call at any time.
   */
  async function rediscover(): Promise<DiscoveryResult> {
    const result = await discoverSkills(resolvedDir);
    await applyResult(result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Get a single skill by name.
     *
     * - If the skill is cached, its SKILL.md mtime is checked and it is
     *   re-parsed when stale.
     * - If the skill is not in the cache, a full rescan is triggered in
     *   case the directory was added after the manager was created.
     * - Returns `null` if the skill cannot be found even after rescanning.
     */
    async getSkill(name: string): Promise<SkillDefinition | null> {
      await ensureInitialized();

      let skill = skillsMap.get(name);
      if (skill) {
        await refreshIfStale(name);
        return skillsMap.get(name) ?? null;
      }

      // Not found — maybe it was added since last scan
      await rediscover();
      return skillsMap.get(name) ?? null;
    },

    /**
     * Return all currently cached skills.
     *
     * Does *not* re-check staleness for every skill — call `reload()` to
     * force a full rescan, or use `getSkill()` for on-demand freshness.
     */
    async getAllSkills(): Promise<SkillDefinition[]> {
      await ensureInitialized();
      return [...skillsMap.values()];
    },

    /**
     * Clear the cache and perform a full rescan of the skills directory.
     */
    async reload(): Promise<DiscoveryResult> {
      skillsMap.clear();
      mtimes.clear();
      initialized = false;
      const result = await discoverSkills(resolvedDir);
      await applyResult(result);
      initialized = true;
      return result;
    },

    /**
     * Return errors from the most recent discovery scan.
     */
    getErrors(): Array<{ dir: string; error: string }> {
      return [...lastErrors];
    },
  };
}

```

## src/services/executor.ts
```typescript
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'ScriptNotFound'
  | 'ScriptNotAllowed'
  | 'InvalidArgs'
  | 'ExecutionTimeout'
  | 'ExecutionFailed';

export interface ExecuteOptions {
  /** Absolute path to the skill directory. */
  skillDir: string;
  /** Script filename (e.g. "run.mjs"). Must be a simple name, no paths. */
  script: string;
  /** Arguments to pass to the script. */
  args?: string[];
  /** Execution timeout in milliseconds (default 30 000). */
  timeout?: number;
  /** Maximum bytes for stdout / stderr (default 20 480 = 20 KB). */
  maxOutput?: number;
  /** Working directory for the child process (default: skillDir). */
  cwd?: string;
  /** Environment variables. When provided, completely replaces process.env. */
  env?: Record<string, string>;
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 20_480;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `script` is a simple filename with no path traversal.
 *
 * Rejects empty strings, strings containing `..`, `/`, or `\`, and absolute
 * paths on any platform.
 */
function isSimpleFilename(script: string): boolean {
  if (!script || script.trim().length === 0) {
    return false;
  }
  if (script.includes('..') || script.includes('/') || script.includes('\\')) {
    return false;
  }
  if (path.isAbsolute(script)) {
    return false;
  }
  return true;
}

/**
 * Truncate a string so that its UTF-8 byte length does not exceed `maxBytes`.
 *
 * When truncation occurs a trailing `\n[output truncated]` marker is appended.
 */
function capOutput(output: string, maxBytes: number): string {
  const buf = Buffer.from(output, 'utf-8');
  if (buf.length <= maxBytes) {
    return output;
  }
  const truncated = buf.subarray(0, maxBytes).toString('utf-8');
  return truncated + '\n[output truncated]';
}

/**
 * Synchronously check whether a file exists and is readable.
 */
function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `script` to an absolute path inside `skillDir`.
 *
 * Lookup order:
 *   1. `<skillDir>/<script>`
 *   2. `<skillDir>/scripts/<script>`
 *
 * After resolution the path is verified to still reside within `skillDir`
 * (containment check). Returns the absolute path on success, or `null`.
 */
function resolveScript(skillDir: string, script: string): string | null {
  const resolvedSkillDir = path.resolve(skillDir);
  const candidateRoot = path.resolve(resolvedSkillDir, script);
  const candidateScripts = path.resolve(resolvedSkillDir, 'scripts', script);

  let scriptPath: string | null = null;

  if (fileExists(candidateRoot)) {
    scriptPath = candidateRoot;
  } else if (fileExists(candidateScripts)) {
    scriptPath = candidateScripts;
  }

  if (scriptPath === null) {
    return null;
  }

  // Containment: resolved path must be inside skillDir
  const normalizedSkillDir = resolvedSkillDir + path.sep;
  if (scriptPath !== resolvedSkillDir && !scriptPath.startsWith(normalizedSkillDir)) {
    return null;
  }

  return scriptPath;
}

/**
 * Determine the interpreter command and argument list for a given script.
 *
 * - `.mjs` / `.js`  -> node
 * - `.sh`           -> bash
 * - anything else   -> direct execution
 */
function resolveCommand(
  scriptPath: string,
  args: string[],
): { command: string; execArgs: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();

  switch (ext) {
    case '.mjs':
    case '.js':
      return { command: 'node', execArgs: [scriptPath, ...args] };
    case '.sh':
      return { command: 'bash', execArgs: [scriptPath, ...args] };
    default:
      return { command: scriptPath, execArgs: args };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a script inside a skill directory with strict security containment.
 *
 * Security measures applied:
 * - **No shell** -- uses `execFile`, never `exec`.
 * - **Path traversal prevention** -- `isSimpleFilename` rejects `..`, `/`, `\`.
 * - **Containment** -- `resolveScript` verifies the resolved path stays within
 *   the skill directory.
 * - **Timeout** -- the child process is killed when the timeout expires.
 * - **Output capping** -- stdout and stderr are truncated to `maxOutput` bytes.
 */
export async function executeScript(options: ExecuteOptions): Promise<ExecutionResult> {
  const {
    skillDir,
    script,
    args = [],
    timeout = DEFAULT_TIMEOUT,
    maxOutput = DEFAULT_MAX_OUTPUT,
    cwd,
    env,
  } = options;

  const startTime = Date.now();

  // --- Security: validate script name ----------------------------------
  if (!isSimpleFilename(script)) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'ScriptNotAllowed',
      durationMs: Date.now() - startTime,
    };
  }

  // --- Validate args ---------------------------------------------------
  if (args.some((a) => typeof a !== 'string')) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'InvalidArgs',
      durationMs: Date.now() - startTime,
    };
  }

  // --- Resolve script path ---------------------------------------------
  const scriptPath = resolveScript(skillDir, script);

  if (scriptPath === null) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'ScriptNotFound',
      durationMs: Date.now() - startTime,
    };
  }

  // --- Build command ---------------------------------------------------
  const { command, execArgs } = resolveCommand(scriptPath, args);

  // --- Execute ---------------------------------------------------------
  return new Promise<ExecutionResult>((resolve) => {
    const child = execFile(
      command,
      execArgs,
      {
        cwd: cwd ?? skillDir,
        timeout,
        maxBuffer: maxOutput * 2, // headroom; we cap manually below
        windowsHide: true,
        ...(env !== undefined && { env }),
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const cappedStdout = capOutput(stdout ?? '', maxOutput);
        const cappedStderr = capOutput(stderr ?? '', maxOutput);

        if (error) {
          // Timeout: Node sets `error.killed` when the child is killed due to
          // the timeout option, and may also set code to ETIMEDOUT.
          if (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            resolve({
              success: false,
              stdout: cappedStdout,
              stderr: cappedStderr,
              exitCode: -1,
              error: 'ExecutionTimeout',
              durationMs,
            });
            return;
          }

          // Non-zero exit or other failure
          const exitCode =
            child.exitCode ?? (error as unknown as { status?: number }).status ?? -1;
          resolve({
            success: false,
            stdout: cappedStdout,
            stderr: cappedStderr,
            exitCode: typeof exitCode === 'number' ? exitCode : -1,
            error: 'ExecutionFailed',
            durationMs,
          });
          return;
        }

        // Success
        resolve({
          success: true,
          stdout: cappedStdout,
          stderr: cappedStderr,
          exitCode: 0,
          error: null,
          durationMs,
        });
      },
    );
  });
}

```

## src/routes/agent-facing.ts
```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, agentSkills, skills, agentEnvVars, envVars, executionLogs } from '../db/index.js';
import { agentAuth, type AuthEnv } from '../services/auth.js';
import { createSkillsManager, type SkillDefinition } from '../services/discovery.js';
import { executeScript, type ExecutionResult } from '../services/executor.js';
import { decrypt } from '../services/crypto.js';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const ErrorSchema = z.object({
  error: z.string(),
});

const SkillSummarySchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  scripts: z.array(z.string()),
});

const SkillDetailSchema = z.object({
  name: z.string(),
  description: z.string(),
  frontmatter: z.record(z.string(), z.string()),
  content: z.string(),
  scripts: z.array(z.string()),
  updatedAt: z.number(),
});

const ExecuteBodySchema = z.object({
  script: z.string(),
  args: z.array(z.string()).default([]),
});

const ExecutionResultSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  error: z.string().nullable(),
  durationMs: z.number(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSkillsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Skills'],
  summary: 'List skills the agent has access to',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: 'Array of skills the authenticated agent can access',
      content: {
        'application/json': {
          schema: z.array(SkillSummarySchema),
        },
      },
    },
  },
});

const getSkillRoute = createRoute({
  method: 'get',
  path: '/{name}',
  tags: ['Skills'],
  summary: 'Get full skill content by name',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      name: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Full skill content including markdown and frontmatter',
      content: {
        'application/json': {
          schema: SkillDetailSchema,
        },
      },
    },
    403: {
      description: 'Agent does not have access to this skill',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: 'Skill not found',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

const executeSkillRoute = createRoute({
  method: 'post',
  path: '/{name}/execute',
  tags: ['Skills'],
  summary: 'Execute a script within a skill',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      name: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: ExecuteBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Script execution result',
      content: {
        'application/json': {
          schema: ExecutionResultSchema,
        },
      },
    },
    403: {
      description: 'Agent does not have access to this skill',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: 'Skill not found',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentFacingRoutes(
  skillsManager: ReturnType<typeof createSkillsManager>,
) {
  const app = new OpenAPIHono<AuthEnv>();

  // ─── GET / — List skills ───────────────────────────────────────────────────

  app.openapi(listSkillsRoute, async (c) => {
    const agent = c.get('agent');

    // Find which skill IDs this agent is granted
    const grants = await db
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agent.id));

    if (grants.length === 0) {
      return c.json([], 200);
    }

    // Fetch the corresponding skill rows
    const results: z.infer<typeof SkillSummarySchema>[] = [];

    for (const { skillId } of grants) {
      const [skill] = await db
        .select()
        .from(skills)
        .where(eq(skills.id, skillId))
        .limit(1);

      if (skill) {
        results.push({
          name: skill.name,
          description: skill.description,
          scripts: JSON.parse(skill.scripts) as string[],
        });
      }
    }

    return c.json(results, 200);
  });

  // ─── GET /:name — Get skill content ────────────────────────────────────────

  app.openapi(getSkillRoute, async (c) => {
    const agent = c.get('agent');
    const { name } = c.req.valid('param');

    // Look up the skill row by name to get its ID
    const [skillRow] = await db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);

    if (!skillRow) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    // Verify the agent has access
    const [grant] = await db
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.agentId, agent.id),
          eq(agentSkills.skillId, skillRow.id),
        ),
      )
      .limit(1);

    if (!grant) {
      return c.json({ error: 'Not authorized to access this skill' }, 403);
    }

    // Get fresh content from the skills manager (with staleness check)
    const skill = await skillsManager.getSkill(name);

    if (!skill) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    return c.json(
      {
        name: skill.name,
        description: skill.description,
        frontmatter: skill.frontmatter,
        content: skill.content,
        scripts: skill.scripts,
        updatedAt: skillRow.updatedAt,
      },
      200,
    );
  });

  // ─── POST /:name/execute — Execute a script ───────────────────────────────

  app.openapi(executeSkillRoute, async (c) => {
    const agent = c.get('agent');
    const { name } = c.req.valid('param');
    const { script, args } = c.req.valid('json');

    // Look up the skill row by name
    const [skillRow] = await db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);

    if (!skillRow) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    // Verify the agent has access
    const [grant] = await db
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.agentId, agent.id),
          eq(agentSkills.skillId, skillRow.id),
        ),
      )
      .limit(1);

    if (!grant) {
      return c.json({ error: 'Not authorized to access this skill' }, 403);
    }

    // Get fresh skill definition from the manager
    const skill = await skillsManager.getSkill(name);

    if (!skill) {
      return c.json({ error: 'Skill not found' }, 404);
    }

    // Gather the agent's granted environment variables
    const grantedEnvVars = await db
      .select({
        key: envVars.key,
        encryptedValue: envVars.encryptedValue,
      })
      .from(agentEnvVars)
      .innerJoin(envVars, eq(agentEnvVars.envVarId, envVars.id))
      .where(eq(agentEnvVars.agentId, agent.id));

    // Decrypt each env var into a plain key-value map
    const env: Record<string, string> = {};
    for (const row of grantedEnvVars) {
      env[row.key] = decrypt(row.encryptedValue);
    }

    // Execute the script
    const result: ExecutionResult = await executeScript({
      skillDir: skill.dirPath,
      script,
      args,
      env,
    });

    // Log execution
    await db.insert(executionLogs).values({
      id: uuid(),
      agentId: agent.id,
      skillName: name,
      script,
      args: JSON.stringify(args),
      exitCode: result.exitCode,
      error: result.error,
      durationMs: result.durationMs,
      createdAt: Date.now(),
    });

    return c.json(
      {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        error: result.error,
        durationMs: result.durationMs,
      },
      200,
    );
  });

  return app;
}

```

## src/routes/agents.ts
```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, agents } from '../db/index.js';
import { adminAuth } from '../services/auth.js';
import { hashApiKey, generateApiKey } from '../services/crypto.js';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const AgentIdParam = z.object({
  id: z.string().openapi({ description: 'Agent ID', example: 'a1b2c3d4-...' }),
});

const CreateAgentBody = z.object({
  name: z.string().min(1).openapi({ description: 'Agent display name', example: 'my-agent' }),
});

const UpdateAgentBody = z.object({
  name: z.string().min(1).optional().openapi({ description: 'New agent name' }),
});

const AgentResponse = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const AgentCreatedResponse = z.object({
  id: z.string(),
  name: z.string(),
  apiKey: z.string().openapi({ description: 'Plain-text API key — shown only once' }),
  createdAt: z.number(),
});

const RotateKeyResponse = z.object({
  id: z.string(),
  apiKey: z.string().openapi({ description: 'New plain-text API key — shown only once' }),
});

const ErrorResponse = z.object({
  error: z.string(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createAgentRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Agents'],
  summary: 'Create a new agent',
  middleware: [adminAuth] as const,
  request: {
    body: {
      content: { 'application/json': { schema: CreateAgentBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Agent created — API key is shown only this once',
      content: { 'application/json': { schema: AgentCreatedResponse } },
    },
  },
});

const listAgentsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Agents'],
  summary: 'List all agents',
  middleware: [adminAuth] as const,
  responses: {
    200: {
      description: 'Array of agents',
      content: { 'application/json': { schema: z.array(AgentResponse) } },
    },
  },
});

const getAgentRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Get a single agent by ID',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdParam,
  },
  responses: {
    200: {
      description: 'Agent found',
      content: { 'application/json': { schema: AgentResponse } },
    },
    404: {
      description: 'Agent not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const updateAgentRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Update an agent',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdParam,
    body: {
      content: { 'application/json': { schema: UpdateAgentBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Agent updated',
      content: { 'application/json': { schema: AgentResponse } },
    },
    404: {
      description: 'Agent not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const deleteAgentRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Delete an agent',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdParam,
  },
  responses: {
    204: {
      description: 'Agent deleted',
    },
    404: {
      description: 'Agent not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const rotateKeyRoute = createRoute({
  method: 'post',
  path: '/{id}/rotate',
  tags: ['Agents'],
  summary: 'Rotate an agent API key',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdParam,
  },
  responses: {
    200: {
      description: 'New API key — shown only this once',
      content: { 'application/json': { schema: RotateKeyResponse } },
    },
    404: {
      description: 'Agent not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const app = new OpenAPIHono();

// POST / — Create agent
app.openapi(createAgentRoute, async (c) => {
  const { name } = c.req.valid('json');
  const id = uuid();
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const now = Date.now();

  await db.insert(agents).values({
    id,
    name,
    apiKeyHash,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ id, name, apiKey, createdAt: now }, 201);
});

// GET / — List all agents
app.openapi(listAgentsRoute, async (c) => {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents);

  return c.json(rows, 200);
});

// GET /:id — Get single agent
app.openapi(getAgentRoute, async (c) => {
  const { id } = c.req.valid('param');

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  return c.json(agent, 200);
});

// PATCH /:id — Update agent
app.openapi(updateAgentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const now = Date.now();

  await db
    .update(agents)
    .set({ ...body, updatedAt: now })
    .where(eq(agents.id, id));

  const [updated] = await db
    .select({
      id: agents.id,
      name: agents.name,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  return c.json(updated!, 200);
});

// DELETE /:id — Delete agent
app.openapi(deleteAgentRoute, async (c) => {
  const { id } = c.req.valid('param');

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  await db.delete(agents).where(eq(agents.id, id));

  return c.body(null, 204);
});

// POST /:id/rotate — Rotate API key
app.openapi(rotateKeyRoute, async (c) => {
  const { id } = c.req.valid('param');

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const now = Date.now();

  await db
    .update(agents)
    .set({ apiKeyHash, updatedAt: now })
    .where(eq(agents.id, id));

  return c.json({ id, apiKey }, 200);
});

export default app;

```

## src/routes/env-vars.ts
```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, envVars, agentEnvVars, agents } from '../db/index.js';
import { adminAuth } from '../services/auth.js';
import { encrypt } from '../services/crypto.js';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const EnvVarId = z.string().openapi({ description: 'Environment variable ID', example: 'a1b2c3d4-...' });

const EnvVarCreated = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  createdAt: z.number(),
}).openapi('EnvVarCreated');

const EnvVarListItem = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi('EnvVarListItem');

const EnvVarUpdated = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  updatedAt: z.number(),
}).openapi('EnvVarUpdated');

const AgentRef = z.object({
  id: z.string(),
  name: z.string(),
}).openapi('AgentRef');

const ErrorResponse = z.object({
  error: z.string(),
}).openapi('ErrorResponse');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createEnvVarRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Environment Variables'],
  summary: 'Create an environment variable',
  middleware: [adminAuth] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            key: z.string().min(1),
            value: z.string().min(1),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Environment variable created',
      content: { 'application/json': { schema: EnvVarCreated } },
    },
    409: {
      description: 'Key already exists',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const listEnvVarsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Environment Variables'],
  summary: 'List all environment variables',
  middleware: [adminAuth] as const,
  responses: {
    200: {
      description: 'List of environment variables',
      content: { 'application/json': { schema: z.array(EnvVarListItem) } },
    },
  },
});

const updateEnvVarRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Environment Variables'],
  summary: 'Update an environment variable',
  middleware: [adminAuth] as const,
  request: {
    params: z.object({ id: EnvVarId }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            value: z.string().min(1).optional(),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Environment variable updated',
      content: { 'application/json': { schema: EnvVarUpdated } },
    },
    404: {
      description: 'Environment variable not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const deleteEnvVarRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Environment Variables'],
  summary: 'Delete an environment variable',
  middleware: [adminAuth] as const,
  request: {
    params: z.object({ id: EnvVarId }),
  },
  responses: {
    204: { description: 'Environment variable deleted' },
    404: {
      description: 'Environment variable not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const listEnvVarAgentsRoute = createRoute({
  method: 'get',
  path: '/{id}/agents',
  tags: ['Environment Variables'],
  summary: 'List agents that use this environment variable',
  middleware: [adminAuth] as const,
  request: {
    params: z.object({ id: EnvVarId }),
  },
  responses: {
    200: {
      description: 'List of agents using this environment variable',
      content: { 'application/json': { schema: z.array(AgentRef) } },
    },
    404: {
      description: 'Environment variable not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const app = new OpenAPIHono();

// POST / — Create env var
app.openapi(createEnvVarRoute, async (c) => {
  const { key, value, description } = c.req.valid('json');
  const now = Date.now();

  const encryptedValue = encrypt(value);
  const id = uuid();

  try {
    await db.insert(envVars).values({
      id,
      key,
      encryptedValue,
      description: description ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: `Environment variable with key "${key}" already exists` }, 409);
    }
    throw err;
  }

  return c.json({ id, key, description: description ?? null, createdAt: now }, 201);
});

// GET / — List env vars
app.openapi(listEnvVarsRoute, async (c) => {
  const rows = await db
    .select({
      id: envVars.id,
      key: envVars.key,
      description: envVars.description,
      createdAt: envVars.createdAt,
      updatedAt: envVars.updatedAt,
    })
    .from(envVars);

  return c.json(rows, 200);
});

// PATCH /:id — Update env var
app.openapi(updateEnvVarRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');

  // Check existence
  const [existing] = await db
    .select()
    .from(envVars)
    .where(eq(envVars.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Environment variable not found' }, 404);
  }

  const updates: Record<string, unknown> = {
    updatedAt: Date.now(),
  };

  if (body.value !== undefined) {
    updates.encryptedValue = encrypt(body.value);
  }

  if (body.description !== undefined) {
    updates.description = body.description;
  }

  await db.update(envVars).set(updates).where(eq(envVars.id, id));

  // Fetch the updated row to return accurate data
  const [updated] = await db
    .select({
      id: envVars.id,
      key: envVars.key,
      description: envVars.description,
      updatedAt: envVars.updatedAt,
    })
    .from(envVars)
    .where(eq(envVars.id, id))
    .limit(1);

  return c.json(updated, 200);
});

// DELETE /:id — Delete env var (cascade handled by FK constraints)
app.openapi(deleteEnvVarRoute, async (c) => {
  const { id } = c.req.valid('param');

  // Check existence
  const [existing] = await db
    .select({ id: envVars.id })
    .from(envVars)
    .where(eq(envVars.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Environment variable not found' }, 404);
  }

  // Delete from junction table first, then the env var itself
  await db.delete(agentEnvVars).where(eq(agentEnvVars.envVarId, id));
  await db.delete(envVars).where(eq(envVars.id, id));

  return c.body(null, 204);
});

// GET /:id/agents — Reverse lookup: which agents use this env var
app.openapi(listEnvVarAgentsRoute, async (c) => {
  const { id } = c.req.valid('param');

  // Check that the env var exists
  const [existing] = await db
    .select({ id: envVars.id })
    .from(envVars)
    .where(eq(envVars.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Environment variable not found' }, 404);
  }

  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
    })
    .from(agentEnvVars)
    .innerJoin(agents, eq(agentEnvVars.agentId, agents.id))
    .where(eq(agentEnvVars.envVarId, id));

  return c.json(rows, 200);
});

export default app;

```

## src/routes/permissions.ts
```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and } from 'drizzle-orm';
import { db, agents, skills, envVars, agentSkills, agentEnvVars } from '../db/index.js';
import { adminAuth } from '../services/auth.js';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const AgentIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Agent ID' }),
});

const AgentIdSkillIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Agent ID' }),
  skillId: z.string().openapi({ param: { name: 'skillId', in: 'path' }, description: 'Skill ID' }),
});

const AgentIdEnvVarIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Agent ID' }),
  envVarId: z.string().openapi({ param: { name: 'envVarId', in: 'path' }, description: 'Env var ID' }),
});

const SkillNameParam = z.object({
  name: z.string().openapi({ param: { name: 'name', in: 'path' }, description: 'Skill name' }),
});

const SkillIdsBody = z.object({
  skillIds: z.array(z.string()),
}).openapi('SetSkillsBody');

const EnvVarIdsBody = z.object({
  envVarIds: z.array(z.string()),
}).openapi('SetEnvVarsBody');

const GrantedResponse = z.object({
  granted: z.number(),
}).openapi('GrantedResponse');

const PermissionsResponse = z.object({
  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
  })),
  envVars: z.array(z.object({
    id: z.string(),
    key: z.string(),
    description: z.string().nullable(),
  })),
}).openapi('PermissionsResponse');

const AgentListResponse = z.array(z.object({
  id: z.string(),
  name: z.string(),
})).openapi('AgentListResponse');

const ErrorResponse = z.object({
  error: z.string(),
}).openapi('ErrorResponse');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const setSkillsRoute = createRoute({
  method: 'put',
  path: '/{id}/skills',
  tags: ['Permissions'],
  summary: "Set an agent's granted skills (full replace)",
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdParam,
    body: { content: { 'application/json': { schema: SkillIdsBody } } },
  },
  responses: {
    200: { description: 'Skills granted', content: { 'application/json': { schema: GrantedResponse } } },
    404: { description: 'Agent not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

const setEnvVarsRoute = createRoute({
  method: 'put',
  path: '/{id}/env-vars',
  tags: ['Permissions'],
  summary: "Set an agent's granted env vars (full replace)",
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdParam,
    body: { content: { 'application/json': { schema: EnvVarIdsBody } } },
  },
  responses: {
    200: { description: 'Env vars granted', content: { 'application/json': { schema: GrantedResponse } } },
    404: { description: 'Agent not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

const getPermissionsRoute = createRoute({
  method: 'get',
  path: '/{id}/permissions',
  tags: ['Permissions'],
  summary: "View an agent's full permission set",
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdParam,
  },
  responses: {
    200: { description: 'Permission set', content: { 'application/json': { schema: PermissionsResponse } } },
    404: { description: 'Agent not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

const grantSkillRoute = createRoute({
  method: 'post',
  path: '/{id}/skills/{skillId}',
  tags: ['Permissions'],
  summary: 'Grant a single skill to an agent',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdSkillIdParam,
  },
  responses: {
    204: { description: 'Skill granted' },
  },
});

const revokeSkillRoute = createRoute({
  method: 'delete',
  path: '/{id}/skills/{skillId}',
  tags: ['Permissions'],
  summary: 'Revoke a single skill from an agent',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdSkillIdParam,
  },
  responses: {
    204: { description: 'Skill revoked' },
  },
});

const grantEnvVarRoute = createRoute({
  method: 'post',
  path: '/{id}/env-vars/{envVarId}',
  tags: ['Permissions'],
  summary: 'Grant a single env var to an agent',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdEnvVarIdParam,
  },
  responses: {
    204: { description: 'Env var granted' },
  },
});

const revokeEnvVarRoute = createRoute({
  method: 'delete',
  path: '/{id}/env-vars/{envVarId}',
  tags: ['Permissions'],
  summary: 'Revoke a single env var from an agent',
  middleware: [adminAuth] as const,
  request: {
    params: AgentIdEnvVarIdParam,
  },
  responses: {
    204: { description: 'Env var revoked' },
  },
});

const agentsBySkillRoute = createRoute({
  method: 'get',
  path: '/skills/{name}/agents',
  tags: ['Permissions'],
  summary: 'List agents that have a specific skill',
  middleware: [adminAuth] as const,
  request: {
    params: SkillNameParam,
  },
  responses: {
    200: { description: 'List of agents', content: { 'application/json': { schema: AgentListResponse } } },
    404: { description: 'Skill not found', content: { 'application/json': { schema: ErrorResponse } } },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const app = new OpenAPIHono();

// 1. PUT /:id/skills — Set agent's granted skills (full replace)
app.openapi(setSkillsRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { skillIds } = c.req.valid('json');

  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  await db.delete(agentSkills).where(eq(agentSkills.agentId, id));

  if (skillIds.length > 0) {
    await db.insert(agentSkills).values(
      skillIds.map((skillId) => ({ agentId: id, skillId })),
    );
  }

  return c.json({ granted: skillIds.length }, 200);
});

// 2. PUT /:id/env-vars — Set agent's granted env vars (full replace)
app.openapi(setEnvVarsRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { envVarIds } = c.req.valid('json');

  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  await db.delete(agentEnvVars).where(eq(agentEnvVars.agentId, id));

  if (envVarIds.length > 0) {
    await db.insert(agentEnvVars).values(
      envVarIds.map((envVarId) => ({ agentId: id, envVarId })),
    );
  }

  return c.json({ granted: envVarIds.length }, 200);
});

// 3. GET /:id/permissions — View agent's full permission set
app.openapi(getPermissionsRoute, async (c) => {
  const { id } = c.req.valid('param');

  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const grantedSkills = await db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, id));

  const grantedEnvVars = await db
    .select({
      id: envVars.id,
      key: envVars.key,
      description: envVars.description,
    })
    .from(agentEnvVars)
    .innerJoin(envVars, eq(agentEnvVars.envVarId, envVars.id))
    .where(eq(agentEnvVars.agentId, id));

  return c.json({ skills: grantedSkills, envVars: grantedEnvVars }, 200);
});

// 4. POST /:id/skills/:skillId — Grant a single skill
app.openapi(grantSkillRoute, async (c) => {
  const { id, skillId } = c.req.valid('param');

  await db
    .insert(agentSkills)
    .values({ agentId: id, skillId })
    .onConflictDoNothing();

  return c.body(null, 204);
});

// 5. DELETE /:id/skills/:skillId — Revoke a single skill
app.openapi(revokeSkillRoute, async (c) => {
  const { id, skillId } = c.req.valid('param');

  await db
    .delete(agentSkills)
    .where(and(eq(agentSkills.agentId, id), eq(agentSkills.skillId, skillId)));

  return c.body(null, 204);
});

// 6. POST /:id/env-vars/:envVarId — Grant a single env var
app.openapi(grantEnvVarRoute, async (c) => {
  const { id, envVarId } = c.req.valid('param');

  await db
    .insert(agentEnvVars)
    .values({ agentId: id, envVarId })
    .onConflictDoNothing();

  return c.body(null, 204);
});

// 7. DELETE /:id/env-vars/:envVarId — Revoke a single env var
app.openapi(revokeEnvVarRoute, async (c) => {
  const { id, envVarId } = c.req.valid('param');

  await db
    .delete(agentEnvVars)
    .where(and(eq(agentEnvVars.agentId, id), eq(agentEnvVars.envVarId, envVarId)));

  return c.body(null, 204);
});

// 8. GET /skills/:name/agents — Which agents have this skill
app.openapi(agentsBySkillRoute, async (c) => {
  const { name } = c.req.valid('param');

  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.name, name))
    .limit(1);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  const result = await db
    .select({
      id: agents.id,
      name: agents.name,
    })
    .from(agentSkills)
    .innerJoin(agents, eq(agentSkills.agentId, agents.id))
    .where(eq(agentSkills.skillId, skill.id));

  return c.json(result, 200);
});

export default app;

```

## src/routes/skills-admin.ts
```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, skills } from '../db/index.js';
import { adminAuth } from '../services/auth.js';
import { createSkillsManager } from '../services/discovery.js';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const SkillListItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  scripts: z.array(z.string()),
  parseError: z.string().nullable(),
  updatedAt: z.number(),
}).openapi('SkillListItem');

const DiscoveryError = z.object({
  dir: z.string(),
  error: z.string(),
});

const SkillListResponse = z.object({
  skills: z.array(SkillListItem),
  errors: z.array(DiscoveryError),
}).openapi('SkillListResponse');

const ReloadResponse = z.object({
  total: z.number(),
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
  errors: z.array(DiscoveryError),
}).openapi('ReloadResponse');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSkillsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin'],
  summary: 'List all skills with metadata and parse errors',
  middleware: [adminAuth] as const,
  responses: {
    200: {
      description: 'All discovered skills and any parse errors',
      content: { 'application/json': { schema: SkillListResponse } },
    },
  },
});

const reloadSkillsRoute = createRoute({
  method: 'post',
  path: '/reload',
  tags: ['Admin'],
  summary: 'Rescan skills directory and sync to database',
  middleware: [adminAuth] as const,
  responses: {
    200: {
      description: 'Reload summary with counts of added, updated, and removed skills',
      content: { 'application/json': { schema: ReloadResponse } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSkillsAdminRoutes(
  skillsManager: ReturnType<typeof createSkillsManager>,
) {
  const app = new OpenAPIHono();

  // GET / — List all skills
  app.openapi(listSkillsRoute, async (c) => {
    const allSkills = await skillsManager.getAllSkills();
    const errors = skillsManager.getErrors();

    // Fetch DB IDs so the admin UI can reference them for permissions
    const dbRows = await db
      .select({ id: skills.id, name: skills.name, updatedAt: skills.updatedAt })
      .from(skills);
    const dbByName = new Map(dbRows.map((r) => [r.name, r]));

    const items = allSkills.map((skill) => ({
      id: dbByName.get(skill.name)?.id ?? '',
      name: skill.name,
      description: skill.description,
      scripts: skill.scripts,
      parseError: skill.parseError ?? null,
      updatedAt: dbByName.get(skill.name)?.updatedAt ?? Date.now(),
    }));

    return c.json({ skills: items, errors }, 200);
  });

  // POST /reload — Rescan skills directory and sync to DB
  app.openapi(reloadSkillsRoute, async (c) => {
    const result = await skillsManager.reload();
    const now = Date.now();

    // Fetch existing skills from DB for comparison
    const existingRows = await db
      .select({ id: skills.id, name: skills.name })
      .from(skills);

    const existingByName = new Map(
      existingRows.map((row) => [row.name, row.id]),
    );

    const discoveredNames = new Set(result.skills.map((s) => s.name));

    let added = 0;
    let updated = 0;

    // Upsert each discovered skill
    for (const skill of result.skills) {
      const scriptsJson = JSON.stringify(skill.scripts);
      const wasExisting = existingByName.has(skill.name);

      await db
        .insert(skills)
        .values({
          id: wasExisting ? existingByName.get(skill.name)! : uuid(),
          name: skill.name,
          description: skill.description,
          dirPath: skill.dirPath,
          scripts: scriptsJson,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skills.name,
          set: {
            description: skill.description,
            dirPath: skill.dirPath,
            scripts: scriptsJson,
            updatedAt: now,
          },
        });

      if (wasExisting) {
        updated++;
      } else {
        added++;
      }
    }

    // Remove skills from DB that are no longer on disk
    let removed = 0;
    for (const [name, id] of existingByName) {
      if (!discoveredNames.has(name)) {
        await db.delete(skills).where(eq(skills.id, id));
        removed++;
      }
    }

    return c.json(
      {
        total: result.skills.length,
        added,
        updated,
        removed,
        errors: result.errors,
      },
      200,
    );
  });

  return app;
}

```

## src/routes/execution-logs.ts
```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, desc, and, type SQL } from 'drizzle-orm';
import { db, executionLogs, agents } from '../db/index.js';
import { adminAuth } from '../services/auth.js';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const ExecutionLogQueryParams = z.object({
  agentId: z.string().optional().openapi({ description: 'Filter by agent ID' }),
  skillName: z.string().optional().openapi({ description: 'Filter by skill name' }),
  limit: z
    .string()
    .optional()
    .default('50')
    .openapi({ description: 'Max results to return (default 50, max 200)' }),
  offset: z
    .string()
    .optional()
    .default('0')
    .openapi({ description: 'Number of results to skip (default 0)' }),
});

const ExecutionLogItem = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  skillName: z.string(),
  script: z.string(),
  args: z.string().nullable(),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().nullable(),
  createdAt: z.number(),
}).openapi('ExecutionLogItem');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listExecutionLogsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Execution Logs'],
  summary: 'List recent skill executions',
  middleware: [adminAuth] as const,
  request: {
    query: ExecutionLogQueryParams,
  },
  responses: {
    200: {
      description: 'Array of execution log entries',
      content: { 'application/json': { schema: z.array(ExecutionLogItem) } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const app = new OpenAPIHono();

// GET / — List recent executions
app.openapi(listExecutionLogsRoute, async (c) => {
  const query = c.req.valid('query');

  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const offset = Math.max(Number(query.offset) || 0, 0);

  // Build filter conditions
  const conditions: SQL[] = [];

  if (query.agentId) {
    conditions.push(eq(executionLogs.agentId, query.agentId));
  }

  if (query.skillName) {
    conditions.push(eq(executionLogs.skillName, query.skillName));
  }

  const whereClause = conditions.length > 0
    ? conditions.length === 1
      ? conditions[0]
      : and(...conditions)
    : undefined;

  const rows = await db
    .select({
      id: executionLogs.id,
      agentId: executionLogs.agentId,
      agentName: agents.name,
      skillName: executionLogs.skillName,
      script: executionLogs.script,
      args: executionLogs.args,
      exitCode: executionLogs.exitCode,
      error: executionLogs.error,
      durationMs: executionLogs.durationMs,
      createdAt: executionLogs.createdAt,
    })
    .from(executionLogs)
    .leftJoin(agents, eq(executionLogs.agentId, agents.id))
    .where(whereClause)
    .orderBy(desc(executionLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(rows, 200);
});

export default app;

```

## src/app.ts
```typescript
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { apiReference } from '@scalar/hono-api-reference';

import { createAgentFacingRoutes } from './routes/agent-facing.js';
import agentsRoutes from './routes/agents.js';
import envVarsRoutes from './routes/env-vars.js';
import permissionsRoutes from './routes/permissions.js';
import { createSkillsAdminRoutes } from './routes/skills-admin.js';
import executionLogsRoutes from './routes/execution-logs.js';
import { createSkillsManager } from './services/discovery.js';

// ---------------------------------------------------------------------------
// Create app
// ---------------------------------------------------------------------------

export function createApp(skillsDir: string) {
  const app = new OpenAPIHono();
  const skillsManager = createSkillsManager(skillsDir);

  // -----------------------------------------------------------------------
  // Middleware
  // -----------------------------------------------------------------------

  app.use('*', cors());

  // TODO: Add rate limiting middleware

  // -----------------------------------------------------------------------
  // Static files
  // -----------------------------------------------------------------------

  app.use('/public/*', serveStatic({ root: './' }));

  // -----------------------------------------------------------------------
  // Serve the agent integration SKILL.md (unauthenticated)
  // -----------------------------------------------------------------------

  app.get('/api/v1/skill.md', serveStatic({ path: './public/skill.md' }));

  // -----------------------------------------------------------------------
  // Route groups
  // -----------------------------------------------------------------------

  // Agent-facing routes (requires agent API key)
  app.route('/api/v1/skills', createAgentFacingRoutes(skillsManager));

  // Management routes (requires admin API key)
  app.route('/api/v1/agents', agentsRoutes);
  app.route('/api/v1/env-vars', envVarsRoutes);
  app.route('/api/v1/agents', permissionsRoutes);

  // Admin routes (requires admin API key)
  app.route('/api/v1/admin/skills', createSkillsAdminRoutes(skillsManager));
  app.route('/api/v1/execution-logs', executionLogsRoutes);

  // -----------------------------------------------------------------------
  // OpenAPI doc & Scalar API reference
  // -----------------------------------------------------------------------

  app.doc('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Skills Server',
      version: '1.0.0',
      description: 'Centralized skills server for AI agents',
    },
  });

  app.get(
    '/api/v1/docs',
    apiReference({
      spec: {
        url: '/api/v1/openapi.json',
      },
    } as Record<string, unknown>),
  );

  // -----------------------------------------------------------------------
  // Catch-all — serve admin UI (index.html)
  // -----------------------------------------------------------------------

  app.get('/', serveStatic({ path: './public/index.html' }));

  return { app, skillsManager };
}

```

## src/index.ts
```typescript
import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import { createApp } from './app.js';
import { db, skills } from './db/index.js';

const port = Number(process.env.PORT) || 3000;
const skillsDir = resolve(process.env.SKILLS_DIR || './skills');

console.log('Starting skills server...');
console.log(`  Port:       ${port}`);
console.log(`  Skills dir: ${skillsDir}`);

// ---------------------------------------------------------------------------
// Create app and initialize
// ---------------------------------------------------------------------------

const { app, skillsManager } = createApp(skillsDir);

// Initial skill discovery — scan directory and sync to DB
async function initialize() {
  const result = await skillsManager.reload();
  const now = Date.now();

  for (const skill of result.skills) {
    await db
      .insert(skills)
      .values({
        id: uuid(),
        name: skill.name,
        description: skill.description,
        dirPath: skill.dirPath,
        scripts: JSON.stringify(skill.scripts),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: skills.name,
        set: {
          description: skill.description,
          dirPath: skill.dirPath,
          scripts: JSON.stringify(skill.scripts),
          updatedAt: now,
        },
      });
  }

  console.log(`  Skills:     ${result.skills.length} discovered`);
  if (result.errors.length > 0) {
    console.log(`  Errors:     ${result.errors.length} skills failed to parse`);
    for (const err of result.errors) {
      console.log(`    - ${err.dir}: ${err.error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

initialize()
  .then(() => {
    serve({ fetch: app.fetch, port });
    console.log(`Skills server running on http://localhost:${port}`);
    console.log(`  API docs:   http://localhost:${port}/api/v1/docs`);
    console.log(`  Admin UI:   http://localhost:${port}/`);
  })
  .catch((err) => {
    console.error('Failed to initialize:', err);
    process.exit(1);
  });

```

## public/skill.md
```markdown
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

```

## public/index.html (first 100 lines)
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skills Server Admin</title>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    :root {
      --bg: #0f0f0f;
      --card: #1a1a1a;
      --border: #2a2a2a;
      --text: #e0e0e0;
      --text-dim: #888;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --error: #ef4444;
      --success: #22c55e;
      --warning: #f59e0b;
      --radius: 8px;
      --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 20px;
    }

    /* Header */
    header {
      background: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 16px 0;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header-title {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.3px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .header-title .icon {
      width: 24px;
      height: 24px;
      background: var(--accent);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      color: white;
      font-weight: 700;
    }

    .btn {
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--card);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
      white-space: nowrap;
    }

    .btn:hover {
      border-color: #444;
      background: #222;
    }

    .btn:disabled {

```

## package.json
```json
{
  "name": "skills-server",
  "version": "1.0.0",
  "type": "module",
  "description": "Centralized skills server for AI agents",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/index.ts",
    "build": "tsc",
    "start": "node --env-file=.env dist/index.js",
    "db:push": "drizzle-kit push",
    "db:generate": "drizzle-kit generate"
  },
  "license": "MIT",
  "dependencies": {
    "@hono/node-server": "^1.19.9",
    "@hono/zod-openapi": "^1.2.1",
    "@scalar/hono-api-reference": "^0.9.40",
    "better-sqlite3": "^12.6.2",
    "drizzle-orm": "^0.45.1",
    "hono": "^4.11.8",
    "uuid": "^13.0.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/uuid": "^10.0.0",
    "drizzle-kit": "^0.31.8",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  }
}

```

## .env.example
```env
PORT=3000
SKILLS_DIR=./skills
ENCRYPTION_KEY=generate-a-64-char-hex-string
HMAC_SECRET=generate-a-64-char-hex-string
ADMIN_API_KEY=generate-a-secure-random-string

```

