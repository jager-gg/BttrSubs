/**
 * A step in dub captions' timing (src/sync.ts dubStepsEarned): kept where the file's line starts meet
 * the captions there at the step's shift, joined to its neighbour where they meet better at the
 * neighbour's.
 */
import { describe, expect, it } from "vitest";
import { dubStepsEarned, type Anchor, type Cue } from "../src/sync.js";

/** A dialogue's line starts, irregular like real speech (a seeded random walk). */
function dialogue(seed: number, until = 20 * 60000): Cue[] {
  let s = seed;
  const random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Cue[] = [];
  for (let t = 5000; t < until - 5000; ) {
    const length = 900 + Math.round(random() * 2600);
    out.push({ start: t, end: t + length });
    t += length + 150 + Math.round(random() * (random() < 0.15 ? 6000 : 1500));
  }
  return out;
}

/**
 * Dub captions for the file's lines: each line `late(t)` ms later, give or take 150 ms (the dub's
 * voices start near, not at, the original's), every fourth line split in two and every seventh
 * left out (a dub's script breaks lines its own way).
 */
function dubOf(lines: Cue[], late: (t: number) => number): Cue[] {
  const out: Cue[] = [];
  lines.forEach((c, i) => {
    if (i % 7 === 3) return;
    const jitter = ((i * 37) % 300) - 150;
    const start = c.start + late(c.start) + jitter;
    const length = c.end - c.start;
    if (i % 4 === 1 && length > 1600) {
      out.push({ start, end: start + length / 2 }, { start: start + length / 2 + 80, end: start + length });
    } else out.push({ start, end: start + length });
  });
  return out;
}

/** Minute-long windows' anchors at these offsets (the captions moved by offset land on the file). */
const anchorsAt = (offsets: number[]): Anchor[] => offsets.map((offset, k) => ({ from: k * 60000, to: (k + 1) * 60000, offset }) as Anchor);

describe("a step in dub captions' timing", () => {
  const lines = dialogue(41);

  it("joins its neighbour when two windows agree on a shift by chance and the line starts meet at the neighbour's", () => {
    const captions = dubOf(lines, () => 7000);
    const anchors = anchorsAt([-15700, -15500, ...Array.from({ length: 18 }, () => -7000)]);
    const earned = dubStepsEarned(anchors, captions, lines);
    expect(earned.map((a) => a.offset)).toEqual(Array.from({ length: 20 }, () => -7000));
  });

  it("is kept where the captions do step there: a cut in one release", () => {
    const captions = dubOf(lines, (t) => (t < 120000 ? 15500 : 7000));
    const anchors = anchorsAt([-15700, -15500, ...Array.from({ length: 18 }, () => -7000)]);
    expect(dubStepsEarned(anchors, captions, lines)).toEqual(anchors);
  });

  it("keeps a lone window off the timing where its lines can't say (too few of them)", () => {
    const sparse = lines.filter((c) => c.start >= 60000 || c.start < 8000);
    const captions = dubOf(sparse, () => 7000);
    const anchors = anchorsAt([-15700, ...Array.from({ length: 19 }, () => -7000)]);
    expect(dubStepsEarned(anchors, captions, sparse)[0].offset).toBe(-15700);
  });

  it("leaves one run as it is", () => {
    const anchors = anchorsAt(Array.from({ length: 20 }, (_, k) => -7000 + (k % 3) * 100));
    expect(dubStepsEarned(anchors, dubOf(lines, () => 7000), lines)).toBe(anchors);
  });
});
