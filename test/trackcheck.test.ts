/**
 * The check of a file's own subtitle track against its voices (trackcheck.ts): where it listens, and
 * which of a subtitle's two timings it finds on the voices heard.
 */
import { describe, expect, it } from "vitest";
import { TRACK_CHECK, trackCheckSpots, voicesSay, type VoiceSpot } from "../src/trackcheck.js";

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
