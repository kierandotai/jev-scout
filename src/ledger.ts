/**
 * JSONL observability ledger (R8 / KTD "the ledger persists across sessions
 * in daily files").
 *
 * One line per event in `<dir>/ledger-YYYY-MM-DD.jsonl`. Callers own keeping
 * page bodies out of `payload` — the ledger does not (cannot) inspect
 * arbitrary payload shapes for raw text, it only guarantees not to add any
 * itself. `contentHash()` is the helper callers use to turn page content into
 * something safe to log: a sha256 hex digest, never the text itself.
 *
 * Past a per-day byte budget (default 50MB, injectable), further events keep
 * being appended — search_id, type, ts, jev, latency_ms all still land, so
 * counters and the event stream stay intact — but `payload` is replaced with
 * `{ omitted: true }` to stop the file from growing unbounded.
 *
 * Every appended record (after any size-guard omission) is also emitted as
 * an `"event"` on the returned EventEmitter, for the dashboard's SSE feed.
 *
 * The ledger directory is created lazily, on first append — never at
 * `createLedger()` time — and is injectable so tests point it at a tmp dir.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sha256Hex } from "./hash.ts";

export type LedgerEventType = "search" | "result" | "fetch" | "gate" | "budget";

/** Jev cost/usage accounting attached to an event, when the event involved a Jev call. */
export interface LedgerJev {
  readonly cost_usd: number;
  readonly [key: string]: unknown;
}

/** What a caller passes to `append()` — the ledger stamps `ts`. */
export interface LedgerEventInput {
  readonly session: string;
  readonly search_id: string;
  readonly type: LedgerEventType;
  /** Metadata and scores only. NEVER page bodies — use `contentHash()` for content. */
  readonly payload: Record<string, unknown>;
  readonly jev?: LedgerJev | undefined;
  readonly latency_ms?: number | undefined;
}

/** What actually lands on disk (and is emitted) — `payload` may be `{omitted: true}`. */
export interface LedgerEvent {
  readonly ts: string;
  readonly session: string;
  readonly search_id: string;
  readonly type: LedgerEventType;
  readonly payload: Record<string, unknown> | { readonly omitted: true };
  readonly jev?: LedgerJev | undefined;
  readonly latency_ms?: number | undefined;
}

export interface LedgerOptions {
  /** Byte cap per day's file before payloads start being omitted. Default 50MB. */
  readonly maxBytesPerDay?: number;
}

export interface Ledger extends EventEmitter {
  /** Append one event; returns the record actually written (post size-guard). */
  append(event: LedgerEventInput): LedgerEvent;
  /** Sum `jev.cost_usd` across today's file — works across process restarts. */
  todaySpend(): number;
}

const DEFAULT_MAX_BYTES_PER_DAY = 50 * 1024 * 1024;

/** sha256 hex digest — the only way page content is allowed to reach the ledger. */
export function contentHash(text: string): string {
  return sha256Hex(text);
}

function defaultDir(): string {
  return path.join(os.homedir(), ".jev-scout");
}

function dateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function createLedger(dir: string = defaultDir(), options: LedgerOptions = {}): Ledger {
  const maxBytesPerDay = options.maxBytesPerDay ?? DEFAULT_MAX_BYTES_PER_DAY;
  const emitter = new EventEmitter() as Ledger;

  function filePathForToday(): string {
    return path.join(dir, `ledger-${dateStamp(new Date())}.jsonl`);
  }

  emitter.append = (input: LedgerEventInput): LedgerEvent => {
    const filePath = filePathForToday();
    fs.mkdirSync(dir, { recursive: true });

    const overCap = fileSize(filePath) >= maxBytesPerDay;
    const record: LedgerEvent = {
      ts: new Date().toISOString(),
      session: input.session,
      search_id: input.search_id,
      type: input.type,
      payload: overCap ? { omitted: true } : input.payload,
      ...(input.jev === undefined ? {} : { jev: input.jev }),
      ...(input.latency_ms === undefined ? {} : { latency_ms: input.latency_ms }),
    };

    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    emitter.emit("event", record);
    return record;
  };

  emitter.todaySpend = (): number => {
    const filePath = filePathForToday();
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return 0;
    }
    let total = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as LedgerEvent;
        const cost = record.jev?.cost_usd;
        if (typeof cost === "number") total += cost;
      } catch {
        // Skip malformed lines rather than failing the whole scan.
      }
    }
    return total;
  };

  return emitter;
}
