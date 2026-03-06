import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed representation of a single skill directory. */
export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  dirPath: string;
  scripts: string[];
  frontmatter: Record<string, string>;
  parseError?: string;
}

/** Aggregate result from a full discovery scan. */
export interface DiscoveryResult {
  skills: SkillDefinition[];
  errors: Array<{ dir: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_FILENAME = 'SKILL.md';
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.js', '.sh']);

// ---------------------------------------------------------------------------
// Frontmatter & Markdown helpers
// ---------------------------------------------------------------------------

/**
 * Parse simple YAML frontmatter from raw text.
 *
 * Handles `key: value` lines only (no nested objects, arrays, etc.).
 * Values may be optionally quoted with single or double quotes.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract the first paragraph from markdown content.
 *
 * Skips blank lines and headings, then returns the first contiguous block of
 * non-empty, non-heading lines joined into a single string.
 */
function firstParagraph(markdown: string): string {
  const lines = markdown.split('\n');
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      started = true;
      paragraphLines.push(trimmed);
    } else {
      if (trimmed === '' || trimmed.startsWith('#')) break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(' ');
}

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md file, extracting YAML frontmatter metadata and the
 * markdown body below it.
 *
 * - `name` defaults to the parent directory name when absent from frontmatter.
 * - `description` falls back to the first paragraph of the markdown body.
 * - All frontmatter key-value pairs are returned in `frontmatter`.
 *
 * @param filePath - Absolute path to a SKILL.md file
 */
export async function parseSkillFile(
  filePath: string,
): Promise<{
  name: string;
  description: string;
  content: string;
  frontmatter: Record<string, string>;
}> {
  const raw = await readFile(filePath, 'utf-8');

  let frontmatter: Record<string, string> = {};
  let content = raw;

  // Check for YAML frontmatter delimited by --- on its own line
  if (raw.startsWith('---')) {
    const endIndex = raw.indexOf('\n---', 3);
    if (endIndex !== -1) {
      const frontmatterRaw = raw.slice(3, endIndex);
      frontmatter = parseFrontmatter(frontmatterRaw);

      // Content is everything after the closing --- line
      const afterClosing = endIndex + 4; // length of "\n---"
      content = raw.slice(afterClosing).replace(/^\r?\n/, '');
    }
  }

  // Name: frontmatter > parent directory name
  const name = frontmatter['name'] ?? basename(resolve(filePath, '..'));

  // Description: frontmatter > first paragraph of body
  const description = frontmatter['description'] || firstParagraph(content);

  return { name, description, content, frontmatter };
}

// ---------------------------------------------------------------------------
// collectScripts
// ---------------------------------------------------------------------------

/**
 * Find script files in a skill directory by extension (.mjs, .js, .sh).
 *
 * Scans the skill root directory and an optional `scripts/` subfolder.
 * Scripts found in the subfolder are prefixed with `"scripts/"` so callers
 * can distinguish them.
 *
 * @param skillDir - Absolute path to the skill directory
 * @returns Array of script filenames (e.g. `["run.mjs", "scripts/setup.sh"]`)
 */
export async function collectScripts(skillDir: string): Promise<string[]> {
  const scripts: string[] = [];

  // Collect from root
  try {
    const rootEntries = await readdir(skillDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile()) continue;
      if (SCRIPT_EXTENSIONS.has(extname(entry.name))) {
        scripts.push(entry.name);
      }
    }
  } catch {
    // Directory unreadable — return empty
  }

  // Collect from scripts/ subfolder
  const subDir = join(skillDir, 'scripts');
  try {
    const subEntries = await readdir(subDir, { withFileTypes: true });
    for (const entry of subEntries) {
      if (!entry.isFile()) continue;
      if (SCRIPT_EXTENSIONS.has(extname(entry.name))) {
        scripts.push(`scripts/${entry.name}`);
      }
    }
  } catch {
    // No scripts/ subfolder — that is fine
  }

  return scripts;
}

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

/**
 * Scan a directory for subdirectories containing a SKILL.md file.
 *
 * For each valid skill directory the SKILL.md is parsed and scripts are
 * collected. Directories that lack a SKILL.md are silently skipped.
 * Directories whose SKILL.md fails to parse are recorded in the `errors`
 * array and still included in `skills` with a `parseError` field set.
 *
 * @param skillsDir - Absolute path to the skills root directory
 * @returns All discovered skills plus any per-directory errors
 */
export async function discoverSkills(
  skillsDir: string,
): Promise<DiscoveryResult> {
  const resolvedDir = resolve(skillsDir);
  const skills: SkillDefinition[] = [];
  const errors: Array<{ dir: string; error: string }> = [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch {
    return { skills, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const skillDir = join(resolvedDir, entry.name);
    const skillFilePath = join(skillDir, SKILL_FILENAME);

    // Check that SKILL.md exists and is a file
    try {
      const fileStat = await stat(skillFilePath);
      if (!fileStat.isFile()) continue;
    } catch {
      // No SKILL.md in this directory — skip silently
      continue;
    }

    // Parse and collect
    try {
      const [parsed, scripts] = await Promise.all([
        parseSkillFile(skillFilePath),
        collectScripts(skillDir),
      ]);

      skills.push({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        dirPath: skillDir,
        scripts,
        frontmatter: parsed.frontmatter,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      errors.push({ dir: skillDir, error: message });

      // Include a degraded entry so the caller knows the directory existed
      skills.push({
        name: entry.name,
        description: '',
        content: '',
        dirPath: skillDir,
        scripts: [],
        frontmatter: {},
        parseError: message,
      });
    }
  }

  return { skills, errors };
}

// ---------------------------------------------------------------------------
// createSkillsManager
// ---------------------------------------------------------------------------

/**
 * Create a long-lived skills manager that caches discovery results and
 * automatically re-parses individual skills when their SKILL.md file
 * changes on disk (detected via mtime comparison).
 *
 * Follows the same staleness pattern as the reference repo's
 * `refreshIfStale` / `rediscover`:
 *
 * 1. `getSkill(name)` — check SKILL.md mtime against cached value.
 *    If changed, re-parse that single skill. If the skill is not in
 *    the cache at all, perform a full rescan in case it was added after
 *    startup.
 * 2. `getAllSkills()` — return all currently cached skills.
 * 3. `reload()` — full rescan of the skills directory.
 * 4. `getErrors()` — return parse errors from the most recent scan.
 *
 * @param skillsDir - Absolute path to the skills root directory
 */
export function createSkillsManager(skillsDir: string) {
  const resolvedDir = resolve(skillsDir);

  /** name -> SkillDefinition */
  const skillsMap = new Map<string, SkillDefinition>();

  /** name -> mtimeMs of SKILL.md when last parsed */
  const mtimes = new Map<string, number>();

  /** Errors from the most recent scan */
  let lastErrors: Array<{ dir: string; error: string }> = [];

  /** Whether the initial discovery has been performed */
  let initialized = false;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Populate the cache from a DiscoveryResult. */
  async function applyResult(result: DiscoveryResult): Promise<void> {
    for (const skill of result.skills) {
      // First occurrence wins (same semantics as the reference repo)
      if (skillsMap.has(skill.name)) continue;

      skillsMap.set(skill.name, skill);

      try {
        const s = await stat(join(skill.dirPath, SKILL_FILENAME));
        mtimes.set(skill.name, s.mtimeMs);
      } catch {
        // Cannot stat — staleness checking will be unavailable for this skill
      }
    }
    lastErrors = result.errors;
  }

  /** Ensure initial discovery has run at least once. */
  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    const result = await discoverSkills(resolvedDir);
    await applyResult(result);
    initialized = true;
  }

  /**
   * Re-parse a single skill if its SKILL.md mtime has changed.
   *
   * If the skill's mtime matches the cached value the function returns
   * immediately — no disk I/O beyond a single `stat` call.
   */
  async function refreshIfStale(skillName: string): Promise<void> {
    const skill = skillsMap.get(skillName);
    if (!skill) return;

    try {
      const s = await stat(join(skill.dirPath, SKILL_FILENAME));
      const cached = mtimes.get(skillName);
      if (cached !== undefined && s.mtimeMs === cached) return;

      // Mtime changed (or was never recorded) — re-parse
      const [parsed, scripts] = await Promise.all([
        parseSkillFile(join(skill.dirPath, SKILL_FILENAME)),
        collectScripts(skill.dirPath),
      ]);

      const updated: SkillDefinition = {
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        dirPath: skill.dirPath,
        scripts,
        frontmatter: parsed.frontmatter,
      };

      skillsMap.set(skillName, updated);
      mtimes.set(skillName, s.mtimeMs);
    } catch {
      // stat or parse failed — keep the existing cached version
    }
  }

  /**
   * Full rescan: discover all skills and merge any new ones into the cache.
   * Existing entries are *not* overwritten (first-seen wins), so this is
   * safe to call at any time.
   */
  async function rediscover(): Promise<DiscoveryResult> {
    const result = await discoverSkills(resolvedDir);
    await applyResult(result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Get a single skill by name.
     *
     * - If the skill is cached, its SKILL.md mtime is checked and it is
     *   re-parsed when stale.
     * - If the skill is not in the cache, a full rescan is triggered in
     *   case the directory was added after the manager was created.
     * - Returns `null` if the skill cannot be found even after rescanning.
     */
    async getSkill(name: string): Promise<SkillDefinition | null> {
      await ensureInitialized();

      let skill = skillsMap.get(name);
      if (skill) {
        await refreshIfStale(name);
        return skillsMap.get(name) ?? null;
      }

      // Not found — maybe it was added since last scan
      await rediscover();
      return skillsMap.get(name) ?? null;
    },

    /**
     * Return all currently cached skills.
     *
     * Does *not* re-check staleness for every skill — call `reload()` to
     * force a full rescan, or use `getSkill()` for on-demand freshness.
     */
    async getAllSkills(): Promise<SkillDefinition[]> {
      await ensureInitialized();
      return [...skillsMap.values()];
    },

    /**
     * Clear the cache and perform a full rescan of the skills directory.
     */
    async reload(): Promise<DiscoveryResult> {
      skillsMap.clear();
      mtimes.clear();
      initialized = false;
      const result = await discoverSkills(resolvedDir);
      await applyResult(result);
      initialized = true;
      return result;
    },

    /**
     * Return errors from the most recent discovery scan.
     */
    getErrors(): Array<{ dir: string; error: string }> {
      return [...lastErrors];
    },
  };
}
