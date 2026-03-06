import { execFile } from 'node:child_process';

const GIT_TIMEOUT = 60_000; // 60 seconds
const GIT_MAX_BUFFER = 1_048_576; // 1 MB

export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitAuthOptions {
  /** Personal access token for HTTPS auth (GitHub, GitLab, etc.) */
  token?: string;
}

/**
 * Inject an auth token into an HTTPS repo URL for private repo access.
 * Converts `https://github.com/org/repo` to `https://x-access-token:<token>@github.com/org/repo`.
 * SSH URLs are returned unchanged (use SSH keys for auth).
 */
export function injectAuthToken(repoUrl: string, token: string): string {
  if (!token || !repoUrl.startsWith('https://')) return repoUrl;
  const withoutProtocol = repoUrl.slice('https://'.length);
  return `https://x-access-token:${token}@${withoutProtocol}`;
}

/**
 * Shallow clone a git repo to a target directory.
 * Uses --depth 1 --single-branch for efficiency.
 * Optionally accepts an auth token for private repos.
 */
export async function gitClone(
  repoUrl: string,
  targetDir: string,
  branch = 'main',
  auth?: GitAuthOptions,
): Promise<GitResult> {
  const effectiveUrl = auth?.token ? injectAuthToken(repoUrl, auth.token) : repoUrl;

  return new Promise<GitResult>((resolve) => {
    execFile(
      'git',
      ['clone', '--depth', '1', '--single-branch', '--branch', branch, effectiveUrl, targetDir],
      { timeout: GIT_TIMEOUT, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        // Sanitize output to avoid leaking tokens in error messages
        const sanitize = (s: string) => auth?.token ? s.replaceAll(auth.token, '***') : s;
        if (error) {
          resolve({
            success: false,
            stdout: sanitize(stdout ?? ''),
            stderr: sanitize(stderr ?? error.message),
            exitCode: error.code != null && typeof error.code === 'number' ? error.code : 1,
          });
          return;
        }
        resolve({ success: true, stdout: sanitize(stdout ?? ''), stderr: sanitize(stderr ?? ''), exitCode: 0 });
      },
    );
  });
}

/**
 * Pull latest changes in an existing repo directory.
 * Uses --ff-only to avoid merge conflicts.
 */
export async function gitPull(repoDir: string): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    execFile(
      'git',
      ['pull', '--ff-only'],
      { cwd: repoDir, timeout: GIT_TIMEOUT, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            stdout: stdout ?? '',
            stderr: stderr ?? error.message,
            exitCode: error.code != null && typeof error.code === 'number' ? error.code : 1,
          });
          return;
        }
        resolve({ success: true, stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
      },
    );
  });
}

/**
 * Validate that a repo URL looks legitimate.
 * Accepts https://, git@, or absolute local paths (for testing/local repos).
 */
export function isValidRepoUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  // HTTPS or SSH
  if (/^https:\/\/.+/.test(url) || /^git@.+:.+/.test(url)) return true;
  // Absolute local path (Unix or Windows)
  if (/^\//.test(url) || /^[A-Za-z]:[\\/]/.test(url)) return true;
  return false;
}

/**
 * Derive a filesystem-safe directory name from a repo URL.
 * Used for consistent clone target naming.
 * e.g., "https://github.com/user/repo.git" -> "github.com-user-repo"
 */
export function repoUrlToDirectoryName(url: string): string {
  let cleaned = url;

  // Strip protocol
  cleaned = cleaned.replace(/^https?:\/\//, '');
  // Handle git@ SSH URLs: git@github.com:user/repo -> github.com/user/repo
  cleaned = cleaned.replace(/^git@/, '').replace(/:/, '/');
  // Strip Windows drive letter prefix (e.g., C:/)
  cleaned = cleaned.replace(/^[A-Za-z]:[\\/]/, '');
  // Remove trailing .git
  cleaned = cleaned.replace(/\.git$/, '');
  // Remove trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');
  // Replace all non-alphanumeric (except dots) with dashes
  cleaned = cleaned.replace(/[\/\\:@]/g, '-');
  // Collapse multiple dashes
  cleaned = cleaned.replace(/-+/g, '-');
  // Remove leading/trailing dashes
  cleaned = cleaned.replace(/^-|-$/g, '');

  return cleaned;
}
