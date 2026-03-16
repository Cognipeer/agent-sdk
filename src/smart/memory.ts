import type {
  MemoryFact,
  MemoryReadPolicy,
  MemoryScope,
  MemoryStore,
  ResolvedSmartAgentConfig,
  StructuredSummary,
} from "../types.js";

type ScopeMap = Map<MemoryScope, MemoryFact[]>;

function normalizeFact(scope: MemoryScope, fact: MemoryFact): MemoryFact {
  return {
    ...fact,
    scope,
    obsolete: fact.obsolete ?? false,
    lastUpdatedAt: fact.lastUpdatedAt ?? new Date().toISOString(),
    confidence: Number.isFinite(fact.confidence) ? fact.confidence : 0.5,
  };
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly buckets: ScopeMap = new Map();

  async get(scope: MemoryScope, options?: { includeObsolete?: boolean; limit?: number }): Promise<MemoryFact[]> {
    const includeObsolete = options?.includeObsolete === true;
    const all = [...(this.buckets.get(scope) || [])]
      .filter((fact) => includeObsolete || !fact.obsolete)
      .sort((left, right) => new Date(right.lastUpdatedAt || 0).getTime() - new Date(left.lastUpdatedAt || 0).getTime());
    return typeof options?.limit === "number" ? all.slice(0, options.limit) : all;
  }

  async upsert(scope: MemoryScope, facts: MemoryFact[]): Promise<void> {
    const existing = [...(this.buckets.get(scope) || [])];

    for (const fact of facts) {
      const normalized = normalizeFact(scope, fact);
      const sameKey = existing.filter((entry) => entry.key === normalized.key && !entry.obsolete);
      for (const entry of sameKey) {
        if (entry.value !== normalized.value) {
          entry.obsolete = true;
          entry.lastUpdatedAt = new Date().toISOString();
        }
      }

      const match = existing.find((entry) => entry.key === normalized.key && entry.value === normalized.value && !entry.obsolete);
      if (match) {
        match.confidence = Math.max(match.confidence, normalized.confidence);
        match.sourceTurn = normalized.sourceTurn;
        match.ttl = normalized.ttl;
        match.tags = normalized.tags;
        match.lastUpdatedAt = normalized.lastUpdatedAt;
      } else {
        existing.push(normalized);
      }
    }

    this.buckets.set(scope, existing);
  }

  async markObsolete(scope: MemoryScope, keys: string[]): Promise<void> {
    const bucket = this.buckets.get(scope) || [];
    const now = new Date().toISOString();
    for (const fact of bucket) {
      if (keys.includes(fact.key)) {
        fact.obsolete = true;
        fact.lastUpdatedAt = now;
      }
    }
    this.buckets.set(scope, bucket);
  }

  async semanticSearch(scope: MemoryScope, query: string, options?: { limit?: number }): Promise<MemoryFact[]> {
    const normalizedQuery = query.toLowerCase();
    const bucket = (this.buckets.get(scope) || []).filter((fact) => !fact.obsolete);
    const scored = bucket
      .map((fact) => {
        const haystack = `${fact.key} ${fact.value} ${(fact.tags || []).join(" ")}`.toLowerCase();
        const score = haystack.includes(normalizedQuery) ? 2 : normalizedQuery.split(/\s+/).filter(Boolean).reduce((acc, token) => acc + (haystack.includes(token) ? 1 : 0), 0);
        return { fact, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.fact.confidence - left.fact.confidence)
      .map((entry) => entry.fact);
    return typeof options?.limit === "number" ? scored.slice(0, options.limit) : scored;
  }
}

export function resolveMemoryStore(config: ResolvedSmartAgentConfig): MemoryStore | undefined {
  if (config.memory.store) return config.memory.store;
  if (config.memory.provider === "inMemory") return new InMemoryMemoryStore();
  return undefined;
}

export async function readMemoryFacts(
  store: MemoryStore | undefined,
  config: ResolvedSmartAgentConfig,
  query: string,
): Promise<MemoryFact[]> {
  if (!store) return [];
  const scope = config.memory.scope;
  const limit = config.context.lastTurnsToKeep;
  const policy: MemoryReadPolicy = config.memory.readPolicy;

  if (policy === "recent_only") {
    return store.get(scope, { limit });
  }

  if (policy === "semantic" && typeof store.semanticSearch === "function") {
    return store.semanticSearch(scope, query, { limit });
  }

  if (policy === "hybrid") {
    const recent = await store.get(scope, { limit: Math.max(3, Math.ceil(limit / 2)) });
    const semantic = typeof store.semanticSearch === "function"
      ? await store.semanticSearch(scope, query, { limit: Math.max(3, Math.ceil(limit / 2)) })
      : [];
    const deduped = new Map<string, MemoryFact>();
    for (const fact of [...semantic, ...recent]) {
      deduped.set(`${fact.key}:${fact.value}`, fact);
    }
    return [...deduped.values()].slice(0, limit);
  }

  return store.get(scope, { limit });
}

export async function writeSummaryFactsToMemory(
  store: MemoryStore | undefined,
  config: ResolvedSmartAgentConfig,
  summary: StructuredSummary | undefined,
  sourceTurn: number,
): Promise<MemoryFact[]> {
  if (!store || !summary) return [];

  const facts: MemoryFact[] = summary.stable_facts.map((fact) => ({
    key: fact.key,
    value: fact.value,
    sourceTurn,
    confidence: fact.confidence ?? 0.8,
    obsolete: false,
    tags: ["summary_fact"],
  }));

  if (summary.discarded_obsolete.length > 0) {
    await store.markObsolete(config.memory.scope, summary.discarded_obsolete);
  }

  if (facts.length > 0) {
    await store.upsert(config.memory.scope, facts);
  }

  return store.get(config.memory.scope, { limit: config.context.lastTurnsToKeep + summary.stable_facts.length });
}

export function renderMemoryFacts(facts: MemoryFact[]): string {
  if (facts.length === 0) return "";
  return [
    "Memory facts:",
    ...facts.map((fact) => `- ${fact.key}: ${fact.value} (confidence ${fact.confidence.toFixed(2)})`),
  ].join("\n");
}