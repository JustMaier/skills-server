import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, inArray } from 'drizzle-orm';
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
    400: { description: 'Invalid skill IDs', content: { 'application/json': { schema: ErrorResponse } } },
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
    400: { description: 'Invalid env var IDs', content: { 'application/json': { schema: ErrorResponse } } },
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

  // Validate all skill IDs exist before modifying
  if (skillIds.length > 0) {
    const existing = await db.select({ id: skills.id }).from(skills).where(inArray(skills.id, skillIds));
    if (existing.length !== skillIds.length) {
      return c.json({ error: 'One or more skill IDs not found' }, 400);
    }
  }

  // Atomic replace: delete + insert in a transaction
  db.transaction((tx) => {
    tx.delete(agentSkills).where(eq(agentSkills.agentId, id)).run();
    if (skillIds.length > 0) {
      tx.insert(agentSkills).values(
        skillIds.map((skillId) => ({ agentId: id, skillId })),
      ).run();
    }
  });

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

  // Validate all env var IDs exist before modifying
  if (envVarIds.length > 0) {
    const existing = await db.select({ id: envVars.id }).from(envVars).where(inArray(envVars.id, envVarIds));
    if (existing.length !== envVarIds.length) {
      return c.json({ error: 'One or more env var IDs not found' }, 400);
    }
  }

  // Atomic replace: delete + insert in a transaction
  db.transaction((tx) => {
    tx.delete(agentEnvVars).where(eq(agentEnvVars.agentId, id)).run();
    if (envVarIds.length > 0) {
      tx.insert(agentEnvVars).values(
        envVarIds.map((envVarId) => ({ agentId: id, envVarId })),
      ).run();
    }
  });

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
