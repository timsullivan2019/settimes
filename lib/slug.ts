import { createHash } from "node:crypto";

// Title is normalized before hashing so trivial casing/whitespace differences
// between fetches don't mint a new slug for the same event.
export function shortHash(input: string, length = 8): string {
  return createHash("sha256")
    .update(input.trim().toLowerCase().replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, length);
}

/** §9.1 rule 3: `${venue-slug}-${party_night}-${shorthash(title)}` */
export function eventSlug(venueSlug: string, partyNight: string, title: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(partyNight)) {
    throw new Error(`eventSlug: partyNight must be YYYY-MM-DD, got ${JSON.stringify(partyNight)}`);
  }
  return `${venueSlug}-${partyNight}-${shortHash(title)}`;
}
