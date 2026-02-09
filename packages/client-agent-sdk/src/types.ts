/**
 * Summary returned by GET /api/v1/skills for each skill the agent can access.
 */
export interface SkillSummary {
  name: string;
  description: string | null;
  scripts: string[];
}

/**
 * Full skill detail returned by GET /api/v1/skills/{name}.
 */
export interface SkillDetail {
  name: string;
  description: string;
  content: string;
  scripts: string[];
  frontmatter: Record<string, string>;
  updatedAt: number;
}

/**
 * Result of executing a script via POST /api/v1/skills/{name}/execute.
 */
export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
  durationMs: number;
}

/**
 * Configuration needed to connect to a skills server instance.
 */
export interface SkillsServerConfig {
  serverUrl: string;
  apiKey: string;
}
