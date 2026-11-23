/**
 * Whether a file's own subtitle track is on its voices.
 *
 * A translation is timed by the file's own subtitle track, which is right when the subtitle was made
 * for another cut of the title. A track that is itself off the audio (a release whose subtitles were
 * taken from another cut) moves a subtitle made for the playing release away from the voices, by the
 * same kind of steps. From the lines alone the two can't be told apart; the voices tell them apart.
 *
 * So when the track moves a subtitle made for the playing release by a second or more, a little of
 * the audio is heard where the two timings differ, and the subtitle's line starts are held against
 * where voices start, once as it came and once as timed by the track. The timing that meets the
 * voices clearly more often than chance, while the other doesn't, is the one served. What was heard
 * is kept with the file, so every other subtitle for it is judged by the same audio with nothing
 * more read.
 */
import type { Cue } from "./sync.js";

export const TRACK_CHECK = {
  /** A line the track moves less than this is where it was either way. */
  movedMs: 1000,
  /** Stretches of the file heard, and how long each is. */
  spots: 3,
  spanMs: 30_000,
  /** The most a file's check may read: its bit rate over the stretches heard. Heavier files hear two, or none. */
  maxBytes: 160e6,
  /** A line start this near a voice starting has met it. */
  meetMs: 150,
  /** A line shows about this long before its voice. */
  leadMs: 200,
  /** Lines moved by the track a stretch must hold, in both timings, to be worth hearing. */
  spotLines: 4,
  /** Line starts on a voice a timing needs before it counts as on the voices, and how far over chance. */
  minMet: 8,
  overChance: 2.5,
  /** And how many times the other timing's count. */
  overOther: 2
};

export interface VoiceSpot {
  from: number;
  to: number;
  speech: Cue[];
}

/** Where voices start in a stretch of speech: a stretch that follows another within a quarter second is the same voice. */
function onsets(speech: Cue[]): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (const c of [...speech].sort((a, b) => a.start - b.start)) {
    if (c.start - last >= 250) out.push(c.start);
    last = Math.max(last, c.end);
  }
  return out;
}

/**
 * Where to hear the file (file time, the start of each stretch): where the lines the track moves by
 * TRACK_CHECK.movedMs or more are thickest in both timings, the stretches kept apart so one scene
 * doesn't decide. Empty when fewer than two stretches hold enough of those lines.
 */
export function trackCheckSpots(came: number[], shift: (start: number) => number, duration: number, most = TRACK_CHECK.spots): number[] {
  const moved = came.map((start) => ({ came: start, served: start + shift(start) })).filter((l) => Math.abs(l.served - l.came) >= TRACK_CHECK.movedMs);
  if (moved.length < TRACK_CHECK.spotLines * 2) return [];
  const cameAt = moved.map((l) => l.came).sort((a, b) => a - b);
  const servedAt = moved.map((l) => l.served).sort((a, b) => a - b);
  const inside = (sorted: number[], from: number) => {
    let n = 0;
    for (const t of sorted) {
      if (t >= from + TRACK_CHECK.spanMs) break;
      if (t >= from) n++;
    }
    return n;
  };
  const latest = Math.max(0, duration - TRACK_CHECK.spanMs);
  const candidates = moved
    .flatMap((l) => [l.came - 1000, l.served - 1000])
    .filter((from) => from >= 0 && from <= latest)
    .map((from) => ({ from, both: Math.min(inside(cameAt, from), inside(servedAt, from)) }))
    .filter((c) => c.both >= TRACK_CHECK.spotLines)
    .sort((a, b) => b.both - a.both || a.from - b.from);
  const apart = Math.max(TRACK_CHECK.spanMs * 2, duration / 8);
  const picked: number[] = [];
  for (const c of candidates) {
    if (picked.length >= most) break;
    if (picked.every((from) => Math.abs(from - c.from) >= apart)) picked.push(c.from);
  }
  return picked.length >= 2 ? picked.sort((a, b) => a - b) : [];
}

export interface VoicesSaid {
  /** Which timing is on the voices; undefined when they don't say clearly. */
  verdict?: "as it came" | "the track";
  /** Line starts on a voice, and the lines counted, for each timing. */
  came: { met: number; lines: number };
  served: { met: number; lines: number };
  /** The share of lines that would meet a voice by chance, from how many voices were heard. */
  chance: number;
}

/**
 * Which of a subtitle's two timings is on the voices heard: as it came, or as the track times it.
 * Only the lines the track moves by TRACK_CHECK.movedMs or more are counted, in each timing, where
 * they fall inside a stretch heard. A timing is on the voices when at least TRACK_CHECK.minMet of
 * its line starts meet a voice, TRACK_CHECK.overChance times what chance gives, and
 * TRACK_CHECK.overOther times the other timing's count; a verdict needs one of them on the voices
 * and the other not.
 *
 * Calibration (one episode whose track is off its voices, 3 stretches of 30 s): the subtitle named for
 * the release met a voice with 14 of 39 lines as it came and 3 of 39 as timed by the track, where
 * chance gives 3 or 4; an official translation, 8 of 31 and 4 of 30; a subtitle for another cut, 3 of
 * 28 either way. Heard for 15 s a stretch, the first gave 6 of 18 and 2 of 19: too few to rest on.
 */
export function voicesSay(came: number[], shift: (start: number) => number, spots: VoiceSpot[]): VoicesSaid {
  const edge = 300;
  const heardMs = spots.reduce((n, s) => n + Math.max(0, s.to - s.from - 2 * edge), 0);
  const voices = spots.map((s) => onsets(s.speech).filter((v) => v >= s.from && v < s.to));
  const voiceCount = voices.reduce((n, v) => n + v.length, 0);
  const chance = heardMs > 0 ? Math.min(1, (voiceCount * 2 * TRACK_CHECK.meetMs) / heardMs) : 1;
  const tally = (starts: number[]) => {
    let met = 0;
    let lines = 0;
    for (const start of starts) {
      const at = start + TRACK_CHECK.leadMs;
      const i = spots.findIndex((s) => at >= s.from + edge && at <= s.to - edge);
      if (i < 0) continue;
      lines++;
      if (voices[i].some((v) => Math.abs(v - at) <= TRACK_CHECK.meetMs)) met++;
    }
    return { met, lines };
  };
  const moved = came.filter((start) => Math.abs(shift(start)) >= TRACK_CHECK.movedMs);
  const asCame = tally(moved);
  const asServed = tally(moved.map((start) => start + shift(start)));
  const clear = (mine: { met: number; lines: number }, other: { met: number }) =>
    mine.met >= TRACK_CHECK.minMet && mine.met >= TRACK_CHECK.overChance * chance * mine.lines && mine.met >= TRACK_CHECK.overOther * other.met;
  const cameClear = clear(asCame, asServed);
  const servedClear = clear(asServed, asCame);
  const verdict = cameClear && !servedClear ? ("as it came" as const) : servedClear && !cameClear ? ("the track" as const) : undefined;
  return { ...(verdict ? { verdict } : {}), came: asCame, served: asServed, chance };
}
