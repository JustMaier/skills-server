/**
 * Summary returned by GET /api/v1/skills.
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
 * Result from POST /api/v1/skills/{name}/execute.
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
 * Thin result shape returned to models from tool calls.
 */
export interface ToolResult {
  ok: boolean;
  result?: string;
  error?: string;
  message?: string;
}
