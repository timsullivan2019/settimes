import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { applySeedRow } from "./venue-seed";

// Exercises the REAL alias-array binding against Postgres — the drizzle
// template expanded arrays into records (42846), and a mock can't catch that
// class of bug. Runs inside a rolled-back transaction; skipped without a
// DATABASE_URL (run via: node --env-file=.env.local node_modules/.bin/vitest run).

const url = process.env.DATABASE_URL;

describe.runIf(Boolean(url))("applySeedRow (live db, rolled back)", () => {
  async function withTempVenue(
    fn: (pg: postgres.Sql, venueId: string) => Promise<void>,
  ): Promise<void> {
    const pg = postgres(url as string, { prepare: false });
    try {
      await pg.begin(async (tx) => {
        const [venue] = await tx`
          insert into venues (name, slug, aliases)
          values ('__seed_test__', '__seed-test__', array['Existing Alias'])
          returning id`;
        await fn(tx as unknown as postgres.Sql, venue.id as string);
        throw new Error("ROLLBACK");
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === "ROLLBACK")) throw error;
    } finally {
      await pg.end();
    }
  }

  async function fetchVenue(pg: postgres.Sql, id: string) {
    const [v] = await pg`
      select address, aliases, ST_AsText(geog::geometry) as point
      from venues where id = ${id}`;
    return v;
  }

  it("zero aliases: address and point apply, aliases untouched", async () => {
    await withTempVenue(async (pg, id) => {
      await applySeedRow(pg, id, {
        aliases: [],
        address: "90 Scott Ave, Brooklyn, NY 11237",
        point: { lat: 40.7107, lng: -73.92285 },
      });
      const v = await fetchVenue(pg, id);
      expect(v.address).toBe("90 Scott Ave, Brooklyn, NY 11237");
      expect(v.aliases).toEqual(["Existing Alias"]);
      expect(v.point).toBe("POINT(-73.92285 40.7107)");
    });
  });

  it("one alias merges with existing", async () => {
    await withTempVenue(async (pg, id) => {
      await applySeedRow(pg, id, { aliases: ["Silo"], address: null, point: null });
      const v = await fetchVenue(pg, id);
      expect([...v.aliases].sort()).toEqual(["Existing Alias", "Silo"]);
      expect(v.address).toBeNull();
      expect(v.point).toBeNull();
    });
  });

  it("three aliases (incl. quote) merge distinct and idempotent", async () => {
    await withTempVenue(async (pg, id) => {
      const update = {
        aliases: ["S.O.B.'s", "Sounds of Brazil", "Existing Alias"],
        address: null,
        point: null,
      };
      await applySeedRow(pg, id, update);
      await applySeedRow(pg, id, update); // re-run must not duplicate
      const v = await fetchVenue(pg, id);
      expect([...v.aliases].sort()).toEqual(["Existing Alias", "S.O.B.'s", "Sounds of Brazil"]);
    });
  });

  it("null address and point never clear stored values", async () => {
    await withTempVenue(async (pg, id) => {
      await applySeedRow(pg, id, {
        aliases: [],
        address: "204 Varick St",
        point: { lat: 40.7286, lng: -74.0052 },
      });
      await applySeedRow(pg, id, { aliases: ["SOB's"], address: null, point: null });
      const v = await fetchVenue(pg, id);
      expect(v.address).toBe("204 Varick St");
      expect(v.point).toBe("POINT(-74.0052 40.7286)");
    });
  });
});
