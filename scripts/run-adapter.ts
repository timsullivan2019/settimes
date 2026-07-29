import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import type { NormalEvent } from "../lib/types";

// Usage: npx tsx scripts/run-adapter.ts <adapter>
// Runs one adapter live, saves a fixture on first run, prints a summary.

const runners: Record<string, () => Promise<NormalEvent[]>> = {
  ra: async () => {
    const { fetchEvents } = await import("../adapters/ra");
    return fetchEvents({
      onPage: (page, raw) => {
        if (page === 1 && !existsSync("fixtures/ra-sample.json")) {
          mkdirSync("fixtures", { recursive: true });
          writeFileSync("fixtures/ra-sample.json", `${JSON.stringify(raw, null, 2)}\n`);
          console.log("saved fixtures/ra-sample.json");
        }
      },
    });
  },
};

async function main(): Promise<void> {
  const name = process.argv[2];
  const run = name ? runners[name] : undefined;
  if (!run) {
    console.error(`usage: npx tsx scripts/run-adapter.ts <${Object.keys(runners).join("|")}>`);
    process.exit(1);
    return;
  }

  const events = await run();

  const complete = events.filter(
    (e) => e.title && e.startsAt && e.venueNameRaw !== null && e.artists.length > 0,
  );
  console.log(`\n${name}: ${events.length} events`);
  console.log(`with title + start + venue + ≥1 artist: ${complete.length}`);
  console.log(`first event sourceUrl: ${events[0]?.sourceUrl}`);
  console.log("\nfirst two NormalEvents:");
  console.log(inspect(events.slice(0, 2), { depth: null, colors: false }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
