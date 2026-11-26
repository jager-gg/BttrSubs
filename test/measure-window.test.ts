/**
 * measureWindow (src/sync.ts) against a plain reference: the same result object, to the last bit, on
 * generated windows. The reference walks every caption from the start for every shift; measureWindow
 * must find the same scores on the 40 ms grid and the 5 ms refinement, and so the same peaks, order
 * and undefined cases.
 */
import { describe, expect, it } from "vitest";
import { measureWindow, type Cue, type Measured } from "../src/sync.js";

// ---------- reference ----------

/** Total overlap between a and b shifted by `shift`. Both sorted by start. */
function referenceOverlap(a: Cue[], b: Cue[], shift: number): number {
  let total = 0;
  let j = 0;
  for (const x of a) {
    while (j < b.length && b[j].end + shift <= x.start) j++;
    for (let k = j; k < b.length && b[k].start + shift < x.end; k++) {
      total += Math.max(0, Math.min(x.end, b[k].end + shift) - Math.max(x.start, b[k].start + shift));
    }
  }
  return total;
}

function referenceMeasureWindow(embedded: Cue[], captions: Cue[], range = 20000, centre = 0): Measured | undefined {
  if (centre !== 0) {
    // Searched over centre ± range: the captions moved by centre first, then measured as usual.
    const moved = referenceMeasureWindow(embedded, captions.map((c) => ({ start: c.start + centre, end: c.end + centre })), range);
    return moved && { offset: moved.offset + centre, score: moved.score, alternatives: moved.alternatives.map((a) => ({ offset: a.offset + centre, score: a.score })) };
  }
  if (embedded.length < 3) return undefined;
  const speech = embedded.reduce((sum, c) => sum + (c.end - c.start), 0);
  const from = embedded[0].start - range - 1000;
  const to = embedded[embedded.length - 1].end + range + 1000;
  const near = captions.filter((c) => c.end >= from && c.start <= to);
  if (near.length < 3) return undefined;

  const scores: number[] = [];
  for (let shift = -range; shift <= range; shift += 40) scores.push(referenceOverlap(embedded, near, shift));
  // Local peaks, each refined to 5 ms.
  const peaks: Array<{ offset: number; score: number }> = [];
  // The two ends of the range aren't peaks: the fit may still be rising past them, towards a shift
  // that wasn't searched.
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] <= 0 || scores[i] < scores[i - 1] || scores[i] < scores[i + 1]) continue;
    let peak = { offset: -range + i * 40, score: scores[i] };
    for (let shift = peak.offset - 40; shift <= peak.offset + 40; shift += 5) {
      const score = referenceOverlap(embedded, near, shift);
      if (score > peak.score) peak = { offset: shift, score };
    }
    peaks.push({ offset: peak.offset, score: Math.round((peak.score / speech) * 100) / 100 });
  }
  peaks.sort((a, b) => b.score - a.score);
  const best = peaks[0];
  if (!best || best.score < 0.45) return undefined;
  const alternatives = peaks.slice(1).filter((p) => p.score >= best.score * 0.9 && Math.abs(p.offset - best.offset) > 400);
  return { offset: best.offset, score: best.score, alternatives };
}

// ---------- generated windows ----------

/** A seeded generator, so every run draws the same windows. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: T[]): T => xs[Math.floor(rng() * xs.length)];
const byStart = (a: Cue, b: Cue) => a.start - b.start;

/** A time in ms: whole, to the frame (as from 23.976 fps), or any fraction. */
function time(rng: Rng, ms: number, kind: number): number {
  if (kind === 0) return Math.round(ms);
  if (kind === 1) return Math.round(ms / 41.708333) * 41.708333;
  return ms + rng() * 0.999;
}

/** Back-to-back lines over `length` ms, some touching, some overlapping, some with gaps. */
function dialogue(rng: Rng, from: number, length: number, count: number, kind: number): Cue[] {
  const cues: Cue[] = [];
  let at = from;
  const step = length / Math.max(1, count);
  for (let i = 0; i < count; i++) {
    const start = time(rng, at, kind);
    const style = rng();
    const duration = style < 0.15 ? step : style < 0.25 ? step * (1.2 + rng()) : step * (0.3 + rng() * 0.6);
    cues.push({ start, end: style < 0.15 ? time(rng, at + step, kind) : time(rng, at + Math.max(1, duration), kind) });
    at += step * (0.6 + rng() * 0.8);
  }
  return cues.sort(byStart);
}

/** One window of a file and the subtitle for the whole of it, out by some shift. */
function episodeShaped(rng: Rng): { embedded: Cue[]; captions: Cue[] } {
  const kind = int(rng, 0, 2);
  const lines = int(rng, 0, 600);
  const full = dialogue(rng, int(rng, 0, 60000), lines * int(rng, 1500, 3500), lines, kind);
  const shift = int(rng, -25000, 25000) + (kind === 2 ? rng() : 0);
  const keep = 0.5 + rng() * 0.5;
  const captions = full.filter(() => rng() < keep).map((c) => ({ start: c.start + shift, end: c.end + shift + (rng() < 0.3 ? int(rng, -300, 300) : 0) }));
  // Lines only the subtitle has.
  for (let i = int(rng, 0, 20); i > 0; i--) {
    const at = time(rng, rng() * (lines * 3000 + 60000), kind);
    captions.push({ start: at, end: at + int(rng, 300, 4000) });
  }
  captions.sort(byStart);
  const count = int(rng, 3, 40);
  const first = full.length > count ? int(rng, 0, full.length - count) : 0;
  const embedded = full.slice(first, first + count).filter(() => rng() < 0.9);
  return { embedded, captions };
}

/** Lines anywhere, of any length, including far outside the window. */
function scattered(rng: Rng): { embedded: Cue[]; captions: Cue[] } {
  const kind = int(rng, 0, 2);
  const embedded: Cue[] = [];
  const base = int(rng, -5000, 200000);
  for (let i = int(rng, 0, 40); i > 0; i--) {
    const start = time(rng, base + rng() * 120000, kind);
    embedded.push({ start, end: start + time(rng, rng() * 6000, kind) });
  }
  embedded.sort(byStart);
  const captions: Cue[] = [];
  for (let i = int(rng, 0, 400); i > 0; i--) {
    const start = time(rng, base - 300000 + rng() * 720000, kind);
    captions.push({ start, end: start + time(rng, rng() * 6000, kind) });
  }
  captions.sort(byStart);
  return { embedded, captions };
}

/** Evenly spaced lines of one length: the fit repeats every period, so peaks tie. */
function periodic(rng: Rng): { embedded: Cue[]; captions: Cue[] } {
  const period = pick(rng, [400, 1000, 1200, 2000, 2500, 3000, 4000]);
  const length = Math.max(40, Math.round(period * (0.2 + rng() * 0.8)));
  const fraction = rng() < 0.3 ? pick(rng, [0.5, 0.25, 0.1, 1 / 3]) : 0;
  const count = int(rng, 3, 40);
  const embedded = Array.from({ length: count }, (_, i) => ({ start: 60000 + i * period + fraction, end: 60000 + i * period + length + fraction }));
  const shift = int(rng, -3000, 3000);
  const total = int(rng, count, 200);
  const captions = Array.from({ length: total }, (_, i) => ({ start: 60000 - 10 * period + i * period + shift, end: 60000 - 10 * period + i * period + shift + length + (rng() < 0.2 ? 20 : 0) }));
  return { embedded, captions };
}

/** Two copies of the same lines at two shifts: two near-equal peaks. */
function twoFits(rng: Rng): { embedded: Cue[]; captions: Cue[] } {
  const kind = int(rng, 0, 2);
  const embedded = dialogue(rng, 100000, int(rng, 10000, 60000), int(rng, 3, 40), kind);
  const a = int(rng, -15000, 15000);
  const b = a + pick(rng, [-1, 1]) * int(rng, 300, 9000);
  const copy = (shift: number, drop: number) => embedded.filter(() => rng() >= drop).map((c) => ({ start: c.start + shift, end: c.end + shift }));
  const captions = [...copy(a, 0), ...copy(b, rng() * 0.1)].sort(byStart);
  return { embedded, captions };
}

/** Next to nothing: a handful of lines or none. */
function tiny(rng: Rng): { embedded: Cue[]; captions: Cue[] } {
  const kind = int(rng, 0, 2);
  const cue = () => {
    const start = time(rng, 50000 + rng() * 20000, kind);
    return { start, end: start + time(rng, rng() * 3000, kind) };
  };
  const embedded = Array.from({ length: int(rng, 0, 4) }, cue).sort(byStart);
  const captions = Array.from({ length: int(rng, 0, 5) }, cue).sort(byStart);
  return { embedded, captions };
}

/** Lines out of order, of zero or negative length: measureWindow matches the reference on these too. */
function unsorted(rng: Rng): { embedded: Cue[]; captions: Cue[] } {
  const { embedded, captions } = scattered(rng);
  const shuffle = (cues: Cue[]) => cues.map((c) => ({ c, k: rng() })).sort((x, y) => x.k - y.k).map((x) => x.c);
  const bend = (cues: Cue[]) => cues.map((c) => (rng() < 0.1 ? { start: c.start, end: c.start - rng() * 500 } : rng() < 0.1 ? { start: c.start, end: c.start } : c));
  return { embedded: rng() < 0.5 ? shuffle(bend(embedded)) : bend(embedded), captions: rng() < 0.5 ? shuffle(bend(captions)) : bend(captions) };
}

/** Whole-millisecond times moved far out: some still summed exactly, some too large for that. */
function far(rng: Rng): { embedded: Cue[]; captions: Cue[] } {
  const { embedded, captions } = twoFits(rng);
  const by = pick(rng, [2 ** 30, -(2 ** 32), 2 ** 40, 2 ** 44, -(2 ** 45)]);
  const move = (cues: Cue[]) => cues.map((c) => ({ start: Math.round(c.start) + by, end: Math.round(c.end) + by }));
  return { embedded: move(embedded), captions: move(captions) };
}

const RANGES = [20000, 3000, 20000, 1500, 3001, 7777.5, 100, 0];
const CENTRES = [0, 0, -2500, 1234.5, 40000, -0.25, -17000];

/**
 * The true shift just inside or just past the end of the range: a peak rising at the end of its 5 ms
 * refinement carries on past range.
 */
function edge(rng: Rng): { embedded: Cue[]; captions: Cue[]; range: number } {
  const range = pick(rng, [3000, 20000, 1500]);
  if (rng() < 0.6) {
    // A long caption under every line holds the fit level across the range, and short lines meet
    // their captions in two narrow rises between the last two 40 ms steps and past the end: the 40 ms
    // step before the end is a peak, and its refinement climbs from the first rise to the second.
    const first = range - int(rng, 1, 39);
    const second = range + int(rng, 1, 30);
    const low = int(rng, 1, 2);
    const embedded: Cue[] = [{ start: 100000, end: 100000 + int(rng, 300, 3000) }];
    const captions: Cue[] = [];
    for (let i = 0; i < low * 2 + 1 + int(rng, 0, 1); i++) {
      const start = 150000 + 50000 * i;
      const line = { start, end: start + int(rng, 3, 15) };
      embedded.push(line);
      const by = i < low ? first : second;
      captions.push({ start: line.start - by, end: line.end - by });
    }
    captions.push({ start: 0, end: 150000 + 50000 * embedded.length + 50000 });
    return { embedded, captions: captions.sort(byStart), range };
  }
  const embedded = dialogue(rng, 100000, int(rng, 10000, 60000), int(rng, 3, 40), int(rng, 0, 1));
  const shift = pick(rng, [-1, 1]) * (range + int(rng, -60, 400));
  const captions = embedded.filter(() => rng() < 0.9).map((c) => ({ start: c.start + shift, end: c.end + shift + (rng() < 0.5 ? int(rng, 0, 400) : 0) }));
  return { embedded, captions, range };
}

function compare(name: string, make: (rng: Rng) => { embedded: Cue[]; captions: Cue[]; range?: number }, count: number, seed: number) {
  it(`${name}: ${count} windows`, () => {
    const rng = seeded(seed);
    let found = 0;
    let beyond = 0;
    for (let i = 0; i < count; i++) {
      const made = make(rng);
      const { embedded, captions } = made;
      const range = made.range ?? pick(rng, RANGES);
      const centre = made.range === undefined ? pick(rng, CENTRES) : 0;
      const want = referenceMeasureWindow(embedded, captions, range, centre);
      const got = measureWindow(embedded, captions, range, centre);
      // toEqual alone treats -0 and 0 as equal: Object.is on every number keeps them apart.
      expect(got, `${name} #${i}, range ${range}, centre ${centre}, ${embedded.length} lines, ${captions.length} captions`).toEqual(want);
      if (want) {
        found++;
        if (Math.abs(want.offset - centre) > range) beyond++;
        expect(Object.is(got!.offset, want.offset) && Object.is(got!.score, want.score)).toBe(true);
        want.alternatives.forEach((a, k) => expect(Object.is(got!.alternatives[k].offset, a.offset) && Object.is(got!.alternatives[k].score, a.score)).toBe(true));
      }
    }
    // Most kinds of window must produce fits, or the comparison proves little.
    if (name !== "tiny" && name !== "unsorted") expect(found).toBeGreaterThan(count / 4);
    // Fits refined past the end of the range must come up where they are built to.
    if (name === "edge") expect(beyond).toBeGreaterThan(count / 20);
  });
}

describe("measureWindow matches the reference", () => {
  compare("episode-shaped", episodeShaped, 1200, 1);
  compare("scattered", scattered, 600, 2);
  compare("periodic", periodic, 800, 3);
  compare("two fits", twoFits, 800, 4);
  compare("tiny", tiny, 2000, 5);
  compare("unsorted", unsorted, 400, 6);
  compare("far", far, 200, 7);
  compare("edge", edge, 800, 8);
});
