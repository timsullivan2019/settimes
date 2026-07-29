# settimes.nyc

Free, open web app aggregating NYC-metro electronic music events from RA, Dice,
Posh, and venue sites into one filterable place — genre, time of night, price,
distance. Not a business. Not multi-city. Ever.

## Read these first
@docs/build-sequence.md
@docs/nyc-edm-discovery-plan.md

`build-sequence.md` is the order of work. `nyc-edm-discovery-plan.md` is the
reasoning behind every decision. Section refs like §10.3 point at the plan.

## Stack
Next.js App Router · TypeScript · Tailwind · Supabase Postgres (PostGIS,
pg_trgm) · Drizzle · Zod · Luxon · p-limit · GitHub Actions cron · Vercel

## Commands
```
npm run dev
npm run test
npx drizzle-kit push
node --env-file=.env.local scripts/<name>.mjs
```

Load env with Node's native `--env-file=.env.local`. Do NOT install `dotenv`,
and do NOT use `export $(cat .env.local | xargs)` — it breaks on passwords
containing `$`, `!`, or `&`, and fails silently.

Existing scripts: `scripts/spike.mjs` (RA reachability probe),
`scripts/db-test.mjs` (extension check), `scripts/ra-query.json` (RA query body,
hardcoded spike date — the adapter must compute the date at runtime).

## Working rules
- Follow build-sequence.md step order. One step, one commit, message prefixed
  with the step number.
- A failed verification is a full stop. Do not proceed to the next step
  intending to come back.
- Steps marked 🛑 require a human. Stop and report.
- Never invent data. If a field can't be parsed, write null and log it.
- Ask before adding anything not specified.

## Time — the most common source of silent bugs
- All times localize to America/New_York via `lib/time.ts`. Never use bare
  `Date` for parsing source timestamps.
- Sources are inconsistent: some send ISO with offset, some send naive strings.
  Treating a naive string as UTC shifts it 4–5 hours onto the wrong night.
- `party_night` = `starts_at` minus 6 hours, date part. A Saturday 23:45 party
  and a Sunday 00:30 party are the same night. Every filter and dedupe
  candidate keys on `party_night`, never the calendar date.

## Reading dates back out of Postgres
- `party_night` is a DATE column. postgres.js hydrates it into a JS `Date` at UTC
  midnight, which renders as the PREVIOUS evening in America/New_York.
- Always select it as `party_night::text` and treat it as a string. Never let a
  `Date` object represent a party night anywhere in the app.
- On raw `db.execute`, the postgres-js driver returns `timestamptz` as a STRING
  (`"2026-07-28 23:00:00+00"`), not a Date. Never assume a driver's return type —
  log the typeof once before writing conversion logic.

## Data integrity
- Every adapter validates its output with Zod. Parse failure throws with the
  diff. Never coerce, never fill defaults.
- Write raw payloads to `event_sources` before normalizing. Never overwrite an
  event with new data — record what each source said, recompute the canonical row.
- Absence never means cancelled. Only set `status='cancelled'` on an explicit
  source signal. On silence, let `last_seen_at` go stale.
- Never delete on dedupe merge — set `is_canonical=false` and `merged_into`.
- Every adapter must be safe to run twice. Second run creates zero new rows.

## Postgres and PostGIS
- Supabase transaction pooler (port 6543) does NOT support prepared statements.
  Always instantiate the postgres client with `{ prepare: false }`.
- Drizzle has no first-class geography type. Do NOT invent one. Define `geog`
  with `customType`, and write ALL spatial queries with the raw ``sql`` `` helper.
- Same for `pg_trgm`: `similarity()` goes through ``sql`` ``, never a Drizzle operator.
- If Drizzle fights a query, drop to raw SQL rather than restructuring the schema.

## Fetching
- All outbound HTTP goes through `lib/fetcher.ts`. Nothing calls `fetch` or
  `undici` directly.
- `fetcher.ts` enforces p-limit concurrency 1 per hostname, ≥1s between requests
  to the same host, exponential backoff on 429/503, and the project User-Agent
  with a contact email.
- **Never `Promise.all` over a list of URLs.** Many targets are small venue
  servers run by people in this scene.

## LLM
- Synchronous messages API with prompt caching on the taxonomy block. Haiku.
- No Batch API in v1 — async polling isn't worth ~$0.75/month.
- Cache classifications on `sha256(title + sorted(artist_ids) + venue_id)`.
  Check cache before any API call.
- On low confidence, keep the specific genre guess with a low score. Never fall
  back to "open format" out of uncertainty — that's reserved for genuinely
  eclectic lineups.

## Scraping conduct — non-negotiable
- Logged-out only. Never create an account on a source and then scrape it.
- Never bypass rate limits, CAPTCHAs, or anti-bot measures.
- Store facts (dates, venues, lineups, prices, links). Not descriptions.
  Hotlink flyers, never rehost.
- Respect `suppressed` and `address_secret` at the query layer, not the UI layer.
- Never fetch tracking URLs found in source data — impression pixels, click
  trackers, analytics beacons. Ingest the event, ignore the instrumentation.
  Requesting them injects false data into someone's ad reporting.

## Never build
Anything under "Not in scope" at the end of build-sequence.md: auth, accounts,
admin panel, dedupe review UI, promoter dashboard, date-conflict checker,
Telegram/Discord/email ingestion, flyer parsing, extra source adapters, alerts,
digests, artist follows, analytics, multi-city, iOS.

The plan document contains a backlog. **The backlog is not a to-do list.**
