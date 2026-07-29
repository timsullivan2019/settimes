import { getUpcomingEvents } from "./query";

// Live data on every request — Step 20 adds revalidation/caching policy.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const parsed = rawLimit === null ? Number.NaN : Number.parseInt(rawLimit, 10);
  // Invalid or absent → the query's default; the query caps at MAX_LIMIT.
  const result = Number.isNaN(parsed) ? await getUpcomingEvents() : await getUpcomingEvents(parsed);
  return Response.json(result);
}
