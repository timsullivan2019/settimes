import { DateTime } from "luxon";
import { sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { computePartyNight } from "../../../lib/time";

// The shared read query (§5.5). The web page imports this function directly;
// the /api/events route serves the same rows to any future client. Route
// files may only export handlers, so the query lives here beside the route.

export interface UpcomingEvent {
  id: string;
  slug: string;
  title: string;
  /** ISO 8601 instant with explicit offset (UTC). */
  starts_at: string;
  ends_at: string | null;
  /** YYYY-MM-DD. Selected as ::text — postgres.js hydrates DATE into a JS
   *  Date at UTC midnight, which renders a day early in America/New_York. */
  party_night: string;
  venue_name_raw: string | null;
  artist_names: string[];
  price_min_cents: number | null;
  is_free: boolean;
  age_restriction: string | null;
  ticket_url: string | null;
  flyer_url: string | null;
  status: string;
}

const DEFAULT_LIMIT = 200;

// Raw db.execute rows come back from the drizzle/postgres-js driver with
// timestamptz as a string like "2026-07-28 23:00:00+00" (drizzle disables the
// driver's date hydration for raw queries). The value carries its own offset;
// normalize it to a strict ISO 8601 UTC instant. Throws on anything else —
// never guess a time.
function isoInstant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const sql = DateTime.fromSQL(value, { setZone: true });
    const parsed = sql.isValid ? sql : DateTime.fromISO(value, { setZone: true });
    const iso = parsed.isValid ? parsed.toUTC().toISO() : null;
    if (iso !== null) return iso;
  }
  throw new Error(`isoInstant: unparseable timestamptz ${JSON.stringify(value)}`);
}

export async function getUpcomingEvents(limit: number = DEFAULT_LIMIT): Promise<UpcomingEvent[]> {
  // "Upcoming" keys on party_night, not the calendar date: at 1am Sunday the
  // current party night is still Saturday's, so in-progress parties stay listed.
  const tonight = computePartyNight(DateTime.now());

  // event_artists is not populated until artist resolution (Step 8+); until
  // then the lineup comes from the raw source payload. The ->'event'->
  // 'artists' path is the RA listing shape stored in event_sources.raw.
  const rows = await db.execute(sql`
    select
      e.id,
      e.slug,
      e.title,
      e.starts_at,
      e.ends_at,
      e.party_night::text as party_night,
      e.venue_name_raw,
      coalesce(lineup.names, '{}') as artist_names,
      e.price_min_cents,
      e.is_free,
      e.age_restriction,
      e.ticket_url,
      e.flyer_url,
      e.status
    from events e
    left join lateral (
      select array_agg(a.value ->> 'name' order by a.ord) as names
      from event_sources s
      cross join lateral jsonb_array_elements(s.raw -> 'event' -> 'artists')
        with ordinality as a(value, ord)
      where s.event_id = e.id
    ) lineup on true
    where e.is_canonical
      and not e.suppressed
      and e.party_night >= ${tonight}::date
    order by e.starts_at asc
    limit ${limit}
  `);

  return rows.map((r) => ({
    id: r.id as string,
    slug: r.slug as string,
    title: r.title as string,
    starts_at: isoInstant(r.starts_at),
    ends_at: r.ends_at === null ? null : isoInstant(r.ends_at),
    party_night: r.party_night as string,
    venue_name_raw: r.venue_name_raw as string | null,
    artist_names: r.artist_names as string[],
    price_min_cents: r.price_min_cents as number | null,
    is_free: r.is_free as boolean,
    age_restriction: r.age_restriction as string | null,
    ticket_url: r.ticket_url as string | null,
    flyer_url: r.flyer_url as string | null,
    status: r.status as string,
  }));
}
