/**
 * Two-tier in-memory judgment cache (R7 / KTD "Cache is in-memory only").
 *
 * - `relevance` tier: keyed on `(sha256(query), sha256(goal ?? ""), url)`,
 *   TTL ~15min. Relevance (and the other per-result scores judged alongside
 *   it, e.g. worth_fetching) depend on the query/goal pairing, so they are
 *   scoped to it.
 * - `credibility` tier: keyed on `(domain, rubric_version)`, TTL ~24h.
 *   Credibility is a property of the domain, not the query — it stays valid
 *   across queries and URLs on the same domain.
 *
 * Eviction is lazy: a read past TTL deletes the entry and reports a miss: no
 * background sweep. `put*` always overwrites — a fresh judgment supersedes
 * whatever was cached, regardless of the incoming judgment's own age.
 * Nothing here is persisted to disk; the cache does not survive a restart.
 */

import { createHash } from "node:crypto";

/** A cached judgment: raw scores only. Gate thresholds apply at read time. */
export interface CacheEntry<TScores = Record<string, unknown>> {
  readonly scores: TScores;
  readonly confidence: number;
  readonly rubric_version: string;
  readonly judged_at: number;
}

export interface CacheOptions {
  /** Relevance tier TTL in ms. Default 15 minutes. */
  readonly relevanceTtlMs?: number;
  /** Credibility tier TTL in ms. Default 24 hours. */
  readonly credibilityTtlMs?: number;
  /** Injectable clock, for deterministic TTL tests. Default `Date.now`. */
  readonly now?: () => number;
}

export interface ScoreCache {
  getRelevance(query: string, goal: string | undefined, url: string): CacheEntry | undefined;
  putRelevance(query: string, goal: string | undefined, url: string, entry: CacheEntry): void;
  getCredibility(domain: string, rubricVersion: string): CacheEntry | undefined;
  putCredibility(domain: string, rubricVersion: string, entry: CacheEntry): void;
}

const DEFAULT_RELEVANCE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CREDIBILITY_TTL_MS = 24 * 60 * 60 * 1000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function relevanceKey(query: string, goal: string | undefined, url: string): string {
  return `${sha256(query)}:${sha256(goal ?? "")}:${url}`;
}

function credibilityKey(domain: string, rubricVersion: string): string {
  return `${domain}:${rubricVersion}`;
}

interface StoredEntry {
  readonly entry: CacheEntry;
  readonly expiresAt: number;
}

export function createCache(options: CacheOptions = {}): ScoreCache {
  const relevanceTtlMs = options.relevanceTtlMs ?? DEFAULT_RELEVANCE_TTL_MS;
  const credibilityTtlMs = options.credibilityTtlMs ?? DEFAULT_CREDIBILITY_TTL_MS;
  const now = options.now ?? Date.now;

  const relevanceStore = new Map<string, StoredEntry>();
  const credibilityStore = new Map<string, StoredEntry>();

  function read(store: Map<string, StoredEntry>, key: string): CacheEntry | undefined {
    const stored = store.get(key);
    if (stored === undefined) return undefined;
    if (stored.expiresAt <= now()) {
      // Lazy eviction: expired entries are dropped on the read that finds them.
      store.delete(key);
      return undefined;
    }
    return stored.entry;
  }

  function write(
    store: Map<string, StoredEntry>,
    key: string,
    entry: CacheEntry,
    ttlMs: number,
  ): void {
    // Always overwrites — a fresh judgment supersedes any cached one.
    store.set(key, { entry, expiresAt: now() + ttlMs });
  }

  return {
    getRelevance(query, goal, url) {
      return read(relevanceStore, relevanceKey(query, goal, url));
    },
    putRelevance(query, goal, url, entry) {
      write(relevanceStore, relevanceKey(query, goal, url), entry, relevanceTtlMs);
    },
    getCredibility(domain, rubricVersion) {
      return read(credibilityStore, credibilityKey(domain, rubricVersion));
    },
    putCredibility(domain, rubricVersion, entry) {
      write(credibilityStore, credibilityKey(domain, rubricVersion), entry, credibilityTtlMs);
    },
  };
}
