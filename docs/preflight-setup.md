# settimes.nyc — Pre-Flight Setup

Everything to do **before** prompting Claude Code to start on `build-sequence.md`. About 30–40 minutes.

Nothing here is written by the agent. You do all of it, so that when the agent starts there's a known-good baseline and any later breakage is unambiguously its fault.

---

## 1. Accounts and versions

Three free accounts. Sign into all of them **with GitHub** so there's one identity:

- GitHub
- Vercel
- Supabase

No Anthropic API key needed yet — genre classification is Step 14.

```bash
node -v   # must be 20 or higher
```

Below 20, install a current LTS before continuing.

---

## 2. Register the domain

**Read this before you buy:** `.nyc` is a restricted TLD. <cite>Registrants must be either a natural person whose primary place of domicile is a valid physical address in the City of New York, or an entity with a physical street address in the City of New York.</cite> <cite>A P.O. Box does not qualify, and proxy registration services are not allowed.</cite>

You live in NYC, so you qualify as an individual — but two consequences:

- **Your real name and NYC address go on the registration.** Privacy/WHOIS proxy isn't permitted. If you'd rather not have your home address attached to a public project, register under an LLC address or reconsider the TLD.
- <cite>The registry runs spot checks, and a domain found non-compliant gets locked and can ultimately be deleted.</cite> So this only works while you actually live in the city.

Register `settimes.nyc` (~$27/year at most registrars). Cloudflare Registrar, Namecheap, and Dynadot all handle `.nyc`.

Don't point DNS anywhere yet — that's Step 8.

---

## 3. Create the project

```bash
npx create-next-app@latest settimes --typescript --app --tailwind --eslint
cd settimes
npm i zod luxon drizzle-orm postgres
npm i -D drizzle-kit @types/luxon vitest tsx
```

---

## 4. Push to GitHub, public

Public means unlimited Actions minutes and it matches the open-source commitment in the plan.

```bash
gh repo create settimes --public --source=. --push
```

Without the `gh` CLI, create the repo in the browser then:

```bash
git remote add origin https://github.com/YOURNAME/settimes.git
git branch -M main && git push -u origin main
```

---

## 5. Capture the RA endpoint yourself

Do **not** take an endpoint URL from a model, including me. It may be stale, and a wrong endpoint costs an hour of debugging something that was never going to work. Two minutes in the browser gets ground truth.

1. Open `ra.co/events/us/newyorkcity` in Chrome
2. DevTools → **Network** → filter **Fetch/XHR**
3. Reload, then scroll the listings so more events load
4. Find the request whose response preview contains event data
5. Right-click → **Copy → Copy as cURL**

Save that somewhere. It holds the exact URL, headers, and query body, and you'll hand it to Claude Code at Step 4 of the sequence.

---

## 6. Run the spike — this is the real gate

Convert the cURL into `scripts/spike.mjs`: one request, print status code and the first 500 characters.

`.github/workflows/spike.yml`:

```yaml
name: spike
on: workflow_dispatch
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node scripts/spike.mjs
```

Push, then GitHub → **Actions** → spike → **Run workflow**.

| Result | Meaning |
|---|---|
| 200 + real event JSON | Continue. |
| 403 / 429 / challenge page | Datacenter IP is blocked. Your scheduler becomes Vercel Cron or a small VPS. **Change §6.1 of the plan now**, before six adapters assume otherwise. |

The whole architecture rests on this. Don't skip it because it works from your laptop — your laptop isn't what runs the cron.

---

## 7. Supabase

1. New project, region near you, save the database password somewhere permanent
2. SQL Editor:
   ```sql
   create extension if not exists postgis;
   create extension if not exists pg_trgm;
   ```
3. Settings → Database → copy the **pooled / transaction** connection string (serverless needs the pooler, not the direct connection)

Locally:

```bash
echo "DATABASE_URL=postgresql://..." >> .env.local
echo ".env.local" >> .gitignore
git status   # confirm .env.local is NOT listed
```

Do not commit until that check passes.

---

## 8. Vercel and the domain

1. Import the GitHub repo, accept the Next.js defaults
2. Add `DATABASE_URL` as an environment variable
3. Deploy — confirm the starter page loads on the `.vercel.app` URL
4. Project → Settings → **Domains** → add `settimes.nyc`
5. At your registrar, add the DNS records Vercel gives you
6. Wait for propagation, then load `https://settimes.nyc`

Getting the starter page live on the real domain now means every later failure is traceable to the agent's work, not to infrastructure.

---

## 9. Drop in the docs

```bash
mkdir docs
# copy nyc-edm-discovery-plan.md → docs/
# copy build-sequence.md → docs/
```

`CLAUDE.md` in the **project root**, not in `docs/`:

```markdown
# settimes.nyc

Free, open web app aggregating NYC-metro electronic music events from
RA, Dice, Posh, and venue sites. Filterable by genre, time of night,
price, and distance. Not a business. Not multi-city. Ever.

## Read these first
@docs/build-sequence.md
@docs/nyc-edm-discovery-plan.md

## Stack
Next.js App Router · TypeScript · Tailwind · Supabase Postgres
(PostGIS, pg_trgm) · Drizzle · Zod · Luxon · GitHub Actions cron

## Commands
npm run dev · npm run test · npx drizzle-kit push

## Always
- Times localize to America/New_York via lib/time.ts. Never use bare Date.
- Every adapter validates its output with Zod. Parse failure throws; never coerce.
- Absence of an event never means cancelled. Only explicit source signals.
- Never delete on dedupe merge — set is_canonical=false and merged_into.
- Follow build-sequence.md step order. A failed verification is a full stop.
- Scrape logged-out only. Never bypass rate limits or anti-bot measures.

## Never
Build anything listed under "Not in scope" at the end of build-sequence.md.
No auth, no accounts, no admin panel, no extra sources, no analytics.
```

```bash
git add . && git commit -m "plan, sequence, project memory" && git push
```

---

## 10. Verify Claude Code sees everything

```bash
claude
```

Run `/memory`. It must list `CLAUDE.md` **and** both imported files.

If the imports don't appear, the paths are wrong. Fix that before prompting anything — otherwise the agent works without the constraints and you'll be undoing decisions instead of preventing them.

---

## 11. First prompt

Keep it narrow. The commonest failure is an agent reading a full plan and building six steps at once.

> Read docs/build-sequence.md. Steps 0 and 1 are complete — the project is scaffolded, deployed to Vercel at settimes.nyc, and the RA spike returned 200 from GitHub Actions. Begin at Step 2: database and schema. Implement only Step 2, run its verification, then stop. Do not begin Step 3.

Paste your saved cURL when it reaches Step 4.

---

## Working habits for the build

- **Ask to see verification output.** Don't accept "done" — ask for the test result or query output. This is the single highest-value habit; it's the difference between a working pipeline and one quietly writing garbage at 3am.
- **One step, one commit**, with the step number in the message.
- **Stop at every 🛑.** Steps 0, 7, 11, and the Gate need a human.
- **If it starts building something you don't recognize**, stop it and check the "Not in scope" list. It's usually reading the backlog as a to-do.

---

## Pre-flight checklist

- [ ] Node 20+
- [ ] GitHub, Vercel, Supabase accounts
- [ ] settimes.nyc registered (NYC address, no proxy)
- [ ] Next.js project created, deps installed
- [ ] Public GitHub repo, pushed
- [ ] RA cURL captured and saved
- [ ] **Spike passed from GitHub Actions** ← the real gate
- [ ] Supabase project, postgis + pg_trgm enabled
- [ ] DATABASE_URL in .env.local, and .env.local gitignored
- [ ] Vercel deployed, env var set, settimes.nyc resolving
- [ ] docs/ populated, CLAUDE.md in root, pushed
- [ ] `/memory` lists all three files

All checked → prompt Step 2.
