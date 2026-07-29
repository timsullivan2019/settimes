export interface LineupArtist {
  name: string;
  /** Performance qualifier stripped from the name: "live", "AV", "DJ set", … */
  note: string | null;
}

// §9.1 rule 5: split on b2b / & / + / x / vs. The word separators require
// surrounding whitespace so names containing them ("Actress", "DJ Excess")
// survive intact.
const SEPARATOR_RE = /\s+(?:b2b|vs\.?|x)\s+|\s*[&+]\s*/gi;

const NOTE_RE = /\s*\((live|a\/?v|dj set|all night long)\)\s*/gi;

export function parseLineup(raw: string): LineupArtist[] {
  if (!raw || !raw.trim()) return [];
  const out: LineupArtist[] = [];
  for (const segment of raw.split(SEPARATOR_RE)) {
    const notes: string[] = [];
    const name = segment
      .replace(NOTE_RE, (_match, note: string) => {
        notes.push(note);
        return " ";
      })
      .replace(/\s+/g, " ")
      .trim();
    if (!name) continue;
    out.push({ name, note: notes.length > 0 ? notes.join(", ") : null });
  }
  return out;
}
