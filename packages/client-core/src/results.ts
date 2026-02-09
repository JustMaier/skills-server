import type { ExecutionResult, ToolResult } from "./types.js";

/**
 * Reshape an ExecutionResult to the thin ToolResult format for models.
 */
export function toToolResult(r: ExecutionResult): ToolResult {
  if (r.success) {
    return { ok: true, result: r.stdout };
  }
  const out: ToolResult = { ok: false, error: r.error ?? undefined };
  if (r.stderr) out.message = r.stderr;
  return out;
}

/**
 * Create a failure ExecutionResult for client-side errors (before HTTP).
 */
export function failResult(error: string, stderr = ""): ExecutionResult {
  return { success: false, stdout: "", stderr, exitCode: -1, error, durationMs: 0 };
}
