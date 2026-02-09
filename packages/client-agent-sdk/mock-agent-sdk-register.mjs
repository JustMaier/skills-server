/**
 * Node.js module loader hook that intercepts imports of
 * @anthropic-ai/claude-agent-sdk and provides mock implementations
 * of createSdkMcpServer and tool.
 *
 * Usage: node --import ./mock-agent-sdk-register.mjs test-e2e.mjs
 */

const mockModuleURL = new URL("mock-agent-sdk.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") {
    return { shortCircuit: true, url: mockModuleURL };
  }
  return nextResolve(specifier, context);
}
