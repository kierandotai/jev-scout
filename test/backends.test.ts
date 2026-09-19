import { test } from "node:test";
import assert from "node:assert/strict";

import { SearxngBackend } from "../src/backends/searxng.ts";
import { BraveBackend } from "../src/backends/brave.ts";
import { DuckDuckGoBackend } from "../src/backends/duckduckgo.ts";
import { BackendError, SoftRateLimitError, type RawResult, type SearchBackend } from "../src/backends/types.ts";
import {
  BackendChainError,
  dedupeResults,
  resolveSearch,
  toRawResult,
} from "../src/backends/resolve.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { withStubbedFetch } from "./support.ts";

function baseConfig(overrides: Partial<Record<string, string>> = {}): Config {
  // Deliberately does NOT inherit process.env — keeps backend-resolution
  // tests independent of whatever JEV_SCOUT_* vars happen to be set in the
  // shell running the suite.
  return loadConfig(overrides as NodeJS.ProcessEnv);
}

// ---------------------------------------------------------------------------
// SearXNG
// ---------------------------------------------------------------------------

test("searxng backend normalizes JSON fixture results and drops javascript: URLs", async () => {
  const fixture = {
    results: [
      { title: "Example Docs", url: "https://docs.example.com/guide/", content: "Official guide to Example." },
      { title: "Bad Link", url: "javascript:alert(1)", content: "should be dropped" },
    ],
  };
  await withStubbedFetch(
    (async () => Response.json(fixture)) as typeof fetch,
    async () => {
      const backend = new SearxngBackend("http://localhost:8080");
      const results = await backend.search("example", 10);
      assert.equal(results.length, 1);
      assert.deepEqual(results[0], {
        title: "Example Docs",
        url: "https://docs.example.com/guide",
        snippet: "Official guide to Example.",
        domain: "docs.example.com",
      });
    },
  );
});

test("searxng backend maps 429 to SoftRateLimitError", async () => {
  await withStubbedFetch(
    (async () => new Response("rate limited", { status: 429 })) as typeof fetch,
    async () => {
      const backend = new SearxngBackend("http://localhost:8080");
      await assert.rejects(() => backend.search("q", 5), SoftRateLimitError);
    },
  );
});

test("searxng backend maps 403 to a typed error advising the formats config", async () => {
  await withStubbedFetch(
    (async () => new Response("forbidden", { status: 403 })) as typeof fetch,
    async () => {
      const backend = new SearxngBackend("http://localhost:8080");
      await assert.rejects(() => backend.search("q", 5), (err: unknown) => {
        assert.ok(err instanceof BackendError);
        assert.match(err.message, /formats/i);
        assert.equal(err.backend, "searxng");
        return true;
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

test("brave backend normalizes JSON fixture and strips HTML tags/entities from description", async () => {
  const fixture = {
    web: {
      results: [
        {
          title: "Brave Result",
          url: "https://example.com/brave",
          description: "A <strong>bold</strong> snippet &amp; more",
        },
      ],
    },
  };
  await withStubbedFetch(
    (async () => Response.json(fixture)) as typeof fetch,
    async () => {
      const backend = new BraveBackend("test-key");
      const results = await backend.search("example", 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.snippet, "A bold snippet & more");
      assert.equal(results[0]!.domain, "example.com");
    },
  );
});

test("brave response missing the web key returns an empty array without throwing", async () => {
  await withStubbedFetch(
    (async () => Response.json({})) as typeof fetch,
    async () => {
      const backend = new BraveBackend("test-key");
      const results = await backend.search("example", 10);
      assert.deepEqual(results, []);
    },
  );
});

test("brave backend maps 429 to SoftRateLimitError", async () => {
  await withStubbedFetch(
    (async () => new Response("rate limited", { status: 429 })) as typeof fetch,
    async () => {
      const backend = new BraveBackend("test-key");
      await assert.rejects(() => backend.search("q", 5), SoftRateLimitError);
    },
  );
});

// ---------------------------------------------------------------------------
// DuckDuckGo
// ---------------------------------------------------------------------------

const DDG_HTML_FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg&amp;rut=abc">DDG <b>Result</b> Title</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg&amp;rut=abc">A snippet about <b>DDG</b> testing.</a>
  </div>
</div>
`;

test("ddg backend parses HTML fixture into normalized results, decoding the uddg redirect param", async () => {
  await withStubbedFetch(
    (async () => new Response(DDG_HTML_FIXTURE, { status: 200 })) as typeof fetch,
    async () => {
      const backend = new DuckDuckGoBackend({ minDelayMs: 0, maxDelayMs: 0 });
      const results = await backend.search("ddg query", 10);
      assert.equal(results.length, 1);
      assert.deepEqual(results[0], {
        title: "DDG Result Title",
        url: "https://example.com/ddg",
        snippet: "A snippet about DDG testing.",
        domain: "example.com",
      });
    },
  );
});

test("ddg backend treats HTTP 202 as an anomaly challenge (SoftRateLimitError)", async () => {
  await withStubbedFetch(
    (async () => new Response("<html>please wait</html>", { status: 202 })) as typeof fetch,
    async () => {
      const backend = new DuckDuckGoBackend({ minDelayMs: 0, maxDelayMs: 0 });
      await assert.rejects(() => backend.search("q", 5), SoftRateLimitError);
    },
  );
});

test("ddg backend treats anomaly markers in a 200 body as an anomaly challenge", async () => {
  await withStubbedFetch(
    (async () => new Response('<html><script src="anomaly.js"></script></html>', { status: 200 })) as typeof fetch,
    async () => {
      const backend = new DuckDuckGoBackend({ minDelayMs: 0, maxDelayMs: 0 });
      await assert.rejects(() => backend.search("q", 5), SoftRateLimitError);
    },
  );
});

// ---------------------------------------------------------------------------
// resolve.ts: normalization + dedupe
// ---------------------------------------------------------------------------

test("cross-backend URL dedupe: same page from two backends collapses to one, first wins", () => {
  const fromSearxng = toRawResult("From SearXNG", "https://EXAMPLE.com/page", "snippet a");
  const fromBrave = toRawResult("From Brave", "https://example.com/page/", "snippet b");
  assert.ok(fromSearxng && fromBrave);
  const combined = dedupeResults([fromSearxng!, fromBrave!]);
  assert.equal(combined.length, 1);
  assert.equal(combined[0]!.url, "https://example.com/page");
  assert.equal(combined[0]!.title, "From SearXNG");
});

test("toRawResult drops javascript: and other non-http(s) URLs", () => {
  assert.equal(toRawResult("bad", "javascript:alert(1)", "s"), undefined);
  assert.equal(toRawResult("bad", "not a url", "s"), undefined);
  assert.equal(toRawResult("bad", "ftp://example.com/file", "s"), undefined);
});

// ---------------------------------------------------------------------------
// resolve.ts: backend resolution chain
// ---------------------------------------------------------------------------

function fakeBackend(name: string, impl: (query: string, count: number) => Promise<RawResult[]>): SearchBackend {
  return { name, search: impl };
}

const SAMPLE_RESULT: RawResult = {
  title: "Sample",
  url: "https://example.com/sample",
  snippet: "sample snippet",
  domain: "example.com",
};

test("auto-resolution chain: first backend throws, second backend serves", async () => {
  let braveCalls = 0;
  const searxng = fakeBackend("searxng", async () => {
    throw new BackendError("searxng down", "searxng");
  });
  const brave = fakeBackend("brave", async () => {
    braveCalls++;
    return [SAMPLE_RESULT];
  });
  const ddg = fakeBackend("ddg", async () => {
    throw new Error("should not be reached");
  });

  const cfg = baseConfig({ JEV_SCOUT_BACKEND: "" });
  const result = await resolveSearch(cfg, { searxng, brave, ddg }, "q", 5);

  assert.equal(braveCalls, 1);
  assert.deepEqual(result.results, [SAMPLE_RESULT]);
  assert.deepEqual(result.backendsTried, ["searxng", "brave"]);
});

test("auto-resolution chain: zero results from the first backend is a valid answer, no fallback", async () => {
  let ddgCalls = 0;
  const searxng = fakeBackend("searxng", async () => []);
  const ddg = fakeBackend("ddg", async () => {
    ddgCalls++;
    return [SAMPLE_RESULT];
  });

  const cfg = baseConfig({ JEV_SCOUT_BACKEND: "" });
  const result = await resolveSearch(cfg, { searxng, ddg }, "q", 5);

  assert.equal(ddgCalls, 0, "ddg must not be called when the prior backend answered with zero results");
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.backendsTried, ["searxng"]);
});

test("auto-resolution chain: all backends throw -> BackendChainError carries backendsTried", async () => {
  const searxng = fakeBackend("searxng", async () => {
    throw new BackendError("searxng down", "searxng");
  });
  const brave = fakeBackend("brave", async () => {
    throw new BackendError("brave down", "brave");
  });
  const ddg = fakeBackend("ddg", async () => {
    throw new SoftRateLimitError("ddg anomaly", "ddg");
  });

  const cfg = baseConfig({ JEV_SCOUT_BACKEND: "" });
  await assert.rejects(
    () => resolveSearch(cfg, { searxng, brave, ddg }, "q", 5),
    (err: unknown) => {
      assert.ok(err instanceof BackendChainError);
      assert.deepEqual(err.backendsTried, ["searxng", "brave", "ddg"]);
      return true;
    },
  );
});

test("explicit JEV_SCOUT_BACKEND=searxng + SearXNG error: typed failure, no fallback attempted", async () => {
  let ddgCalls = 0;
  const searxng = fakeBackend("searxng", async () => {
    throw new BackendError("searxng returned 403", "searxng", { retryable: false });
  });
  const ddg = fakeBackend("ddg", async () => {
    ddgCalls++;
    return [SAMPLE_RESULT];
  });

  const cfg = baseConfig({ JEV_SCOUT_BACKEND: "searxng" });
  await assert.rejects(
    () => resolveSearch(cfg, { searxng, ddg }, "q", 5),
    (err: unknown) => {
      assert.ok(err instanceof BackendError);
      assert.ok(!(err instanceof BackendChainError));
      assert.equal(err.backend, "searxng");
      return true;
    },
  );
  assert.equal(ddgCalls, 0, "explicit backend selection must not fall back to ddg");
});
