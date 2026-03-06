import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { agentAuth, type AuthEnv } from '../services/auth.js';
import { db, skills, agentSkills, skillRegistry, agents, type PermissionLevel } from '../db/index.js';
import { hasPermission, getEffectivePermission } from '../services/permissions.js';
import { gitClone, gitPull, isValidRepoUrl, repoUrlToDirectoryName, type GitAuthOptions } from '../services/git.js';
import { createLink, removeLink, isLink } from '../services/symlink.js';
import { createSkillsManager } from '../services/discovery.js';

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const ErrorSchema = z.object({
  error: z.string(),
});

const RegistryEntrySchema = z.object({
  id: z.string(),
  skillId: z.string(),
  skillName: z.string(),
  repoUrl: z.string(),
  branch: z.string(),
  subpath: z.string(),
  registeredBy: z.string().nullable(),
  lastSynced: z.number().nullable(),
  status: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const RegisterBodySchema = z.object({
  repoUrl: z.string(),
  branch: z.string().default('main'),
  subpath: z.string().default('/'),
  name: z.string().optional(),
  authToken: z.string().optional().openapi({ description: 'Personal access token for private repos (never stored, used only for clone)' }),
});

const UpdateBodySchema = z.object({
  branch: z.string().optional(),
  subpath: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const registerRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Registry'],
  summary: 'Register a skill from a Git repo',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RegisterBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Skill registered successfully',
      content: {
        'application/json': {
          schema: RegistryEntrySchema,
        },
      },
    },
    400: {
      description: 'Invalid request',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    409: {
      description: 'Skill already exists',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    500: {
      description: 'Internal error',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

const listRegistryRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Registry'],
  summary: 'List registry entries',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: 'Array of registry entries',
      content: {
        'application/json': {
          schema: z.array(RegistryEntrySchema),
        },
      },
    },
    403: {
      description: 'Insufficient permissions',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

const getRegistryEntryRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Registry'],
  summary: 'Get registry entry detail',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Registry entry detail',
      content: {
        'application/json': {
          schema: RegistryEntrySchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: 'Registry entry not found',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

const updateRegistryEntryRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Registry'],
  summary: 'Update registry entry branch/subpath',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated registry entry',
      content: {
        'application/json': {
          schema: RegistryEntrySchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: 'Registry entry not found',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

const deleteRegistryEntryRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Registry'],
  summary: 'Unregister a skill (remove symlink, delete registry entry)',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Skill unregistered',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean() }),
        },
      },
    },
    403: {
      description: 'Insufficient permissions',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: 'Registry entry not found',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    500: {
      description: 'Internal error',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

const syncRegistryEntryRoute = createRoute({
  method: 'post',
  path: '/{id}/sync',
  tags: ['Registry'],
  summary: 'Pull latest from Git and re-discover skill',
  middleware: [agentAuth] as const,
  security: [{ Bearer: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Sync result',
      content: {
        'application/json': {
          schema: RegistryEntrySchema,
        },
      },
    },
    403: {
      description: 'Insufficient permissions',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    404: {
      description: 'Registry entry not found',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
    500: {
      description: 'Internal error',
      content: {
        'application/json': {
          schema: ErrorSchema,
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a RegistryEntrySchema-shaped object from a registry row + skill name. */
function toEntryResponse(
  row: typeof skillRegistry.$inferSelect,
  skillName: string,
) {
  return {
    id: row.id,
    skillId: row.skillId,
    skillName,
    repoUrl: row.repoUrl,
    branch: row.branch,
    subpath: row.subpath,
    registeredBy: row.registeredBy,
    lastSynced: row.lastSynced,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRegistryRoutes(
  skillsManager: ReturnType<typeof createSkillsManager>,
  skillsDir: string,
  reposDir: string,
) {
  const app = new OpenAPIHono<AuthEnv>();

  // ─── POST / — Register skill from Git repo ─────────────────────────────

  app.openapi(registerRoute, async (c) => {
    const agent = c.get('agent');
    const agentLevel = agent.permissionLevel as PermissionLevel;

    // Agent-wide maintain check
    if (!hasPermission(agentLevel, 'maintain')) {
      return c.json({ error: 'Requires maintain permission' }, 403);
    }

    const { repoUrl, branch, subpath, name, authToken } = c.req.valid('json');

    // Validate repo URL
    if (!isValidRepoUrl(repoUrl)) {
      return c.json({ error: 'Invalid repository URL' }, 400);
    }

    // Derive skill name
    const skillName = name ?? basename(repoUrlToDirectoryName(repoUrl));

    // Check if a skill with this name already exists
    const [existing] = await db
      .select()
      .from(skills)
      .where(eq(skills.name, skillName))
      .limit(1);

    if (existing) {
      return c.json({ error: `Skill "${skillName}" already exists` }, 409);
    }

    // Clone target directory
    const cloneDir = join(reposDir, repoUrlToDirectoryName(repoUrl));

    // Clone if not already cloned
    let alreadyCloned = false;
    try {
      await stat(cloneDir);
      alreadyCloned = true;
    } catch {
      // Directory does not exist — will clone
    }

    if (!alreadyCloned) {
      const auth: GitAuthOptions | undefined = authToken ? { token: authToken } : undefined;
      const cloneResult = await gitClone(repoUrl, cloneDir, branch, auth);
      if (!cloneResult.success) {
        return c.json({ error: `Git clone failed: ${cloneResult.stderr}` }, 500);
      }
    }

    // Verify SKILL.md exists at the subpath
    const skillMdPath = join(cloneDir, subpath, 'SKILL.md');
    try {
      await stat(skillMdPath);
    } catch {
      return c.json({ error: `SKILL.md not found at ${subpath}` }, 400);
    }

    // Create symlink (remove stale one if it exists from a previous failed registration)
    const linkPath = join(skillsDir, skillName);
    try {
      if (await isLink(linkPath)) {
        await removeLink(linkPath);
      }
      await createLink(join(cloneDir, subpath), linkPath);
    } catch (err) {
      return c.json({
        error: `Failed to create symlink: ${err instanceof Error ? err.message : String(err)}`,
      }, 500);
    }

    // Reload skills manager to pick up the new skill
    const reloadResult = await skillsManager.reload();

    // Find the newly discovered skill in memory
    const discovered = reloadResult.skills.find((s) => s.name === skillName);
    if (!discovered) {
      return c.json({ error: 'Skill was not discovered after linking — check SKILL.md' }, 500);
    }

    // Upsert discovered skill into DB (reload only populates in-memory cache)
    const now = Date.now();
    const skillId = uuid();
    await db
      .insert(skills)
      .values({
        id: skillId,
        name: discovered.name,
        description: discovered.description,
        dirPath: discovered.dirPath,
        scripts: JSON.stringify(discovered.scripts),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: skills.name,
        set: {
          description: discovered.description,
          dirPath: discovered.dirPath,
          scripts: JSON.stringify(discovered.scripts),
          updatedAt: now,
        },
      });

    // Fetch the skill row (may have been upserted with existing ID)
    const [skillRow] = await db
      .select()
      .from(skills)
      .where(eq(skills.name, skillName))
      .limit(1);

    if (!skillRow) {
      return c.json({ error: 'Skill was not discovered after linking — check SKILL.md' }, 500);
    }

    const entryId = uuid();
    const entry = {
      id: entryId,
      skillId: skillRow.id,
      repoUrl,
      branch,
      subpath,
      registeredBy: agent.id,
      lastSynced: now,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(skillRegistry).values(entry);

    // Auto-grant maintain permission on the new skill to the registering agent
    await db.insert(agentSkills).values({
      agentId: agent.id,
      skillId: skillRow.id,
      permissionLevel: 'maintain',
    });

    return c.json(toEntryResponse(entry, skillName), 201);
  });

  // ─── GET / — List registry entries ──────────────────────────────────────

  app.openapi(listRegistryRoute, async (c) => {
    const agent = c.get('agent');
    const agentLevel = agent.permissionLevel as PermissionLevel;

    if (!hasPermission(agentLevel, 'execute')) {
      return c.json({ error: 'Requires execute permission' }, 403);
    }

    const entries = await db
      .select({
        id: skillRegistry.id,
        skillId: skillRegistry.skillId,
        skillName: skills.name,
        repoUrl: skillRegistry.repoUrl,
        branch: skillRegistry.branch,
        subpath: skillRegistry.subpath,
        registeredBy: skillRegistry.registeredBy,
        lastSynced: skillRegistry.lastSynced,
        status: skillRegistry.status,
        createdAt: skillRegistry.createdAt,
        updatedAt: skillRegistry.updatedAt,
      })
      .from(skillRegistry)
      .innerJoin(skills, eq(skillRegistry.skillId, skills.id));

    return c.json(entries, 200);
  });

  // ─── GET /:id — Get registry entry detail ───────────────────────────────

  app.openapi(getRegistryEntryRoute, async (c) => {
    const agent = c.get('agent');
    const agentLevel = agent.permissionLevel as PermissionLevel;
    const { id } = c.req.valid('param');

    if (!hasPermission(agentLevel, 'execute')) {
      return c.json({ error: 'Requires execute permission' }, 403);
    }

    const [entry] = await db
      .select({
        id: skillRegistry.id,
        skillId: skillRegistry.skillId,
        skillName: skills.name,
        repoUrl: skillRegistry.repoUrl,
        branch: skillRegistry.branch,
        subpath: skillRegistry.subpath,
        registeredBy: skillRegistry.registeredBy,
        lastSynced: skillRegistry.lastSynced,
        status: skillRegistry.status,
        createdAt: skillRegistry.createdAt,
        updatedAt: skillRegistry.updatedAt,
      })
      .from(skillRegistry)
      .innerJoin(skills, eq(skillRegistry.skillId, skills.id))
      .where(eq(skillRegistry.id, id))
      .limit(1);

    if (!entry) {
      return c.json({ error: 'Registry entry not found' }, 404);
    }

    return c.json(entry, 200);
  });

  // ─── PATCH /:id — Update branch/subpath ─────────────────────────────────

  app.openapi(updateRegistryEntryRoute, async (c) => {
    const agent = c.get('agent');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    // Look up registry entry
    const [entry] = await db
      .select()
      .from(skillRegistry)
      .where(eq(skillRegistry.id, id))
      .limit(1);

    if (!entry) {
      return c.json({ error: 'Registry entry not found' }, 404);
    }

    // Check maintain permission on the skill
    const effective = await getEffectivePermission(agent.id, entry.skillId);
    if (!hasPermission(effective, 'maintain')) {
      return c.json({ error: 'Requires maintain permission on this skill' }, 403);
    }

    // Build update
    const now = Date.now();
    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.branch !== undefined) updates.branch = body.branch;
    if (body.subpath !== undefined) updates.subpath = body.subpath;

    await db
      .update(skillRegistry)
      .set(updates)
      .where(eq(skillRegistry.id, id));

    // Re-fetch
    const [updated] = await db
      .select({
        id: skillRegistry.id,
        skillId: skillRegistry.skillId,
        skillName: skills.name,
        repoUrl: skillRegistry.repoUrl,
        branch: skillRegistry.branch,
        subpath: skillRegistry.subpath,
        registeredBy: skillRegistry.registeredBy,
        lastSynced: skillRegistry.lastSynced,
        status: skillRegistry.status,
        createdAt: skillRegistry.createdAt,
        updatedAt: skillRegistry.updatedAt,
      })
      .from(skillRegistry)
      .innerJoin(skills, eq(skillRegistry.skillId, skills.id))
      .where(eq(skillRegistry.id, id))
      .limit(1);

    return c.json(updated!, 200);
  });

  // ─── DELETE /:id — Unregister skill ─────────────────────────────────────

  app.openapi(deleteRegistryEntryRoute, async (c) => {
    const agent = c.get('agent');
    const { id } = c.req.valid('param');

    // Look up registry entry
    const [entry] = await db
      .select()
      .from(skillRegistry)
      .where(eq(skillRegistry.id, id))
      .limit(1);

    if (!entry) {
      return c.json({ error: 'Registry entry not found' }, 404);
    }

    // Check maintain permission on the skill
    const effective = await getEffectivePermission(agent.id, entry.skillId);
    if (!hasPermission(effective, 'maintain')) {
      return c.json({ error: 'Requires maintain permission on this skill' }, 403);
    }

    // Look up skill name for symlink path
    const [skillRow] = await db
      .select()
      .from(skills)
      .where(eq(skills.id, entry.skillId))
      .limit(1);

    if (skillRow) {
      // Remove symlink
      const linkPath = join(skillsDir, skillRow.name);
      try {
        await removeLink(linkPath);
      } catch {
        // Symlink may already be gone — continue
      }

      // Delete skill from DB
      await db.delete(skills).where(eq(skills.id, skillRow.id));
    }

    // Delete registry record
    await db.delete(skillRegistry).where(eq(skillRegistry.id, id));

    // Reload skills manager
    await skillsManager.reload();

    return c.json({ ok: true }, 200);
  });

  // ─── POST /:id/sync — Pull latest and re-discover ──────────────────────

  app.openapi(syncRegistryEntryRoute, async (c) => {
    const agent = c.get('agent');
    const { id } = c.req.valid('param');

    // Look up registry entry
    const [entry] = await db
      .select()
      .from(skillRegistry)
      .where(eq(skillRegistry.id, id))
      .limit(1);

    if (!entry) {
      return c.json({ error: 'Registry entry not found' }, 404);
    }

    // Check maintain permission on the skill
    const effective = await getEffectivePermission(agent.id, entry.skillId);
    if (!hasPermission(effective, 'maintain')) {
      return c.json({ error: 'Requires maintain permission on this skill' }, 403);
    }

    const now = Date.now();

    // Set status to syncing
    await db
      .update(skillRegistry)
      .set({ status: 'syncing', updatedAt: now })
      .where(eq(skillRegistry.id, id));

    // Derive repo directory from repoUrl
    const repoDir = join(reposDir, repoUrlToDirectoryName(entry.repoUrl));

    // Pull latest
    const pullResult = await gitPull(repoDir);
    if (!pullResult.success) {
      await db
        .update(skillRegistry)
        .set({ status: 'broken', updatedAt: Date.now() })
        .where(eq(skillRegistry.id, id));
      return c.json({ error: `Git pull failed: ${pullResult.stderr}` }, 500);
    }

    // Verify SKILL.md still exists at symlink target
    const skillMdPath = join(repoDir, entry.subpath, 'SKILL.md');
    let skillMdExists = false;
    try {
      await stat(skillMdPath);
      skillMdExists = true;
    } catch {
      // SKILL.md missing
    }

    if (!skillMdExists) {
      await db
        .update(skillRegistry)
        .set({ status: 'broken', updatedAt: Date.now() })
        .where(eq(skillRegistry.id, id));

      // Look up skill name for response
      const [skillRow] = await db
        .select()
        .from(skills)
        .where(eq(skills.id, entry.skillId))
        .limit(1);

      const [broken] = await db
        .select()
        .from(skillRegistry)
        .where(eq(skillRegistry.id, id))
        .limit(1);

      return c.json(toEntryResponse(broken!, skillRow?.name ?? ''), 200);
    }

    // Reload skills manager
    await skillsManager.reload();

    // Set status to active
    const syncedAt = Date.now();
    await db
      .update(skillRegistry)
      .set({ status: 'active', lastSynced: syncedAt, updatedAt: syncedAt })
      .where(eq(skillRegistry.id, id));

    // Look up skill name for response
    const [skillRow] = await db
      .select()
      .from(skills)
      .where(eq(skills.id, entry.skillId))
      .limit(1);

    const [synced] = await db
      .select()
      .from(skillRegistry)
      .where(eq(skillRegistry.id, id))
      .limit(1);

    return c.json(toEntryResponse(synced!, skillRow?.name ?? ''), 200);
  });

  return app;
}
