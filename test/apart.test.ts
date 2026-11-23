/**
 * Lines kept from running into the next one once retimed (endsApart): a line that didn't overlap the
 * next as written ends where the next begins.
 */
import { describe, expect, it } from "vitest";
import { APART_MIN_SHOWN_MS, endsApart, parseCues, retime } from "../src/sync.js";

const SRT = [
  "1\n00:00:10,000 --> 00:00:13,000\nFirst line.",
  "2\n00:00:13,200 --> 00:00:15,000\nSecond line.",
  "3\n00:00:20,000 --> 00:00:22,000\nThird line.",
  "4\n00:00:21,000 --> 00:00:23,000\nSpoken over the third.",
  "5\n00:00:30,000 --> 00:00:32,000\nFifth line.",
  "6\n00:00:32,100 --> 00:00:34,000\nSixth line."
].join("\n\n");

const timesOf = (text: string) => parseCues(text, ".srt").map((c) => [c.start, c.end]);

describe("lines kept apart once retimed", () => {
  it("ends a line where the next begins, when a step moves the next one earlier", () => {
    // From the second line on, everything is moved 1.5 s earlier than the first.
    const shift = (start: number) => (start < 13_000 ? 0 : -1500);
    const plain = timesOf(retime(SRT, ".srt", shift));
    expect(plain[0]).toEqual([10_000, 13_000]);
    expect(plain[1][0]).toBe(11_700);
    const apart = timesOf(retime(SRT, ".srt", shift, 1, endsApart(parseCues(SRT, ".srt"), shift)));
    expect(apart[0]).toEqual([10_000, 11_700]);
    // Every start is where the timing put it, and the other lines keep their ends.
    expect(apart.map((c) => c[0])).toEqual(plain.map((c) => c[0]));
    expect(apart.slice(1)).toEqual(plain.slice(1));
  });

  it("leaves lines that overlap as written overlapping", () => {
    const shift = () => 400;
    const out = timesOf(retime(SRT, ".srt", shift, 1, endsApart(parseCues(SRT, ".srt"), shift)));
    expect(out[2]).toEqual([20_400, 22_400]);
    expect(out[3]).toEqual([21_400, 23_400]);
  });

  it("doesn't cut a line to under half a second: there the two stay together", () => {
    // The sixth line is moved to 0.2 s after the fifth begins.
    const shift = (start: number) => (start < 32_000 ? 0 : -1900);
    const out = timesOf(retime(SRT, ".srt", shift, 1, endsApart(parseCues(SRT, ".srt"), shift)));
    expect(out[5][0]).toBe(30_200);
    expect(out[5][0] - out[4][0]).toBeLessThan(APART_MIN_SHOWN_MS);
    expect(out[4]).toEqual([30_000, 32_000]);
  });

  it("moves nothing when no line runs into the next", () => {
    const shift = () => -2750;
    expect(retime(SRT, ".srt", shift, 1, endsApart(parseCues(SRT, ".srt"), shift))).toBe(retime(SRT, ".srt", shift));
  });

  it("starts from the ends another step already gave the lines", () => {
    const shift = (start: number) => (start < 13_000 ? 0 : -1500);
    // The first line was given a later end; it still ends where the second begins.
    const given = (start: number, end: number) => (start === 10_000 ? 14_000 : end + shift(start));
    const out = timesOf(retime(SRT, ".srt", shift, 1, endsApart(parseCues(SRT, ".srt"), shift, given)));
    expect(out[0]).toEqual([10_000, 11_700]);
    expect(out[4]).toEqual([28_500, 30_500]);
  });
});

describe("a step that moves the lines after it earlier", () => {
  // Lines of 2 s with 0.3 s between them for ten minutes, and one break of 6 s after five.
  const captions: Array<{ start: number; end: number }> = [];
  for (let t = 0; t < 600_000; t += captions.length === 130 ? 8000 : 2300) captions.push({ start: t, end: t + 2000 });
  const pause = captions.findIndex((c, k) => k > 0 && c.start - captions[k - 1].end > 5000);
  const before = { from: 180_000, to: 240_000, offset: 2000, score: 0.9 };
  const after = { from: 420_000, to: 480_000, offset: -1500, score: 0.9 };
  const inThePause = (at: number) => at > captions[pause - 1].end && at < captions[pause].start;

  it("sits in the one pause long enough for it, where the file's lines fit either shift alike", async () => {
    const { placeStep } = await import("../src/sync.js");
    // One line of the file over the whole span: covered the same at both shifts.
    const reference = [{ start: 180_000, end: 480_000 }];
    expect(inThePause(placeStep(before, after, captions, reference))).toBe(true);
    // Moved later instead, any pause will do: the lines after it only get further away.
    const later = placeStep({ ...before, offset: -1500 }, { ...after, offset: 2000 }, captions, reference);
    expect(Number.isFinite(later)).toBe(true);
  });

  it("sits there by line starts too", async () => {
    const { stepByStarts } = await import("../src/sync.js");
    const starts = captions.map((c) => c.start);
    expect(inThePause(stepByStarts(before, after, captions, [], starts))).toBe(true);
  });

  it("takes any pause when none has the room", async () => {
    const { placeStep } = await import("../src/sync.js");
    const tight = captions.filter((_, k) => k < pause).concat(captions.slice(pause).map((c) => ({ start: c.start - 5700, end: c.end - 5700 })));
    const at = placeStep(before, after, tight, [{ start: 180_000, end: 480_000 }]);
    expect(at).toBeGreaterThan(before.from - before.offset);
    expect(at).toBeLessThan(after.to - after.offset);
  });
});

describe("where a dub's voices are heard", () => {
  const DURATION = 24 * 60_000;
  const SPAN = 40_000;
  const window = (minute: number, offset: number) => ({ from: minute * 60_000, to: (minute + 1) * 60_000, offset, score: 0.9 });

  it("is the usual five spots while the timing is one stretch", async () => {
    const { voiceSpots } = await import("../src/sync.js");
    const one = Array.from({ length: 24 }, (_, m) => window(m, 300 + (m % 3) * 40));
    expect(voiceSpots(one, DURATION, SPAN)).toEqual([0.15, 0.32, 0.5, 0.68, 0.85].map((s) => Math.round(DURATION * s)));
    expect(voiceSpots([], DURATION, SPAN)).toHaveLength(5);
  });

  it("is in every stretch where the timing steps, two in the long ones, and no more spots than usual", async () => {
    const { voiceSpots } = await import("../src/sync.js");
    // Two minutes, then twelve, then nine: three stretches, each a shift of its own.
    const stepped = [window(0, 800), window(1, 800), ...Array.from({ length: 12 }, (_, i) => window(2 + i, 2100)), ...Array.from({ length: 9 }, (_, i) => window(15 + i, -1500))];
    const spots = voiceSpots(stepped, DURATION, SPAN);
    expect(spots).toHaveLength(5);
    const inside = (from: number, to: number) => spots.filter((s) => s >= from * 60_000 && s + SPAN <= to * 60_000).length;
    expect([inside(0, 2), inside(2, 14), inside(15, 24)]).toEqual([1, 2, 2]);
  });

  it("hears the five longest stretches when there are more than five", async () => {
    const { voiceSpots } = await import("../src/sync.js");
    const many = [0, 1, 2, 3, 4, 5, 6].flatMap((k) => Array.from({ length: k === 6 ? 1 : 3 }, (_, i) => window(k * 3 + i, k * 1000)));
    const spots = voiceSpots(many, DURATION, SPAN);
    expect(spots).toHaveLength(5);
    expect(spots.some((s) => s >= 18 * 60_000)).toBe(false);
  });
});
