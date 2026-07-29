import { getUpcomingEvents } from "./query";

// Live data on every request — Step 20 adds revalidation/caching policy.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const events = await getUpcomingEvents();
  return Response.json({ events });
}
