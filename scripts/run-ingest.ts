import { sql } from "drizzle-orm";
import { client, db } from "../db/client";
import { ingest } from "../lib/ingest";
import type { NormalEvent } from "../lib/types";

// Usage: npx tsx --env-file=.env.local scripts/run-ingest.ts <adapter>
// Fetches from one adapter, ingests, prints run counters and table counts.

const adapters: Record<string, () => Promise<NormalEvent[]>> = {
  ra: async () => {
    const { fetchEvents } = await import("../adapters/ra");
    return fetchEvents();
  },
};

async function main(): Promise<void> {
  const name = process.argv[2];
  const fetch = name ? adapters[name] : undefined;
  if (!fetch) {
    console.error(`usage: npx tsx --env-file=.env.local scripts/run-ingest.ts <${Object.keys(adapters).join("|")}>`);
    process.exitCode = 1;
    return;
  }

  const normalEvents = await fetch();
  const result = await ingest(name as "ra", normalEvents);
  console.log("ingest_runs row:", result);

  const [counts] = await db.execute(
    sql`select
          (select count(*) from events) as events,
          (select count(*) from event_sources) as event_sources`,
  );
  console.log("table counts:", counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
