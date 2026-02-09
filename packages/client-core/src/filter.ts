/**
 * Simple glob matching supporting * and ? wildcards.
 */
function matchGlob(str: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(str);
}

/**
 * Test if a skill name passes include/exclude glob filters.
 *
 * - If `exclude` matches, the skill is rejected.
 * - If `include` is provided, the skill must match at least one pattern.
 * - If neither is provided, the skill is accepted.
 */
export function matchesFilter(
  name: string,
  include?: string[],
  exclude?: string[],
): boolean {
  if (exclude?.length && exclude.some((p) => matchGlob(name, p))) return false;
  if (include?.length) return include.some((p) => matchGlob(name, p));
  return true;
}
