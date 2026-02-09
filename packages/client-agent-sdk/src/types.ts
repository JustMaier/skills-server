// Re-export core types for backwards compatibility.
export type {
  SkillSummary,
  SkillDetail,
  ExecutionResult,
} from "@skills-server/client-core";

/**
 * Configuration needed to connect to a skills server instance.
 */
export interface SkillsServerConfig {
  serverUrl: string;
  apiKey: string;
}
