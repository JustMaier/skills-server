export {
  createSkillsProvider,
  createSdkTools,
  createManualTools,
  toToolResult,
  processTurn,
} from './provider.js';

export type {
  SkillSummary,
  SkillDetail,
  SkillExecutionResult,
  SkillToolResult,
  SkillsProvider,
  ProviderOptions,
  TurnEvent,
  TurnOutput,
} from './types.js';

// Re-export SkillsClient so consumers can access the underlying client
export { SkillsClient } from '@skills-server/client-core';
