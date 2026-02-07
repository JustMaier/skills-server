import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { createApp } from './app.js';
import { db, skills } from './db/index.js';

const port = Number(process.env.PORT) || 3000;
const skillsDir = resolve(process.env.SKILLS_DIR || './skills');

console.log('Starting skills server...');
console.log(`  Port:       ${port}`);
console.log(`  Skills dir: ${skillsDir}`);

// ---------------------------------------------------------------------------
// Create app and initialize
// ---------------------------------------------------------------------------

const { app, skillsManager } = createApp(skillsDir);

// Initial skill discovery — scan directory and sync to DB
async function initialize() {
  const result = await skillsManager.reload();
  const now = Date.now();

  // Fetch existing skills from DB
  const existingRows = await db.select({ id: skills.id, name: skills.name }).from(skills);
  const existingByName = new Map(existingRows.map((r) => [r.name, r.id]));
  const discoveredNames = new Set(result.skills.map((s) => s.name));

  // Upsert discovered skills
  for (const skill of result.skills) {
    await db
      .insert(skills)
      .values({
        id: existingByName.get(skill.name) ?? uuid(),
        name: skill.name,
        description: skill.description,
        dirPath: skill.dirPath,
        scripts: JSON.stringify(skill.scripts),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: skills.name,
        set: {
          description: skill.description,
          dirPath: skill.dirPath,
          scripts: JSON.stringify(skill.scripts),
          updatedAt: now,
        },
      });
  }

  // Remove skills from DB that no longer exist on disk
  let removed = 0;
  for (const [name, id] of existingByName) {
    if (!discoveredNames.has(name)) {
      await db.delete(skills).where(eq(skills.id, id));
      removed++;
    }
  }

  console.log(`  Skills:     ${result.skills.length} discovered${removed > 0 ? `, ${removed} removed` : ''}`);
  if (result.errors.length > 0) {
    console.log(`  Errors:     ${result.errors.length} skills failed to parse`);
    for (const err of result.errors) {
      console.log(`    - ${err.dir}: ${err.error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

initialize()
  .then(() => {
    serve({ fetch: app.fetch, port });
    console.log(`Skills server running on http://localhost:${port}`);
    console.log(`  API docs:   http://localhost:${port}/api/v1/docs`);
    console.log(`  Admin UI:   http://localhost:${port}/`);
  })
  .catch((err) => {
    console.error('Failed to initialize:', err);
    process.exit(1);
  });
