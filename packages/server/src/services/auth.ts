import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";

import { db, agents, type Agent } from "../db/index.js";
import { hashApiKey, timingSafeEqual } from "./crypto.js";

// ---------------------------------------------------------------------------
// Hono Env type – allows routes to access `c.get('agent')` with full typing
// ---------------------------------------------------------------------------

export type AuthEnv = {
  Variables: {
    agent: Agent;
  };
};

// ---------------------------------------------------------------------------
// Agent authentication middleware
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming request using a Bearer token that maps to a
 * registered agent in the database.
 *
 * On success the matched {@link Agent} record is stored on the Hono context
 * so downstream handlers can retrieve it via `c.get('agent')`.
 */
export const agentAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const key = header.slice("Bearer ".length);
  const hash = hashApiKey(key);

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.apiKeyHash, hash))
    .limit(1);

  if (!agent) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("agent", agent);
  await next();
});

// ---------------------------------------------------------------------------
// Admin authentication middleware
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming request against the server-level admin API key
 * stored in `process.env.ADMIN_API_KEY`.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export const adminAuth = createMiddleware(async (c, next) => {
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    return c.json({ error: "Admin authentication required" }, 401);
  }

  const header = c.req.header("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Admin authentication required" }, 401);
  }

  const key = header.slice("Bearer ".length);

  if (!timingSafeEqual(key, adminKey)) {
    return c.json({ error: "Admin authentication required" }, 401);
  }

  await next();
});
