import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { client, db } from "../db/client";
import { dedupe, lineupFromRaw, type EvaluatedPair } from "../lib/dedupe";
import { parseLineup } from "../lib/artists";
import { shortHash } from "../lib/slug";
import { toDateTime } from "../lib/canonical";
import { NY_TZ } from "../lib/time";

// Step 11: export ~60 candidate pairs for hand-labelling, stratified by score
// band. The label column is BLANK and the scores live in a SEPARATE file so
// the labeller is never anchored by the number being calibrated.
//
// The pairs must be scored and displayed from each event's OWN source view —
// but 64 winner rows currently hold §10.4-resolved (merged) values. So, all
// through production code paths:
//   1. unmerge everything
//   2. re-run the RA and Dice ingests — each row refreshes to its own source's
//      pristine view (a single-member group recompute is a no-op)
//   3. snapshot every event's pristine fields
//   4. run dedupe() — it re-merges (restoring the merged state) and returns
//      every evaluated pair with scores computed from the pristine views
//   5. sample, join the snapshot, write the CSVs
// If the script dies mid-run the DB is recoverable: re-running it (or just
// dedupe) re-applies the same merges.
//
// Usage: npx tsx --env-file=.env.local scripts/export-dedupe-pairs.ts

interface Snapshot {
  title: string;
  startNY: string;
  price: string;
  source: string;
  url: string;
  lineup: string[];
  venueId: string | null;
}

function csvCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sample<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, n);
}

async function main(): Promise<void> {
  // 1. Unmerge everything so every row can be refreshed to its own view.
  const unmerged = await db.execute(sql`
    update events set is_canonical = true, merged_into = null
    where merged_into is not null
    returning id`);
  console.log(`unmerged: ${unmerged.length}`);

  // 2. Live ingests through the production path.
  const { ingest } = await import("../lib/ingest");
  for (const source of ["ra", "dice"] as const) {
    const { fetchEvents } = await import(`../adapters/${source}`);
    const result = await ingest(source, await fetchEvents());
    console.log(`${source} ingest: found=${result.found} errors=${result.errors}`);
    if (result.errors > 0) throw new Error(`${source} ingest had errors — aborting export`);
  }

  // Pristine check: an RA-owned row must have a null ticket_url again.
  const [pristine] = await db.execute(sql`
    select count(*)::int as bad
    from events e join event_sources s on s.event_id = e.id and s.source = 'ra'
    where e.ticket_url is not null`);
  if ((pristine.bad as number) > 0) {
    throw new Error(`${pristine.bad} ra-owned rows still carry a ticket_url — not pristine`);
  }
  console.log("pristine check passed: all ra-owned rows have null ticket_url");

  // 3. Snapshot every event's own-source view.
  const rows = await db.execute(sql`
    select e.id, e.title, e.starts_at, e.price_min_cents, e.venue_id,
           s.source, s.source_url, s.raw, v.name as venue_name
    from events e
    join event_sources s on s.event_id = e.id
    left join venues v on v.id = e.venue_id
    where not e.suppressed`);
  const snap = new Map<string, Snapshot>();
  const venueNames = new Map<string, string>();
  for (const r of rows) {
    const lineup = lineupFromRaw(r.source as string, r.raw).flatMap((n) =>
      parseLineup(n).map((a) => a.name),
    );
    snap.set(r.id as string, {
      title: r.title as string,
      startNY: toDateTime(r.starts_at).setZone(NY_TZ).toFormat("yyyy-MM-dd HH:mm"),
      price:
        r.price_min_cents === null ? "" : `$${((r.price_min_cents as number) / 100).toFixed(2)}`,
      source: r.source as string,
      url: (r.source_url as string | null) ?? "",
      lineup,
      venueId: r.venue_id as string | null,
    });
    if (r.venue_id !== null && r.venue_name !== null) {
      venueNames.set(r.venue_id as string, r.venue_name as string);
    }
  }
  console.log(`snapshot: ${snap.size} events`);

  // 4. Re-run dedupe — restores the merged state, returns pristine-view scores.
  const report = await dedupe();
  console.log(
    `dedupe: ${report.pairsEvaluated} pairs, ${report.hardMerged + report.scoredMerged} merged`,
  );

  // 5. Stratified sampling.
  const scored = report.pairs.filter((p) => p.score !== null);
  const boundary = scored.filter(
    (p) => p.outcome === "separate" && (p.score as number) >= 0.5 && (p.score as number) < 0.8,
  );
  const mergedScored = scored.filter((p) => p.outcome === "merged-scored");
  const low = scored.filter((p) => p.outcome === "separate" && (p.score as number) < 0.5);
  const bothNoLineup = scored.filter(
    (p) => snap.get(p.aId)?.lineup.length === 0 && snap.get(p.bId)?.lineup.length === 0,
  );

  const chosen = new Map<string, EvaluatedPair>();
  const take = (pool: EvaluatedPair[], n: number, label: string) => {
    const fresh = pool.filter((p) => !chosen.has(`${p.aId}|${p.bId}`));
    const picked = sample(fresh, n);
    for (const p of picked) chosen.set(`${p.aId}|${p.bId}`, p);
    console.log(`stratum ${label}: pool ${pool.length}, took ${picked.length}`);
  };
  take(boundary, 25, "0.5–0.8 boundary");
  take(mergedScored, 15, "≥0.80 merged");
  take(low, 10, "<0.5");
  take(bothNoLineup, 10, "both-no-lineup");

  // Random order — never sorted by score.
  const final = shuffle([...chosen.values()]);

  const pairRows = [
    "pair_id,label,event_a_title,event_a_start,event_a_lineup,event_a_price,event_a_source,event_b_title,event_b_start,event_b_lineup,event_b_price,event_b_source,venue,party_night,event_a_url,event_b_url",
  ];
  const scoreRows = [
    "pair_id,outcome,score,threshold,title_similarity,lineup_jaccard,start_proximity,price_proximity",
  ];
  for (const p of final) {
    const a = snap.get(p.aId);
    const b = snap.get(p.bId);
    if (!a || !b) continue;
    const pairId = shortHash(`${p.aId}|${p.bId}`, 6);
    const venue = (p.venueId !== null && venueNames.get(p.venueId)) || "";
    pairRows.push(
      [
        pairId,
        "", // label — for the human
        a.title,
        a.startNY,
        a.lineup.join("; "),
        a.price,
        a.source,
        b.title,
        b.startNY,
        b.lineup.join("; "),
        b.price,
        b.source,
        venue,
        p.partyNight,
        a.url,
        b.url,
      ]
        .map(csvCell)
        .join(","),
    );
    const c = p.components;
    scoreRows.push(
      [
        pairId,
        p.outcome,
        p.score?.toFixed(4) ?? "",
        p.threshold?.toFixed(2) ?? "",
        c ? c.title.toFixed(4) : "",
        c ? (c.lineup === null ? "unknown" : c.lineup.toFixed(4)) : "",
        c ? c.start.toFixed(4) : "",
        c ? (c.price === null ? "unknown" : c.price.toFixed(4)) : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  writeFileSync("docs/dedupe-pairs.csv", `${pairRows.join("\n")}\n`);
  writeFileSync("docs/dedupe-pairs-scores.csv", `${scoreRows.join("\n")}\n`);
  console.log(`\nwrote docs/dedupe-pairs.csv (${pairRows.length - 1} pairs, label column blank)`);
  console.log(`wrote docs/dedupe-pairs-scores.csv (join on pair_id AFTER labelling)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
