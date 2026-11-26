/**
 * A timing in stretches found by the moments the lines fill (coverStretches in src/sync.ts): for a
 * loose translation made for another cut, later after each break and by more than the windows'
 * search reaches. Built from the benchmark's made-up episodes (test/synthetic.ts).
 */
import { describe, expect, it } from "vitest";
import { coverStretches } from "../src/sync.js";
import { episode, faithful, indexFile, retimedByOthers, stepped, windowFile, without } from "./synthetic.js";

describe("captions that fill the file's moments in stretches far apart", () => {
  const film = episode(311, { minutes: 96 });
  const cuts = [28 * 60_000, 68 * 60_000];
  /** A translation with seven in ten of the lines, joined and split otherwise and each a beat off, so few start where the file's do. */
  const loose = (lines = film.lines) => without(retimedByOthers(faithful(lines), 312, { jitter: 350, merge: 0.3, split: 0.2 }), 313, 0.3);

  it("are timed stretch by stretch, each at its own shift", () => {
    const sub = stepped(loose(), cuts, [-2500, -12300, -27600]);
    const timed = coverStretches(indexFile(film.duration, [film.lines]), sub);
    expect(timed).toBeDefined();
    expect(timed!.cover - timed!.decoy).toBeGreaterThan(0.15);
    const at = (minute: number) => timed!.anchors.reduce((a, b) => (Math.abs(b.from - minute * 60_000) < Math.abs(a.from - minute * 60_000) ? b : a)).offset;
    for (const [minute, shift] of [[10, 2500], [20, 2500], [40, 12300], [60, 12300], [75, 27600], [90, 27600]]) expect(Math.abs(at(minute) - shift)).toBeLessThanOrEqual(400);
  });

  it("aren't, when they are another film's", () => {
    const other = loose(episode(315, { minutes: 96 }).lines);
    expect(coverStretches(indexFile(film.duration, [film.lines]), other)).toBeUndefined();
  });

  it("aren't, when only the first part of the file is theirs", () => {
    const sub = stepped(loose(), cuts, [-2500, -12300, -27600]).filter((l) => l.truth < 30 * 60_000);
    const rest = loose(episode(316, { minutes: 96 }).lines).filter((l) => l.start >= 31 * 60_000);
    expect(coverStretches(indexFile(film.duration, [film.lines]), [...sub, ...rest])).toBeUndefined();
  });

  it("aren't looked for on a file read in windows, or one moved earlier than a far shift", () => {
    expect(coverStretches(windowFile(film.duration, film.lines), stepped(loose(), cuts, [-2500, -12300, -27600]))).toBeUndefined();
    // Captions that have more than the file sit earlier and earlier: not this way's to time.
    expect(coverStretches(indexFile(film.duration, [film.lines]), stepped(loose(), cuts, [2500, 42300, 87600]))).toBeUndefined();
  });
});
