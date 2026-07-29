import { sql } from "drizzle-orm";
import { db as defaultDb, type Db } from "../db/client";
import { fetcher, type Fetcher } from "./fetcher";
import { shortHash, slugify } from "./slug";

// Step 8: venue resolution. Match order (§9 pipeline):
//   exact name → alias array → trigram similarity ≥0.6 → create new + geocode.
// events.venue_name_raw is never touched — resolution only sets events.venue_id,
// so an improved matcher can always be re-run against history.

const TRIGRAM_THRESHOLD = 0.6;

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// NYC metro (~25mi around Manhattan, incl. north Jersey). bounded=1 keeps a
// bare venue-name query from matching some same-named business elsewhere;
// a metro venue Nominatim can't find inside the box stays ungeocoded (null
// geog, logged) rather than getting a wrong point.
const NYC_VIEWBOX = "-74.5,41.1,-73.4,40.2";

// §9.1 rule 6: TBA/secret-location listings. These get address_secret=true
// and must never be geocoded — display "Bushwick — address released day-of",
// never a point.
const ADDRESS_SECRET_RE = /\b(tba|tbd|secret|location (announced|released)|dm for)\b/i;

export function isAddressSecret(venueNameRaw: string | null): boolean {
  return venueNameRaw !== null && ADDRESS_SECRET_RE.test(venueNameRaw);
}

export type VenueMatch = "exact" | "alias" | "trigram" | "created";

export interface ResolvedVenue {
  venueId: string;
  matched: VenueMatch;
  /** similarity score when matched === "trigram" */
  score?: number;
}

interface Geocoded {
  lat: number;
  lon: number;
  displayName: string;
}

// A venue geocode must land on a place-like feature. Without this, a bare
// name inside the bounding box can match a street ("SILO" → "Silo Circle",
// a residential road in Greenwich CT) or a whole neighborhood ("TBA -
// Bushwick" → Bushwick). A wrong point is worse than a null one.
const ACCEPT_CATEGORIES = new Set([
  "amenity",
  "building",
  "shop",
  "leisure",
  "tourism",
  "club",
  "office",
  "craft",
  "man_made",
]);

async function searchNominatim(query: string, fetchImpl: Fetcher): Promise<Geocoded | null> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "3");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("viewbox", NYC_VIEWBOX);
  url.searchParams.set("bounded", "1");

  // lib/fetcher.ts enforces ≥1 req/sec per host and the project User-Agent —
  // both required by Nominatim's usage policy.
  const response = await fetchImpl(url.toString());
  if (response.status !== 200) {
    console.warn(`venues: nominatim HTTP ${response.status} for ${JSON.stringify(query)}`);
    return null;
  }
  const results = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    category: string;
    type: string;
  }>;
  if (!Array.isArray(results)) return null;
  for (const hit of results) {
    if (!ACCEPT_CATEGORIES.has(hit.category)) {
      console.log(
        `venues: geocode rejected [${hit.category}/${hit.type}] for ${JSON.stringify(query)}: ${hit.display_name}`,
      );
      continue;
    }
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon, displayName: hit.display_name };
    }
  }
  return null;
}

export async function geocode(name: string, fetchImpl: Fetcher = fetcher): Promise<Geocoded | null> {
  // Compound names hide the geocodable part: "Pier 78 at Hudson River Park"
  // misses while "Pier 78" hits, "Westlight Rooftop at The William Vale"
  // misses while "The William Vale" hits. Try the full name, then each side
  // of " at ". Only the raw name is used — nothing is invented.
  const candidates = [name];
  const atIndex = name.indexOf(" at ");
  if (atIndex > 0) {
    candidates.push(name.slice(0, atIndex).trim(), name.slice(atIndex + 4).trim());
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const hit = await searchNominatim(candidate, fetchImpl);
    if (hit !== null) return hit;
  }
  return null;
}

export async function resolveVenue(
  nameRaw: string,
  db: Db = defaultDb,
  fetchImpl: Fetcher = fetcher,
): Promise<ResolvedVenue> {
  const name = nameRaw.trim();
  if (!name) throw new Error("resolveVenue: empty venue name");

  // 1. Exact name (case-insensitive).
  const exact = await db.execute(
    sql`select id from venues where lower(name) = lower(${name}) limit 1`,
  );
  if (exact.length > 0) return { venueId: exact[0].id as string, matched: "exact" };

  // 2. Alias array (case-insensitive).
  const alias = await db.execute(sql`
    select id from venues
    where exists (select 1 from unnest(aliases) a where lower(a) = lower(${name}))
    limit 1`);
  if (alias.length > 0) return { venueId: alias[0].id as string, matched: "alias" };

  // 3. Trigram similarity ≥0.6, best match wins. pg_trgm goes through raw sql.
  const trigram = await db.execute(sql`
    select id, name, similarity(name, ${name}) as score
    from venues
    where similarity(name, ${name}) >= ${TRIGRAM_THRESHOLD}
    order by score desc
    limit 1`);
  if (trigram.length > 0) {
    const score = Number(trigram[0].score);
    console.log(
      `venues: trigram ${JSON.stringify(name)} → ${JSON.stringify(trigram[0].name)} (${score.toFixed(2)})`,
    );
    return { venueId: trigram[0].id as string, matched: "trigram", score };
  }

  // 4. Create new + geocode.
  const geo = await geocode(name, fetchImpl);
  const geogFragment =
    geo === null
      ? sql`null`
      : sql`ST_SetSRID(ST_MakePoint(${geo.lon}, ${geo.lat}), 4326)::geography`;
  const address = geo?.displayName ?? null;

  const baseSlug = slugify(name) || "venue";
  let inserted = await db.execute(sql`
    insert into venues (name, slug, address, geog)
    values (${name}, ${baseSlug}, ${address}, ${geogFragment})
    on conflict (slug) do nothing
    returning id`);
  if (inserted.length === 0) {
    // Slug taken by a different venue; disambiguate deterministically.
    inserted = await db.execute(sql`
      insert into venues (name, slug, address, geog)
      values (${name}, ${`${baseSlug}-${shortHash(name, 4)}`}, ${address}, ${geogFragment})
      returning id`);
  }

  // Every new venue is logged for human review.
  console.log(
    `venues: CREATED ${JSON.stringify(name)} slug=${baseSlug} ` +
      (geo === null ? "geocode=MISS" : `geocode=(${geo.lat}, ${geo.lon}) ${geo.displayName}`),
  );
  return { venueId: inserted[0].id as string, matched: "created" };
}
