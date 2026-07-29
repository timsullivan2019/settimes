# Dedupe pair labelling guide (Step 11)

Fill the blank `label` column in `docs/dedupe-pairs.csv` with exactly one of
the three labels below, in caps. Do not open `docs/dedupe-pairs-scores.csv`
until every row is labelled — it holds the scores being calibrated, and
knowing the number anchors the judgment we're trying to test.

## The three labels

### SAME — one party, multiple listings

The two rows describe a single real-world event that happens to be listed on
more than one platform (or twice on one). Ticket buyers from either listing
end up in the same room dancing to the same lineup.

Signs: same headliner or overlapping lineup, titles that are variants of each
other ("Artbat" / "ARTBAT", "presents…" prefixes, "[NYC]" suffixes), the same
promoter series name. Prices may differ — platforms charge different fees and
tiers sell out at different times. Lineups may differ too: sources often list
different slices of the same bill (one lists only the headliner, the other the
full undercard). A partial lineup is NOT evidence of a different party.

### DISTINCT — different parties

Two genuinely different events. They merely share a venue and a night, or the
sampler paired them for some other reason.

Signs: different headliners, unrelated titles, clearly different crowds or
series ("Reggaeton Boat Party" vs "Float & Flex Friday"), start times hours
apart at a bar that turns over.

### RELATED — same venue, same night, different room or session

The multi-room / multi-session case: simultaneous or back-to-back events under
one roof that a buyer must choose between with separate tickets. Examples in
this data: Skyport Marina running several boat parties in one night, Elsewhere
programming the Hall and Zone One concurrently, SILO main room vs yard, an
early sail vs a midnight sail on the same boat.

**RELATED must never merge.** Merging it hides a real event behind another —
the one failure that attacks the mission (§10.3: a false split shows a party
twice; a false merge deletes one). RELATED is labelled separately from
DISTINCT because it is exactly the case the hard never-merge rule and the
candidate keys exist to protect, and the tuning needs to know how often it
lands near the merge threshold.

## Judgment calls

- Use the `event_a_url` / `event_b_url` columns when the row alone doesn't
  settle it — the live listing pages usually do.
- If a listing has been taken down and you genuinely cannot tell, label it
  with your best guess and append `?` (e.g. `SAME?`) — uncertain labels get
  downweighted rather than discarded.
- Same boat, same night, two departure times → RELATED, not DISTINCT.
- A free RSVP listing and a paid listing for the same room and lineup → SAME
  (platforms gate entry differently; it's still one party).

## What happens with the labels

The labelled file joins to `docs/dedupe-pairs-scores.csv` on `pair_id`. The
weights, the 0.80 threshold, and the raised 0.90 no-lineup bar then get tuned
against your labels — never the other way around — and the set is frozen into
`fixtures/dedupe-pairs.json` as a regression test so future scoring changes
are checked against human ground truth.
