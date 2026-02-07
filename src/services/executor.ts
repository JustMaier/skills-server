import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'ScriptNotFound'
  | 'ScriptNotAllowed'
  | 'InvalidArgs'
  | 'ExecutionTimeout'
  | 'ExecutionFailed';

export interface ExecuteOptions {
  /** Absolute path to the skill directory. */
  skillDir: string;
  /** Script filename (e.g. "run.mjs"). Must be a simple name, no paths. */
  script: string;
  /** Arguments to pass to the script. */
  args?: string[];
  /** Execution timeout in milliseconds (default 30 000). */
  timeout?: number;
  /** Maximum bytes for stdout / stderr (default 20 480 = 20 KB). */
  maxOutput?: number;
  /** Working directory for the child process (default: skillDir). */
  cwd?: string;
  /** Environment variables. When provided, completely replaces process.env. */
  env?: Record<string, string>;
}

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error: string | null;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 20_480;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `script` is a safe relative path with no traversal.
 *
 * Allows a single `scripts/` prefix for subdirectory scripts.
 * Rejects empty strings, `..`, `\`, absolute paths, and any other `/`.
 */
function isSafeScriptPath(script: string): boolean {
  if (!script || script.trim().length === 0) {
    return false;
  }
  if (script.includes('..') || script.includes('\\')) {
    return false;
  }
  if (path.isAbsolute(script)) {
    return false;
  }
  // Allow exactly "scripts/<filename>" or a simple filename
  const stripped = script.startsWith('scripts/') ? script.slice('scripts/'.length) : script;
  if (stripped.includes('/')) {
    return false;
  }
  return true;
}

/**
 * Truncate a string so that its UTF-8 byte length does not exceed `maxBytes`.
 *
 * When truncation occurs a trailing `\n[output truncated]` marker is appended.
 */
function capOutput(output: string, maxBytes: number): string {
  const buf = Buffer.from(output, 'utf-8');
  if (buf.length <= maxBytes) {
    return output;
  }
  const truncated = buf.subarray(0, maxBytes).toString('utf-8');
  return truncated + '\n[output truncated]';
}

/**
 * Synchronously check whether a file exists and is readable.
 */
function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `script` to an absolute path inside `skillDir`.
 *
 * Lookup order:
 *   1. `<skillDir>/<script>`
 *   2. `<skillDir>/scripts/<script>`
 *
 * After resolution the path is verified to still reside within `skillDir`
 * (containment check). Returns the absolute path on success, or `null`.
 */
function resolveScript(skillDir: string, script: string): string | null {
  const resolvedSkillDir = path.resolve(skillDir);
  const candidateRoot = path.resolve(resolvedSkillDir, script);
  const candidateScripts = path.resolve(resolvedSkillDir, 'scripts', script);

  let scriptPath: string | null = null;

  if (fileExists(candidateRoot)) {
    scriptPath = candidateRoot;
  } else if (fileExists(candidateScripts)) {
    scriptPath = candidateScripts;
  }

  if (scriptPath === null) {
    return null;
  }

  // Containment: resolved path must be inside skillDir
  const normalizedSkillDir = resolvedSkillDir + path.sep;
  if (scriptPath !== resolvedSkillDir && !scriptPath.startsWith(normalizedSkillDir)) {
    return null;
  }

  return scriptPath;
}

/**
 * Determine the interpreter command and argument list for a given script.
 *
 * - `.mjs` / `.js`  -> node
 * - `.sh`           -> bash
 * - anything else   -> direct execution
 */
function resolveCommand(
  scriptPath: string,
  args: string[],
): { command: string; execArgs: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();

  switch (ext) {
    case '.mjs':
    case '.js':
      return { command: 'node', execArgs: [scriptPath, ...args] };
    case '.sh':
      return { command: 'bash', execArgs: [scriptPath, ...args] };
    default:
      return { command: scriptPath, execArgs: args };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a script inside a skill directory with strict security containment.
 *
 * Security measures applied:
 * - **No shell** -- uses `execFile`, never `exec`.
 * - **Path traversal prevention** -- `isSimpleFilename` rejects `..`, `/`, `\`.
 * - **Containment** -- `resolveScript` verifies the resolved path stays within
 *   the skill directory.
 * - **Timeout** -- the child process is killed when the timeout expires.
 * - **Output capping** -- stdout and stderr are truncated to `maxOutput` bytes.
 */
export async function executeScript(options: ExecuteOptions): Promise<ExecutionResult> {
  const {
    skillDir,
    script,
    args = [],
    timeout = DEFAULT_TIMEOUT,
    maxOutput = DEFAULT_MAX_OUTPUT,
    cwd,
    env,
  } = options;

  const startTime = Date.now();

  // --- Security: validate script name ----------------------------------
  if (!isSafeScriptPath(script)) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'ScriptNotAllowed',
      durationMs: Date.now() - startTime,
    };
  }

  // --- Validate args ---------------------------------------------------
  if (args.some((a) => typeof a !== 'string')) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'InvalidArgs',
      durationMs: Date.now() - startTime,
    };
  }

  // --- Resolve script path ---------------------------------------------
  const scriptPath = resolveScript(skillDir, script);

  if (scriptPath === null) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'ScriptNotFound',
      durationMs: Date.now() - startTime,
    };
  }

  // --- Build command ---------------------------------------------------
  const { command, execArgs } = resolveCommand(scriptPath, args);

  // --- Execute ---------------------------------------------------------
  return new Promise<ExecutionResult>((resolve) => {
    const child = execFile(
      command,
      execArgs,
      {
        cwd: cwd ?? skillDir,
        timeout,
        maxBuffer: maxOutput * 2, // headroom; we cap manually below
        windowsHide: true,
        ...(env !== undefined && { env: { ...process.env, ...env } }),
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const cappedStdout = capOutput(stdout ?? '', maxOutput);
        const cappedStderr = capOutput(stderr ?? '', maxOutput);

        if (error) {
          // Timeout: Node sets `error.killed` when the child is killed due to
          // the timeout option, and may also set code to ETIMEDOUT.
          if (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            resolve({
              success: false,
              stdout: cappedStdout,
              stderr: cappedStderr,
              exitCode: -1,
              error: 'ExecutionTimeout',
              durationMs,
            });
            return;
          }

          // Non-zero exit or other failure
          const exitCode =
            child.exitCode ?? (error as unknown as { status?: number }).status ?? -1;
          resolve({
            success: false,
            stdout: cappedStdout,
            stderr: cappedStderr,
            exitCode: typeof exitCode === 'number' ? exitCode : -1,
            error: 'ExecutionFailed',
            durationMs,
          });
          return;
        }

        // Success
        resolve({
          success: true,
          stdout: cappedStdout,
          stderr: cappedStderr,
          exitCode: 0,
          error: null,
          durationMs,
        });
      },
    );
  });
}
