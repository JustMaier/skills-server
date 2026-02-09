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
