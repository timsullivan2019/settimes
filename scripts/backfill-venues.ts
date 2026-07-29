import { sql } from "drizzle-orm";
import { client, db } from "../db/client";
import { geocode, resolveVenue, type VenueMatch } from "../lib/venues";

// Usage: npx tsx --env-file=.env.local scripts/backfill-venues.ts
// Resolves venue_id for every event that lacks one, then prints the Step 8
// verification report. Idempotent: events with venue_id set are skipped.

async function main(): Promise<void> {
  const names = await db.execute(sql`
    select venue_name_raw as name, count(*)::int as n
    from events
    where venue_id is null and venue_name_raw is not null
    group by 1
    order by n desc`);
  console.log(`distinct unresolved venue names: ${names.length}`);

  const tally: Record<VenueMatch, number> = { exact: 0, alias: 0, trigram: 0, created: 0 };
  const failures: Array<{ name: string; error: string }> = [];

  for (const row of names) {
    const name = row.name as string;
    try {
      const resolved = await resolveVenue(name);
      tally[resolved.matched]++;
      await db.execute(sql`
        update events set venue_id = ${resolved.venueId}
        where venue_name_raw = ${name} and venue_id is null`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name, error: message });
      console.warn(`backfill: ${JSON.stringify(name)} failed: ${message}`);
    }
  }

  console.log("\nmatch tally:", tally);
  if (failures.length > 0) console.log("failures:", failures);

  // Second pass: venues that exist but never geocoded. Retries are cheap and
  // the geocoder improves over time; only null-geog venues are touched.
  const ungeocode = await db.execute(
    sql`select id, name from venues where geog is null order by name`,
  );
  console.log(`\nre-geocoding ${ungeocode.length} venues with null geog`);
  let regeocoded = 0;
  for (const v of ungeocode) {
    const geo = await geocode(v.name as string);
    if (geo === null) continue;
    await db.execute(sql`
      update venues
      set geog = ST_SetSRID(ST_MakePoint(${geo.lon}, ${geo.lat}), 4326)::geography,
          address = coalesce(address, ${geo.displayName})
      where id = ${v.id}`);
    regeocoded++;
    console.log(`venues: GEOCODED ${JSON.stringify(v.name)} → ${geo.displayName}`);
  }
  console.log(`re-geocoded: ${regeocoded}/${ungeocode.length}`);

  const [totals] = await db.execute(sql`
    select
      (select count(*)::int from events) as total,
      (select count(*)::int from events e
         join venues v on v.id = e.venue_id
       where v.geog is not null) as with_geog,
      (select count(*)::int from events where venue_id is null) as no_venue`);
  const total = totals.total as number;
  const withGeog = totals.with_geog as number;
  console.log(
    `\nevents resolved to a venue with non-null geog: ${withGeog}/${total} ` +
      `(${((100 * withGeog) / total).toFixed(1)}%) — events with no venue_id: ${totals.no_venue}`,
  );

  const unresolved = await db.execute(sql`
    select e.venue_name_raw as name, count(*)::int as n
    from events e
    left join venues v on v.id = e.venue_id
    where v.geog is null
    group by 1
    order by n desc`);
  console.log(`\nunresolved venue_name_raw (venue missing or geog null) — ${unresolved.length} names:`);
  for (const r of unresolved) console.log(`  ${r.n}  ${r.name}`);

  const top = await db.execute(sql`
    select v.name, count(*)::int as n
    from events e
    join venues v on v.id = e.venue_id
    group by v.name
    order by n desc
    limit 10`);
  console.log("\ntop 10 venues by events:");
  for (const r of top) console.log(`  ${r.n}  ${r.name}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
