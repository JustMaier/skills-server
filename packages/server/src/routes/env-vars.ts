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
