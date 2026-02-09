import { tool } from '@openrouter/sdk';
import type { NextTurnParamsContext } from '@openrouter/sdk';
import { z } from 'zod';
import {
  SkillsClient,
  toToolResult,
  failResult,
  type SkillDetail,
  type ExecutionResult,
  type ToolResult,
} from '@skills-server/client-core';
import type {
  SkillsProvider,
  ProviderOptions,
  TurnEvent,
  TurnOutput,
} from './types.js';

// ---------------------------------------------------------------------------
// Zod schema for tool results (shared by SDK tools)
// ---------------------------------------------------------------------------

const toolResultSchema = z.object({
  ok: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Re-export toToolResult for backwards compatibility
// ---------------------------------------------------------------------------

export { toToolResult } from '@skills-server/client-core';

// ---------------------------------------------------------------------------
// createSkillsProvider
// ---------------------------------------------------------------------------

/**
 * Create a SkillsProvider backed by a remote skills server.
 *
 * On creation, fetches the skill list via `GET /api/v1/skills` and caches
 * skill summaries. Full skill content is fetched lazily on `load_skill` calls.
 *
 * @param serverUrl  Base URL of the skills server (e.g. "http://localhost:3000")
 * @param apiKey     Agent API key for the skills server
 * @param options    Optional include/exclude filters
 */
export async function createSkillsProvider(
  serverUrl: string,
  apiKey: string,
  options: ProviderOptions = {},
): Promise<SkillsProvider> {
  const client = new SkillsClient(serverUrl, apiKey);

  // Map of fully loaded skill definitions (populated lazily via load_skill)
  const skillsMap = new Map<string, SkillDetail>();

  /** Fetch skills from server, apply filters, rebuild cache and catalog. */
  async function fetchAndSync(): Promise<void> {
    await client.refresh({ include: options.include, exclude: options.exclude });
  }

  const provider: SkillsProvider = {
    get skillNames() {
      return client.skills.map((s) => s.name);
    },
    skills: skillsMap,
    get skillsCatalog() {
      return client.skillsCatalog;
    },
    set skillsCatalog(_value: string) {
      // No-op — catalog is managed by the underlying SkillsClient.
      // Setter exists for interface compatibility.
    },

    async refresh() {
      await fetchAndSync();
    },

    handleToolCall: async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ExecutionResult> => {
      // ----- load_skill -----
      if (name === 'load_skill') {
        const skillName = String(args.skill ?? '');

        const hasSkill = client.skills.some((s) => s.name === skillName);
        if (!hasSkill) {
          // Best-effort refresh in case permissions changed since last fetch
          try { await fetchAndSync(); } catch { /* continue with existing data */ }
        }

        const hasSkillAfterRefresh = client.skills.some((s) => s.name === skillName);
        if (!hasSkillAfterRefresh) {
          return failResult(
            'SkillNotFound',
            `"${skillName}" not found. Available: ${provider.skillNames.join(', ')}`,
          );
        }

        try {
          const detail = await client.loadSkill(skillName);
          skillsMap.set(skillName, detail);
          return {
            success: true,
            stdout: detail.content,
            stderr: '',
            exitCode: 0,
            error: null,
            durationMs: 0,
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Failed to load skill';
          return failResult('LoadFailed', message);
        }
      }

      // ----- use_skill -----
      if (name === 'use_skill') {
        const skillName = String(args.skill ?? '');
        const script = String(args.script ?? '');
        const rawArgs = args.args;

        let scriptArgs: string[] = [];
        if (Array.isArray(rawArgs)) {
          scriptArgs = rawArgs.map(String);
        } else if (rawArgs !== undefined && rawArgs !== null) {
          return failResult(
            'InvalidArgs',
            `args must be an array of strings, got ${typeof rawArgs}`,
          );
        }

        try {
          return await client.executeSkill(skillName, script, scriptArgs);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Execution failed';
          return failResult('ExecutionFailed', message);
        }
      }

      return failResult(
        'UnknownTool',
        `Unknown tool: ${name}. Available: load_skill, use_skill`,
      );
    },
  };

  // Initial fetch
  await fetchAndSync();

  return provider;
}

// ---------------------------------------------------------------------------
// createSdkTools
// ---------------------------------------------------------------------------

/**
 * Create OpenRouter SDK-compatible tools from a SkillsProvider.
 *
 * Returns tools ready for `client.callModel({ tools })`. The `load_skill` tool
 * uses `nextTurnParams` to inject skill instructions into the model's context.
 */
export function createSdkTools(provider: SkillsProvider) {
  const { skills } = provider;

  const loadSkillInputSchema = z.object({
    skill: z
      .string()
      .describe('The name of the skill to load.'),
  });

  const useSkillInputSchema = z.object({
    skill: z.string().describe('The skill that provides the script.'),
    script: z
      .string()
      .describe(
        'The script filename to run as outlined in the skill (ex. skill.mjs, cli.js, run.sh).',
      ),
    args: z
      .array(z.string())
      .default([])
      .describe('Arguments to pass to the script.'),
    remember: z
      .boolean()
      .default(false)
      .describe(
        'Set to true if you want to reference the result of this request as you continue to perform your work - be conservative.',
      ),
  });

  const loadSkillTool = tool({
    name: 'load_skill',
    description:
      "Load a skill's instructions once to learn what scripts and commands it provides. " +
      'Only call this once per skill -- the instructions stay in context for the rest of the conversation.',
    inputSchema: loadSkillInputSchema,
    outputSchema: toolResultSchema,
    nextTurnParams: {
      instructions: (params: z.infer<typeof loadSkillInputSchema>, context: NextTurnParamsContext): string | null => {
        const marker = `[Skill: ${params.skill}]`;
        const current = context.instructions ?? '';
        if (current.includes(marker)) return current;
        const s = skills.get(params.skill);
        if (!s) return current;
        return `${current}\n\n${marker}\n${s.content}`;
      },
    },
    execute: async (params: z.infer<typeof loadSkillInputSchema>) => {
      return toToolResult(
        await provider.handleToolCall('load_skill', { skill: params.skill }),
      );
    },
  });

  const useSkillTool = tool({
    name: 'use_skill',
    description:
      'Run a script from a previously loaded skill. ' +
      'Refer to the skill instructions already in your context for available scripts and arguments.',
    inputSchema: useSkillInputSchema,
    outputSchema: toolResultSchema,
    execute: async (params: z.infer<typeof useSkillInputSchema>) => {
      return toToolResult(
        await provider.handleToolCall('use_skill', {
          skill: params.skill,
          script: params.script,
          args: params.args,
        }),
      );
    },
  });

  return [loadSkillTool, useSkillTool];
}

// ---------------------------------------------------------------------------
// createManualTools
// ---------------------------------------------------------------------------

/**
 * Create manual tools (execute: false) from SDK tools.
 *
 * Use these with a custom multi-turn loop for real streaming between turns.
 * The SDK's auto-execution batches items across turns; manual tools let you
 * call `callModel` per turn and stream each turn independently.
 */
export function createManualTools(sdkTools: ReturnType<typeof createSdkTools>) {
  return sdkTools.map((t) => ({
    ...t,
    function: { ...t.function, execute: false as const, nextTurnParams: undefined },
  }));
}

// ---------------------------------------------------------------------------
// processTurn
// ---------------------------------------------------------------------------

/**
 * Process a callModel result: stream tool events, collect history, and return final text.
 *
 * Handles the common pattern of iterating `getItemsStream()` for UI display while
 * collecting SDK-format items for session history. Respects the `remember` flag on
 * `use_skill` calls -- when `false`, the tool call and its result are emitted to the
 * callback for display but excluded from the returned history.
 */
export async function processTurn(
  result: {
    getItemsStream(): AsyncIterable<Record<string, unknown>>;
    getText(): Promise<string>;
  },
  onEvent?: (event: TurnEvent) => void,
): Promise<TurnOutput> {
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  const callNames = new Map<string, string>();
  const skipCallIds = new Set<string>();
  const history: unknown[] = [];

  // Track cumulative text from message items to compute deltas
  let streamedText = '';

  for await (const item of result.getItemsStream()) {
    if (item.type === 'function_call') {
      const callId = item.callId as string;
      const name = item.name as string;
      callNames.set(callId, name);

      if (item.status === 'completed' && !seenCalls.has(callId)) {
        seenCalls.add(callId);

        // Check remember flag on use_skill calls (default: don't persist)
        let persist = true;
        if (name === 'use_skill') {
          try {
            const args = JSON.parse(item.arguments as string);
            if (args.remember !== true) persist = false;
          } catch {
            /* don't persist if args can't be parsed */
          }
        }

        if (persist) {
          history.push({
            type: 'function_call',
            callId,
            name,
            arguments: item.arguments,
          });
        } else {
          skipCallIds.add(callId);
        }

        onEvent?.({
          type: 'tool_call',
          name,
          arguments: item.arguments as string,
        });
      }
    } else if (item.type === 'function_call_output') {
      const callId = item.callId as string;
      if (!seenResults.has(callId)) {
        seenResults.add(callId);

        if (!skipCallIds.has(callId)) {
          history.push({
            type: 'function_call_output',
            callId,
            output: item.output,
          });
        }

        onEvent?.({
          type: 'tool_result',
          name: callNames.get(callId) ?? 'unknown',
          result: item.output as string,
        });
      }
    } else if (item.type === 'message') {
      // Extract text from cumulative message content and emit deltas
      const content = item.content;
      let text = '';
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object' && 'text' in part) {
            text += (part as { text: string }).text;
          }
        }
      } else if (typeof content === 'string') {
        text = content;
      }
      if (text.length > streamedText.length) {
        const delta = text.slice(streamedText.length);
        streamedText = text;
        onEvent?.({ type: 'text_delta', delta });
      }
    }
  }

  // Fall back to getText() if no text was streamed from message items
  const text = streamedText || (await result.getText());
  return { text, history };
}
