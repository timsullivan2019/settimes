import { readFileSync } from "node:fs";
import { client } from "../db/client";
import { applySeedRow, type SeedPoint } from "../lib/venue-seed";

// Usage: npx tsx --env-file=.env.local scripts/apply-venue-seed.ts
//
// Reads docs/venue-seed.csv (§16.2 hand-seeded venues) and applies filled-in
// rows: address, geog from lat/lng, aliases (pipe-separated, e.g.
// "S.O.B.'s|Sounds of Brazil"). Safe to re-run as more rows get filled —
// updates are idempotent and blank cells are skipped, never cleared.
//
// Runs on the postgres.js client (see lib/venue-seed.ts for why not drizzle).

const CSV_PATH = "docs/venue-seed.csv";

// Sanity box for hand-entered coordinates: NYC metro plus margin. A typo'd
// point is exactly the silent radius-filter poison the addendum warns about.
const LAT_RANGE = [39.5, 41.5];
const LNG_RANGE = [-75.5, -72.5];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

async function main(): Promise<void> {
  const [header, ...rows] = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const expected = ["venue_name_raw", "event_count", "aliases", "address", "lat", "lng", "notes"];
  if (header.join(",") !== expected.join(",")) {
    throw new Error(`unexpected CSV header: ${header.join(",")}`);
  }

  let applied = 0;
  let skippedBlank = 0;

  for (const row of rows) {
    const [name, , aliasesRaw, address, latRaw, lngRaw] = row.map((f) => f.trim());
    const aliases = aliasesRaw
      ? aliasesRaw.split("|").map((a) => a.trim()).filter(Boolean)
      : [];
    if (!aliases.length && !address && !latRaw && !lngRaw) {
      skippedBlank++;
      continue;
    }

    const venue = await client`
      select id from venues where lower(name) = lower(${name}) limit 1`;
    if (venue.length === 0) {
      console.warn(`seed: no venue named ${JSON.stringify(name)} — skipped`);
      continue;
    }
    const venueId = venue[0].id as string;

    if ((latRaw === "") !== (lngRaw === "")) {
      console.warn(`seed: ${JSON.stringify(name)} has only one of lat/lng — point skipped`);
    }
    let point: SeedPoint | null = null;
    if (latRaw !== "" && lngRaw !== "") {
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      const sane =
        Number.isFinite(lat) && Number.isFinite(lng) &&
        lat >= LAT_RANGE[0] && lat <= LAT_RANGE[1] &&
        lng >= LNG_RANGE[0] && lng <= LNG_RANGE[1];
      if (!sane) {
        console.warn(`seed: ${JSON.stringify(name)} lat/lng (${latRaw}, ${lngRaw}) outside metro sanity box — point skipped`);
      } else {
        point = { lat, lng };
      }
    }

    await applySeedRow(client, venueId, { aliases, address: address || null, point });
    applied++;
    console.log(
      `seed: applied ${JSON.stringify(name)}` +
        (point !== null ? ` point=(${point.lat}, ${point.lng})` : "") +
        (address ? " address" : "") +
        (aliases.length > 0 ? ` aliases=[${aliases.join(", ")}]` : ""),
    );
  }

  console.log(`\napplied: ${applied} · untouched blank rows: ${skippedBlank}`);

  const [m] = await client`
    select
      count(*) filter (where not address_secret)::int as eligible,
      count(*) filter (where not address_secret
        and exists (select 1 from venues v where v.id = events.venue_id and v.geog is not null)
      )::int as with_point
    from events`;
  const eligible = m.eligible as number;
  const withPoint = m.with_point as number;
  console.log(
    `events with a usable point, excluding address_secret: ${withPoint}/${eligible} ` +
      `(${((100 * withPoint) / eligible).toFixed(1)}%)`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
