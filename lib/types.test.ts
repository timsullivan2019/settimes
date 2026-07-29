import { describe, expect, it } from "vitest";
import { NormalEventSchema } from "./types";

const valid = {
  source: "ra" as const,
  sourceEventId: "1234567",
  sourceUrl: "https://ra.co/events/1234567",
  title: "Bunker NYC: Function",
  startsAt: new Date("2026-08-15T03:00:00Z"),
  endsAt: null,
  venueNameRaw: "Basement",
  addressRaw: null,
  artists: [{ name: "Function", note: "all night long" }],
  priceMinCents: 2500,
  priceMaxCents: null,
  isFree: false,
  doorOnly: false,
  ageRestriction: "21+",
  flyerUrl: null,
  ticketUrl: "https://ra.co/events/1234567",
  status: "confirmed" as const,
  addressSecret: false,
  raw: { anything: true },
};

describe("NormalEventSchema", () => {
  it("accepts a complete adapter payload", () => {
    expect(NormalEventSchema.parse(valid)).toBeTruthy();
  });

  it("rejects a string where a Date is required — no coercion", () => {
    expect(() =>
      NormalEventSchema.parse({ ...valid, startsAt: "2026-08-15T03:00:00Z" }),
    ).toThrow();
  });

  it("rejects a missing field — no defaults", () => {
    const { isFree: _dropped, ...withoutIsFree } = valid;
    expect(() => NormalEventSchema.parse(withoutIsFree)).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => NormalEventSchema.parse({ ...valid, source: "eventbrite" })).toThrow();
  });

  it("rejects a negative price", () => {
    expect(() => NormalEventSchema.parse({ ...valid, priceMinCents: -100 })).toThrow();
  });
});
