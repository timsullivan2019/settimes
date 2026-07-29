import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetcher } from "./fetcher";

type Call = { url: string; at: number; init?: RequestInit };

function recordingFetch(statuses: number[] = []) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, at: Date.now(), init });
    const status = statuses.shift() ?? 200;
    return new Response("ok", { status });
  };
  return { calls, impl };
}

describe("fetcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spaces two requests to the same host at least 1s apart", async () => {
    const { calls, impl } = recordingFetch();
    const f = createFetcher({ fetchImpl: impl });
    const pending = Promise.all([f("https://ra.co/one"), f("https://ra.co/two")]);
    await vi.runAllTimersAsync();
    const [a, b] = await pending;
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1000);
  });

  it("does not delay requests to different hosts", async () => {
    const { calls, impl } = recordingFetch();
    const f = createFetcher({ fetchImpl: impl });
    const pending = Promise.all([f("https://ra.co/x"), f("https://dice.fm/x")]);
    await vi.runAllTimersAsync();
    await pending;
    expect(calls[1].at - calls[0].at).toBe(0);
  });

  it("retries a simulated 429 after a backoff, then succeeds", async () => {
    const { calls, impl } = recordingFetch([429, 200]);
    const f = createFetcher({ fetchImpl: impl });
    const pending = f("https://ra.co/graphql");
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1000);
  });

  it("backs off exponentially across consecutive 429s", async () => {
    const { calls, impl } = recordingFetch([429, 429, 200]);
    const f = createFetcher({ fetchImpl: impl });
    const pending = f("https://ra.co/graphql");
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1000);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(2000);
  });

  it("retries a 503 the same way", async () => {
    const { calls, impl } = recordingFetch([503, 200]);
    const f = createFetcher({ fetchImpl: impl });
    const pending = f("https://smallvenue.example/events");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and returns the throttled response", async () => {
    const { calls, impl } = recordingFetch([429, 429, 429]);
    const f = createFetcher({ fetchImpl: impl, maxRetries: 2 });
    const pending = f("https://ra.co/graphql");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(429);
    expect(calls).toHaveLength(3);
  });

  it("sends the project User-Agent with a contact email", async () => {
    const { calls, impl } = recordingFetch();
    const f = createFetcher({ fetchImpl: impl });
    const pending = f("https://ra.co/graphql");
    await vi.runAllTimersAsync();
    await pending;
    const ua = new Headers(calls[0].init?.headers).get("user-agent");
    expect(ua).toContain("settimes");
    expect(ua).toMatch(/@/);
  });
});
