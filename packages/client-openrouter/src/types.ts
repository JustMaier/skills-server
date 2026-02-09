/**
 * Summary returned by GET /api/v1/skills (list endpoint).
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
  frontmatter: Record<string, string>;
  content: string;
  scripts: string[];
  updatedAt: number;
}

/**
 * Result from POST /api/v1/skills/{name}/execute.
 */
export interface SkillExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
  durationMs: number;
}

/**
 * Thin result shape returned to models from SDK tools.
 */
export interface SkillToolResult {
  ok: boolean;
  result?: string;
  error?: string;
  message?: string;
}

/**
 * Event emitted by processTurn for UI display.
 */
export interface TurnEvent {
  type: 'tool_call' | 'tool_result' | 'text_delta';
  name?: string;
  arguments?: string;
  result?: string;
  delta?: string;
}

/**
 * Output from processTurn.
 */
export interface TurnOutput {
  text: string;
  history: unknown[];
}

/**
 * Options for createSkillsProvider.
 */
export interface ProviderOptions {
  /**
   * Only include skills whose names match these patterns.
   * If omitted, all skills the agent has access to are included.
   */
  include?: string[];
  /**
   * Exclude skills whose names match these patterns.
   */
  exclude?: string[];
}

/**
 * The provider returned by createSkillsProvider.
 */
export interface SkillsProvider {
  /** Handle a tool call by name and arguments. */
  handleToolCall(name: string, args: Record<string, unknown>): Promise<SkillExecutionResult>;
  /** List of available skill names. */
  skillNames: string[];
  /** Map of skill name to full detail (populated on load_skill calls). */
  skills: Map<string, SkillDetail>;
  /** Pre-built catalog of skill names, descriptions, and scripts for system prompt injection. */
  skillsCatalog: string;
}
