import { sql } from "drizzle-orm";
import { client, db } from "../db/client";

// Post-Step-9 cleanup: the Dice ingest created venue rows that duplicate
// venues RA had already created under slightly different names. Each merge
// records the Dice spelling as an alias on the surviving row (so the next
// ingest resolves it via the alias match, not trigram luck), repoints the
// events, and deletes the duplicate row. Idempotent: a merged pair is skipped
// on rerun.
//
// Deliberately NOT merged — room-level names stay separate venues:
//   "Elsewhere - Rooftop", "Pianos: Showroom", "Pianos: The Mezzanine",
//   "Harriet's Lounge - 1 Hotel"
// A room is not an alias of its building. Collapsing rooms into the parent
// venue would make same-night events in different rooms land on the same
// (party_night, venue_id) key, which is exactly the §10 RELATED case the
// dedupe hard rules must keep as separate events (Elsewhere's Hall vs Zone
// One). Multi-room modeling is backlog (§5.3); until then, distinct rows are
// the representation that keeps dedupe honest.

const MERGES: Array<{ dupe: string; target: string }> = [
  { dupe: "Elsewhere, Brooklyn", target: "Elsewhere" },
  { dupe: "314 Scholes St, Brooklyn, NY 11206, USA", target: "LoHi" },
  { dupe: "Marquee Skydeck at Edge Hudson Yards", target: "Marquee Skydeck Edge" },
  { dupe: "Circle Line Boat", target: "Circle Line Cruises" },
];

// Geocodes that landed on unrelated POIs inside the bounding box ("Paradise
// Coney Island" → a flower shop, "Brooklyn Backyard" → a garden). A wrong
// point silently corrupts the radius filter; null does not. The address
// column on these rows came from the same wrong geocode, so it is nulled too.
const WRONG_GEOCODES = ["Paradise Coney Island", "Brooklyn Backyard"];

async function overlapCount(): Promise<number> {
  const [row] = await db.execute(sql`
    with dice_events as (
      select e.id, e.venue_id, e.party_night
      from events e join event_sources s on s.event_id = e.id and s.source = 'dice'
    ),
    ra_events as (
      select e.venue_id, e.party_night
      from events e join event_sources s on s.event_id = e.id and s.source = 'ra'
    )
    select count(distinct d.id)::int as n
    from dice_events d
    join ra_events r on r.venue_id = d.venue_id and r.party_night = d.party_night
    where d.venue_id is not null`);
  return row.n as number;
}

async function main(): Promise<void> {
  const before = await overlapCount();
  console.log(`dice events sharing (party_night, venue_id) with an RA event — before: ${before}`);

  for (const { dupe, target } of MERGES) {
    const dupeRows = await db.execute(sql`select id from venues where name = ${dupe}`);
    if (dupeRows.length === 0) {
      console.log(`skip (already merged?): ${JSON.stringify(dupe)}`);
      continue;
    }
    const targetRows = await db.execute(sql`select id from venues where name = ${target}`);
    if (targetRows.length !== 1) {
      throw new Error(
        `target ${JSON.stringify(target)} matched ${targetRows.length} venues — refusing to guess`,
      );
    }
    const dupeId = dupeRows[0].id as string;
    const targetId = targetRows[0].id as string;

    // Scalar binding only (array_append), per the array-parameter rule.
    await db.execute(sql`
      update venues set aliases = array_append(aliases, ${dupe})
      where id = ${targetId} and not (${dupe} = any(aliases))`);
    const repointed = await db.execute(sql`
      update events set venue_id = ${targetId} where venue_id = ${dupeId} returning id`);
    await db.execute(sql`delete from venues where id = ${dupeId}`);
    console.log(
      `merged ${JSON.stringify(dupe)} → ${JSON.stringify(target)} (${repointed.length} events repointed)`,
    );
  }

  for (const name of WRONG_GEOCODES) {
    const rows = await db.execute(sql`
      update venues set geog = null, address = null
      where name = ${name} and geog is not null
      returning name`);
    console.log(
      rows.length > 0
        ? `nulled wrong geocode on ${JSON.stringify(name)}`
        : `skip (no point set): ${JSON.stringify(name)}`,
    );
  }

  const after = await overlapCount();
  console.log(`dice events sharing (party_night, venue_id) with an RA event — after: ${after}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
