// CCR = Compress-Cache-Retrieve: a reversible, hash-addressable store that
// keeps the true original of any value ContextPilot compresses, so the model
// (or the host app) can always recover it later via `get_tool_response`.

import { createHash } from "node:crypto";

type CCREntry = {
  value: unknown;
  storedAt: number;
  ttlMs: number;
};

export class CCRStore {
  private entries = new Map<string, CCREntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.defaultTtlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 500;
  }

  /** Stores `value` and returns a short content hash that can be used to retrieve it later. */
  store(value: unknown, ttlMs?: number): string {
    const hash = CCRStore.hashOf(value);
    this.entries.delete(hash); // re-insert refreshes LRU-ish ordering for eviction
    this.entries.set(hash, { value, storedAt: Date.now(), ttlMs: ttlMs ?? this.defaultTtlMs });
    this.evictIfNeeded();
    return hash;
  }

  /** Returns the original value for `hash`, or `undefined` if missing/expired. */
  retrieve(hash: string): unknown | undefined {
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > entry.ttlMs) {
      this.entries.delete(hash);
      return undefined;
    }
    return entry.value;
  }

  has(hash: string): boolean {
    return this.retrieve(hash) !== undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  static hashOf(value: unknown): string {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return createHash("sha1").update(serialized).digest("hex").slice(0, 16);
  }
}
