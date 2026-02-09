/**
 * Mock implementation of @anthropic-ai/claude-agent-sdk
 *
 * Provides just enough of createSdkMcpServer and tool to let the
 * client-agent-sdk code initialize and be testable.
 */

export function tool(name, description, schema, handler) {
  return { name, description, schema, handler };
}

export function createSdkMcpServer(config) {
  return {
    name: config.name,
    version: config.version,
    tools: config.tools,
  };
}
