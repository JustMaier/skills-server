import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, agentSkills, skills, agentEnvVars, skillEnvVars, envVars, executionLogs } from '../db/index.js';
import { agentAuth, type AuthEnv } from '../services/auth.js';
import { createSkillsManager } from '../services/discovery.js';
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

  // ─── Shared helper: verify agent has access to a skill ──────────────────

  type SkillAccessError = { error: string; status: 403 | 404 };
  type SkillAccessOk = { skillRow: typeof skills.$inferSelect; skill: import('../services/discovery.js').SkillDefinition };

  async function requireSkillAccess(agentId: string, skillName: string): Promise<SkillAccessError | SkillAccessOk> {
    const [skillRow] = await db
      .select()
      .from(skills)
      .where(eq(skills.name, skillName))
      .limit(1);

    if (!skillRow) return { error: 'Skill not found', status: 404 };

    const [grant] = await db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillRow.id)))
      .limit(1);

    if (!grant) return { error: 'Not authorized to access this skill', status: 403 };

    const skill = await skillsManager.getSkill(skillName);
    if (!skill) return { error: 'Skill not found', status: 404 };

    return { skillRow, skill };
  }

  // ─── GET /:name — Get skill content ────────────────────────────────────────

  app.openapi(getSkillRoute, async (c) => {
    const agent = c.get('agent');
    const { name } = c.req.valid('param');

    const access = await requireSkillAccess(agent.id, name);
    if ('error' in access) return c.json({ error: access.error }, access.status);
    const { skill, skillRow } = access;

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

    const access = await requireSkillAccess(agent.id, name);
    if ('error' in access) return c.json({ error: access.error }, access.status);
    const { skill } = access;

    // Verify script is in the skill's discovered scripts whitelist
    if (!skill.scripts.includes(script)) {
      return c.json({ error: 'Script not allowed for this skill' }, 403);
    }

    // Gather env vars: intersection of agent grants AND skill requirements.
    // Strict: if the skill has no skill_env_vars entries, no env vars are injected.
    const grantedEnvVars = await db
      .select({
        key: envVars.key,
        encryptedValue: envVars.encryptedValue,
      })
      .from(agentEnvVars)
      .innerJoin(envVars, eq(agentEnvVars.envVarId, envVars.id))
      .innerJoin(skillEnvVars, and(
        eq(skillEnvVars.envVarId, envVars.id),
        eq(skillEnvVars.skillId, access.skillRow.id),
      ))
      .where(eq(agentEnvVars.agentId, agent.id));

    // Decrypt each env var into a plain key-value map
    const env: Record<string, string> = {};
    for (const row of grantedEnvVars) {
      try {
        env[row.key] = decrypt(row.encryptedValue);
      } catch {
        // Skip env vars that fail to decrypt (e.g. key rotation)
      }
    }

    // Execute the script
    const result = await executeScript({
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
