import { DateTime } from "luxon";
import { NY_TZ } from "../lib/time";
import { getUpcomingEvents, type UpcomingEvent } from "./api/events/query";

// Live data on every request — Step 20 adds the 5-minute revalidate.
export const dynamic = "force-dynamic";

function nyTime(iso: string): DateTime {
  return DateTime.fromISO(iso).setZone(NY_TZ);
}

function EventRow({ event }: { event: UpcomingEvent }) {
  const starts = nyTime(event.starts_at);
  const ends = event.ends_at === null ? null : nyTime(event.ends_at);
  return (
    <li>
      <article>
        <time dateTime={event.starts_at}>
          {starts.toFormat("ccc LLL d")} · {starts.toFormat("h:mm a")}
          {ends !== null ? `–${ends.toFormat("h:mm a")}` : ""}
        </time>
        <h2>{event.title}</h2>
        <p>{event.venue_name_raw ?? "Venue TBA"}</p>
        {event.artist_names.length > 0 ? <p>{event.artist_names.join(" · ")}</p> : null}
      </article>
    </li>
  );
}

export default async function Home() {
  const events = await getUpcomingEvents();
  return (
    <main>
      <h1>settimes.nyc</h1>
      <ol>
        {events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </ol>
    </main>
  );
}
