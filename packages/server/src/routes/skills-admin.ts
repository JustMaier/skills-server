import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, skills, skillEnvVars, envVars } from '../db/index.js';
import { adminAuth } from '../services/auth.js';
import { createSkillsManager } from '../services/discovery.js';

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const SkillListItem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  scripts: z.array(z.string()),
  parseError: z.string().nullable(),
  updatedAt: z.number(),
}).openapi('SkillListItem');

const DiscoveryError = z.object({
  dir: z.string(),
  error: z.string(),
});

const SkillListResponse = z.object({
  skills: z.array(SkillListItem),
  errors: z.array(DiscoveryError),
}).openapi('SkillListResponse');

const ReloadResponse = z.object({
  total: z.number(),
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
  errors: z.array(DiscoveryError),
}).openapi('ReloadResponse');

const SkillIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Skill ID' }),
});

const SkillIdEnvVarIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, description: 'Skill ID' }),
  envVarId: z.string().openapi({ param: { name: 'envVarId', in: 'path' }, description: 'Env var ID' }),
});

const EnvVarIdsBody = z.object({
  envVarIds: z.array(z.string()),
}).openapi('SkillEnvVarsBody');

const SkillEnvVarItem = z.object({
  id: z.string(),
  key: z.string(),
  description: z.string().nullable(),
});

const SkillEnvVarsResponse = z.object({
  envVars: z.array(SkillEnvVarItem),
}).openapi('SkillEnvVarsResponse');

const GrantedCountResponse = z.object({
  granted: z.number(),
}).openapi('SkillEnvVarGrantedResponse');

const ErrorResponse = z.object({
  error: z.string(),
}).openapi('SkillAdminErrorResponse');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listSkillsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin'],
  summary: 'List all skills with metadata and parse errors',
  middleware: [adminAuth] as const,
  responses: {
    200: {
      description: 'All discovered skills and any parse errors',
      content: { 'application/json': { schema: SkillListResponse } },
    },
  },
});

const reloadSkillsRoute = createRoute({
  method: 'post',
  path: '/reload',
  tags: ['Admin'],
  summary: 'Rescan skills directory and sync to database',
  middleware: [adminAuth] as const,
  responses: {
    200: {
      description: 'Reload summary with counts of added, updated, and removed skills',
      content: { 'application/json': { schema: ReloadResponse } },
    },
  },
});

const getSkillEnvVarsRoute = createRoute({
  method: 'get',
  path: '/{id}/env-vars',
  tags: ['Admin'],
  summary: "List a skill's required environment variables",
  middleware: [adminAuth] as const,
  request: { params: SkillIdParam },
  responses: {
    200: {
      description: 'Env vars linked to this skill',
      content: { 'application/json': { schema: SkillEnvVarsResponse } },
    },
    404: {
      description: 'Skill not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const setSkillEnvVarsRoute = createRoute({
  method: 'put',
  path: '/{id}/env-vars',
  tags: ['Admin'],
  summary: "Set a skill's required env vars (full replace)",
  middleware: [adminAuth] as const,
  request: {
    params: SkillIdParam,
    body: { content: { 'application/json': { schema: EnvVarIdsBody } } },
  },
  responses: {
    200: {
      description: 'Env vars set',
      content: { 'application/json': { schema: GrantedCountResponse } },
    },
    400: {
      description: 'Invalid env var IDs',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Skill not found',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const grantSkillEnvVarRoute = createRoute({
  method: 'post',
  path: '/{id}/env-vars/{envVarId}',
  tags: ['Admin'],
  summary: 'Link a single env var to a skill',
  middleware: [adminAuth] as const,
  request: { params: SkillIdEnvVarIdParam },
  responses: {
    204: { description: 'Env var linked' },
  },
});

const revokeSkillEnvVarRoute = createRoute({
  method: 'delete',
  path: '/{id}/env-vars/{envVarId}',
  tags: ['Admin'],
  summary: 'Unlink a single env var from a skill',
  middleware: [adminAuth] as const,
  request: { params: SkillIdEnvVarIdParam },
  responses: {
    204: { description: 'Env var unlinked' },
  },
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSkillsAdminRoutes(
  skillsManager: ReturnType<typeof createSkillsManager>,
) {
  const app = new OpenAPIHono();

  // GET / — List all skills
  app.openapi(listSkillsRoute, async (c) => {
    const allSkills = await skillsManager.getAllSkills();
    const errors = skillsManager.getErrors();

    // Fetch DB IDs so the admin UI can reference them for permissions
    const dbRows = await db
      .select({ id: skills.id, name: skills.name, updatedAt: skills.updatedAt })
      .from(skills);
    const dbByName = new Map(dbRows.map((r) => [r.name, r]));

    const items = allSkills.map((skill) => ({
      id: dbByName.get(skill.name)?.id ?? '',
      name: skill.name,
      description: skill.description,
      scripts: skill.scripts,
      parseError: skill.parseError ?? null,
      updatedAt: dbByName.get(skill.name)?.updatedAt ?? Date.now(),
    }));

    return c.json({ skills: items, errors }, 200);
  });

  // POST /reload — Rescan skills directory and sync to DB
  app.openapi(reloadSkillsRoute, async (c) => {
    const result = await skillsManager.reload();
    const now = Date.now();

    // Fetch existing skills from DB for comparison
    const existingRows = await db
      .select({ id: skills.id, name: skills.name })
      .from(skills);

    const existingByName = new Map(
      existingRows.map((row) => [row.name, row.id]),
    );

    const discoveredNames = new Set(result.skills.map((s) => s.name));

    let added = 0;
    let updated = 0;

    // Upsert each discovered skill
    for (const skill of result.skills) {
      const scriptsJson = JSON.stringify(skill.scripts);
      const wasExisting = existingByName.has(skill.name);

      await db
        .insert(skills)
        .values({
          id: wasExisting ? existingByName.get(skill.name)! : uuid(),
          name: skill.name,
          description: skill.description,
          dirPath: skill.dirPath,
          scripts: scriptsJson,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skills.name,
          set: {
            description: skill.description,
            dirPath: skill.dirPath,
            scripts: scriptsJson,
            updatedAt: now,
          },
        });

      if (wasExisting) {
        updated++;
      } else {
        added++;
      }
    }

    // Remove skills from DB that are no longer on disk
    let removed = 0;
    for (const [name, id] of existingByName) {
      if (!discoveredNames.has(name)) {
        await db.delete(skills).where(eq(skills.id, id));
        removed++;
      }
    }

    return c.json(
      {
        total: result.skills.length,
        added,
        updated,
        removed,
        errors: result.errors,
      },
      200,
    );
  });

  // GET /:id/env-vars — List a skill's required env vars
  app.openapi(getSkillEnvVarsRoute, async (c) => {
    const { id } = c.req.valid('param');

    const [skill] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!skill) return c.json({ error: 'Skill not found' }, 404);

    const linked = await db
      .select({
        id: envVars.id,
        key: envVars.key,
        description: envVars.description,
      })
      .from(skillEnvVars)
      .innerJoin(envVars, eq(skillEnvVars.envVarId, envVars.id))
      .where(eq(skillEnvVars.skillId, id));

    return c.json({ envVars: linked }, 200);
  });

  // PUT /:id/env-vars — Set a skill's required env vars (full replace)
  app.openapi(setSkillEnvVarsRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { envVarIds } = c.req.valid('json');

    const [skill] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!skill) return c.json({ error: 'Skill not found' }, 404);

    if (envVarIds.length > 0) {
      const existing = await db.select({ id: envVars.id }).from(envVars).where(inArray(envVars.id, envVarIds));
      if (existing.length !== envVarIds.length) {
        return c.json({ error: 'One or more env var IDs not found' }, 400);
      }
    }

    db.transaction((tx) => {
      tx.delete(skillEnvVars).where(eq(skillEnvVars.skillId, id)).run();
      if (envVarIds.length > 0) {
        tx.insert(skillEnvVars).values(
          envVarIds.map((envVarId) => ({ skillId: id, envVarId })),
        ).run();
      }
    });

    return c.json({ granted: envVarIds.length }, 200);
  });

  // POST /:id/env-vars/:envVarId — Link a single env var to a skill
  app.openapi(grantSkillEnvVarRoute, async (c) => {
    const { id, envVarId } = c.req.valid('param');

    await db
      .insert(skillEnvVars)
      .values({ skillId: id, envVarId })
      .onConflictDoNothing();

    return c.body(null, 204);
  });

  // DELETE /:id/env-vars/:envVarId — Unlink a single env var from a skill
  app.openapi(revokeSkillEnvVarRoute, async (c) => {
    const { id, envVarId } = c.req.valid('param');

    await db
      .delete(skillEnvVars)
      .where(and(eq(skillEnvVars.skillId, id), eq(skillEnvVars.envVarId, envVarId)));

    return c.body(null, 204);
  });

  return app;
}
