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
    api_key_hash  TEXT NOT NULL UNIQUE,
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
