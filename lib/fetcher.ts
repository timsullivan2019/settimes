import pLimit from "p-limit";

// The only outbound HTTP in the project (§14). Enforces, per hostname:
// concurrency 1, ≥1s between request starts, exponential backoff on 429/503,
// and the project User-Agent.

const USER_AGENT = "settimes.nyc/0.1 (+https://settimes.nyc; nightshadow261@gmail.com)";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetcherOptions {
  fetchImpl?: FetchLike;
  minHostIntervalMs?: number;
  backoffBaseMs?: number;
  maxRetries?: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const {
    fetchImpl = fetch,
    minHostIntervalMs = 1_000,
    backoffBaseMs = 1_000,
    maxRetries = 3,
  } = options;

  const limiters = new Map<string, ReturnType<typeof pLimit>>();
  const lastRequestAt = new Map<string, number>();

  return (url, init) => {
    const hostname = new URL(url).hostname;
    let limit = limiters.get(hostname);
    if (!limit) {
      limit = pLimit(1);
      limiters.set(hostname, limit);
    }

    return limit(async () => {
      const headers = new Headers(init?.headers);
      if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);

      for (let attempt = 0; ; attempt++) {
        const last = lastRequestAt.get(hostname);
        if (last !== undefined) {
          const wait = minHostIntervalMs - (Date.now() - last);
          if (wait > 0) await sleep(wait);
        }
        lastRequestAt.set(hostname, Date.now());

        const response = await fetchImpl(url, { ...init, headers });
        const throttled = response.status === 429 || response.status === 503;
        if (!throttled || attempt >= maxRetries) return response;

        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const backoffMs = backoffBaseMs * 2 ** attempt;
        await sleep(
          Math.max(backoffMs, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0),
        );
      }
    });
  };
}

export const fetcher = createFetcher();
