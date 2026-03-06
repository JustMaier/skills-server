import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// ─── Permission Levels ──────────────────────────────────────────────────────

export const PERMISSION_LEVELS = ["none", "execute", "maintain", "admin"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

// ─── Agents ──────────────────────────────────────────────────────────────────

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  permissionLevel: text("permission_level").notNull().default("none"),
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
  key: text("key").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  description: text("description"),
  ownerId: text("owner_id").references(() => agents.id, { onDelete: "cascade" }),
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
    permissionLevel: text("permission_level").notNull().default("execute"),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.skillId] })],
);

export type AgentSkill = typeof agentSkills.$inferSelect;
export type NewAgentSkill = typeof agentSkills.$inferInsert;

// ─── Skill <-> EnvVar (many-to-many) ────────────────────────────────────────

export const skillEnvVars = sqliteTable(
  "skill_env_vars",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    envVarId: text("env_var_id")
      .notNull()
      .references(() => envVars.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.skillId, table.envVarId] })],
);

export type SkillEnvVar = typeof skillEnvVars.$inferSelect;
export type NewSkillEnvVar = typeof skillEnvVars.$inferInsert;

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

// ─── Skill Registry (Git-backed skills) ─────────────────────────────────────

export const skillRegistry = sqliteTable("skill_registry", {
  id: text("id").primaryKey(),
  skillId: text("skill_id")
    .notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull().default("main"),
  subpath: text("subpath").notNull().default("/"),
  registeredBy: text("registered_by").references(() => agents.id, {
    onDelete: "set null",
  }),
  lastSynced: integer("last_synced"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type SkillRegistryEntry = typeof skillRegistry.$inferSelect;
export type NewSkillRegistryEntry = typeof skillRegistry.$inferInsert;

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
