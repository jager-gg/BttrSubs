/**
 * windowPeaks (src/sync.ts), the peaks farStretches chooses shifts from, against a plain reference: the
 * same steps in the same order on generated curves. The reference sorts every step of the curve by its
 * count; windowPeaks must take the same steps.
 */
import { describe, expect, it } from "vitest";
import { windowPeaks } from "../src/sync.js";

// ---------- reference ----------

const STRETCH_PEAKS = 3;
const STRETCH_PEAK_LINES = 3;

function referencePeaks(curve: Int32Array, earliest: number, apart: number): number[] {
  const own: number[] = [];
  const order = Array.from(curve.keys()).filter((k) => k >= earliest).sort((x, y) => curve[y] - curve[x]);
  for (const k of order) {
    if (own.length >= STRETCH_PEAKS || curve[k] < STRETCH_PEAK_LINES) break;
    if (own.every((o) => Math.abs(k - o) > apart)) own.push(k);
  }
  return own;
}

// ---------- generated curves ----------

/** A seeded generator, so every run draws the same curves. */
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

/** As startCurve draws one: each line start met adds 1 over a plateau of 41 steps, so counts tie in runs. */
function startShaped(rng: Rng, length: number): Int32Array {
  const curve = new Int32Array(length);
  const lines = int(rng, 0, 40);
  const real = int(rng, 0, length - 1);
  for (let n = 0; n < lines; n++) {
    // Most lines meet a start at the true shift; every line meets a few by chance elsewhere.
    const at = [rng() < 0.6 ? real + int(rng, -2, 2) : int(rng, 0, length - 1)];
    for (let c = int(rng, 0, 12); c > 0; c--) at.push(int(rng, 0, length - 1));
    const seen = new Set<number>();
    for (const centre of at) for (let i = Math.max(0, centre - 20); i <= Math.min(length - 1, centre + 20); i++) seen.add(i);
    for (const i of seen) curve[i]++;
  }
  return curve;
}

/** Anything: small counts, all equal, zeros, negatives, the extremes of an Int32Array. */
function anyCurve(rng: Rng, length: number): Int32Array {
  const kind = int(rng, 0, 4);
  const curve = new Int32Array(length);
  for (let i = 0; i < length; i++) {
    if (kind === 0) curve[i] = int(rng, 0, 6);
    else if (kind === 1) curve[i] = 4;
    else if (kind === 2) curve[i] = rng() < 0.02 ? int(rng, 3, 5) : 0;
    else if (kind === 3) curve[i] = int(rng, -5, 8);
    else curve[i] = pick(rng, [2147483647, -2147483648, 3, 2, 1_000_000, 0]);
  }
  return curve;
}

function compare(name: string, make: (rng: Rng) => Int32Array, count: number, seed: number) {
  it(`${name}: ${count} curves`, () => {
    const rng = seeded(seed);
    let taken = 0;
    for (let i = 0; i < count; i++) {
      const curve = make(rng);
      const earliest = pick(rng, [Math.round(curve.length * 0.46), 0, 0, -5, 3.5, curve.length - 1, curve.length, curve.length + 10, NaN, -Infinity, Infinity]);
      const apart = pick(rng, [50, 50, 0, -1, 2.5, 20, 100000, NaN]);
      const want = referencePeaks(curve, earliest, apart);
      const got = windowPeaks(curve, earliest, apart);
      expect(got, `${name} #${i}, length ${curve.length}, earliest ${earliest}, apart ${apart}`).toEqual(want);
      got.forEach((k, n) => expect(Object.is(k, want[n])).toBe(true));
      if (want.length > 1) taken++;
    }
    // Enough curves must give two peaks or more, or the order of the steps is hardly compared.
    if (name !== "empty") expect(taken).toBeGreaterThan(count / 5);
  });
}

describe("windowPeaks matches the reference", () => {
  // The length farStretches gives: ±120 s in 20 ms steps.
  compare("start-shaped, full length", (rng) => startShaped(rng, 12001), 400, 1);
  compare("start-shaped, short", (rng) => startShaped(rng, int(rng, 1, 800)), 3000, 2);
  compare("any counts", (rng) => anyCurve(rng, int(rng, 0, 400)), 3000, 3);
  compare("empty", () => new Int32Array(0), 1, 4);
});
