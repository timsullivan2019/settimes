import { describe, expect, it } from "vitest";
import {
  MERGE_THRESHOLD,
  MERGE_THRESHOLD_NO_LINEUP,
  combineScore,
  jaccard,
  lineupFromRaw,
  normalizeTitle,
  priceProximity,
  startProximity,
} from "./dedupe";

// These tests cover ONLY the pure scoring pieces — the exact functions
// dedupe() calls per pair. They do not cover the SQL candidate query, the
// pg_trgm similarity call, or merge persistence; those run live in
// scripts/run-dedupe.ts against the real database and driver.

describe("normalizeTitle", () => {
  it("strips §10.3 noise words, punctuation, and emoji", () => {
    expect(normalizeTitle("The Bunker New York presents Function")).toBe(
      "the bunker new york function",
    );
    expect(normalizeTitle("FUNCTION (all night long)")).toBe("function");
    expect(normalizeTitle("Bunker NYC: Function")).toBe("bunker nyc function");
    expect(normalizeTitle("Open Decks w/ Steen & Kush Jones [NYC] 🔥")).toBe(
      "open decks steen kush jones",
    );
    expect(normalizeTitle("Cathedral pres. Night Mass feat. Anetha")).toBe(
      "cathedral night mass anetha",
    );
  });

  it("does not eat words containing the noise tokens", () => {
    expect(normalizeTitle("Presence of Mind")).toBe("presence of mind");
    expect(normalizeTitle("Defeated Sound")).toBe("defeated sound");
  });
});

describe("jaccard", () => {
  it("is intersection over union", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(["a"]), new Set(["a"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
});

describe("startProximity", () => {
  it("is 1.0 within 60 minutes, 0 at 180, linear between", () => {
    const t = Date.UTC(2026, 7, 1, 3, 0);
    const min = 60_000;
    expect(startProximity(t, t)).toBe(1);
    expect(startProximity(t, t + 60 * min)).toBe(1);
    expect(startProximity(t, t + 120 * min)).toBeCloseTo(0.5);
    expect(startProximity(t, t + 180 * min)).toBe(0);
    expect(startProximity(t, t + 300 * min)).toBe(0);
  });
});

describe("priceProximity", () => {
  it("is UNKNOWN (null) when either price is null — nulls are not agreement", () => {
    expect(priceProximity(null, null)).toBeNull();
    expect(priceProximity(2000, null)).toBeNull();
    expect(priceProximity(null, 2000)).toBeNull();
  });

  it("compares known prices relatively; two free events agree", () => {
    expect(priceProximity(0, 0)).toBe(1);
    expect(priceProximity(2000, 2000)).toBe(1);
    expect(priceProximity(1000, 2000)).toBeCloseTo(0.5);
  });
});

describe("combineScore — unknown handling", () => {
  it("redistributes weight when lineup and price are unknown", () => {
    // Only title (0.35) and start (0.15) known → renormalized 0.7 / 0.3.
    const s = combineScore({ title: 0.9, lineup: null, start: 1, price: null });
    expect(s.score).toBeCloseTo((0.35 * 0.9 + 0.15 * 1) / 0.5);
    expect(s.threshold).toBe(MERGE_THRESHOLD_NO_LINEUP);
  });

  it("uses the base threshold when lineup is known", () => {
    const s = combineScore({ title: 0.9, lineup: 1, start: 1, price: null });
    expect(s.threshold).toBe(MERGE_THRESHOLD);
    expect(s.score).toBeCloseTo((0.35 * 0.9 + 0.4 * 1 + 0.15 * 1) / 0.9);
  });

  it("two lineup-less events with identical starts still need title ≥0.857", () => {
    // The case that would lose a real party: same venue, same start, no
    // lineups. Title alone must clear (0.9 - 0.3) / 0.7.
    const atBar = (title: number) =>
      combineScore({ title, lineup: null, start: 1, price: null });
    expect(atBar(0.85).score).toBeLessThan(MERGE_THRESHOLD_NO_LINEUP);
    expect(atBar(0.86).score).toBeGreaterThanOrEqual(MERGE_THRESHOLD_NO_LINEUP);
  });

  it("a disjoint lineup is real disagreement, not unknown", () => {
    const s = combineScore({ title: 0.9, lineup: 0, start: 1, price: null });
    expect(s.threshold).toBe(MERGE_THRESHOLD);
    expect(s.score).toBeCloseTo((0.35 * 0.9 + 0.4 * 0 + 0.15 * 1) / 0.9);
    expect(s.score).toBeLessThan(MERGE_THRESHOLD);
  });
});

describe("lineupFromRaw", () => {
  it("reads RA structured artists and Dice detailed_artists", () => {
    expect(
      lineupFromRaw("ra", { event: { artists: [{ id: "1", name: "Anetha" }] } }),
    ).toEqual(["Anetha"]);
    expect(
      lineupFromRaw("dice", {
        detailed_artists: [{ id: 1, name: "Escaflowne" }],
        artists: ["ignored"],
      }),
    ).toEqual(["Escaflowne"]);
    expect(lineupFromRaw("dice", { detailed_artists: [], artists: ["A", "B"] })).toEqual([
      "A",
      "B",
    ]);
  });

  it("returns [] (UNKNOWN), never throws, on absent or unshaped payloads", () => {
    expect(lineupFromRaw("ra", { event: {} })).toEqual([]);
    expect(lineupFromRaw("ra", null)).toEqual([]);
    expect(lineupFromRaw("posh", { anything: true })).toEqual([]);
  });
});
