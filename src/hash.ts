/**
 * Shared sha256 hex-digest helper. Used by cache.ts (cache-key hashing of
 * query/goal text) and ledger.ts (`contentHash` — page bodies are never
 * logged raw, only their hash). A tiny, dependency-free utility module so
 * neither of those peer modules has to import the other just to hash text.
 */

import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
