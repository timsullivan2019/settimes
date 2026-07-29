import { describe, expect, it } from "vitest";
import { eventSlug, shortHash } from "./slug";

describe("eventSlug", () => {
  it("produces venue-date-shorthash", () => {
    const slug = eventSlug("bossa-nova-civic-club", "2026-08-14", "Function All Night");
    expect(slug).toMatch(/^bossa-nova-civic-club-2026-08-14-[0-9a-f]{8}$/);
  });

  it("is deterministic and insensitive to title casing/whitespace", () => {
    const a = eventSlug("nowadays", "2026-08-14", "Mister Saturday Night");
    const b = eventSlug("nowadays", "2026-08-14", "  mister   saturday night ");
    expect(a).toBe(b);
  });

  it("differs for different titles on the same night and venue", () => {
    const a = eventSlug("elsewhere", "2026-08-14", "Hall: Techno");
    const b = eventSlug("elsewhere", "2026-08-14", "Zone One: Electro");
    expect(a).not.toBe(b);
  });

  it("rejects a party night that is not YYYY-MM-DD", () => {
    expect(() => eventSlug("nowadays", "08/14/2026", "x")).toThrow(/YYYY-MM-DD/);
  });
});

describe("shortHash", () => {
  it("returns the requested length", () => {
    expect(shortHash("abc")).toHaveLength(8);
    expect(shortHash("abc", 6)).toHaveLength(6);
  });
});
