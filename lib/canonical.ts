import { DateTime } from "luxon";
import { parseLocal } from "./time";
import type { Source } from "./types";

// §10.4 canonical field resolution, n-way — THE single implementation.
// Both writers of canonical rows go through it:
//   - lib/dedupe.ts, when a merge folds a loser into a winner
//   - lib/ingest.ts, when any ingest refreshes a member of a merge group and
//     the canonical row must be recomputed from ALL sources in the group
// Canonical fields are never owned by one source's payload; they are always a
// resolution over every member's view.

export const TRUST: Source[] = ["ra", "dice", "posh", "jsonld", "submission"];

export function trustRankOf(sources: readonly string[]): number {
  let best = TRUST.length;
  for (const s of sources) {
    const rank = TRUST.indexOf(s as Source);
    if (rank !== -1 && rank < best) best = rank;
  }
  return best;
}

/** One merge-group member's current view of the event. */
export interface CanonicalMember {
  id: string;
  /** distinct sources backing this member (its event_sources rows) */
  sources: string[];
  title: string;
  startsAt: DateTime;
  endsAt: DateTime | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  isFree: boolean;
  ageRestriction: string | null;
  ticketUrl: string | null;
  flyerUrl: string | null;
}

export interface CanonicalFields {
  title: string;
  startsAt: DateTime;
  endsAt: DateTime | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  isFree: boolean;
  ageRestriction: string | null;
  ticketUrl: string | null;
  flyerUrl: string | null;
}

export interface CanonicalProvenance {
  field: string;
  value: unknown;
  memberId: string;
  source: string;
}

/** Numeric restrictiveness of an age string; higher = more restrictive. */
function ageRank(s: string | null): number | null {
  if (s === null) return null;
  if (/all ages/i.test(s)) return 0;
  const m = /(\d{1,2})\s*\+/.exec(s);
  return m ? Number(m[1]) : null;
}

function bestSourceName(m: CanonicalMember): string {
  return TRUST[trustRankOf(m.sources)] ?? "unknown";
}

/**
 * Resolve the best value per field across a merge group (§10.4). Member order
 * matters only for ties: pass the canonical root first so full ties keep its
 * value. Two nulls resolve to null — absence is never invented into a value.
 */
export function resolveCanonical(members: CanonicalMember[]): {
  fields: CanonicalFields;
  provenance: CanonicalProvenance[];
} {
  if (members.length === 0) throw new Error("resolveCanonical: no members");
  const provenance: CanonicalProvenance[] = [];
  const note = (field: string, value: unknown, from: CanonicalMember) => {
    provenance.push({ field, value, memberId: from.id, source: bestSourceName(from) });
  };

  // Stable trust order: input order breaks ties.
  const byTrust = [...members].sort((a, b) => trustRankOf(a.sources) - trustRankOf(b.sources));
  const firstNonNull = <K extends keyof CanonicalMember>(key: K) =>
    byTrust.find((m) => m[key] !== null) ?? null;

  // title: from the highest-trust source; longer wins a trust tie.
  let titleFrom = byTrust[0];
  for (const m of byTrust) {
    if (
      trustRankOf(m.sources) === trustRankOf(titleFrom.sources) &&
      m.title.length > titleFrom.title.length
    ) {
      titleFrom = m;
    }
  }
  note("title", titleFrom.title, titleFrom);

  // starts_at: earliest reported.
  let startFrom = members[0];
  for (const m of members) {
    if (m.startsAt.toMillis() < startFrom.startsAt.toMillis()) startFrom = m;
  }
  note("starts_at", startFrom.startsAt.toISO(), startFrom);

  // ends_at: §10.4 has no rule — highest-trust known end, never null over known.
  const endFrom = firstNonNull("endsAt");
  if (endFrom !== null) note("ends_at", endFrom.endsAt?.toISO(), endFrom);

  // price: lowest AVAILABLE price (each member's price_min_cents is already
  // "currently available" per §9.1 rule 4). All-null stays null.
  let priceFrom: CanonicalMember | null = null;
  for (const m of members) {
    if (m.priceMinCents === null) continue;
    if (priceFrom === null || m.priceMinCents < (priceFrom.priceMinCents as number)) {
      priceFrom = m;
    }
  }
  if (priceFrom !== null) {
    note("price_min_cents", priceFrom.priceMinCents, priceFrom);
    note("price_max_cents", priceFrom.priceMaxCents, priceFrom);
  }

  // ticket_url: from the lowest-price source; without any price, the
  // highest-trust non-null URL.
  const ticketFrom =
    priceFrom !== null && priceFrom.ticketUrl !== null ? priceFrom : firstNonNull("ticketUrl");
  if (ticketFrom !== null) note("ticket_url", ticketFrom.ticketUrl, ticketFrom);

  // age: most restrictive; unparseable strings lose to parseable ones.
  let ageFrom: CanonicalMember | null = null;
  for (const m of members) {
    if (m.ageRestriction === null) continue;
    if (ageFrom === null) {
      ageFrom = m;
      continue;
    }
    const cur = ageRank(ageFrom.ageRestriction);
    const cand = ageRank(m.ageRestriction);
    if (cand !== null && (cur === null || cand > cur)) ageFrom = m;
  }
  if (ageFrom !== null) note("age_restriction", ageFrom.ageRestriction, ageFrom);

  // flyer: "highest resolution" would require fetching every image — not
  // done; highest-trust non-null stands in.
  const flyerFrom = firstNonNull("flyerUrl");
  if (flyerFrom !== null) note("flyer_url", flyerFrom.flyerUrl, flyerFrom);

  const priceMin = priceFrom?.priceMinCents ?? null;
  const fields: CanonicalFields = {
    title: titleFrom.title,
    startsAt: startFrom.startsAt,
    endsAt: endFrom?.endsAt ?? null,
    priceMinCents: priceMin,
    priceMaxCents: priceFrom?.priceMaxCents ?? null,
    // A known lowest price decides is_free; with no price anywhere, any
    // member's explicit free flag survives.
    isFree: priceMin !== null ? priceMin === 0 : members.some((m) => m.isFree),
    ageRestriction: ageFrom?.ageRestriction ?? null,
    ticketUrl: ticketFrom?.ticketUrl ?? null,
    flyerUrl: flyerFrom?.flyerUrl ?? null,
  };
  return { fields, provenance };
}

/**
 * Raw db.execute returns timestamptz as a string ("2026-07-28 23:00:00+00"),
 * the typed builder returns Date — never assume the driver's return type.
 */
export function toDateTime(v: unknown): DateTime {
  if (v instanceof Date) return DateTime.fromJSDate(v);
  if (typeof v === "string") return parseLocal(v);
  throw new Error(`expected timestamp, got ${typeof v}`);
}
