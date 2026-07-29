import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema";
import { ingest } from "./ingest";
import type { NormalEvent } from "./types";

// Regression for the ingest-clobber bug: a canonical row holds §10.4-resolved
// data from several sources, and ingestOne used to refresh it from a single
// source's payload — so an RA ingest (no price, no ticket_url) nulled the
// merged Dice price on every dice→ra canonical row, permanently, because
// dedupe never re-evaluates merged pairs.
//
// This exercises the REAL production path — ingest() → ingestOne() →
// recomputeMergeGroup() — against live Postgres inside a rolled-back
// transaction, with a real merge group (canonical winner owned by RA, merged
// loser owned by Dice). Skipped without a DATABASE_URL
// (run via: node --env-file=.env.local node_modules/.bin/vitest run).

const url = process.env.DATABASE_URL;

const DICE_URL = "https://dice.fm/event/__clobber-test__";

function normalEvent(overrides: Partial<NormalEvent> & Pick<NormalEvent, "source" | "sourceEventId">): NormalEvent {
  return {
    sourceUrl: null,
    title: "Clobber Test Party",
    startsAt: new Date("2026-08-02T03:00:00Z"), // 2026-08-01 23:00 EDT
    endsAt: null,
    venueNameRaw: "__clobber-test-venue__",
    addressRaw: null,
    artists: [],
    priceMinCents: null,
    priceMaxCents: null,
    isFree: false,
    doorOnly: false,
    ageRestriction: null,
    flyerUrl: null,
    ticketUrl: null,
    status: "confirmed",
    addressSecret: false,
    raw: { test: true },
    ...overrides,
  };
}

describe.runIf(Boolean(url))("ingest recomputes merge groups (live db, rolled back)", () => {
  async function withMergeGroup(
    fn: (
      db: Parameters<typeof ingest>[2],
      pg: postgres.Sql,
      ids: { winner: string; loser: string },
    ) => Promise<void>,
  ): Promise<void> {
    const pg = postgres(url as string, { prepare: false });
    try {
      await pg.begin(async (tx) => {
        // Canonical winner, owned by RA. Its price/ticket_url currently hold
        // the merged Dice values, as after a real dedupe run.
        const [winner] = await tx`
          insert into events (slug, title, starts_at, party_night,
            price_min_cents, price_max_cents, is_free, ticket_url, is_canonical)
          values ('__clobber-test-winner__', 'Clobber Test Party',
            '2026-08-02T03:00:00Z', '2026-08-01', 6675, 7272, false,
            ${DICE_URL}, true)
          returning id`;
        // Merged loser, owned by Dice — the source the merged values came from.
        const [loser] = await tx`
          insert into events (slug, title, starts_at, party_night,
            price_min_cents, price_max_cents, is_free, ticket_url,
            age_restriction, is_canonical, merged_into)
          values ('__clobber-test-loser__', 'Clobber Test Party',
            '2026-08-02T03:00:00Z', '2026-08-01', 6675, 7272, false,
            ${DICE_URL}, '21+', false, ${winner.id})
          returning id`;
        await tx`
          insert into event_sources (event_id, source, source_event_id, raw)
          values (${winner.id}, 'ra', '__clobber_ra__', '{}'),
                 (${loser.id}, 'dice', '__clobber_dice__', '{}')`;

        // drizzle's postgres-js driver reads client.options.parsers, which a
        // TransactionSql lacks — graft the parent client's options on so the
        // transaction can serve as a drizzle client inside the rollback.
        const txClient = tx as unknown as postgres.Sql;
        txClient.options = pg.options;
        const db = drizzle(txClient, { schema });
        await fn(db as Parameters<typeof ingest>[2], tx as unknown as postgres.Sql, {
          winner: winner.id as string,
          loser: loser.id as string,
        });
        throw new Error("ROLLBACK");
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === "ROLLBACK")) throw error;
    } finally {
      await pg.end();
    }
  }

  it("RA ingest (no price, no ticket_url) does not clobber merged Dice values", async () => {
    await withMergeGroup(async (db, pg, ids) => {
      const result = await ingest(
        "ra",
        [normalEvent({ source: "ra", sourceEventId: "__clobber_ra__", title: "Clobber Test Party (RA billing)" })],
        db,
      );
      expect(result.updated).toBe(1);
      expect(result.errors).toBe(0);

      const [w] = await pg`
        select title, price_min_cents, price_max_cents, ticket_url,
               age_restriction, is_canonical
        from events where id = ${ids.winner}`;
      // The refresh itself happened — RA's (higher-trust, longer) title won…
      expect(w.title).toBe("Clobber Test Party (RA billing)");
      // …but the merged Dice values survived the RA payload's nulls.
      expect(w.price_min_cents).toBe(6675);
      expect(w.price_max_cents).toBe(7272);
      expect(w.ticket_url).toBe(DICE_URL);
      expect(w.age_restriction).toBe("21+");
      expect(w.is_canonical).toBe(true);
    });
  });

  it("Dice ingest of the loser refreshes its row and keeps the canonical resolved", async () => {
    await withMergeGroup(async (db, pg, ids) => {
      await ingest(
        "dice",
        [
          normalEvent({
            source: "dice",
            sourceEventId: "__clobber_dice__",
            priceMinCents: 5500, // Dice dropped the price
            priceMaxCents: 7272,
            ticketUrl: DICE_URL,
            ageRestriction: "21+",
          }),
        ],
        db,
      );

      const [l] = await pg`
        select price_min_cents, is_canonical, merged_into
        from events where id = ${ids.loser}`;
      expect(l.price_min_cents).toBe(5500);
      expect(l.is_canonical).toBe(false); // merge flags untouched by ingest
      expect(l.merged_into).toBe(ids.winner);

      const [w] = await pg`
        select price_min_cents, ticket_url, is_canonical
        from events where id = ${ids.winner}`;
      expect(w.price_min_cents).toBe(5500); // canonical follows the group's lowest
      expect(w.ticket_url).toBe(DICE_URL);
      expect(w.is_canonical).toBe(true);
    });
  });
});
