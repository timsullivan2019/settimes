import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { computePartyNight, parseLocal, NY_TZ } from "./time";

describe("parseLocal", () => {
  it("interprets a naive string in America/New_York by default", () => {
    const dt = parseLocal("2026-08-14T23:00:00");
    expect(dt.zoneName).toBe(NY_TZ);
    expect(dt.offset).toBe(-240); // EDT
    expect(dt.toISO()).toBe("2026-08-14T23:00:00.000-04:00");
    expect(dt.toUTC().toISO()).toBe("2026-08-15T03:00:00.000Z");
  });

  it("interprets a naive SQL-style string (space separator)", () => {
    const dt = parseLocal("2026-08-14 23:00:00");
    expect(dt.toISO()).toBe("2026-08-14T23:00:00.000-04:00");
  });

  it("interprets a naive string in an explicit sourceTz, then converts to NY", () => {
    const dt = parseLocal("2026-08-15T03:00:00", "utc");
    expect(dt.zoneName).toBe(NY_TZ);
    expect(dt.toISO()).toBe("2026-08-14T23:00:00.000-04:00");
  });

  it("preserves the instant of an ISO string with an offset", () => {
    const dt = parseLocal("2026-08-15T05:00:00+02:00");
    expect(dt.zoneName).toBe(NY_TZ);
    expect(dt.toISO()).toBe("2026-08-14T23:00:00.000-04:00");
  });

  it("ignores sourceTz when the string carries its own offset", () => {
    const dt = parseLocal("2026-08-14T23:00:00-04:00", "utc");
    expect(dt.toUTC().toISO()).toBe("2026-08-15T03:00:00.000Z");
  });

  it("preserves the instant of a UTC (Z) string", () => {
    const dt = parseLocal("2026-08-15T03:00:00Z");
    expect(dt.zoneName).toBe(NY_TZ);
    expect(dt.toISO()).toBe("2026-08-14T23:00:00.000-04:00");
  });

  it("throws on unparseable input rather than inventing data", () => {
    expect(() => parseLocal("not a timestamp")).toThrow(/unparseable/);
    expect(() => parseLocal("")).toThrow(/unparseable/);
  });

  it("throws on date-only input rather than defaulting to midnight", () => {
    expect(() => parseLocal("2026-08-14")).toThrow(/date-only/);
    expect(() => parseLocal("  2026-08-14  ")).toThrow(/date-only/);
    // A date WITH a midnight time is explicit and stays allowed.
    expect(parseLocal("2026-08-14T00:00:00").toISO()).toBe("2026-08-14T00:00:00.000-04:00");
  });

  describe("November 2026 DST boundary (fall back, Nov 1)", () => {
    it("takes the FIRST occurrence of an ambiguous 1:30am", () => {
      // 1:30am happens at EDT (-04:00) and again at EST (-05:00).
      const dt = parseLocal("2026-11-01T01:30:00");
      expect(dt.offset).toBe(-240); // EDT — the first occurrence
      expect(dt.toUTC().toISO()).toBe("2026-11-01T05:30:00.000Z");
    });

    it("uses EST for times after the transition", () => {
      const dt = parseLocal("2026-11-01T03:00:00");
      expect(dt.offset).toBe(-300); // EST
    });

    it("uses EDT for times before the transition", () => {
      const dt = parseLocal("2026-10-31T23:00:00");
      expect(dt.offset).toBe(-240);
    });

    it("still parses a nonexistent spring-forward time (Mar 8, 2:30am)", () => {
      const dt = parseLocal("2026-03-08T02:30:00");
      expect(dt.isValid).toBe(true);
    });
  });
});

describe("computePartyNight", () => {
  it("puts Saturday 23:45 and Sunday 00:30 on the SAME night", () => {
    // 2026-07-25 is a Saturday.
    const sat = parseLocal("2026-07-25T23:45:00");
    const sun = parseLocal("2026-07-26T00:30:00");
    expect(computePartyNight(sat)).toBe("2026-07-25");
    expect(computePartyNight(sun)).toBe("2026-07-25");
    expect(computePartyNight(sat)).toBe(computePartyNight(sun));
  });

  it("rolls over at 6am exactly", () => {
    expect(computePartyNight(parseLocal("2026-07-26T05:59:00"))).toBe("2026-07-25");
    expect(computePartyNight(parseLocal("2026-07-26T06:00:00"))).toBe("2026-07-26");
  });

  it("is correct across the November DST boundary", () => {
    // Saturday night into the fall-back Sunday — all one party night.
    expect(computePartyNight(parseLocal("2026-10-31T23:00:00"))).toBe("2026-10-31");
    // First occurrence of 1:30am (EDT).
    expect(computePartyNight(parseLocal("2026-11-01T01:30:00"))).toBe("2026-10-31");
    // Second occurrence of 1:30am (EST) — same night.
    const second = DateTime.fromISO("2026-11-01T01:30:00-05:00", { setZone: true });
    expect(computePartyNight(second)).toBe("2026-10-31");
    // 4am EST is still Saturday's party.
    expect(computePartyNight(DateTime.fromISO("2026-11-01T04:00:00-05:00"))).toBe("2026-10-31");
    // Sunday 6:30am starts Sunday's night.
    expect(computePartyNight(parseLocal("2026-11-01T06:30:00"))).toBe("2026-11-01");
  });

  it("accepts a JS Date and localizes it to NY first", () => {
    // 03:00 UTC = 23:00 EDT the previous evening.
    expect(computePartyNight(new Date("2026-07-26T03:00:00Z"))).toBe("2026-07-25");
  });

  it("throws on an invalid Date", () => {
    expect(() => computePartyNight(new Date("garbage"))).toThrow(/invalid/);
  });
});
