import { z } from "zod";

// The shape every adapter must return (§9). Nothing is coerced and nothing is
// defaulted — an adapter that can't parse a field writes null explicitly, and a
// payload that doesn't fit throws with the Zod diff.

export const SOURCES = ["ra", "dice", "posh", "jsonld", "submission"] as const;

export const LineupArtistSchema = z.object({
  name: z.string().min(1),
  note: z.string().nullable(),
});

export const NormalEventSchema = z.object({
  source: z.enum(SOURCES),
  // Stable per-source ID; if the source has none, the adapter hashes
  // source + title + starts_at + venue_name_raw (§9 idempotency).
  sourceEventId: z.string().min(1),
  sourceUrl: z.url().nullable(),
  title: z.string().min(1),
  // Instants, already localized by lib/time.ts — adapters pass
  // parseLocal(...).toJSDate(). Never a bare `new Date(string)`.
  startsAt: z.date(),
  endsAt: z.date().nullable(),
  venueNameRaw: z.string().nullable(),
  addressRaw: z.string().nullable(),
  artists: z.array(LineupArtistSchema),
  priceMinCents: z.number().int().nonnegative().nullable(),
  priceMaxCents: z.number().int().nonnegative().nullable(),
  isFree: z.boolean(),
  doorOnly: z.boolean(),
  ageRestriction: z.string().nullable(),
  flyerUrl: z.url().nullable(),
  ticketUrl: z.url().nullable(),
  // Only 'cancelled' on an explicit source signal — absence never means
  // cancelled (§9.1 rule 2).
  status: z.enum(["confirmed", "cancelled", "postponed"]),
  addressSecret: z.boolean(),
  // The untouched source payload, written to event_sources.raw before any
  // normalization.
  raw: z.unknown(),
});

export type NormalEvent = z.infer<typeof NormalEventSchema>;
export type Source = (typeof SOURCES)[number];
