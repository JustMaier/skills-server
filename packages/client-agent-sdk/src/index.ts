export { createSkillsServer, createSkillsServerConfig } from "./tools.js";
export type {
  SkillSummary,
  SkillDetail,
  ExecutionResult,
  SkillsServerConfig,
} from "./types.js";

// Re-export SkillsClient so consumers can type the client property
export { SkillsClient } from "@skills-server/client-core";
