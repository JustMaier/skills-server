import { eq, and } from "drizzle-orm";
import { db, agents, agentSkills, skills, type PermissionLevel, PERMISSION_LEVELS } from "../db/index.js";

// ---------------------------------------------------------------------------
// Rank comparison
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<PermissionLevel, number> = {
  none: 0,
  execute: 1,
  maintain: 2,
  admin: 3,
};

/** Check if `effective` meets or exceeds `required`. */
export function hasPermission(
  effective: PermissionLevel,
  required: PermissionLevel,
): boolean {
  return LEVEL_RANK[effective] >= LEVEL_RANK[required];
}

/** Return the higher of two permission levels. */
export function maxLevel(
  a: PermissionLevel,
  b: PermissionLevel,
): PermissionLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** Validate a string is a valid PermissionLevel. */
export function isValidPermissionLevel(
  value: string,
): value is PermissionLevel {
  return (PERMISSION_LEVELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Effective permission resolution
// ---------------------------------------------------------------------------

/**
 * Compute an agent's effective permission for a specific skill.
 *
 * Effective = max(agent.permissionLevel, agentSkills.permissionLevel for this skill)
 *
 * If the agent has no per-skill grant, only the agent-wide level applies.
 */
export async function getEffectivePermission(
  agentId: string,
  skillId: string,
): Promise<PermissionLevel> {
  const [agent] = await db
    .select({ permissionLevel: agents.permissionLevel })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) return "none";

  const agentLevel = agent.permissionLevel as PermissionLevel;

  const [grant] = await db
    .select({ permissionLevel: agentSkills.permissionLevel })
    .from(agentSkills)
    .where(
      and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)),
    )
    .limit(1);

  if (!grant) return agentLevel;

  return maxLevel(agentLevel, grant.permissionLevel as PermissionLevel);
}

// ---------------------------------------------------------------------------
// Permission check with skill lookup
// ---------------------------------------------------------------------------

export type PermissionError = { error: string; status: 403 | 404 };
export type PermissionOk = {
  skillRow: typeof skills.$inferSelect;
  effectiveLevel: PermissionLevel;
};

/**
 * Look up a skill by name and verify the agent meets the required permission.
 *
 * For agents with agent-wide `execute` or higher, per-skill grants are not
 * required for access — the agent-wide level provides blanket access.
 */
export async function requirePermission(
  agentId: string,
  skillName: string,
  required: PermissionLevel,
): Promise<PermissionError | PermissionOk> {
  const [skillRow] = await db
    .select()
    .from(skills)
    .where(eq(skills.name, skillName))
    .limit(1);

  if (!skillRow) return { error: "Skill not found", status: 404 };

  const effective = await getEffectivePermission(agentId, skillRow.id);

  if (!hasPermission(effective, required)) {
    return { error: "Not authorized to access this skill", status: 403 };
  }

  return { skillRow, effectiveLevel: effective };
}
