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

---

## Addendum — Step 8 revised criteria (2026-07-28)

The original "≥85% of events resolve to a venue with non-null geog" was set before
we knew NYC's venue coverage in OSM. Replaced with two separate metrics:

- **Events linked to a venue record: 100%.** No event may lack a venue_id.
- **Events with a usable point: ≥85% of events EXCLUDING address_secret ones.**
  TBA/secret-location listings must NOT be geocoded (§9.1 rule 6). Counting them
  as failures measures the wrong thing.

**Finding:** roughly 30% of NYC venues in a 30-day RA window are absent from
OpenStreetMap — SILO, Outer Heaven, Superior Ingredients, Silence Please, H0l0 Yard,
Apollo Studio, rooftops and studios. These are precisely the underground spaces the
project exists to surface. Expect a permanent hand-seeded tail; §16.2 anticipates it.

**Never accept a non-POI geocode.** Verified failure modes: "SILO" → a residential
street in Greenwich CT, "SOBs" → a footpath in NJ. Wrong coordinates are worse than
null, because the radius filter fails silently.

**Venue matching is not truly tested until Step 9,** when Dice names must resolve to
venues RA already created. Seed `aliases` with real short forms.

---

## Addendum — Dice adapter, verified 2026-07-28

**Two surfaces, different formats.** Browse SSR embeds local-offset ISO
(`2026-08-02T14:00:00-04:00`); events-api returns UTC (`2026-07-29T03:00:00Z`).
Both carry an explicit offset; a naive string is a format change and must fail loudly.

**SSR pages are not sufficient** — they embed only ~25 events and ignore their own
cursor. Coverage requires `events-api.dice.fm/v1/events`, the same request the site
makes for any anonymous visitor. The API key is public (`window.EVENTS_API_KEY`,
served to every logged-out visitor) and is scraped at runtime, never hardcoded, so
it follows rotation. Still logged-out, no anti-bot circumvention. **If Dice ever
gates or rotates this deliberately, fall back to SSR pages — do not work around it.**

**Price:** tiers carry `total` (face_value + fees) in integer cents and a `sold_out`
flag. `price_min_cents` = min total over tiers where `sold_out` is false. A fully
sold-out event gets null, never a historical low tier.

**`music:party` includes non-electronic events** (hip-hop, country). Kept
deliberately — Step 14 classification sorts them. **Consequence: the §17.1 Gate must
be computed AFTER genre classification, filtered to electronic genres.** Counting
raw Dice events overstates the thesis.

**Rooms vs venues.** `Elsewhere - Rooftop`, `Pianos: Showroom`, `Harriet's Lounge -
1 Hotel` are rooms and stay as separate venue records. Multi-room modeling is
backlog; separate records correctly prevent same-night different-room events from
becoming dedupe candidates.

---

## Addendum — schema drift from §7 (2026-07-28)

The live schema now differs from §7 of the plan. Migrations are authoritative:

- `venues.geocode_blocked boolean not null default false` (0001) — backfill skips
  these permanently. Nulling a bad geocode alone is not enough: backfill retries
  every null-geog venue and Nominatim returns the same wrong POI.
- `venues.notes text` (0001) — records why a venue is blocked or hand-seeded.
  §7 gives `notes` only to promoters.

**Rooms vs venues — refined.** Separate venue records only where a venue programs
multiple rooms SIMULTANEOUSLY (Elsewhere, Pianos, 1 Hotel). A bar with a rooftop
does not, so those merge. Test: can two different events run at the same time under
one roof? Yes → separate records. No → alias.

**Venue state after Step 9:** 100% of events venue-linked, 88.9% (927/1043) with a
usable point. The denominator grew with Dice's venues; the seed file remains the
long-tail mechanism.

**Overlap tracking:** RA↔Dice events sharing (party_night, venue_id): 124 → 132 →
133 across the venue merges. ~32% of 414 Dice events. Pre-dedupe estimate only —
includes both true duplicates and RELATED same-venue-same-night distinct events.

**Canonical resolution lives in lib/canonical.ts** — one n-way §10.4 resolver, used
by both dedupe (on merge) and ingest (on recompute). Never duplicate this logic.
After any source refreshes the row it owns, ingest walks to the canonical root and
re-resolves from every member of the merge group.

**Known bounded staleness:** if a source RETRACTS a value (deletes a price rather
than changing it), the canonical can hold the old value until the root's own source
next ingests — at most one 6h cycle. Recoverable-stale per §9.1 rule 2, not
corruption. Full fix would re-normalize every member from event_sources.raw at
recompute time; judged out of proportion. Revisit if Step 11 surfaces a stale pair.

**Invariant to check after any ingest/dedupe change:** canonical = total − merged.
Raw is_canonical counts drift legitimately as the rolling window moves.

---

## Addendum — Step 11 calibration (2026-07-28)

**§10.3's stated assumption was wrong.** The plan said lineup does the heavy lifting
and titles are noisy. The labelled data shows the reverse: title 0.45, lineup 0.25.
Sources list disjoint slices of the same bill far more often than they disagree on
what the party is called.

**Applied config:** overlap coefficient (|∩|/min) not Jaccard · weights
0.45/0.25/0.15/0.15 · bars 0.70 base, 0.80 no-lineup · strip list extended with
`with`, `and`, `ft.`. Result on the labelled set: 0 false merges, 8 false splits,
down from 0/27.

**Why not the grid argmax:** it lived at a corner where a lineup-less pair
renormalized to 0.556 weight on start proximity — two different parties both opening
at 10pm would merge on title similarity as low as 0.38, and a shared-opener DISTINCT
pair scored 0.844. Overfitting to 60 pairs in the direction the mission can't absorb.
Unit test pins the shared-opener arithmetic at 0.63 < 0.70.

**Three merges clear the bar by 0.006** (identical title, disjoint lineup). First to
unmerge if title weighting ever softens. The fixture catches it.

**RELATED is protected by the hard block rule, not the threshold.** Same-platform
multi-room pairs never reach scoring. Cross-platform RELATED (RA lists one Skyport
sailing, Dice another) does get scored — those appear in the labelled set, mostly
labelled DISTINCT, with a 0.266 margin below the bar.

**RE-RUN THE FIXTURE AFTER POSH LANDS.** A config tuned on two sources is not
guaranteed to hold for three.

**Gate tracking:** 93 of 414 Dice events merge into RA → 321 Dice-only events in a
30-day window (~75/week vs a 30 threshold). Two caveats before this counts: it
includes non-electronic events riding in on Dice's `music:party` tag, so the Gate
must be computed AFTER genre classification; and Posh is not yet in.
