# BUILD SEQUENCE

Companion to `nyc-edm-discovery-plan.md`. That document is **what and why**. This one is **order and done-when**.

---

## Instructions for the coding agent

Read these before starting. They matter more than any individual step.

1. **One step at a time.** Complete a step, run its verification, commit, then move to the next. Do not batch steps.
2. **A failed verification is a full stop.** Do not proceed to the next step to "come back to it." Fix it or report it.
3. **Do not add anything not in this document.** No auth, no accounts, no admin panel, no extra sources, no analytics, no dark-mode toggle, no loading skeletons beyond what's specified. If something seems missing, ask rather than build it.
4. **Steps marked 🛑 HUMAN require a person.** Stop, report the result, wait.
5. **Commit after every step** with the step number in the message: `step 4: RA adapter`.
6. **Never invent data.** If an adapter can't parse something, write null and log it. Do not fill in plausible values.
7. **Section references** like §9.1 point to the plan document. Read the referenced section before implementing.

---

## Phase 0 — Spike

### 🛑 Step 0. Prove the runner can reach RA

**Before any other work.** GitHub Actions runs on datacenter IPs and some sources block them. Everything downstream assumes this works.

- Create a bare repo, public
- Add `.github/workflows/spike.yml` — a single job that does one POST to RA's GraphQL endpoint for NYC and prints the HTTP status and the first 500 characters of the response
- Run it manually via workflow_dispatch

**Done when:** the Actions log shows a 200 and recognizable event JSON.

**If it fails with 403/429:** stop and report. The scheduler becomes Vercel Cron or a small VPS, and that changes §6.1 before anything else is built.

---

## Phase 1 — Skeleton

### Step 1. Project scaffold

```bash
npx create-next-app@latest nycrave --typescript --app --tailwind --eslint
cd nycrave
npm i zod luxon drizzle-orm postgres
npm i -D drizzle-kit @types/luxon vitest
```

- Push to GitHub, public
- Add `LICENSE` (MIT) and `LICENSE-DATA` (CC0)
- Connect Vercel, confirm a deploy of the default page

**Done when:** the starter page is live on a public URL.

### Step 2. Database and schema

- Create Supabase project
- Enable extensions: `postgis`, `pg_trgm`
- Run the §7 migration verbatim — all nine tables
- Add `DATABASE_URL` to `.env.local` and to Vercel env vars
- Define Drizzle schema in `db/schema.ts` mirroring the SQL exactly

**Verify:**
```sql
select extname from pg_extension where extname in ('postgis','pg_trgm');
select table_name from information_schema.tables where table_schema='public';
```

**Done when:** both extensions present, nine tables present, Drizzle types compile.

### Step 3. Shared primitives

Build these before any adapter — every adapter depends on them.

| File | Purpose | Reference |
|---|---|---|
| `lib/time.ts` | `parseLocal(input, sourceTz)` → always America/New_York. `computePartyNight(startsAt)` → date, minus 6h. | §9.1 rule 1, §10.1 |
| `lib/slug.ts` | `eventSlug(venueSlug, partyNight, title)` → `venue-date-shorthash` | §9.1 rule 3 |
| `lib/artists.ts` | `parseLineup(raw)` → splits `b2b/&/+/x/vs`, strips `(live)`/`(AV)`/`(DJ set)` into a note | §9.1 rule 5 |
| `lib/types.ts` | Zod schema for `NormalEvent` — the shape every adapter must return | §9 |
| `lib/fetcher.ts` | **The only outbound HTTP in the project.** `p-limit` concurrency 1 per hostname, ≥1s between requests to the same host, exponential backoff on 429/503, project User-Agent with contact email. | §14 |

**Verify with Vitest:**
- `parseLocal` correct for a naive string, an offset string, and a UTC string
- `computePartyNight`: Sat 23:45 and Sun 00:30 return the **same** date
- `computePartyNight` correct across the November DST boundary
- `parseLineup("A b2b B (live)")` → two artists, one note
- `fetcher` issues two requests to the same host ≥1s apart, and retries a simulated 429

Also install: `npm i p-limit`

**Done when:** all tests pass. Do not proceed on a failing time test — every downstream bug will trace back here.

---

## Phase 2 — First data on screen

### Step 4. RA adapter

`adapters/ra.ts`, implementing the §3 interface.

- POST to RA's GraphQL endpoint, NYC area, rolling 30-day window
- Parse response through a **Zod schema** — on parse failure, throw with the diff, do not coerce
- Return `NormalEvent[]`
- Save one real response to `fixtures/ra-sample.json` for offline tests

**Verify:** `npx tsx scripts/run-adapter.ts ra` prints ≥20 events with title, start time, venue name, and at least one artist populated.

### Step 5. Naive ingest

`lib/ingest.ts`:

- Write every raw payload to `event_sources`, keyed `(source, source_event_id)`, upsert
- Insert into `events` with no dedupe and no genre — `venue_name_raw` only, no venue resolution yet
- Compute `party_night` and `slug`
- Write a row to `ingest_runs` on every execution

**Verify:** run twice in a row. Second run creates zero new rows. (Idempotency, §9.)

### Step 6. The list page

- `app/api/events/route.ts` — the shared read query (§5.5). Upcoming events by `party_night`, ordered by `starts_at`.
- `app/page.tsx` — server component calling that route's query function. Plain unstyled list: date, time, title, venue, lineup.

**Verify:** deploy, open on a phone, see real NYC events.

### 🛑 Step 7. Checkpoint

Report: how many events, over what date range, and anything visibly wrong. **This is tonight's finish line.** Stop here.

---

## Phase 3 — Make it correct

### Step 8. Venue resolution

`lib/venues.ts`:

- Match order: exact name → alias array → trigram similarity ≥0.6 → create new + geocode via Nominatim (respect 1 req/sec, send a real User-Agent)
- Never overwrite `venue_name_raw`
- Log every new venue created for human review

**Verify:** ≥85% of events resolve to a venue with non-null `geog`. List unresolved ones.

### Step 9. Dice adapter

Same shape as Step 4. Public browse pages, city + genre + `priceTo`. Zod-validated. Fixture saved.

**Verify:** ≥20 events with `price_min_cents` populated on most.

### Step 10. Deduplication

`lib/dedupe.ts` — implement §10 exactly.

Order of operations matters:
1. **Hard rules first** — identical `ticket_url` or same platform + same event ID → merge, no scoring. Same venue + same night + different ticket URLs on the same platform → never merge.
2. Candidates: same `(party_night, venue_id)` only
3. Score per §10.3
4. `≥0.80` merge · below that, leave separate
5. Merge sets `is_canonical=false` + `merged_into`. **Never delete.**
6. Canonical field resolution per §10.4 — lowest available price, union of artists, most restrictive age

**Verify:**
- A known duplicate across RA and Dice merges into one canonical row
- A multi-room venue on one night stays as separate events
- Unmerging by clearing `merged_into` restores the original rows

### 🛑 Step 11. Dedupe calibration

Export ~50 candidate pairs to CSV with the score column **hidden**. Human labels each SAME / DISTINCT / RELATED. Agent then tunes weights against the labels and saves the set to `fixtures/dedupe-pairs.json` as a regression test.

Stop and request the labelled file.

---

## Phase 4 — Coverage and genre

### Step 12. Posh adapter

Same pattern. Zod, fixture, verification of ≥20 events.

### Step 13. JSON-LD crawler

`adapters/jsonld.ts` — one adapter, a URL list in `config/venues.json`.

- Fetch each URL **through `lib/fetcher.ts`** — never `fetch`/`undici` directly, and **never `Promise.all` over the URL list**. These are small venue servers.
- Extract every `<script type="application/ld+json">`, filter `@type` in `Event`/`MusicEvent`
- Degrade gracefully: a site with no JSON-LD logs and continues, never throws
- Seed the config with 10 venue URLs to start

**Verify:** at least 3 of the 10 URLs yield events. Report which produced nothing.

### Step 14. Genre classification

`lib/genres.ts`:

- Fixed taxonomy from §11.1 as a constant
- Cache key `sha256(title + sorted(artist_ids) + venue_id)`; check cache before any API call
- **Synchronous messages API** with **prompt caching** on the taxonomy block, Haiku. **Do not use the Batch API** — async polling and partial-failure handling aren't worth ~$0.75/month at this volume.
- Write resulting labels back to `artists.genres`
- On low confidence, keep the specific guess with a low score — never fall back to `open format` out of uncertainty

**Verify:** ≥80% of events have ≥1 genre. Print the confidence distribution. Spot-check 10 by hand.

---

## Phase 5 — The actual product

### Step 15. Filters

- When: tonight / tomorrow / weekend / date range, plus time-of-night
- Genre: multi-select
- Price: free / <$20 / <$40 / any
- Where: radius via `ST_DWithin`, or neighborhood
- Age

**Time-of-night must use interval overlap, not start time** (§12). Missing `ends_at` → regex the title for a range, else default 5 hours for filtering only, never displayed.

All filter state in URL search params.

**Verify:** "after 2am" returns a party that started at 11pm.

### Step 16. Event card and detail page

Per §12. Card: date/time, venue + neighborhood + distance, lineup with headliner emphasized, genre chips, lowest price, age. Detail page adds map, all ticket links cheapest-first, and **provenance** ("Listed on RA, Dice, and Posh").

Design direction is a separate human decision — build semantic, unstyled-but-structured markup that can be restyled without touching logic.

### Step 17. Share affordance

- `app/e/[slug]/opengraph-image.tsx` via `next/og` — headliner, venue, date, price
- `navigator.share()` button with clipboard fallback

**Verify:** paste a link into a messaging app and confirm the card renders.

---

## Phase 6 — Ship

### Step 18. Submit and report

- `/submit` — writes to `submissions`, status pending
- "Report a problem" on event pages — four options, writes to `reports`, emails you

### Step 19. Open feeds

- `/feed.json` — stable field names, ISO 8601 with explicit timezone, paginated (§5.5)
- `/feed.ics` — same data as calendar

### Step 20. Automation and guardrails

- Actions cron: RA/Dice/Posh 6h, crawler 12h, classify hourly, dedupe after each ingest
- **Weekly `pg_dump`** to repo or object storage (§14)
- **Weekly prune:** `update event_sources set raw='{}'::jsonb where fetched_at < now() - interval '90 days'` (§14)
- Alerts: zero results twice consecutively; >60% drop vs 7-day median; >20% venue resolution failures
- `/status` page from `ingest_runs`
- 5-minute revalidate on the list page

**Verify:** disable an adapter deliberately and confirm the alert fires.

---

## 🛑 THE GATE

Run §17.1 before building anything further:

```sql
select count(*) from events e
where e.party_night between current_date and current_date + 30
  and not exists (
    select 1 from event_sources s where s.event_id = e.id and s.source = 'ra'
  );
```

| Per week | Action |
|---|---|
| 30+ | Thesis holds. Continue. |
| 10–30 | Ship, lead with filtering rather than coverage. |
| <10 | Stop. Rethink per §17.1. |

**Nothing in the backlog gets built before this number exists.**

---

## Dependency order

```
0 spike
└─ 1 scaffold ─ 2 schema ─ 3 primitives
                            ├─ 4 RA ─ 5 ingest ─ 6 page ─ 🛑7
                            ├─ 8 venues ─ 9 Dice ─ 10 dedupe ─ 🛑11
                            ├─ 12 Posh ─ 13 crawler ─ 14 genres
                            └─ 15 filters ─ 16 cards ─ 17 share
                                                       └─ 18 ─ 19 ─ 20 ─ 🛑GATE
```

Step 3 blocks everything. Steps 9, 12, 13 are independent and can be reordered. Steps 15–17 need 14 for genre chips to have content.

---

## Not in scope — do not build

Accounts · auth · admin panel · dedupe review UI · promoter dashboard · date-conflict checker · Telegram/Discord/email ingestion · flyer parsing · Shotgun/Ticketmaster/SeatGeek · alerts or digests · artist follows · analytics beyond `ingest_runs` · multi-city · iOS.

Everything above is either deliberately cut or a later phase (§5.3, §5.4).

---

## Addendum — Step 5 extra verification

After the first ingest run, JS and Postgres must agree on `party_night`.
Both compute it correctly in isolation; nothing yet proves they agree.

```sql
select count(*) from events
where party_night
   <> ((starts_at at time zone 'America/New_York') - interval '6 hours')::date;
```

Must return 0. Non-zero means `lib/time.ts` and the SQL definition have
drifted — fix before proceeding, since every dedupe candidate set depends on it.

---

## Addendum — RA adapter, verified 2026-07-28

**`bumps` cannot be removed.** Deleting the selection makes RA's resolver return
`{"errors":[{"message":"Error fetching event listings & bumps"}]}`. Keep a minimal
`bumps { bumpDecision { id } }`. Never request `clickUrl`/`impressionUrl`, never
parse bump payloads. Only `eventListings.data` is ingested.

**No date/startTime join is needed.** RA returns `date`, `startTime`, `endTime` as
full naive ISO datetimes — `startTime` already carries its own date. Do NOT graft
`date`'s date-part onto `startTime`: an event listed under Saturday with doors at
Sunday 01:00 has `date`=Sat and `startTime`=Sun 01:00, and re-joining shifts it a
full day. A strict Zod regex enforces full-datetime shape on all three fields.

**`ticket_url` is unconditionally null from RA.** RA returns no price, and
`/events/{id}` is a listing page, not checkout. The URL lives in
`event_sources.source_url` for a "View on RA" link. Consequence for §10.4: RA rows
never auto-merge via the identical-ticket_url rule.

**~37% of RA events have zero artists** (231 of 629 in a 30-day window). Empty
lineups are normal — open decks, TBA, promoters who typed names into prose. Venue
and start time were present on 100%.

Consequence for §10.3: lineup Jaccard carries the heaviest weight (0.40) and is
unavailable for roughly a third of RA events. **The Step 11 labelling set must
include no-lineup pairs**, or the weights get tuned only against easy cases.

**Artist names carry RA disambiguators.** e.g. `Djgothqueen (3)` — the suffix marks
a distinct artist sharing a name, NOT a performance note. Step 8 artist resolution
must key on RA's structured artist `id` first, falling back to name only when no id
exists. Stripping the suffix and matching on name alone merges different people.
