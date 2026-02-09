import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SkillSummary, SkillDetail, ExecutionResult } from "./types.js";

// ---------------------------------------------------------------------------
// MCP result helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], is_error: true as const };
}

// ---------------------------------------------------------------------------
// createSkillsServer — returns an MCP server with three tools
// ---------------------------------------------------------------------------

/**
 * Creates a Claude Agent SDK MCP server that proxies requests to a remote
 * skills server. The returned server exposes three tools:
 *
 * - `list_skills`   — List all skills the agent has access to
 * - `load_skill`    — Load a skill's full instructions and content
 * - `execute_skill` — Execute a script from a skill
 *
 * @param serverUrl  Base URL of the skills server (e.g. `http://localhost:3000`)
 * @param apiKey     Bearer token for agent authentication
 */
export function createSkillsServer(serverUrl: string, apiKey: string) {
  const baseUrl = serverUrl.replace(/\/+$/, "");

  // ── HTTP helper ──────────────────────────────────────────────────────────

  async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  // ── MCP server ───────────────────────────────────────────────────────────

  return createSdkMcpServer({
    name: "skills-server",
    version: "1.0.0",
    tools: [
      // ── list_skills ────────────────────────────────────────────────────
      tool(
        "list_skills",
        "List all available skills on the server. Returns each skill's name, description, and available scripts.",
        {},
        async () => {
          try {
            const skills = await apiFetch<SkillSummary[]>("/api/v1/skills");

            if (skills.length === 0) {
              return textResult("No skills available.");
            }

            const lines = skills.map((s) => {
              const desc = s.description ?? "(no description)";
              const scripts = s.scripts.length > 0 ? s.scripts.join(", ") : "none";
              return `- **${s.name}**: ${desc}\n  Scripts: ${scripts}`;
            });

            return textResult(lines.join("\n"));
          } catch (err) {
            return errorResult(`Error listing skills: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),

      // ── load_skill ─────────────────────────────────────────────────────
      tool(
        "load_skill",
        "Load a skill's full instructions and content by name. Returns the skill's markdown content, frontmatter, available scripts, and last updated timestamp.",
        {
          name: z.string().describe("Name of the skill to load"),
        },
        async (args) => {
          try {
            const skill = await apiFetch<SkillDetail>(
              `/api/v1/skills/${encodeURIComponent(args.name)}`,
            );

            const parts: string[] = [];

            parts.push(`# ${skill.name}`);
            if (skill.description) {
              parts.push(`\n${skill.description}`);
            }

            // Frontmatter metadata
            const fmKeys = Object.keys(skill.frontmatter);
            if (fmKeys.length > 0) {
              parts.push("\n## Metadata");
              for (const key of fmKeys) {
                parts.push(`- ${key}: ${skill.frontmatter[key]}`);
              }
            }

            // Available scripts
            if (skill.scripts.length > 0) {
              parts.push("\n## Scripts");
              parts.push(skill.scripts.map((s) => `- ${s}`).join("\n"));
            }

            // Main content
            parts.push("\n## Content");
            parts.push(skill.content);

            parts.push(`\n---\nLast updated: ${new Date(skill.updatedAt).toISOString()}`);

            return textResult(parts.join("\n"));
          } catch (err) {
            return errorResult(`Error loading skill '${args.name}': ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),

      // ── execute_skill ──────────────────────────────────────────────────
      tool(
        "execute_skill",
        "Execute a script from a skill. Specify the skill name, the script filename to run, and optional arguments.",
        {
          name: z.string().describe("Name of the skill"),
          script: z.string().describe("Script filename to run"),
          args: z.array(z.string()).default([]).describe("Arguments to pass to the script"),
        },
        async (args) => {
          try {
            const result = await apiFetch<ExecutionResult>(
              `/api/v1/skills/${encodeURIComponent(args.name)}/execute`,
              {
                method: "POST",
                body: JSON.stringify({
                  script: args.script,
                  args: args.args,
                }),
              },
            );

            const parts: string[] = [];

            parts.push(`Exit code: ${result.exitCode}`);
            parts.push(`Success: ${result.success}`);
            parts.push(`Duration: ${result.durationMs}ms`);

            if (result.stdout) {
              parts.push(`\n--- stdout ---\n${result.stdout}`);
            }
            if (result.stderr) {
              parts.push(`\n--- stderr ---\n${result.stderr}`);
            }
            if (result.error) {
              parts.push(`\nError: ${result.error}`);
            }

            // Report as error to the agent if the script failed
            if (!result.success) {
              return errorResult(parts.join("\n"));
            }

            return textResult(parts.join("\n"));
          } catch (err) {
            return errorResult(`Error executing '${args.script}' on skill '${args.name}': ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// createSkillsServerConfig — convenience wrapper for query() options
// ---------------------------------------------------------------------------

/**
 * Creates the MCP server and returns a configuration object that can be
 * spread directly into the `options` parameter of `query()`.
 *
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { createSkillsServerConfig } from "@skills-server/client-agent-sdk";
 *
 * const config = createSkillsServerConfig("http://localhost:3000", "my-api-key");
 *
 * for await (const msg of query({
 *   prompt: "List the available skills",
 *   options: { ...config, maxTurns: 10 },
 * })) {
 *   // ...
 * }
 * ```
 *
 * @param serverUrl  Base URL of the skills server
 * @param apiKey     Bearer token for agent authentication
 */
export function createSkillsServerConfig(serverUrl: string, apiKey: string) {
  const server = createSkillsServer(serverUrl, apiKey);
  return {
    mcpServers: { "skills-server": server } as Record<string, typeof server>,
    allowedTools: [
      "mcp__skills-server__list_skills",
      "mcp__skills-server__load_skill",
      "mcp__skills-server__execute_skill",
    ],
  };
}
