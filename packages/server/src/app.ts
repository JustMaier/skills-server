import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { apiReference } from '@scalar/hono-api-reference';

import { createAgentFacingRoutes } from './routes/agent-facing.js';
import agentsRoutes from './routes/agents.js';
import envVarsRoutes from './routes/env-vars.js';
import permissionsRoutes from './routes/permissions.js';
import { createSkillsAdminRoutes } from './routes/skills-admin.js';
import executionLogsRoutes from './routes/execution-logs.js';
import { createSkillsManager } from './services/discovery.js';

// ---------------------------------------------------------------------------
// Create app
// ---------------------------------------------------------------------------

export function createApp(skillsDir: string) {
  const app = new OpenAPIHono();
  const skillsManager = createSkillsManager(skillsDir);

  // -----------------------------------------------------------------------
  // Middleware
  // -----------------------------------------------------------------------

  app.use('*', cors());

  // TODO: Add rate limiting middleware

  // -----------------------------------------------------------------------
  // Static files
  // -----------------------------------------------------------------------

  app.use('/public/*', serveStatic({ root: './' }));

  // -----------------------------------------------------------------------
  // Serve the agent integration SKILL.md (unauthenticated)
  // -----------------------------------------------------------------------

  app.get('/api/v1/skill.md', serveStatic({ path: './public/skill.md' }));

  // -----------------------------------------------------------------------
  // Route groups
  // -----------------------------------------------------------------------

  // Agent-facing routes (requires agent API key)
  app.route('/api/v1/skills', createAgentFacingRoutes(skillsManager));

  // Management routes (requires admin API key)
  app.route('/api/v1/agents', agentsRoutes);
  app.route('/api/v1/env-vars', envVarsRoutes);
  app.route('/api/v1/agents', permissionsRoutes);

  // Admin routes (requires admin API key)
  app.route('/api/v1/admin/skills', createSkillsAdminRoutes(skillsManager));
  app.route('/api/v1/execution-logs', executionLogsRoutes);

  // -----------------------------------------------------------------------
  // OpenAPI doc & Scalar API reference
  // -----------------------------------------------------------------------

  app.doc('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Skills Server',
      version: '1.0.0',
      description: 'Centralized skills server for AI agents',
    },
  });

  app.get(
    '/api/v1/docs',
    apiReference({
      spec: {
        url: '/api/v1/openapi.json',
      },
    } as Record<string, unknown>),
  );

  // -----------------------------------------------------------------------
  // Catch-all — serve admin UI (index.html)
  // -----------------------------------------------------------------------

  app.get('/', serveStatic({ path: './public/index.html' }));

  return { app, skillsManager };
}
