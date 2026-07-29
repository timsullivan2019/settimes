import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { client, db } from "../db/client";
import {
  MERGE_THRESHOLD,
  MERGE_THRESHOLD_NO_LINEUP,
  WEIGHTS,
  jaccard,
  normalizeTitle,
  priceProximity,
  startProximity,
} from "../lib/dedupe";
import { NY_TZ } from "../lib/time";

// Step 11 tuning: evaluate the labelled pairs against the current scorer and
// candidate changes. REPORTS ONLY — nothing here writes to lib/dedupe.ts.
//
// Cost model per the mission asymmetry (§10.3): a false merge hides a real
// event (product failure) ≈ 5× a false split (cosmetic duplicate). Labels
// ending in "?" are uncertain and weigh 0.5. Both counts are always reported
// separately — never only a blended score.
//
// Usage: npx tsx --env-file=.env.local scripts/tune-dedupe.ts

const LABELLED = "docs/dedupe-pairs-manually-categorized.csv";
const SCORES = "docs/dedupe-pairs-scores.csv";
const FIXTURE = "fixtures/dedupe-pairs.json";

// --- tiny RFC-4180 CSV parser (quoted fields, embedded commas) -------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

// --- data model -------------------------------------------------------------

interface Side {
  title: string;
  startMs: number;
  startNY: string;
  lineup: string[];
  priceMinCents: number | null;
  source: string;
}

interface Pair {
  pairId: string;
  label: "SAME" | "DISTINCT" | "RELATED";
  uncertain: boolean;
  a: Side;
  b: Side;
  venue: string;
  partyNight: string;
  shipped: {
    outcome: string;
    score: number;
    threshold: number;
    titleSimilarity: number;
    lineupJaccard: number | null;
    startProximity: number;
    priceProximity: number | null;
  };
}

function parsePrice(s: string): number | null {
  if (!s.trim()) return null;
  const m = /^\$(\d+(?:\.\d{2})?)$/.exec(s.trim());
  if (!m) throw new Error(`unparseable price ${JSON.stringify(s)}`);
  return Math.round(Number(m[1]) * 100);
}

function parseStart(s: string): { ms: number; ny: string } {
  const dt = DateTime.fromFormat(s.trim(), "yyyy-MM-dd HH:mm", { zone: NY_TZ });
  if (!dt.isValid) throw new Error(`unparseable start ${JSON.stringify(s)}`);
  return { ms: dt.toMillis(), ny: s.trim() };
}

function parseLineupCell(s: string): string[] {
  return s.trim() === "" ? [] : s.split(";").map((x) => x.trim()).filter(Boolean);
}

function side(cols: string[], offset: number): Side {
  const start = parseStart(cols[offset + 1]);
  return {
    title: cols[offset],
    startMs: start.ms,
    startNY: start.ny,
    lineup: parseLineupCell(cols[offset + 2]),
    priceMinCents: parsePrice(cols[offset + 3]),
    source: cols[offset + 4],
  };
}

// --- scoring under a configuration -----------------------------------------

interface Config {
  wTitle: number;
  wLineup: number;
  wStart: number;
  wPrice: number;
  bar: number;
  barNoLineup: number;
  lineupMetric: "jaccard" | "overlap";
  titleNorm: "base" | "extended";
}

function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const min = Math.min(a.size, b.size);
  return min === 0 ? 0 : intersection / min;
}

// Candidate B: also strip the spelled-out twins of w/ (with), & (and), and
// the "ft." abbreviation. feat/feat./featuring are already stripped by base.
function normalizeTitleExtended(title: string): string {
  return normalizeTitle(
    title
      .toLowerCase()
      .replace(/\bwith\b/g, " ")
      .replace(/\band\b/g, " ")
      .replace(/\bft\.?(?=\s|$)/g, " "),
  );
}

interface Scored {
  score: number;
  merges: boolean;
  lineupUnknown: boolean;
}

function scorePair(p: Pair, cfg: Config, titleSim: number): Scored {
  const aSet = new Set(p.a.lineup.map((x) => x.toLowerCase()));
  const bSet = new Set(p.b.lineup.map((x) => x.toLowerCase()));
  const lineupUnknown = aSet.size === 0 || bSet.size === 0;
  const lineup = lineupUnknown
    ? null
    : cfg.lineupMetric === "jaccard"
      ? jaccard(aSet, bSet)
      : overlapCoefficient(aSet, bSet);
  const start = startProximity(p.a.startMs, p.b.startMs);
  const price = priceProximity(p.a.priceMinCents, p.b.priceMinCents);

  let sum = cfg.wTitle * titleSim + cfg.wStart * start;
  let wsum = cfg.wTitle + cfg.wStart;
  if (lineup !== null) {
    sum += cfg.wLineup * lineup;
    wsum += cfg.wLineup;
  }
  if (price !== null) {
    sum += cfg.wPrice * price;
    wsum += cfg.wPrice;
  }
  const score = sum / wsum;
  const bar = lineupUnknown ? cfg.barNoLineup : cfg.bar;
  return { score, merges: score >= bar, lineupUnknown };
}

interface Evaluation {
  falseMerges: Pair[];
  falseSplits: Pair[];
  relatedMerged: Pair[];
  cost: number;
  fmWeighted: number;
  fsWeighted: number;
}

function evaluate(pairs: Pair[], cfg: Config, sims: Map<string, number>): Evaluation {
  const falseMerges: Pair[] = [];
  const falseSplits: Pair[] = [];
  const relatedMerged: Pair[] = [];
  let fmWeighted = 0;
  let fsWeighted = 0;
  for (const p of pairs) {
    const s = scorePair(p, cfg, sims.get(p.pairId) as number);
    const w = p.uncertain ? 0.5 : 1;
    if (s.merges && p.label !== "SAME") {
      falseMerges.push(p);
      fmWeighted += w;
      if (p.label === "RELATED") relatedMerged.push(p);
    }
    if (!s.merges && p.label === "SAME") {
      falseSplits.push(p);
      fsWeighted += w;
    }
  }
  return {
    falseMerges,
    falseSplits,
    relatedMerged,
    cost: 5 * fmWeighted + fsWeighted,
    fmWeighted,
    fsWeighted,
  };
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  // Load and join.
  const labelled = parseCsv(readFileSync(LABELLED, "utf8"));
  const scoresCsv = parseCsv(readFileSync(SCORES, "utf8"));
  const scoreById = new Map(scoresCsv.slice(1).map((r) => [r[0], r]));

  const pairs: Pair[] = [];
  for (const cols of labelled.slice(1)) {
    const pairId = cols[0];
    const rawLabel = cols[1].trim().toUpperCase();
    const uncertain = rawLabel.endsWith("?");
    const label = rawLabel.replace(/\?$/, "") as Pair["label"];
    if (!["SAME", "DISTINCT", "RELATED"].includes(label)) {
      throw new Error(`pair ${pairId}: unknown label ${JSON.stringify(cols[1])}`);
    }
    const s = scoreById.get(pairId);
    if (!s) throw new Error(`pair ${pairId} missing from ${SCORES}`);
    pairs.push({
      pairId,
      label,
      uncertain,
      a: side(cols, 2),
      b: side(cols, 7),
      venue: cols[12],
      partyNight: cols[13],
      shipped: {
        outcome: s[1],
        score: Number(s[2]),
        threshold: Number(s[3]),
        titleSimilarity: Number(s[4]),
        lineupJaccard: s[5] === "unknown" ? null : Number(s[5]),
        startProximity: Number(s[6]),
        priceProximity: s[7] === "unknown" ? null : Number(s[7]),
      },
    });
  }
  const tally = { SAME: 0, DISTINCT: 0, RELATED: 0 };
  for (const p of pairs) tally[p.label]++;
  console.log(
    `joined ${pairs.length} pairs — SAME=${tally.SAME} DISTINCT=${tally.DISTINCT} RELATED=${tally.RELATED} (uncertain: ${pairs.filter((p) => p.uncertain).length})`,
  );
  if (tally.RELATED === 0) {
    console.log(
      "NOTE: no RELATED labels — sampling drew only scored pairs, and same-platform\n" +
        "multi-room/multi-session pairs are hard-BLOCKED before scoring, so they never\n" +
        "reached the sample. The zero-RELATED-merges constraint is enforced structurally\n" +
        "by the block rule for those; it is vacuous over this label set.",
    );
  }

  // pg_trgm title similarity for both normalizations, through the same
  // similarity() the production scorer uses.
  const simsBase = new Map<string, number>();
  const simsExt = new Map<string, number>();
  for (const p of pairs) {
    const [b] = await db.execute(
      sql`select similarity(${normalizeTitle(p.a.title)}, ${normalizeTitle(p.b.title)})::float8 as s`,
    );
    const [x] = await db.execute(
      sql`select similarity(${normalizeTitleExtended(p.a.title)}, ${normalizeTitleExtended(p.b.title)})::float8 as s`,
    );
    simsBase.set(p.pairId, Number(b.s));
    simsExt.set(p.pairId, Number(x.s));
  }

  // Sanity: reconstructed base scores must match the shipped scores.
  let maxDev = 0;
  const CURRENT: Config = {
    wTitle: WEIGHTS.title,
    wLineup: WEIGHTS.lineup,
    wStart: WEIGHTS.start,
    wPrice: WEIGHTS.price,
    bar: MERGE_THRESHOLD,
    barNoLineup: MERGE_THRESHOLD_NO_LINEUP,
    lineupMetric: "jaccard",
    titleNorm: "base",
  };
  for (const p of pairs) {
    const s = scorePair(p, CURRENT, simsBase.get(p.pairId) as number);
    maxDev = Math.max(maxDev, Math.abs(s.score - p.shipped.score));
  }
  console.log(`reconstruction sanity: max |rescored − shipped| = ${maxDev.toFixed(4)}\n`);

  // ---- current performance -------------------------------------------------
  const fmt = (p: Pair, sims: Map<string, number>, cfg: Config) => {
    const s = scorePair(p, cfg, sims.get(p.pairId) as number);
    const sh = p.shipped;
    return (
      `  ${p.pairId} [${p.label}${p.uncertain ? "?" : ""}] score=${s.score.toFixed(3)} ` +
      `(title=${(sims.get(p.pairId) as number).toFixed(2)} lineup=${sh.lineupJaccard === null ? "UNK" : sh.lineupJaccard.toFixed(2)} ` +
      `start=${sh.startProximity.toFixed(2)} price=${sh.priceProximity === null ? "UNK" : sh.priceProximity.toFixed(2)})\n` +
      `     a(${p.a.source}): ${JSON.stringify(p.a.title)}\n` +
      `     b(${p.b.source}): ${JSON.stringify(p.b.title)}  @ ${p.venue} ${p.partyNight}`
    );
  };

  console.log("=== CURRENT CONFIG (0.35/0.40/0.15/0.10 · bar 0.80 · no-lineup bar 0.90 · jaccard) ===");
  const cur = evaluate(pairs, CURRENT, simsBase);
  const confusion = (cfg: Config, sims: Map<string, number>) => {
    const m: Record<string, { merged: number; separate: number }> = {};
    for (const p of pairs) {
      const key = p.label + (p.uncertain ? "?" : "");
      m[key] = m[key] ?? { merged: 0, separate: 0 };
      const s = scorePair(p, cfg, sims.get(p.pairId) as number);
      if (s.merges) m[key].merged++;
      else m[key].separate++;
    }
    for (const [k, v] of Object.entries(m)) {
      console.log(`  ${k.padEnd(9)} merged=${v.merged}  separate=${v.separate}`);
    }
  };
  confusion(CURRENT, simsBase);
  console.log(`\nFALSE MERGES (DISTINCT/RELATED scoring over the bar): ${cur.falseMerges.length}`);
  for (const p of cur.falseMerges) console.log(fmt(p, simsBase, CURRENT));
  console.log(`\nFALSE SPLITS (SAME under the bar): ${cur.falseSplits.length}`);
  for (const p of cur.falseSplits) console.log(fmt(p, simsBase, CURRENT));

  const noLineup = pairs.filter((p) => p.a.lineup.length === 0 || p.b.lineup.length === 0);
  const nlEval = evaluate(noLineup, CURRENT, simsBase);
  console.log(
    `\nNO-LINEUP SUBSET (${noLineup.length} pairs, bar 0.90): false merges=${nlEval.falseMerges.length}, false splits=${nlEval.falseSplits.length}`,
  );
  for (const p of [...nlEval.falseMerges, ...nlEval.falseSplits]) console.log(fmt(p, simsBase, CURRENT));

  // ---- independent variants ------------------------------------------------
  console.log("\n=== VARIANT A: overlap coefficient (weights/bars unchanged) ===");
  const evalA = evaluate(pairs, { ...CURRENT, lineupMetric: "overlap" }, simsBase);
  console.log(`  false merges=${evalA.falseMerges.length}  false splits=${evalA.falseSplits.length}  (current: ${cur.falseMerges.length}/${cur.falseSplits.length})`);
  for (const p of evalA.falseMerges) console.log(fmt(p, simsBase, { ...CURRENT, lineupMetric: "overlap" }));

  console.log("\n=== VARIANT B: extended title strip list (weights/bars unchanged) ===");
  const evalB = evaluate(pairs, CURRENT, simsExt);
  console.log(`  false merges=${evalB.falseMerges.length}  false splits=${evalB.falseSplits.length}  (current: ${cur.falseMerges.length}/${cur.falseSplits.length})`);
  for (const p of evalB.falseMerges) console.log(fmt(p, simsExt, CURRENT));

  console.log("\n=== VARIANT A+B (weights/bars unchanged) ===");
  const evalAB = evaluate(pairs, { ...CURRENT, lineupMetric: "overlap" }, simsExt);
  console.log(`  false merges=${evalAB.falseMerges.length}  false splits=${evalAB.falseSplits.length}`);

  // ---- C: grid search ------------------------------------------------------
  console.log("\n=== VARIANT C: grid search (cost = 5·FM + FS, '?' labels ×0.5) ===");
  interface Row {
    cfg: Config;
    ev: Evaluation;
  }
  const rows: Row[] = [];
  for (const lineupMetric of ["jaccard", "overlap"] as const) {
    for (const titleNorm of ["base", "extended"] as const) {
      const sims = titleNorm === "base" ? simsBase : simsExt;
      for (let wt = 20; wt <= 50; wt += 5) {
        for (let wl = 25; wl <= 55; wl += 5) {
          for (let ws = 5; ws <= 25; ws += 5) {
            const wp = 100 - wt - wl - ws;
            if (wp < 0 || wp > 15) continue;
            for (let bar = 700; bar <= 900; bar += 25) {
              for (let bar2 = bar; bar2 <= 950; bar2 += 25) {
                const cfg: Config = {
                  wTitle: wt / 100,
                  wLineup: wl / 100,
                  wStart: ws / 100,
                  wPrice: wp / 100,
                  bar: bar / 1000,
                  barNoLineup: bar2 / 1000,
                  lineupMetric,
                  titleNorm,
                };
                const ev = evaluate(pairs, cfg, sims);
                if (ev.relatedMerged.length > 0) continue; // hard constraint
                rows.push({ cfg, ev });
              }
            }
          }
        }
      }
    }
  }
  rows.sort(
    (a, b) =>
      a.ev.cost - b.ev.cost ||
      a.ev.falseMerges.length - b.ev.falseMerges.length ||
      // prefer conservative bars on full ties
      b.cfg.barNoLineup - a.cfg.barNoLineup ||
      b.cfg.bar - a.cfg.bar,
  );
  const show = (r: Row) =>
    console.log(
      `  cost=${r.ev.cost.toFixed(1)}  FM=${r.ev.falseMerges.length} FS=${r.ev.falseSplits.length}  ` +
        `w=(${r.cfg.wTitle.toFixed(2)}/${r.cfg.wLineup.toFixed(2)}/${r.cfg.wStart.toFixed(2)}/${r.cfg.wPrice.toFixed(2)}) ` +
        `bars=(${r.cfg.bar.toFixed(3)}/${r.cfg.barNoLineup.toFixed(3)}) ${r.cfg.lineupMetric}/${r.cfg.titleNorm}`,
    );
  console.log("top 12 configurations:");
  for (const r of rows.slice(0, 12)) show(r);

  console.log("\nbest per variant family:");
  for (const lineupMetric of ["jaccard", "overlap"] as const) {
    for (const titleNorm of ["base", "extended"] as const) {
      const best = rows.find((r) => r.cfg.lineupMetric === lineupMetric && r.cfg.titleNorm === titleNorm);
      if (best) show(best);
    }
  }

  // Best-with-current-weights (threshold-only tuning), for comparison.
  console.log("\nthreshold-only tuning (current weights, jaccard/base):");
  const thresholdOnly = rows.filter(
    (r) =>
      r.cfg.lineupMetric === "jaccard" &&
      r.cfg.titleNorm === "base" &&
      r.cfg.wTitle === 0.35 &&
      r.cfg.wLineup === 0.4 &&
      r.cfg.wStart === 0.15 &&
      r.cfg.wPrice === 0.1,
  );
  for (const r of thresholdOnly.slice(0, 3)) show(r);

  // ---- recommended configuration ------------------------------------------
  const rec = rows[0];
  console.log("\n=== RECOMMENDED (numbers only — NOT applied) ===");
  show(rec);
  console.log("confusion matrix at recommended config:");
  confusion(rec.cfg, rec.cfg.titleNorm === "base" ? simsBase : simsExt);
  const recSims = rec.cfg.titleNorm === "base" ? simsBase : simsExt;
  console.log(`false merges (${rec.ev.falseMerges.length}):`);
  for (const p of rec.ev.falseMerges) console.log(fmt(p, recSims, rec.cfg));
  console.log(`false splits (${rec.ev.falseSplits.length}):`);
  for (const p of rec.ev.falseSplits) console.log(fmt(p, recSims, rec.cfg));

  // ---- freeze fixture ------------------------------------------------------
  const fixture = {
    generatedAt: "2026-07-29",
    source: LABELLED,
    note:
      "Human-labelled dedupe calibration set (Step 11). Labels: SAME (one party, " +
      "multiple listings), DISTINCT (different parties), RELATED (same venue/night, " +
      "different room/session — must never merge). uncertain=true means the label " +
      "ended in '?' and weighs 0.5 in tuning. `shipped` holds the score the " +
      "pre-tuning config (0.35/0.40/0.15/0.10, bars 0.80/0.90, jaccard, base " +
      "normalization) produced from each event's own-source view. Raw inputs are " +
      "included so any future scorer can be re-evaluated against these labels.",
    pairs: pairs.map((p) => ({
      pairId: p.pairId,
      label: p.label,
      uncertain: p.uncertain,
      venue: p.venue,
      partyNight: p.partyNight,
      a: p.a,
      b: p.b,
      shipped: p.shipped,
    })),
  };
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`\nfroze ${pairs.length} labelled pairs to ${FIXTURE}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
