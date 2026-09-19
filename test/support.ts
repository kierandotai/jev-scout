/**
 * Shared test helpers. Not itself a test file — the suite glob
 * (`test/*.test.ts`) skips it, so `node --test` never tries to run it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Stub `globalThis.fetch` for the duration of `run()`, then restore it. */
export function withStubbedFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** A fresh temp directory under the OS tmpdir, named `jev-scout-<prefix>-*`. */
export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jev-scout-${prefix}-`));
}
