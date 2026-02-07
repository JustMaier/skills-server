import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, skills } from '../db/index.js';
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

  return app;
}
