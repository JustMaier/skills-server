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
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    api_key_hash     TEXT NOT NULL UNIQUE,
    permission_level TEXT NOT NULL DEFAULT 'none',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
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
    key             TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    description     TEXT,
    owner_id        TEXT REFERENCES agents(id) ON DELETE CASCADE,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id         TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    permission_level TEXT NOT NULL DEFAULT 'execute',
    PRIMARY KEY (agent_id, skill_id)
  );

  CREATE TABLE IF NOT EXISTS skill_env_vars (
    skill_id    TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    env_var_id  TEXT NOT NULL REFERENCES env_vars(id) ON DELETE CASCADE,
    PRIMARY KEY (skill_id, env_var_id)
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

  CREATE TABLE IF NOT EXISTS skill_registry (
    id             TEXT PRIMARY KEY,
    skill_id       TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    repo_url       TEXT NOT NULL,
    branch         TEXT NOT NULL DEFAULT 'main',
    subpath        TEXT NOT NULL DEFAULT '/',
    registered_by  TEXT REFERENCES agents(id) ON DELETE SET NULL,
    last_synced    INTEGER,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
`);

// ─── Idempotent migrations for existing databases ──────────────────────────

function migrateColumn(table: string, column: string, definition: string) {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already exists — ignore
  }
}

migrateColumn("agents", "permission_level", "TEXT NOT NULL DEFAULT 'none'");
migrateColumn("agent_skills", "permission_level", "TEXT NOT NULL DEFAULT 'execute'");
migrateColumn("env_vars", "owner_id", "TEXT REFERENCES agents(id) ON DELETE CASCADE");

// Replace UNIQUE(key) with UNIQUE(key, owner_id) on env_vars
try {
  sqlite.exec(`DROP INDEX IF EXISTS env_vars_key_unique`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS env_vars_key_owner ON env_vars(key, COALESCE(owner_id, ''))`);
} catch {
  // Index already exists or old index not found — ignore
}

// ─── Drizzle ORM instance ───────────────────────────────────────────────────

export const db = drizzle(sqlite, { schema });
