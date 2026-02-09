/**
 * Example: Claude Agent SDK agent that uses the skills server.
 *
 * Prerequisites:
 *   1. Build the package: npm run build (from packages/client-agent-sdk)
 *   2. Start the skills server
 *   3. Set environment variables (see .env.example)
 *
 * Run:
 *   npx tsx example/agent.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSkillsServerConfig } from "../dist/index.js";

const serverUrl = process.env.SKILLS_SERVER_URL;
const apiKey = process.env.SKILLS_SERVER_API_KEY;

if (!serverUrl || !apiKey) {
  console.error(
    "Missing required environment variables.\n" +
    "Set SKILLS_SERVER_URL and SKILLS_SERVER_API_KEY before running this example.\n" +
    "See example/.env.example for details.",
  );
  process.exit(1);
}

const config = createSkillsServerConfig(serverUrl, apiKey);

console.log("Starting agent with skills server at:", serverUrl);
console.log("Available tools:", config.allowedTools.join(", "));
console.log("---\n");

for await (const message of query({
  prompt:
    "List the available skills, then load the hello skill and run its script with 'world' as an argument.",
  options: {
    ...config,
    maxTurns: 10,
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") {
        process.stdout.write(block.text);
      }
    }
  }

  if (message.type === "result" && message.subtype === "success") {
    console.log("\n\nFinal result:", message.result);
  }
}
