import { eq, sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { events, eventSources, ingestRuns } from "../db/schema";
import { computePartyNight } from "./time";
import { eventSlug, shortHash } from "./slug";
import type { NormalEvent, Source } from "./types";

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
  const slug = name
    .normalize("NFKD")
    // strip combining diacritics left over from NFKD
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-venue";
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
    addressSecret: e.addressSecret,
  };
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
    // This source payload already owns an events row: refresh its fields from
    // the newest payload (the naive "recompute the canonical row") and bump
    // last_seen_at. The slug stays as minted — it is a public URL.
    await db
      .update(events)
      .set({ ...eventFieldsFrom(e, partyNight), lastSeenAt: sql`now()` })
      .where(eq(events.id, sourceRow.eventId));
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
