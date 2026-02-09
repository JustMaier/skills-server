// Re-export core types — maintains backwards compatibility for consumers
// who import directly from this package.
export type {
  SkillSummary,
  SkillDetail,
  ExecutionResult as SkillExecutionResult,
  ToolResult as SkillToolResult,
} from "@skills-server/client-core";

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
  handleToolCall(name: string, args: Record<string, unknown>): Promise<import("@skills-server/client-core").ExecutionResult>;
  /** List of available skill names. */
  skillNames: string[];
  /** Map of skill name to full detail (populated on load_skill calls). */
  skills: Map<string, import("@skills-server/client-core").SkillDetail>;
  /** Pre-built catalog of skill names, descriptions, and scripts for system prompt injection. */
  skillsCatalog: string;
  /** Re-fetch the skill list from the server and update skillNames, skillsCatalog, and tool descriptions. */
  refresh(): Promise<void>;
}
