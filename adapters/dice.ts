import { DateTime } from "luxon";
import { z } from "zod";
import { parseLineup } from "../lib/artists";
import { fetcher, type Fetcher } from "../lib/fetcher";
import { NY_TZ, parseLocal } from "../lib/time";
import { NormalEventSchema, type NormalEvent } from "../lib/types";

// Dice's server-rendered browse pages embed only the first ~25 events and
// ignore the ?cursor= param (verified live 2026-07-29: page 2 fetched with the
// SSR nextCursor returns the same events), so the browse page alone cannot
// paginate. The complete public path is the browse page's own data API,
// events-api.dice.fm/v1/events — the exact requests the site makes for an
// anonymous visitor. Its API key is public: dice.fm serves it inline to every
// logged-out visitor as window.EVENTS_API_KEY. It is scraped from the page at
// runtime, never hardcoded, so a key rotation follows the site automatically.
const DICE_BROWSE_URL = "https://dice.fm/browse";
const DICE_EVENTS_API_URL = "https://events-api.dice.fm/v1/events";
const API_KEY_RE = /window\.EVENTS_API_KEY = '([^']+)'/;

const CITY_FILTER = "New York";
// Dice's primary browse filters for this scene. music:dj is the site's "DJ"
// tab; music:party carries many electronic parties (party:house, party:edm,
// party:tech-house tags) alongside non-electronic ones — genre classification
// (Step 14) sorts those out. music:gig (live bands) is excluded.
const TYPE_TAGS = ["music:dj", "music:party"];
const WINDOW_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

// Both observed Dice datetime shapes carry an explicit offset: the events API
// returns UTC instants ("2026-08-02T18:00:00Z"), the browse SSR returns local
// offsets ("2026-08-02T14:00:00-04:00") — verified live 2026-07-29. parseLocal
// keeps the instant either way. A naive string (no offset) is a format change
// and must fail loudly here rather than be guessed at.
const offsetDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    "expected an offset-carrying datetime like 2026-08-02T18:00:00Z",
  );

// Tier prices are integer cents. total = face_value + fees — the number Dice
// itself displays on event cards (verified against browse SSR `price`).
const DiceTicketTypeSchema = z.object({
  id: z.number(),
  name: z.string(),
  price: z.object({
    total: z.number().int().nonnegative(),
    fees: z.number().int().nonnegative(),
    face_value: z.number().int().nonnegative(),
  }),
  sold_out: z.boolean(),
});

const DiceArtistSchema = z.object({
  id: z.number(),
  name: z.string().min(1),
  headliner: z.boolean(),
});

const DiceVenueSchema = z.object({
  id: z.number(),
  name: z.string().min(1),
});

// Sale states observed live 2026-07-29: on-sale, off-sale, sold-out,
// cancelled. postponed included for the §9.1 rule-2 mapping. A value outside
// this list is new behavior and fails loudly.
const DiceStatusSchema = z.enum(["on-sale", "off-sale", "sold-out", "cancelled", "postponed"]);

const DiceEventSchema = z.object({
  id: z.string().min(1),
  perm_name: z.string().min(1),
  name: z.string().min(1),
  type: z.string(),
  date: offsetDateTime,
  date_end: offsetDateTime.nullable(),
  timezone: z.string().min(1),
  status: DiceStatusSchema,
  sold_out: z.boolean(),
  address: z.string().nullable(),
  age_limit: z.string().nullable(),
  external_url: z.string().nullable(),
  ticket_types: z.array(DiceTicketTypeSchema),
  detailed_artists: z.array(DiceArtistSchema),
  artists: z.array(z.string()),
  venues: z.array(DiceVenueSchema),
  images: z.array(z.string()),
});

const DiceResponseSchema = z.object({
  data: z.array(DiceEventSchema),
  links: z.object({
    self: z.string(),
    next: z.string().nullable().optional(),
  }),
});

type DiceEvent = z.infer<typeof DiceEventSchema>;

function normalize(raw: unknown, e: DiceEvent): NormalEvent {
  const startsAt = parseLocal(e.date, e.timezone).toJSDate();
  const endsAt = e.date_end === null ? null : parseLocal(e.date_end, e.timezone).toJSDate();

  // §9.1 rule 4: price = lowest CURRENTLY AVAILABLE tier. A sold-out early
  // bird is not the price. Fully sold-out events have no available price —
  // null, never the lowest historical tier.
  const available = e.ticket_types.filter((t) => !t.sold_out);
  const priceMinCents = available.length > 0 ? Math.min(...available.map((t) => t.price.total)) : null;
  const priceMaxCents = available.length > 0 ? Math.max(...available.map((t) => t.price.total)) : null;

  // Structured lineup preferred (carries Dice artist ids in raw); the plain
  // string list is the fallback. Each name still goes through parseLineup to
  // strip "(live)"-style notes.
  const artistNames = e.detailed_artists.length > 0 ? e.detailed_artists.map((a) => a.name) : e.artists;

  if (e.venues.length === 0) {
    console.warn(`dice: event ${e.id} ${JSON.stringify(e.name)} has no venue — venue_name_raw=null`);
  }
  if (e.venues.length > 1) {
    console.warn(`dice: event ${e.id} lists ${e.venues.length} venues — using the first`);
  }

  // The event page is the checkout on Dice — a real ticket link, unlike RA
  // (§10.4's identical-ticket_url auto-merge applies). The payload's `url`
  // field (link.dice.fm) is an attribution redirect — it stays in raw but is
  // never used as ticket_url and never fetched. type="linkout" events ticket
  // externally via external_url.
  const eventPage = `https://dice.fm/event/${e.perm_name}`;
  const ticketUrl = e.external_url ?? eventPage;

  const candidate = {
    source: "dice" as const,
    sourceEventId: e.id,
    sourceUrl: eventPage,
    title: e.name,
    startsAt,
    endsAt,
    venueNameRaw: e.venues[0]?.name ?? null,
    addressRaw: e.address,
    artists: artistNames.flatMap((name) => parseLineup(name)),
    priceMinCents,
    priceMaxCents,
    isFree: priceMinCents === 0,
    doorOnly: false,
    // Free text on Dice ("This is a 21+ event", "21+ ") — stored as sent,
    // never normalized into a value the source didn't state.
    ageRestriction: e.age_limit?.trim() || null,
    flyerUrl: e.images[0] ?? null,
    // §9.1 rule 2: cancelled/postponed only on this explicit source signal.
    // Sale states (on-sale, off-sale, sold-out) are not event states.
    ticketUrl,
    status:
      e.status === "cancelled" || e.status === "postponed"
        ? e.status
        : ("confirmed" as const),
    addressSecret: false,
    raw,
  };

  const parsed = NormalEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `dice: event ${e.id} failed NormalEvent validation:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

async function fetchApiKey(fetchImpl: Fetcher): Promise<string> {
  const response = await fetchImpl(DICE_BROWSE_URL, {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  if (response.status !== 200) {
    throw new Error(`dice: HTTP ${response.status} fetching browse page for API key`);
  }
  const html = await response.text();
  const key = API_KEY_RE.exec(html)?.[1];
  if (!key) {
    throw new Error("dice: window.EVENTS_API_KEY not found on browse page — page format changed");
  }
  return key;
}

export interface DiceAdapterOptions {
  fetchImpl?: Fetcher;
  /** Called with each page's raw parsed JSON, before validation. */
  onPage?: (page: number, rawResponse: unknown) => void;
  /** Injectable clock for tests. */
  now?: DateTime;
}

export async function fetchEvents(options: DiceAdapterOptions = {}): Promise<NormalEvent[]> {
  const { fetchImpl = fetcher, onPage } = options;
  const today = (options.now ?? DateTime.now()).setZone(NY_TZ);

  const apiKey = await fetchApiKey(fetchImpl);

  const firstUrl = new URL(DICE_EVENTS_API_URL);
  firstUrl.searchParams.set("page[size]", String(PAGE_SIZE));
  firstUrl.searchParams.append("filter[cities][]", CITY_FILTER);
  for (const tag of TYPE_TAGS) firstUrl.searchParams.append("filter[type_tags][]", tag);
  firstUrl.searchParams.set("filter[date_from]", today.toISODate() ?? "");
  firstUrl.searchParams.set("filter[date_to]", today.plus({ days: WINDOW_DAYS }).toISODate() ?? "");

  const byId = new Map<string, NormalEvent>();
  let url: string | null = firstUrl.toString();

  for (let page = 1; url !== null && page <= MAX_PAGES; page++) {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "x-api-key": apiKey },
    });
    if (response.status !== 200) {
      throw new Error(`dice: HTTP ${response.status} on page ${page}`);
    }
    const json: unknown = await response.json();

    const parsed = DiceResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `dice: response failed validation on page ${page}:\n${z.prettifyError(parsed.error)}`,
      );
    }
    onPage?.(page, json);

    const { data, links } = parsed.data;
    if (data.length === 0) break;

    // json.data and parsed.data.data are index-aligned; the untouched raw
    // object is what lands in event_sources.raw.
    const rawData = (json as { data: unknown[] }).data;
    for (const [i, e] of data.entries()) {
      if (!byId.has(e.id)) {
        byId.set(e.id, normalize(rawData[i], e));
      }
    }

    url = links.next ?? null;
  }

  return [...byId.values()];
}
