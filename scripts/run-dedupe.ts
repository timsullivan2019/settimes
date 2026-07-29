import { sql } from "drizzle-orm";
import { client, db } from "../db/client";
import { dedupe, unmerge, type EvaluatedPair } from "../lib/dedupe";

// Usage: npx tsx --env-file=.env.local scripts/run-dedupe.ts
// Runs dedupe live and prints the Step 10 verification sections 1–6.

async function canonicalCount(): Promise<number> {
  const [r] = await db.execute(
    sql`select count(*)::int as n from events where is_canonical`,
  );
  return r.n as number;
}

function fmtComponents(p: EvaluatedPair): string {
  const c = p.components;
  if (!c) return "";
  const f = (v: number | null) => (v === null ? "UNKNOWN" : v.toFixed(2));
  return `title=${f(c.title)} lineup=${f(c.lineup)} start=${f(c.start)} price=${f(c.price)}`;
}

async function main(): Promise<void> {
  const before = await canonicalCount();
  const report = await dedupe();

  console.log("\n=== 1. pair outcomes ===");
  console.log(`groups with ≥2 events: ${report.groups}`);
  console.log(`pairs evaluated:       ${report.pairsEvaluated}`);
  console.log(`merged (hard rule):    ${report.hardMerged}`);
  console.log(`merged (scored):       ${report.scoredMerged}`);
  console.log(`blocked by hard rule:  ${report.blocked}`);
  console.log(`left separate:         ${report.separate}`);
  console.log(`skipped (no venue_id): ${report.skippedNoVenue}`);

  console.log(`\n=== 2. merges applied this run (${report.merges.length}) ===`);
  for (const m of report.merges) {
    console.log(
      `  ${m.score === null ? "HARD " : m.score.toFixed(3)}  ${JSON.stringify(m.winnerTitle)}  ⇐  ${JSON.stringify(m.loserTitle)}`,
    );
  }

  console.log("\n=== 3. near-misses, score 0.5–0.8 (left separate) ===");
  const nearMisses = report.pairs
    .filter((p) => p.outcome === "separate" && p.score !== null && p.score >= 0.5 && p.score < 0.8)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const p of nearMisses.slice(0, 10)) {
    console.log(`  ${p.score?.toFixed(3)} (bar ${p.threshold})  ${p.partyNight}`);
    console.log(`     a: ${JSON.stringify(p.aTitle)}`);
    console.log(`     b: ${JSON.stringify(p.bTitle)}`);
    console.log(`     ${fmtComponents(p)}`);
  }
  console.log(`  (${nearMisses.length} total in band)`);

  const raisedBar = report.pairs
    .filter(
      (p) => p.outcome === "separate" && p.score !== null && p.score >= 0.8 && p.threshold === 0.9,
    )
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  console.log(
    `\n  scored ≥0.80 but held below the raised no-lineup bar (0.90) — ${raisedBar.length} pairs:`,
  );
  for (const p of raisedBar.slice(0, 10)) {
    console.log(`  ${p.score?.toFixed(3)}  ${p.partyNight}`);
    console.log(`     a: ${JSON.stringify(p.aTitle)}`);
    console.log(`     b: ${JSON.stringify(p.bTitle)}`);
    console.log(`     ${fmtComponents(p)}`);
  }

  console.log("\n=== 4. canonical field resolution for one merged pair ===");
  const detailed = report.merges.find((m) => m.score !== null) ?? report.merges[0];
  if (detailed) {
    console.log(`  winner: ${JSON.stringify(detailed.winnerTitle)} (${detailed.winnerId})`);
    console.log(`  loser:  ${JSON.stringify(detailed.loserTitle)} (${detailed.loserId})`);
    for (const r of detailed.resolutions) {
      console.log(
        `    ${r.field.padEnd(16)} ← ${r.fromSource.padEnd(5)} ${JSON.stringify(r.value)}`,
      );
    }
  } else {
    console.log("  (no merges happened)");
  }

  console.log("\n=== 5. reversibility ===");
  const probe = report.merges.find((m) => m.score !== null) ?? report.merges[0];
  if (probe) {
    const show = async (label: string) => {
      const rows = await db.execute(sql`
        select id, is_canonical, merged_into, title
        from events where id in (${probe.winnerId}, ${probe.loserId})
        order by id`);
      console.log(`  ${label}`);
      for (const r of rows) {
        console.log(
          `    ${r.id}  is_canonical=${r.is_canonical}  merged_into=${r.merged_into ?? "null"}  ${JSON.stringify(r.title)}`,
        );
      }
    };
    await show("after merge:");
    await unmerge(probe.loserId);
    await show("after unmerge (both rows restored):");
    const rerun = await dedupe();
    const remerged = rerun.merges.find(
      (m) => m.loserId === probe.loserId && m.winnerId === probe.winnerId,
    );
    console.log(
      `  re-run dedupe: pair ${remerged ? "re-merged identically" : "NOT re-merged — INVESTIGATE"}`,
    );
    await show("after re-run:");
  } else {
    console.log("  (no merges to probe)");
  }

  console.log("\n=== 6. is_canonical counts ===");
  const after = await canonicalCount();
  console.log(`  before: ${before}`);
  console.log(`  after:  ${after}  (Δ ${before - after}, merges applied: ${report.merges.length})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
