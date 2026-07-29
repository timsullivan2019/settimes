import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import postgres from "postgres";
import { combineScore, componentsFor, normalizeTitle } from "./dedupe";
import { NY_TZ } from "./time";

// Step 11 ground-truth regression: every scoring change must hold against the
// 60 hand-labelled pairs in fixtures/dedupe-pairs.json.
//
//   - ZERO false merges: no DISTINCT or RELATED pair may reach its bar. A
//     false merge hides a real event — the one failure that attacks the
//     mission (§10.3).
//   - RELATED must never merge, asserted separately (§10's multi-room case).
//   - False splits are cosmetic but bounded: ≤ 9 at calibration time. A
//     scoring change that increases them fails here and must either be fixed
//     or consciously re-baselined WITH a rerun of scripts/tune-dedupe.ts.
//
// Code-path coverage: this exercises normalizeTitle → pg_trgm similarity() →
// componentsFor → combineScore — the exact scoring pipeline dedupe() runs per
// candidate pair. Not covered here: candidate generation, hard merge/block
// rules, and merge persistence (verified live via scripts/run-dedupe.ts).
// Skipped without a DATABASE_URL
// (run via: node --env-file=.env.local node_modules/.bin/vitest run).

const url = process.env.DATABASE_URL;

interface FixtureSide {
  title: string;
  startNY: string;
  lineup: string[];
  priceMinCents: number | null;
}

interface FixturePair {
  pairId: string;
  label: "SAME" | "DISTINCT" | "RELATED";
  uncertain: boolean;
  a: FixtureSide;
  b: FixtureSide;
  venue: string;
}

const MAX_FALSE_SPLITS = 9;

function view(s: FixtureSide) {
  const start = DateTime.fromFormat(s.startNY, "yyyy-MM-dd HH:mm", { zone: NY_TZ });
  if (!start.isValid) throw new Error(`fixture: bad start ${JSON.stringify(s.startNY)}`);
  return {
    lineup: new Set(s.lineup.map((x) => x.toLowerCase())),
    startsAtMs: start.toMillis(),
    priceMinCents: s.priceMinCents,
  };
}

describe.runIf(Boolean(url))("dedupe scoring vs labelled ground truth (live pg_trgm)", () => {
  // 60 sequential similarity() round-trips through the transaction pooler
  // run ~5s — beyond vitest's default timeout.
  it("produces zero false merges, zero RELATED merges, and ≤9 false splits", { timeout: 60_000 }, async () => {
    const fixture = JSON.parse(readFileSync("fixtures/dedupe-pairs.json", "utf8")) as {
      pairs: FixturePair[];
    };
    expect(fixture.pairs.length).toBe(60);

    const pg = postgres(url as string, { prepare: false });
    try {
      const falseMerges: string[] = [];
      const falseSplits: string[] = [];
      for (const p of fixture.pairs) {
        const [row] = await pg`
          select similarity(${normalizeTitle(p.a.title)}, ${normalizeTitle(p.b.title)})::float8 as s`;
        const scored = combineScore(componentsFor(view(p.a), view(p.b), Number(row.s)));
        const merges = scored.score >= scored.threshold;
        const desc = `${p.pairId} [${p.label}] score=${scored.score.toFixed(3)} bar=${scored.threshold} ${JSON.stringify(p.a.title)} / ${JSON.stringify(p.b.title)} @ ${p.venue}`;
        if (merges && p.label !== "SAME") falseMerges.push(desc);
        if (!merges && p.label === "SAME") falseSplits.push(desc);
        if (p.label === "RELATED") {
          // Explicit: RELATED never merges, at any config (§10 multi-room).
          expect(merges, `RELATED pair merged: ${desc}`).toBe(false);
        }
      }

      expect(falseMerges, `false merges:\n${falseMerges.join("\n")}`).toEqual([]);
      console.log(
        `dedupe-fixture: false splits ${falseSplits.length}/${MAX_FALSE_SPLITS} allowed` +
          (falseSplits.length > 0 ? `\n${falseSplits.join("\n")}` : ""),
      );
      expect(falseSplits.length, `false splits:\n${falseSplits.join("\n")}`).toBeLessThanOrEqual(
        MAX_FALSE_SPLITS,
      );
    } finally {
      await pg.end();
    }
  });
});
