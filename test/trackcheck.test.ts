/**
 * The check of a file's own subtitle track against its voices (trackcheck.ts): where it listens, and
 * which of a subtitle's two timings it finds on the voices heard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRACK_CHECK, trackCheckSpots, trackOffVoices, voicesSay, type VoiceSpot } from "../src/trackcheck.js";
import { openBench, type Bench } from "./serve.js";
import { episode, faithful, heard, indexFile, retimedByOthers } from "./synthetic.js";

/** The same numbers every run. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

const DURATION = 40 * 60 * 1000;

/** A film's voices: one starting every 1.5 to 4.5 s, each lasting 0.8 to 2 s. */
function voicesOf(seed: number): Array<{ start: number; end: number }> {
  const next = seeded(seed);
  const out: Array<{ start: number; end: number }> = [];
  for (let t = 20_000; t < DURATION - 20_000; t += 1500 + Math.round(next() * 3000)) out.push({ start: t, end: t + 800 + Math.round(next() * 1200) });
  return out;
}

/** Subtitle lines for those voices: four in five of them, each shown a little before its voice. */
function linesFor(voices: Array<{ start: number }>, seed: number): number[] {
  const next = seeded(seed);
  return voices.filter(() => next() < 0.8).map((v) => v.start - TRACK_CHECK.leadMs + Math.round((next() - 0.5) * 120));
}

/** What a read of the audio hears at those stretches. */
const heardAt = (voices: Array<{ start: number; end: number }>, froms: number[]): VoiceSpot[] =>
  froms.map((from) => ({ from, to: from + TRACK_CHECK.spanMs, speech: voices.filter((v) => v.start >= from && v.end <= from + TRACK_CHECK.spanMs) }));

/** A track that sits further from the audio after each of its breaks. */
const stepped = (start: number) => (start < 8 * 60_000 ? -800 : start < 16 * 60_000 ? -3000 : start < 26 * 60_000 ? -5500 : -7300);

describe("where a track check listens", () => {
  it("picks up to three stretches, apart from each other, where the moved lines are thick in both timings", () => {
    const came = linesFor(voicesOf(7), 8);
    const froms = trackCheckSpots(came, stepped, DURATION);
    expect(froms).toHaveLength(3);
    for (let i = 1; i < froms.length; i++) expect(froms[i] - froms[i - 1]).toBeGreaterThanOrEqual(DURATION / 8);
    for (const from of froms) {
      expect(from).toBeGreaterThanOrEqual(0);
      expect(from + TRACK_CHECK.spanMs).toBeLessThanOrEqual(DURATION);
      // Only where the track moves the lines a second or more.
      expect(Math.abs(stepped(from + TRACK_CHECK.spanMs / 2))).toBeGreaterThanOrEqual(TRACK_CHECK.movedMs);
    }
  });

  it("listens nowhere for a subtitle the track leaves about where it was", () => {
    const came = linesFor(voicesOf(7), 8);
    expect(trackCheckSpots(came, () => 240, DURATION)).toEqual([]);
    expect(trackCheckSpots(came, (start) => (start < 60_000 ? -3000 : 0), DURATION)).toEqual([]);
  });
});

describe("which timing is on the voices", () => {
  const voices = voicesOf(11);

  it("is the subtitle as it came, when its own timing meets the voices and the track's doesn't", () => {
    const came = linesFor(voices, 12);
    const said = voicesSay(came, stepped, heardAt(voices, trackCheckSpots(came, stepped, DURATION)));
    expect(said.verdict).toBe("as it came");
    expect(said.came.met).toBeGreaterThan(said.came.lines * 0.7);
    expect(said.served.met).toBeLessThan(said.served.lines * 0.4);
  });

  it("is the track's, for a subtitle made for another cut", () => {
    // The lines as they came are off the voices by what the track then takes back.
    const came = linesFor(voices, 12).map((onVoice) => onVoice - stepped(onVoice));
    const shift = (start: number) => {
      let at = start;
      for (let i = 0; i < 4; i++) at = start + stepped(at);
      return at - start;
    };
    const said = voicesSay(came, shift, heardAt(voices, trackCheckSpots(came, shift, DURATION)));
    expect(said.verdict).toBe("the track");
  });

  it("is neither's, when neither timing meets the voices or too little was heard", () => {
    const elsewhere = linesFor(voicesOf(99), 12);
    const spots = heardAt(voices, trackCheckSpots(elsewhere, stepped, DURATION));
    expect(voicesSay(elsewhere, stepped, spots).verdict).toBeUndefined();
    const came = linesFor(voices, 12);
    const froms = trackCheckSpots(came, stepped, DURATION);
    // A song over the scene: one voice heard in each stretch.
    const quiet = froms.map((from) => ({ from, to: from + TRACK_CHECK.spanMs, speech: voices.filter((v) => v.start >= from).slice(0, 1) }));
    expect(voicesSay(came, stepped, quiet).verdict).toBeUndefined();
    expect(voicesSay(came, stepped, []).verdict).toBeUndefined();
  });

  it("counts only the lines the track moves a second or more", () => {
    const came = linesFor(voices, 12);
    const early = (start: number) => (start < 20 * 60_000 ? 0 : -4000);
    const spots = heardAt(voices, [5 * 60_000, 25 * 60_000]);
    const said = voicesSay(came, early, spots);
    const second = came.filter((s) => s + TRACK_CHECK.leadMs >= 25 * 60_000 + 300 && s + TRACK_CHECK.leadMs <= 25 * 60_000 + TRACK_CHECK.spanMs - 300).length;
    expect(said.came.lines).toBe(second);
  });
});

describe("whether the voices put the file's own track off them", () => {
  const voices = voicesOf(21);
  // Five stretches heard, as when speech times a subtitle that fits nothing in the track.
  const spots = heardAt(voices, [0.15, 0.32, 0.5, 0.68, 0.85].map((share) => Math.round(DURATION * share)));
  // A track taken from another cut: further from the audio after each break, by seconds.
  const fromAnotherCut = (start: number) => (start < 6 * 60_000 ? -1500 : start < 15 * 60_000 ? -3300 : start < 24 * 60_000 ? -5500 : -7500);
  const placed = linesFor(voices, 22);

  it("is off, when its lines land where voices fall at random and the subtitle's land on them", () => {
    const track = linesFor(voices, 23).map((start) => start + fromAnotherCut(start));
    const said = trackOffVoices(placed, track, spots);
    expect(said.off).toBe(true);
    expect(said.track.lines).toBeGreaterThanOrEqual(TRACK_CHECK.trackLines);
    expect(said.track.met).toBeLessThanOrEqual(said.chance * said.track.lines);
    expect(said.subtitle.met).toBeGreaterThan(said.subtitle.lines * 0.7);
  });

  it("is on, for a track made for the audio heard", () => {
    expect(trackOffVoices(placed, linesFor(voices, 23), spots).off).toBe(false);
  });

  it("is on, for a track timed to another language's audio while a dub's voices are heard", () => {
    // Each dub line starts up to 0.6 s from where the original's does, either way.
    const next = seeded(24);
    const original = linesFor(voices, 23).map((start) => start + Math.round((next() - 0.5) * 1200));
    const said = trackOffVoices(placed, original, spots);
    expect(said.track.met).toBeGreaterThan(said.chance * said.track.lines);
    expect(said.off).toBe(false);
  });

  it("says nothing on too few of the track's lines, or when the subtitle isn't on the voices either", () => {
    const track = linesFor(voices, 23).map((start) => start + fromAnotherCut(start));
    const one = heardAt(voices, [Math.round(DURATION * 0.5)]).map((s) => ({ ...s, to: s.from + 20_000 }));
    expect(trackOffVoices(placed, track, one).track.lines).toBeLessThan(TRACK_CHECK.trackLines);
    expect(trackOffVoices(placed, track, one).off).toBe(false);
    expect(trackOffVoices(linesFor(voicesOf(99), 22), track, spots).off).toBe(false);
    expect(trackOffVoices(placed, track, []).off).toBe(false);
  });
});

describe("a subtitle timed by speech on a file whose own track is off the voices, in a play", () => {
  let bench: Bench;

  beforeAll(async () => {
    bench = await openBench(".cache-trackoff-test");
  });

  afterAll(async () => {
    await bench?.close();
  });

  it("keeps the timing the voices give it: the track's lines neither refine nor snap it", async () => {
    const outcome = await bench.serve({
      name: "track-off-voices",
      about: "a release whose own subtitles were taken from another cut, off its audio by a different amount every minute",
      file: "index",
      lang: "English",
      today: { synced: true, floor: { "0.3": 0, "0.1": 0 } },
      build: () => {
        const ep = episode(131, { minutes: 42 });
        // Seconds off, by another amount each minute: no shift, nor a shift per stretch, fits the subtitle to it.
        const offBy = [-3300, -5500, -4200, -7500, -3600, -6400, -4900, -6900];
        // Its lines split and joined otherwise than the subtitle's, as another cut's subtitles are.
        const track = retimedByOthers(faithful(ep.lines), 133, { merge: 0.3, split: 0.3 }).map((c) => {
          const by = offBy[Math.floor(c.start / 60_000) % offBy.length];
          return { start: c.start + by, end: c.end + by };
        });
        return { record: indexFile(ep.duration, [track], heard(ep.lines, 132)), subtitle: faithful(ep.lines) };
      }
    });
    expect(outcome.method).toBe("speech");
    expect(outcome.log.some((line) => /the track is off the voices, not followed/.test(line))).toBe(true);
    expect(outcome.log.some((line) => /snapped|met by the file's own lines/.test(line))).toBe(false);
    expect(outcome.within!["0.1"]).toBe(1);
  });
});
