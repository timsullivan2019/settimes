# NYC Electronic Music Event Discovery — Complete Plan

**Version:** consolidated, July 2026
**Author context:** solo builder, working NYC DJ, no revenue goal
**Status:** pre-build. One core assumption remains untested (see §4).

> **Note for a reviewing agent:** this document is written to be critiqued. Decisions carry their rationale and their rejected alternatives. §4 lists every load-bearing assumption with a confidence level and a falsification test. §18 lists what I don't know. Attack those first — the schema and the build order are the easy parts to fix.

---

## 1. What this is

A free, open web app that shows every electronic music / DJ event in the NYC metro (five boroughs + Jersey within ~25 miles of Manhattan), filterable by genre, date, time of night, price, and distance.

Not a business. Target operating cost is under $5/month (§14), and the explicit goal is a public good for the scene the builder is part of.

**One-sentence positioning:**

> The only place that shows NYC electronic events from every ticketing platform at once — genre inferred rather than self-reported, filterable by price and time-of-night, published as an open feed by someone who isn't selling anything.

---

## 2. The problem, and the evidence for it

**Stated problem:** finding electronic events in NYC requires checking RA, then Dice, then Posh, then a dozen Instagram accounts, and the smallest events appear in none of them.

**Evidence that the gap is real:**

| Evidence | Source | Confidence |
|---|---|---|
| No consumer product aggregates across RA + Dice + Posh for NYC. Every cross-source aggregator found is a developer scraping tool sold on Apify to engineers and tour managers. | Search, July 2026 | High |
| 19hz.info — the reference volunteer electronic calendar — covers 16 regions including Iowa/Nebraska and has **no New York section**. | Fetched 19hz.info directly | High |
| Ticketing is genuinely fragmented: Posh is now one of the largest US nightlife platforms, with DICE and Shotgun strong in music-led niches. | Posh's own 2026 comparison content | Medium |
| The most-used discovery tools for this scene are Instagram accounts, which cannot be filtered at all. | @nyc_raves ~84K, @nyc.rave.girls ~80K | High |

**Evidence that cuts against it — do not skip this:**

Historic NYC underground listings follow the pattern *"email for the location — advance tickets via residentadvisor.net."* Even secret-location warehouse parties have long ticketed through RA. Posh has taken share since, but the founding intuition that *RA misses the underground* is weaker than it feels from inside the scene. **This is the assumption the whole project rests on, and it has not been measured.** See §4.1 and §17.

---

## 3. Competitive landscape (verified July 2026)

### 3.1 Resident Advisor — stronger than assumed

- **Electronic Music Genres**, launched **November 2022**: sub-genre browsing across 62–80 electronic sub-genres. RA built it explicitly because small DIY promoters struggle to stand out and fans can't find parties matching their taste.
- **RA Guide app**: filters by type, size, genre, date, popularity, RA Picks, and a "For You" feed. Syncs with **Spotify and Apple Music** for personalized discovery. Precise geolocation.
- Scale: ~2M events, ~6M users, 192 countries, 4.86 App Store rating.

**Therefore: "nobody lets you filter NYC by genre" is false.** RA shipped exactly that three and a half years ago, aimed at exactly this problem.

**The crack:** RA's genre tags are *promoter-supplied* — someone ticks boxes at listing time. The DIY promoters RA built it for are the least likely to bother, and it only covers events listed on RA at all.

### 3.2 The real incumbents are Instagram accounts

- **@nyc_raves** — ~84K followers
- **@nyc.rave.girls** — ~80K followers, weekly party recs every Tuesday, community Discord, built since late 2023

One profile described the latter as *scene translators, making New York's house and techno landscape legible for people who actually want to dance*, and noted that in a city full of promoters and collectives the most trusted voices in NY nightlife might be two people with a TikTok account.

**This is the real competitive set.** Not RA. The winning product in "help me find a party" is currently human curation with a personality, and it has a six-figure audience.

### 3.3 Newsletters occupy the same job

Haus of Vibes (explicitly framed around *the scene being bigger than Brooklyn Mirage*), Rave New World, BKMag weekend guides, sober-nightlife weeklies, Bands do BK. All human-curated, all loyal, **none filterable**.

### 3.4 Where not to compete

| Don't | Why |
|---|---|
| Personalization | RA syncs Spotify and Apple Music. Spotify's API is closed to new apps. You lose. |
| Curation voice | The Instagram accounts own this. Don't try to be a scene personality. |
| App polish | RA Guide is a mature native app. You're a fast mobile web page. |

Compete on **completeness, filterability, openness** — three things the incumbents structurally cannot do. RA will never list Posh's events. Instagram cannot be filtered.

---

## 4. Assumptions register

*The most important section for a reviewer.*

### 4.1 Load-bearing, untested

| # | Assumption | Confidence | Falsification test |
|---|---|---|---|
| **A1** | Aggregating Dice + Posh + venue crawl surfaces meaningfully more NYC events than RA alone | **Low–Medium** | §17 Week One Gate. <10/week ⇒ thesis dead |
| **A2** | People will use a filter-first tool rather than scrolling Instagram | Medium | §17.3. Of ~50 people told about it, how many still open it in week 4? |
| **A2b** | Utility without curation voice can earn scene trust | Medium–High | Precedent: 19hz has held loyalty across 16 regions for 20 years with no voice, no design, no taste-making |
| **A3** | Inferred genre beats promoter-supplied tags in practice | Medium | Sample 100 events; compare coverage and accuracy vs RA's tags |
| **A4** | 20–30 promoters will opt in because the builder is a DJ | Medium–High | Week 2 outreach. <10 yes ⇒ the human channel fails |

### 4.2 Technical, verified

| # | Assumption | Confidence | Basis |
|---|---|---|---|
| T1 | RA's GraphQL endpoint is reachable unauthenticated | High | Multiple working open-source scrapers; RA event pages also carry JSON-LD as fallback |
| T2 | Dice, Posh public pages are parseable | High | Numerous working commercial scrapers exist |
| T3 | Venue sites emit schema.org Event JSON-LD | Medium | Common but uneven; the crawler must degrade gracefully |
| T4 | LLM genre classification is accurate enough | Medium | Untested on this domain. Measure confidence distribution in week 1 |
| T5 | Dedupe can hit <2% false merges | Medium | Weights in §10 are guesses until tuned against labelled data |

### 4.3 Assumptions deliberately abandoned

- ~~"Nobody offers genre filtering"~~ — false, RA does (§3.1)
- ~~"RA misses the underground"~~ — unproven and contested (§2)
- ~~"Spotify can power personalization"~~ — API closed (§8.4)
- ~~"This should be pitched as an industry/B2B tool"~~ — considered and cut. It pulls the product away from the actual mission: a fan deciding where to dance at 10pm. Telling 50 people you know is still the launch tactic; it just isn't a repositioning.

---

## 5. Scope

### 5.1 v1 — exactly this

| In | Why |
|---|---|
| RA + Dice + Posh adapters | ~75% coverage for ~20% of the work |
| Generic JSON-LD crawler | Best effort-to-coverage ratio in the project |
| `/submit` form | The human channel; also the promoter relationship |
| Venue + artist resolution | Dedupe cannot work without it |
| Dedupe | Without it the product feels broken |
| Genre classification | The differentiator |
| Filters: when / genre / price / where | The literal problem statement |
| **Share affordance: OG images + Web Share** | Group chats are the real UI of this scene. Shareable URLs without a share *affordance* means the product never reaches where coordination actually happens. Small build, disproportionate reach. |
| Open feed (JSON + ICS) | One afternoon; the public-good proof — and ICS sync is a power-user feature |

### 5.2 Non-goals

- Not a ticketing platform. Never handle money. Always link out.
- Not a social network. No feed, no comments, no accounts in v1.
- Not multi-city. **Ever.** (See §16 — expansion is how these die.)
- Not a leak. Address-secret events stay secret.

### 5.3 Backlog — real, deliberately fenced

Email ingestion · **public RSS feeds of scene newsletters** (cleanest remaining source — RSS exists to be machine-read, zero ToS question) · Telegram · Discord (invited, never infiltrated) · flyer vision parsing · Bandsintown artist watchlist · booking agency rosters · community radio schedules · Shotgun / Ticketmaster / SeatGeek adapters · co-billing similarity · alerts and digests · multi-room modeling · residency modeling · set times · all-in pricing · accessibility info

**Gate:** nothing moves from backlog to build until v1 has been live two weeks **and** you can write down the specific user complaint it fixes. **No exceptions.**

*(A date-conflict checker for promoters was considered and cut. It's an industry tool, and the mission is a fan deciding where to dance at 10pm.)*

### 5.4 Phases — where iOS sits

iOS is a **stated future phase**, not backlog and not v1. Writing it down here is what keeps it from leaking into v1.

| Phase | What | Gate |
|---|---|---|
| **1 — Backend + web** | Everything in §5.1. Adapters, database, dedupe, genre classification, mobile web with filters and sharing. | — |
| **2 — Installable web (PWA)** | Manifest, icons, service worker. Home-screen icon, full-screen, no browser chrome. Push notifications possible on iOS once installed. | Optional, ~an afternoon |
| **3 — Native iOS app** | Thin client over the same API. Reliable push ("that DJ is playing Friday"), offline cache, share extension. | Only after §17.1 clears **and** §17.3 shows ≥20 weekly returners |

**Why this order, not the reverse:**

- The scrapers can never live on a phone. iOS kills background work; it won't wake every six hours, and it won't run with the app closed. The backend is required either way, so an app is *additional* work, never alternative work.
- Distribution depends on links. Your launch is dropping URLs in group chats — instant open, flyer-like preview. An app link means App Store → download → open, and most people never finish that for a tool they've never heard of.
- Iteration speed. Web ships in 90 seconds; App Store review takes days. The whole plan is built on measuring fast and being willing to stop.
- Cost. $99/yr plus Swift or React Native, versus a live URL tonight.

### 5.5 Two decisions now that keep iOS cheap later

Almost nothing needs to change — but two choices, made tonight, mean the app is a thin client later instead of a rewrite:

1. **Keep queries behind a route, not only inside page components.** Put the read logic in `app/api/events/route.ts` and have the web page call it (or share the same query function). If every query lives only inside a React server component, there's nothing for an app to talk to and you'd rebuild it. One file's difference now.
2. **`/feed.json` is effectively your public API — design it as one.** Stable field names, ISO 8601 timestamps, explicit timezone, pagination, and never remove a field without versioning. You're publishing it as open data anyway; if it's clean, it's also what the iOS app consumes on day one. It's also what lets *someone else* build a client on your data, which is the point of publishing it.

That's the whole preparation. No abstraction layers, no premature generalizing — just don't bury the queries and don't let the feed shape drift.

---

## 6. Architecture

### 6.1 Stack, with rationale

| Layer | Choice | Why | Rejected |
|---|---|---|---|
| Language | TypeScript everywhere | One repo, one deploy, one mental model. Context-switching kills solo projects. | Python scrapers + TS web — better libs, worse focus |
| DB | Supabase Postgres + PostGIS + pg_trgm | Radius queries and fuzzy matching built in; free tier | SQLite (no geo), Mongo (no joins, and this is relational) |
| Web | Next.js App Router on Vercel | Server components mean no separate API layer | SPA + API — twice the surface for no gain |
| Scheduler | GitHub Actions cron | Free, version-controlled, logs included | Vercel cron (fine), VPS (more ops) |
| Parsing | `cheerio` + `undici` | Fast, no browser | Playwright — 10× slower and heavier; use only where forced |
| LLM | Anthropic API | Genre classification | Local model — not worth the ops at this volume |
| Geocoding | Nominatim (OSM) | Free, no key | Google Maps — needs billing |

**Explicit anti-pattern:** do not default to a headless browser. Most targets ship JSON in the page. Playwright only after confirming the data isn't already in the payload.

### 6.2 Flow

```
GitHub Actions cron
  ├─ ingest:ra       6h
  ├─ ingest:dice     6h
  ├─ ingest:posh     6h
  ├─ ingest:jsonld  12h
  ├─ classify:genres hourly (queue drain)
  └─ dedupe:run      after each ingest
        ↓
Supabase Postgres + PostGIS
        ↓
Next.js on Vercel
  /  · /e/[slug] · /submit · /status · /feed.json · /feed.ics
  /api/events  ← shared read layer; the web page and any future
                 iOS client both call this (see §5.5)
```

---

## 7. Data model

```sql
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
```

### 7.1 Why the model looks like this

- **`event_sources` is the architectural core.** Never overwrite an event with new data — record what each source said and recompute the canonical row. Makes dedupe reversible and bugs survivable. Also lets you show provenance in the UI, which is what makes an aggregator trustworthy.
- **`venue_name_raw` kept forever**, even post-resolution, so an improved matcher can be re-run against history.
- **`party_night`** because a Saturday 11:45pm party and a Sunday 12:30am party are the same night to a human. See §9.
- **`suppressed` and `address_secret`** are scene-trust guarantees enforced in the database, not in application logic you might forget.

---

## 8. Sources

### 8.1 v1 — structured, no auth

| Source | Access | Notes |
|---|---|---|
| **Resident Advisor** | `ra.co` GraphQL, unauthenticated | Area ID + date range. Best lineups. JSON-LD on event pages as fallback. |
| **Dice** | Public browse pages, city + genre + `priceTo` | Lowest ticket price, on-sale status, venue coordinates, doors time, age limit. |
| **Posh** | Public explore pages | Many Brooklyn parties ticket here and nowhere else. |

Three adapters. That is all of tier 1 for v1.

### 8.2 v1 — generic crawler

**One** `jsonld` adapter over a URL list: fetch, extract every `<script type="application/ld+json">` with `@type: Event | MusicEvent`, normalize. Feed it 40–60 venue pages, promoter pages, Tixr / Ticket Tailor / See Tickets / Withfriends / Eventix / Fatsoma / Partiful, any `.ics` feed, any published Google Sheet (CSV export URL, no key).

Best effort-to-coverage ratio in the project. Every new venue is one config row.

### 8.3 Excluded — and why

| Source | Reason |
|---|---|
| **EDMtrain** | Their API terms forbid combining their events with other sources to build a competing discovery service. That is precisely this product. |
| **Eventbrite search** | Public search API removed Dec 2019, no replacement. Only per-event/venue/organizer ID lookups remain. |
| **Spotify** | Nov 2024 killed Related Artists, Recommendations, Audio Features, Audio Analysis for new apps. Now also requires a Premium dev account, caps test users at 5, and gates extended access behind 250K MAU + a registered business. Cannot support login personalization. |
| **Instagram** | No compliant automated path. Business Discovery is Professional-accounts-only; App Review requires business verification and a demo; hashtag search is capped at 30 unique tags/week and Meta's approved uses (own campaigns, brand sentiment, contest entrants) don't include event aggregation. Third-party "Instagram APIs" are proxied scraping with the same exposure, outsourced. |
| **Discord scraping** | Self-bots are forbidden and get accounts terminated; the Developer Policy bars mining or scraping Discord data. Joining also means accepting the ToS, which flips you to the losing side of the case law (§15). Get invited instead. |
| **Songkick / SoundCloud / Beatport** | Gated application queues. |
| **Reddit** | Low yield, rate-limited, active litigation over scraping. |
| **Shotgun / Ticketmaster / SeatGeek** | Marginal coverage over RA+Dice+Posh; none serve the small-events mission. Ticketmaster is the first to add back if mid-size rooms turn out to be missing. |

### 8.4 Enrichment (no key required)

- **MusicBrainz** — no API key; requires a descriptive User-Agent with contact and ≤1 req/sec. Artist identity backbone, genre tags, cross-IDs to Spotify/Discogs/Wikidata.
- **Discogs** — instant personal token. Best electronic label/artist coverage; label affiliation is a strong genre signal.
- **Bandsintown** (backlog) — artist-scoped access is free and needs no application; only city-wide search is partner-gated.

---

## 9. Ingestion pipeline

```
fetch() → write event_sources (source, source_event_id, raw jsonb)
        → normalize() → NormalEvent
        → resolveVenue()    exact alias → trigram ≥0.6 → geocode+create → flag
        → resolveArtists()  exact → alias → trigram → MusicBrainz → create
        → computePartyNight()
        → dedupe()          §10
        → classifyGenres()  §11 (queued, cached)
        → upsert canonical
```

**Idempotency:** every adapter must be safe to run twice. Key `event_sources` on `(source, source_event_id)`; if a source has no stable ID, hash `source + title + starts_at + venue_name_raw`.

### 9.1 Correctness rules — non-negotiable, all cheap

Each prevents silent corruption. Each is a few lines. Each, skipped, produces a bug you won't notice for weeks.

1. **Timezones explicitly.** Dice gives ISO with offset; JSON-LD often gives `2026-08-14T23:00` with none. Parse as UTC and you shift it 4–5 hours across the party-night boundary onto the wrong day. Every adapter returns times localized to `America/New_York` via one `parseLocal()` helper, unit-tested against naive / offset / UTC inputs. On the November DST night, 1:30am occurs twice — take the first.
2. **Absence never means cancellation.** A broken scraper returning zero must not empty the calendar. Set `status='cancelled'` only on an explicit source signal. On silence, let `last_seen_at` go stale. Stale is recoverable; wrongly cancelled is not.
3. **Slugs must not collide.** `${venue-slug}-${party_night}-${shorthash(title)}`.
4. **Price = lowest *currently available*.** A sold-out $10 early bird is not the price.
5. **Parse artist names before matching.** Split on `b2b/B2B/&/+/x/vs`. Strip `(live)`, `(AV)`, `(DJ set)`, `(all night long)` into a note field. Require a **higher** trigram threshold under 6 characters — fuzzy-matching "Anna" at 0.6 merges different people.
6. **`address_secret` needs a detection rule.** Set when no street address is given, or venue matches `/\b(tba|tbd|secret|location (announced|released)|dm for)\b/i`. Display "Bushwick — address released day-of" and link out.

---

## 10. Deduplication

The same party appears on RA as *"Bunker NYC: Function"*, on Dice as *"The Bunker New York presents Function"*, on Posh as *"FUNCTION (all night long)"*. Get this wrong and the product feels broken.

### 10.1 Party-night boundary

```sql
party_night := (starts_at at time zone 'America/New_York' - interval '6 hours')::date
```

Every filter, candidate set, and the "tonight" view keys on this — never the raw calendar date.

### 10.2 Candidates

Compare only within `(party_night, venue_id)`. If venue is unresolved, fall back to `(party_night, ST_DWithin(geog, 200m))`. Keeps it to a handful of rows, not O(n²).

### 10.3 Scoring

```ts
score = 0.35 * titleSimilarity   // pg_trgm on normalized titles
      + 0.40 * lineupJaccard     // over resolved artist IDs
      + 0.15 * startProximity    // 1.0 within 60min → 0 at 180min
      + 0.10 * priceProximity
```

- `≥ 0.80` merge · `< 0.80` **leave as separate events**

**There is no review queue.** A manual triage list is a chore that gets abandoned by month two, and abandoning it means events silently rot in limbo. Instead: merge only when confident, and when uncertain, show both.

The asymmetry justifies it. A false split shows a party twice — untidy, and the user still finds it. A false merge **hides an event**, along with the wrong price and lineup, which directly attacks the mission. Duplicated listings are a cosmetic bug; deleted listings are a product failure.

If duplicates become visibly annoying, the fix is a better hard rule (§10.4), not a lower threshold.

Normalize titles first: lowercase; strip `presents`, `pres.`, `w/`, `feat.`, `b2b`, `all night long`, `[nyc]`, emoji, punctuation. Lineup overlap does the work; titles are noisy and prices lie.

**Hard rules run before scoring** — these catch most real duplicates without touching the weights:

- Identical `ticket_url`, or same platform + same event ID → **auto-merge**, no scoring
- Same venue + same night + *different* ticket URLs on the same platform → **never merge** (this is the multi-room case: Elsewhere's Hall vs Zone One, Avant Gardner's rooms)

> **The weights are guesses.** Week one: hand-label ~50 candidate pairs from your own output and sanity-check the 0.80 threshold against them. Label three ways — SAME, DISTINCT, and RELATED (same venue, same night, different room) — because RELATED is the case that would otherwise delete events from your calendar.

### 10.4 Canonical field resolution

Pick the best value per field, not one winning row:

| Field | Rule |
|---|---|
| `title` | Longest, from highest-trust source (RA > Dice > Posh > crawl > submission) |
| `starts_at` | Earliest reported |
| `price_min_cents` | **Lowest available** — a real user benefit |
| `ticket_url` | From the lowest-price source |
| artists | **Union** — sources list different support acts |
| `flyer_url` | Highest resolution |
| `age_restriction` | Most restrictive |

### 10.5 Reversibility

Never delete on merge: set `is_canonical=false`, `merged_into=<winner>`. A dedupe you can't undo is one you'll be afraid to improve.

---

## 11. Genre classification

### 11.1 Fixed taxonomy

Source tags don't reconcile — RA says "techno," Posh says "music," Dice says "electronic." Define your own:

```
house · deep house · tech house · disco / nu-disco
techno · hard techno · minimal / dub techno · electro
breaks / breakbeat · uk garage / 2-step · bass / dubstep
jungle / dnb · hardcore / gabber · trance · psytrance
footwork / juke · ballroom · jersey club · baltimore club
afro house / amapiano · latin club / reggaeton · dembow
ambient / experimental · downtempo / organic · leftfield / eclectic
open format
```

Max three per event. `open format` is a real answer, not a failure.

### 11.2 Inputs, in priority order

1. Resolved artist genres (MusicBrainz + Discogs + your accumulated labels)
2. Title and lineup
3. Venue prior
4. Promoter prior
5. Description

### 11.3 Prompt shape

```
Classify this electronic music event for a NYC listings site.
Return ONLY JSON: {"genres": string[], "confidence": number, "reasoning": string}
Choose 1–3 from this exact list: [taxonomy]
Prefer specificity. Return ["open format"] if the lineup spans 3+ unrelated genres.
```

Cache on `sha256(title + sorted(artist_ids) + venue_id)`. At ~1,000–1,500 events/month the bill is a few dollars.

### 11.4 Why this is the differentiator

RA's tags are opt-in and promoter-entered. Yours are **inferred**, so they work on every event whether or not anyone tagged it — including events RA never sees. And every classification writes labels back to `artists.genres`, so after ~2,000 events most lookups hit your own DB. It gets more accurate and cheaper over time. That accumulated labelling is the one asset nobody can copy off you.

### 11.5 Similarity without Spotify

Spotify's recommendation endpoints are closed, so build the graph from **co-billing**:

```sql
select a2.artist_id, count(*) as co_bills
from event_artists a1
join event_artists a2 on a1.event_id = a2.event_id and a1.artist_id <> a2.artist_id
where a1.artist_id = $1
group by a2.artist_id order by co_bills desc limit 20;
```

A better local signal than any global genre label, free, and yours. (Backlog — v1 has no accounts.)

---

## 12. Frontend

Mobile-first. Assume a phone at 11pm.

**Default view is tonight**, sorted by start time, before any filter is touched.

### Filter bar

| Filter | Options |
|---|---|
| When | Tonight · Tomorrow · Weekend · Dates → time-of-night band |
| Genre | Multi-select from taxonomy |
| Price | Free · <$20 · <$40 · Any |
| Where | Radius slider, or neighborhood chips |
| Age | All ages · 18+ · 21+ |

```sql
-- radius
where ST_DWithin(v.geog, ST_MakePoint($lng,$lat)::geography, $meters)

-- time-of-night must match OVERLAP, not start time:
-- someone wanting a 3am set must find the party that started at 11pm
where tstzrange(starts_at, coalesce(ends_at, starts_at + interval '5 hours'))
   && tstzrange($window_start, $window_end)
```

End times are mostly absent — "11pm–6am" lives in the title text. So: use `ends_at` if given; else regex title/description for a range; else default 5 hours and use it for filtering only, never display it.

### Event card

```
FRI 8/14 · 11PM–6AM
BOSSA NOVA CIVIC CLUB · Bushwick · 2.1 mi
─────────────────────────────────────────
DJ PYTHON · ral · Sybil
[techno] [electro]            $15 · 21+ →
```

Headliner bold. Genre chips tappable. Price = lowest across sources. Distance only with permission.

### Detail page

Lineup, set times if known, map, all ticket links cheapest-first, flyer, "report a problem," and **provenance** — "Listed on RA, Dice, and Posh." That transparency is what makes an aggregator trustworthy.

"Report a problem" must go somewhere: the `reports` table, four radio buttons, an email to yourself. Twenty minutes, and it makes the system self-healing.

### Sharing — v1, not optional

Group chats are where this scene actually coordinates. The plan previously had shareable URLs and no way to share them.

- **Dynamic OG image per event** via `next/og` at `/e/[slug]/opengraph-image`. Render bolded headliner, venue + neighborhood, date/time, lowest price, genre chips. Pasting a link into iMessage, WhatsApp, or Signal should produce a card a group can decide from **without clicking**.
- **Native share button** on the event card via `navigator.share()`, with clipboard fallback on desktop.
- Filter state lives in the URL, so "techno, under $30, Friday, Bushwick" is itself a shareable object.

### v1 has no login

Filters live in the URL so links are shareable.

---

## 13. Build order

### Tonight (3–4 hours)

0. **Spike first (10 min):** run the RA fetch *from a GitHub Actions runner*, not your laptop. Actions uses datacenter IPs and some sources block them. If it 403s, your scheduler is Vercel cron or a $5 VPS — learn that now, not after six adapters. (A public repo also gets unlimited Actions minutes, which fits the framing anyway.)
1. `create-next-app`, push to GitHub (public), add `LICENSE` (MIT) + `LICENSE-DATA` (CC0), connect Vercel
2. Supabase project, enable `postgis` + `pg_trgm`, run the §7 migration
3. `adapters/ra.ts` — GraphQL, NYC area, 30-day window → `event_sources`
4. Naive upsert into `events` — no dedupe, no genres
5. `/` — server component listing upcoming events
6. Deploy, open on your phone

**Done means:** a public URL listing real NYC events pulled automatically. Nothing else.

### Night 2
Venue resolution + seeding · `party_night` · Dice adapter · basic dedupe

### Week 1
Posh adapter · JSON-LD crawler + 25 venues · genre classification · filter bar · **100 labelled dedupe pairs and weight tuning** · Actions cron · `/status`

### Week 2 — then stop
`/submit` + `reports` · `/feed.json` + `/feed.ics` · **OG images + share button** · **telling the 50 (§16) — the real work of week 2, not code**

### That's v1

Run it two weeks. Fix only what breaks and what people complain about. The failure mode isn't shipping too little — it's nine beautiful ingestion pipelines nobody has heard of, maintained by one exhausted person.

### Phase 2 — make it installable (optional, ~an afternoon)

`manifest.json` · app icons · a minimal service worker · `apple-mobile-web-app-capable` meta. Result: "Add to Home Screen" gives a real icon that opens full-screen with no browser chrome, and unlocks web push on iOS for anyone who installs it. Most of the felt benefit of an app, none of the App Store.

### Phase 3 — native iOS (gated)

**Only after §17.1 clears and §17.3 shows ≥20 weekly returners.** If people aren't coming back to the website, an app won't fix that — it'll just be a more expensive way to be ignored.

When it's justified:

- Thin client over `/api/events` and `/feed.json` — no backend changes
- The reason to go native is **reliable push**: "an artist you follow is playing Friday." That's the one thing a PWA does less dependably on iOS.
- Secondary: offline cache for the subway, and a share extension
- Requires accounts for the first time (to store follows) — which is why v1 deliberately has none. Add auth once, at this point, not before.
- Practical route for a solo builder: React Native or Expo, since you're already in TypeScript

**Do not start Phase 3 while Phase 1 still has broken adapters.** A native app on top of unreliable data is worse than no app.

---

## 14. Operations

| Job | Cadence |
|---|---|
| RA, Dice, Posh | 6h |
| JSON-LD crawl | 12h |
| Genre classify | hourly |
| Dedupe | after each ingest |

**Monitoring — the failure mode is silent.** A scraper returns `200 OK` with zero events because the page changed. Alert on: zero results twice consecutively; count dropping >60% vs 7-day median; >20% of events failing venue resolution. Email yourself. A public `/status` page also signals seriousness to promoters.

**Politeness — non-negotiable.** `User-Agent: NYCRaveMap/1.0 (+https://site; you@email)`. ≥1s between requests per domain. Exponential backoff on 429/503. Cache aggressively.

**Cost guardrails — three rules that pin this near zero indefinitely:**

1. **Prune `raw` at 90 days.** `update event_sources set raw = '{}'::jsonb where fetched_at < now() - interval '90 days'` on a weekly cron. Raw payloads are ~20MB/month and would otherwise cross Supabase's 500MB free cap in about a year, forcing a $25/month upgrade. Keep the row for provenance; drop the blob.
2. **Weekly `pg_dump` to your own repo or object storage.** The free tier has **no backups**. Ten minutes to set up, and the 500MB cap is not your real risk — losing everything is.
3. **Classification uses the synchronous messages API with prompt caching, on Haiku.** Cache reads are 0.1x base input and the taxonomy block is identical on every call, which is where the saving actually is. *The Batch API was considered and rejected: it would save roughly $0.75/month in exchange for async submission, polling, retrieval, and partial-failure handling — plus a job that can stall silently. Bad trade at this volume. Revisit only if a second city is ever added, which it won't be.*

*The free-tier inactivity pause (7 days) can never trigger here — the 6-hour cron keeps the database continuously active.*

**Cost:** Supabase $0 · Vercel $0 · Actions $0 (public repo) · LLM ~$1.50/mo (Haiku + prompt caching, ~1,500 events/mo) · domain ~$2.25/mo (.nyc, billed annually) → **$0–4/month**.

Infrastructure was never the cost risk. Your scarce resource is attention — don't spend an evening evaluating databases. PocketBase and D1 are SQLite: you'd lose PostGIS and pg_trgm, which are doing the radius filter, venue matching, and dedupe scoring, and PocketBase needs a server you pay for. Switching costs money and features.

**Caching, where cost and UX align:** revalidate the list page every 5 minutes, server-render it so the listing reads with no JS, and never rehost flyers (§15.3). All three cut egress *and* make the site load instantly on bad venue wifi at 1am.

---

## 15. Legal and ethical operating rules

1. **Logged-out only, always.** Never create an account on a source then scrape it. The distinction that keeps winning in US courts is public-logged-out (defensible) vs behind-a-login-against-accepted-terms (not). hiQ won on CFAA and still lost on contract, because it had accepted LinkedIn's user agreement.
2. **Never defeat anti-bot measures.** No CAPTCHA solving, no rate-limit circumvention, no rotating residential proxies. Bypassing technical access controls is the live legal frontier.
3. **Store facts, not prose.** Dates, venues, lineups, prices, links are facts. Descriptions and flyers are someone's copyrighted work. Write your own 200-char blurb or none. Hotlink flyers; don't rehost.
4. **Link out, always.** You are additive to RA, Dice, and Posh. Say this when promoters ask.
5. **Honor opt-out within 24h, no questions.** One angry promoter handled gracefully becomes an advocate.
6. **Address suppression default-on** for flagged events. Never publish a location earlier than the promoter does.
7. **Never sell or publish promoter contact data.**
8. **No user tracking beyond aggregate counts.** No ad pixels, no session recording.

*Not legal advice.*

### 15.1 Three policies to decide now, not under pressure

- **Your own gigs.** You're a DJ running a platform claiming neutrality. State publicly: your own events get no special placement, ever. Someone will notice you're on a lineup you're listing, and the only good answer is one written beforehand.
- **Artists with credible allegations.** Within six months someone will ask why a person is listed. The defensible neutral-calendar position is: list what is publicly scheduled, don't adjudicate, and honor any promoter's request to remove their own event. Curating instead is also legitimate. Pick one now and apply it consistently. The failure is improvising.
- **License.** Feed: CC0 or ODbL. Code: MIT. Two files, tonight. Makes the public-good claim concrete rather than rhetorical.

---

## 16. Getting people to use it

Machine sources reach ~85–90%. The rest is a **trust problem, not a data problem**, and being a working DJ is the unfair advantage. No engineer gets added to a promoter's group chat. You do.

### 16.1 Don't launch. Tell 50 people.

Not a marketing strategy — just the cheapest way to launch anything without a budget. Write the list before you write any outreach.

| Channel | Why |
|---|---|
| DM people you already know who go out | Highest conversion; peer-to-peer |
| DJ and friend group chats | Where plans actually get made |
| Record shops, community radio people | Scene-central, natural nodes |
| Your own sets | A captive audience of exactly the right people |

**Cut: QR codes on flyers.** Flyers reach people already at a party. This is for someone deciding at 10pm on Wednesday.

**The Instagram accounts are partners, not competitors or sources.** ~164K combined followers and no filtering; you have filtering and no audience. Offer an embed. Never scrape them (§8.3).

### 16.2 Promoter outreach

Four sentences, fan-facing, no B2B pitch:

> I built a free calendar that pulls NYC electronic events from RA, Dice, Posh, and venue sites into one place, so people can find parties by genre, price, and neighborhood — including the small ones. It's not ticketing, I don't take a cut, every listing links straight to your page. Can I list your nights? And tell me if something's missing.

**Seed venue buckets** (verify each is still open — NYC turnover is high and a stale list reads as outsider): core Brooklyn clubs · warehouse/large · DIY small rooms · Manhattan · Jersey within radius · non-club (art spaces, boat parties, daytime series).

**Positioning:** say the non-commercial part out loud on the site from day one — no ads, no ticket cut, no data sales, open feed.

---

## 17. Validation

### 17.1 Week One Gate — before building anything else

Test A1 before investing another weekend. After RA + Dice + Posh run, before filters or classification:

```sql
select count(*) from events e
where e.party_night between current_date and current_date + 30
  and not exists (
    select 1 from event_sources s where s.event_id = e.id and s.source = 'ra'
  );
```

| Per week | Verdict |
|---|---|
| **30+** | Thesis confirmed. Build the plan. |
| **10–30** | Real but thin. Ship, and lead with **filtering**, not coverage. |
| **<10** | RA has NYC covered. **Stop and rethink.** |

Under 10, the honest pivot isn't quitting — it's becoming the **filtering and openness layer over RA**: better price and time-of-night filters, open feed, no ads. Still useful, still doesn't exist, but a different thing. Know that in week one, not month six.

### 17.3 The Week Four Gate — testing A2

Vanity metrics don't apply to a tool 50 people know about. The test is narrow:

**Of the ~50 people you told, how many opened it in week 4?**

| Result | Verdict |
|---|---|
| **20+** | A2 holds. Keep going. |
| **8–20** | Marginal. Ask the ones who stopped — usually one missing feature or one wrong data point. |
| **<8** | A2 fails. Even people who go out constantly don't want this. Stop. |

### 17.4 Ongoing

| Metric | Month 3 target |
|---|---|
| Events listed / week | 150+ |
| **Events RA doesn't have** | 30+/week ← *the thesis* |
| **Seeded users active weekly** | 20+ ← *A2* |
| Genre confidence ≥0.8 | 85% |
| **False merges** (events hidden) | ~0 — hand-sample 50/month. This is the one that breaks the mission. |
| Duplicate listings visible | <5/week — cosmetic; fix with hard rules, not a lower threshold |
| Opted-in promoters | 40 |
| Submissions / week | 15 |
| Sources broken >48h unnoticed | 0 |

---

## 18. Risks and open questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| **RA is simply good enough for NYC** | **Medium** | §17.1 gate before further investment |
| Source changes structure, breaks silently | **High** | Zero-result + volume-drop alerting; JSON-LD fallback |
| Nobody uses a filter tool over Instagram (A2) | **Medium** | Cheap to find out. Tested at §17.3 against 50 known users, not general traffic. |
| Scene reads you as an extractor | Medium | Instant opt-out, address suppression, non-commercial stated, promoters recruited *before* launch |
| Dedupe visibly wrong | Medium | Review queue, reversible merges, labelled fixtures |
| Cease-and-desist | Low | Logged-out only, no circumvention, facts not prose, traffic driven *to* them, comply immediately |
| Solo burnout | **High** | Automate the mechanical; keep v1 small; never promise same-day coverage |
| Venue list stale | Medium | Quarterly audit, `is_dark`, 60-day no-event alert |

### 18.1 The event-discovery graveyard

Know what you're walking into. A founder who tried documented that **Y Combinator said they'd had an event discovery business in almost every cohort and none had succeeded**, and that most investors he approached had already lost money in the category.

| Why they died | Applies here? |
|---|---|
| No barriers to entry; competing for funding and partnerships | **No** — not raising |
| Revenue never materialized | **No** — covering ~$3/month |
| Couldn't get users to add events (supply cold start) | **No** — you scrape; supply exists day one |
| Event value drops sharply with distance; must be hyperlocal | **Mitigated** — single metro |
| Died on expansion | **Only if you expand** |

Nearly every fatal mode is *commercial*. Remove revenue, funding, and growth and most of the graveyard doesn't apply. That is the strongest structural argument for the public-good framing.

### 18.2 Open questions — attack these

1. **A1 is unmeasured.** Everything else is downstream. Is the gate design right? Is 30/week the correct threshold?
2. **A2 is now a power-user bet.** The mass-market version was abandoned as unwinnable against Instagram curators. Open: is ~50 seeded users the right sample, and is 20 active at week 4 the right bar? Is the segment large enough in NYC to sustain the maintenance burden?
3. **Promoter placement pressure.** Once this is useful, promoters will ask to be featured or to have rivals downranked. §15.1 covers your own gigs; the promoter version isn't written yet. Draft it before it's tested.
3. **Is genre inference actually better than RA's promoter tags,** or just different? T4 is untested.
4. **Is the 6-hour party-night boundary right** for NYC, or should it be 5 or 7?
5. **Does the co-billing similarity graph have enough density** in a single metro to be useful?
6. **Is a solo maintainer viable long-term,** and what's the succession plan beyond "public repo + open feed"?
7. **Is 0.80 the right merge threshold**, given that showing duplicates is now the deliberate fallback?

---

## 19. Tonight's checklist

- [ ] Spike: RA fetch works from a GitHub Actions runner
- [ ] `npx create-next-app@latest nycrave --typescript --app`
- [ ] Push to GitHub (public); add `LICENSE` (MIT), `LICENSE-DATA` (CC0)
- [ ] Connect Vercel, confirm deploy
- [ ] Supabase project; enable `postgis`, `pg_trgm`; run §7 migration
- [ ] `adapters/ra.ts` — GraphQL, NYC area, 30-day window
- [ ] `lib/upsert.ts` — naive, no dedupe
- [ ] `app/api/events/route.ts` — the shared read query (§5.5)
- [ ] `app/page.tsx` — list upcoming events
- [ ] Deploy, open on your phone
- [ ] Write down the first 10 promoters to DM tomorrow

**Then, before anything else: run the §17.1 gate.** Three adapters, one query, one number. It tells you whether you're building this plan or a smaller, still-useful different one.
