import type { SkillSummary, SkillDetail, ExecutionResult } from "./types.js";
import { buildCatalog } from "./catalog.js";
import { matchesFilter } from "./filter.js";

export interface FilterOptions {
  include?: string[];
  exclude?: string[];
}

/**
 * HTTP client for a skills server instance.
 *
 * Wraps the three agent-facing API endpoints with authentication,
 * caches the skill list and catalog, and exposes a manual `refresh()`.
 */
export class SkillsClient {
  private baseUrl: string;
  private apiKey: string;

  /** Cached skill list from the last refresh(). Empty until refresh() is called. */
  skills: SkillSummary[] = [];

  /** Markdown catalog built from the cached skill list. Empty until refresh(). */
  skillsCatalog = "";

  constructor(serverUrl: string, apiKey: string) {
    this.baseUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Authenticated fetch against the skills server.
   * Throws on network errors and non-2xx responses.
   */
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: string };
        detail = body.error ?? "";
      } catch {
        detail = res.statusText;
      }
      throw new Error(`Skills server ${res.status}: ${detail || res.statusText}`);
    }

    return (await res.json()) as T;
  }

  /** GET /api/v1/skills — list all skills visible to this agent. */
  async listSkills(): Promise<SkillSummary[]> {
    return this.request<SkillSummary[]>("/api/v1/skills");
  }

  /** GET /api/v1/skills/{name} — full skill content and metadata. */
  async loadSkill(name: string): Promise<SkillDetail> {
    return this.request<SkillDetail>(
      `/api/v1/skills/${encodeURIComponent(name)}`,
    );
  }

  /** POST /api/v1/skills/{name}/execute — run a script. */
  async executeSkill(
    name: string,
    script: string,
    args: string[] = [],
  ): Promise<ExecutionResult> {
    return this.request<ExecutionResult>(
      `/api/v1/skills/${encodeURIComponent(name)}/execute`,
      {
        method: "POST",
        body: JSON.stringify({ script, args }),
      },
    );
  }

  /**
   * Re-fetch the skill list from the server and rebuild the cached catalog.
   *
   * Accepts optional include/exclude filters applied to the fetched list.
   * Call this when permissions change or skills are added/removed.
   */
  async refresh(options: FilterOptions = {}): Promise<void> {
    const all = await this.listSkills();
    this.skills = all.filter((s) =>
      matchesFilter(s.name, options.include, options.exclude),
    );
    this.skillsCatalog = buildCatalog(this.skills);
  }
}
