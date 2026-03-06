import { mkdir, symlink, unlink, lstat, access } from 'node:fs/promises';
import { dirname } from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * Create a symlink/junction from linkPath pointing to targetDir.
 * On Windows, uses junction. On Unix, uses directory symlink.
 * Creates parent directories of linkPath if they don't exist.
 */
export async function createLink(targetDir: string, linkPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  const type = isWindows ? 'junction' : 'dir';
  await symlink(targetDir, linkPath, type);
}

/**
 * Remove a symlink/junction at the given path.
 * Does NOT remove the target directory.
 */
export async function removeLink(linkPath: string): Promise<void> {
  await unlink(linkPath);
}

/**
 * Check if the given path is a symlink/junction.
 */
export async function isLink(linkPath: string): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Check if a symlink/junction exists and its target directory is accessible.
 * Returns false for broken links.
 */
export async function verifyLink(linkPath: string): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) return false;
    await access(linkPath);
    return true;
  } catch {
    return false;
  }
}
