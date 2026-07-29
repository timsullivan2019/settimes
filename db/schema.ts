import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Drizzle has no first-class geography type. All spatial queries go through
// the raw sql`` helper — this type exists only so the column is in the schema.
const geography = customType<{ data: string }>({
  dataType() {
    return "geography(Point, 4326)";
  },
});

export const venues = pgTable(
  "venues",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    aliases: text("aliases").array().default(sql`'{}'`),
    address: text("address"),
    neighborhood: text("neighborhood"),
    region: text("region"), // manhattan|brooklyn|queens|bronx|si|jersey
    geog: geography("geog"),
    capacityBand: text("capacity_band"),
    website: text("website"),
    instagram: text("instagram"),
    isDark: boolean("is_dark").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [
    index("venues_geog_idx").using("gist", t.geog),
    index("venues_name_trgm").using("gin", t.name.op("gin_trgm_ops")),
  ],
);

export const artists = pgTable(
  "artists",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    aliases: text("aliases").array().default(sql`'{}'`),
    mbid: text("mbid"),
    discogsId: text("discogs_id"),
    raSlug: text("ra_slug"),
    genres: text("genres").array().default(sql`'{}'`),
    soundcloud: text("soundcloud"),
    instagram: text("instagram"),
    isLocal: boolean("is_local").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [index("artists_name_trgm").using("gin", t.name.op("gin_trgm_ops"))],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: text("slug").unique().notNull(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    partyNight: date("party_night").notNull(),
    venueId: uuid("venue_id").references(() => venues.id),
    venueNameRaw: text("venue_name_raw"),
    addressRaw: text("address_raw"),
    priceMinCents: integer("price_min_cents"),
    priceMaxCents: integer("price_max_cents"),
    isFree: boolean("is_free").default(false),
    doorOnly: boolean("door_only").default(false),
    ageRestriction: text("age_restriction"),
    genres: text("genres").array().default(sql`'{}'`),
    genreConfidence: real("genre_confidence"),
    genreSource: text("genre_source"),
    blurb: text("blurb"),
    flyerUrl: text("flyer_url"),
    ticketUrl: text("ticket_url"),
    status: text("status").default("confirmed"),
    addressSecret: boolean("address_secret").default(false),
    isCanonical: boolean("is_canonical").default(true),
    mergedInto: uuid("merged_into").references((): AnyPgColumn => events.id),
    suppressed: boolean("suppressed").default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [
    index("events_night_idx")
      .on(t.partyNight)
      .where(sql`is_canonical and not suppressed`),
    index("events_title_trgm").using("gin", t.title.op("gin_trgm_ops")),
  ],
);

export const eventSources = pgTable(
  "event_sources",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceEventId: text("source_event_id"),
    sourceUrl: text("source_url"),
    raw: jsonb("raw").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).default(sql`now()`),
  },
  (t) => [unique("event_sources_source_source_event_id_key").on(t.source, t.sourceEventId)],
);

export const eventArtists = pgTable(
  "event_artists",
  {
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id").references(() => artists.id),
    billingOrder: integer("billing_order").default(0),
    isHeadliner: boolean("is_headliner").default(false),
    setTime: timestamp("set_time", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.artistId] })],
);

export const promoters = pgTable("promoters", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  instagram: text("instagram"),
  contactEmail: text("contact_email"),
  optedIn: boolean("opted_in").default(false),
  optedOut: boolean("opted_out").default(false),
  notes: text("notes"),
});

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  payload: jsonb("payload").notNull(),
  flyerUrl: text("flyer_url"),
  submitter: text("submitter"),
  status: text("status").default("pending"),
  eventId: uuid("event_id").references(() => events.id),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
});

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // wrong_time|wrong_genre|cancelled|not_real
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`),
});

export const ingestRuns = pgTable("ingest_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).default(sql`now()`),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  found: integer("found").default(0),
  created: integer("created").default(0),
  updated: integer("updated").default(0),
  errors: integer("errors").default(0),
  errorText: text("error_text"),
});
