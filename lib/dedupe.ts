import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "../db/client";
import { parseLineup } from "./artists";
import {
  resolveCanonical,
  toDateTime,
  trustRankOf,
  type CanonicalMember,
} from "./canonical";

// Step 10: deduplication, §10 exactly.
//
// Order of operations per pair:
//   1. hard MERGE rules   — same (source, source_event_id), or identical
//      non-null ticket_url → merge with no scoring
//   2. hard NEVER-MERGE   — the two events carry listings from the SAME
//      platform with DIFFERENT source event ids → block. This is the
//      multi-room / multi-session case (Skyport Marina's several boat parties
//      a night, Elsewhere's concurrent rooms): one platform listing the same
//      venue twice on one night means two real events, and RA's null
//      ticket_url makes source_event_id the reliable form of §10's
//      "different ticket URLs on the same platform".
//   3. score (§10.3)      — 0.35 title + 0.40 lineup + 0.15 start + 0.10 price
//   4. threshold          — ≥0.80 merge, below leave separate. No review queue:
//      a visible duplicate is cosmetic, a hidden event is a product failure.
//
// UNKNOWNS — missing data must never look like agreement. ~37% of RA events
// have no lineup and RA supplies no price at all, so:
//   - lineupJaccard is UNKNOWN when EITHER side has zero artists. Two empty
//     lineups are neither a match (1.0) nor a clash (0.0) — the component is
//     dropped and its 0.40 weight is redistributed proportionally across the
//     components that do have data (score = Σw·s / Σw over known components).
//   - priceProximity is likewise UNKNOWN when either side has a null price.
//   - title and start are always present, so a score always exists.
//   - Losing the lineup removes the strongest signal, leaving mostly
//     title + start — and two DIFFERENT parties at one venue often share a
//     start time. The merge bar therefore rises to 0.90 when lineup is
//     unknown: with price also unknown that requires title similarity ≥0.86
//     even when the start times are identical.
//
// DEVIATION from §10.3, flagged: lineupJaccard runs over normalized artist
// NAMES extracted from event_sources.raw, not "resolved artist IDs" — the
// artists / event_artists tables are empty because no build step has run
// artist resolution yet. Names are stable across RA and Dice for the same
// party; revisit when artist resolution lands.

export const WEIGHTS = { title: 0.35, lineup: 0.4, start: 0.15, price: 0.1 } as const;
export const MERGE_THRESHOLD = 0.8;
export const MERGE_THRESHOLD_NO_LINEUP = 0.9;

// ---------------------------------------------------------------------------
// Pure scoring pieces (unit-tested in dedupe.test.ts)
// ---------------------------------------------------------------------------

// §10.3: lowercase; strip presents/pres./w//feat./b2b/all night long/[nyc],
// emoji, punctuation. Lineup overlap does the real work; titles are noisy.
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[nyc\]/g, " ")
    .replace(/\bpres(?:ents|\.)?(?=\s|$)/g, " ")
    .replace(/\bfeat(?:uring|\.)?(?=\s|$)/g, " ")
    .replace(/\bw\//g, " ")
    .replace(/\bb2b\b/g, " ")
    .replace(/\ball night long\b/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 1.0 within 60 minutes, linear down to 0 at 180 minutes (§10.3). */
export function startProximity(aMs: number, bMs: number): number {
  const diffMin = Math.abs(aMs - bMs) / 60_000;
  if (diffMin <= 60) return 1;
  if (diffMin >= 180) return 0;
  return (180 - diffMin) / 120;
}

/** Relative closeness of two known prices; null = UNKNOWN (either side null). */
export function priceProximity(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const max = Math.max(a, b);
  if (max === 0) return 1; // both free
  return 1 - Math.abs(a - b) / max;
}

export interface PairComponents {
  title: number;
  /** null = UNKNOWN — either side has no lineup. Never 0, never 1. */
  lineup: number | null;
  start: number;
  /** null = UNKNOWN — either side has no price. */
  price: number | null;
}

export interface PairScore {
  score: number;
  threshold: number;
  components: PairComponents;
}

// Unknown components are excluded and their weight redistributed
// proportionally over the known ones; an unknown lineup raises the bar.
export function combineScore(c: PairComponents): PairScore {
  let sum = WEIGHTS.title * c.title + WEIGHTS.start * c.start;
  let weightSum = WEIGHTS.title + WEIGHTS.start;
  if (c.lineup !== null) {
    sum += WEIGHTS.lineup * c.lineup;
    weightSum += WEIGHTS.lineup;
  }
  if (c.price !== null) {
    sum += WEIGHTS.price * c.price;
    weightSum += WEIGHTS.price;
  }
  return {
    score: sum / weightSum,
    threshold: c.lineup === null ? MERGE_THRESHOLD_NO_LINEUP : MERGE_THRESHOLD,
    components: c,
  };
}

// ---------------------------------------------------------------------------
// Lineup extraction from raw payloads
// ---------------------------------------------------------------------------

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Artist name strings from a stored raw payload; [] when absent or unshaped. */
export function lineupFromRaw(source: string, raw: unknown): string[] {
  const names: string[] = [];
  const r = asObj(raw);
  if (r === null) return names;
  if (source === "ra") {
    const artists = asObj(r.event)?.artists;
    if (Array.isArray(artists)) {
      for (const a of artists) {
        const name = asObj(a)?.name;
        if (typeof name === "string") names.push(name);
      }
    }
  } else if (source === "dice") {
    const detailed = r.detailed_artists;
    if (Array.isArray(detailed) && detailed.length > 0) {
      for (const a of detailed) {
        const name = asObj(a)?.name;
        if (typeof name === "string") names.push(name);
      }
    } else if (Array.isArray(r.artists)) {
      for (const a of r.artists) if (typeof a === "string") names.push(a);
    }
  }
  return names;
}

function lineupSet(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of names) {
    for (const a of parseLineup(raw)) out.add(a.name.toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedupe run
// ---------------------------------------------------------------------------

interface Ev {
  id: string;
  slug: string;
  title: string;
  normTitle: string;
  startsAt: DateTime;
  endsAt: DateTime | null;
  partyNight: string;
  venueId: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  isFree: boolean;
  ageRestriction: string | null;
  ticketUrl: string | null;
  flyerUrl: string | null;
  firstSeenMs: number;
  /** own sources plus, after a merge, the absorbed event's — so the
   *  never-merge platform rule holds transitively through a canonical row. */
  sources: Array<{ source: string; sourceEventId: string | null }>;
  lineup: Set<string>;
  mergedInto: string | null;
}

export interface EvaluatedPair {
  aId: string;
  bId: string;
  aTitle: string;
  bTitle: string;
  partyNight: string;
  venueId: string | null;
  outcome: "merged-hard" | "merged-scored" | "blocked" | "separate";
  reason: string;
  score: number | null;
  threshold: number | null;
  components: PairComponents | null;
}

export interface FieldResolution {
  field: string;
  value: unknown;
  fromSource: string;
  fromTitle: string;
}

export interface MergeRecord {
  winnerId: string;
  loserId: string;
  winnerTitle: string;
  loserTitle: string;
  score: number | null; // null = hard-rule merge
  resolutions: FieldResolution[];
}

export interface DedupeReport {
  groups: number;
  pairsEvaluated: number;
  hardMerged: number;
  scoredMerged: number;
  blocked: number;
  separate: number;
  skippedNoVenue: number;
  pairs: EvaluatedPair[];
  merges: MergeRecord[];
}

function trustRank(ev: Ev): number {
  return trustRankOf(ev.sources.map((s) => s.source));
}

function asMember(ev: Ev): CanonicalMember {
  return {
    id: ev.id,
    sources: ev.sources.map((s) => s.source),
    title: ev.title,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    priceMinCents: ev.priceMinCents,
    priceMaxCents: ev.priceMaxCents,
    isFree: ev.isFree,
    ageRestriction: ev.ageRestriction,
    ticketUrl: ev.ticketUrl,
    flyerUrl: ev.flyerUrl,
  };
}

// §10.4 canonical field resolution — delegated to the shared n-way resolver
// in lib/canonical.ts (the same one ingest uses to recompute merge groups).
// Mutates `w` in memory so later merges into the same canonical row resolve
// against accumulated state, and returns the per-field provenance.
function resolveFields(w: Ev, l: Ev): FieldResolution[] {
  // Winner first: full ties keep the winner's value.
  const { fields, provenance } = resolveCanonical([asMember(w), asMember(l)]);
  const titles = new Map([
    [w.id, w.title],
    [l.id, l.title],
  ]);
  const res: FieldResolution[] = provenance.map((p) => ({
    field: p.field,
    value: p.value,
    fromSource: p.source,
    fromTitle: titles.get(p.memberId) ?? "?",
  }));

  w.title = fields.title;
  w.normTitle = normalizeTitle(fields.title);
  // Candidates share party_night by construction, so the earliest instant
  // never moves the night.
  w.startsAt = fields.startsAt;
  w.endsAt = fields.endsAt;
  w.priceMinCents = fields.priceMinCents;
  w.priceMaxCents = fields.priceMaxCents;
  w.isFree = fields.isFree;
  w.ticketUrl = fields.ticketUrl;
  w.ageRestriction = fields.ageRestriction;
  w.flyerUrl = fields.flyerUrl;
  // union of artists (§10.4) — persists only in memory for later scoring;
  // there is no event_artists data to write until artist resolution exists.
  for (const a of l.lineup) w.lineup.add(a);
  w.sources = [...w.sources, ...l.sources];

  return res;
}

/** Shared platform with different source ids → the §10 never-merge case. */
function platformConflict(a: Ev, b: Ev): string | null {
  for (const sa of a.sources) {
    for (const sb of b.sources) {
      if (sa.source === sb.source && sa.sourceEventId !== sb.sourceEventId) {
        return sa.source;
      }
    }
  }
  return null;
}

function sharedSourceId(a: Ev, b: Ev): boolean {
  return a.sources.some((sa) =>
    b.sources.some(
      (sb) =>
        sa.source === sb.source &&
        sa.sourceEventId !== null &&
        sa.sourceEventId === sb.sourceEventId,
    ),
  );
}

// db/client throws at import time without DATABASE_URL, which would break
// unit tests of the pure scoring functions above — so the default client is
// resolved lazily, only when a caller actually runs against the database.
async function defaultDb(): Promise<Db> {
  return (await import("../db/client")).db;
}

export async function dedupe(db?: Db): Promise<DedupeReport> {
  db = db ?? (await defaultDb());
  const eventRows = await db.execute(sql`
    select id, slug, title, starts_at, ends_at, party_night::text as party_night,
           venue_id, price_min_cents, price_max_cents, is_free, age_restriction,
           ticket_url, flyer_url, first_seen_at
    from events
    where is_canonical and merged_into is null and not suppressed`);

  const sourceRows = await db.execute(sql`
    select s.event_id, s.source, s.source_event_id, s.raw
    from event_sources s
    join events e on e.id = s.event_id`);

  const sourcesByEvent = new Map<
    string,
    Array<{ source: string; sourceEventId: string | null; raw: unknown }>
  >();
  for (const r of sourceRows) {
    const eventId = r.event_id as string;
    let list = sourcesByEvent.get(eventId);
    if (!list) {
      list = [];
      sourcesByEvent.set(eventId, list);
    }
    list.push({
      source: r.source as string,
      sourceEventId: r.source_event_id as string | null,
      raw: r.raw,
    });
  }

  const events = new Map<string, Ev>();
  for (const r of eventRows) {
    const id = r.id as string;
    const srcs = sourcesByEvent.get(id) ?? [];
    events.set(id, {
      id,
      slug: r.slug as string,
      title: r.title as string,
      normTitle: normalizeTitle(r.title as string),
      startsAt: toDateTime(r.starts_at),
      endsAt: r.ends_at === null ? null : toDateTime(r.ends_at),
      partyNight: r.party_night as string,
      venueId: r.venue_id as string | null,
      priceMinCents: r.price_min_cents as number | null,
      priceMaxCents: r.price_max_cents as number | null,
      isFree: r.is_free as boolean,
      ageRestriction: r.age_restriction as string | null,
      ticketUrl: r.ticket_url as string | null,
      flyerUrl: r.flyer_url as string | null,
      firstSeenMs: toDateTime(r.first_seen_at).toMillis(),
      sources: srcs.map((s) => ({ source: s.source, sourceEventId: s.sourceEventId })),
      lineup: lineupSet(srcs.flatMap((s) => lineupFromRaw(s.source, s.raw))),
      mergedInto: null,
    });
  }

  // Candidates: same (party_night, venue_id) only — never an O(n²) scan.
  // §10.2's fallback for unresolved venues (party_night + ST_DWithin 200m)
  // cannot run here: events carry no geography of their own, only venues do,
  // so a venue-less event has no point to measure from. Step 8 guarantees
  // 100% venue linkage; if that ever breaks, the events are skipped and
  // counted rather than silently dropped.
  const groups = new Map<string, Ev[]>();
  let skippedNoVenue = 0;
  for (const ev of events.values()) {
    if (ev.venueId === null) {
      skippedNoVenue++;
      console.warn(`dedupe: event ${ev.id} has no venue_id — skipped (no geog fallback possible)`);
      continue;
    }
    const key = `${ev.partyNight}|${ev.venueId}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(ev);
  }

  const pairs: EvaluatedPair[] = [];
  interface PendingMerge {
    a: Ev;
    b: Ev;
    score: number | null;
    pair: EvaluatedPair;
  }
  const hardMerges: PendingMerge[] = [];
  const scoredMerges: PendingMerge[] = [];
  let groupCount = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    groupCount++;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const pair: EvaluatedPair = {
          aId: a.id,
          bId: b.id,
          aTitle: a.title,
          bTitle: b.title,
          partyNight: a.partyNight,
          venueId: a.venueId,
          outcome: "separate",
          reason: "",
          score: null,
          threshold: null,
          components: null,
        };
        pairs.push(pair);

        // 1. Hard merge rules — before everything else.
        if (sharedSourceId(a, b)) {
          pair.outcome = "merged-hard";
          pair.reason = "same platform + same event id";
          hardMerges.push({ a, b, score: null, pair });
          continue;
        }
        if (a.ticketUrl !== null && a.ticketUrl === b.ticketUrl) {
          pair.outcome = "merged-hard";
          pair.reason = "identical ticket_url";
          hardMerges.push({ a, b, score: null, pair });
          continue;
        }

        // 2. Hard never-merge — blocks before scoring.
        const conflict = platformConflict(a, b);
        if (conflict !== null) {
          pair.outcome = "blocked";
          pair.reason = `same platform (${conflict}), different event ids — multi-room/multi-session`;
          continue;
        }

        // 3. Score. pg_trgm similarity goes through raw sql, never a JS clone.
        const [simRow] = await db.execute(
          sql`select similarity(${a.normTitle}, ${b.normTitle})::float8 as s`,
        );
        const components: PairComponents = {
          title: Number(simRow.s),
          lineup:
            a.lineup.size === 0 || b.lineup.size === 0 ? null : jaccard(a.lineup, b.lineup),
          start: startProximity(a.startsAt.toMillis(), b.startsAt.toMillis()),
          price: priceProximity(a.priceMinCents, b.priceMinCents),
        };
        const scored = combineScore(components);
        pair.score = scored.score;
        pair.threshold = scored.threshold;
        pair.components = components;

        if (scored.score >= scored.threshold) {
          pair.outcome = "merged-scored";
          pair.reason = `score ${scored.score.toFixed(3)} ≥ ${scored.threshold}`;
          scoredMerges.push({ a, b, score: scored.score, pair });
        } else {
          pair.reason = `score ${scored.score.toFixed(3)} < ${scored.threshold}`;
        }
      }
    }
  }

  // Apply hard merges first, then scored merges best-first, re-checking the
  // platform rule against each canonical row's accumulated sources so two
  // same-platform events can never end up under one canonical via a chain.
  const rootOf = (ev: Ev): Ev => {
    let cur = ev;
    while (cur.mergedInto !== null) {
      const next = events.get(cur.mergedInto);
      if (!next) break;
      cur = next;
    }
    return cur;
  };

  scoredMerges.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
  const merges: MergeRecord[] = [];

  for (const pending of [...hardMerges, ...scoredMerges]) {
    const ra = rootOf(pending.a);
    const rb = rootOf(pending.b);
    if (ra.id === rb.id) {
      pending.pair.reason += " (already merged via another pair)";
      continue;
    }
    if (pending.score !== null) {
      const conflict = platformConflict(ra, rb);
      if (conflict !== null) {
        pending.pair.outcome = "blocked";
        pending.pair.reason = `blocked at apply: platform (${conflict}) conflict via an earlier merge`;
        continue;
      }
    }

    // Winner: highest-trust source; earlier first_seen_at breaks ties.
    let winner = ra;
    let loser = rb;
    if (
      trustRank(rb) < trustRank(ra) ||
      (trustRank(rb) === trustRank(ra) && rb.firstSeenMs < ra.firstSeenMs)
    ) {
      winner = rb;
      loser = ra;
    }

    const resolutions = resolveFields(winner, loser);
    loser.mergedInto = winner.id;

    // Never delete (§10.5): the loser keeps its row, its slug, and its
    // event_sources — only the flags change, so clearing merged_into fully
    // restores it.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update events set is_canonical = false, merged_into = ${winner.id}
        where id = ${loser.id}`);
      // Timestamps bind as ISO strings with explicit offset — the postgres.js
      // raw path rejects JS Date params (and returns timestamptz as strings;
      // the same never-assume-driver-types rule, in both directions).
      await tx.execute(sql`
        update events set
          title = ${winner.title},
          starts_at = ${winner.startsAt.toISO()},
          ends_at = ${winner.endsAt === null ? null : winner.endsAt.toISO()},
          price_min_cents = ${winner.priceMinCents},
          price_max_cents = ${winner.priceMaxCents},
          is_free = ${winner.isFree},
          age_restriction = ${winner.ageRestriction},
          ticket_url = ${winner.ticketUrl},
          flyer_url = ${winner.flyerUrl}
        where id = ${winner.id}`);
    });

    merges.push({
      winnerId: winner.id,
      loserId: loser.id,
      winnerTitle: winner.title,
      loserTitle: loser.title,
      score: pending.score,
      resolutions,
    });
  }

  const hardMerged = merges.filter((m) => m.score === null).length;
  const scoredMerged = merges.length - hardMerged;
  return {
    groups: groupCount,
    pairsEvaluated: pairs.length,
    hardMerged,
    scoredMerged,
    blocked: pairs.filter((p) => p.outcome === "blocked").length,
    separate: pairs.filter((p) => p.outcome === "separate").length,
    skippedNoVenue,
    pairs,
    merges,
  };
}

/**
 * §10.5 reversibility: clearing the flags restores the loser row untouched —
 * its fields, slug, and event_sources never changed. The canonical row keeps
 * the merged field values until the next ingest run refreshes it from its own
 * source payload (see the ingest-refresh caveat in the Step 10 report).
 */
export async function unmerge(loserId: string, db?: Db): Promise<void> {
  db = db ?? (await defaultDb());
  await db.execute(sql`
    update events set is_canonical = true, merged_into = null
    where id = ${loserId}`);
}
