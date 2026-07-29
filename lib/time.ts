import { DateTime, IANAZone } from "luxon";

export const NY_TZ = "America/New_York";

const DAY_MS = 86_400_000;

// Tries ISO first ("2026-08-14T23:00:00"), then SQL ("2026-08-14 23:00:00").
function parseWith(input: string, zone: string): DateTime {
  const iso = DateTime.fromISO(input, { zone });
  if (iso.isValid) return iso;
  return DateTime.fromSQL(input, { zone });
}

// A naive wall time on the fall-back night occurs twice; §9.1 rule 1 says take
// the first. Luxon's own resolution of ambiguous times depends on the offset in
// effect when the code runs, so resolve explicitly: compute both candidate
// instants and keep the earliest valid one.
function resolveNaive(wall: DateTime, zoneName: string): DateTime {
  const zone = IANAZone.isValidZone(zoneName) ? IANAZone.create(zoneName) : null;
  if (zone) {
    // `wall` holds the string's components read as if UTC, so its millis are
    // the naive wall time on a transition-free axis.
    const wallTs = wall.toMillis();
    const offsets = [...new Set([zone.offset(wallTs - DAY_MS), zone.offset(wallTs + DAY_MS)])];
    const candidates = offsets
      .map((offset) => wallTs - offset * 60_000)
      .filter((ts) => zone.offset(ts) === (wallTs - ts) / 60_000);
    if (candidates.length > 0) {
      return DateTime.fromMillis(Math.min(...candidates), { zone: zoneName });
    }
  }
  // Fixed-offset zone, or a spring-forward wall time that doesn't exist —
  // let Luxon resolve it.
  const dt = DateTime.fromObject(
    {
      year: wall.year,
      month: wall.month,
      day: wall.day,
      hour: wall.hour,
      minute: wall.minute,
      second: wall.second,
      millisecond: wall.millisecond,
    },
    { zone: zoneName },
  );
  if (!dt.isValid) {
    throw new Error(`parseLocal: invalid zone ${JSON.stringify(zoneName)}: ${dt.invalidReason}`);
  }
  return dt;
}

/**
 * Parse a source timestamp into an America/New_York DateTime.
 *
 * - Strings carrying an offset ("...Z", "...-04:00") keep their instant.
 * - Naive strings ("2026-08-14T23:00") are interpreted in `sourceTz`.
 * - Unparseable input throws — never invent data.
 */
export function parseLocal(input: string, sourceTz: string = NY_TZ): DateTime {
  // A bare date would parse as midnight, and midnight minus 6h puts
  // party_night on the previous day — every event silently one day early.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    throw new Error(
      `parseLocal: date-only input ${JSON.stringify(input)} — combine with a time first`,
    );
  }
  const asUtc = parseWith(input, "utc");
  const asShifted = parseWith(input, "utc+2");
  if (!asUtc.isValid || !asShifted.isValid) {
    throw new Error(
      `parseLocal: unparseable timestamp ${JSON.stringify(input)}: ${
        asUtc.invalidExplanation ?? asUtc.invalidReason
      }`,
    );
  }
  // If the string carries its own offset, the interpretation zone is ignored
  // and both parses land on the same instant.
  const hasOwnOffset = asUtc.toMillis() === asShifted.toMillis();
  if (hasOwnOffset) return asUtc.setZone(NY_TZ);
  return resolveNaive(asUtc, sourceTz).setZone(NY_TZ);
}

/**
 * party_night = (starts_at at time zone 'America/New_York' - interval '6 hours')::date
 *
 * The subtraction happens in naive local space (as Postgres does it), so this
 * stays byte-identical to the SQL definition even across DST transitions.
 */
export function computePartyNight(startsAt: DateTime | Date): string {
  const local = (startsAt instanceof Date ? DateTime.fromJSDate(startsAt) : startsAt).setZone(
    NY_TZ,
  );
  if (!local.isValid) {
    throw new Error(`computePartyNight: invalid input: ${local.invalidReason}`);
  }
  const naive = DateTime.utc(
    local.year,
    local.month,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const date = naive.minus({ hours: 6 }).toISODate();
  if (date === null) {
    throw new Error("computePartyNight: could not derive a date");
  }
  return date;
}
