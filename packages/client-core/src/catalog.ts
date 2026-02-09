import type { SkillSummary } from "./types.js";

/**
 * Build a markdown skills catalog for system-prompt injection.
 *
 * Returns empty string if the skills array is empty.
 */
export function buildCatalog(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map((s) => {
    const desc = s.description ?? "(no description)";
    const scripts = s.scripts.length > 0 ? s.scripts.join(", ") : "none";
    return `- **${s.name}**: ${desc} [scripts: ${scripts}]`;
  });

  return (
    "## Available Skills\n\n" +
    "Use `load_skill` to read a skill's full instructions before using it.\n\n" +
    lines.join("\n")
  );
}
