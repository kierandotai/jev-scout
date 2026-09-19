/**
 * Same-process HTTP dashboard (U7 / R9, KTD "stdout is sacred").
 *
 * All dashboard logging goes to stderr only — stdout carries nothing but
 * MCP JSON-RPC, and this module never writes to it.
 *
 * Routes:
 *   GET /              -> dashboard.html (static file, read once at startup)
 *   GET /events        -> SSE feed of ledger events: ring buffer of the last
 *                          200 replayed on connect (or since `Last-Event-ID`),
 *                          then live-streamed; 25s unref'd heartbeat comment.
 *   GET /api/summary   -> JSON aggregates for initial paint: event counts,
 *                          total Jev cost, per-domain credibility rows,
 *                          session start ts, and `lastEventId` — the SSE
 *                          sequence id these aggregates already account for.
 *                          The client uses `lastEventId` to avoid double-
 *                          counting a replayed SSE event into a running
 *                          total the summary snapshot already includes.
 *
 * DNS-rebinding defense: every request's Host header must equal exactly
 * `127.0.0.1:<bound-port>` (rejected with a bare 403 otherwise). This
 * REJECTS `localhost:<port>` too, on purpose — the dashboard only ever
 * prints/returns a 127.0.0.1 URL, so there's no UX loss, and accepting a
 * second hostname would just be a second name an attacker's DNS response
 * could rebind to this origin.
 *
 * Process-exit discipline (KTD): the listener and every accepted socket are
 * `unref()`'d so a live dashboard never keeps the process alive on its own.
 * `close()` calls `closeAllConnections()` before the promisified
 * `server.close()` — `close()` alone waits forever on open SSE streams.
 * Each SSE connection's heartbeat timer is `unref()`'d and cleared when
 * that connection closes.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Ledger, LedgerEvent } from "./ledger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RING_BUFFER_SIZE = 200;
const HEARTBEAT_MS = 25_000;

/**
 * Credibility is scored 0-2 (R3); below this counts as a "low credibility"
 * hit in the domain table. Matches config.ts's default
 * JEV_SCOUT_MIN_CREDIBILITY (1.0) — dashboard.ts intentionally doesn't take
 * a Config dependency (see the U7 export contract: `startDashboard(ledger,
 * opts?)`), so this is a fixed, documented default rather than
 * env-configurable.
 */
const LOW_CREDIBILITY_THRESHOLD = 1.0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = path.join(__dirname, "dashboard.html");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartDashboardOptions {
  readonly port?: number;
}

export interface DashboardHandle {
  readonly url: string;
  close(): Promise<void>;
}

interface RingEntry {
  readonly id: number;
  readonly event: LedgerEvent;
}

interface DomainStats {
  judgments: number;
  sumCredibility: number;
  lowCredibilityHits: number;
}

interface SummaryDomainRow {
  readonly domain: string;
  readonly judgments: number;
  readonly meanCredibility: number;
  readonly lowCredibilityHits: number;
}

interface Summary {
  readonly sessionStartTs: string;
  readonly eventCounts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly jevCallCount: number;
  readonly domains: SummaryDomainRow[];
  /** SSE sequence id these aggregates already include — see module doc. */
  readonly lastEventId: number;
}

// ---------------------------------------------------------------------------
// startDashboard
// ---------------------------------------------------------------------------

export async function startDashboard(
  ledger: Ledger,
  opts: StartDashboardOptions = {},
): Promise<DashboardHandle> {
  const html = fs.readFileSync(DASHBOARD_HTML_PATH);
  const sessionStartTs = new Date().toISOString();

  // --- Aggregated state, fed by every ledger "event" from dashboard boot
  // forward. There is no historical backfill: the ledger doesn't expose a
  // "replay everything since process start" API, so the dashboard's view
  // (like the ring buffer's) starts at the moment it subscribes. ---
  const ringBuffer: RingEntry[] = [];
  let nextId = 0;
  const eventCounts: Record<string, number> = { search: 0, result: 0, fetch: 0, gate: 0, budget: 0 };
  let totalCostUsd = 0;
  let jevCallCount = 0;
  const domains = new Map<string, DomainStats>();

  const sseClients = new Set<http.ServerResponse>();

  function buildSummary(): Summary {
    const domainRows: SummaryDomainRow[] = [];
    for (const [domain, stats] of domains) {
      domainRows.push({
        domain,
        judgments: stats.judgments,
        meanCredibility: stats.judgments === 0 ? 0 : stats.sumCredibility / stats.judgments,
        lowCredibilityHits: stats.lowCredibilityHits,
      });
    }
    domainRows.sort((a, b) => b.lowCredibilityHits - a.lowCredibilityHits || b.judgments - a.judgments);
    return {
      sessionStartTs,
      eventCounts: { ...eventCounts },
      totalCostUsd,
      jevCallCount,
      domains: domainRows,
      lastEventId: nextId,
    };
  }

  function safeWrite(res: http.ServerResponse, chunk: string): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      // Socket may have died between the writableEnded check and write();
      // the client's own "close" handler will clean up sseClients/timers.
    }
  }

  function onLedgerEvent(record: LedgerEvent): void {
    nextId += 1;
    const id = nextId;
    ringBuffer.push({ id, event: record });
    if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();

    eventCounts[record.type] = (eventCounts[record.type] ?? 0) + 1;
    if (record.jev !== undefined) {
      jevCallCount += 1;
      totalCostUsd += record.jev.cost_usd;
    }
    if (record.type === "result") {
      const payload = record.payload as Record<string, unknown>;
      const domain = typeof payload.domain === "string" ? payload.domain : undefined;
      const credibility = typeof payload.credibility === "number" ? payload.credibility : undefined;
      if (domain !== undefined && credibility !== undefined) {
        const stats = domains.get(domain) ?? { judgments: 0, sumCredibility: 0, lowCredibilityHits: 0 };
        stats.judgments += 1;
        stats.sumCredibility += credibility;
        if (credibility < LOW_CREDIBILITY_THRESHOLD) stats.lowCredibilityHits += 1;
        domains.set(domain, stats);
      }
    }

    const line = `id: ${id}\ndata: ${JSON.stringify(record)}\n\n`;
    for (const res of sseClients) {
      safeWrite(res, line);
    }
  }

  ledger.on("event", onLedgerEvent);

  let boundPort = 0;

  function logRequest(req: http.IncomingMessage, status: number): void {
    process.stderr.write(`[dashboard] ${req.method ?? "?"} ${req.url ?? "?"} ${status}\n`);
  }

  function hostIsValid(req: http.IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${boundPort}`;
  }

  const server = http.createServer((req, res) => {
    if (!hostIsValid(req)) {
      res.writeHead(403);
      res.end();
      logRequest(req, 403);
      return;
    }

    const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);

    if (req.method === "GET" && reqUrl.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      logRequest(req, 200);
      return;
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/summary") {
      const body = JSON.stringify(buildSummary());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
      logRequest(req, 200);
      return;
    }

    if (req.method === "GET" && reqUrl.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();
      res.on("error", () => {
        // A destroyed socket (e.g. from closeAllConnections()) can emit an
        // async write error after the synchronous safeWrite() guard passed;
        // swallow it here so it never becomes an unhandled 'error' crash.
      });

      const lastEventIdHeader = req.headers["last-event-id"];
      const afterIdRaw = typeof lastEventIdHeader === "string" ? Number(lastEventIdHeader) : NaN;
      const replayFrom = Number.isFinite(afterIdRaw) ? afterIdRaw : 0;

      for (const entry of ringBuffer) {
        if (entry.id > replayFrom) {
          safeWrite(res, `id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
        }
      }

      sseClients.add(res);

      const heartbeat = setInterval(() => {
        safeWrite(res, ": heartbeat\n\n");
      }, HEARTBEAT_MS);
      heartbeat.unref();

      res.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });

      logRequest(req, 200);
      return;
    }

    res.writeHead(404);
    res.end();
    logRequest(req, 404);
  });

  server.unref();
  server.on("connection", (socket) => {
    socket.unref();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  boundPort = typeof address === "object" && address !== null ? address.port : 0;

  const url = `http://127.0.0.1:${boundPort}`;
  process.stderr.write(`[dashboard] listening at ${url}\n`);

  async function close(): Promise<void> {
    ledger.removeListener("event", onLedgerEvent);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { url, close };
}
