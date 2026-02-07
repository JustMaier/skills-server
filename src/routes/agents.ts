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
