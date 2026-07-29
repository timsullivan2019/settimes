import { DateTime } from "luxon";
import { z } from "zod";
import { parseLineup } from "../lib/artists";
import { fetcher, type Fetcher } from "../lib/fetcher";
import { NY_TZ, parseLocal } from "../lib/time";
import { NormalEventSchema, type NormalEvent } from "../lib/types";

const RA_GRAPHQL_URL = "https://ra.co/graphql";
const RA_ORIGIN = "https://ra.co";
const NYC_AREA_ID = 8;
const WINDOW_DAYS = 30;
const PAGE_SIZE = 20;

// scripts/ra-query.json with the tracking fields cut out and the fragment
// trimmed to facts — no pick.blurb (editorial prose), no image metadata,
// because the payload is stored verbatim in event_sources.
//
// The resolver ERRORS if the `bumps` selection is deleted entirely (verified
// live 2026-07-28: "Error fetching event listings & bumps"), so a minimal
// `bumps { bumpDecision { id } }` stays — it returns ids only. clickUrl and
// impressionUrl are never requested, so tracking URLs never enter the payload.
const QUERY = `query GET_EVENT_LISTINGS_WITH_BUMPS($filters: FilterInputDtoInput, $page: Int, $pageSize: Int, $sort: SortInputDtoInput, $areaId: ID) {
  eventListingsWithBumps(
    filters: $filters
    pageSize: $pageSize
    page: $page
    sort: $sort
    areaId: $areaId
  ) {
    eventListings {
      data {
        id
        listingDate
        event {
          ...eventListingsFields
        }
      }
      totalResults
    }
    bumps {
      bumpDecision {
        id
      }
    }
  }
}

fragment eventListingsFields on Event {
  id
  date
  startTime
  endTime
  title
  contentUrl
  flyerFront
  isTicketed
  venue {
    id
    name
    contentUrl
  }
  artists {
    id
    name
  }
}`;

// RA sends naive local datetimes with the date already joined to the time:
// "2026-07-28T19:00:00.000" (verified live 2026-07-28). No offset — the value
// is NYC wall time. Anything else — date-only, time-only, or a string carrying
// an offset — is a format change and must fail loudly here rather than parse
// to an instant hours off.
const naiveDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/,
    "expected a naive local datetime like 2026-07-28T19:00:00.000",
  );

const RaArtistSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
});

const RaVenueSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  contentUrl: z.string().nullable(),
});

const RaEventSchema = z.object({
  id: z.string().min(1),
  date: naiveDateTime,
  startTime: naiveDateTime,
  endTime: naiveDateTime.nullable(),
  title: z.string().min(1),
  contentUrl: z.string().nullable(),
  flyerFront: z.string().nullable(),
  isTicketed: z.boolean(),
  venue: RaVenueSchema.nullable(),
  artists: z.array(RaArtistSchema),
});

const RaListingSchema = z.object({
  id: z.string(),
  listingDate: z.string(),
  event: RaEventSchema,
});

const RaResponseSchema = z.object({
  data: z.object({
    eventListingsWithBumps: z.object({
      eventListings: z.object({
        data: z.array(RaListingSchema),
        totalResults: z.number().int().nonnegative(),
      }),
    }),
  }),
});

type RaListing = z.infer<typeof RaListingSchema>;

function absolutize(path: string | null): string | null {
  if (path === null) return null;
  return path.startsWith("/") ? `${RA_ORIGIN}${path}` : path;
}

function normalize(listing: RaListing): NormalEvent {
  const e = listing.event;

  // startTime already carries its own date (see naiveDateTime above), so it is
  // the joined "date + time" string. Do NOT re-join with e.date: an event
  // listed under Saturday whose doors open Sunday 01:00 has date=Sat but
  // startTime=Sun 01:00, and grafting Sat onto 01:00 would shift it a day.
  const startsAt = parseLocal(e.startTime, NY_TZ).toJSDate();
  const endsAt = e.endTime === null ? null : parseLocal(e.endTime, NY_TZ).toJSDate();

  if (e.venue === null) {
    console.warn(`ra: event ${e.id} ${JSON.stringify(e.title)} has no venue — venue_name_raw=null`);
  }
  if (e.contentUrl === null) {
    console.warn(`ra: event ${e.id} ${JSON.stringify(e.title)} has no contentUrl — source_url=null`);
  }

  const sourceUrl = absolutize(e.contentUrl);

  const candidate = {
    source: "ra" as const,
    sourceEventId: e.id,
    sourceUrl,
    title: e.title,
    startsAt,
    endsAt,
    venueNameRaw: e.venue?.name ?? null,
    addressRaw: null,
    // Structured artist array used directly — no string splitting. Each name
    // still goes through parseLineup to strip "(live)" / "(AV)" style notes.
    artists: e.artists.flatMap((a) => parseLineup(a.name)),
    // RA does not return price in this listing payload.
    priceMinCents: null,
    priceMaxCents: null,
    isFree: false,
    doorOnly: false,
    ageRestriction: null,
    flyerUrl: absolutize(e.flyerFront),
    // Always null from RA: ra.co/events/<id> is a listing page, not a
    // checkout link, and RA returns no price — so it can't satisfy §10.4's
    // "lowest available price → that source's ticket link". The page itself
    // lives on in event_sources.source_url ("View on RA").
    ticketUrl: null,
    status: "confirmed" as const,
    addressSecret: false,
    raw: listing,
  };

  const parsed = NormalEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `ra: event ${e.id} failed NormalEvent validation:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export interface RaAdapterOptions {
  fetchImpl?: Fetcher;
  /** Called with each page's raw parsed JSON, before validation. */
  onPage?: (page: number, rawResponse: unknown) => void;
  /** Injectable clock for tests. */
  now?: DateTime;
}

export async function fetchEvents(options: RaAdapterOptions = {}): Promise<NormalEvent[]> {
  const { fetchImpl = fetcher, onPage } = options;
  const today = (options.now ?? DateTime.now()).setZone(NY_TZ);
  const gte = today.toISODate();
  const lte = today.plus({ days: WINDOW_DAYS }).toISODate();

  // Multi-day events surface once per listingDate; key on the RA event id so
  // each event normalizes exactly once.
  const byId = new Map<string, NormalEvent>();
  let totalPages = 1;

  for (let page = 1; page <= totalPages; page++) {
    const body = {
      operationName: "GET_EVENT_LISTINGS_WITH_BUMPS",
      variables: {
        filters: {
          areas: { eq: NYC_AREA_ID },
          listingDate: { gte, lte },
        },
        pageSize: PAGE_SIZE,
        page,
        sort: {
          listingDate: { order: "ASCENDING" },
          score: { order: "DESCENDING" },
          titleKeyword: { order: "ASCENDING" },
        },
        areaId: NYC_AREA_ID,
      },
      query: QUERY,
    };

    const response = await fetchImpl(RA_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        "ra-content-language": "en",
      },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) {
      throw new Error(`ra: HTTP ${response.status} on page ${page}`);
    }
    const json: unknown = await response.json();

    if (typeof json === "object" && json !== null && "errors" in json) {
      throw new Error(`ra: GraphQL errors on page ${page}: ${JSON.stringify(json.errors)}`);
    }
    const parsed = RaResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `ra: response failed validation on page ${page}:\n${z.prettifyError(parsed.error)}`,
      );
    }
    onPage?.(page, json);

    const { data, totalResults } = parsed.data.data.eventListingsWithBumps.eventListings;
    if (page === 1) totalPages = Math.ceil(totalResults / PAGE_SIZE);
    if (data.length === 0) break;

    for (const listing of data) {
      if (!byId.has(listing.event.id)) {
        byId.set(listing.event.id, normalize(listing));
      }
    }
  }

  return [...byId.values()];
}
