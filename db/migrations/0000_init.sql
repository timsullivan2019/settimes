create extension if not exists postgis;
create extension if not exists pg_trgm;

create table venues (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique not null,
  aliases       text[] default '{}',
  address       text,
  neighborhood  text,
  region        text,                       -- manhattan|brooklyn|queens|bronx|si|jersey
  geog          geography(Point, 4326),
  capacity_band text,
  website       text,
  instagram     text,
  is_dark       boolean default false,
  created_at    timestamptz default now()
);
create index venues_geog_idx on venues using gist (geog);
create index venues_name_trgm on venues using gin (name gin_trgm_ops);

create table artists (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique not null,
  aliases    text[] default '{}',
  mbid       text,
  discogs_id text,
  ra_slug    text,
  genres     text[] default '{}',
  soundcloud text,
  instagram  text,
  is_local   boolean default false,
  created_at timestamptz default now()
);
create index artists_name_trgm on artists using gin (name gin_trgm_ops);

create table events (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique not null,
  title            text not null,
  starts_at        timestamptz not null,
  ends_at          timestamptz,
  party_night      date not null,
  venue_id         uuid references venues(id),
  venue_name_raw   text,
  address_raw      text,
  price_min_cents  int,
  price_max_cents  int,
  is_free          boolean default false,
  door_only        boolean default false,
  age_restriction  text,
  genres           text[] default '{}',
  genre_confidence real,
  genre_source     text,
  blurb            text,
  flyer_url        text,
  ticket_url       text,
  status           text default 'confirmed',
  address_secret   boolean default false,
  is_canonical     boolean default true,
  merged_into      uuid references events(id),
  suppressed       boolean default false,
  first_seen_at    timestamptz default now(),
  last_seen_at     timestamptz default now()
);
create index events_night_idx on events (party_night)
  where is_canonical and not suppressed;
create index events_title_trgm on events using gin (title gin_trgm_ops);

create table event_sources (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid references events(id) on delete cascade,
  source          text not null,
  source_event_id text,
  source_url      text,
  raw             jsonb not null,
  fetched_at      timestamptz default now(),
  unique (source, source_event_id)
);

create table event_artists (
  event_id      uuid references events(id) on delete cascade,
  artist_id     uuid references artists(id),
  billing_order int default 0,
  is_headliner  boolean default false,
  set_time      timestamptz,
  primary key (event_id, artist_id)
);

create table promoters (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique not null,
  instagram     text,
  contact_email text,
  opted_in      boolean default false,
  opted_out     boolean default false,
  notes         text
);

create table submissions (
  id         uuid primary key default gen_random_uuid(),
  payload    jsonb not null,
  flyer_url  text,
  submitter  text,
  status     text default 'pending',
  event_id   uuid references events(id),
  created_at timestamptz default now()
);

create table reports (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid references events(id) on delete cascade,
  kind       text not null,        -- wrong_time|wrong_genre|cancelled|not_real
  note       text,
  created_at timestamptz default now()
);

create table ingest_runs (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  started_at  timestamptz default now(),
  finished_at timestamptz,
  found       int default 0,
  created     int default 0,
  updated     int default 0,
  errors      int default 0,
  error_text  text
);
