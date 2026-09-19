import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchPage, isForbiddenAddress, type LookupFn } from "../src/fetcher.ts";

function withStubbedFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function lookupResolvingTo(...addresses: { address: string; family: number }[]): LookupFn {
  return async () => addresses;
}

// ---------------------------------------------------------------------------
// isForbiddenAddress: pure classification, no DNS
// ---------------------------------------------------------------------------

test("isForbiddenAddress rejects loopback, private, link-local, multicast, unspecified", () => {
  const forbidden = [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fc00::1",
    "0.0.0.0",
  ];
  for (const ip of forbidden) {
    assert.equal(isForbiddenAddress(ip), true, `${ip} should be forbidden`);
  }
});

test("isForbiddenAddress allows ordinary public addresses", () => {
  const allowed = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
  for (const ip of allowed) {
    assert.equal(isForbiddenAddress(ip), false, `${ip} should be allowed`);
  }
});

test("isForbiddenAddress covers 172.16.0.0/12 boundaries and rejects unparseable input", () => {
  assert.equal(isForbiddenAddress("172.15.255.255"), false, "just below the /12 range");
  assert.equal(isForbiddenAddress("172.32.0.0"), false, "just above the /12 range");
  assert.equal(isForbiddenAddress("172.31.255.255"), true, "top of the /12 range");
  assert.equal(isForbiddenAddress("not-an-ip"), true, "unparseable input fails closed");
});

test("isForbiddenAddress rejects IPv4-mapped IPv6 loopback/private addresses", () => {
  assert.equal(isForbiddenAddress("::ffff:127.0.0.1"), true);
  assert.equal(isForbiddenAddress("::ffff:10.0.0.5"), true);
  assert.equal(isForbiddenAddress("::ffff:93.184.216.34"), false);
});

// ---------------------------------------------------------------------------
// fetchPage: SSRF guard (DNS-injected)
// ---------------------------------------------------------------------------

test("fetchPage rejects when the injected lookup resolves to a private address", async () => {
  let fetchCalled = false;
  await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called once SSRF guard rejects");
    }) as typeof fetch,
    async () => {
      const result = await fetchPage("http://internal.example.com/", {
        lookup: lookupResolvingTo({ address: "10.0.0.5", family: 4 }),
      });
      assert.deepEqual(result, {
        ok: false,
        reason: "ssrf",
        detail: "internal.example.com resolves to forbidden address 10.0.0.5",
      });
    },
  );
  assert.equal(fetchCalled, false, "no network call should happen once the SSRF guard rejects");
});

test("fetchPage rejects an IP-literal URL directly, without any DNS lookup", async () => {
  let lookupCalled = false;
  const result = await fetchPage("http://169.254.169.254/latest/meta-data/", {
    lookup: async () => {
      lookupCalled = true;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "ssrf");
  assert.equal(lookupCalled, false, "IP-literal hostnames are checked directly, no DNS involved");
});

test("fetchPage rejects unsupported protocols before any DNS or network call", async () => {
  const result = await fetchPage("ftp://example.com/file", { lookup: lookupResolvingTo() });
  assert.deepEqual(result, {
    ok: false,
    reason: "protocol",
    detail: "unsupported protocol: ftp:",
  });
});

test("fetchPage follows a safe redirect hop then rejects when that hop resolves to a private address", async () => {
  const calls: string[] = [];
  const lookup: LookupFn = async (hostname) => {
    calls.push(hostname);
    if (hostname === "safe.example.com") return [{ address: "93.184.216.34", family: 4 }];
    if (hostname === "internal.example.com") return [{ address: "10.0.0.5", family: 4 }];
    throw new Error(`unexpected lookup for ${hostname}`);
  };

  await withStubbedFetch(
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "https://safe.example.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://internal.example.com/secret" },
        });
      }
      throw new Error(`fetch must not reach ${url} — SSRF guard should have rejected it first`);
    }) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/", { lookup });
      assert.deepEqual(result, {
        ok: false,
        reason: "ssrf",
        detail: "internal.example.com resolves to forbidden address 10.0.0.5",
      });
    },
  );
  assert.deepEqual(calls, ["safe.example.com", "internal.example.com"]);
});

test("fetchPage enforces the redirect hop cap", async () => {
  let hop = 0;
  await withStubbedFetch(
    (async () => {
      hop++;
      return new Response(null, { status: 302, headers: { location: `https://safe.example.com/${hop}` } });
    }) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/0", {
        lookup: lookupResolvingTo({ address: "93.184.216.34", family: 4 }),
        maxRedirects: 2,
      });
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "redirect_limit");
    },
  );
  // 1 initial + 2 followed redirects = 3 fetch attempts before the cap trips.
  assert.equal(hop, 3);
});

// ---------------------------------------------------------------------------
// fetchPage: body safety
// ---------------------------------------------------------------------------

const SAFE_LOOKUP = lookupResolvingTo({ address: "93.184.216.34", family: 4 });

test("fetchPage aborts a stream that exceeds the byte cap, without trusting Content-Length", async () => {
  await withStubbedFetch(
    (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("x".repeat(40)));
          controller.enqueue(encoder.encode("y".repeat(40)));
          controller.enqueue(encoder.encode("z".repeat(40)));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "1" },
      });
    }) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/big", {
        lookup: SAFE_LOOKUP,
        maxBytes: 50,
      });
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "too_large");
    },
  );
});

test("fetchPage rejects application/pdf before reading the body", async () => {
  let readerRequested = false;
  await withStubbedFetch(
    (async () => {
      const res = new Response(new ReadableStream(), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
      // Track whether fetchPage's own code ever asks for a reader — the
      // stream's spec-mandated internal `pull` prefetch (independent of any
      // consumer) is not a signal we control or care about here.
      const realGetReader = res.body!.getReader.bind(res.body);
      res.body!.getReader = () => {
        readerRequested = true;
        return realGetReader();
      };
      return res;
    }) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/doc.pdf", { lookup: SAFE_LOOKUP });
      assert.deepEqual(result, {
        ok: false,
        reason: "content_type",
        detail: "unsupported content-type: application/pdf",
      });
    },
  );
  assert.equal(readerRequested, false, "fetchPage must never request a body reader once content-type is rejected");
});

test("fetchPage surfaces a timeout as a typed result", async () => {
  await withStubbedFetch(
    (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation timed out.", "TimeoutError"));
        });
      })) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/slow", {
        lookup: SAFE_LOOKUP,
        timeoutMs: 20,
      });
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "timeout");
    },
  );
});

test("fetchPage never throws on an HTTP error status; returns a typed http_error result", async () => {
  await withStubbedFetch(
    (async () => new Response("not found", { status: 404, statusText: "Not Found" })) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/missing", { lookup: SAFE_LOOKUP });
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "http_error");
    },
  );
});

test("fetchPage surfaces a raw network failure as a typed network result", async () => {
  await withStubbedFetch(
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/", { lookup: SAFE_LOOKUP });
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "network");
    },
  );
});

// ---------------------------------------------------------------------------
// fetchPage: happy path — strip, truncate, hash
// ---------------------------------------------------------------------------

test("fetchPage strips script/style contents, collapses whitespace, and reports truncated:false under the cap", async () => {
  const html = `
    <html><head><style>body { color: red; }</style><script>alert(1)</script></head>
    <body>
      <h1>Hello   World</h1>
      <!-- a comment -->
      <p>Some <b>bold</b>\n\ntext &amp; more.</p>
    </body></html>
  `;
  await withStubbedFetch(
    (async () => htmlResponse(html)) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/page", { lookup: SAFE_LOOKUP });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.text, "Hello World Some bold text & more.");
      assert.equal(result.truncated, false);
      assert.equal(result.url, "https://safe.example.com/page");
      assert.equal(result.finalUrl, "https://safe.example.com/page");
      assert.match(result.contentHash, /^[0-9a-f]{64}$/);
      assert.ok(!result.text.includes("alert(1)"), "script contents must be dropped entirely");
      assert.ok(!result.text.includes("color: red"), "style contents must be dropped entirely");
    },
  );
});

test("fetchPage truncates to the excerpt cap and marks truncated:true", async () => {
  const longText = "word ".repeat(20);
  await withStubbedFetch(
    (async () => htmlResponse(`<p>${longText}</p>`)) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/long", {
        lookup: SAFE_LOOKUP,
        maxExcerptChars: 10,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.text.length, 10);
      assert.equal(result.truncated, true);
    },
  );
});

test("fetchPage follows a safe redirect through to a successful final response", async () => {
  await withStubbedFetch(
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "https://safe.example.com/old") {
        return new Response(null, { status: 301, headers: { location: "/new" } });
      }
      if (url === "https://safe.example.com/new") {
        return htmlResponse("<p>Landed here</p>");
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch,
    async () => {
      const result = await fetchPage("https://safe.example.com/old", { lookup: SAFE_LOOKUP });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.url, "https://safe.example.com/old");
      assert.equal(result.finalUrl, "https://safe.example.com/new");
      assert.equal(result.text, "Landed here");
    },
  );
});
