import { describe, expect, it } from "vitest";
import { type Cue, type FileAnchors, RATE_FACTORS, judge, retime, scaleCues } from "../src/sync.js";
import { FILM, episode, faithful, indexFile, madeForRate, retimedByOthers, stepped } from "./synthetic.js";

/** Lines of uneven length and spacing, the way dialogue comes (deterministic, no randomness). */
function lines(from: number, to: number, seed: number): Cue[] {
  const cues: Cue[] = [];
  let at = from;
  let n = seed;
  while (at < to) {
    n = (n * 1103515245 + 12345) % 2147483648;
    const length = 900 + (n % 2600);
    const gap = 300 + ((n >> 8) % 2200);
    cues.push({ start: at, end: at + length });
    at += length + gap;
  }
  return cues;
}

const SPOTS = [0.15, 0.32, 0.5, 0.68, 0.85];
const DURATION = 1_420_000;

/** The file's own subtitle track, read at the usual five spots. */
function fileWith(track: Cue[]): FileAnchors {
  return {
    duration: DURATION,
    windows: SPOTS.map((spot) => {
      const from = Math.round(DURATION * spot);
      return { from, to: from + 40000, cues: track.filter((c) => c.start >= from && c.end <= from + 40000) };
    })
  };
}

const PAL_ON_FILM = 25 / (24000 / 1001);
const written = lines(0, 1_360_000, 7);

describe("subtitles made for another frame rate", () => {
  it("rescales a 25 fps subtitle on a 23.976 fps file and syncs it", () => {
    // As played, every line lands 4.3% later than written, plus 0.6 s.
    const track = written.map((c) => ({ start: Math.round(c.start * PAL_ON_FILM) + 600, end: Math.round(c.end * PAL_ON_FILM) + 600 }));
    const verdict = judge(fileWith(track), written);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeCloseTo(PAL_ON_FILM, 6);
    expect(verdict.anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of verdict.anchors) expect(Math.abs(anchor.offset - 600)).toBeLessThanOrEqual(60);
  });

  it("rescales the slow drift of 24 against 23.976 fps", () => {
    const factor = 24 / (24000 / 1001);
    const track = written.map((c) => ({ start: Math.round(c.start * factor) - 300, end: Math.round(c.end * factor) - 300 }));
    const verdict = judge(fileWith(track), written);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeCloseTo(factor, 6);
  });

  it("leaves captions alone when they already fit at one shift", () => {
    const track = written.map((c) => ({ start: c.start + 1200, end: c.end + 1200 }));
    const verdict = judge(fileWith(track), written);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeUndefined();
  });

  it("keeps a real step as a step, not a drift", () => {
    // A cut halfway: +0.4 s before it, +3.4 s after.
    const track = written.map((c) => {
      const d = c.start < 700_000 ? 400 : 3400;
      return { start: c.start + d, end: c.end + d };
    });
    expect(judge(fileWith(track), written).factor).toBeUndefined();
  });

  it("finds no rate for another episode's captions", () => {
    const track = lines(0, 1_360_000, 4242);
    const verdict = judge(fileWith(track), written);
    expect(verdict.factor).toBeUndefined();
    expect(verdict.verdict).not.toBe("synced");
  });

  it("rescales a long film's subtitle made from a transfer a touch off its rate, where the timing creeps", () => {
    const film = episode(211, { minutes: 100 });
    // Another transcription of the dialogue (lines split and joined otherwise, a beat off), written for
    // 23.976 fps from a transfer 0.012% off it: rescaled, it creeps 0.7 s over the film.
    const sub = madeForRate(retimedByOthers(faithful(film.lines), 212, { jitter: 300, merge: 0.25, split: 0.25 }), (FILM / 25) * 1.00012, -400);
    const verdict = judge(indexFile(film.duration, [film.lines]), sub);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeCloseTo(FILM / 25, 6);
    const offsets = verdict.anchors.map((a) => a.offset);
    // Further apart than one shift allows, and nowhere near the next rate's drift (5 s over this film).
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeGreaterThan(500);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(2500);
    expect(verdict.anchors.length).toBeGreaterThan(60);
  });

  it("rescales a subtitle made for another rate from another cut, whose rescaled lines sit in stretches", () => {
    const show = episode(215, { minutes: 42 });
    // Later after each of two breaks, and written for 25 fps: as written it fits nothing.
    const sub = madeForRate(stepped(faithful(show.lines), [14 * 60_000, 29 * 60_000], [-2100, -4500, -6300]), 25 / FILM);
    const verdict = judge(indexFile(show.duration, [show.lines]), sub);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.factor).toBeCloseTo(25 / FILM, 6);
    const offsets = verdict.anchors.map((a) => a.offset);
    for (const shift of [2100, 4500, 6300]) expect(offsets.filter((o) => Math.abs(o - shift) <= 200).length).toBeGreaterThan(5);
  });

  it("finds no rate for another film's captions on a long file", () => {
    const film = episode(213, { minutes: 100 });
    const other = madeForRate(faithful(episode(214, { minutes: 100 }).lines), FILM / 25);
    const verdict = judge(indexFile(film.duration, [film.lines]), other);
    expect(verdict.factor).toBeUndefined();
    expect(verdict.verdict).not.toBe("synced");
  });

  it("rescales the written times before shifting them", () => {
    const srt = "1\n00:10:00,000 --> 00:10:02,000\nhi\n";
    expect(retime(srt, ".srt", () => 600, PAL_ON_FILM)).toBe("1\n00:10:26,225 --> 00:10:28,310\nhi\n");
    const ass = "Dialogue: 0,0:10:00.00,0:10:02.00,Default,,0,0,0,,Hi\n";
    expect(retime(ass, ".ass", () => 0, PAL_ON_FILM)).toBe("Dialogue: 0,0:10:25.63,0:10:27.71,Default,,0,0,0,,Hi\n");
    expect(scaleCues([{ start: 1000, end: 2000 }], 2)).toEqual([{ start: 2000, end: 4000 }]);
    expect(RATE_FACTORS).toHaveLength(6);
  });

  it("keeps a styled line's own moments where they fall in it: karaoke, changes, moves and fades scale with the line", () => {
    const line = (tags: string) => `Dialogue: 0,0:00:10.00,0:00:14.00,Song,,0,0,0,,${tags}\n`;
    const out = (tags: string, factor: number) => retime(line(tags), ".ass", () => 0, factor).split(",,0,0,0,,")[1].trimEnd();
    // Twice as long: every moment at twice its time; a fade in and out, lengths at the line's ends, stays.
    expect(out("{\\k50}la{\\kf100}li{\\ko25\\K25}lu", 2)).toBe("{\\k100}la{\\kf200}li{\\ko50\\K50}lu");
    expect(out("{\\t(0,500,\\fs40)\\t(1000,2000,2,\\fscx120)\\t(\\blur3)\\t(2,\\bord4)}x", 2)).toBe("{\\t(0,1000,\\fs40)\\t(2000,4000,2,\\fscx120)\\t(\\blur3)\\t(2,\\bord4)}x");
    expect(out("{\\move(10,20,30,40,100,900)\\move(1,2,3,4)\\fade(255,0,255,0,200,3800,4000)\\fad(150,300)\\pos(100,200)}x", 2)).toBe(
      "{\\move(10,20,30,40,200,1800)\\move(1,2,3,4)\\fade(255,0,255,0,400,7600,8000)\\fad(150,300)\\pos(100,200)}x"
    );
    // Syllables are summed before rounding: a hundred of 33 hundredths end where the line does.
    const sung = [...out(`{${"\\k33".repeat(100)}}x`, 25 / 24).matchAll(/\\k(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(sung).toBe(Math.round((3300 * 25) / 24));
    // Text that only looks like tags, outside the braces, stays; so does everything at no change of rate.
    expect(out("\\k50 as written{\\k50}la", 2)).toBe("\\k50 as written{\\k100}la");
    expect(out("{\\k50\\t(0,500,\\fs40)}la", 1)).toBe("{\\k50\\t(0,500,\\fs40)}la");
  });
});
