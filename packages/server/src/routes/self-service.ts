import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, envVars, agentEnvVars, skillEnvVars, agentSkills } from '../db/index.js';
import { agentAuth, type AuthEnv } from '../services/auth.js';
import { encrypt } from '../services/crypto.js';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const EnvVarId = z.string().openapi({ description: 'Environment variable ID', example: 'a1b2c3d4-...' });
const SkillId = z.string().openapi({ description: 'Skill ID', example: 'a1b2c3d4-...' });

const SelfEnvVarListItem = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).openapi('SelfEnvVarListItem');

const SelfEnvVarCreated = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  createdAt: z.number(),
}).openapi('SelfEnvVarCreated');

const SelfEnvVarUpdated = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  updatedAt: z.number(),
}).openapi('SelfEnvVarUpdated');

const ErrorResponse = z.object({
  error: z.string(),
}).openapi('SelfServiceErrorResponse');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listMyEnvVarsRoute = createRoute({
  method: 'get',
  path: '/env-vars',
  tags: ['Self-Service'],
  summary: 'List my environment variables',
  middleware: [agentAuth] as const,
  responses: {
    200: {
      description: 'List of environment variables owned by the authenticated agent',
      content: { 'application/json': { schema: z.array(SelfEnvVarListItem) } },
    },
  },
});

const createMyEnvVarRoute = createRoute({
  method: 'post',
  path: '/env-vars',
  tags: ['Self-Service'],
  summary: 'Create an environment variable owned by me',
  middleware: [agentAuth] as const,
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
      content: { 'application/json': { schema: SelfEnvVarCreated } },
    },
    409: {
      description: 'Key already exists for this agent',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const updateMyEnvVarRoute = createRoute({
  method: 'patch',
  path: '/env-vars/{id}',
  tags: ['Self-Service'],
  summary: 'Update my environment variable',
  middleware: [agentAuth] as const,
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
      content: { 'application/json': { schema: SelfEnvVarUpdated } },
    },
    403: {
      description: 'Not owned by this agent',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Environment variable not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const deleteMyEnvVarRoute = createRoute({
  method: 'delete',
  path: '/env-vars/{id}',
  tags: ['Self-Service'],
  summary: 'Delete my environment variable',
  middleware: [agentAuth] as const,
  request: {
    params: z.object({ id: EnvVarId }),
  },
  responses: {
    204: { description: 'Environment variable deleted' },
    403: {
      description: 'Not owned by this agent',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Environment variable not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const linkEnvVarToSkillRoute = createRoute({
  method: 'post',
  path: '/skills/{skillId}/env-vars/{envVarId}',
  tags: ['Self-Service'],
  summary: 'Link my env var to a skill',
  middleware: [agentAuth] as const,
  request: {
    params: z.object({ skillId: SkillId, envVarId: EnvVarId }),
  },
  responses: {
    204: { description: 'Env var linked to skill' },
    403: {
      description: 'Not authorized',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Env var not found or not owned by this agent',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const unlinkEnvVarFromSkillRoute = createRoute({
  method: 'delete',
  path: '/skills/{skillId}/env-vars/{envVarId}',
  tags: ['Self-Service'],
  summary: 'Unlink my env var from a skill',
  middleware: [agentAuth] as const,
  request: {
    params: z.object({ skillId: SkillId, envVarId: EnvVarId }),
  },
  responses: {
    204: { description: 'Env var unlinked from skill' },
    403: {
      description: 'Not authorized',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Env var not found or not owned by this agent',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXECUTE_OR_ABOVE = ['execute', 'maintain', 'admin'];

/**
 * Check whether the authenticated agent has execute-level access to a skill,
 * either via the agentSkills junction or via a global permissionLevel.
 */
async function hasSkillAccess(agentId: string, agentPermissionLevel: string, skillId: string): Promise<boolean> {
  // Global permission level grants access to all skills
  if (EXECUTE_OR_ABOVE.includes(agentPermissionLevel)) {
    return true;
  }

  // Check per-skill grant
  const [grant] = await db
    .select({ agentId: agentSkills.agentId })
    .from(agentSkills)
    .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)))
    .limit(1);

  return !!grant;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const app = new OpenAPIHono<AuthEnv>();

// GET /env-vars — List my env vars
app.openapi(listMyEnvVarsRoute, async (c) => {
  const agent = c.get('agent');

  const rows = await db
    .select({
      id: envVars.id,
      key: envVars.key,
      description: envVars.description,
      createdAt: envVars.createdAt,
      updatedAt: envVars.updatedAt,
    })
    .from(envVars)
    .where(eq(envVars.ownerId, agent.id));

  return c.json(rows, 200);
});

// POST /env-vars — Create env var owned by me
app.openapi(createMyEnvVarRoute, async (c) => {
  const agent = c.get('agent');
  const { key, value, description } = c.req.valid('json');
  const now = Date.now();

  const encryptedValue = encrypt(value);
  const id = uuid();

  try {
    // Insert env var and auto-grant in a transaction
    db.transaction((tx) => {
      tx.insert(envVars).values({
        id,
        key,
        encryptedValue,
        description: description ?? null,
        ownerId: agent.id,
        createdAt: now,
        updatedAt: now,
      }).run();

      tx.insert(agentEnvVars).values({
        agentId: agent.id,
        envVarId: id,
      }).run();
    });
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: `Environment variable with key "${key}" already exists` }, 409);
    }
    throw err;
  }

  return c.json({ id, key, description: description ?? null, createdAt: now }, 201);
});

// PATCH /env-vars/:id — Update my env var
app.openapi(updateMyEnvVarRoute, async (c) => {
  const agent = c.get('agent');
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');

  const [existing] = await db
    .select()
    .from(envVars)
    .where(eq(envVars.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Environment variable not found' }, 404);
  }

  if (existing.ownerId !== agent.id) {
    return c.json({ error: 'Not owned by this agent' }, 403);
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

// DELETE /env-vars/:id — Delete my env var
app.openapi(deleteMyEnvVarRoute, async (c) => {
  const agent = c.get('agent');
  const { id } = c.req.valid('param');

  const [existing] = await db
    .select({ id: envVars.id, ownerId: envVars.ownerId })
    .from(envVars)
    .where(eq(envVars.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Environment variable not found' }, 404);
  }

  if (existing.ownerId !== agent.id) {
    return c.json({ error: 'Not owned by this agent' }, 403);
  }

  // Delete from junction tables first, then the env var itself
  db.transaction((tx) => {
    tx.delete(agentEnvVars).where(eq(agentEnvVars.envVarId, id)).run();
    tx.delete(skillEnvVars).where(eq(skillEnvVars.envVarId, id)).run();
    tx.delete(envVars).where(eq(envVars.id, id)).run();
  });

  return c.body(null, 204);
});

// POST /skills/:skillId/env-vars/:envVarId — Link my env var to a skill
app.openapi(linkEnvVarToSkillRoute, async (c) => {
  const agent = c.get('agent');
  const { skillId, envVarId } = c.req.valid('param');

  // Verify ownership of env var
  const [envVar] = await db
    .select({ id: envVars.id, ownerId: envVars.ownerId })
    .from(envVars)
    .where(eq(envVars.id, envVarId))
    .limit(1);

  if (!envVar || envVar.ownerId !== agent.id) {
    return c.json({ error: 'Environment variable not found or not owned by this agent' }, 404);
  }

  // Verify skill access
  const canAccess = await hasSkillAccess(agent.id, agent.permissionLevel, skillId);
  if (!canAccess) {
    return c.json({ error: 'No execute access to this skill' }, 403);
  }

  await db
    .insert(skillEnvVars)
    .values({ skillId, envVarId })
    .onConflictDoNothing();

  return c.body(null, 204);
});

// DELETE /skills/:skillId/env-vars/:envVarId — Unlink my env var from a skill
app.openapi(unlinkEnvVarFromSkillRoute, async (c) => {
  const agent = c.get('agent');
  const { skillId, envVarId } = c.req.valid('param');

  // Verify ownership of env var
  const [envVar] = await db
    .select({ id: envVars.id, ownerId: envVars.ownerId })
    .from(envVars)
    .where(eq(envVars.id, envVarId))
    .limit(1);

  if (!envVar || envVar.ownerId !== agent.id) {
    return c.json({ error: 'Environment variable not found or not owned by this agent' }, 404);
  }

  // Verify skill access
  const canAccess = await hasSkillAccess(agent.id, agent.permissionLevel, skillId);
  if (!canAccess) {
    return c.json({ error: 'No execute access to this skill' }, 403);
  }

  await db
    .delete(skillEnvVars)
    .where(and(eq(skillEnvVars.skillId, skillId), eq(skillEnvVars.envVarId, envVarId)));

  return c.body(null, 204);
});

export default app;
