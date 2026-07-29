import { eq, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { events, eventSources, ingestRuns } from "../db/schema";
import { resolveCanonical, toDateTime, type CanonicalMember } from "./canonical";
import { computePartyNight } from "./time";
import { eventSlug, shortHash, slugify } from "./slug";
import type { NormalEvent, Source } from "./types";
import { isAddressSecret } from "./venues";

// Step 5: naive ingest. No dedupe, no genre classification, no venue
// resolution — venue_name_raw only. Safe to run twice: the second run with
// identical data creates zero new rows.

export interface IngestResult {
  runId: string;
  found: number;
  created: number;
  updated: number;
  errors: number;
  errorText: string | null;
}

// Interim venue component for the event slug, derived from venue_name_raw.
// Step 8 resolves venues to real rows with their own slugs and may change how
// this component is derived — existing slugs stay as minted (URLs are stable).
function slugifyVenueName(name: string | null): string {
  if (name === null) return "unknown-venue";
  return slugify(name) || "unknown-venue";
}

function eventFieldsFrom(e: NormalEvent, partyNight: string) {
  return {
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    partyNight,
    venueNameRaw: e.venueNameRaw,
    addressRaw: e.addressRaw,
    priceMinCents: e.priceMinCents,
    priceMaxCents: e.priceMaxCents,
    isFree: e.isFree,
    doorOnly: e.doorOnly,
    ageRestriction: e.ageRestriction,
    flyerUrl: e.flyerUrl,
    ticketUrl: e.ticketUrl,
    status: e.status,
    // §9.1 rule 6 detection ORs with the adapter's own signal — detection can
    // add the flag, never clear an adapter-set one.
    addressSecret: e.addressSecret || isAddressSecret(e.venueNameRaw),
  };
}

// The ingest-clobber fix: a canonical row holds §10.4-resolved data from
// every source in its merge group, so after ANY member's source refreshes its
// own row, the canonical root is recomputed from ALL members. Without this,
// one RA run nulls the Dice price and ticket_url on every dice→ra canonical
// row — and dedupe never repairs it, because merged pairs are not re-evaluated.
//
// Each member's row is that source's own current view (its owning ingest is
// the only field writer), with one bounded exception: when a LOSER's source
// ingests, the root's row still holds previously-resolved values and re-enters
// resolution as-is. min/union/most-restrictive folds are idempotent over
// resolved values, so this converges — a retracted value can only linger until
// the root's own source next ingests (every 6h in production), and stale is
// the recoverable direction (§9.1 rule 2).
async function recomputeMergeGroup(db: Db, memberId: string): Promise<void> {
  // Root of the member's merge chain (merged_into normally points straight at
  // the canonical row; the recursion tolerates chains).
  const roots = await db.execute(sql`
    with recursive up as (
      select id, merged_into, 0 as depth from events where id = ${memberId}
      union all
      select e.id, e.merged_into, up.depth + 1
      from events e join up on e.id = up.merged_into
      where up.depth < 20
    )
    select id from up where merged_into is null`);
  if (roots.length !== 1) return;
  const rootId = roots[0].id as string;

  const memberRows = await db.execute(sql`
    with recursive grp as (
      select id, title, starts_at, ends_at, price_min_cents, price_max_cents,
             is_free, age_restriction, ticket_url, flyer_url
      from events where id = ${rootId}
      union all
      select e.id, e.title, e.starts_at, e.ends_at, e.price_min_cents,
             e.price_max_cents, e.is_free, e.age_restriction, e.ticket_url,
             e.flyer_url
      from events e join grp on e.merged_into = grp.id
    )
    select g.*,
           (select coalesce(array_agg(distinct s.source), '{}')
              from event_sources s where s.event_id = g.id) as sources
    from grp g`);
  if (memberRows.length < 2) return; // not a merge group — the row is its own view

  // Root first: resolveCanonical keeps the root's value on full ties.
  memberRows.sort((a, b) => (a.id === rootId ? -1 : b.id === rootId ? 1 : 0));
  const members: CanonicalMember[] = memberRows.map((r) => ({
    id: r.id as string,
    sources: (r.sources as string[]) ?? [],
    title: r.title as string,
    startsAt: toDateTime(r.starts_at),
    endsAt: r.ends_at === null ? null : toDateTime(r.ends_at),
    priceMinCents: r.price_min_cents as number | null,
    priceMaxCents: r.price_max_cents as number | null,
    isFree: r.is_free as boolean,
    ageRestriction: r.age_restriction as string | null,
    ticketUrl: r.ticket_url as string | null,
    flyerUrl: r.flyer_url as string | null,
  }));

  const { fields } = resolveCanonical(members);
  // party_night is rewritten from the resolved start so the SQL invariant
  // (starts_at NY-local minus 6h) can never drift; group members share a
  // night by §10.2 construction, so the value is stable in practice.
  await db.execute(sql`
    update events set
      title = ${fields.title},
      starts_at = ${fields.startsAt.toISO()},
      ends_at = ${fields.endsAt === null ? null : fields.endsAt.toISO()},
      party_night = ${computePartyNight(fields.startsAt.toJSDate())},
      price_min_cents = ${fields.priceMinCents},
      price_max_cents = ${fields.priceMaxCents},
      is_free = ${fields.isFree},
      age_restriction = ${fields.ageRestriction},
      ticket_url = ${fields.ticketUrl},
      flyer_url = ${fields.flyerUrl}
    where id = ${rootId}`);
}

async function ingestOne(db: Db, e: NormalEvent): Promise<"created" | "updated"> {
  // Raw payload lands in event_sources first, before anything touches events
  // — and the (source, source_event_id) row is also the idempotency anchor:
  // its event_id tells the second run which events row this payload owns.
  const [sourceRow] = await db
    .insert(eventSources)
    .values({
      source: e.source,
      sourceEventId: e.sourceEventId,
      sourceUrl: e.sourceUrl,
      raw: e.raw,
    })
    .onConflictDoUpdate({
      target: [eventSources.source, eventSources.sourceEventId],
      set: {
        sourceUrl: e.sourceUrl,
        raw: e.raw,
        fetchedAt: sql`now()`,
      },
    })
    .returning({ id: eventSources.id, eventId: eventSources.eventId });

  const partyNight = computePartyNight(e.startsAt);

  if (sourceRow.eventId !== null) {
    // This source payload already owns an events row: refresh THAT row from
    // the newest payload and bump last_seen_at. The slug stays as minted — it
    // is a public URL. For a merge-group loser this write is the whole story:
    // the loser row is exactly "what this source says" (dedupe only ever
    // touches its flags). For a canonical root it is transient — the group
    // recompute below immediately re-resolves it per §10.4, so canonical
    // fields are never left owned by one source's payload.
    await db
      .update(events)
      .set({ ...eventFieldsFrom(e, partyNight), lastSeenAt: sql`now()` })
      .where(eq(events.id, sourceRow.eventId));
    await recomputeMergeGroup(db, sourceRow.eventId);
    return "updated";
  }

  // New event row. If the slug is already taken it belongs to a *different*
  // event (same venue + night + title hash); disambiguate deterministically
  // with the source event id so a rerun mints the identical slug.
  const baseSlug = eventSlug(slugifyVenueName(e.venueNameRaw), partyNight, e.title);
  const fields = eventFieldsFrom(e, partyNight);
  let inserted = await db
    .insert(events)
    .values({ slug: baseSlug, ...fields })
    .onConflictDoNothing({ target: events.slug })
    .returning({ id: events.id });
  if (inserted.length === 0) {
    inserted = await db
      .insert(events)
      .values({ slug: `${baseSlug}-${shortHash(e.source + e.sourceEventId, 4)}`, ...fields })
      .returning({ id: events.id });
  }

  await db
    .update(eventSources)
    .set({ eventId: inserted[0].id })
    .where(eq(eventSources.id, sourceRow.id));
  return "created";
}

export async function ingest(
  source: Source,
  normalEvents: NormalEvent[],
  db: Db = defaultDb,
): Promise<IngestResult> {
  const [run] = await db.insert(ingestRuns).values({ source }).returning({ id: ingestRuns.id });

  let created = 0;
  let updated = 0;
  let errors = 0;
  const errorMessages: string[] = [];

  for (const e of normalEvents) {
    try {
      const outcome = await ingestOne(db, e);
      if (outcome === "created") created++;
      else updated++;
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`ingest: ${source} ${e.sourceEventId} failed: ${message}`);
      if (errorMessages.length < 5) {
        errorMessages.push(`${e.sourceEventId}: ${message}`);
      }
    }
  }

  const result = {
    found: normalEvents.length,
    created,
    updated,
    errors,
    errorText: errorMessages.length > 0 ? errorMessages.join("\n") : null,
  };

  await db
    .update(ingestRuns)
    .set({ ...result, finishedAt: sql`now()`, errorText: result.errorText })
    .where(eq(ingestRuns.id, run.id));

  return { runId: run.id, ...result };
}
