/**
 * speechCurve (src/sync.ts) against a plain reference: the same curve, to the last count, on generated
 * windows of speech. The reference counts every caption start inside the window at each shift;
 * speechCurve stops counting at 3, the only count the curve reads.
 */
import { describe, expect, it } from "vitest";
import { speechCurve, type Cue } from "../src/sync.js";

// ---------- reference ----------

const ONSET_LEAD_MS = 200;
const ONSET_PAUSE_MS = 250;
const ONSET_TOLERANCE_MS = 200;
const SPEECH_STEP_MS = 20;

function onsets(cues: Cue[], pause: number): number[] {
  const out: number[] = [];
  let lastEnd = -Infinity;
  for (const c of cues) {
    if (c.start - lastEnd >= pause) out.push(c.start);
    lastEnd = Math.max(lastEnd, c.end);
  }
  return out;
}

function matchedOnsets(a: number[], b: number[], shift: number, tolerance: number): number {
  // A line usually shows a little before the voice starts: it may lead by ONSET_LEAD_MS, trail by less.
  const lead = ONSET_LEAD_MS;
  const lag = tolerance;
  let matched = 0;
  let j = 0;
  for (const x of a) {
    while (j < b.length && b[j] + shift < x - lead) j++;
    if (j < b.length && b[j] + shift <= x + lag) matched++;
  }
  return matched;
}

function referenceSpeechCurve(speech: Cue[], captions: Cue[], range = 20000): { matched: number[]; heard: number } | undefined {
  const heard = onsets(speech, ONSET_PAUSE_MS);
  if (heard.length < 4) return undefined;
  const from = heard[0] - range - 1000;
  const to = heard[heard.length - 1] + range + 1000;
  // Every line start counts: streaming subtitles run line into line with 80 ms between, inside one
  // stretch of speech. Each start of speech should meet one of them.
  const said = captions.filter((c) => c.end >= from && c.start <= to).map((c) => c.start);
  if (said.length < 4) return undefined;
  const windowStart = heard[0];
  const windowEnd = speech[speech.length - 1].end;
  const matched: number[] = [];
  for (let shift = -range; shift <= range; shift += SPEECH_STEP_MS) {
    const inside = said.filter((x) => x + shift >= windowStart - ONSET_TOLERANCE_MS && x + shift <= windowEnd + ONSET_TOLERANCE_MS).length;
    matched.push(inside < 3 ? 0 : matchedOnsets(heard, said, shift, ONSET_TOLERANCE_MS));
  }
  return { matched, heard: heard.length };
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

/** A time in ms: whole, to the frame, or any fraction. */
function time(rng: Rng, ms: number, kind: number): number {
  if (kind === 0) return Math.round(ms);
  if (kind === 1) return Math.round(ms / 41.708333) * 41.708333;
  return ms + rng() * 0.999;
}

/** Speech heard in one window of the audio, and the subtitle's lines for the whole file, out by some shift. */
function heardWindow(rng: Rng): { speech: Cue[]; captions: Cue[] } {
  const kind = int(rng, 0, 2);
  const speech: Cue[] = [];
  let at = int(rng, 0, 600000);
  for (let n = int(rng, 0, 30); n > 0; n--) {
    const start = time(rng, at, kind);
    speech.push({ start, end: time(rng, at + int(rng, 100, 4000), kind) });
    at += int(rng, -500, 5000);
  }
  speech.sort(byStart);
  const shift = int(rng, -25000, 25000) + (kind === 2 ? rng() : 0);
  const captions: Cue[] = speech.filter(() => rng() < 0.8).map((c) => ({ start: c.start + shift + int(rng, -150, 150), end: c.end + shift }));
  for (let n = int(rng, 0, 150); n > 0; n--) {
    const start = time(rng, rng() * 800000, kind);
    captions.push({ start, end: start + int(rng, 300, 4000) });
  }
  if (rng() < 0.8) captions.sort(byStart);
  return { speech, captions };
}

/** A few caption starts near the window's edges: the count inside sits at 2, 3 or 4 as the shift moves. */
function edges(rng: Rng): { speech: Cue[]; captions: Cue[] } {
  const kind = int(rng, 0, 2);
  const speech = Array.from({ length: int(rng, 4, 8) }, (_, n) => ({ start: time(rng, 100000 + n * 1000, kind), end: time(rng, 100000 + n * 1000 + 600, kind) }));
  const end = speech[speech.length - 1].end;
  const captions = Array.from({ length: int(rng, 4, 6) }, () => {
    const start = pick(rng, [100000, end]) + int(rng, -25000, 25000) + (kind === 2 ? rng() : 0);
    return { start, end: start + 500 };
  });
  return { speech, captions: captions.sort(byStart) };
}

/**
 * Exactly 3 caption starts inside the window at one shift, one of them on the window's edge (moved
 * back by the shift, it lands on the start less ONSET_TOLERANCE_MS, or the end plus it): whether the
 * edge counts decides between a count and 0.
 */
function boundary(rng: Rng): { speech: Cue[]; captions: Cue[] } {
  const speech = Array.from({ length: int(rng, 4, 8) }, (_, n) => ({ start: 100000 + n * 1000, end: 100000 + n * 1000 + 600 }));
  const end = speech[speech.length - 1].end;
  const shift = -20000 + 20 * int(rng, 0, 2000);
  const edge = rng() < 0.5 ? 100000 - ONSET_TOLERANCE_MS : end + ONSET_TOLERANCE_MS;
  // Two more starts near enough to be read, outside the window at this shift.
  const starts = [edge - shift, speech[1].start - shift, speech[2].start - shift, 100000 - 20500, speech[speech.length - 1].start + 20500];
  return { speech, captions: starts.map((start) => ({ start, end: start + 400 })).sort(byStart) };
}

/** Next to nothing, out of order, or extreme. */
function odd(rng: Rng): { speech: Cue[]; captions: Cue[] } {
  const { speech, captions } = heardWindow(rng);
  const kind = int(rng, 0, 3);
  if (kind === 0) return { speech: speech.slice(0, int(rng, 0, 5)), captions: captions.slice(0, int(rng, 0, 5)) };
  if (kind === 1) return { speech: [...speech].reverse(), captions: [...captions].reverse() };
  if (kind === 2) return { speech, captions: captions.map((c) => (rng() < 0.05 ? { start: NaN, end: c.end } : rng() < 0.05 ? { start: -c.start, end: -c.end } : c)) };
  return { speech: speech.map((c) => ({ start: c.start + 2 ** 45, end: c.end + 2 ** 45 })), captions: captions.map((c) => ({ start: c.start + 2 ** 45, end: c.end + 2 ** 45 })) };
}

const RANGES = [20000, 20000, 3000, 7777.5, 0, 45];

function compare(name: string, make: (rng: Rng) => { speech: Cue[]; captions: Cue[] }, count: number, seed: number) {
  it(`${name}: ${count} windows`, () => {
    const rng = seeded(seed);
    let curves = 0;
    let gated = 0;
    for (let i = 0; i < count; i++) {
      const { speech, captions } = make(rng);
      // The edge cases are built on the shifts of a ±20 s search.
      const range = name === "boundary" ? 20000 : pick(rng, RANGES);
      const want = referenceSpeechCurve(speech, captions, range);
      const got = speechCurve(speech, captions, range);
      expect(got, `${name} #${i}, range ${range}, ${speech.length} cues, ${captions.length} captions`).toEqual(want);
      if (want) {
        curves++;
        want.matched.forEach((m, k) => expect(Object.is(got!.matched[k], m)).toBe(true));
        expect(Object.is(got!.heard, want.heard)).toBe(true);
        // Shifts with matches next to shifts held at 0: the count of 3 decides somewhere on this curve.
        if (want.matched.some((m) => m > 0) && want.matched.some((m) => m === 0)) gated++;
      }
    }
    if (name !== "odd") {
      expect(curves).toBeGreaterThan(count / 4);
      expect(gated).toBeGreaterThan(count / 20);
    }
  });
}

describe("speechCurve matches the reference", () => {
  compare("heard windows", heardWindow, 800, 1);
  compare("edges", edges, 600, 2);
  compare("odd", odd, 400, 3);
  compare("boundary", boundary, 300, 4);
});
