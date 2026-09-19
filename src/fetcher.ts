/**
 * Safe page fetching (R4 / KTD "stdout is sacred" is unrelated; this is the
 * SSRF + body-safety KTD).
 *
 * Order of operations, strictly: SSRF guard FIRST (parse + protocol check +
 * DNS resolve + address classification), on every hop including the first —
 * only once a hop clears the guard does any network I/O happen for it. Then:
 * honest UA, a timeout, a Content-Type allowlist checked BEFORE the body is
 * read, a streamed byte cap that never trusts Content-Length, tag-stripping,
 * and a fixed excerpt truncation with a `truncated` flag.
 *
 * `fetchPage` never throws on an HTTP-level failure (4xx/5xx) or a fetch
 * mechanics failure (timeout, network, oversized body, ...) — every failure
 * mode is a typed `{ok: false, reason, detail}` result. `isForbiddenAddress`
 * is exported as a pure function precisely so address-classification logic
 * can be unit tested without any DNS involved.
 */

import { isIP } from "node:net";
import { promises as dns } from "node:dns";

import { contentHash } from "./ledger.ts";

// ---------------------------------------------------------------------------
// Address classification (pure — no DNS, no I/O)
// ---------------------------------------------------------------------------

/**
 * True when `ip` (an IPv4 or IPv6 address literal) falls in a range that
 * must never be fetched: loopback, RFC1918 private, link-local (including
 * the cloud metadata address 169.254.169.254), multicast, unspecified,
 * IPv6 unique-local, or an IPv4-mapped IPv6 address in any of the above.
 * An unparseable string is treated as forbidden (fail closed).
 */
export function isForbiddenAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isForbiddenIPv4(ip);
  if (family === 6) return isForbiddenIPv6(ip);
  return true;
}

function isForbiddenIPv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c, d] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 — "this network" / unspecified
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local (incl. cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT shared address space
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 — multicast
  if (a >= 240) return true; // 240.0.0.0/4 — reserved for future use (includes 255.255.255.255 broadcast)
  return false;
}

/** Expand an IPv6 literal (compressed or full, with optional embedded IPv4 tail) into 8 hextet values. */
function expandIPv6Hextets(ip: string): number[] | undefined {
  const zoneIdx = ip.indexOf("%");
  const clean = zoneIdx === -1 ? ip : ip.slice(0, zoneIdx);

  const halves = clean.split("::");
  if (halves.length > 2) return undefined;

  function groupsOf(s: string): string[] {
    return s === "" ? [] : s.split(":");
  }

  function expandEmbeddedIPv4(groups: string[]): string[] | undefined {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1]!;
    if (!last.includes(".")) return groups;
    const octets = last.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return undefined;
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    return [...groups.slice(0, -1), hi, lo];
  }

  const rawHead = expandEmbeddedIPv4(groupsOf(halves[0] ?? ""));
  const rawTail = halves.length === 2 ? expandEmbeddedIPv4(groupsOf(halves[1] ?? "")) : [];
  if (rawHead === undefined || rawTail === undefined) return undefined;

  let full: string[];
  if (halves.length === 2) {
    const missing = 8 - (rawHead.length + rawTail.length);
    if (missing < 0) return undefined;
    full = [...rawHead, ...Array<string>(missing).fill("0"), ...rawTail];
  } else {
    full = rawHead;
  }
  if (full.length !== 8) return undefined;

  const values: number[] = [];
  for (const g of full) {
    if (g === "" || !/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    values.push(parseInt(g, 16));
  }
  return values;
}

function isForbiddenIPv6(ip: string): boolean {
  const hextets = expandIPv6Hextets(ip);
  if (hextets === undefined) return true;

  // IPv4-mapped (::ffff:a.b.c.d/96) and IPv4-compatible (::a.b.c.d/96,
  // deprecated) — both embed an IPv4 address in the low 32 bits. Decode the
  // whole ::/96 block (hextet 5 is 0 or 0xffff) through the IPv4 classifier
  // rather than blanket-forbidding it, since e.g. ::203.0.113.5 is public.
  if (
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 &&
    hextets[4] === 0 && (hextets[5] === 0 || hextets[5] === 0xffff)
  ) {
    const h6 = hextets[6]!;
    const h7 = hextets[7]!;
    const a = (h6 >> 8) & 0xff;
    const b = h6 & 0xff;
    const c = (h7 >> 8) & 0xff;
    const d = h7 & 0xff;
    return isForbiddenIPv4(`${a}.${b}.${c}.${d}`);
  }

  // 64:ff9b::/96 — the well-known NAT64 translation prefix. Blanket-forbidden
  // (not decoded): its entire purpose is synthesizing IPv6 addresses from
  // arbitrary IPv4 ones at the resolver, so the embedded address cannot be
  // trusted as a proxy for what the classifier would say about it directly.
  if (
    hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2] === 0 &&
    hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0
  ) {
    return true;
  }

  if (hextets.every((h) => h === 0)) return true; // :: — unspecified

  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true; // ::1 — loopback

  const highByte = (hextets[0]! >> 8) & 0xff;
  if (highByte === 0xfc || highByte === 0xfd) return true; // fc00::/7 — unique-local
  if (highByte === 0xff) return true; // ff00::/8 — multicast
  if (highByte === 0xfe) {
    const secondByte = hextets[0]! & 0xff;
    if (secondByte >= 0x80 && secondByte <= 0xbf) return true; // fe80::/10 — link-local
  }
  return false;
}

// ---------------------------------------------------------------------------
// SSRF guard: protocol + resolve + classify, re-run on every hop
// ---------------------------------------------------------------------------

/** Matches `dns.promises.lookup(hostname, {all: true})`'s resolved shape. */
export type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (hostname, options) => dns.lookup(hostname, options);

/**
 * The host this hop was vetted against, kept around so the pre-fetch
 * recheck (below) has something to compare its fresh lookup to.
 */
type VettedHost =
  | { readonly kind: "literal"; readonly address: string }
  | { readonly kind: "resolved"; readonly hostname: string; readonly addresses: ReadonlySet<string> };

type GuardResult =
  | { readonly ok: true; readonly vetted: VettedHost }
  | { readonly ok: false; readonly reason: "protocol" | "ssrf"; readonly detail: string };

/** Strip a bracketed IPv6 literal's `[...]` so it reaches `isIP`/`isForbiddenAddress` unwrapped. */
function unbracket(hostname: string): string {
  return hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Classify `parsed`'s host. Protocol must already have been checked by the
 * caller alongside canonicalization — this only resolves/classifies the
 * address(es). Does NOT itself hit the network beyond DNS.
 */
async function guardUrl(parsed: URL, lookup: LookupFn): Promise<GuardResult> {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "protocol", detail: `unsupported protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;
  // Bracketed IPv6 literals (e.g. "[::1]") must be unwrapped before isIP
  // sees them — otherwise they fail isIP, fall through to the DNS-lookup
  // path below, and fail closed via ENOTFOUND instead of being classified
  // directly.
  const literalCandidate = unbracket(hostname);
  if (isIP(literalCandidate) !== 0) {
    if (isForbiddenAddress(literalCandidate)) {
      return { ok: false, reason: "ssrf", detail: `forbidden address literal: ${literalCandidate}` };
    }
    return { ok: true, vetted: { kind: "literal", address: literalCandidate } };
  }

  const addrs = await resolveAndClassify(hostname, lookup, "DNS lookup");
  if (!addrs.ok) return addrs;
  return { ok: true, vetted: { kind: "resolved", hostname, addresses: new Set(addrs.addresses) } };
}

/** Shared resolve+classify used by both the initial guard and the pre-fetch recheck. */
async function resolveAndClassify(
  hostname: string,
  lookup: LookupFn,
  label: string,
): Promise<{ readonly ok: true; readonly addresses: string[] } | { readonly ok: false; readonly reason: "ssrf"; readonly detail: string }> {
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (err) {
    return { ok: false, reason: "ssrf", detail: `${label} failed for ${hostname}: ${String(err)}` };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: "ssrf", detail: `${label} returned no addresses for ${hostname}` };
  }
  const forbidden = addrs.find((a) => isForbiddenAddress(a.address));
  if (forbidden !== undefined) {
    return {
      ok: false,
      reason: "ssrf",
      detail: `${hostname} resolves to forbidden address ${forbidden.address}`,
    };
  }
  return { ok: true, addresses: addrs.map((a) => a.address) };
}

/**
 * DNS-rebinding TOCTOU mitigation. `guardUrl` classifies via one DNS lookup;
 * the platform `fetch()` call below then resolves the hostname AGAIN,
 * independently, when it actually opens the connection — an attacker
 * controlling the DNS answer for `hostname` can flip it to a forbidden
 * address in between. Zero-dep constraint rules out a custom dispatcher
 * (undici) that would let us pin the connection to the exact address we
 * vetted, so full closure of the race is out of scope here (documented in
 * README). This re-runs the lookup immediately before the fetch call and
 * rejects if anything changed: a newly-resolved address is itself forbidden,
 * or the fresh address set shares nothing with the vetted one (a strong
 * rebinding signal even when every individual new address looks "clean").
 * This narrows the window from "guard to whenever fetch() resolves" down to
 * milliseconds — it does not eliminate it.
 */
async function revalidateBeforeFetch(
  vetted: VettedHost,
  lookup: LookupFn,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: "ssrf"; readonly detail: string }> {
  if (vetted.kind === "literal") {
    // No DNS involved for a literal — re-run the pure classification anyway
    // as cheap, harmless defense in depth.
    if (isForbiddenAddress(vetted.address)) {
      return { ok: false, reason: "ssrf", detail: `forbidden address literal: ${vetted.address}` };
    }
    return { ok: true };
  }

  const result = await resolveAndClassify(vetted.hostname, lookup, "pre-fetch DNS re-check");
  if (!result.ok) return result;

  const disjoint = result.addresses.every((addr) => !vetted.addresses.has(addr));
  if (disjoint) {
    return {
      ok: false,
      reason: "ssrf",
      detail:
        `${vetted.hostname} re-resolved to an address set disjoint from the one vetted moments earlier ` +
        `(possible DNS rebinding): vetted=[${[...vetted.addresses].join(", ")}], now=[${result.addresses.join(", ")}]`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Body reading: stream + hard byte cap (never trust Content-Length)
// ---------------------------------------------------------------------------

async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const body = res.body;
  if (body === null) return { ok: true, text: "" };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Tag-strip: drop script/style contents entirely, collapse whitespace
// ---------------------------------------------------------------------------

const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<[^>]+>/g;
const ENTITY_RE = /&(nbsp|amp|lt|gt|quot|#39|apos);/g;
const BASIC_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function stripTags(html: string): string {
  const withoutScriptsAndStyles = html.replace(SCRIPT_STYLE_RE, " ");
  const withoutComments = withoutScriptsAndStyles.replace(COMMENT_RE, " ");
  const withoutTags = withoutComments.replace(TAG_RE, " ");
  const decoded = withoutTags.replace(ENTITY_RE, (m) => BASIC_ENTITIES[m] ?? m);
  return decoded.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// fetchPage
// ---------------------------------------------------------------------------

export interface FetchPageOptions {
  /** Injectable DNS resolver, default `dns.promises.lookup`. */
  readonly lookup?: LookupFn;
  /** Per-hop request timeout in ms. Default 10_000. */
  readonly timeoutMs?: number;
  /** Hard byte cap on the streamed body. Default 2MB. */
  readonly maxBytes?: number;
  /** Max redirect hops to follow. Default 5. */
  readonly maxRedirects?: number;
  /** Excerpt truncation length in chars. Default 24_000. */
  readonly maxExcerptChars?: number;
  readonly userAgent?: string;
}

export type FetchFailureReason =
  | "ssrf"
  | "protocol"
  | "content_type"
  | "too_large"
  | "timeout"
  | "http_error"
  | "network"
  | "redirect_limit";

export type FetchPageResult =
  | {
      readonly ok: true;
      readonly url: string;
      readonly finalUrl: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly contentHash: string;
    }
  | {
      readonly ok: false;
      readonly reason: FetchFailureReason;
      readonly detail: string;
    };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_EXCERPT_CHARS = 24_000;
const DEFAULT_USER_AGENT = "jev-scout/0.1 (+https://github.com/jev-scout/jev-scout; research fetcher)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);

/**
 * Fetch a page, SSRF-safe. Resolves and classifies the hostname's address(es)
 * BEFORE any connection is made, on the initial URL and on every redirect
 * hop's Location header (manual redirects, capped). Never throws — every
 * failure mode surfaces as a typed `{ok: false, reason, detail}`.
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const lookup = opts.lookup ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxExcerptChars = opts.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  let currentUrl = url;
  let hopsFollowed = 0;

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, reason: "protocol", detail: `unparseable URL: ${currentUrl}` };
    }
    // Canonicalize this hop to the WHATWG-normalized, percent-encoded form.
    // This alone neutralizes delimiter bytes (e.g. "<", ">") an attacker
    // embeds in the URL, before finalUrl ever reaches judge.ts's untrusted
    // state wrapping.
    currentUrl = parsed.toString();

    // SSRF guard FIRST — nothing below this line runs until the hop clears it.
    const guard = await guardUrl(parsed, lookup);
    if (!guard.ok) return { ok: false, reason: guard.reason, detail: guard.detail };

    // Re-check immediately before the network call — see revalidateBeforeFetch.
    const recheck = await revalidateBeforeFetch(guard.vetted, lookup);
    if (!recheck.ok) return { ok: false, reason: recheck.reason, detail: recheck.detail };

    let res: Response;
    try {
      res = await fetch(currentUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return {
          ok: false,
          reason: "timeout",
          detail: `request to ${currentUrl} timed out after ${timeoutMs}ms`,
        };
      }
      return { ok: false, reason: "network", detail: `network error fetching ${currentUrl}: ${String(err)}` };
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (location === null || location === "") {
        return {
          ok: false,
          reason: "http_error",
          detail: `redirect status ${res.status} from ${currentUrl} had no Location header`,
        };
      }
      if (hopsFollowed >= maxRedirects) {
        return { ok: false, reason: "redirect_limit", detail: `exceeded ${maxRedirects} redirect hops` };
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        return { ok: false, reason: "protocol", detail: `redirect Location is unparseable: ${location}` };
      }
      currentUrl = nextUrl;
      hopsFollowed++;
      continue; // re-runs the full SSRF guard on the new hop, from the top
    }

    if (!res.ok) {
      return {
        ok: false,
        reason: "http_error",
        detail: `${currentUrl} responded ${res.status} ${res.statusText}`,
      };
    }

    // Content-Type checked BEFORE the body is read.
    const contentType = res.headers.get("content-type") ?? "";
    const baseType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(baseType)) {
      return {
        ok: false,
        reason: "content_type",
        detail: `unsupported content-type: ${contentType || "(missing)"}`,
      };
    }

    const body = await readBodyCapped(res, maxBytes);
    if (!body.ok) {
      return { ok: false, reason: "too_large", detail: `body exceeded the ${maxBytes}-byte cap` };
    }

    const stripped = stripTags(body.text);
    const truncated = stripped.length > maxExcerptChars;
    const text = truncated ? stripped.slice(0, maxExcerptChars) : stripped;

    return {
      ok: true,
      url,
      finalUrl: currentUrl,
      text,
      truncated,
      contentHash: contentHash(stripped),
    };
  }
}
