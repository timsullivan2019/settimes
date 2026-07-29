import type { Sql } from "postgres";

// The venue-seed update path (§16.2), shared by scripts/apply-venue-seed.ts
// and its tests. Runs on the postgres.js client, NOT drizzle's sql template:
// drizzle expands a JS array param into N scalar placeholders — `($4,$5,$6)`
// is a record, and `record::text[]` is a Postgres error (42846). postgres.js
// binds the whole array as a single parameter, which works for any length
// including zero.

export interface SeedPoint {
  lat: number;
  lng: number;
}

export interface SeedUpdate {
  /** Merged (distinct union) into venues.aliases. May be empty. */
  aliases: string[];
  /** null leaves the stored address untouched. */
  address: string | null;
  /** null leaves the stored geog untouched. */
  point: SeedPoint | null;
}

export async function applySeedRow(pg: Sql, venueId: string, update: SeedUpdate): Promise<void> {
  const geogFragment =
    update.point === null
      ? pg`null::geography`
      : pg`ST_SetSRID(ST_MakePoint(${update.point.lng}, ${update.point.lat}), 4326)::geography`;
  await pg`
    update venues set
      address = coalesce(${update.address}, address),
      geog = coalesce(${geogFragment}, geog),
      aliases = (
        select coalesce(array_agg(distinct a), '{}')
        from unnest(aliases || ${update.aliases}::text[]) a
      )
    where id = ${venueId}`;
}
