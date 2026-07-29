import { describe, expect, it } from "vitest";
import { parseLineup } from "./artists";

describe("parseLineup", () => {
  it('parseLineup("A b2b B (live)") → two artists, one note', () => {
    const result = parseLineup("A b2b B (live)");
    expect(result).toEqual([
      { name: "A", note: null },
      { name: "B", note: "live" },
    ]);
    expect(result).toHaveLength(2);
    expect(result.filter((a) => a.note !== null)).toHaveLength(1);
  });

  it("splits on B2B uppercase", () => {
    expect(parseLineup("Ben UFO B2B Joy Orbison")).toEqual([
      { name: "Ben UFO", note: null },
      { name: "Joy Orbison", note: null },
    ]);
  });

  it("splits on & and +", () => {
    expect(parseLineup("DJ Python & ral + Sybil").map((a) => a.name)).toEqual([
      "DJ Python",
      "ral",
      "Sybil",
    ]);
  });

  it("splits on vs and vs.", () => {
    expect(parseLineup("Surgeon vs Regis").map((a) => a.name)).toEqual(["Surgeon", "Regis"]);
    expect(parseLineup("Surgeon vs. Regis").map((a) => a.name)).toEqual(["Surgeon", "Regis"]);
  });

  it("splits on whitespace-delimited x", () => {
    expect(parseLineup("Helena Hauff x DJ Stingray").map((a) => a.name)).toEqual([
      "Helena Hauff",
      "DJ Stingray",
    ]);
  });

  it("does not split on x inside a name", () => {
    expect(parseLineup("Actress")).toEqual([{ name: "Actress", note: null }]);
    expect(parseLineup("DJ Excess")).toEqual([{ name: "DJ Excess", note: null }]);
  });

  it("strips (AV), (DJ set), and (all night long) into notes", () => {
    expect(parseLineup("Max Cooper (AV)")).toEqual([{ name: "Max Cooper", note: "AV" }]);
    expect(parseLineup("Fred again.. (DJ set)")).toEqual([
      { name: "Fred again..", note: "DJ set" },
    ]);
    expect(parseLineup("Marcel Dettmann (all night long)")).toEqual([
      { name: "Marcel Dettmann", note: "all night long" },
    ]);
  });

  it("handles a note mid-string without corrupting the split", () => {
    expect(parseLineup("Overmono (live) + Batu")).toEqual([
      { name: "Overmono", note: "live" },
      { name: "Batu", note: null },
    ]);
  });

  it("returns [] for empty or whitespace input", () => {
    expect(parseLineup("")).toEqual([]);
    expect(parseLineup("   ")).toEqual([]);
  });

  it("drops empty segments from stray separators", () => {
    expect(parseLineup("A & ").map((a) => a.name)).toEqual(["A"]);
  });
});
