/**
 * Syncing a subtitle to the file being played. A subtitle is usually timed to some other release;
 * this lines it up with the playing one. The file is found through the viewer's AIOStreams, and the
 * timing of its own subtitle lines is read (never their words): for a Matroska file from its index
 * (mkv.ts), about 1 MB for the whole file; otherwise ffmpeg reads a few short windows, seeking with
 * the file's index so only those are downloaded. The subtitle's shift is measured window by window,
 * so timing that steps mid-episode is followed. When the subtitle fits none of the file's tracks, or
 * the file has none, it is timed by where speech starts in the audio of a few windows (vad.ts). Dub
 * captions, which follow the English voices rather than the original audio the track follows, are
 * moved from the track's timing onto those voices where the audio has been heard (refineBySpeech).
 * Reads of the file are held back when its host refuses them or the day's limit is spent (reads.ts).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheKey, cachePath } from "./cache.js";
import { config } from "./config.js";
import { decodeSubtitle } from "./text.js";
import { languageCode, sameLanguage } from "./langcodes.js";
import { count, noteError, scrub } from "./stats.js";
import { heardSpeech } from "./vad.js";
import { dialogueLines, isTextCodec, pictureLines, readMkvTiming, readMkvTracks, sharedHead, type MkvTrack } from "./mkv.js";
import { readMp4Timing } from "./mp4.js";
import { readFileHash } from "./oshash.js";
import { openAudioWindow, type AudioWindow } from "./audiowindow.js";
import { hearingTurn } from "./turns.js";
import { viewerOf } from "./viewers.js";
import { otherInstallUrls } from "./installUrls.js";
import { jellyfinToken, linkedInstallUrls } from "./aiostreamsAccount.js";
import { jellyfinItemIds, jellyfinVersions } from "./aiostreamsJellyfin.js";
import { kitsuEpisode } from "./ids.js";
import { FILM_FRAME_MS, keptInOrder, linesOverShift, onFileLines, timingByLines } from "./align.js";
import { TRACK_CHECK, trackCheckSpots, trackOffVoices, voicesSay, type VoiceSpot } from "./trackcheck.js";
import { laidOutForPlayers } from "./respace.js";
import { backgroundReadFits, checkHost, checkReadable, checkReads, fetchFile, noteRead, noteReadOk, noteRefusal, PrivateHost, ReadsPaused, refusalStatus } from "./reads.js";

export interface Cue {
  start: number;
  end: number;
}

export interface Anchor {
  /** Window in the file, ms. */
  from: number;
  to: number;
  /** ms to add to the caption times here (negative = earlier). */
  offset: number;
  /** Share of the embedded speech the captions cover at that offset, 0..1. */
  score: number;
  /** Where the shift changes to this anchor's, in caption time, when the timing itself found it (see farStretches). */
  stepAt?: number;
}

// ---------- subtitle text ----------

function srtTime(value: string): number {
  const m = value.match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return NaN;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

function assTime(value: string): number {
  const m = value.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) return NaN;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function formatSrt(ms: number, sep: string): string {
  const t = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(t / 3600000), 2)}:${pad(Math.floor(t / 60000) % 60, 2)}:${pad(Math.floor(t / 1000) % 60, 2)}${sep}${pad(t % 1000, 3)}`;
}

function formatAss(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60, 2)}:${pad(Math.floor(cs / 100) % 60, 2)}.${pad(cs % 100, 2)}`;
}

const isAss = (ext: string) => ext === ".ass" || ext === ".ssa";

/** Splits an ASS Dialogue line into its fields (Text keeps its commas). */
function assFields(line: string, format: string[]): Record<string, string> | undefined {
  const body = line.replace(/^Dialogue:\s*/, "");
  const parts: string[] = [];
  let rest = body;
  for (let i = 0; i < format.length - 1; i++) {
    const comma = rest.indexOf(",");
    if (comma === -1) return undefined;
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return Object.fromEntries(format.map((name, i) => [name, parts[i] ?? ""]));
}

function assFormat(text: string): string[] {
  const events = text.split(/\[Events\]/i)[1] ?? text;
  const line = events.match(/^Format:\s*(.+)$/im)?.[1];
  return (line ?? "Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text").split(",").map((s) => s.trim().toLowerCase());
}

/** Timed lines of a caption file. */
export function parseCues(text: string, ext: string): Cue[] {
  const cues: Cue[] = [];
  if (isAss(ext)) {
    const format = assFormat(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const f = assFields(line, format);
      if (!f) continue;
      const start = assTime(f.start);
      const end = assTime(f.end);
      if (end > start) cues.push({ start, end });
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("-->")) continue;
      const [a, b] = line.split("-->");
      const start = srtTime(a);
      const end = srtTime(b);
      if (end > start) cues.push({ start, end });
    }
  }
  return cues.sort((x, y) => x.start - y.start);
}

/**
 * A style name's words, lower case: split at anything but a letter and between a lower and an upper
 * case letter ("TitleCard", "OPKara"), a plural's "s" dropped ("Signs", "Credits").
 */
export function styleWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

const SIGN_WORDS = new Set(["sign", "song", "op", "ed", "opening", "ending", "kara", "karaoke", "title", "insert", "note", "logo", "screen", "text"]);

/**
 * A style named for signs, songs or on-screen text, by its words: "Sign", "OP-Romaji", "ED1",
 * "TitleCard", "Signs/Songs"; not dialogue placed at the top ("top", "Main - Top", "italicstop"), nor
 * "Subtitle" or "Speed". Calibration (128 ASS subtitles of real plays): read by letters inside words,
 * 267 dialogue events in those four "top" styles, over 45 files, were taken for signs; read by words,
 * nothing else changes.
 */
const signStyle = (name: string) => styleWords(name).some((w) => SIGN_WORDS.has(w));
const SIGN_TAGS = /\\(?:pos|move|org|an[1345789])\b|\\[kK][fot]?\d|\\p[1-9]/;

/** Spoken lines from ASS text (an embedded track's or a subtitle's): signs, songs and positioned text left out. */
export function dialogueCues(assText: string): Cue[] {
  const format = assFormat(assText);
  const cues: Cue[] = [];
  for (const line of assText.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const f = assFields(line, format);
    if (!f) continue;
    if (signStyle(f.style ?? "") || SIGN_TAGS.test(f.text ?? "")) continue;
    if (!(f.text ?? "").replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, "").trim()) continue;
    const start = assTime(f.start);
    const end = assTime(f.end);
    if (end > start) cues.push({ start, end });
  }
  // Duplicate layers (shadow copies) would count twice.
  const seen = new Set<string>();
  return cues
    .filter((c) => (seen.has(`${c.start}-${c.end}`) ? false : (seen.add(`${c.start}-${c.end}`), true)))
    .sort((x, y) => x.start - y.start);
}

/**
 * The lines a subtitle is timed by: an ASS subtitle's spoken lines (dialogueCues), as its signs,
 * songs and karaoke follow neither the voices nor the file's own lines; every line when none reads
 * as spoken. Every line is still moved (retime).
 * Calibration (137 ASS subtitles of real plays): 122 are 90% or more spoken lines and 11 are 75-90%;
 * 4 Blu-ray releases are 3-4% (thousands of karaoke and sign events), which timed by every line
 * left the file's own track "too sparse" and weren't synced.
 */
export function captionCues(text: string, ext: string): Cue[] {
  if (!isAss(ext)) return parseCues(text, ext);
  const spoken = dialogueCues(text);
  return spoken.length ? spoken : parseCues(text, ext);
}

/**
 * Rewrites every cue's times: first scaled by `factor` (a subtitle made for another frame rate, see
 * RATE_FACTORS), then moved by delta(scaled start). With `end`, a line ends at end(scaled start,
 * scaled end) instead of moving its end by the same delta (see keptInOrder).
 */
export function retime(text: string, ext: string, delta: (start: number) => number, factor = 1, end?: (start: number, end: number) => number): string {
  const scale = (ms: number) => Math.round(ms * factor);
  const ending = (start: number, last: number, d: number) => (end ? end(start, last) : last + d);
  if (isAss(ext)) {
    return text.replace(/^(Dialogue:[^,]*,)(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2})/gm, (_all, head, a, b) => {
      const start = scale(assTime(a));
      const d = delta(start);
      return `${head}${formatAss(start + d)},${formatAss(ending(start, scale(assTime(b)), d))}`;
    });
  }
  return text.replace(/^.*-->.*$/gm, (line) => {
    const [a] = line.split("-->");
    const start = scale(srtTime(a));
    const d = delta(start);
    let stamps = 0;
    // The first stamp is the start, the second the end.
    return line.replace(/(?:\d{1,2}:)?\d{2}:\d{2}([,.])\d{3}/g, (stamp, sep) => {
      const at = scale(srtTime(stamp));
      return formatSrt(stamps++ === 1 ? ending(start, at, d) : at + d, sep);
    });
  });
}

/** A line cut short to make room for the next is still shown this long, or as long as it was written for when that is less. */
export const APART_MIN_SHOWN_MS = 500;

/**
 * Where each line ends once retimed (retime's `end`), so that a line doesn't stay on screen into the
 * next one when it didn't as written. Lines are moved by their own amounts (a shift per stretch,
 * snapping, a line's own pairing), and where a later line is moved earlier than the one before it, the
 * two would show together. The earlier one then ends where the next begins. Lines that overlap as
 * written (two speakers, a sign over dialogue) keep doing so, and a line isn't cut to under
 * APART_MIN_SHOWN_MS: there the two stay together, as the timing put them.
 *
 * `cues`: every line of the subtitle, in the times retime moves (scaled already). `end`: where a line
 * ends before this, when it isn't its own end moved with its start.
 */
export function endsApart(cues: Cue[], shift: (start: number) => number, end?: (start: number, end: number) => number): (start: number, end: number) => number {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const ends = new Map<string, number>();
  const moved = (c: Cue) => (end ? end(c.start, c.end) : c.end + shift(c.start));
  for (let k = 0; k < sorted.length; k++) {
    const line = sorted[k];
    const from = line.start + shift(line.start);
    const to = moved(line);
    // The first line written to start once this one has gone.
    let j = k + 1;
    while (j < sorted.length && sorted[j].start < line.end) j++;
    if (j >= sorted.length) continue;
    const next = sorted[j].start + shift(sorted[j].start);
    if (next >= to) continue;
    if (next - from >= Math.min(APART_MIN_SHOWN_MS, line.end - line.start)) ends.set(`${line.start}|${line.end}`, next);
  }
  return (start, last) => ends.get(`${start}|${last}`) ?? (end ? end(start, last) : last + shift(start));
}

// ---------- per-line snapping ----------

/**
 * After the shift, each caption line that lands near one of the file's own line starts is moved onto
 * it ("snapping"), where the file was read. A translation is often timed by someone else, a line
 * here or there a beat off: inside the windows read, synced lines sat 150 ms from the file's line
 * starts at the median, and 46% sat 80 to 300 ms off (replay data). Only clear pairs move: the file's
 * line is the only one within SNAP_CLEAR_MS, no other caption line is nearer to it, and the move is
 * at most SNAP_MAX_MS (`limits`; wider on the file's own track in the captions' language, OWN_SNAP). Dub captions never snap: the file's lines follow the original audio, not the dub.
 * Returns the extra move per caption start (in the captions' own, possibly rescaled, time).
 */
export function lineNudges(captions: Cue[], shift: (start: number) => number, reference: Cue[], limits: SnapLimits = SNAP): Map<number, number> {
  const refs = [...new Set(reference.map((c) => c.start))].sort((a, b) => a - b);
  const nudges = new Map<number, number>();
  if (refs.length === 0) return nudges;
  const placed = captions.map((c) => c.start + shift(c.start)).sort((a, b) => a - b);
  // The nearest of a sorted list to x, and the distance to the one after it.
  const nearest = (list: number[], x: number): { at: number; second: number } | undefined => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    const near = [list[lo - 2], list[lo - 1], list[lo], list[lo + 1]].filter((v): v is number => v !== undefined).sort((a, b) => Math.abs(a - x) - Math.abs(b - x));
    return near.length ? { at: near[0], second: near[1] === undefined ? Infinity : Math.abs(near[1] - x) } : undefined;
  };
  for (const c of captions) {
    if (nudges.has(c.start)) continue;
    const at = c.start + shift(c.start);
    const ref = nearest(refs, at);
    if (!ref) continue;
    const move = ref.at - at;
    if (Math.abs(move) > limits.max || Math.abs(move) < SNAP_MIN_MS || ref.second <= limits.clear(move)) continue;
    // No other caption line may be nearer to that line start (or as near): it belongs to this one.
    const back = nearest(placed, ref.at);
    if (!back || back.at !== at || back.second <= Math.abs(move)) continue;
    nudges.set(c.start, move);
  }
  return nudges;
}

/** Back-to-back cues this close (either way) with the same text are one line cut in two. */
const CUT_GAP_MS = 10;
/**
 * The least share of a subtitle's cues that continue the cue before it for its cuts to count: below
 * it, the same text back to back is a line said twice, which the file's track has twice too.
 * Calibration (316 uploads): 0 to 4 such cues a file (at most 0.5%), words said
 * or sounds heard twice; an upload that cuts its lines at shot changes: 207 of 793 (26%).
 */
const CUT_SHARE = 0.05;

/** A cue's text for comparing lines: tags left out, spaces and line breaks as one space. */
function cueText(text: string): string {
  return text
    .replace(/<[^>]*>|\{[^}]*\}/g, " ")
    .replace(/\\[Nnh]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lines the subtitle cuts in two or more: back-to-back cues (within CUT_GAP_MS) with the same text,
 * which some uploads use wherever a line runs across a shot change. The file's own track has them as
 * one line, so each piece is timed with the first: snapping and the pairing by rhythm see one line from
 * the first piece's start to the last piece's end (joinCuts). Only for a subtitle that cuts lines this
 * way (CUT_SHARE). Returns the start of every later piece mapped to its first piece's start, in the
 * captions' time scaled by `factor` (as retime has them).
 */
export function cutLines(text: string, ext: string, factor = 1): Map<number, number> {
  const cues: Array<{ start: number; end: number; words: string }> = [];
  if (isAss(ext)) {
    const format = assFormat(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("Dialogue:")) continue;
      const f = assFields(line, format);
      if (!f) continue;
      cues.push({ start: assTime(f.start), end: assTime(f.end), words: cueText(f.text ?? "") });
    }
  } else {
    let cue: { start: number; end: number; words: string } | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (line.includes("-->")) {
        const [a, b] = line.split("-->");
        cue = { start: srtTime(a), end: srtTime(b), words: "" };
        cues.push(cue);
      } else if (!line.trim()) cue = undefined;
      else if (cue) cue.words += ` ${line}`;
    }
    for (const c of cues) c.words = cueText(c.words);
  }
  const lines = cues.filter((c) => c.end > c.start).sort((x, y) => x.start - y.start);
  const heads = new Map<number, number>();
  const scale = (ms: number) => Math.round(ms * factor);
  for (let k = 1; k < lines.length; k++) {
    const a = lines[k - 1];
    const b = lines[k];
    if (!b.words || b.words !== a.words || Math.abs(b.start - a.end) > CUT_GAP_MS || b.start === a.start) continue;
    heads.set(scale(b.start), heads.get(scale(a.start)) ?? scale(a.start));
  }
  return heads.size >= lines.length * CUT_SHARE ? heads : new Map();
}

/** The captions with each cut line (cutLines) as one line, from its first piece's start to its last piece's end. */
export function joinCuts(captions: Cue[], heads: Map<number, number>): Cue[] {
  const ends = new Map<number, number>();
  for (const c of captions) {
    const head = heads.get(c.start);
    if (head !== undefined) ends.set(head, Math.max(ends.get(head) ?? 0, c.end));
  }
  return captions.filter((c) => !heads.has(c.start)).map((c) => (ends.has(c.start) ? { ...c, end: Math.max(c.end, ends.get(c.start)!) } : c));
}

/**
 * The moves of a pairing by rhythm (linesOverShift) less those onto a line start that another caption
 * line, as shifted, is nearer to: an extra line of the subtitle (one the file's track doesn't have)
 * paired a line off would take its neighbour's line, and keep the neighbour from snapping onto it.
 */
export function nearerClaims(captions: Cue[], shift: (start: number) => number, moves: Map<number, number>): Map<number, number> {
  // Rivals are lines the pairing left where they were: one it moved elsewhere has a line of its own.
  const placed = captions.filter((c) => !moves.has(c.start)).map((c) => c.start + shift(c.start)).sort((a, b) => a - b);
  const kept = new Map<number, number>();
  for (const [start, to] of moves) {
    const target = start + to;
    const own = Math.abs(to - shift(start));
    let lo = 0;
    let hi = placed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (placed[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const here = start + shift(start);
    const rival = [placed[lo - 1], placed[lo], placed[lo + 1]].some((at) => at !== undefined && at !== here && Math.abs(at - target) < own);
    if (!rival) kept.set(start, to);
  }
  return kept;
}

/** Moves smaller than this aren't worth making; larger than SNAP_MAX_MS aren't the same line. */
const SNAP_MIN_MS = 40;
const SNAP_MAX_MS = 300;
/** The file's next line start must be farther than this from the caption, so the pair is clear. */
const SNAP_CLEAR_MS = 600;

/** How far a line may snap (`max`), and how far the file's next line start must be for a move (`clear`). */
export type SnapLimits = { max: number; clear: (move: number) => number };
const SNAP: SnapLimits = { max: SNAP_MAX_MS, clear: () => SNAP_CLEAR_MS };
/**
 * Limits on the file's own track in the captions' language (see tracksToTry): its lines are the
 * captions' own lines, one for one, so a line another release timed up to 0.9 s apart still finds its
 * own, as long as the next nearest line start is at least 0.3 s farther than it.
 */
export const OWN_SNAP: SnapLimits = { max: 900, clear: (move) => Math.abs(move) + 300 };

// ---------- frame rate ----------

const FILM = 24000 / 1001;

/**
 * What a subtitle's times are multiplied by when it was made for one frame rate and the file plays at
 * another: a 25 fps (PAL: DVD, European TV) subtitle on a 23.976 fps web or Blu-ray file runs 4.3%
 * fast, about a minute by the end of an episode; 24 against 23.976 drifts 1.4 s over 24 minutes.
 */
export const RATE_FACTORS = [25 / FILM, 25 / 24, 24 / FILM, FILM / 24, 24 / 25, FILM / 25];

/** The captions as they'd play at another frame rate. */
export function scaleCues(cues: Cue[], factor: number): Cue[] {
  return cues.map((c) => ({ ...c, start: Math.round(c.start * factor), end: Math.round(c.end * factor) }));
}

/** How far apart the anchors' shifts are. */
function spread(anchors: Anchor[]): number {
  if (anchors.length === 0) return Infinity;
  const offsets = anchors.map((a) => a.offset);
  return Math.max(...offsets) - Math.min(...offsets);
}

type Measurement = { measuredWindows: Array<{ from: number; to: number; measured: Measured }>; anchors: Anchor[] };

/**
 * A long measurement written as steps: each `yield` is a point where the server may answer other
 * requests before going on. Measuring a film against six frame rates takes seconds of CPU, and
 * Node runs it on the one thread that also answers lists and downloads.
 */
type Steps<T> = Generator<void, T, void>;

/** Runs the steps in one go: for tests and the replay check, where nothing else is waiting. */
function finish<T>(steps: Steps<T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Runs the steps, letting waiting requests through between them. */
async function finishBetweenRequests<T>(steps: Steps<T>): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = steps.next();
  }
  return step.value;
}

type Rescaled = Measurement & { factor: number; captions: Cue[] };

/** Whether measured windows give a sync to trust (the same tests syncCaptions makes). */
function trusted(m: Measurement): boolean {
  return fitsFile(m.measuredWindows) && m.anchors.length > 0 && landsOnTiming(m.measuredWindows, m.anchors) && holdsTogether(m.anchors);
}

/**
 * How many times the shift jumps (by more than JUMP_MS) from one anchor to the next. Smaller moves
 * don't count: a subtitle running a touch fast or slow creeps by half a second a minute or so
 * between its cuts.
 */
export function shiftChanges(anchors: Anchor[]): number {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  let changes = 0;
  for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i].offset - sorted[i - 1].offset) > JUMP_MS) changes++;
  return changes;
}

const JUMP_MS = 1000;

/**
 * Whether a timing changes no more often than cuts can explain. A subtitle made for another cut of
 * the file needs a new shift at each place the cuts differ: a handful of times per episode. A shift
 * that jumps about from window to window is something a shift per stretch can't follow, whatever the
 * cause: chance fits of a subtitle that isn't this file's, or a subtitle timed by hand to another
 * recording, where each line sits differently (a dozen jumps of several seconds over a film). Such a
 * subtitle is left to byLines, which times it line by line when it is the file's own dialogue. Allowed: one jump per
 * CHANGE_EVERY anchors, and at least MIN_CHANGES_ALLOWED.
 */
export function holdsTogether(anchors: Anchor[]): boolean {
  return shiftChanges(anchors) <= Math.max(MIN_CHANGES_ALLOWED, Math.floor(anchors.length / CHANGE_EVERY));
}

const MIN_CHANGES_ALLOWED = 3;
const CHANGE_EVERY = 6;

/**
 * The captions rescaled to the file's frame rate, when that is what fits: they then land at one shift
 * (within AGREE_MS) in at least RATE_MIN_ANCHORS windows spread over the file, where as written they
 * fit nowhere, or only with steps. A step mid-episode (a cut, a moved break) stays a step: it isn't a
 * straight line from start to end. Undefined when the captions already fit at one shift.
 */
export function rescaled(found: FileAnchors, captions: Cue[], asWritten: Measurement): Rescaled | undefined {
  return finish(rescaledSteps(found, captions, asWritten));
}

/** rescaled, one frame rate per step. */
function* rescaledSteps(found: FileAnchors, captions: Cue[], asWritten: Measurement): Steps<Rescaled | undefined> {
  if (found.speechOnly || !found.duration) return undefined;
  if (trusted(asWritten) && spread(asWritten.anchors) <= AGREE_MS) return undefined;
  let best: (Rescaled & { score: number }) | undefined;
  for (const factor of RATE_FACTORS) {
    yield;
    const scaled = scaleCues(captions, factor);
    const m = measureAll(found, scaled);
    if (m.anchors.length < RATE_MIN_ANCHORS || !trusted(m) || spread(m.anchors) > AGREE_MS) continue;
    // Drift only shows across the file: the anchors must reach from its early part to its late part.
    const sorted = [...m.anchors].sort((a, b) => a.from - b.from);
    if (sorted[sorted.length - 1].to - sorted[0].from < found.duration * RATE_MIN_REACH) continue;
    // Steps that fit as written, in more windows, are kept: a real cut isn't a drift.
    if (trusted(asWritten) && asWritten.anchors.length > m.anchors.length) continue;
    // Line starts must meet at that one shift too (see lineStartFit).
    const median = [...m.anchors.map((a) => a.offset)].sort((a, b) => a - b)[Math.floor(m.anchors.length / 2)];
    const lines = lineStartFit(found, scaled, median);
    if (lines.score < RATE_MIN_LINE_SCORE || lines.margin < RATE_MIN_LINE_MARGIN) continue;
    const score = m.anchors.reduce((sum, a) => sum + a.score, 0);
    if (!best || m.anchors.length > best.anchors.length || (m.anchors.length === best.anchors.length && score > best.score)) best = { ...m, factor, captions: scaled, score };
  }
  if (!best) return undefined;
  const { score: _score, ...result } = best;
  return result;
}

/**
 * How well the captions' line starts meet the file's own line starts at `offset`, over every measured
 * window at once, against the best fit more than a second away. Overlap alone can't vouch for a
 * rescaled fit (dense dialogue covers itself at many shifts, and six rates are tried), but line starts
 * meet at one shift only. score: the share of the file's line starts met; margin: score minus that
 * rival. Calibration (replay data, 186 pairs): the rate fits accepted score 0.58 to 0.89 with margins
 * of 0.36 to 0.63; the best refused one scores 0.21, and other episodes' subtitles 0.12.
 */
export function lineStartFit(found: FileAnchors, captions: Cue[], offset: number, range = 20000): { score: number; margin: number } {
  const { matched, total } = fileStartCurve(found, captions, range);
  if (total === 0) return { score: 0, margin: 0 };
  const steps = matched.length;
  const at = (i: number) => matched[i] / total;
  const centre = Math.round((offset + range) / LINE_STEP_MS);
  let score = 0;
  let rival = 0;
  for (let i = 0; i < steps; i++) {
    const distance = Math.abs(i - centre) * LINE_STEP_MS;
    if (distance <= AGREE_MS) score = Math.max(score, at(i));
    else if (distance > 1000) rival = Math.max(rival, at(i));
  }
  return { score: Math.round(score * 100) / 100, margin: Math.round((score - rival) * 100) / 100 };
}

/** Caption starts, sorted, each once: what startCurve takes. */
function captionStarts(captions: Cue[]): number[] {
  return [...new Set(captions.map((c) => c.start))].sort((a, b) => a - b);
}

/**
 * For each shift from -range to +range, LINE_STEP_MS apart: how many of `lines` have a caption start
 * within LINE_TOLERANCE_MS of their own start once the captions are moved by it. Each line counts
 * once per shift. `starts`: the captions' starts, sorted (captionStarts). Added into `into` when given.
 */
function startCurve(lines: Cue[], starts: number[], range: number, into?: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> {
  const steps = Math.round((2 * range) / LINE_STEP_MS) + 1;
  const matched = into ?? new Int32Array(steps);
  const seen = new Int32Array(steps).fill(-1);
  const own = lines.map((c) => c.start).sort((a, b) => a - b);
  let a = 0;
  own.forEach((line, k) => {
    // Every shift where a caption start lands within LINE_TOLERANCE_MS of this line's start.
    while (a < starts.length && starts[a] < line - range - LINE_TOLERANCE_MS) a++;
    for (let j = a; j < starts.length && starts[j] <= line + range + LINE_TOLERANCE_MS; j++) {
      const shift = line - starts[j];
      const first = Math.max(0, Math.ceil((shift - LINE_TOLERANCE_MS + range) / LINE_STEP_MS));
      const last = Math.min(steps - 1, Math.floor((shift + LINE_TOLERANCE_MS + range) / LINE_STEP_MS));
      for (let i = first; i <= last; i++) {
        if (seen[i] === k) continue;
        seen[i] = k;
        matched[i]++;
      }
    }
  });
  return matched;
}

/** startCurve over every measured window of the file at once, and how many lines that is. */
function fileStartCurve(found: FileAnchors, captions: Cue[], range: number): { matched: Int32Array<ArrayBuffer>; total: number } {
  const starts = captionStarts(captions);
  let matched = new Int32Array(Math.round((2 * range) / LINE_STEP_MS) + 1);
  let total = 0;
  for (const w of found.windows) {
    if (w.bridge || w.cues.length < 3) continue;
    total += w.cues.length;
    matched = startCurve(w.cues, starts, range, matched);
  }
  return { matched, total };
}

/**
 * The shift, over ±range, at which the captions' line starts meet the most of the file's own line
 * starts in every measured window at once (see lineStartFit): score, the share met; margin, score
 * minus the best shift more than a second away. Undefined when no window has lines.
 */
export function wideFit(found: FileAnchors, captions: Cue[], range = WIDE_RANGE_MS): { offset: number; score: number; margin: number } | undefined {
  const { matched, total } = fileStartCurve(found, captions, range);
  if (total === 0) return undefined;
  let best = 0;
  for (let i = 1; i < matched.length; i++) if (matched[i] > matched[best]) best = i;
  // A plateau of equal counts counts once, at its middle.
  let end = best;
  while (end + 1 < matched.length && matched[end + 1] === matched[best]) end++;
  const at = Math.round((best + end) / 2);
  let rival = 0;
  for (let i = 0; i < matched.length; i++) if (Math.abs(i - at) * LINE_STEP_MS > 1000) rival = Math.max(rival, matched[i]);
  return { offset: -range + at * LINE_STEP_MS, score: Math.round((matched[at] / total) * 100) / 100, margin: Math.round(((matched[at] - rival) / total) * 100) / 100 };
}

const WIDE_RANGE_MS = 120000;

const LINE_STEP_MS = 20;
const LINE_TOLERANCE_MS = 200;
/** What a rescaled fit needs from lineStartFit. */
const RATE_MIN_LINE_SCORE = 0.35;
const RATE_MIN_LINE_MARGIN = 0.25;

/** The fewest windows that must agree on one shift after rescaling. */
const RATE_MIN_ANCHORS = 3;
/** The share of the file those windows must cover, from the first to the last. */
const RATE_MIN_REACH = 0.4;

// ---------- measuring ----------

/** Total overlap between a and b shifted by `shift`. Both sorted by start. */
function overlap(a: Cue[], b: Cue[], shift: number): number {
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

/**
 * The shift that makes the captions cover the embedded speech in one window
 * best, searched over ±range ms. Returns undefined when the window has too
 * little speech or no shift fits well.
 */
export interface Measured {
  offset: number;
  score: number;
  /** Other good fits (score within 10% of the best), best first. */
  alternatives: Array<{ offset: number; score: number }>;
}

/**
 * Where a line starts after a pause, and where someone starts talking after one: the points speech
 * and lines share. Dialogue covers most of a scene, so how much two timelines overlap barely changes
 * when one is shifted by seconds; where speech starts doesn't.
 */
function onsets(cues: Cue[], pause: number): number[] {
  const out: number[] = [];
  let lastEnd = -Infinity;
  for (const c of cues) {
    if (c.start - lastEnd >= pause) out.push(c.start);
    lastEnd = Math.max(lastEnd, c.end);
  }
  return out;
}

/** How many of `a` have one of `b` (sorted) within tolerance once b is shifted. */
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

const ONSET_LEAD_MS = 200;

const ONSET_PAUSE_MS = 250;
const ONSET_TOLERANCE_MS = 200;

/**
 * measureWindow for speech heard in the audio: the shift that lines the captions' line starts up
 * with where speech starts, searched over ±range ms. The score is the share of speech starts that
 * meet a line start.
 */
/** Per shift (every SPEECH_STEP_MS over ±range), how many speech starts meet a line start. */
export function speechCurve(speech: Cue[], captions: Cue[], range = 20000): { matched: number[]; heard: number } | undefined {
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

const SPEECH_STEP_MS = 20;

/** The peaks of a curve, best first: a plateau of equal values counts once, at its middle. */
function curvePeaks(values: number[], range: number): Array<{ offset: number; score: number }> {
  const peaks: Array<{ offset: number; score: number }> = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0 || values[i] < (values[i - 1] ?? 0) || values[i] < (values[i + 1] ?? 0)) continue;
    let k = i;
    while (k + 1 < values.length && values[k + 1] === values[i]) k++;
    peaks.push({ offset: -range + Math.round((i + k) / 2) * SPEECH_STEP_MS, score: values[i] });
    i = k;
  }
  return peaks.sort((a, b) => b.score - a.score);
}

/** measureWindow for speech heard in one window of the audio (see speechCurve). */
export function measureSpeech(speech: Cue[], captions: Cue[], range = 20000): Measured | undefined {
  const curve = speechCurve(speech, captions, range);
  if (!curve) return undefined;
  const peaks = curvePeaks(curve.matched.map((m) => Math.round((m / curve.heard) * 100) / 100), range);
  const best = peaks[0];
  if (!best || best.score < 0.45) return undefined;
  const alternatives = peaks.slice(1).filter((p) => p.score >= best.score * 0.9 && Math.abs(p.offset - best.offset) > 400);
  return { offset: best.offset, score: best.score, alternatives };
}

/**
 * Speech across all of a file's windows at once. One window's best fit is right only about half the
 * time (a chance alignment of a few starts can win), but chance alignments land somewhere else in
 * every window while the true shift is the same: the windows' curves are added up, and each window
 * then takes its own best fit within SPEECH_DRIFT_MS of the total's peak, for timing that drifts.
 * score: the share of all speech starts that meet a line at the peak; margin: how far the peak
 * stands above the best shift more than a second away from it.
 */
export function measureSpeechFile(windows: Array<{ from: number; to: number; speech: Cue[] }>, captions: Cue[], range = 20000): SpeechFit | undefined {
  const curves = speechCurves(windows, captions, range);
  return curves.length < SPEECH_MIN_ANCHORS ? undefined : fitCurves(curves, range);
}

/** A fit of speech to captions over some windows (see measureSpeechFile); heard: the speech starts it counts. */
type SpeechFit = { offset: number; score: number; margin: number; anchors: Anchor[]; heard: number };

/** Each window's speechCurve, in the windows' order; windows with too little speech or too few lines have none. */
function speechCurves(windows: Array<{ from: number; to: number; speech: Cue[] }>, captions: Cue[], range = 20000): Array<{ w: { from: number; to: number }; curve: { matched: number[]; heard: number } }> {
  return windows.flatMap((w) => {
    const curve = speechCurve(w.speech, captions, range);
    return curve ? [{ w, curve }] : [];
  });
}

/** measureSpeechFile over windows whose curves are already drawn. */
function fitCurves(curves: Array<{ w: { from: number; to: number }; curve: { matched: number[]; heard: number } }>, range = 20000): SpeechFit | undefined {
  if (curves.length === 0) return undefined;
  const heard = curves.reduce((sum, c) => sum + c.curve.heard, 0);
  const total = curves[0].curve.matched.map((_, i) => curves.reduce((sum, c) => sum + c.curve.matched[i], 0) / heard);
  const peaks = curvePeaks(total, range);
  const best = peaks[0];
  if (!best) return undefined;
  const rival = peaks.find((p) => Math.abs(p.offset - best.offset) > 1000)?.score ?? 0;
  const anchors = curves.flatMap(({ w, curve }) => {
    const lo = Math.max(0, Math.round((best.offset - SPEECH_DRIFT_MS + range) / SPEECH_STEP_MS));
    const hi = Math.min(curve.matched.length - 1, Math.round((best.offset + SPEECH_DRIFT_MS + range) / SPEECH_STEP_MS));
    let at = -1;
    for (let i = lo; i <= hi; i++) if (at < 0 || curve.matched[i] > curve.matched[at] || (curve.matched[i] === curve.matched[at] && Math.abs(i - (best.offset + range) / SPEECH_STEP_MS) < Math.abs(at - (best.offset + range) / SPEECH_STEP_MS))) at = i;
    const score = at < 0 ? 0 : curve.matched[at] / curve.heard;
    return score >= 0.45 ? [{ from: w.from, to: w.to, offset: -range + at * SPEECH_STEP_MS, score: Math.round(score * 100) / 100 }] : [];
  });
  return { offset: best.offset, score: Math.round(best.score * 100) / 100, margin: Math.round((best.score - rival) * 100) / 100, anchors, heard };
}

const SPEECH_DRIFT_MS = 600;

export function measureWindow(embedded: Cue[], captions: Cue[], range = 20000, centre = 0): Measured | undefined {
  if (centre !== 0) {
    // Searched over centre ± range: the captions moved by centre first, then measured as usual.
    const moved = measureWindow(embedded, captions.map((c) => ({ start: c.start + centre, end: c.end + centre })), range);
    return moved && { offset: moved.offset + centre, score: moved.score, alternatives: moved.alternatives.map((a) => ({ offset: a.offset + centre, score: a.score })) };
  }
  if (embedded.length < 3) return undefined;
  const speech = embedded.reduce((sum, c) => sum + (c.end - c.start), 0);
  const from = embedded[0].start - range - 1000;
  const to = embedded[embedded.length - 1].end + range + 1000;
  const near = captions.filter((c) => c.end >= from && c.start <= to);
  if (near.length < 3) return undefined;

  const scores: number[] = [];
  for (let shift = -range; shift <= range; shift += 40) scores.push(overlap(embedded, near, shift));
  // Local peaks, each refined to 5 ms.
  const peaks: Array<{ offset: number; score: number }> = [];
  // The two ends of the range aren't peaks: the fit may still be rising past them, towards a shift
  // that wasn't searched.
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] <= 0 || scores[i] < scores[i - 1] || scores[i] < scores[i + 1]) continue;
    let peak = { offset: -range + i * 40, score: scores[i] };
    for (let shift = peak.offset - 40; shift <= peak.offset + 40; shift += 5) {
      const score = overlap(embedded, near, shift);
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

/**
 * Settles each window on one of its fits (its best, or a near-best one), by following the timing
 * through the file. A chance match can beat the true fit inside one window, but the true timing
 * carries on from one window to the next, and a real change (an inserted recap, a moved break)
 * holds in every window after it. So the windows are walked in order and the run of fits is taken
 * that scores highest in total, where changing the shift between one window and the next costs
 * STEP_COST and a window may be passed over. A fit off on its own costs two changes, more than one
 * window can score, so it is passed over; a new timing that lasts is followed.
 *
 * Taking the one shift most windows support and pulling every window towards it fails on an episode
 * whose shift changes several times: the minutes after a change are read at the first shift, seconds
 * late, though most of those windows' own best fits are right.
 *
 * A window that still disagrees with every other one by more than 1.5 s is dropped: a change seen
 * in one window only isn't trusted until another window confirms it.
 */
export function agreeAnchors(windows: Array<{ from: number; to: number; measured: Measured }>): Anchor[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  const fits = sorted.map((w) => [{ offset: w.measured.offset, score: w.measured.score }, ...w.measured.alternatives]);
  // Each state is a run ending at one shift: the best total for it, and how it was reached.
  type State = { offset: number | undefined; total: number; prev: number; pick: number };
  const steps: State[][] = [];
  let states: State[] = [{ offset: undefined, total: 0, prev: -1, pick: -1 }];
  for (const options of fits) {
    const next = new Map<number | undefined, State>();
    const keep = (state: State) => {
      const known = next.get(state.offset);
      if (!known || state.total > known.total) next.set(state.offset, state);
    };
    // Passing this window over: every run carries on as it is.
    states.forEach((state, j) => keep({ offset: state.offset, total: state.total, prev: j, pick: -1 }));
    options.forEach((option, k) => {
      let best: State | undefined;
      states.forEach((state, j) => {
        const changed = state.offset !== undefined && Math.abs(option.offset - state.offset) > AGREE_MS;
        const total = state.total + option.score - (changed ? STEP_COST : 0);
        if (!best || total > best.total) best = { offset: option.offset, total, prev: j, pick: k };
      });
      if (best) keep(best);
    });
    steps.push(states);
    states = [...next.values()].sort((a, b) => b.total - a.total).slice(0, MAX_RUNS);
  }
  // Back from the best run's end to its start.
  const picks = new Array<number>(fits.length).fill(-1);
  let state = states[0];
  for (let i = fits.length - 1; i >= 0; i--) {
    picks[i] = state.pick;
    state = steps[i][state.prev];
  }
  const chosen = sorted.flatMap((w, i) => (picks[i] < 0 ? [] : [{ from: w.from, to: w.to, offset: fits[i][picks[i]].offset, score: fits[i][picks[i]].score }]));
  if (chosen.length < 3) return chosen;
  return chosen.filter((anchor, i) => chosen.some((o, j) => j !== i && Math.abs(o.offset - anchor.offset) <= 1500));
}

/** What a change of shift between two windows costs, in window scores (a window scores 0.45 to 1). */
const STEP_COST = 0.6;
/** How many runs are followed at once. */
const MAX_RUNS = 64;

/**
 * Turns the anchors into a shift per caption line. Anchors that agree (within
 * AGREE_MS) share one shift. Where they differ, the change is placed at the
 * longest silence in the captions between the two windows, which is where a
 * cut, recap or break usually sits.
 */
/**
 * Windows measure the same release a few hundred ms apart, because dub lines
 * and translated lines never start at quite the same moment. Differences under this are
 * noise.
 */
const AGREE_MS = 500;

/** How much of a reference line the captions cover when shifted. */
function coverage(line: Cue, captions: Cue[], shift: number): number {
  let total = 0;
  for (const c of captions) {
    if (c.start + shift >= line.end) break;
    total += Math.max(0, Math.min(line.end, c.end + shift) - Math.max(line.start, c.start + shift));
  }
  return total / (line.end - line.start);
}

/** A pause may be this much shorter than the step it has to hold: a line lingers a little past its words. */
const STEP_ROOM_SLACK_MS = 500;
/** How many lines better a pause without room for the step must fit the file than the best pause with it. */
const STEP_ROOM_LINES = 2;

/**
 * The pauses a step from shift `from` to shift `to` can sit in. A step that moves the lines after it
 * earlier means the file lacks that much of what the subtitle was timed to (a shorter break, a card
 * left out), and what it lacks held no lines: so the subtitle has a pause there at least as long as
 * the step. In a shorter pause the lines after the step would land on the ones before it. A step that
 * moves them later fits any pause, and when no pause has the room, every pause stays a candidate.
 *
 * The file's lines still come first: a pause without the room is taken when it fits them by more than
 * STEP_ROOM_LINES better than any pause with it (a line that lingers into a cut leaves a short pause at
 * a real step). Room decides where the lines can't tell the pauses apart.
 */
function withRoom<G extends { width: number }>(gaps: G[], from: number, to: number): G[] {
  const closer = from - to;
  if (closer <= STEP_ROOM_SLACK_MS) return gaps;
  const roomy = gaps.filter((gap) => gap.width >= closer - STEP_ROOM_SLACK_MS);
  return roomy.length ? roomy : gaps;
}

/**
 * Where the shift changes from a to b, in caption time. Every pause between
 * caption lines in the span is a candidate; the one that lets the most
 * reference lines fit (lines before it at a's shift, after it at b's) wins,
 * among those with room for the step unless one without it fits clearly
 * better (withRoom).
 * Each line only has to choose between two known shifts, which holds up with
 * few lines where measuring an offset would not. Without reference lines in
 * the span, the longest pause is used.
 */
export function placeStep(a: Anchor, b: Anchor, captions: Cue[], reference: Cue[]): number {
  const lo = a.from - a.offset;
  const hi = b.to - b.offset;
  const every: Array<{ at: number; width: number }> = [];
  for (let k = 0; k < captions.length - 1; k++) {
    const gapStart = captions[k].end;
    const gapEnd = captions[k + 1].start;
    if (gapEnd <= gapStart || gapStart < lo || gapEnd > hi) continue;
    every.push({ at: (gapStart + gapEnd) / 2, width: gapEnd - gapStart });
  }
  const gaps = every;
  const roomy = new Set(withRoom(every, a.offset, b.offset));
  if (gaps.length === 0) return ((a.to - a.offset) + (b.from - b.offset)) / 2;
  const lines = reference.filter((r) => r.start >= a.from && r.end <= b.to);
  if (lines.length === 0) return [...roomy].reduce((x, y) => (y.width > x.width ? y : x)).at;

  // Each line's fit at either shift, worked out once.
  const fits = lines.map((r) => ({ start: r.start, atA: coverage(r, captions, a.offset), atB: coverage(r, captions, b.offset) }));
  let best = { at: gaps[0].at, score: -Infinity };
  let bestRoomy = { at: gaps[0].at, score: -Infinity };
  for (const gap of gaps) {
    // In reference time a line before the switch sits before gap+a, after it past gap+b.
    let score = 0;
    for (const f of fits) {
      if (f.start < gap.at + a.offset) score += f.atA;
      else if (f.start >= gap.at + b.offset) score += f.atB;
    }
    if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && gap.width > 0)) best = { at: gap.at, score };
    if (roomy.has(gap) && (score > bestRoomy.score + 1e-9 || (Math.abs(score - bestRoomy.score) <= 1e-9 && gap.width > 0))) bestRoomy = { at: gap.at, score };
  }
  // Room for the step decides unless a pause without it fits the file's lines clearly better (withRoom).
  return bestRoomy.score >= best.score - STEP_ROOM_LINES ? bestRoomy.at : best.at;
}

/**
 * A shift that follows a run of anchors from one to the next instead of taking their median: each
 * anchor's shift (the median of it and its neighbours in the run, against a window read a little off)
 * holds at the middle of its window, and between two anchors the shift moves in proportion. For timing
 * by line starts, whose windows are each read to a line: a subtitle's shift can creep between its
 * steps, so one shift for the whole run would leave its ends a second off.
 */
function followRun(run: Anchor[]): (start: number) => number {
  const offsets = run.map((a) => a.offset);
  const points = run
    .map((a, k) => {
      const near = offsets.slice(Math.max(0, k - 1), k + 2).sort((x, y) => x - y);
      const offset = near.length === 3 ? near[1] : a.offset;
      return { at: (a.from + a.to) / 2 - offset, offset };
    })
    .sort((x, y) => x.at - y.at);
  return (start) => {
    if (start <= points[0].at) return points[0].offset;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      if (start <= b.at) return Math.round(a.offset + ((b.offset - a.offset) * (start - a.at)) / Math.max(1, b.at - a.at));
    }
    return points[points.length - 1].offset;
  };
}

/**
 * A shift per caption start from the anchors (see the runs below). `follow`: within a run the shift
 * follows its anchors (followRun) instead of taking their median.
 */
export function planShifts(anchors: Anchor[], captions: Cue[], reference: Cue[] = [], follow = false): (start: number) => number {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  if (sorted.length === 0) return () => 0;
  const offsets = sorted.map((a) => a.offset);
  if (follow && Math.max(...offsets) - Math.min(...offsets) <= AGREE_MS) return followRun(sorted);
  if (Math.max(...offsets) - Math.min(...offsets) <= AGREE_MS) {
    const median = [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)];
    return () => median;
  }

  // Runs of anchors whose neighbours agree: a step sits only where two neighbours differ by more than
  // AGREE_MS. Each run takes the median of its own anchors' shifts, as a file with one run does
  // above. Taking the shift of the anchor that starts a run instead would serve a run whose windows
  // read +0.46, +0.15, -0.20, ... around a true 0 at +0.46 s throughout.
  const runs: Anchor[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].offset - sorted[i - 1].offset) > AGREE_MS) runs.push([]);
    runs[runs.length - 1].push(sorted[i]);
  }
  const shiftOf = runs.map((run) => {
    const offsets = run.map((a) => a.offset).sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)];
  });
  // Boundaries in caption time (the times as written in the caption file).
  const bounds: Array<{ at: number; offset: number }> = [];
  for (let i = 0; i < runs.length - 1; i++) {
    const a = { ...runs[i][runs[i].length - 1], offset: shiftOf[i] };
    const b = { ...runs[i + 1][0], offset: shiftOf[i + 1] };
    bounds.push({ at: runs[i + 1][0].stepAt ?? placeStep(a, b, captions, reference), offset: b.offset });
  }
  if (follow) {
    const within = runs.map(followRun);
    return (start) => {
      let run = 0;
      bounds.forEach((bound, i) => {
        if (start >= bound.at) run = i + 1;
      });
      return within[run](start);
    };
  }
  return (start) => {
    let offset = shiftOf[0];
    for (const bound of bounds) if (start >= bound.at) offset = bound.offset;
    return offset;
  };
}

/**
 * Dub captions keep planShifts (they follow the dub, not the file's lines), but a step in it still
 * has to earn its place: a run of windows that takes a shift of its own keeps it only when the file's
 * line starts in it meet the captions' starts no worse there than at the shift of a run beside it,
 * past chance (beyondChance). Each shift is given the same small search (MEET_REACH_MS), as overlap
 * reads a window a few hundred ms off. Overlap can agree on a wrong shift in two neighbouring windows
 * by chance, against a track whose lines aren't the captions' (a translation against dub captions);
 * where the lines start still says which of two shifts seconds apart is the file's. A run that
 * doesn't earn its step takes the shift of the neighbour its lines meet best.
 */
export function dubStepsEarned(anchors: Anchor[], captions: Cue[], lines: Cue[]): Anchor[] {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  const runs: Anchor[][] = [];
  for (const anchor of sorted) {
    const run = runs[runs.length - 1];
    if (run && Math.abs(anchor.offset - run[run.length - 1].offset) <= AGREE_MS) run.push(anchor);
    else runs.push([anchor]);
  }
  if (runs.length < 2) return anchors;
  const shiftOf = runs.map((run) => run.map((a) => a.offset).sort((x, y) => x - y)[run.length >> 1]);
  const starts = captions.map((c) => c.start).sort((x, y) => x - y);
  const lineStarts = lines.map((c) => c.start);
  const metNear = (runLines: number[], shift: number) => {
    let best = 0;
    for (let c = -MEET_REACH_MS; c <= MEET_REACH_MS; c += MEET_STEP_MS) best = Math.max(best, meetCount(runLines, starts, () => shift + c, MEET_JUDGE_MS));
    return best;
  };
  const moved = new Map<Anchor, number>();
  runs.forEach((run, i) => {
    const runLines = lineStarts.filter((t) => t >= run[0].from && t < run[run.length - 1].to);
    if (runLines.length < MEET_MIN_LINES) return;
    const own = metNear(runLines, shiftOf[i]);
    let best: { shift: number; met: number } | undefined;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= runs.length) continue;
      const met = metNear(runLines, shiftOf[j]);
      if (met > own + beyondChance(own) && (!best || met > best.met)) best = { shift: shiftOf[j], met };
    }
    if (best) for (const anchor of run) moved.set(anchor, best.shift);
  });
  return moved.size ? anchors.map((a) => (moved.has(a) ? { ...a, offset: moved.get(a)! } : a)) : anchors;
}

// ---------- following a translation's shift through the file ----------

/**
 * A translation is timed to the playing file's own lines, so where those lines start says its timing
 * more exactly than overlap does. Overlap reads each window a few hundred ms off, differently from one
 * window to the next (lines held longer, split or merged differently), and planShifts serves that as
 * it reads it. Over the replay data that also glued two shifts into one where a window straddled a cut
 * (-4.95 and -5.95 s joined by a window read at -5.48 s, served half a second off for ten minutes),
 * and flattened subtitles that creep (one went from +1.0 to +4.4 s over 37 minutes) into one median.
 * Dub captions follow the dub, not the file's lines: they keep planShifts.
 */

/** t minus the start nearest to it, of a sorted list (Infinity when it's empty). */
function gapToStart(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < starts.length ? starts[lo] - t : Infinity;
  const before = lo > 0 ? t - starts[lo - 1] : Infinity;
  return after < before ? -after : before;
}

/** How many of the file's line starts meet a caption start within `tolerance`, the captions moved by shift(t). */
function meetCount(lines: number[], starts: number[], shift: (t: number) => number, tolerance: number): number {
  return lines.filter((t) => Math.abs(gapToStart(starts, t - shift(t))) <= tolerance).length;
}

/**
 * How far the captions' line starts (sorted) are from meeting the file's line starts `lines`, once
 * moved by base(t): the correction within ±reach at which the most of them meet a caption start
 * within `tolerance`, and how many meet then. Undefined when fewer than MEET_MIN_LINES, or under
 * MEET_MIN_SHARE of the lines, meet at best.
 */
export function meetStarts(lines: number[], starts: number[], base: (t: number) => number, reach = MEET_REACH_MS, tolerance = MEET_TOLERANCE_MS): { correction: number; met: number } | undefined {
  if (lines.length < MEET_MIN_LINES || starts.length === 0) return undefined;
  const moved = lines.map((t) => t - base(t));
  const metAt = (c: number) => moved.filter((t) => Math.abs(gapToStart(starts, t - c)) <= tolerance).length;
  const counts: number[] = [];
  for (let c = -reach; c <= reach; c += MEET_STEP_MS) counts.push(metAt(c));
  const best = Math.max(...counts);
  if (best < MEET_MIN_LINES || best < MEET_MIN_SHARE * lines.length) return undefined;
  // The middle of the widest stretch of corrections at the best count, then the median gap of the
  // lines that meet there: a count alone is flat over a stretch as wide as the tolerance.
  let from = 0;
  let width = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] !== best) continue;
    let k = i;
    while (k + 1 < counts.length && counts[k + 1] === best) k++;
    if (k - i + 1 > width) (from = i), (width = k - i + 1);
    i = k;
  }
  const middle = -reach + (from + (width - 1) / 2) * MEET_STEP_MS;
  const gaps = moved.map((t) => gapToStart(starts, t - middle)).filter((d) => Math.abs(d) <= tolerance).sort((a, b) => a - b);
  const correction = Math.round(middle + gaps[gaps.length >> 1]);
  return { correction, met: metAt(correction) };
}

/** How far from its overlap fit a window's line starts are looked for: overlap was seen up to 0.7 s off. */
const MEET_REACH_MS = 700;
/** A line start meets a caption start this close, in one window. */
const MEET_TOLERANCE_MS = 120;
const MEET_STEP_MS = 10;
/** Fewer lines meeting than this, or than this share of them, isn't a fit (chance meets about 8% at 120 ms). */
const MEET_MIN_LINES = 4;
const MEET_MIN_SHARE = 0.25;
/**
 * A whole stretch is fitted with a looser tolerance: its lines are many, and a translation's lines
 * each sit a beat off (at 120 ms the fit followed the beats of a few lines: wobble-windows lost 5 points).
 */
const STRETCH_TOLERANCE_MS = 400;
/** Two timings of a stretch are compared by how many of its line starts meet a caption start this close. */
const MEET_JUDGE_MS = 200;
/** How much a shift that moves along a stretch must move over it to be tried. */
const TREND_MIN_MS = 200;
/** The share more lines such a shift must make meet than one shift does, to be taken (and see beyondChance). */
const TREND_MARGIN = 0.03;
/**
 * How far past chance a step or a moving shift must take a stretch's lines (see beyondChance). A
 * count of lines that meet wanders by about its square root from one fit to the next, and a fit
 * with more freedom (two shifts, or one that moves) always finds some of that to gain. Over the
 * stored plays, with every fifth of the file's lines hidden from the sync in turn, 1.5 and 2 did
 * best for the hidden lines, 1 a little less.
 */
const CHANCE_Z = 1.5;
/** Windows' fits within this of one line through them are a subtitle that creeps: one stretch. */
const ALONG_MS = 250;
/** Tied pauses spread wider than this lie across a stretch that wasn't read. */
const TIED_SPAN_MS = 60000;

/**
 * How many more lines a timing with more freedom (a step, or a shift that moves along a stretch)
 * must make meet than the simpler one, which makes `met` of them meet: TREND_MARGIN of them, and
 * no fewer than CHANCE_Z times the square root of `met`, what fitting a count's noise can give.
 * Where only a quarter of each window's lines meet (a translation timed loosely, for a release cut
 * differently), a 3% margin is a line or two: a slope or a step fitted to a few lines a beat off
 * would serve whole minutes 0.3 s off.
 */
function beyondChance(met: number): number {
  return Math.max(TREND_MARGIN * met, CHANCE_Z * Math.sqrt(met));
}

/** The line most points agree with (Theil-Sen: the median of the slopes between pairs). */
function robustLine(points: Array<{ x: number; y: number }>): { intercept: number; slope: number } {
  const median = (values: number[]) => {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) if (points[j].x !== points[i].x) slopes.push((points[j].y - points[i].y) / (points[j].x - points[i].x));
  const slope = slopes.length ? median(slopes) : 0;
  return { intercept: median(points.map((p) => p.y - slope * p.x)), slope };
}

/**
 * placeStep by line starts: of the pauses between caption lines in the span, the one that lets the
 * most of the file's line starts (sorted, `lines`) meet a caption start, those before it at a's shift
 * and those after it at b's. Overlap counts a line a beat off as half fitting, which can put a step a
 * minute away from where the lines changed. Among pauses the lines can't tell apart, the longest, where a cut most likely is; when those spread over a stretch
 * that wasn't read (a file read in windows), the middle one. `read` are the stretches of the file that
 * were read (file time): tied pauses spread wide across only read stretches still take the longest,
 * since a long pause there is a pause in the dialogue, not a gap in the reading. Without `read`, any
 * wide spread counts as unread.
 */
export function stepByStarts(a: Anchor, b: Anchor, captions: Cue[], lines: number[], starts: number[], read?: Array<{ from: number; to: number }>): number {
  const lo = a.from - a.offset;
  const hi = b.to - b.offset;
  const every: Array<{ at: number; width: number }> = [];
  for (let k = 0; k < captions.length - 1; k++) {
    const gapStart = captions[k].end;
    const gapEnd = captions[k + 1].start;
    if (gapEnd <= gapStart || gapStart < lo || gapEnd > hi) continue;
    every.push({ at: (gapStart + gapEnd) / 2, width: gapEnd - gapStart });
  }
  if (every.length === 0) return (a.to - a.offset + (b.from - b.offset)) / 2;
  const meet = (list: typeof every) => {
    const within = lines.filter((t) => t >= a.from && t < b.to);
    const onA = within.map((t) => Math.abs(gapToStart(starts, t - a.offset)) <= MEET_JUDGE_MS);
    const onB = within.map((t) => Math.abs(gapToStart(starts, t - b.offset)) <= MEET_JUDGE_MS);
    return Math.max(...list.map((gap) => within.reduce((sum, t, i) => sum + (t < gap.at + a.offset ? Number(onA[i]) : t >= gap.at + b.offset ? Number(onB[i]) : 0), 0)));
  };
  // Only where the step has room, unless a pause without it meets clearly more of the file's line starts (withRoom).
  const roomy = withRoom(every, a.offset, b.offset);
  const gaps = roomy.length === every.length || meet(roomy) >= meet(every) - STEP_ROOM_LINES ? roomy : every;
  const span = lines.filter((t) => t >= a.from && t < b.to);
  const meetsA = span.map((t) => Math.abs(gapToStart(starts, t - a.offset)) <= MEET_JUDGE_MS);
  const meetsB = span.map((t) => Math.abs(gapToStart(starts, t - b.offset)) <= MEET_JUDGE_MS);
  const scores = gaps.map((gap) => span.reduce((sum, t, i) => sum + (t < gap.at + a.offset ? Number(meetsA[i]) : t >= gap.at + b.offset ? Number(meetsB[i]) : 0), 0));
  const top = Math.max(...scores);
  const tied = gaps.filter((_, i) => scores[i] === top);
  const first = tied[0].at;
  const last = tied[tied.length - 1].at;
  if (last - first > TIED_SPAN_MS && !readThrough(read, first + a.offset, last + b.offset)) return tied[(tied.length - 1) >> 1].at;
  return tied.reduce((x, y) => (y.width > x.width ? y : x)).at;
}

/** Whether the stretches read cover the file from `from` to `to`, with no gap over a second. */
function readThrough(read: Array<{ from: number; to: number }> | undefined, from: number, to: number): boolean {
  if (!read) return false;
  let reached = from;
  for (const r of [...read].sort((x, y) => x.from - y.from)) {
    if (r.from > reached + 1000) break;
    reached = Math.max(reached, r.to);
    if (reached >= to) return true;
  }
  return reached >= to;
}

export interface Followed {
  shift: (start: number) => number;
  /** The anchors with the shift served at the middle of each window. */
  anchors: Anchor[];
  /** Whether the file's line starts set the timing of at least one stretch (enough of them met). */
  byStarts: boolean;
}

/**
 * planShifts for a translation, from the file's lines that were read (`lines`):
 * 1. Each window's shift is fitted again by its line starts (meetStarts), where they meet clearly.
 * 2. The windows are cut into stretches wherever neighbours differ by over AGREE_MS, and a stretch
 *    still spread wider than that is cut at its largest jump (a window across a cut reads between
 *    the two shifts, close enough to both to join them), unless its windows' fits lie along a line.
 * 3. Each stretch takes the one shift at which the most of all its line starts meet the captions',
 *    or a shift moving along it (a line through its windows' fits, for a subtitle that creeps) when
 *    that makes clearly more of them meet (beyondChance). Where too few meet, it keeps its windows'
 *    median overlap.
 * 4. Neighbouring stretches that one shift fits about as well (each side losing no more than chance
 *    accounts for) are joined again, the pair that loses least first (a stretch whose lines don't
 *    meet goes first with the neighbour its overlap lands on).
 * 5. Between stretches, the step is placed by stepByStarts.
 * 6. No line is moved before the one written ahead of it, nor over it (inOrder).
 * `read`: the stretches of the file the lines were read from (see stepByStarts).
 */
export function followShifts(anchors: Anchor[], captions: Cue[], lines: Cue[], read?: Array<{ from: number; to: number }>): Followed {
  if (anchors.length === 0) return { shift: () => 0, anchors, byStarts: false };
  const starts = [...new Set(captions.map((c) => c.start))].sort((a, b) => a - b);
  const fileStarts = lines.map((l) => l.start).sort((a, b) => a - b);
  const own = [...anchors].sort((a, b) => a.from - b.from).map((anchor) => {
    const inside = fileStarts.filter((t) => t >= anchor.from && t < anchor.to);
    const met = meetStarts(inside, starts, () => anchor.offset);
    return { anchor, offset: met ? anchor.offset + met.correction : anchor.offset, met: Boolean(met), lines: inside };
  });
  type Own = (typeof own)[number];
  const centre = (o: Own) => (o.anchor.from + o.anchor.to) / 2;
  const cut = (run: Own[]): Own[][] => {
    const offsets = run.map((o) => o.offset);
    if (run.length < 2 || Math.max(...offsets) - Math.min(...offsets) <= AGREE_MS) return [run];
    // Fits that lie along a line are a subtitle that creeps, not a cut.
    const fitted = run.filter((o) => o.met);
    if (fitted.length >= 3) {
      const line = robustLine(fitted.map((o) => ({ x: centre(o), y: o.offset })));
      if (fitted.every((o) => Math.abs(o.offset - line.intercept - line.slope * centre(o)) <= ALONG_MS)) return [run];
    }
    let at = 1;
    for (let i = 2; i < run.length; i++) if (Math.abs(offsets[i] - offsets[i - 1]) > Math.abs(offsets[at] - offsets[at - 1])) at = i;
    return [...cut(run.slice(0, at)), ...cut(run.slice(at))];
  };
  const runs: Own[][] = [[own[0]]];
  for (let i = 1; i < own.length; i++) {
    if (Math.abs(own[i].offset - own[i - 1].offset) > AGREE_MS) runs.push([]);
    runs[runs.length - 1].push(own[i]);
  }
  const settleRun = (run: Own[], mayMove = true) => {
    const lo = run[0].anchor.from;
    const hi = run[run.length - 1].anchor.to;
    const runLines = run.flatMap((o) => o.lines);
    const fitted = run.filter((o) => o.met);
    const values = (fitted.length ? fitted : run).map((o) => o.offset).sort((a, b) => a - b);
    // A timing for the stretch (one shift, or one moving along it and held at its ends), moved to
    // where all of its lines meet best if that makes no fewer of them meet; it holds when enough do.
    const settle = (intercept: number, slope: number) => {
      let at = (t: number) => intercept + slope * Math.min(hi, Math.max(lo, t));
      let met = meetCount(runLines, starts, at, MEET_JUDGE_MS);
      const pooled = meetStarts(runLines, starts, at, MEET_REACH_MS, STRETCH_TOLERANCE_MS);
      if (pooled) {
        const along = at;
        const moved = (t: number) => along(t) + pooled.correction;
        const now = meetCount(runLines, starts, moved, MEET_JUDGE_MS);
        if (now >= met) (at = moved), (met = now);
      }
      return { at, met, byStarts: met >= Math.max(MEET_MIN_LINES, MEET_MIN_SHARE * runLines.length) };
    };
    let plan = settle(values[values.length >> 1], 0);
    if (mayMove && fitted.length >= 2) {
      const line = robustLine(fitted.map((o) => ({ x: centre(o), y: o.offset })));
      if (Math.abs(line.slope) * (hi - lo) >= TREND_MIN_MS) {
        const moving = settle(line.intercept, line.slope);
        if (moving.byStarts && moving.met > plan.met + beyondChance(plan.met)) plan = moving;
      }
    }
    // Lines that don't meet the captions as a whole can still meet by chance in one window: then
    // the stretch keeps the median of its windows' overlap, as planShifts gives it.
    if (!plan.byStarts) {
      const overlap = run.map((o) => o.anchor.offset).sort((a, b) => a - b)[run.length >> 1];
      return { at: () => overlap, met: meetCount(runLines, starts, () => overlap, MEET_JUDGE_MS), byStarts: false };
    }
    return plan;
  };
  const stretches = runs.flatMap(cut);
  const plans = stretches.map((run) => settleRun(run));
  // A step must earn its place: two neighbouring stretches whose lines meet about as well at one
  // shift are joined again, where neither side loses more lines than chance accounts for
  // (beyondChance). A window's own fit can be a few hundred ms off where few of its lines meet,
  // enough to cut. The pair that loses least is joined first, then the one whose shifts differ least.
  // A stretch whose lines don't meet loses about as few at any shift, so they can't say where it
  // belongs: it goes first with a neighbour its windows' overlap lands on (LAND_MS, as landsOnTiming
  // counts it). Calibration (one episode): two minutes read at -7.24 and -7.4 s, between stretches
  // at -5.0 and -7.7 s, join -5.0 s by their lines alone and are served 2.5 s off. Overlap that lands on neither (chance fits at the edge of
  // the search) leaves it to the lines.
  const landsOn = (run: Own[], plan: (typeof plans)[number], at: (t: number) => number) =>
    plan.byStarts || run.filter((o) => Math.abs(at(centre(o)) - o.anchor.offset) <= LAND_MS).length * 2 >= run.length;
  for (;;) {
    let best: { at: number; plan: (typeof plans)[number]; lands: boolean; gain: number; step: number } | undefined;
    for (let i = 0; i < stretches.length - 1; i++) {
      const plan = settleRun([...stretches[i], ...stretches[i + 1]], false);
      const keeps = (k: number) => meetCount(stretches[k].flatMap((o) => o.lines), starts, plan.at, MEET_JUDGE_MS) + beyondChance(plans[k].met) >= plans[k].met;
      if (!keeps(i) || !keeps(i + 1)) continue;
      const step = Math.abs(plans[i].at(stretches[i][stretches[i].length - 1].anchor.to) - plans[i + 1].at(stretches[i + 1][0].anchor.from));
      const gain = plan.met - plans[i].met - plans[i + 1].met;
      const lands = landsOn(stretches[i], plans[i], plan.at) && landsOn(stretches[i + 1], plans[i + 1], plan.at);
      if (!best || (lands !== best.lands ? lands : gain > best.gain || (gain === best.gain && step < best.step))) best = { at: i, plan, lands, gain, step };
    }
    if (!best) break;
    stretches.splice(best.at, 2, [...stretches[best.at], ...stretches[best.at + 1]]);
    plans.splice(best.at, 2, best.plan);
  }
  const bounds = placeSteps(
    stretches.map((run, k) => {
      const first = run[0].anchor;
      const last = run[run.length - 1].anchor;
      return { first: { ...first, offset: Math.round(plans[k].at(first.from)) }, last: { ...last, offset: Math.round(plans[k].at(last.to)) } };
    }),
    captions,
    fileStarts,
    starts,
    read
  );
  // A plan gives the shift at a moment of the file; a caption start c lands at c + shift.
  const landed = (plan: (typeof plans)[number], c: number) => plan.at(c + plan.at(c + plan.at(c)));
  const raw = (start: number) => {
    let k = 0;
    while (k < bounds.length && start >= bounds[k]) k++;
    return Math.round(landed(plans[k], start));
  };
  const served = stretches.flatMap((run, k) => run.map((o) => ({ ...o.anchor, offset: Math.round(plans[k].at(centre(o))) })));
  return { shift: inOrder(captions, raw), anchors: served, byStarts: plans.some((p) => p.byStarts) };
}

/**
 * The steps between stretches of followShifts, in caption time and in order: each placed by
 * stepByStarts between the last window of one stretch and the first of the next (`first` and `last`
 * carry the stretch's shift at its two ends). A stretch of one window is both, so the steps on
 * either side of it are looked for across that same window and can come out the wrong way round,
 * and then the stretch would get no lines at all. Those two are placed again, each on its own half of
 * the stretch. A step still before the one ahead of it is held at that one: the lookup in
 * followShifts walks the steps in order.
 */
export function placeSteps(stretches: Array<{ first: Anchor; last: Anchor }>, captions: Cue[], lines: number[], starts: number[], read?: Array<{ from: number; to: number }>): number[] {
  const place = (i: number, half?: number) => {
    const a = stretches[i].last;
    const b = stretches[i + 1].first;
    // The step after a stretch looks from its middle on, the step before it up to its middle.
    const from = half !== undefined && i === half ? Math.max(a.from, middle(stretches[i])) : a.from;
    const to = half !== undefined && i + 1 === half ? Math.min(b.to, middle(stretches[i + 1])) : b.to;
    return stepByStarts({ ...a, from }, { ...b, to }, captions, lines, starts, read);
  };
  const middle = (s: { first: Anchor; last: Anchor }) => (s.first.from + s.last.to) / 2;
  const bounds = stretches.slice(1).map((_, i) => place(i));
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] >= bounds[i - 1]) continue;
    bounds[i - 1] = place(i - 1, i);
    bounds[i] = place(i, i);
  }
  for (let i = 1; i < bounds.length; i++) bounds[i] = Math.max(bounds[i], bounds[i - 1]);
  return bounds;
}

/**
 * The timing a translation takes from the file's own lines (followShifts), or undefined to keep
 * planShifts. Timing heard in speech (`heard`) is taken from them only when enough of them meet it:
 * the captions fit no shift on that track, so it may not be their dialogue at all.
 *
 * Given `file`, the file these lines are read from, the timing must also account for the whole file
 * (accountsForFile), as the plan it refines already did. The checks of syncCaptions judge that plan,
 * before followShifts runs, so what followShifts does can never make a subtitle count as synced. It
 * only refines: each window within 0.7 s of what overlap read, and two stretches joined only where
 * neither loses more lines than chance accounts for (beyondChance). A join can still move a stretch
 * by a few seconds, so the timing served is held to the same test, and one that fails is dropped
 * for the plan it refined. Over the stored plays and the benchmark, none has failed.
 */
export function timingByStarts(anchors: Anchor[], captions: Cue[], lines: Cue[], heard: boolean, file?: FileAnchors): Followed | undefined {
  if (lines.length === 0) return undefined;
  // Windows heard in speech read the audio, not the track the lines come from.
  const followed = followShifts(anchors, captions, lines, file?.windows.filter((w) => !w.heard));
  if (heard && !followed.byStarts) return undefined;
  return file && accountsForFile(file, captions, followed.shift) ? undefined : followed;
}

/**
 * A shift that changes from line to line, held so that no line moves before the one written ahead of
 * it, nor over it when they didn't overlap as written: it moves only as far as that line allows.
 *
 * Only the shift's changes from line to line are held so (a shift that creeps, or a stretch's lines
 * met a few ms apart). Where it steps back between two lines by more than STEP_BACK_MS, by more than
 * the pause the step sits in, the line after the step is left where the step puts it, as keptInOrder
 * leaves lines a step put out of order: that is the step's doing, and the lines after it are timed
 * by it. Holding it would push each of them later in turn.
 */
export function inOrder(captions: Cue[], shift: (start: number) => number): (start: number) => number {
  const sorted = [...captions].sort((a, b) => a.start - b.start || b.end - a.end);
  const held = new Map<number, number>();
  let prev: { start: number; end: number; shift: number; asTimed: number } | undefined;
  for (const c of sorted) {
    if (held.has(c.start)) continue;
    const asTimed = shift(c.start);
    let s = asTimed;
    if (prev && prev.asTimed - asTimed <= STEP_BACK_MS) {
      const floor = c.start >= prev.end ? prev.end + prev.shift : prev.start + prev.shift;
      if (c.start + s < floor) s = floor - c.start;
    }
    held.set(c.start, s);
    prev = { start: c.start, end: c.end, shift: s, asTimed };
  }
  return (start) => held.get(start) ?? shift(start);
}

/**
 * A drop in the shift between two neighbouring lines past this is a step, not a change from line to
 * line (see inOrder). A shift that creeps moves by half a second over a minute at most (followRun),
 * a few ms from one line to the next.
 */
const STEP_BACK_MS = 100;

// ---------- reading the playing file ----------

/**
 * Most ffprobe/ffmpeg processes at once, across everyone. A new file that isn't timed from its
 * index reads 5 windows side by side; several people starting at the same moment queue here
 * instead of piling up on the machine.
 */
const MAX_PROCS = 6;
let runningProcs = 0;
const waitingProcs: Array<() => void> = [];

async function procSlot(): Promise<void> {
  if (runningProcs < MAX_PROCS) {
    runningProcs++;
    return;
  }
  count("proc.queued");
  // The slot is handed over by the one that finishes, so the count stays exact.
  await new Promise<void>((resolve) => waitingProcs.push(resolve));
}

function freeSlot(): void {
  const next = waitingProcs.shift();
  if (next) next();
  else runningProcs--;
}

/** ffprobe/ffmpeg, counted for the stats page: runs, wall time and failures are the addon's main cost. */
async function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  // The file being read, to tell its host's refusals from other failures (see reads.ts).
  const url = args.find((a) => /^https?:\/\//.test(a));
  // ffmpeg and ffprobe open the address themselves: it must be one that may be read (reads.ts).
  if (url) await checkReadable(url);
  await procSlot();
  // A run that waited for its slot doesn't start on a host that refused meanwhile.
  try {
    if (url) checkHost(url);
  } catch (error) {
    freeSlot();
    throw error;
  }
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      freeSlot();
      count(`proc.${cmd}`);
      count(`proc.${cmd}.ms`, Date.now() - startedAt);
      if (error) {
        count(`proc.${cmd}.fail`);
        const refused = url ? refusalStatus(error.message) : undefined;
        if (url && refused) noteRefusal(url, refused);
        reject(error);
      } else {
        if (url) noteReadOk(url);
        resolve(stdout);
      }
    });
  });
}

/** Writes a chunk to a process's standard input, waiting while that is full. */
export async function feed(proc: ChildProcess, chunk: Uint8Array): Promise<void> {
  if (proc.stdin!.write(chunk)) return;
  // Full: on until it drains, or ffmpeg exits. Whichever comes first, the other's listener is taken
  // off again, so a long read's many waits don't pile listeners up on the process.
  await new Promise<void>((resolve) => {
    const done = () => {
      proc.stdin!.off("drain", done);
      proc.off("close", done);
      resolve();
    };
    proc.stdin!.once("drain", done);
    proc.once("close", done);
  });
}

/**
 * ffmpeg fed a stretch of the file through its standard input (audiowindow.ts), counted as run()
 * counts. Once ffmpeg has what it needs it exits, and the read stops there. A read that fails part
 * way fails the run, though ffmpeg made what it could of the bytes it got.
 */
async function runFed(args: string[], window: AudioWindow, timeoutMs: number): Promise<void> {
  await procSlot();
  const startedAt = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
      // ffmpeg stops reading once it has the stretch: what's written after that has nowhere to go.
      proc.stdin.on("error", () => {});
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      let feedError: unknown;
      let closed = false;
      const fed = (async () => {
        try {
          for await (const chunk of window.bytes) {
            if (closed) break;
            await feed(proc, chunk);
          }
        } catch (error) {
          if (!closed) feedError = error;
        } finally {
          proc.stdin.end();
        }
      })();
      proc.on("error", (error) => {
        closed = true;
        window.stop();
        reject(error);
      });
      proc.on("close", (code) => {
        closed = true;
        clearTimeout(timer);
        window.stop();
        count("proc.ffmpeg");
        count("proc.ffmpeg.ms", Date.now() - startedAt);
        // A read error that came before ffmpeg finished is the run's failure.
        void fed.finally(() => {
          if (code === 0 && !feedError) return resolve();
          count("proc.ffmpeg.fail");
          reject(feedError ?? new Error(`ffmpeg exited with ${code}: ${scrub(stderr.trim().split("\n").slice(-2).join(" | "))}`));
        });
      });
    });
  } finally {
    freeSlot();
  }
}

/** A failed read of the playing file: logged, and listed on the dashboard unless reads are only paused or the file isn't served yet. */
function readFailed(filename: string, error: unknown, what = ""): void {
  const message = scrub(error instanceof Error ? error.message : String(error));
  if (error instanceof ReadsPaused || error instanceof NotTheFile || error instanceof PrivateHost || error instanceof AlreadySaid) {
    count(error instanceof NotTheFile ? "sync.notTheFile" : error instanceof PrivateHost ? "sync.privateHostRefused" : error instanceof AlreadySaid ? "sync.saidAgain" : "sync.heldBack");
    console.log(`sync: ${filename}: ${what}${message}`);
    return;
  }
  noteError("sync", error);
  console.error(`sync: ${filename}: ${what}${message}`);
}

/**
 * Roughly how many bytes ffmpeg reads for `ms` of the file: the stretch holds every track, so it is
 * the file's bit rate over that time (about WINDOW_BYTES per 40 s when the header doesn't say).
 */
function windowBytes(bitrate: number | undefined, ms: number): number {
  return bitrate ? (bitrate / 8) * (ms / 1000) : WINDOW_BYTES * (ms / WINDOW_MS);
}

/** Drops entries older than maxAgeMs from a map of things seen at a time, so it can't grow for ever. */
function forgetOld<V>(map: Map<string, V>, at: (value: V) => number, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, value] of map) if (at(value) < cutoff) map.delete(key);
}

/** How long a finished job for extra reads is remembered, so syncs running beside it don't read the same stretch twice. */
const JOB_KEPT_MS = 10 * 60 * 1000;

const PROTOCOLS = ["-protocol_whitelist", "http,https,tcp,tls,crypto"];

/**
 * A listed stream that may be the playing file, and why: listed under its name ("name"), under the
 * name of another version of its release ("loose": checksum tag and version left out), or at its
 * exact size under another name ("size"), or as the one opened usenet release of its kind ("inner",
 * see INNER_SHARE). Only "name" is taken on its listing alone.
 */
export interface StreamCandidate {
  url: string;
  how: "name" | "loose" | "size" | "inner";
  /** Not in the list just asked for: its link as an earlier list gave it, this long ago (see rememberedStreams). */
  remembered?: number;
  /** The names of every stream the list holds, as bareName gives them: what a link may be serving in a failed release's place. */
  listed?: ReadonlySet<string>;
  /** Found in a list asked for by the title's other id (streamCandidates' `alias`), not by the one asked with. */
  byAlias?: boolean;
}

/**
 * The links of the streams AIOStreams listed lately, by configuration and title, then by file name.
 * AIOStreams drops a release from its list once the release's host no longer has it, and serves
 * another file under the link the player already holds (its failover); the player goes on naming the
 * first file. The link that list gave still leads to what is playing, so it is kept for
 * REMEMBERED_MS and used when a later list no longer names the file. In memory only: a link opens
 * the viewer's account, so it is never written to disk, and a restart forgets them all.
 */
const rememberedStreams = new Map<string, Map<string, { url: string; at: number }>>();
const REMEMBERED_MS = 6 * 60 * 60 * 1000;
/** Titles remembered at most; the one asked about longest ago goes first. */
const REMEMBERED_TITLES = 300;

/**
 * A usenet release under two names. Until it is opened AIOStreams lists it by its NZB's name and size;
 * once opened, by the name and size of the file inside, which for an obfuscated post is a run of
 * letters and digits that names no title. A player that was given the first list goes on naming the
 * file by the NZB, and a list asked for after it started playing holds only the inner name.
 *
 * So when nothing listed is the played file by name, version or size, the stream that is listed under
 * a name with no title in it is a candidate when all of this holds: it is the only such stream that
 * fits; its listed size is the played one less what an NZB carries beside the file (INNER_SHARE); and
 * the release marks AIOStreams read from the NZB's name, which it still lists in the stream's binge
 * group (resolution, source, group), are each in the played name. Its host must then serve a size
 * within the same share (openPlayable).
 *
 * Calibration (usenet releases, listed NZB size against the file served): 0.81, 0.88 and 0.88.
 */
const INNER_SHARE = { min: 0.75, max: 1 };

/** A file name that names no title: one run of letters and digits, both kinds in it, 16 or more long. */
function namesNothing(name: string): boolean {
  return /^(?=.*\d)(?=.*[a-z])[a-z0-9]{16,}$/i.test(bareName(name));
}

/** Whether a size is the played one less an NZB's overhead (INNER_SHARE). */
function innerSized(size: number, played: number): boolean {
  return size > 0 && played > 0 && size >= played * INNER_SHARE.min && size < played * INNER_SHARE.max;
}

/** Whether every release mark of a binge group ("addon|1080p|BluRay|GROUP") is in the played name; false with fewer than two marks. */
function marksIn(bingeGroup: string | undefined, played: string): boolean {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const marks = (bingeGroup ?? "").split("|").slice(1).map(flat).filter(Boolean);
  const name = flat(played);
  return marks.length >= 2 && marks.every((mark) => name.includes(mark));
}

/** For tests: forget every remembered link. */
export function forgetStreams(): void {
  rememberedStreams.clear();
}

/** Files whose look-up in AIOStreams is held back for now (holdFileLookup): under any of the title's ids, so by the file. */
const heldLookups = new Map<string, Promise<void>>();

/**
 * Holds back the look-up of a file in AIOStreams until `until` ends. Asked for a title's streams,
 * AIOStreams searches every indexer it has, the same sites this addon asks for the episode that is
 * starting, and a site that answers an address one request at a time makes each wait for the other.
 * A file nobody is watching yet (the next episode's, asked ahead) is looked up after.
 */
export function holdFileLookup(filename: string, until: Promise<unknown>): void {
  const key = filename;
  const held: Promise<void> = until.then(() => undefined, () => undefined).finally(() => {
    if (heldLookups.get(key) === held) heldLookups.delete(key);
  });
  heldLookups.set(key, held);
}

/**
 * The streams AIOStreams lists that may be the playing file, likeliest first: its name, the listed
 * size nearest the player's first (two files can share a name, and listed sizes are rounded or
 * estimated); then the names of other versions of its release (a debrid host can serve the first
 * version of a release AIOStreams lists as its second, or the other way round); then its exact size
 * under any name. Those under another name are taken only at the size their host serves (openPlayable).
 *
 * `alias` is the title's other id (an anime episode's Kitsu id beside its IMDb one, or the other way
 * round). AIOStreams keeps a list for each id it is asked with, and a search by one isn't the search by
 * the other: a player's server can list an anime's streams by its Kitsu id and send the subtitle request
 * with the IMDb id. So each place asked for the file by `videoId` is asked by `alias` next when its list
 * lacks the file, before the next place.
 */
export async function streamCandidates(aiostreamsUrl: string, videoId: string, type: string, filename: string, alias?: string): Promise<StreamCandidate[]> {
  await heldLookups.get(filename);
  // Asked for the player's address, the lookup gets the list the player chose from (viewers.ts).
  const viewer = viewerOf(aiostreamsUrl, videoId);
  type Listed = { url?: string; behaviorHints?: { filename?: string; videoSize?: number | string; bingeGroup?: string }; streamData?: unknown };
  const listOf = async (installUrl: string, id = videoId): Promise<Listed[] | undefined> => {
    count("api.aiostreams");
    if (viewer) count("api.aiostreams.forViewer");
    const response = await fetch(`${installUrl.replace(/\/manifest\.json$/, "")}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, {
      // An AIOStreams client's name: AIOStreams then adds its record of each stream's file (streamData).
      headers: { "User-Agent": STREAM_DATA_AGENT, ...(viewer ? { "X-AIOStreams-User-IP": viewer } : {}) },
      signal: AbortSignal.timeout(STREAM_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { streams?: Listed[] };
    return (body.streams ?? []).filter((s) => s.url && s.behaviorHints?.filename);
  };
  const first = await listOf(aiostreamsUrl);
  if (!first) return [];
  let listed = first;
  const size = fileSize(filename);
  const wantedSize = size === undefined ? undefined : Number(size);
  const off = (s: (typeof listed)[number]) => (wantedSize !== undefined && Number(s.behaviorHints!.videoSize) > 0 ? Math.abs(Number(s.behaviorHints!.videoSize) - wantedSize) : Infinity);
  const byNearest = (a: (typeof listed)[number], b: (typeof listed)[number]) => off(a) - off(b);
  const wanted = bareName(fileName(filename));
  const loose = releaseName(fileName(filename));
  // AIOStreams keeps a finished list under the install URL it was asked with, and each player has its
  // own copy of that URL: when this copy's list lacks the file, the configuration's other copies are
  // asked, and the one the player uses answers with the list the player chose from (installUrls.ts).
  const named = () => listed.some((s) => bareName(s.behaviorHints!.filename!) === wanted);
  // The same install URL asked by the title's other id, when its list by this one lacks the file.
  const fromAlias = new Set<string>();
  const byAlias = async (installUrl: string): Promise<boolean> => {
    if (!alias || named()) return false;
    const more = await listOf(installUrl, alias).catch(() => undefined);
    if (!more) return false;
    const had = listed.length;
    const added = more.filter((s) => !listed.some((l) => l.url === s.url));
    for (const s of added) fromAlias.add(s.url!);
    listed = listed.concat(added);
    if (!named()) return false;
    count("sync.aliasList");
    console.log(`sync: ${filename}: not in the list asked for by ${videoId} (${had} streams); it is in the list asked for by ${alias}`);
    return true;
  };
  await byAlias(aiostreamsUrl);
  // The copies AIOStreams put into the account's linked apps come first (read with the account's
  // password, aiostreamsAccount.ts), then the ones the configuration holds.
  const linked = named() ? [] : await linkedInstallUrls(aiostreamsUrl, STREAM_LOOKUP_TIMEOUT_MS);
  const saved = named() ? [] : otherInstallUrls(aiostreamsUrl).filter((url) => !linked.includes(url));
  for (const other of [...linked, ...saved]) {
    const more = await listOf(other).catch(() => undefined);
    if (!more) continue;
    const had = listed.length;
    listed = listed.concat(more.filter((s) => !listed.some((l) => l.url === s.url)));
    if (!named() && (await byAlias(other))) break;
    if (!named()) continue;
    const ofLinked = linked.includes(other);
    count(ofLinked ? "sync.linkedInstallUrl" : "sync.otherInstallUrl");
    console.log(`sync: ${filename}: not in the list this install URL gets (${had} streams); it is in the list ${ofLinked ? "a linked app's install URL" : "another of the configuration's install URLs"} gets`);
    break;
  }
  // A player signed in to AIOStreams' own Jellyfin server has no install URL: the versions that server
  // holds for the title are asked for with a sign-in of the account (aiostreamsJellyfin.ts).
  const itemIds = named() ? [] : [...jellyfinItemIds(videoId, type), ...(alias ? jellyfinItemIds(alias, type) : [])];
  const token = itemIds.length ? await jellyfinToken(aiostreamsUrl, STREAM_LOOKUP_TIMEOUT_MS) : undefined;
  for (const itemId of token ? itemIds : []) {
    count("api.aiostreams.jellyfin");
    const versions = await jellyfinVersions(aiostreamsUrl, token!, itemId, STREAM_LOOKUP_TIMEOUT_MS, viewer).catch(() => undefined);
    if (!versions) continue;
    const had = listed.length;
    const added = versions.filter((v) => !listed.some((l) => l.url === v.url));
    if (alias && !jellyfinItemIds(videoId, type).includes(itemId)) for (const v of added) fromAlias.add(v.url);
    listed = listed.concat(added.map((v) => ({ url: v.url, behaviorHints: { filename: v.filename, videoSize: v.size } })));
    if (!named()) continue;
    count("sync.jellyfinVersions");
    console.log(`sync: ${filename}: in no install URL's list (${had} streams); it is among the ${versions.length} versions AIOStreams' Jellyfin server holds for the title`);
    break;
  }
  const out: StreamCandidate[] = [];
  const listedNames: ReadonlySet<string> = new Set(listed.map((s) => bareName(s.behaviorHints!.filename!)));
  const add = (streams: typeof listed, how: StreamCandidate["how"]) => {
    for (const s of streams) if (!out.some((c) => c.url === s.url)) out.push({ url: s.url!, how, listed: listedNames, ...(fromAlias.has(s.url!) ? { byAlias: true } : {}) });
  };
  add(listed.filter((s) => bareName(s.behaviorHints!.filename!) === wanted).sort(byNearest), "name");
  add(listed.filter((s) => releaseName(s.behaviorHints!.filename!) === loose).sort(byNearest), "loose");
  if (size !== undefined) add(listed.filter((s) => String(s.behaviorHints!.videoSize ?? "") === size), "size");
  // An opened usenet release, listed by the name of the file inside it (INNER_SHARE): only when it is the one that fits.
  if (out.length === 0 && wantedSize !== undefined) {
    const inner = listed.filter((s) => namesNothing(s.behaviorHints!.filename!) && innerSized(Number(s.behaviorHints!.videoSize), wantedSize) && marksIn(s.behaviorHints!.bingeGroup, fileName(filename)));
    if (inner.length === 1) add(inner, "inner");
  }
  // This list's links are remembered, and one an earlier list gave is used when this one lacks the file.
  const now = Date.now();
  const memoryKey = `${aiostreamsUrl}|${videoId}`;
  const names = rememberedStreams.get(memoryKey) ?? new Map<string, { url: string; at: number }>();
  rememberedStreams.delete(memoryKey);
  rememberedStreams.set(memoryKey, names);
  for (const [name, kept] of names) if (now - kept.at >= REMEMBERED_MS) names.delete(name);
  const earlier = out.some((c) => c.how === "name") ? undefined : names.get(wanted);
  for (const s of listed) names.set(bareName(s.behaviorHints!.filename!), { url: s.url!, at: now });
  while (rememberedStreams.size > REMEMBERED_TITLES) rememberedStreams.delete(rememberedStreams.keys().next().value!);
  if (earlier) {
    count("sync.rememberedLink");
    out.unshift({ url: earlier.url, how: "name", remembered: now - earlier.at, listed: listedNames });
    console.log(`sync: ${filename}: not in AIOStreams' list now (${listed.length} streams); its link from the list ${Math.round((now - earlier.at) / 1000)} s ago is tried`);
  }
  // Why a file isn't found is otherwise guessed at afterwards: what AIOStreams listed is said here.
  if (out.length === 0) console.log(`sync: ${filename}: AIOStreams lists ${listed.length} streams for ${videoId}, none under this name${size === undefined ? "" : " or at this size"}`);
  // AIOStreams' record of the playing file, from the one stream that is surely it: its name at the
  // player's size (or its name alone when the player gave none and one stream has it), else its size alone.
  const sameName = listed.filter((s) => bareName(s.behaviorHints!.filename!) === wanted && (size === undefined || String(s.behaviorHints!.videoSize ?? "") === size));
  const sameSize = size === undefined ? [] : listed.filter((s) => String(s.behaviorHints!.videoSize ?? "") === size);
  const surely = sameName.length === 1 ? sameName[0] : sameName.length === 0 && sameSize.length === 1 ? sameSize[0] : undefined;
  if (surely) noteListedFacts(filename, surely.streamData);
  return out;
}

// ---------- what AIOStreams already knows about the playing file ----------

/** The User-Agent of stream lookups: AIOStreams adds its record of each stream's file for a name starting "AIO". */
const STREAM_DATA_AGENT = "AIOStreams/bttrsubs";
/** Records measured from the file itself: AIOStreams' own probe, and StremThru's. Others are matched by name. */
const MEASURED_SOURCES: ReadonlySet<string> = new Set(["local", "stremthru"]);
/** How long a lookup's record of a file is kept for its play. */
const LISTED_FACTS_MS = 30 * 60 * 1000;

/** The playing file's tracks as AIOStreams' record gives them: full text subtitle languages, audio languages, length. */
export interface ListedFacts {
  textLangs: string[];
  audioLangs: string[];
  duration?: number;
}

/**
 * What AIOStreams' record of a stream (its `streamData`) says about the file, when the record was
 * measured from the file (MEASURED_SOURCES); undefined otherwise. Subtitle languages count as
 * fullTextLanguages counts them: text tracks, not signs, songs or forced ones. Languages come as
 * names ("English") and are given as codes; a name not known here is left out of the subtitle
 * languages (so less is skipped) and counts as unknown among the audio ones.
 */
export function factsOfListed(streamData: unknown): ListedFacts | undefined {
  type Track = { lang?: unknown; codec?: unknown; title?: unknown; forced?: unknown };
  const data = streamData as { duration?: unknown; parsedFile?: { mediaInfoSource?: unknown; subtitleTracks?: unknown; audioTracks?: unknown } } | undefined;
  const parsed = data?.parsedFile;
  if (!parsed || typeof parsed.mediaInfoSource !== "string" || !MEASURED_SOURCES.has(parsed.mediaInfoSource)) return undefined;
  const tracks = (value: unknown): Track[] => (Array.isArray(value) ? value.filter((t): t is Track => typeof t === "object" && t !== null) : []);
  const code = (lang: unknown) => (typeof lang === "string" ? languageCode(lang) : undefined);
  const full = (t: Track) => typeof t.codec === "string" && TEXT_CODECS.test(t.codec.toLowerCase()) && t.forced !== true && !/sign|song|forced/i.test(typeof t.title === "string" ? t.title : "");
  const textLangs = [...new Set(tracks(parsed.subtitleTracks).filter(full).map((t) => code(t.lang)).filter((c): c is string => Boolean(c)))];
  const audioLangs = tracks(parsed.audioTracks).map((t) => code(t.lang) ?? "und");
  const duration = typeof data!.duration === "number" && data!.duration > 0 ? data!.duration : undefined;
  return { textLangs, audioLangs, ...(duration ? { duration } : {}) };
}

/**
 * AIOStreams' record of each playing file a lookup found, by file: in memory only, never written to
 * the cache or the log (a stream's record also holds the release's download details). It answers
 * only what the file's own header read hasn't in time (embeddedLanguages, hasEnglishVoices,
 * fileDuration): a first play's list knows the file while its stream is still being opened, and the
 * header read's answer replaces it once it is in.
 */
const listedFacts = new Map<string, ListedFacts & { at: number }>();

function noteListedFacts(filename: string, streamData: unknown): void {
  const facts = factsOfListed(streamData);
  const now = Date.now();
  for (const [key, kept] of listedFacts) if (now - kept.at >= LISTED_FACTS_MS) listedFacts.delete(key);
  if (!facts) return;
  listedFacts.set(filename, { ...facts, at: now });
  count("sync.listedFacts");
}

/** AIOStreams' record of the playing file, while it is fresh, counted where it answers in the header read's place. */
function listedFactsOf(filename: string): ListedFacts | undefined {
  const kept = listedFacts.get(filename);
  if (!kept || Date.now() - kept.at >= LISTED_FACTS_MS) return undefined;
  count("sync.listedFactsUsed");
  return kept;
}

/** For tests: forget every record of a file AIOStreams gave. */
export function forgetListedFacts(): void {
  listedFacts.clear();
}

/**
 * The playing file as one key: its name, and "/<bytes>" when the player sent its size. Synced timing
 * is stored under it, so two different files that share a name (a pack's "S01E06.mkv") don't share
 * timing. A name never holds "/", so the size comes back off unambiguously.
 */
export function fileRef(filename: string, size?: string): string {
  return size && /^[1-9]\d{0,15}$/.test(size) ? `${filename}/${size}` : filename;
}

/**
 * Whose readings a file's are, in front of its ref: "@<10 hex>|" for an AIOStreams account on another
 * instance than this server's own, nothing for an account on this server's own (ownReadings).
 */
const READINGS_SCOPE = /^@[0-9a-f]{10}\|/;

/** Whether an AIOStreams configuration is on this server's own instance (OWN_AIOSTREAMS, reached at AIOSTREAMS_BASE). */
function ownReadings(aiostreamsUrl: string): boolean {
  const origin = (url: string | undefined) => {
    try {
      return url ? new URL(url).origin : undefined;
    } catch {
      return undefined;
    }
  };
  const at = origin(aiostreamsUrl);
  return Boolean(config.ownAiostreams) && at !== undefined && (at === origin(config.ownAiostreams) || at === origin(config.aiostreamsBase));
}

/**
 * The playing file's ref as its readings, sync results and signs are kept under, for the AIOStreams
 * configuration that plays it. What is kept for a file rests on what that configuration's stream
 * list served under the file's name, and a list is whatever the addons in an AIOStreams account
 * answer. Accounts on this server's own AIOStreams, which its owner hands out, share one file's
 * readings; an account on any other instance keeps its own, so nothing it stores under a name reaches
 * anyone else's play. A scope a request sent in the name itself is dropped first.
 */
export function scopedRef(aiostreamsUrl: string | undefined, ref: string): string {
  const bare = ref.replace(READINGS_SCOPE, "");
  if (!aiostreamsUrl || ownReadings(aiostreamsUrl)) return bare;
  return `@${createHash("sha256").update(aiostreamsUrl).digest("hex").slice(0, 10)}|${bare}`;
}

/**
 * One file under two sizes. The size in a ref is the one the player sent, which is the one its stream
 * list gave: a usenet release's listed size until it is opened, the size its host serves after. So the
 * same file, played twice, can come as "name/<listed>" and then "name/<served>", and would be read and
 * synced twice. When a stream listed under the file's own name is opened and serves another size than
 * the ref's, the two refs are tied (noteServedSize): whichever has no readings yet stands for the
 * other from then on (sameFileRef), within the same readings scope.
 */
const sameFiles = new Map<string, string | null>();
const SAME_FILES_KEPT = 5000;

function sameFileFile(ref: string): string {
  return path.join(cachePath("aliases"), `${cacheKey({ kind: "same-file", ref })}.json`);
}

/**
 * A file whose link serves another release. When the release behind a link has failed, AIOStreams
 * serves the next one it listed under that same link, and the answer's own Content-Disposition names
 * it. What is read is then that release, so it is kept under that release's own name and size, where
 * a play of it by name finds it too. The played name stands for it only for STAND_IN_KEPT_MS: a link
 * is asked again after that, since failover can settle on another release another day, and nothing
 * read of one release may be taken for another's.
 */
const standIns = new Map<string, { ref: string; until: number }>();
/** Refs known to have no stand-in on record, so their record isn't looked for on every request. */
const noStandIn = new Set<string>();
const STAND_IN_KEPT_MS = 6 * 60 * 60 * 1000;

function standInFile(ref: string): string {
  return path.join(cachePath("aliases"), `${cacheKey({ kind: "stand-in", ref })}.json`);
}

/** The ref a played file's link serves in its place, while that is known here. */
function standInFor(ref: string): string | undefined {
  const kept = standIns.get(ref);
  if (!kept) return undefined;
  if (Date.now() < kept.until) return kept.ref;
  standIns.delete(ref);
  return undefined;
}

/** The ref what is read of a played file is kept under: the release its link serves in its place, while that is known. */
export function readingsRef(filename: string): string {
  return standInFor(filename) ?? filename;
}

/** The same, from the record kept on disk: a stand-in noted before this server last started. */
async function keptStandIn(ref: string): Promise<string | undefined> {
  if (noStandIn.has(ref)) return undefined;
  try {
    const kept = JSON.parse(await readFile(standInFile(ref), "utf8")) as { ref?: unknown; until?: unknown };
    if (typeof kept.ref === "string" && kept.ref && typeof kept.until === "number" && Date.now() < kept.until) {
      standIns.set(ref, { ref: kept.ref, until: kept.until });
      return kept.ref;
    }
  } catch {}
  if (noStandIn.size >= SAME_FILES_KEPT) noStandIn.clear();
  noStandIn.add(ref);
  return undefined;
}

/** The link of the stream listed under this file's name serves another listed release, `name` at `served` bytes. */
export async function noteStandIn(filename: string, name: string, served: string): Promise<void> {
  const ref = `${READINGS_SCOPE.exec(filename)?.[0] ?? ""}${name}/${served}`;
  const until = Date.now() + STAND_IN_KEPT_MS;
  if (standIns.size >= SAME_FILES_KEPT) standIns.clear();
  standIns.set(filename, { ref, until });
  noStandIn.delete(filename);
  await mkdir(cachePath("aliases"), { recursive: true });
  await writeFile(standInFile(filename), JSON.stringify({ ref, until }));
  count("sync.standInFile");
  console.log(`sync: ${fileName(filename)}: its link serves ${name} (${served} bytes), another release listed for the title: read and kept as that file`);
}

export function forgetStandIns(): void {
  standIns.clear();
  noStandIn.clear();
}

/**
 * The ref a file's readings are kept under: the release its link serves in its place, while that is
 * known; else the one it was first read as, when this ref is the same file under another size.
 */
export async function sameFileRef(ref: string): Promise<string> {
  const standIn = standInFor(ref) ?? (await keptStandIn(ref));
  if (standIn) return standIn;
  let to = sameFiles.get(ref);
  if (to === undefined) {
    try {
      const kept = JSON.parse(await readFile(sameFileFile(ref), "utf8")) as { ref?: unknown };
      to = typeof kept.ref === "string" && kept.ref && fileName(kept.ref) === fileName(ref) ? kept.ref : null;
    } catch {
      to = null;
    }
    if (sameFiles.size >= SAME_FILES_KEPT) sameFiles.clear();
    sameFiles.set(ref, to);
  }
  return to ?? ref;
}

/**
 * The host serves `served` bytes for the stream listed under this file's own name: when that isn't the
 * size in its ref, the ref with the served size is the same file. The one of the two with readings
 * stands for the other; when both or neither have, this ref does (it is the one being read now).
 */
export async function noteServedSize(filename: string, served: string): Promise<void> {
  if (!/^[1-9]\d{0,15}$/.test(served) || fileSize(filename) === served) return;
  const other = `${READINGS_SCOPE.exec(filename)?.[0] ?? ""}${fileName(filename)}/${served}`;
  const has = (ref: string) => readFile(anchorsFile(ref)).then(() => true, () => false);
  const [from, to] = (await has(other)) && !(await has(filename)) ? [filename, other] : [other, filename];
  if ((await sameFileRef(from)) === to) return;
  await mkdir(cachePath("aliases"), { recursive: true });
  await writeFile(sameFileFile(from), JSON.stringify({ ref: to, at: new Date().toISOString() }));
  sameFiles.set(from, to);
  sameFiles.delete(to);
  count("sync.sameFile");
  console.log(`sync: ${fileName(filename)}: listed at ${fileSize(filename) ?? "no size"}, served at ${served} bytes: one file, kept under ${fileSize(to) ?? "no size"}`);
}

/** The file name in a fileRef. */
export function fileName(ref: string): string {
  return ref.replace(READINGS_SCOPE, "").replace(/\/\d+$/, "");
}

function fileSize(ref: string): string | undefined {
  return /\/(\d+)$/.exec(ref)?.[1];
}

/** Usenet streams can name the file without its extension, so names are compared without one. */
function bareName(name: string): string {
  return name.toLowerCase().replace(/\.(mkv|mp4|avi|m4v|webm|ts)$/, "");
}

/**
 * A file's name without what changes between versions of the same release: the checksum tag
 * ("[1A2B3C4D]") and the version after the episode ("01v2"). Names alike this way are other
 * versions, so different files unless their size says otherwise (see streamCandidates).
 */
export function releaseName(name: string): string {
  return bareName(name)
    .replace(/\[[0-9a-f]{8}\]/g, "")
    .replace(/(\d)v\d\b/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface Probe {
  duration: number;
  track?: number;
  /** Picture subtitles (Blu-ray PGS, DVD): only their timing is read. */
  image?: boolean;
  /** More text tracks, next best first, read in the same pass as `track` (see trackChoice). */
  others?: number[];
  /** The language of `track` and each of `others`, by index, where tagged (see tracksToTry). */
  trackLangs?: Record<string, string>;
  /** The audio track whose speech can stand in when there's no subtitle track (see pickAudio). */
  audio?: number;
  /** Its language as tagged, when it is. */
  audioLang?: string;
  /** Languages of the file's full text subtitle tracks (see fullTextLanguages). */
  languages: string[];
  /** Bits per second over the whole file, when the header says. */
  bitrate?: number;
}

const TEXT_CODECS = /^(ass|ssa|subrip|srt|webvtt|mov_text|text)$/;
const IMAGE_CODECS = /^(hdmv_pgs_subtitle|dvd_subtitle)$/;

type ProbedStream = { index: number; codec_type?: string; codec_name?: string; tags?: { language?: string; title?: string }; disposition?: { forced?: number } };

/**
 * Languages the file already has full subtitles in: text tracks, not signs, songs or forced lines,
 * as tagged ("ara", "eng"). Picture tracks (PGS) don't count: many players have to burn them in.
 */
export function fullTextLanguages(streams: ProbedStream[]): string[] {
  const signs = (s: ProbedStream) => /sign|song|forced/i.test(s.tags?.title ?? "") || Boolean(s.disposition?.forced);
  const tags = streams
    .filter((s) => s.codec_type === "subtitle" && TEXT_CODECS.test(s.codec_name ?? "") && !signs(s))
    .map((s) => (s.tags?.language ?? "").toLowerCase())
    .filter((l) => l && l !== "und");
  return [...new Set(tags)];
}

export function pickTrack(streams: ProbedStream[]): ProbedStream | undefined {
  return rankTracks(streams)[0];
}

/**
 * The file's subtitle tracks to time by, best first. Only their timing is used, never their words,
 * so the language matters little: a text track in any language beats a picture one (PGS, VobSub),
 * whose line times are known less exactly. Then English, then tracks titled Full or Dialogue. Signs,
 * songs and forced tracks time too few lines and are never candidates.
 */
export function rankTracks(streams: ProbedStream[]): ProbedStream[] {
  const signs = (s: ProbedStream) => /sign|song|forced/i.test(s.tags?.title ?? "") || Boolean(s.disposition?.forced);
  const usable = streams.filter((s) => s.codec_type === "subtitle" && (TEXT_CODECS.test(s.codec_name ?? "") || IMAGE_CODECS.test(s.codec_name ?? "")) && !signs(s));
  const rank = (s: ProbedStream) => {
    const language = s.tags?.language ?? "";
    let r = 0;
    if (TEXT_CODECS.test(s.codec_name ?? "")) r += 50;
    if (/^(eng?|und)?$/i.test(language)) r += 20;
    if (/^eng?$/i.test(language)) r += 1;
    if (/full|dialog/i.test(s.tags?.title ?? "")) r += 2;
    return r;
  };
  return [...usable].sort((x, y) => rank(y) - rank(x) || x.index - y.index);
}

/** More text tracks read beside the first one, to time by when it doesn't fit (see trackChoice). */
const MAX_OTHER_TRACKS = 2;

/** The language each of these tracks is tagged with, by index; untagged ("und") ones are left out. */
function trackLanguages(streams: ProbedStream[], indexes: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const index of indexes) {
    const language = streams.find((s) => s.index === index)?.tags?.language?.toLowerCase();
    if (language && language !== "und") out[String(index)] = language;
  }
  return out;
}

/**
 * Beside the tracks kept to time every language by (`kept`), the best ranked text track in each
 * other language the file has: captions in that language are timed by it first (see tracksToTry),
 * since the file's own translation splits and places its lines the way an upload in that language
 * does, and the English track's lines sit a little apart from them.
 */
export function languageTracks(ranked: ProbedStream[], kept: number[]): number[] {
  const seen = new Set(Object.values(trackLanguages(ranked, kept)));
  const out: number[] = [];
  for (const s of ranked) {
    const language = s.tags?.language?.toLowerCase();
    if (kept.includes(s.index) || !TEXT_CODECS.test(s.codec_name ?? "") || !language || language === "und" || seen.has(language)) continue;
    seen.add(language);
    out.push(s.index);
  }
  return out;
}

/**
 * The audio track to hear speech in: English first (dub captions follow the English dub), then the
 * file's default track, then the first one.
 */
export function pickAudio(streams: Array<ProbedStream & { disposition?: { default?: number } }>): number | undefined {
  const audio = streams.filter((s) => s.codec_type === "audio");
  const rank = (s: (typeof audio)[number]) => (/^eng?$/i.test(s.tags?.language ?? "") ? 2 : 0) + (s.disposition?.default ? 1 : 0);
  return [...audio].sort((a, b) => rank(b) - rank(a))[0]?.index;
}

/**
 * The link served something other than the listed file: a debrid file that isn't ready yet comes back
 * as a short clip of a few MB. Nothing read from it is kept, and the next request reads again.
 */
export class NotTheFile extends Error {
  override name = "NotTheFile";
}

/**
 * A failure that has been said once for this file already: the file isn't in AIOStreams' list (said
 * when it was looked for), or its header wasn't read (said by the read that failed). Every subtitle
 * synced to the file meets it again, so it is logged each time and listed as an error only the once.
 */
export class AlreadySaid extends Error {
  override name = "AlreadySaid";
}

/**
 * Whether what a link served can be the listed file. A stand-in clip is a few MB and seconds long; a
 * file in a pack can be listed at the whole pack's size, so only an answer both far smaller than the
 * listed size and short is taken for a stand-in. Unknown sizes pass.
 */
export function servesListedFile(listed: number | undefined, served: number | undefined, durationMs: number): boolean {
  if (!listed || !served) return true;
  return !(served < listed * STAND_IN_SHARE && durationMs < STAND_IN_MAX_MS);
}
/** A stand-in is under this share of the listed size, and shorter than STAND_IN_MAX_MS. */
const STAND_IN_SHARE = 0.1;
const STAND_IN_MAX_MS = 120_000;

/** ffprobe's answer, as far as probe reads it. */
type ProbeJson = {
  format?: { duration?: string; bit_rate?: string; size?: string };
  streams?: Array<{ index: number; codec_type?: string; codec_name?: string; tags?: { language?: string; title?: string }; disposition?: { forced?: number; default?: number } }>;
};

/** ffprobe's names for the Matroska codec ids the probe's checks look at (TEXT_CODECS, IMAGE_CODECS). */
const MKV_CODEC_NAMES: Array<[RegExp, string]> = [
  [/^S_(TEXT\/)?ASS$/, "ass"],
  [/^S_(TEXT\/)?SSA$/, "ssa"],
  [/^S_TEXT\/(UTF8|ASCII)$/, "subrip"],
  [/^S_TEXT\/WEBVTT$|^D_WEBVTT/, "webvtt"],
  [/^S_HDMV\/PGS$/, "hdmv_pgs_subtitle"],
  [/^S_VOBSUB$/, "dvd_subtitle"]
];
export const codecNameOf = (codec: string): string => MKV_CODEC_NAMES.find(([pattern]) => pattern.test(codec))?.[1] ?? codec.toLowerCase();

/**
 * A Matroska file's header as ffprobe gives it, from mkv.ts's read of the file's first part (one read,
 * shared with the language, index and hash reads). ffprobe reads on through the fonts many anime files
 * attach before their first cluster, a request at a time. Calibration (11-16): 6.5 MB in 26 requests of
 * 256 KB, 14.5-15 s from a debrid CDN, on three 480p/720p releases. Undefined for another format, or a
 * header that names no tracks or no duration: ffprobe reads those.
 */
async function mkvHeader(url: string): Promise<ProbeJson | undefined> {
  const found = await readMkvTracks(url).catch(() => undefined);
  if (!found || !found.duration) return undefined;
  const size = (await sharedHead(url)?.catch(() => undefined))?.size;
  const seconds = found.duration / 1000;
  return {
    format: { duration: String(seconds), ...(size ? { size: String(size), bit_rate: String(Math.round((size * 8) / seconds)) } : {}) },
    streams: found.tracks.map((t) => ({
      index: t.index,
      ...(t.type !== "other" ? { codec_type: t.type } : {}),
      codec_name: codecNameOf(t.codec),
      tags: { language: t.languageIso ?? t.language, ...(t.name ? { title: t.name } : {}) },
      disposition: { forced: t.forced ? 1 : 0, default: t.default ? 1 : 0 }
    }))
  };
}

/**
 * Duration, the embedded subtitle track to time against (see pickTrack), and the audio track. With
 * the listed size (`listed`, bytes), a link serving something else throws NotTheFile.
 */
async function probe(url: string, listed?: number): Promise<Probe> {
  // The header alone, by bounded range requests: an open-ended one ("bytes=0-") keeps the host sending
  // until ffprobe hangs up, and reading packets past the header adds nothing asked for here.
  // Calibration (over HTTP): the same answer from one 64 KB request on a 3.9 GB Matroska file, against
  // 5 to 7.8 MB sent open-ended; on a remux with 7 picture tracks, in 430 ms against 436 ms.
  const ask = async (headerOnly: boolean) =>
    JSON.parse(
      await run("ffprobe", [...PROTOCOLS, "-initial_request_size", "65536", "-request_size", "262144", ...(headerOnly ? ["-probesize", "65536", "-analyzeduration", "0"] : []), "-v", "error", "-show_entries", "format=duration,bit_rate,size:stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=forced,default", "-of", "json", url], 30000)
    ) as ProbeJson;
  // A Matroska file is read by its own header (mkvHeader), anything else by ffprobe.
  const fromMkv = await mkvHeader(url);
  if (fromMkv) count("sync.probeMkv");
  let json = fromMkv ?? (await ask(true));
  // A format with no stream list in a header (MPEG-TS) shows its streams only once packets are read.
  if (!(json.streams ?? []).some((s) => s.codec_type === "audio" || s.codec_type === "video")) json = await ask(false);
  const ranked = rankTracks(json.streams ?? []);
  const track = ranked[0];
  const image = track ? IMAGE_CODECS.test(track.codec_name ?? "") : undefined;
  // Text tracks only: a picture track would take a read of its own per window.
  const others = image ? [] : ranked.slice(1).filter((s) => TEXT_CODECS.test(s.codec_name ?? "")).slice(0, MAX_OTHER_TRACKS).map((s) => s.index);
  const trackLangs = track ? trackLanguages(ranked, [track.index, ...others]) : {};
  const served = Number(json.format?.size) || undefined;
  if (!servesListedFile(listed, served, Number(json.format?.duration ?? 0) * 1000)) {
    throw new NotTheFile(`the link served ${Math.round((served ?? 0) / 1e6)} MB (${Math.round(Number(json.format?.duration ?? 0))} s), not the ${Math.round((listed ?? 0) / 1e6)} MB file listed; it may not be ready yet`);
  }
  const audio = pickAudio(json.streams ?? []);
  const audioLang = json.streams?.find((s) => s.index === audio)?.tags?.language;
  return {
    duration: Number(json.format?.duration ?? 0) * 1000,
    ...(Number(json.format?.bit_rate) > 0 ? { bitrate: Number(json.format?.bit_rate) } : {}),
    track: track?.index,
    image,
    ...(others.length ? { others } : {}),
    ...(Object.keys(trackLangs).length ? { trackLangs } : {}),
    audio,
    ...(audioLang ? { audioLang } : {}),
    languages: fullTextLanguages(json.streams ?? [])
  };
}

// ---------- speech in the audio, for files without subtitles ----------

/** Whether a file with no subtitle track is synced to the speech in its audio (see bySpeech). */
export const SPEECH_SYNC = true;

/** Mono at 16 kHz, as Silero hears it (src/vad.ts). */
const SPEECH_AUDIO = ["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le"];
const SPEECH_RATE = 16000;
const FRAME_MS = 20;

/**
 * Where people speak in a stretch of audio (16 kHz mono, 16-bit), as cues starting at `from`. Loud
 * frames against the stretch's own quiet: the threshold sits between its floor and its peaks, so a
 * quiet scene and a loud one are judged alike. Short gaps join, short blips go, and stretches too
 * long to be one line of dialogue (music, action) are left out.
 */
export function speechCues(pcm: Buffer, from: number): Cue[] {
  const frameSamples = (SPEECH_RATE * FRAME_MS) / 1000;
  const levels: number[] = [];
  for (let offset = 0; offset + frameSamples * 2 <= pcm.length; offset += frameSamples * 2) {
    let sum = 0;
    for (let i = 0; i < frameSamples; i++) {
      const sample = pcm.readInt16LE(offset + i * 2);
      sum += sample * sample;
    }
    levels.push(10 * Math.log10(sum / frameSamples / (32768 * 32768) + 1e-12));
  }
  if (levels.length < 50) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)];
  const peak = sorted[Math.floor(sorted.length * 0.95)];
  if (peak - floor < 10) return []; // no contrast: silence, or wall-to-wall sound
  const threshold = Math.max(floor + 0.35 * (peak - floor), -60);
  const spans: Cue[] = [];
  levels.forEach((level, i) => {
    if (level < threshold) return;
    const start = i * FRAME_MS;
    const last = spans[spans.length - 1];
    if (last && start - last.end <= 300) last.end = start + FRAME_MS;
    else spans.push({ start, end: start + FRAME_MS });
  });
  return spans.filter((s) => s.end - s.start >= 250 && s.end - s.start <= 12000).map((s) => ({ start: from + s.start, end: from + s.end }));
}

/** A temporary file under the cache (the container's own disk is read-only). */
async function tempFile(ext: string): Promise<string> {
  await mkdir(cachePath("tmp"), { recursive: true });
  return path.join(cachePath("tmp"), `${randomUUID()}.${ext}`);
}

/**
 * Speech in [from, from + length) of the file, from its audio track: for files with no subtitle track.
 * Read here and piped into ffmpeg when the file's layout allows (audiowindow.ts: one request where ffmpeg
 * makes four or five); else, or when that fails short of a refusal, ffmpeg reads the file's address itself.
 */
async function readSpeechWindow(url: string, audio: number, from: number, length: number): Promise<Cue[]> {
  const pcm = await tempFile("pcm");
  try {
    const direct = await openAudioWindow(url, audio, from, length).catch((error) => {
      if (error instanceof ReadsPaused || refusalStatus(error instanceof Error ? error.message : String(error))) throw error;
      console.error(`sync: audio at ${Math.round(from / 1000)}s not opened here (${scrub(error instanceof Error ? error.message : String(error))}): ffmpeg reads it`);
      return undefined;
    });
    if (direct) {
      try {
        await runFed(["-v", "error", ...direct.input, ...direct.output, ...SPEECH_AUDIO, "-y", pcm], direct, 60000);
        count("sync.directWindows");
        count("sync.directBytes", direct.received());
        count("sync.directRanges", direct.ranges);
        return await heardSpeech(await readFile(pcm), from);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ReadsPaused || refusalStatus(message)) throw error;
        count("sync.directFallback");
        console.error(`sync: audio at ${Math.round(from / 1000)}s not read here (${scrub(message)}): ffmpeg reads it`);
      }
    }
    await run("ffmpeg", [...PROTOCOLS, "-v", "error", "-ss", (from / 1000).toFixed(3), "-i", url, "-map", `0:${audio}`, "-t", (length / 1000).toFixed(3), ...SPEECH_AUDIO, "-y", pcm], 60000);
    return await heardSpeech(await readFile(pcm), from);
  } finally {
    await rm(pcm, { force: true });
  }
}

/**
 * Embedded dialogue lines in [from, from + length) of the file, ms. The seek
 * (-ss before -i) uses the file's index; the end must be an output -to, since
 * an input -t on a subtitle-only map doesn't stop the read and ffmpeg would
 * go through the whole file.
 */
/** One window's lines from the first track, speech heard in it, and the other text tracks' lines by track index. */
type WindowRead = { cues: Cue[]; speech?: Cue[]; others?: Record<string, Cue[]> };

/** As readWindowAndSpeech, but a failure hearing the audio never costs the lines: read again without it. */
async function readWindowAndSpeechSafely(url: string, track: number, audio: number | undefined, from: number, length: number, others: number[] = []): Promise<WindowRead> {
  if (audio === undefined) return readWindowAndSpeech(url, track, undefined, from, length, others);
  try {
    return await readWindowAndSpeech(url, track, audio, from, length, others);
  } catch (error) {
    console.error(`sync: speech not heard at ${Math.round(from / 1000)}s: ${scrub(error instanceof Error ? error.message : String(error))}`);
    return readWindowAndSpeech(url, track, undefined, from, length, others);
  }
}

/**
 * The window's dialogue lines and, from the same read, where people speak in it: the audio comes in
 * the same stretch of the file, so hearing it costs no extra download. Speech is kept beside the
 * lines (see FileAnchors) to measure how well it would time a file that has no subtitles.
 */
async function readWindowAndSpeech(url: string, track: number, audio: number | undefined, from: number, length: number, others: number[] = []): Promise<WindowRead> {
  const to = ((from + length) / 1000).toFixed(3);
  const pcm = audio === undefined ? undefined : await tempFile("pcm");
  // The other text tracks come in the same stretch of the file: writing them out costs no extra read.
  const extra = await Promise.all(others.map(async (index) => ({ index, file: await tempFile("ass") })));
  try {
    const out = await run(
      "ffmpeg",
      [
        ...PROTOCOLS, "-v", "error", "-probesize", "1000000", "-analyzeduration", "0",
        "-copyts", "-ss", (from / 1000).toFixed(3), "-i", url,
        "-map", `0:${track}`, "-to", to, "-c:s", "ass", "-f", "ass", "pipe:1",
        ...extra.flatMap(({ index, file }) => ["-map", `0:${index}`, "-to", to, "-c:s", "ass", "-f", "ass", "-y", file]),
        ...(pcm ? ["-map", `0:${audio}`, "-to", to, ...SPEECH_AUDIO, "-y", pcm] : [])
      ],
      pcm ? 60000 : 30000
    );
    const inWindow = (cues: Cue[]) => cues.filter((c) => c.start >= from && c.end <= from + length);
    const cues = inWindow(dialogueCues(out));
    const read: Record<string, Cue[]> = {};
    for (const { index, file } of extra) {
      try {
        read[index] = inWindow(dialogueCues(await readFile(file, "utf8")));
      } catch {}
    }
    let speech: Cue[] | undefined;
    if (pcm) {
      try {
        speech = await heardSpeech(await readFile(pcm), from);
      } catch {}
    }
    return { cues, ...(speech ? { speech } : {}), ...(Object.keys(read).length ? { others: read } : {}) };
  } finally {
    if (pcm) await rm(pcm, { force: true });
    await Promise.all(extra.map(({ file }) => rm(file, { force: true })));
  }
}

/**
 * Display times of a picture subtitle track in the window. A picture packet
 * shows a line and the next (tiny, clearing) packet ends it, so only packet
 * times and sizes are read (ffprobe -read_intervals), nothing is decoded.
 */
async function readImageWindow(url: string, track: number, from: number, length: number): Promise<Cue[]> {
  const out = await run(
    "ffprobe",
    [
      ...PROTOCOLS, "-v", "error", "-read_intervals", `${(from / 1000).toFixed(3)}%+${(length / 1000).toFixed(3)}`,
      "-select_streams", String(track), "-show_entries", "packet=pts_time,size", "-of", "csv=p=0", url
    ],
    30000
  );
  return imageCues(out).filter((c) => c.start >= from && c.end <= from + length);
}

/** "pts,size" rows to cues: a packet over 100 bytes shows a line until the next packet. */
export function imageCues(csv: string): Cue[] {
  const packets = csv
    .trim()
    .split(/\r?\n/)
    .map((row) => row.split(","))
    .map(([pts, size]) => ({ at: Math.round(Number(pts) * 1000), size: Number(size) }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.size))
    .sort((a, b) => a.at - b.at);
  const cues: Cue[] = [];
  for (let i = 0; i < packets.length - 1; i++) {
    const end = packets[i + 1].at;
    if (packets[i].size > 100 && end > packets[i].at && end - packets[i].at < 15000) cues.push({ start: packets[i].at, end });
  }
  return cues;
}

export interface FileAnchors {
  /** The file these were read from, kept for the replay check (scripts/replay.ts). */
  filename?: string;
  duration: number;
  /** bridge: read only to place a step between two anchors, not measured on its own. */
  windows: Array<{ from: number; to: number; cues: Cue[]; bridge?: boolean; speech?: Cue[]; others?: Record<string, Cue[]>; langs?: Record<string, Cue[]>; heard?: boolean }>;
  /** Bits per second, from the header: heavy files get shorter windows (windowMs). */
  bitrate?: number;
  /** "index": the lines come from the Matroska index, over the whole file (indexAnchors); heard windows hold only speech. */
  source?: "index";
  /** More text tracks read in each window (their lines in windows[].others), next best first: see trackChoice. */
  others?: number[];
  /**
   * From the index only: the best text track in each other language the file has (see
   * languageTracks), their lines in windows[].langs, to time captions in their own language.
   */
  langTracks?: number[];
  /** The language of `track` and of each of `others` and `langTracks`, by index, where tagged; unknown on older records. */
  trackLangs?: Record<string, string>;
  /** The embedded track the windows were read from, for reading more of them later. */
  track?: number;
  image?: boolean;
  /** The audio track speech is heard in (see pickAudio). */
  audio?: number;
  /** That audio track's language as tagged ("eng", "jpn"); unknown on older records. */
  audioLang?: string;
  /**
   * No subtitle track: the windows' cues are where people speak, heard in the audio. Otherwise the
   * windows also keep their speech beside the lines, to measure how well speech times a file.
   */
  speechOnly?: boolean;
  /**
   * How many rounds of extra windows have been read (at most MAX_ROUNDS). For a file with no
   * subtitle track, at most STEP_ROUND: the audio heard at MORE_SPOTS, then at the spots a step
   * calls for (see hearMoreSpeech).
   */
  rounds?: number;
  /**
   * On a file with no windows: written since files with no subtitle track are timed by speech.
   * Older empty records don't count (the file may have audio to time by): it is probed again.
   */
  speechChecked?: boolean;
  /** How the windows' speech was heard: "silero" (src/vad.ts). Older speech, from loudness alone, isn't used. */
  speechBy?: "silero";
  /** Languages the file already has full text subtitles in (see fullTextLanguages); unknown on older records. */
  subtitleLangs?: string[];
}

/**
 * A stored record still worth trusting: empty ones from before speech sync, and speech-only ones
 * heard by loudness alone, are read again.
 */
export function stillValid(found: FileAnchors): boolean {
  if (found.speechOnly) return found.speechBy === "silero";
  return found.windows.length > 0 || Boolean(found.speechChecked);
}

const WINDOW_SPOTS = [0.15, 0.32, 0.5, 0.68, 0.85];
const WINDOW_MS = 40000;
/**
 * A window's length for a file of this bit rate: 40 s, shorter for files so heavy that 40 s is
 * hundreds of MB (a 2160p remux carries about 10 times a web release's data per second), down to 20 s.
 * Reading 5 of them at 70 Mb/s took over 8 s, past what a player waits for its subtitle.
 */
export function windowMs(bitrate: number | undefined): number {
  if (!bitrate) return WINDOW_MS;
  return Math.round(Math.min(WINDOW_MS, Math.max(MIN_WINDOW_MS, ((WINDOW_BYTES * 8) / bitrate) * 1000)));
}
const MIN_WINDOW_MS = 20000;
/** About this much of a file per window. */
const WINDOW_BYTES = 60 * 1024 * 1024;

const fileAnchorJobs = new Map<string, Promise<FileAnchors | undefined>>();
/**
 * Resolved playback URLs, kept in memory only (they expire), for reading extra windows. Each is kept
 * for the AIOStreams that listed it (playKey): a file is read at the address its own viewer's
 * AIOStreams gave, on that viewer's account, never at one resolved for someone else.
 */
const playbackUrls = new Map<string, { url: string; at: number }>();
/** A file as one AIOStreams configuration lists it: the key of its playback URL and its lookup. */
const playKey = (aiostreamsUrl: string, filename: string) => `${aiostreamsUrl}
${filename}`;

function anchorsFile(filename: string): string {
  // A file whose link serves another release is read as that release, and kept as it (standIns).
  return path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename: readingsRef(filename) })}.json`);
}

/**
 * Files AIOStreams didn't list, by when that was seen. A player names the stream that was picked; when
 * it was dead and AIOStreams failed over to another one, the picked one drops out of later lists:
 * AIOStreams drops a failed NZB from later lists, and which file failover played is known only to it, so lists show
 * these tracks unsynced: timing from the named file would be wrong for the one playing. The list is
 * asked for a few times first (see lookUpStreamAgain); after that the lookup isn't repeated for
 * UNLISTED_MS.
 */
const unlisted = new Map<string, number>();
const UNLISTED_MS = 10 * 60 * 1000;
/** A search through every indexer can take a while the first time (one ran past 20 s); nothing waits on it but the sync. */
const STREAM_LOOKUP_TIMEOUT_MS = 45 * 1000;
/** One lookup per file and AIOStreams configuration at a time (playKey): the header read and the windows share it, so indexers are searched once. */
const lookups = new Map<string, Promise<string | undefined>>();

/** The playing file's likeliest stream URL from AIOStreams, by its name (see streamCandidates; unchecked). */
export async function lookUpStream(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<string | undefined> {
  return (await streamCandidates(aiostreamsUrl, videoId, type, filename))[0]?.url;
}

/** Listed streams tried for the playing file, at most, each with one 1-byte read. */
const MAX_CANDIDATES = 4;

/** An IMDb episode's id as the anime lists number it ("tt1:2:12" -> "kitsu:1000:37"); undefined for anything else. */
async function animeEpisodeId(videoId: string): Promise<string | undefined> {
  const own = /^(tt\d+):(\d+):(\d+)$/.exec(videoId);
  if (!own) return undefined;
  return kitsuEpisode(own[1], Number(own[2]), Number(own[3]));
}

/**
 * The URL to read the playing file at: the first of AIOStreams' candidates (streamCandidates) that is
 * the file, asking again when none is. A candidate is opened with a 1-byte read, its redirects
 * followed hop by hop (so a host whose reads are paused is named before it's asked, and gets no
 * request). One listed under the file's own name is the file; one under another name (another
 * version of its release, or its size) only when its host serves the size the player sent, to the byte.
 * AIOStreams' list for one title differs from one request to the next (a slow source misses one
 * answer and is in the next): a film's file wasn't in the list asked for at play and was in one asked
 * for a minute later, and two lists a second apart differed. It is asked again after each of `waits`
 * before the file counts as unlisted. A release AIOStreams replaces with another when its link is
 * opened is still found by its name: its link serves the one that plays (standInFile).
 * An anime episode asked for by its IMDb id has a second id, the one the anime lists give it
 * ("kitsu:1000:37"), and AIOStreams keeps a list for each (streamCandidates' `alias`): a player's
 * server that lists anime by Kitsu ids shows that list, while the subtitle request it sends carries the
 * IMDb id. And an IMDb episode's list places a file numbered with no season ("Show 037") by counting
 * the earlier seasons' episodes, which AIOStreams does with an episode 0 a listing carries in one
 * answer and without it in the next, one episode apart; the anime's own number needs no count. So a
 * file its own list lacks is asked for by that id too, once, at each place before the next.
 */
export async function lookUpStreamAgain(aiostreamsUrl: string, videoId: string, type: string, filename: string, waits: number[] = LOOKUP_RETRY_MS): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    // The anime lists' id for the episode, asked for where a list by the episode's own id lacks the file.
    const alias = attempt === 0 && waits.length > 0 && type === "series" ? await animeEpisodeId(videoId).catch(() => undefined) : undefined;
    const candidates = attempt === 0 ? await streamCandidates(aiostreamsUrl, videoId, type, filename, alias) : await streamCandidates(aiostreamsUrl, videoId, type, filename).catch(() => []);
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      const url = await openPlayable(candidate, filename);
      if (!url) continue;
      if (candidate.remembered !== undefined) {
        count("sync.unlistedRecovered");
        console.log(`sync: ${filename}: read through its link from the earlier list`);
      }
      if (attempt > 0) {
        count("sync.lookupRetryFound");
        console.log(`sync: ${filename}: not in AIOStreams' list at first, found on asking again`);
      }
      return url;
    }
    if (attempt >= waits.length) return undefined;
    await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    count("sync.lookupRetry");
  }
}

/**
 * A stream under the file's own name that serves less than this share of the file's size is a
 * stand-in, not the file. Calibration (11-18): hosts served files listed under their own name at
 * 0.81 to 1.00 of the size played (a usenet release's listed size is its whole NZB); the clip
 * AIOStreams answers with when every release failed was 19,856 and 21,982 bytes for files of 13.4
 * and 14.2 GB, under 0.000002.
 */
const SLIVER_SHARE = 0.1;

/** The file name a Content-Disposition header gives: its encoded form (filename*) where there is one, else the quoted or bare one. */
export function servedName(header: string | null): string | undefined {
  if (!header) return undefined;
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim()) || undefined;
    } catch {}
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/.exec(header);
  const name = plain?.[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain?.[2]?.trim();
  return name || undefined;
}

/** A candidate's URL, resolved past its redirects, when it is the playing file (see lookUpStreamAgain); undefined when it isn't. */
async function openPlayable(candidate: StreamCandidate, filename: string): Promise<string | undefined> {
  const signal = AbortSignal.timeout(LINK_OPEN_TIMEOUT_MS);
  let at = reachedFromHere(candidate.url);
  let head = await fetchFile(at, { headers: { Range: "bytes=0-0" }, redirect: "manual", signal });
  for (let hop = 0; hop < MAX_REDIRECTS && head.status >= 300 && head.status < 400 && head.headers.get("location"); hop++) {
    await head.body?.cancel();
    at = reachedFromHere(new URL(head.headers.get("location")!, at).toString());
    checkHost(at);
    head = await fetchFile(at, { headers: { Range: "bytes=0-0" }, redirect: "manual", signal });
  }
  await head.arrayBuffer();
  if (head.status === 403 || head.status === 429) noteRefusal(at, head.status);
  const url = head.ok ? at : reachedFromHere(candidate.url);
  checkReads(url);
  // The size the host serves: the whole of a range answer, or the length of a whole-file one.
  const served = head.status === 206 ? /\/(\d+)\s*$/.exec(head.headers.get("content-range") ?? "")?.[1] : head.ok ? head.headers.get("content-length") : null;
  // A stream under the file's own name, its checksum tag and version included, is the file. The size a
  // player sends is the one the list gave (a usenet release's whole NZB until it is opened, a debrid
  // addon's own figure), not always what the host serves, so it doesn't overrule the name. Calibration
  // (11-15): a debrid file listed and played at 389,021,696 bytes was served at 389,021,204; a usenet
  // release played at 503,747,903 was served at 408,174,337.
  if (candidate.how === "name") {
    // A remembered link that no longer opens has run out: the file stays unfound.
    if (candidate.remembered !== undefined && !head.ok) {
      console.log(`sync: ${filename}: its remembered link answers HTTP ${head.status}`);
      return undefined;
    }
    // A link that serves a sliver of the file's size isn't serving the file: when every release
    // behind a link has failed, AIOStreams answers it with a short clip that says so. Reading that as
    // the file would time subtitles against the clip and judge them as another title's.
    const whole = Number(fileSize(filename));
    if (served && whole > 0 && Number(served) < whole * SLIVER_SHARE) {
      count("sync.standIn");
      console.log(`sync: ${filename}: its stream serves ${served} bytes, not a file of ${whole}: a stand-in, nothing of the file is playing`);
      return undefined;
    }
    // The answer names the file it serves. Another listed release's name there is failover's doing:
    // the release under this name failed and that one is served in its place (noteStandIn). A name
    // the list doesn't hold says nothing (a host may name a file anything), and the name stands.
    const servedAs = servedName(head.headers.get("content-disposition"));
    const inItsPlace = servedAs !== undefined && bareName(servedAs) !== bareName(fileName(filename)) && candidate.listed?.has(bareName(servedAs)) === true;
    if (served && inItsPlace) await noteStandIn(filename, servedAs, served).catch(() => undefined);
    // The same file is asked for under this served size once a player has opened it (sameFileRef).
    else if (served) await noteServedSize(filename, served).catch(() => undefined);
    // A stream that doesn't open (a release its host no longer has) is read no further, but said.
    if (!head.ok) console.log(`sync: ${filename}: its stream in AIOStreams answers HTTP ${head.status}`);
    return url;
  }
  const played = fileSize(filename);
  // The one opened usenet release that fits (INNER_SHARE): the file when its host serves a size that fits too.
  if (candidate.how === "inner") {
    if (served && innerSized(Number(served), Number(played))) {
      count("sync.innerName");
      console.log(`sync: ${filename}: listed under the name of the file inside its release now, served at ${served} bytes: read as the playing file`);
      return url;
    }
    console.log(`sync: ${filename}: a stream listed under a name with no title serves ${served ?? "no size"} bytes, not a share of the ${played ?? "unknown"} played: not read`);
    return undefined;
  }
  // Under another name (another version of its release, or any name at its size): the file only when
  // its host serves the size the player sent, to the byte.
  if (played !== undefined && served === played) return url;
  if (served) {
    count("sync.otherFile");
    console.log(`sync: ${filename}: a stream listed ${candidate.how === "loose" ? "as another version of it" : "at its size under another name"} serves ${served} bytes, not the ${played ?? "unknown"} played: another file, not read`);
  }
  return undefined;
}

/**
 * How long a stream's link may take to answer. AIOStreams answers a link only once its failover has
 * settled on a file: the release clicked, then the ones after it in the list, for up to its own wait
 * (60 s unless a configuration sets another). Giving up sooner abandons a file the player is about
 * to be served. Nothing a viewer waits on waits for this: a list and a download have their own time.
 */
export const LINK_OPEN_TIMEOUT_MS = 65_000;

/** How long to wait before each further look for a file AIOStreams didn't list. */
const LOOKUP_RETRY_MS = [5000, 15000];

/** Whether AIOStreams was just found not to list this file (see unlisted). */
export function notListed(filename: string): boolean {
  const at = unlisted.get(filename);
  if (at === undefined) return false;
  if (Date.now() - at < UNLISTED_MS) return true;
  unlisted.delete(filename);
  return false;
}

/**
 * The URL to read the playing file at. `background`: for a read nobody waits on (see hearDubVoices),
 * AIOStreams is asked once, with no asking again later, and a file it doesn't list isn't marked as
 * unlisted (that would label the next list's tracks unsynced).
 */
async function resolvePlayback(aiostreamsUrl: string, videoId: string, type: string, filename: string, background = false): Promise<string> {
  const key = playKey(aiostreamsUrl, filename);
  const known = playbackUrls.get(key);
  if (known && Date.now() - known.at < PLAYBACK_KEPT_MS) {
    checkReads(known.url);
    return known.url;
  }
  checkReads();
  if (notListed(filename)) throw new AlreadySaid(`no stream in AIOStreams named ${filename} (seen a moment ago)`);
  let lookup = lookups.get(key);
  if (!lookup && background) lookup = lookUpStreamAgain(aiostreamsUrl, videoId, type, filename, []);
  else if (!lookup) {
    lookup = lookUpStreamAgain(aiostreamsUrl, videoId, type, filename).finally(() => lookups.delete(key));
    lookups.set(key, lookup);
  }
  const url = await lookup;
  if (!url) {
    if (background) throw new Error(`no stream in AIOStreams named ${filename} (asked once, for the audio)`);
    forgetOld(unlisted, (at) => at, UNLISTED_MS);
    unlisted.set(filename, Date.now());
    count("sync.unlisted");
    throw new Error(`no stream in AIOStreams is ${filename}`);
  }
  checkReads(url);
  forgetOld(playbackUrls, (seen) => seen.at, PLAYBACK_KEPT_MS);
  playbackUrls.set(key, { url, at: Date.now() });
  return url;
}

/** How long a resolved playback URL is used before asking AIOStreams again (they expire). */
const PLAYBACK_KEPT_MS = 20 * 60 * 1000;

/** Redirects followed from AIOStreams' playback address to the file (fetch's own limit is 20). */
const MAX_REDIRECTS = 5;

/**
 * An address on this server's own AIOStreams (OWN_AIOSTREAMS), the way it's reached from here
 * (AIOSTREAMS_BASE, as its API calls go): a stream it serves itself is then read without going out
 * through its public address and back in. Calibration (a cached stream of its own, 3 rounds of 3 spots):
 * 4 MB in 16 ms (10-26) the internal way, 57 ms (24-100) the public way; finding the file 34 ms against 173.
 */
export function reachedFromHere(url: string): string {
  const own = config.ownAiostreams?.replace(/\/+$/, "");
  const base = config.aiostreamsBase?.replace(/\/+$/, "");
  if (!own || !base || own === base) return url;
  return url === own || url.startsWith(`${own}/`) ? base + url.slice(own.length) : url;
}

const probeJobs = new Map<string, Promise<Probe | undefined>>();
/** Files whose header read (probeFile) hasn't finished yet. */
const probing = new Set<string>();

/**
 * The header read of the file, while it's under way (fileHasSubtitles starts one on a first play):
 * a first list waits for it, up to its grace, so whatever else comes in meanwhile still fits that list.
 */
export function headerUnderWay(filename: string): Promise<unknown> | undefined {
  return probing.has(filename) ? probeJobs.get(filename) : undefined;
}
/**
 * The languages of a Matroska file's full text subtitles from its first part alone (one read of
 * 512 KB, see mkv.ts), per file: known seconds before ffprobe's header read is done, so a first
 * play's list can already leave out the languages the file has (see embeddedLanguages).
 */
const headerLanguageJobs = new Map<string, Promise<string[] | undefined>>();
/** The languages of a Matroska file's audio tracks, from the same read (see hasEnglishVoices). */
const headerAudioJobs = new Map<string, Promise<string[] | undefined>>();

/** Full text subtitle languages among a Matroska file's tracks: not signs, songs or forced lines, as tagged. */
export function mkvTextLanguages(tracks: MkvTrack[]): string[] {
  const full = tracks.filter((t) => t.type === "subtitle" && isTextCodec(t.codec) && !t.forced && !/sign|song|forced/i.test(t.name));
  return [...new Set(full.map((t) => t.language.toLowerCase()).filter((l) => l && l !== "und"))];
}

/**
 * The playing file's header: duration and its English subtitle track, if any.
 * One job per file, shared by the list (to label tracks honestly on the first
 * play) and the sync. A file without one is written down at once, so later
 * lists and syncs know without asking again.
 */
function probeFile(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<Probe | undefined> {
  let job = probeJobs.get(filename);
  if (!job) {
    job = (async () => {
      const started = Date.now();
      const opening = resolvePlayback(aiostreamsUrl, videoId, type, filename);
      // A Matroska file's first part, read once as soon as the stream is open: its tracks' languages,
      // seconds before ffprobe's header read is done. The audio's is asked for from the start, so a
      // list can wait for it (hasEnglishVoices).
      const head = opening.then((url) => readMkvTracks(url)).catch(() => undefined);
      if (!headerAudioJobs.has(filename)) {
        headerAudioJobs.set(filename, head.then((h) => (h ? h.tracks.filter((t) => t.type === "audio").map((t) => t.language.toLowerCase()) : undefined)));
        setTimeout(() => headerAudioJobs.delete(filename), 30 * 60 * 1000).unref();
      }
      const url = await opening;
      const opened = Date.now() - started;
      if (!headerLanguageJobs.has(filename)) {
        headerLanguageJobs.set(filename, head.then((h) => (h ? mkvTextLanguages(h.tracks) : undefined)));
        setTimeout(() => headerLanguageJobs.delete(filename), 30 * 60 * 1000).unref();
      }
      const probed = await probe(url, Number(fileSize(filename)) || undefined);
      // Where a first play's wait goes: finding and opening the stream (a debrid addon can take seconds
      // to make a link the first time), then reading its header.
      console.log(`sync: ${filename}: stream found and opened in ${opened} ms, header read in ${Date.now() - started - opened} ms`);
      if ((probed.track === undefined && (probed.audio === undefined || !SPEECH_SYNC)) || !probed.duration) {
        const none: FileAnchors = { filename, duration: probed.duration, windows: [], speechChecked: true, subtitleLangs: probed.languages };
        await mkdir(cachePath("anchors"), { recursive: true });
        await writeFile(anchorsFile(filename), JSON.stringify(none));
        count("sync.noSubtitles");
      }
      return probed;
    })().catch((error) => {
      readFailed(filename, error);
      return undefined;
    });
    probeJobs.set(filename, job);
    probing.add(filename);
    void job.finally(() => probing.delete(filename));
    job.then((result) => {
      if (!result) probeJobs.delete(filename); // let a later request try again
      else setTimeout(() => probeJobs.delete(filename), 30 * 60 * 1000).unref();
    });
  }
  return job;
}

/**
 * Whether the playing file has embedded subtitles to sync to: from
 * earlier results when there are any, else from its header, waited on for at
 * most waitMs. Undefined when that isn't known in time.
 */
export async function fileHasSubtitles(aiostreamsUrl: string, videoId: string, type: string, filename: string, waitMs: number): Promise<boolean | "speech" | undefined> {
  try {
    if (notListed(filename)) return false;
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (stillValid(found)) return found.windows.length === 0 ? false : found.speechOnly ? "speech" : true;
  } catch {}
  const probed = await Promise.race([probeFile(aiostreamsUrl, videoId, type, filename), new Promise<"late">((resolve) => setTimeout(() => resolve("late"), waitMs).unref())]);
  if (notListed(filename)) return false;
  if (probed === "late" || !probed) return undefined;
  if (!probed.duration) return false;
  if (probed.track !== undefined) return true;
  // No subtitle track: timed by speech in the audio, when there is audio.
  return probed.audio !== undefined && SPEECH_SYNC ? "speech" : false;
}

// ---------- the playing file's own hash ----------

function hashFile(filename: string): string {
  return path.join(cachePath("hashes"), `${cacheKey({ kind: "file-hash", filename: readingsRef(filename) })}.json`);
}

/** The playing file's OpenSubtitles hash and size, worked out on an earlier play (startFileHash). */
export async function storedFileHash(filename: string): Promise<{ hash: string; size: number } | undefined> {
  try {
    const found = JSON.parse(await readFile(hashFile(filename), "utf8")) as { hash?: unknown; size?: unknown };
    return typeof found.hash === "string" && /^[0-9a-f]{16}$/.test(found.hash) && typeof found.size === "number" ? { hash: found.hash, size: found.size } : undefined;
  } catch {
    return undefined;
  }
}

/** When each file's hash was last tried: one try per file in this long, so a failure is never retried in a loop. */
const hashTries = new Map<string, number>();
const HASH_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Works out the playing file's hash in the background, once, from two 64 KB reads (oshash.ts), for a
 * player that sends none: the lists after it ask the subtitle sites with it. Nothing waits on it.
 * The stream is looked up beside the header read when one is under way (the same lookup), else on
 * its own, without marking the file unlisted when AIOStreams doesn't list it.
 */
export function startFileHash(aiostreamsUrl: string, videoId: string, type: string, filename: string): void {
  const tried = hashTries.get(filename);
  if (tried !== undefined && Date.now() - tried < HASH_RETRY_MS) return;
  forgetOld(hashTries, (at) => at, HASH_RETRY_MS);
  hashTries.set(filename, Date.now());
  void (async () => {
    if (await storedFileHash(filename)) return;
    // A first play's header read looks the stream up: it's waited for and its URL used, so AIOStreams
    // (and the indexers behind it) are asked once. A file read on an earlier play is looked up here.
    await probeJobs.get(filename);
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename, !lookups.has(playKey(aiostreamsUrl, filename)));
    const found = await readFileHash(url);
    if (!found) return;
    await mkdir(cachePath("hashes"), { recursive: true });
    await writeFile(hashFile(filename), JSON.stringify({ ...found, at: new Date().toISOString() }));
    count("sync.hashed");
    console.log(`hash: ${fileName(filename)}: ${found.hash}`);
  })().catch((error) => {
    count("sync.hashFailed");
    console.error(`hash: ${fileName(filename)}: ${error instanceof Error ? error.message : error}`);
  });
}

/**
 * Languages the playing file already has full text subtitles in, from earlier reads of it, a header
 * read that has finished (fileHasSubtitles starts one on a first play), or the quick read of a
 * Matroska file's first part, waited on for at most waitMs. Undefined when not known in time.
 */
export async function embeddedLanguages(filename: string, waitMs = 0): Promise<string[] | undefined> {
  try {
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (Array.isArray(found.subtitleLangs)) return found.subtitleLangs;
  } catch {}
  const job = probeJobs.get(filename);
  // A header read that's already done.
  const probed = job ? await Promise.race([job, Promise.resolve(undefined)]) : undefined;
  if (probed) return probed.languages;
  const quick = headerLanguageJobs.get(filename);
  const read = quick ? await Promise.race([quick, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs).unref())]) : undefined;
  // Not read in time: AIOStreams' record of the file, where a lookup found one (listedFacts).
  return read ?? listedFactsOf(filename)?.textLangs;
}

const subtitleTrackJobs = new Map<string, Promise<MkvTrack[]>>();

/**
 * The playing file's subtitle tracks as its Matroska header gives them, an ASS track with its own
 * script header (its styles): one header read, kept with the file's other signs work (cache/signs).
 * Empty for a file that isn't Matroska or whose header can't be read.
 */
export function fileSubtitleTracks(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<MkvTrack[]> {
  // Asked for at each use: the file's link may turn out to serve another release once it is opened.
  const kept = () => path.join(cachePath("signs"), `${cacheKey({ kind: "file-tracks", filename: readingsRef(filename) })}.json`);
  let job = subtitleTrackJobs.get(filename);
  if (!job) {
    job = (async () => {
      try {
        return (JSON.parse(await readFile(kept(), "utf8")) as { tracks: MkvTrack[] }).tracks;
      } catch {}
      const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
      const read = await readMkvTracks(url, 15000).catch(() => undefined);
      const tracks = (read?.tracks ?? []).filter((t) => t.type === "subtitle");
      await mkdir(path.dirname(kept()), { recursive: true });
      await writeFile(kept(), JSON.stringify({ tracks }));
      return tracks;
    })().catch(() => [] as MkvTrack[]).finally(() => setTimeout(() => subtitleTrackJobs.delete(filename), 60_000).unref());
    subtitleTrackJobs.set(filename, job);
  }
  return job;
}

/**
 * Whether audio tagged with these languages has English voices: true when one is English, false when
 * every one is tagged another language, undefined when one is untagged ("und") or there are none.
 */
export function englishVoicesIn(languages: string[]): boolean | undefined {
  if (languages.some((l) => /^(en|eng)$/i.test(l))) return true;
  if (languages.length > 0 && languages.every((l) => l && !/^und$/i.test(l))) return false;
  return undefined;
}

/**
 * Whether the playing file has English voices: an English audio track (ffprobe's pick takes English
 * first, so a pick in another language means there is none). False for a file whose audio is all in
 * another language, an anime's original-language release: dub captions follow English voices, so
 * they don't belong on it. From earlier reads of it, a header read that has finished, or the quick
 * read of a Matroska file's first part, waited on for at most waitMs. Undefined when not known in time.
 */
export async function hasEnglishVoices(filename: string, waitMs = 0): Promise<boolean | undefined> {
  try {
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (found.audioLang) return englishVoicesIn([found.audioLang]);
  } catch {}
  const job = probeJobs.get(filename);
  const probed = job ? await Promise.race([job, Promise.resolve(undefined)]) : undefined;
  if (probed?.audioLang) return englishVoicesIn([probed.audioLang]);
  const quick = headerAudioJobs.get(filename);
  const languages = quick ? await Promise.race([quick, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs).unref())]) : undefined;
  if (languages) return englishVoicesIn(languages);
  // Not read in time: AIOStreams' record of the file, where a lookup found one (listedFacts).
  const listed = listedFactsOf(filename);
  return listed ? englishVoicesIn(listed.audioLangs) : undefined;
}

/**
 * The playing file's length in ms, once known: from earlier reads of it, a header read that has
 * finished, or else AIOStreams' record of the file (listedFacts).
 */
export async function fileDuration(filename: string): Promise<number | undefined> {
  try {
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (found.duration) return found.duration;
  } catch {}
  const job = probeJobs.get(filename);
  const probed = job ? await Promise.race([job, Promise.resolve(undefined)]) : undefined;
  return probed?.duration || listedFactsOf(filename)?.duration || undefined;
}

/** Index lines are cut into windows this long, end to end: every window of the file is measured. */
const INDEX_WINDOW_MS = 60000;
/** A text track needs at least this many dialogue lines in the index to be timed by it. */
const INDEX_MIN_LINES = 30;

/**
 * The file's anchors from its Matroska index (mkv.ts): every text subtitle track's dialogue lines over
 * the whole file, cut into windows so the usual measuring applies, and nothing more of the file to
 * read (rounds are done). Picture tracks, and files whose index has no usable text track, are read
 * the usual way (undefined).
 */
async function indexAnchors(url: string, filename: string, duration: number, audio: number | undefined, languages: string[], bitrate?: number, audioLang?: string): Promise<FileAnchors | undefined> {
  // An MP4's text tracks are timed from its sample tables (mp4.ts), a Matroska file's from its index.
  const mp4 = /\.(mp4|m4v|mov)$/i.test(fileName(filename));
  const timing = mp4 ? ((await readMp4Timing(url)) ?? (await readMkvTiming(url))) : ((await readMkvTiming(url)) ?? (await readMp4Timing(url)));
  if (!timing) return undefined;
  const CODECS: Record<string, string> = { "S_TEXT/ASS": "ass", "S_ASS": "ass", "S_TEXT/SSA": "ssa", "S_SSA": "ssa", "S_TEXT/UTF8": "subrip", "S_TEXT/ASCII": "subrip", "S_TEXT/WEBVTT": "webvtt", "S_HDMV/PGS": "hdmv_pgs_subtitle", tx3g: "mov_text", text: "mov_text", wvtt: "webvtt" };
  const lines = new Map<number, Cue[]>();
  const streams: ProbedStream[] = [];
  for (const t of timing.tracks) {
    if (t.type !== "subtitle" || !CODECS[t.codec]) continue;
    // Picture tracks (PGS) give shows and clears, not lengths: see pictureLines.
    const entries = timing.lines.get(t.number) ?? [];
    const dialogue = t.codec === "S_HDMV/PGS" ? pictureLines(entries) : dialogueLines(entries);
    if (dialogue.length < INDEX_MIN_LINES) continue;
    lines.set(t.index, dialogue);
    streams.push({ index: t.index, codec_type: "subtitle", codec_name: CODECS[t.codec], tags: { language: t.language, title: t.name }, disposition: { forced: t.forced ? 1 : 0 } });
  }
  const ranked = rankTracks(streams);
  if (!ranked.length) return undefined;
  // Text tracks first (rankTracks); a picture track is the reference only when there's no text one,
  // and other picture tracks aren't kept beside it (they'd need reading the same way).
  const firstIsPicture = ranked[0].codec_name === "hdmv_pgs_subtitle";
  const usable = firstIsPicture ? ranked.slice(0, 1) : ranked.filter((s) => s.codec_name !== "hdmv_pgs_subtitle");
  const [first, ...rest] = usable.slice(0, 1 + MAX_OTHER_TRACKS).map((s) => s.index);
  const langTracks = firstIsPicture ? [] : languageTracks(usable, [first, ...rest]);
  const trackLangs = trackLanguages(usable, [first, ...rest, ...langTracks]);
  const length = duration || timing.duration;
  const windows: FileAnchors["windows"] = [];
  for (let from = 0; from < length; from += INDEX_WINDOW_MS) {
    const to = Math.min(length, from + INDEX_WINDOW_MS);
    const inside = (cues: Cue[]) => cues.filter((c) => c.start >= from && c.start < to);
    const byTrack = (tracks: number[]) => Object.fromEntries(tracks.map((i) => [String(i), inside(lines.get(i) ?? [])]));
    windows.push({ from, to, cues: inside(lines.get(first) ?? []), ...(rest.length ? { others: byTrack(rest) } : {}), ...(langTracks.length ? { langs: byTrack(langTracks) } : {}) });
  }
  count("sync.files");
  count("sync.index");
  count("sync.indexBytes", timing.bytesRead);
  console.log(`sync: ${filename}: timing from the file's index (${Math.round(timing.bytesRead / 1024)} KB, ${lines.get(first)?.length ?? 0} lines on track ${first})`);
  return {
    filename, duration: length, windows, track: first, audio, ...(audioLang ? { audioLang } : {}), source: "index", rounds: MAX_ROUNDS, ...(bitrate ? { bitrate } : {}), ...(firstIsPicture ? { image: true } : {}),
    ...(rest.length ? { others: rest } : {}), ...(langTracks.length ? { langTracks } : {}), ...(Object.keys(trackLangs).length ? { trackLangs } : {}), subtitleLangs: languages
  };
}

/**
 * Speech for a file timed from its index: the audio at the usual spots, read side by side and kept
 * beside the index windows (marked heard, so nothing measures them as lines). Read when the captions
 * fit none of its tracks, and in the `background` for dub captions the track timed (see
 * hearDubVoices): then a read that failed at every spot isn't kept, so it can be tried again.
 * Undefined when the file has no audio to hear or it can't be read.
 */
/**
 * Background reads of a file's audio take turns, in the order they are asked for: two at once share
 * the host's bandwidth, and the first asked is the one playing (a player asks for the next episode's
 * list while this one plays, and that file isn't watched for a while). Calibration (11-16): an
 * episode's 5 spots read beside the next episode's took 16.5 s.
 */
let hearingLine: Promise<void> = Promise.resolve();

/**
 * Where a dub's voices are heard on a file timed from its index (addSpeech), in file time: at the
 * usual spots while the track's timing is one stretch. Where it steps, every stretch is set by its own
 * voices (refineBySpeech), and one that isn't heard takes the file's move: so the spots are shared out
 * among the stretches, each of the longest getting one, then the rest by length (a long stretch gets
 * two before a short one gets any more), and spread evenly inside each. As many spots as usual, so
 * nothing more is read.
 */
export function voiceSpots(anchors: Anchor[], duration: number, span: number): number[] {
  const usual = WINDOW_SPOTS.map((spot) => Math.round(duration * spot));
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  const runs: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || Math.abs(sorted[i].offset - sorted[i - 1].offset) > AGREE_MS) runs.push({ from: sorted[i].from, to: sorted[i].to });
    else runs[runs.length - 1].to = Math.max(runs[runs.length - 1].to, sorted[i].to);
  }
  if (runs.length < 2) return usual;
  const length = (run: { from: number; to: number }) => run.to - run.from;
  const heard = [...runs].sort((a, b) => length(b) - length(a)).slice(0, usual.length).map((run) => ({ run, spots: 1 }));
  for (let left = usual.length - heard.length; left > 0; left--) heard.reduce((most, h) => (length(h.run) / h.spots > length(most.run) / most.spots ? h : most)).spots++;
  return heard
    .flatMap(({ run, spots }) => {
      const room = Math.max(0, Math.min(run.to, duration) - run.from - span);
      return Array.from({ length: spots }, (_, i) => Math.round(run.from + ((i + 0.5) / spots) * room));
    })
    .sort((a, b) => a - b);
}

function addSpeech(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string, background = false, froms?: number[]): Promise<FileAnchors | undefined> {
  const jobKey = `${filename}#speech`;
  let job = extendJobs.get(jobKey);
  if (job) return job;
  let done: () => void = () => {};
  const ahead = background ? hearingLine : undefined;
  if (background) hearingLine = new Promise<void>((resolve) => (done = resolve));
  job = (async () => {
    if (stored.audio === undefined || stored.speechBy === "silero" || !SPEECH_SYNC) return undefined;
    await ahead;
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename, background);
    const span = windowMs(stored.bitrate);
    // The usual spots, or the ones a dub's stepped timing asks for (voiceSpots).
    const spots = froms?.length ? froms : WINDOW_SPOTS.map((spot) => Math.round(stored.duration * spot));
    count("sync.windows", spots.length);
    count("sync.videoSeconds", (spots.length * span) / 1000);
    noteRead(windowBytes(stored.bitrate, spots.length * span));
    let failed = 0;
    const hear = async (from: number) => {
      const speech = await readSpeechWindow(url, stored.audio as number, from, span).catch(() => (failed++, [] as Cue[]));
      return { from, to: from + span, cues: [] as Cue[], speech, heard: true };
    };
    const heard = await Promise.all(spots.map(hear));
    if (background && failed === spots.length) throw new Error(`the audio couldn't be read at any of the ${spots.length} spots`);
    const result: FileAnchors = { ...stored, windows: [...stored.windows, ...heard].sort((a, b) => a.from - b.from), speechBy: "silero" };
    // Whole or not at all: read in the background, it can land while a sync is reading the record.
    await writeWhole(anchorsFile(filename), JSON.stringify(result));
    console.log(`sync: ${filename}: read the audio at ${spots.length} spots for speech${froms?.length ? ` (${spots.map((s) => `${Math.round(s / 1000)}s`).join(", ")}: in each stretch of the timing)` : ""}`);
    return result;
  })()
    .catch((error) => {
      readFailed(filename, error, "speech: ");
      return undefined;
    })
    .finally(() => done());
  keepJob(jobKey, job);
  return job;
}

/**
 * Whether dub captions timed by the track on this file wait for its English audio to be heard: a file
 * timed from its index, whose audio hasn't been read yet (the index holds no audio), is the dub's (see
 * voicesAreTheDub) and costs at most BACKGROUND_MAX_BYTES to hear. A file read in windows hears its
 * audio in the same reads as its lines.
 */
export function voicesToHear(stored: FileAnchors): boolean {
  return SPEECH_SYNC && stored.source === "index" && stored.audio !== undefined && stored.speechBy !== "silero" && voicesAreTheDub(stored) && hearingCost(stored) <= BACKGROUND_MAX_BYTES;
}

/** About how many bytes hearing the file's audio at the usual spots reads (addSpeech): its bit rate over 5 windows. */
export function hearingCost(stored: Pick<FileAnchors, "bitrate">): number {
  return windowBytes(stored.bitrate, WINDOW_SPOTS.length * windowMs(stored.bitrate));
}

/**
 * The most a background read of the audio may cost a file: 5 windows of WINDOW_BYTES (315 MB, with a
 * little room for rounding), what any file up to 25 Mb/s costs once its windows are shortened
 * (windowMs). Heavier files (a 2160p remux, whose 20 s windows would read 875 MB at 70 Mb/s) keep the
 * track's timing for dub captions.
 */
const BACKGROUND_MAX_BYTES = 320e6;

/** Background reads still running (see settled). */
const backgroundJobs = new Set<Promise<unknown>>();

/**
 * Reads the English audio of a file timed from its index, in the background, once dub captions were
 * synced to it by the track: its voices refine the timing of every dub caption on the file
 * (refineBySpeech). The list's sync starts it, seconds before the player asks for the captions, and a
 * download waits for it within its budget (syncedByVoices), so a first play gets them timed by the
 * voices; one that lands later times the next request. The cost is the 5 windows addSpeech reads
 * (hearingCost: the file's bit rate over 5 x 40 s, shorter windows for heavy files, at most
 * BACKGROUND_MAX_BYTES): read once per file, never for a file whose audio was heard already, counted
 * against DAILY_READ_GB and held back by the host's refusals (reads.ts), and only while the day's
 * reads leave room for syncs a viewer waits on (backgroundReadFits).
 */
function hearDubVoices(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string, anchors: Anchor[] = []): void {
  if (!voicesToHear(stored)) return;
  if (!backgroundReadFits(hearingCost(stored))) {
    count("sync.voicesHeldBack");
    console.log(`sync: ${filename}: the English audio for dub captions is left unread: today's reads are nearly spent`);
    return;
  }
  const job = addSpeech(stored, aiostreamsUrl, videoId, type, filename, true, voiceSpots(anchors, stored.duration, windowMs(stored.bitrate)));
  backgroundJobs.add(job);
  void job.finally(() => backgroundJobs.delete(job));
}

/** Where the stretches heard for a file's track check are kept (hearVoiceSpots), beside its readings. */
function voiceSpotsFile(filename: string): string {
  return anchorsFile(filename).replace(/\.json$/, ".spots");
}

/** The stretches of a file whose speech has been heard, as the track check counts them. */
function voiceSpotsOf(found: FileAnchors): VoiceSpot[] {
  return found.windows.filter((w) => w.speech?.length).map((w) => ({ from: w.from, to: w.to, speech: w.speech! }));
}

/** Where the file's own track's lines start, once each, from the windows read from it. */
function trackStartsOf(found: FileAnchors): number[] {
  return [...new Set(found.windows.filter((w) => !w.heard).flatMap((w) => w.cues.map((c) => c.start)))];
}

/** The stretches of a file heard for its track check, when they have been. */
async function keptVoiceSpots(filename: string): Promise<VoiceSpot[] | undefined> {
  try {
    const spots = JSON.parse(await readFile(voiceSpotsFile(filename), "utf8")) as VoiceSpot[];
    return Array.isArray(spots) && spots.length ? spots : undefined;
  } catch {
    return undefined;
  }
}

/** Track checks whose audio is being heard, by file, and the files one was started for since the server started. */
const voiceSpotJobs = new Map<string, Promise<void>>();
const voiceSpotsTried = new Set<string>();

/**
 * Hears the file at the stretches a track check asks for (trackcheck.ts), in the background, and keeps
 * what was heard beside the file's readings: once per file, since every subtitle for it is judged by
 * the same stretches. The list's sync starts it, a download waits for it within its budget
 * (syncedByVoices), and one that lands later decides the next request. Its cost is the file's bit rate
 * over the stretches heard, at most TRACK_CHECK.maxBytes, counted against DAILY_READ_GB.
 */
function hearVoiceSpots(stored: FileAnchors, froms: number[], aiostreamsUrl: string, videoId: string, type: string, filename: string): void {
  if (voiceSpotJobs.has(filename)) return;
  voiceSpotsTried.add(filename);
  const job = (async () => {
    const started = Date.now();
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename, true);
    count("sync.trackCheckHeard");
    count("sync.videoSeconds", (froms.length * TRACK_CHECK.spanMs) / 1000);
    noteRead(windowBytes(stored.bitrate, froms.length * TRACK_CHECK.spanMs));
    const spots: VoiceSpot[] = await Promise.all(froms.map(async (from) => ({ from, to: from + TRACK_CHECK.spanMs, speech: await readSpeechWindow(url, stored.audio as number, from, TRACK_CHECK.spanMs) })));
    await writeWhole(voiceSpotsFile(filename), JSON.stringify(spots));
    console.log(`sync: ${filename}: heard ${froms.length} stretches of ${TRACK_CHECK.spanMs / 1000} s (${froms.map((f) => `${Math.round(f / 1000)}s`).join(", ")}) to check its subtitle track against its voices, in ${Date.now() - started} ms`);
  })()
    .catch((error) => readFailed(filename, error, "track check: "))
    .finally(() => voiceSpotJobs.delete(filename));
  voiceSpotJobs.set(filename, job);
  backgroundJobs.add(job);
  void job.finally(() => backgroundJobs.delete(job));
}

/**
 * Dub captions the track timed while the file's English audio is heard (SyncResult.voicesPending),
 * synced again by the voices once the read under way lands, if it lands within `waitMs`. Undefined
 * when no read is under way, or none lands in time: the track's timing stands.
 */
export async function syncedByVoices(
  key: string,
  caption: () => Promise<{ file: string }>,
  aiostreamsUrl: string,
  videoId: string,
  type: string,
  filename: string,
  lang: string | undefined,
  waitMs: number,
  hearing: Promise<unknown> | undefined = extendJobs.get(`${filename}#speech`) ?? voiceSpotJobs.get(filename)
): Promise<SyncResult | undefined> {
  if (!hearing || waitMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = await Promise.race([hearing.then(() => true, () => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), waitMs)))]);
  clearTimeout(timer);
  if (!heard) return undefined;
  const again = await syncCaptions(key, caption, aiostreamsUrl, videoId, type, filename, lang);
  return again && !again.voicesPending && !again.trackCheckPending ? again : undefined;
}

/**
 * Where more of a file with no subtitle track is heard, once its first five windows' speech didn't
 * time a subtitle clearly (see hearMoreSpeech): between those five, so the ten spread over the file
 * from a tenth of the way in.
 */
export const MORE_SPOTS = [0.1, 0.24, 0.41, 0.59, 0.76];
/** A file with no subtitle track gets one round of MORE_SPOTS, at most (FileAnchors.rounds). */
const SPEECH_ROUNDS = 1;
/** And one round more, after it, where speech hints at a step it can't place (stepSpots). */
const STEP_ROUND = 2;
/**
 * A timing by speech that rests on fewer windows than this is worth hearing more of the file for. On
 * the stored plays, 8 of 18 subtitles on files with no subtitle track couldn't be timed (too few
 * voices heard in too many of the 5 windows), and 5 of the 10 timed rested on 3 windows.
 */
const SPEECH_SURE_WINDOWS = 4;

/**
 * Whether a file with no subtitle track may have more of its audio heard (hearMoreSpeech): its speech
 * was heard by Silero, MORE_SPOTS haven't been read yet, and they cost at most BACKGROUND_MAX_BYTES.
 */
export function moreSpeechToHear(stored: FileAnchors): boolean {
  return SPEECH_SYNC && Boolean(stored.speechOnly) && stored.audio !== undefined && stored.speechBy === "silero" && (stored.rounds ?? 0) < SPEECH_ROUNDS && moreSpeechCost(stored) <= BACKGROUND_MAX_BYTES;
}

/**
 * Whether a file with no subtitle track may be heard at the spots a step calls for (stepSpots): as
 * moreSpeechToHear, once MORE_SPOTS have been heard and the step round hasn't.
 */
export function stepSpeechToHear(stored: FileAnchors): boolean {
  return SPEECH_SYNC && Boolean(stored.speechOnly) && stored.audio !== undefined && stored.speechBy === "silero" && (stored.rounds ?? 0) === SPEECH_ROUNDS && moreSpeechCost(stored) <= BACKGROUND_MAX_BYTES;
}

/** About how many bytes hearing MORE_SPOTS reads: the file's bit rate over 5 windows, as the first pass. */
export function moreSpeechCost(stored: Pick<FileAnchors, "bitrate">): number {
  return windowBytes(stored.bitrate, MORE_SPOTS.length * windowMs(stored.bitrate));
}

/**
 * Hears a file with no subtitle track at MORE_SPOTS, in the background, when its speech didn't time a
 * subtitle clearly (no clear fit, one resting on fewer than SPEECH_SURE_WINDOWS windows, or a window
 * with speech enough to measure that lands elsewhere, where the timing may step): from
 * the next request on, every subtitle on the file is timed by ten windows of speech instead of five.
 * Nothing waits for it, so the first list and download are as quick as before. It costs what the first
 * pass did (moreSpeechCost: the file's bit rate over 5 windows of 40 s, shorter for heavy files, at
 * most BACKGROUND_MAX_BYTES), once per file; counted against DAILY_READ_GB, started only while the
 * day's reads leave room for syncs a viewer waits on (backgroundReadFits), read one spot at a time, and
 * stopped as soon as the file's host refuses or the day's limit is spent (reads.ts).
 *
 * `stepAt`: once MORE_SPOTS are heard, the spots a step speech hints at calls for (stepSpots), heard
 * the same way and at the same cost, once per file (STEP_ROUND).
 */
function hearMoreSpeech(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string, stepAt?: number[]): void {
  const froms = moreSpeechToHear(stored) ? MORE_SPOTS.map((spot) => Math.round(stored.duration * spot)) : stepAt?.length && stepSpeechToHear(stored) ? stepAt : undefined;
  if (!froms) return;
  if (!backgroundReadFits(moreSpeechCost(stored))) {
    count("sync.speechHeldBack");
    console.log(`sync: ${filename}: more of the audio is left unheard: today's reads are nearly spent`);
    return;
  }
  const job = readMoreSpeech(stored, aiostreamsUrl, videoId, type, filename, froms, froms === stepAt ? STEP_ROUND : SPEECH_ROUNDS);
  backgroundJobs.add(job);
  void job.finally(() => backgroundJobs.delete(job));
}

/** The read behind hearMoreSpeech: kept with the file's readings whole, or not at all (it is tried again later). */
function readMoreSpeech(stored: FileAnchors, aiostreamsUrl: string, videoId: string, type: string, filename: string, froms: number[], round: number): Promise<FileAnchors | undefined> {
  const jobKey = `${filename}#more-speech-${round}`;
  let job = extendJobs.get(jobKey);
  if (job) return job;
  job = (async () => {
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename, true);
    const span = windowMs(stored.bitrate);
    const heard: FileAnchors["windows"] = [];
    let failed = 0;
    const turn = await takeHearingTurn(aiostreamsUrl, filename);
    try {
      for (const from of froms) {
        // A host that refused meanwhile, or the day's limit spent: stop here (ReadsPaused).
        checkReads(url);
        count("sync.windows");
        count("sync.videoSeconds", span / 1000);
        noteRead(windowBytes(stored.bitrate, span));
        const cues = await readSpeechWindow(url, stored.audio as number, from, span).catch(() => (failed++, [] as Cue[]));
        heard.push({ from, to: from + span, cues });
      }
    } finally {
      turn.done();
    }
    if (failed === froms.length) throw new Error(`the audio couldn't be read at any of the ${froms.length} spots`);
    const now = (await storedAnchors(filename)) ?? stored;
    const result: FileAnchors = { ...now, windows: [...now.windows, ...heard].sort((a, b) => a.from - b.from), rounds: round };
    await writeWhole(anchorsFile(filename), JSON.stringify(result));
    console.log(`sync: ${filename}: heard the audio at ${froms.length} more spots${round === STEP_ROUND ? " for a step" : ""} (${heard.map((w) => `${Math.round(w.from / 1000)}s: ${w.cues.length}`).join(", ")})`);
    return result;
  })().catch((error) => {
    readFailed(filename, error, "more speech: ");
    return undefined;
  });
  keepJob(jobKey, job);
  return job;
}

/** Resolves once no background read is running: for tests, the benchmark and the score, before they let fetch out again. */
export async function settled(): Promise<void> {
  while (backgroundJobs.size) await Promise.allSettled([...backgroundJobs]);
}

/** The file's readings as stored, if any. */
async function storedAnchors(filename: string): Promise<FileAnchors | undefined> {
  try {
    return JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
  } catch {
    return undefined;
  }
}

/** Writes a file whole or not at all: a download reading it meanwhile gets the old one or the new one. */
async function writeWhole(file: string, data: string): Promise<void> {
  const part = `${file}.${randomUUID()}.part`;
  try {
    await writeFile(part, data);
    await rename(part, file);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

/** The file's turn at hearing (turns.ts), counted and logged when it had to wait for another file. */
async function takeHearingTurn(aiostreamsUrl: string, filename: string): Promise<{ done: () => void }> {
  const turn = await hearingTurn(aiostreamsUrl, filename);
  if (turn.waitedMs >= 100) {
    count("sync.turnWaited");
    count("sync.turnWaitedMs", turn.waitedMs);
    console.log(`sync: ${filename}: heard after another file of the same configuration (waited ${turn.waitedMs} ms)`);
  }
  return turn;
}

/** Embedded dialogue at the anchor windows of the playing file, cached per file. */
export function fileAnchors(aiostreamsUrl: string, videoId: string, type: string, filename: string): Promise<FileAnchors | undefined> {
  const key = cacheKey({ kind: "file-anchors", filename });
  let job = fileAnchorJobs.get(key);
  if (!job) {
    job = (async () => {
      try {
        const stored = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
        if (stillValid(stored)) return stored;
      } catch {}
      const probed = await probeFile(aiostreamsUrl, videoId, type, filename);
      if (!probed) throw new AlreadySaid("file header not read");
      const { duration, track, image, audio, audioLang, languages, others, trackLangs, bitrate } = probed;
      const span = windowMs(bitrate);
      if ((track === undefined && (audio === undefined || !SPEECH_SYNC)) || !duration) return { filename, duration, windows: [], speechChecked: true, subtitleLangs: languages } satisfies FileAnchors;
      // No subtitle track: speech in the audio stands in for the lines.
      const speechOnly = track === undefined;
      const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
      // A Matroska file's index holds every subtitle line's timing: the whole file's lines from a few
      // hundred KB, instead of reading windows of the video (see mkv.ts).
      if (!speechOnly) {
        const fromIndex = await indexAnchors(url, filename, duration, audio, languages, bitrate, audioLang).catch((error) => {
          console.log(`sync: ${filename}: index not read (${scrub(error instanceof Error ? error.message : String(error))}), reading windows`);
          return undefined;
        });
        if (fromIndex) {
          await mkdir(cachePath("anchors"), { recursive: true });
          await writeFile(anchorsFile(filename), JSON.stringify(fromIndex));
          return fromIndex;
        }
      }
      count("sync.files");
      count("sync.windows", WINDOW_SPOTS.length);
      count("sync.videoSeconds", (WINDOW_SPOTS.length * span) / 1000);
      noteRead(windowBytes(bitrate, WINDOW_SPOTS.length * span));
      // A file timed by speech takes its turn at hearing (see turns.ts): the watched episode before one listed ahead.
      const turn = speechOnly ? await takeHearingTurn(aiostreamsUrl, filename) : undefined;
      const windows = await Promise.all(
        WINDOW_SPOTS.map(async (spot) => {
          const from = Math.round(duration * spot);
          try {
            if (speechOnly) return { from, to: from + span, cues: await readSpeechWindow(url, audio as number, from, span) };
            if (image) return { from, to: from + span, cues: await readImageWindow(url, track, from, span) };
            return { from, to: from + span, ...(await readWindowAndSpeechSafely(url, track, audio, from, span, others)) };
          } catch {
            return { from, to: from + span, cues: [] };
          }
        })
      ).finally(() => turn?.done());
      if (speechOnly) {
        count("sync.speechOnly");
        console.log(`sync: ${filename}: no subtitle track, timing from speech in the audio`);
      }
      // A file with no subtitle track keeps its bit rate: hearing more of its audio later costs that (see moreSpeechCost).
      const result: FileAnchors = { filename, duration, windows, track, image, audio, ...(audioLang ? { audioLang } : {}), ...(others?.length && !speechOnly ? { others } : {}), ...(trackLangs && !speechOnly ? { trackLangs } : {}), ...(speechOnly ? { speechOnly, ...(bitrate ? { bitrate } : {}) } : {}), ...(audio !== undefined ? { speechBy: "silero" as const } : {}), subtitleLangs: languages };
      await mkdir(cachePath("anchors"), { recursive: true });
      await writeFile(anchorsFile(filename), JSON.stringify(result));
      return result;
    })().catch((error) => {
      readFailed(filename, error);
      return undefined;
    });
    fileAnchorJobs.set(key, job);
    // Only while it runs, so syncs started together share one read. A finished reading is on disk
    // (the next request loads it, with any windows added since); a failed one is tried again.
    void job.then(() => {
      if (fileAnchorJobs.get(key) === job) fileAnchorJobs.delete(key);
    });
  }
  return job;
}

const EXTRA_WINDOW_MS = 60000;
const MAX_EXTRA_WINDOWS = 6;
/** Round 1 covers gaps; round 2 reads the stretches where the timing steps. */
export const MAX_ROUNDS = 2;
/** A stretch between disagreeing anchors is read in full up to this long. */
const MAX_BRIDGE_MS = 180000;

/**
 * Where to read more of the file after a first pass: around spots that found
 * nothing usable, between neighbouring anchors that disagree (to find where
 * the timing steps), and early on when nothing covers the first quarter. A
 * streaming cut and a Blu-ray often differ at the breaks, so the shift can
 * step a few times in one episode, and a sparse spot can't show that.
 */
export function refinementStarts(
  found: Pick<FileAnchors, "duration" | "windows">,
  anchors: Anchor[],
  /** Later rounds only narrow down steps between disagreeing anchors. */
  stepsOnly = false
): number[] {
  const last = Math.max(0, found.duration - EXTRA_WINDOW_MS);
  const clamp = (t: number) => Math.min(last, Math.max(0, Math.round(t)));
  const wanted: number[] = [];
  if (!stepsOnly) {
    for (const w of found.windows) {
      if (anchors.some((a) => a.from === w.from)) continue;
      wanted.push(clamp(w.from - EXTRA_WINDOW_MS), clamp(w.to));
    }
  }
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  if (!stepsOnly) {
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      // Far apart: a measuring window between them first, so the stretch to bridge is short.
      if (Math.abs(a.offset - b.offset) > AGREE_MS && b.from - a.to > MAX_BRIDGE_MS) wanted.push(clamp((a.to + b.from) / 2 - EXTRA_WINDOW_MS / 2));
    }
  }
  if (!stepsOnly && !sorted.some((a) => a.from < found.duration * 0.25)) wanted.push(clamp(found.duration * 0.05));

  const taken = found.windows.map((w) => w.from);
  const out: number[] = [];
  for (const start of wanted) {
    const near = [...taken, ...out].some((t) => Math.abs(t - start) < EXTRA_WINDOW_MS / 2);
    if (!near) out.push(start);
    if (out.length >= MAX_EXTRA_WINDOWS) break;
  }
  return out.sort((a, b) => a - b);
}

/** The stretches between neighbouring anchors that disagree, to read in full (capped). */
export function bridgeSpans(found: Pick<FileAnchors, "windows">, anchors: Anchor[]): Array<{ from: number; length: number }> {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  const spans: Array<{ from: number; length: number }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (Math.abs(a.offset - b.offset) <= AGREE_MS) continue;
    const gap = b.from - a.to;
    if (gap <= 5000) continue;
    const from = gap > MAX_BRIDGE_MS ? Math.round((a.to + b.from) / 2 - MAX_BRIDGE_MS / 2) : a.to;
    const length = Math.min(gap, MAX_BRIDGE_MS);
    if (!found.windows.some((w) => w.bridge && w.from === from)) spans.push({ from, length });
  }
  return spans;
}

const extendJobs = new Map<string, Promise<FileAnchors | undefined>>();

/** Remembers a job for extra reads while it runs and for JOB_KEPT_MS after, then lets it go. */
function keepJob(jobKey: string, job: Promise<FileAnchors | undefined>): void {
  extendJobs.set(jobKey, job);
  void job.then(() => {
    setTimeout(() => {
      if (extendJobs.get(jobKey) === job) extendJobs.delete(jobKey);
    }, JOB_KEPT_MS).unref();
  });
}

/** Reads extra windows of the playing file once, and keeps them with the file's anchors. */
function extendAnchors(
  found: FileAnchors,
  spans: Array<{ from: number; length: number; bridge?: boolean }>,
  aiostreamsUrl: string,
  videoId: string,
  type: string,
  filename: string
): Promise<FileAnchors | undefined> {
  const round = (found.rounds ?? 0) + 1;
  const jobKey = `${filename}#${round}`;
  let job = extendJobs.get(jobKey);
  if (job) return job;
  job = (async () => {
    if (round > MAX_ROUNDS || spans.length === 0) return found;
    const url = await resolvePlayback(aiostreamsUrl, videoId, type, filename);
    // Anchors that don't record the track: look it up again (header only).
    if (found.track === undefined && !found.speechOnly) {
      const probed = await probe(url, Number(fileSize(filename)) || undefined);
      if (probed.track === undefined) return found;
      found = { ...found, track: probed.track, image: probed.image, audio: probed.audio, ...(probed.audioLang ? { audioLang: probed.audioLang } : {}), ...(probed.others ? { others: probed.others } : {}), ...(probed.trackLangs ? { trackLangs: probed.trackLangs } : {}) };
    }
    const read = async (from: number, length: number): Promise<{ cues: Cue[]; speech?: Cue[] }> => {
      if (found.speechOnly) return { cues: await readSpeechWindow(url, found.audio as number, from, length) };
      if (found.image) return { cues: await readImageWindow(url, found.track as number, from, length) };
      return readWindowAndSpeechSafely(url, found.track as number, found.audio, from, length, found.others);
    };
    count("sync.windows", spans.length);
    count("sync.videoSeconds", Math.round(spans.reduce((sum, s) => sum + s.length, 0) / 1000));
    noteRead(windowBytes(found.bitrate, spans.reduce((sum, s) => sum + s.length, 0)));
    const extra = await Promise.all(
      spans.map(async ({ from, length, bridge }) => {
        try {
          return { from, to: from + length, ...(await read(from, length)), ...(bridge ? { bridge } : {}) };
        } catch {
          return { from, to: from + length, cues: [], ...(bridge ? { bridge } : {}) };
        }
      })
    );
    const result: FileAnchors = { ...found, windows: [...found.windows, ...extra].sort((a, b) => a.from - b.from), rounds: round };
    await writeFile(anchorsFile(filename), JSON.stringify(result));
    console.log(`sync: ${filename}: round ${round}: read ${extra.length} more windows at ${extra.map((w) => `${Math.round(w.from / 1000)}s (${w.cues.length} lines)`).join(", ")}`);
    return result;
  })().catch((error) => {
    readFailed(filename, error, "extra windows: ");
    return found;
  });
  keepJob(jobKey, job);
  return job;
}

/** Every window measured (measureWindow, searched over centre ± 20 s), and the anchors they agree on. */
function measureAll(found: FileAnchors, captions: Cue[], centre = 0) {
  const measuredWindows = found.windows.flatMap((w) => {
    if (w.bridge) return [];
    // An index minute with only a few lines (a cold open before the opening song) is too few to time
    // by; it takes its neighbours' timing.
    if (found.source === "index" && w.cues.length < INDEX_MIN_WINDOW_LINES) return [];
    const measured = measureWindow(w.cues, captions, 20000, centre);
    return measured ? [{ from: w.from, to: w.to, measured }] : [];
  });
  const anchors = agreeAnchors(measuredWindows);
  return { measuredWindows, anchors: found.source === "index" ? dropSpikes(anchors) : anchors };
}

/**
 * On index windows, which follow each other minute by minute: a window whose shift is far from both
 * neighbours while they agree is a chance fit, not a cut (a cut changes every window after it). Seen with
 * an OpenSubtitles English: +1.24 s, +5.76 s, +1.27 s at 2, 3 and 4 minutes.
 */
export function dropSpikes(anchors: Anchor[]): Anchor[] {
  const sorted = [...anchors].sort((a, b) => a.from - b.from);
  return sorted.filter((a, i) => {
    const before = sorted[i - 1];
    const after = sorted[i + 1];
    if (!before || !after) return true;
    const spike = Math.abs(a.offset - before.offset) > SPIKE_MS && Math.abs(a.offset - after.offset) > SPIKE_MS && Math.abs(before.offset - after.offset) <= AGREE_MS;
    return !spike;
  });
}

const SPIKE_MS = 1500;
/** Index windows with fewer lines aren't measured (minutes of dialogue held 8 to 27 on one episode). */
const INDEX_MIN_WINDOW_LINES = 6;

// ---------- what overlap can't place: timing far off, and lines that start right but last otherwise ----------

/**
 * How the windows' own best fits sit against the final timing, in the file's order: how many land
 * within LAND_MS of the timing there (as landsOnTiming counts them), and the longest run of windows
 * in a row that don't. A window with no fit of its own counts as not landing. A real subtitle misses
 * a window here and there, where a chance fit beat its own; a stretch the timing doesn't hold for
 * (a scene only one cut has, another episode's dialogue) misses window after window.
 */
export function landing(windows: Array<{ from: number; measured?: Measured }>, anchors: Anchor[]): { landed: number; astray: number } {
  if (anchors.length === 0) return { landed: 0, astray: windows.length };
  const timingAt = (from: number) => anchors.reduce((a, b) => (Math.abs(b.from - from) < Math.abs(a.from - from) ? b : a)).offset;
  let landed = 0;
  let run = 0;
  let astray = 0;
  for (const w of [...windows].sort((a, b) => a.from - b.from)) {
    if (w.measured && Math.abs(w.measured.offset - timingAt(w.from)) <= LAND_MS) {
      landed++;
      run = 0;
    } else astray = Math.max(astray, ++run);
  }
  return { landed, astray };
}

/** More windows in a row than this off the timing: a stretch it doesn't hold for (see landing). */
const MAX_ASTRAY_RUN = 4;

/**
 * measureWindow by line starts: the shift, over ±range, at which the most of the window's own line
 * starts have a caption start within LINE_TOLERANCE_MS. Overlap can't tell shifts apart when the
 * captions' lines last otherwise than the file's: an official translation that runs each line on
 * until the next and merges short lines covers the file's dialogue about as well at many shifts,
 * but its lines still start where the file's do. The two ends of the range aren't peaks. `starts`: the captions' starts (captionStarts).
 */
export function measureStarts(lines: Cue[], starts: number[], range = 20000): Measured | undefined {
  if (lines.length < 3 || starts.length < 3) return undefined;
  const shares = Array.from(startCurve(lines, starts, range), (m) => m / lines.length);
  const peaks = curvePeaks(shares, range).filter((p) => Math.abs(p.offset) < range - LINE_TOLERANCE_MS);
  const best = peaks[0];
  if (!best || Math.round(best.score * lines.length) < STARTS_MIN_MATCHED) return undefined;
  const round = (p: { offset: number; score: number }) => ({ offset: p.offset, score: Math.round(p.score * 100) / 100 });
  return { ...round(best), alternatives: peaks.slice(1).filter((p) => p.score >= best.score * 0.9 && Math.abs(p.offset - best.offset) > 400).map(round) };
}

/** A window's best line-start fit must meet at least this many of its lines. */
const STARTS_MIN_MATCHED = 3;

/**
 * Timing by line starts alone (measureStarts per window), for a translation on a file timed from its
 * index that no shift fits by overlap. Every index window with lines counts, measured or not: at
 * least STARTS_MIN_LANDED of them must land on the final timing with their own best fit, never more
 * than MAX_ASTRAY_RUN in a row off it, and the timing must pass what a shift per stretch passes
 * (trusted: fitsFile, landsOnTiming, holdsTogether). Each line starts where it does in the
 * subtitle, so this is for translations only (dub captions' lines are the dub's own).
 *
 * Calibration (a show's official translation whose shift steps by about 3 s at each break: +1.7,
 * +5.1, +8.6, +11.1, +15.6 s through one episode): by overlap 10 to 15 of their 39 to 43 windows
 * land on the timing, by line starts 22 to 34. Of 3,611 pairs of a file with another episode's or
 * another show's subtitle, none passes (see STARTS_MIN_WINDOWS).
 */
export function byStarts(found: FileAnchors, captions: Cue[]): (Measurement & { landed: number; windows: number; astray: number }) | undefined {
  const trial = startsTrial(found, captions);
  if (!trial || !trusted(trial) || trial.landed < STARTS_MIN_LANDED * trial.windows || trial.astray > MAX_ASTRAY_RUN) return undefined;
  return trial;
}

/** What byStarts measures, before it decides: undefined when the file isn't one it can time. */
export function startsTrial(found: FileAnchors, captions: Cue[]): (Measurement & { landed: number; windows: number; astray: number }) | undefined {
  if (found.source !== "index" || found.image || found.speechOnly) return undefined;
  const considered = found.windows.filter((w) => !w.bridge && !w.heard && w.cues.length >= INDEX_MIN_WINDOW_LINES);
  if (considered.length < STARTS_MIN_WINDOWS) return undefined;
  const starts = captionStarts(captions);
  const all = considered.map((w) => ({ from: w.from, to: w.to, measured: measureStarts(w.cues, starts) }));
  const measuredWindows = all.flatMap((w) => (w.measured ? [{ from: w.from, to: w.to, measured: w.measured }] : []));
  const anchors = dropSpikes(agreeAnchors(measuredWindows));
  return { measuredWindows, anchors, windows: considered.length, ...landing(all, anchors) };
}

/**
 * Fewer index windows with lines than this is too little to time a file by line starts alone: chance
 * lands a larger share of few windows. Over 2,766 pairs of a file with another episode's or show's
 * subtitle, the most that landed was 44% of 12 to 19 windows (three of those passed trusted), 41% of 20
 * to 29, 37% of 30 to 39 and 33% of 40 or more, none of these passing trusted.
 */
const STARTS_MIN_WINDOWS = 24;
/** The share of those windows that must land on the timing with their own best line-start fit. */
const STARTS_MIN_LANDED = 0.5;

/**
 * Timing the usual search (±20 s around 0, a window's own best fit) doesn't find: further off, or in
 * stretches a window's own fit can't tell apart. Two ways, both from where the lines start:
 *
 * - **In stretches** (farStretches), asked first, on a file read whole from its index. With
 *   `stretchesOnly`, nothing else is asked.
 * - **At one far shift:** a release that opens with a recap, or has a longer cold open than the
 *   subtitle's, moves every line by a minute or so. The line starts over the whole file find the
 *   shift most of it sits at (wideFit), and every window is measured again around it. Asked when that
 *   shift meets FAR_MIN_SCORE of the line starts and is more than FAR_FROM_MS off (nearer, the usual
 *   search already covered it). A scene before a longer opening song is looked for near 0 first
 *   (nearStart).
 *
 * Either is taken when its windows pass what a shift per stretch passes (trusted), never more than
 * FAR_MAX_ASTRAY_RUN of them in a row are off it (a recap or a song of a minute or two), it moves no
 * more than FAR_MAX_BEFORE_START lines to before the file starts, and FAR_MIN_LANDED of the windows
 * land on it with their own best fit, or else the timing as planned meets FAR_MIN_MET of the file's
 * line starts and more than the best single shift does. A longer cut's subtitle with one scene more
 * after its cold open sits a minute off everywhere but the cold open, whose lines would go before the
 * start: refused.
 */
export function farTiming(found: FileAnchors, captions: Cue[], stretchesOnly = false): (Measurement & { centre: number; landed: number; windows: number }) | undefined {
  if (found.speechOnly) return undefined;
  const wide = wideFit(found, captions);
  if (!wide) return undefined;
  const fewest = found.source === "index" ? INDEX_MIN_WINDOW_LINES : 3;
  const considered = found.windows.filter((w) => !w.bridge && !w.heard && w.cues.length >= fewest);
  const passes = (m: Measurement) => {
    if (!trusted(m)) return undefined;
    const { landed, astray } = landing(considered.map((w) => ({ from: w.from, measured: m.measuredWindows.find((x) => x.from === w.from)?.measured })), m.anchors);
    if (astray > FAR_MAX_ASTRAY_RUN) return undefined;
    const shift = planShifts(m.anchors, captions);
    // Fewer windows on it with their own best fit: the timing as planned must then meet more of the
    // file's line starts than the best single shift does, as only a timing in stretches can.
    if (landed < FAR_MIN_LANDED * considered.length) {
      const met = startsMet(considered.flatMap((w) => w.cues), captions, shift);
      if (met < FAR_MIN_MET || met <= wide.score) return undefined;
    }
    if (captions.filter((c) => c.start + shift(c.start) < 0).length > FAR_MAX_BEFORE_START) return undefined;
    return { ...m, centre: wide.offset, landed, windows: considered.length };
  };
  // Stretches first: the line starts place every window among all the shifts at once, where the
  // windows' own fits around one shift are often chance (a song's window, a scene before it).
  const stretched = found.source === "index" ? farStretches(captions, considered, wide.score) : undefined;
  const byStretch = stretched && passes(stretched);
  if (byStretch) return byStretch;
  if (stretchesOnly || Math.abs(wide.offset) <= FAR_FROM_MS || wide.score < FAR_MIN_SCORE) return undefined;
  const m = measureAll(found, captions, wide.offset);
  // A start that is near is asked before one shift for all: measured around the far shift, a scene
  // before the song finds some chance fit there, and its lines would be left as far off as the rest.
  const led = wide.offset > 0 ? nearStart(found, captions, m) : undefined;
  return (led && passes(led)) ?? passes(m);
}

/**
 * The timing in stretches (farStretches), when it shows the timing the windows' own fits gave to be
 * wrong somewhere: dub captions' lines are another script's, and a window's best overlap is at times
 * a chance one that its neighbours happen to accept (a minute or two then sits many seconds off).
 * The spoken line starts each timing meets are counted (within the path's own reach of a shift):
 * the stretches take over when they meet STRETCH_OVER_LINES more over the file. Undefined when the
 * timing found stands.
 */
export function stretchesOver(found: FileAnchors, captions: Cue[], anchors: Anchor[]): ReturnType<typeof farTiming> {
  if (found.speechOnly || anchors.length === 0) return undefined;
  const stretched = farTiming(found, captions, true);
  if (!stretched) return undefined;
  const reach = LINE_TOLERANCE_MS + STRETCH_SAME * LINE_STEP_MS;
  const now = planShifts(anchors, captions);
  const then = planShifts(stretched.anchors, captions);
  const lines = found.windows.filter((w) => !w.bridge && !w.heard).flatMap((w) => spoken(w.cues));
  const gain = Math.round((startsMet(lines, captions, then, reach) - startsMet(lines, captions, now, reach)) * lines.length);
  return gain >= STRETCH_OVER_LINES ? stretched : undefined;
}

/**
 * How many more line starts the stretches must meet to take a timing over.
 * Calibration (a broadcast's captions on a disc's files): 15 more where two minutes sat 20 s off.
 */
const STRETCH_OVER_LINES = 6;

/**
 * A timing in stretches, found window by window from where the lines start. For a file read whole
 * from its index: a broadcast's captions on a disc's file sit near before the opening song, far off
 * after it and a little further after each break, and a window's own best overlap is often a chance
 * one.
 *
 * - Each window's line starts peak at a few shifts over ±WIDE_RANGE_MS, one of them its own. Which
 *   one is told by its neighbours: a real timing holds one shift window after window. The run of
 *   shifts that meets the most line starts in all, each change costing STRETCH_CHANGE_LINES of them,
 *   is the timing (a best path over the windows' peaks).
 * - Only spoken lines count (see spoken), and no shift far and earlier is looked at: a file that has
 *   more than the captions is timed this way, never captions that have more than the file.
 * - The run is judged on lines it wasn't found with. With a few lines a window and many shifts to
 *   pick from, a run of chance peaks meets as many line starts as a real timing; found again with
 *   every other line, it must meet the lines left out: STRETCH_MIN_REACHED of them, and
 *   STRETCH_MIN_GAIN more than the best single shift (`single`).
 * - A short run far from the one before it is left out (STRETCH_STRAY_WINDOWS). Each run takes its
 *   shift to a step, and each change of shift is placed to a line (stepByStarts) and carried on the
 *   anchor that follows it (Anchor.stepAt).
 *
 * The caller holds the result to its own tests (farTiming's `passes`).
 */
function farStretches(captions: Cue[], windows: FileAnchors["windows"], single: number): Measurement | undefined {
  const sorted = [...windows].sort((x, y) => x.from - y.from).map((w) => ({ ...w, cues: spoken(w.cues) })).filter((w) => w.cues.length >= STRETCH_PEAK_LINES);
  if (sorted.length < STRETCH_MIN_WINDOWS) return undefined;
  const starts = captionStarts(captions);
  const apart = Math.round(1000 / LINE_STEP_MS);
  const earliest = Math.round((WIDE_RANGE_MS - FAR_FROM_MS) / LINE_STEP_MS);
  // A window meets a shift by its best count within STRETCH_SAME of it: peaks of one stretch sit a step or two apart.
  const meets = (curve: Int32Array, i: number): number => {
    let most = 0;
    for (let k = Math.max(0, i - STRETCH_SAME); k <= Math.min(curve.length - 1, i + STRETCH_SAME); k++) most = Math.max(most, curve[k]);
    return most;
  };
  // The first window's shift is the one the captions before it take: none that moves a line to before the file starts.
  const tooEarly = (i: number): boolean => {
    const offset = -WIDE_RANGE_MS + i * LINE_STEP_MS;
    return offset < 0 && captions.some((c) => c.start + offset < 0);
  };
  /** The best run of shifts for these lines, a window each: the shift (in steps) per window. */
  const run = (lines: Cue[][]): number[] | undefined => {
    const curves = lines.map((own) => startCurve(own, starts, WIDE_RANGE_MS));
    // The shifts to choose from: each window's highest peaks, a second apart. None far and earlier:
    // a song's lines, evenly spaced, meet the captions' at many shifts by chance.
    const shifts: number[] = [];
    for (const curve of curves) {
      const own: number[] = [];
      const order = Array.from(curve.keys()).filter((k) => k >= earliest).sort((x, y) => curve[y] - curve[x]);
      for (const k of order) {
        if (own.length >= STRETCH_PEAKS || curve[k] < STRETCH_PEAK_LINES) break;
        if (own.every((o) => Math.abs(k - o) > apart)) own.push(k);
      }
      for (const k of own) if (shifts.every((o) => Math.abs(k - o) > STRETCH_SAME)) shifts.push(k);
    }
    if (shifts.length === 0) return undefined;
    const met = curves.map((curve) => shifts.map((k) => meets(curve, k)));
    let best = met[0].map((count, k) => (tooEarly(shifts[k]) ? count - 1e6 : count));
    const from: number[][] = [];
    for (let w = 1; w < curves.length; w++) {
      let top = 0;
      for (let k = 1; k < best.length; k++) if (best[k] > best[top]) top = k;
      const next = new Array<number>(shifts.length);
      const back = new Array<number>(shifts.length);
      for (let k = 0; k < shifts.length; k++) {
        const stay = best[k] >= best[top] - STRETCH_CHANGE_LINES;
        back[k] = stay ? k : top;
        next[k] = (stay ? best[k] : best[top] - STRETCH_CHANGE_LINES) + met[w][k];
      }
      from.push(back);
      best = next;
    }
    let at = 0;
    for (let k = 1; k < best.length; k++) if (best[k] > best[at]) at = k;
    const path = new Array<number>(curves.length);
    for (let w = curves.length - 1; w >= 0; w--) {
      path[w] = shifts[at];
      if (w > 0) at = from[w - 1][at];
    }
    return path;
  };
  const all = sorted.map((w) => w.cues);
  const path = run(all);
  if (!path) return undefined;
  // The run is judged on lines it wasn't found with: found with every other line of each window, it
  // must meet the lines between them. Among enough shifts, a few lines a window meet some by chance,
  // and the best run of chance meets as many as a real timing does; the lines left out tell them apart.
  const halves = [0, 1].map((odd) => all.map((own) => own.filter((_, n) => n % 2 === odd)));
  let held = 0;
  for (const [found, left] of [halves, [halves[1], halves[0]]]) {
    const half = run(found);
    if (!half) return undefined;
    left.forEach((own, w) => (held += meets(startCurve(own, starts, WIDE_RANGE_MS), half[w])));
  }
  const lines = all.reduce((sum, own) => sum + own.length, 0);
  const reached = held / lines;
  if (reached < Math.max(STRETCH_MIN_REACHED, single + STRETCH_MIN_GAIN)) return undefined;
  // A run of a window or two that sits far from the run before it is chance (few lines, at a break
  // or by the credits), not a stretch: its windows are left out, and take their neighbours' timing.
  const stray = new Set<number>();
  for (let w = 1, begun = 0; w <= sorted.length; w++) {
    if (w < sorted.length && Math.abs(path[w] - path[begun]) <= STRETCH_SAME) continue;
    if (begun > 0 && w - begun <= STRETCH_STRAY_WINDOWS && Math.abs(path[begun] - path[begun - 1]) * LINE_STEP_MS > FAR_FROM_MS) for (let n = begun; n < w; n++) stray.add(n);
    begun = w;
  }
  // The shift of each window kept, and the runs of them that share one.
  const kept: Array<number | undefined> = sorted.map((_, n) => (stray.has(n) ? undefined : -WIDE_RANGE_MS + path[n] * LINE_STEP_MS));
  const runs: number[][] = [];
  kept.forEach((offset, n) => {
    if (offset === undefined) return;
    const last = runs[runs.length - 1];
    if (last && Math.abs(offset - kept[last[last.length - 1]]!) <= STRETCH_SAME * LINE_STEP_MS) last.push(n);
    else runs.push([n]);
  });
  const middle = (run: number[]): number => run.map((n) => kept[n]!).sort((x, y) => x - y)[run.length >> 1];
  // Each run's shift to a step: the path's shifts are peaks merged within STRETCH_SAME of each other,
  // so the run takes the shift, that near its own, at which its windows' line starts meet the most
  // together (a plateau's middle).
  const curves = all.map((own) => startCurve(own, starts, WIDE_RANGE_MS));
  for (const run of runs) {
    const at = Math.round((middle(run) + WIDE_RANGE_MS) / LINE_STEP_MS);
    const sum = (k: number) => run.reduce((total, n) => total + curves[n][k], 0);
    let best = at;
    for (let k = Math.max(0, at - STRETCH_SAME); k <= Math.min(curves[0].length - 1, at + STRETCH_SAME); k++) if (sum(k) > sum(best)) best = k;
    let begin = best;
    let end = best;
    while (begin > 0 && sum(begin - 1) === sum(best)) begin--;
    while (end + 1 < curves[0].length && sum(end + 1) === sum(best)) end++;
    const offset = -WIDE_RANGE_MS + Math.round((begin + end) / 2) * LINE_STEP_MS;
    for (const n of run) kept[n] = offset;
  }
  // Where each change of shift sits, to a line: the path knows it to a window, and a window on the
  // wrong side of it would carry a minute of lines to the other stretch's shift. The step is placed
  // by the line starts (stepByStarts) between the last two windows of one run and the first two of
  // the next; windows wholly on one side of it take that side's shift, and those it runs through are
  // left out.
  const lineStarts = all.flatMap((own) => own.map((c) => c.start)).sort((x, y) => x - y);
  const read = windows.map((w) => ({ from: w.from, to: w.to }));
  const stepsAt = new Map<number, number>();
  for (let r = 0; r + 1 < runs.length; r++) {
    const before = runs[r];
    const after = runs[r + 1];
    const A = middle(before);
    const B = middle(after);
    if (Math.abs(A - B) <= AGREE_MS) continue;
    const a = { from: sorted[before[Math.max(0, before.length - 2)]].from, to: sorted[before[before.length - 1]].to, offset: A, score: 1 };
    const b = { from: sorted[after[0]].from, to: sorted[after[Math.min(after.length - 1, 1)]].to, offset: B, score: 1 };
    const at = stepByStarts(a, b, captions, lineStarts, starts, read);
    const lo = at + Math.min(A, B);
    const hi = at + Math.max(A, B);
    for (const n of [...before.slice(-2), ...after.slice(0, 2)]) {
      const w = sorted[n];
      if (w.to <= lo) kept[n] = before.includes(n) ? kept[n] : A;
      else if (w.from >= hi) kept[n] = after.includes(n) ? kept[n] : B;
      else kept[n] = undefined;
    }
    stepsAt.set(r + 1, at);
  }
  const measuredWindows = sorted.flatMap((w, n) => {
    const offset = kept[n];
    if (offset === undefined) return [];
    // The shift as the line starts give it: the best overlap beside it sits a few hundred ms off for
    // lines of another script, and would take the captions off the starts they were placed by. Its
    // score is what every other timing's is, the share of the window's lines the captions cover at
    // that shift: the share of line starts met is another measure, and reads low for a good fit.
    const length = w.cues.reduce((sum, c) => sum + (c.end - c.start), 0);
    const covered = w.cues.reduce((sum, c) => sum + Math.min(1, coverage(c, captions, offset)) * (c.end - c.start), 0);
    return [{ from: w.from, to: w.to, measured: { offset, score: length > 0 ? Math.round((covered / length) * 100) / 100 : 0, alternatives: [] } }];
  });
  // Each run's first window still kept carries the step that leads to it.
  const stepOf = new Map<number, number>();
  runs.forEach((run, r) => {
    const at = stepsAt.get(r);
    if (at === undefined) return;
    const B = middle(run);
    const first = measuredWindows.find((w) => w.from >= sorted[run[0]].from && Math.abs(w.measured.offset - B) <= AGREE_MS);
    if (first) stepOf.set(first.from, at);
  });
  const anchors: Anchor[] = measuredWindows.map((w) => ({ from: w.from, to: w.to, offset: w.measured.offset, score: w.measured.score, ...(stepOf.has(w.from) ? { stepAt: stepOf.get(w.from) } : {}) }));
  return { measuredWindows, anchors };
}

/** The fewest windows with spoken lines to find stretches among: a file read whole from its index, minute by minute. */
const STRETCH_MIN_WINDOWS = 12;
/** A run this short, more than FAR_FROM_MS from the run before it, is left out. */
const STRETCH_STRAY_WINDOWS = 2;
/** How many of a window's peaks are shifts to choose from, and the fewest line starts one must meet. */
const STRETCH_PEAKS = 3;
const STRETCH_PEAK_LINES = 3;
/** Peaks this many steps apart or fewer are one shift. */
const STRETCH_SAME = 10;
/**
 * What a change of shift costs, in line starts met: a stretch must meet this many more than staying
 * on its neighbour's shift would. Calibration (a broadcast's captions on a disc's files): a window on
 * its own shift met 5 to 9 of about 12 lines, on another 2 to 4.
 */
const STRETCH_CHANGE_LINES = 3;
/**
 * The share of the spoken line starts the stretches must meet in all.
 * Calibration (a season of a broadcast's captions on a disc's files, 39 episodes): 0.51 to 0.69;
 * chance peaks on another episode's subtitle, 0.35.
 */
const STRETCH_MIN_REACHED = 0.45;
/** How much more of the file's line starts the stretches must meet than the best single shift. */
const STRETCH_MIN_GAIN = 0.05;

/** The share of the file's lines that have a caption start within `within` of their own once the captions are moved by `shift`. */
function startsMet(lines: Cue[], captions: Cue[], shift: (start: number) => number, within = LINE_TOLERANCE_MS): number {
  if (lines.length === 0) return 0;
  const starts = captions.map((c) => c.start + shift(c.start)).sort((x, y) => x - y);
  const near = (t: number): boolean => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return (lo < starts.length && starts[lo] - t <= within) || (lo > 0 && t - starts[lo - 1] <= within);
  };
  return lines.filter((c) => near(c.start)).length / lines.length;
}

/**
 * A far timing whose start is near: the file's opening song runs longer than the captions' release
 * gave it, so the scene before the song sits within the usual search and everything after it far off.
 * Only for a file that has more than the captions (a far shift later, which opens a gap in them and
 * loses no line); captions with more than the file are another cut's. Of the runs of windows from
 * the file's start within NEAR_LEAD_MS, the one whose line starts single out a shift most clearly
 * (wideFit's margin over the usual range, with NEAR_MIN_SCORE at least) is that scene: each of its
 * windows is measured beside that shift, and the windows after them keep what they measured around
 * the far one.
 */
function nearStart(found: FileAnchors, captions: Cue[], far: Measurement): Measurement | undefined {
  const fewest = found.source === "index" ? INDEX_MIN_WINDOW_LINES : 3;
  const first = found.windows.filter((w) => !w.bridge && !w.heard && w.from < NEAR_LEAD_MS).sort((a, b) => a.from - b.from).map((w) => ({ ...w, cues: spoken(w.cues) }));
  // The last of them may hold the song: the run from the start whose shift stands out most is taken.
  const runs = first.flatMap((_, n) => {
    const lead = first.slice(0, n + 1);
    const fit = wideFit({ ...found, windows: lead }, captions, NEAR_RANGE_MS);
    return fit && fit.score >= NEAR_MIN_SCORE && fit.margin >= FAR_MIN_MARGIN ? [{ lead, fit }] : [];
  });
  for (const { lead, fit } of runs.sort((x, y) => y.fit.margin - x.fit.margin).slice(0, 1)) {
    // Each window's own fit, looked for beside the shift they share: overlap alone can't tell shifts
    // apart over the whole range when the captions' lines are another script's. A window with no fit
    // of its own there (the scene's last lines, then the song's) takes the shared shift as it is.
    const near = lead.flatMap((w) => {
      if (w.cues.length === 0) return [];
      const measured = (w.cues.length >= fewest ? measureWindow(w.cues, captions, NEAR_BESIDE_MS, fit.offset) : undefined) ?? { offset: fit.offset, score: fit.score, alternatives: [] };
      return [{ from: w.from, to: w.to, measured }];
    });
    if (near.length === 0) return undefined;
    // The start's windows are anchors as they are: their shared shift vouches for them, where one or
    // two windows alone have no neighbour to agree with.
    const rest = far.measuredWindows.filter((w) => w.from > lead[lead.length - 1].from);
    const agreed = (found.source === "index" ? dropSpikes(agreeAnchors(rest)) : agreeAnchors(rest)).sort((x, y) => x.from - y.from);
    // The window after the scene holds the song: a fit there that the next window doesn't share is
    // chance, and would count as one more change of shift.
    while (agreed.length > 1 && Math.abs(agreed[0].offset - agreed[1].offset) > SPIKE_MS) agreed.shift();
    return { measuredWindows: [...near, ...rest], anchors: [...near.map((w) => ({ from: w.from, to: w.to, offset: w.measured.offset, score: w.measured.score })), ...agreed] };
  }
  return undefined;
}

/**
 * A window's lines without those that start together with another: a song's two scripts, or a sign
 * with its line, not dialogue. Evenly spaced pairs meet the captions' line starts at many shifts.
 */
function spoken(cues: Cue[]): Cue[] {
  const starts = new Map<number, number>();
  for (const c of cues) starts.set(c.start, (starts.get(c.start) ?? 0) + 1);
  return cues.filter((c) => starts.get(c.start) === 1);
}

/** How far into the file the scene before the song may reach. */
const NEAR_LEAD_MS = 300000;
/** The usual search's range, for the start of a far timing. */
const NEAR_RANGE_MS = 20000;
/**
 * What the start's line starts must reach together: a minute or two of lines is few, so more than a
 * whole file's must meet. Calibration (a broadcast's captions on a disc's file): 0.59 over the scene
 * before the song at a margin of 0.18; with the song's minute added, 0.38 at a margin of 0.
 */
const NEAR_MIN_SCORE = 0.3;
/** How far from the start's shared shift a window's own fit is looked for. */
const NEAR_BESIDE_MS = 500;

/** How far off the line starts' shift must be to search around it instead of around 0. */
const FAR_FROM_MS = 10000;
/**
 * What wideFit must find. Over 3,611 pairs of a file with another episode's or show's subtitle, the
 * best margin was 0.05; this file's own subtitles at one shift scored 0.2 to 0.84 (dub captions,
 * whose lines are their own, lower: their stretches of talk start where the file's do).
 */
const FAR_MIN_SCORE = 0.2;
/** The margin the start's own shift must have (see nearStart). */
const FAR_MIN_MARGIN = 0.1;
/** The share of the windows with lines that must land on the far timing with their own best fit. */
const FAR_MIN_LANDED = 0.75;
/**
 * With fewer windows landing, the share of the file's line starts the timing as planned must meet.
 * Calibration (a broadcast's captions on a disc's files): 0.33 over three stretches, where the best
 * single shift met 0.30; 0.46 and 0.5 over two, where it met 0.36 and 0.37.
 */
const FAR_MIN_MET = 0.3;
/**
 * The most windows in a row that may be off the far timing: a recap, or an opening song whose lines
 * the file's track carries and the captions don't, with the window either side of it.
 */
const FAR_MAX_ASTRAY_RUN = 4;
/** The most lines the far timing may move to before the file starts (a credit at 0:00, say). */
const FAR_MAX_BEFORE_START = 2;

// ---------- which of the file's tracks to time by ----------

/** The lines of every text track ranked for timing (the first and `others`) where they were read, not speech. */
function trackLines(found: FileAnchors): Cue[] {
  return found.windows.filter((w) => !w.heard && !w.bridge).flatMap((w) => [...w.cues, ...Object.values(w.others ?? {}).flat()]);
}

/** The file's windows as another of its text tracks read them (see FileAnchors.others and langTracks). */
export function trackView(found: FileAnchors, track: number): FileAnchors {
  return { ...found, windows: found.windows.map((w) => ({ ...w, cues: w.others?.[track] ?? w.langs?.[track] ?? [] })) };
}

/**
 * The tracks to time captions by, in order: the best ranked ("first") and the others read beside it,
 * with the file's own track in the captions' language (`lang`) moved to the front when it has one.
 * Dub captions (no language) and older records (no trackLangs) keep the usual order.
 */
export function tracksToTry(found: FileAnchors, lang?: string): Array<"first" | number> {
  const usual: Array<"first" | number> = ["first", ...(found.others ?? [])];
  const langs = found.trackLangs;
  if (!lang || !langs) return usual;
  const tag = (track: "first" | number): string | undefined => langs[String(track === "first" ? found.track : track)];
  const own = [...usual, ...(found.langTracks ?? [])].find((track) => {
    const language = tag(track);
    return language !== undefined && sameLanguage(language, lang);
  });
  return own === undefined || own === "first" ? usual : [own, ...usual.filter((track) => track !== own)];
}

/** The file's windows with no lines at all: every track was too sparse, so only speech is left. */
function noLines(found: FileAnchors): FileAnchors {
  return { ...found, windows: found.windows.map((w) => ({ ...w, cues: [] })), rounds: MAX_ROUNDS };
}

/**
 * Whether a track has fewer than half as many lines as the captions, per minute: a track of signs,
 * songs or forced lines that wasn't labelled as one. Lines read in the windows are compared with
 * the captions' lines over their whole length, so a shift or a frame rate doesn't change it.
 */
export function sparseTrack(found: FileAnchors, captions: Cue[]): boolean {
  const windows = found.windows.filter((w) => !w.bridge && !w.heard);
  const readMs = windows.reduce((sum, w) => sum + (w.to - w.from), 0);
  const span = captions.length > 1 ? captions[captions.length - 1].end - captions[0].start : 0;
  if (readMs <= 0 || span <= 0) return false;
  const lines = windows.reduce((sum, w) => sum + w.cues.length, 0);
  return lines / readMs < SPARSE_SHARE * (captions.length / span);
}

const SPARSE_SHARE = 0.5;

/**
 * Which of the file's subtitle tracks to time these captions by: "first" (the best ranked, see
 * rankTracks), another text track read beside it (its index), or undefined when every track is too
 * sparse (see sparseTrack) and only speech can time them. A track is skipped when it's sparse; the
 * first one that fits on the windows read so far wins (as written or at another frame rate). When
 * none fits yet, the first track that isn't sparse is kept: extra windows may still fit it.
 */
export function trackChoice(found: FileAnchors, captions: Cue[], lang?: string): "first" | number | undefined {
  return finish(trackChoiceSteps(found, captions, lang)).track;
}

/**
 * The track chosen, with what was measured on the way so it isn't measured twice: the captions as
 * written on that track, and (when `rated` is there, even as undefined) what rescaled made of them.
 */
type TrackPick = { track: "first" | number | undefined; asWritten?: Measurement; rated?: Rescaled | undefined };

/** trackChoice, one measurement per step. */
function* trackChoiceSteps(found: FileAnchors, captions: Cue[], lang?: string): Steps<TrackPick> {
  const candidates = tracksToTry(found, lang);
  let fallback: TrackPick | undefined;
  for (const track of candidates) {
    const view = track === "first" ? found : trackView(found, track);
    if (!view.windows.some((w) => w.cues.length) || sparseTrack(view, captions)) continue;
    yield;
    const asWritten = measureAll(view, captions);
    // Fits as written: whether it also wants rescaling (steps that are really a drift) is left to the caller.
    if (trusted(asWritten)) return { track, asWritten };
    const rated = yield* rescaledSteps(view, captions, asWritten);
    if (rated) return { track, asWritten, rated };
    fallback ??= { track, asWritten, rated: undefined };
  }
  return fallback ?? { track: undefined };
}

/**
 * What syncCaptions decides for these captions on windows already read, without reading more of the
 * file: the replay check (scripts/replay.ts) runs it over past plays. Live syncs check fitsFile on
 * the first windows, before extra rounds; here every stored window counts.
 */
export function judge(stored: FileAnchors, captions: Cue[], lang?: string): { verdict: "synced" | "wrong" | "rejected" | "unsynced"; anchors: Anchor[]; offsets: number[]; bySpeech?: boolean; byLines?: boolean; byStarts?: boolean; far?: number; factor?: number; track?: "first" | number } {
  // Every timing must also account for the whole file (accountsForFile), as in syncCaptions.
  const whole = (view: FileAnchors, timed: Cue[], shift: (start: number) => number, perWindow?: Anchor[]) => !accountsForFile(view, timed, shift, perWindow);
  // Timed by speech, by its plan: one shift, or a shift per stretch where it steps (see syncCaptions).
  const heardWhole = (view: FileAnchors, timed: Cue[], speech: NonNullable<ReturnType<typeof bySpeech>>) => whole(view, timed, planShifts(speech.anchors, timed, speech.reference));
  if (stored.speechOnly) {
    const speech = bySpeech(stored, captions);
    return speech && heardWhole(stored, captions, speech) ? { verdict: "synced", anchors: speech.anchors, offsets: [], bySpeech: true } : { verdict: "unsynced", anchors: [], offsets: [] };
  }
  const track = trackChoice(stored, captions, lang);
  const found = track === undefined ? noLines(stored) : track === "first" ? stored : trackView(stored, track);
  const asWritten = measureAll(found, captions);
  const rated = rescaled(found, captions, asWritten);
  // Made for another frame rate: from here on the captions are rescaled, as syncCaptions has them.
  const timed = rated ? rated.captions : captions;
  const { measuredWindows, anchors } = rated ?? asWritten;
  const offsets = measuredWindows.map((w) => w.measured.offset);
  // What no shift fits within the usual search: line by line first (live, for languages other than
  // the dub captions), then one shift far beyond it, then line starts (live, the same languages), then speech.
  const heard = () => {
    const lined = byLines(stored, timed, lang);
    if (lined && whole(lined.track === "first" ? stored : trackView(stored, lined.track), timed, shiftLookup(lined.shifts))) return { verdict: "synced" as const, anchors: lined.anchors, offsets, byLines: true, track: lined.track };
    const far = farTiming(found, timed);
    if (far && whole(found, timed, planShifts(far.anchors, timed))) return { verdict: "synced" as const, anchors: far.anchors, offsets: far.measuredWindows.map((w) => w.measured.offset), far: far.centre, track };
    const started = byStarts(found, timed);
    if (started && whole(found, timed, planShifts(started.anchors, timed, [], true))) return { verdict: "synced" as const, anchors: started.anchors, offsets: started.measuredWindows.map((w) => w.measured.offset), byStarts: true, track };
    const speech = bySpeech(found, timed);
    return speech && heardWhole(found, timed, speech) ? { verdict: "synced" as const, anchors: speech.anchors, offsets, bySpeech: true } : undefined;
  };
  if (!fitsFile(measuredWindows)) return heard() ?? { verdict: "wrong", anchors: [], offsets };
  if (anchors.length === 0) return heard() ?? { verdict: "unsynced", anchors, offsets };
  if (!landsOnTiming(measuredWindows, anchors)) return heard() ?? { verdict: "rejected", anchors: [], offsets };
  if (!holdsTogether(anchors)) return heard() ?? { verdict: "rejected", anchors: [], offsets };
  if (!whole(found, timed, planShifts(anchors, timed, found.windows.flatMap((w) => w.cues)), anchors)) return heard() ?? { verdict: "rejected", anchors: [], offsets };
  const over = !lang && !rated ? stretchesOver(found, timed, anchors) : undefined;
  if (over && whole(found, timed, planShifts(over.anchors, timed))) return { verdict: "synced", anchors: over.anchors, offsets: over.measuredWindows.map((w) => w.measured.offset), far: over.centre, track };
  return { verdict: "synced", anchors, offsets, track, ...(rated ? { factor: rated.factor } : {}) };
}

/**
 * Timing from speech heard in the audio (Silero, English audio first, see pickAudio): for a file with
 * no subtitle track, and as the last resort when captions fit the track nowhere (dub captions follow
 * the English audio, not the translated track). All windows are matched at once (measureSpeechFile).
 * Over 8 recorded files it landed within 0.36 s on each against the file's own lines, and refused
 * another file's lines on all 8 (best margin 0.13). `lead`: how far ahead of the voice a line goes,
 * SPEECH_LEAD_MS for a translation, VOICE_LEAD_MS for dub captions.
 *
 * A subtitle for a release cut differently steps at a break, and the windows on each side of it meet
 * the voices at a shift of their own (see speechStep). Each side is then timed by its own windows,
 * when each has at least SPEECH_STRETCH_WINDOWS that say so clearly on their own. A step that fewer
 * windows show can't be placed, and the one shift the others agree on would leave that side's lines
 * seconds off, so nothing is timed: more of the file is heard first (see hearMoreSpeech).
 */
export function bySpeech(found: FileAnchors, captions: Cue[], lead = SPEECH_LEAD_MS): { anchors: Anchor[]; reference: Cue[]; score: number; margin: number; windows: number; steps?: number } | undefined {
  if (found.speechBy !== "silero") return undefined;
  const heard = speechHeard(found);
  if (heard.length < SPEECH_MIN_ANCHORS) return undefined;
  const curves = speechCurves(heard, captions);
  if (curves.length < SPEECH_MIN_ANCHORS) return undefined;
  // Lines show a little before the voice starts: a line start met at the voice is that much late.
  const placed = (anchors: Anchor[]) => anchors.map((a) => ({ ...a, offset: a.offset - lead }));
  const reference = heard.flatMap((w) => w.speech);
  const step = speechStep(curves, SPEECH_STRETCH_WINDOWS);
  if (step) return { anchors: placed([...step.before.anchors, ...step.after.anchors]), reference, score: Math.min(step.before.score, step.after.score), margin: Math.min(step.before.margin, step.after.margin), windows: curves.length, steps: 1 };
  const fit = fitCurves(curves);
  if (!clearSpeech(fit, SPEECH_MIN_ANCHORS)) return undefined;
  // The windows the one shift leaves out meet the voices at a shift of their own, too few to time by.
  if (speechStep(curves, SPEECH_STEP_SEEN_WINDOWS)) return undefined;
  return { anchors: placed(fit.anchors), reference, score: fit.score, margin: fit.margin, windows: curves.length };
}

/** The windows whose speech bySpeech times by: at least SPEECH_WINDOW_VOICES voices heard in each. */
function speechHeard(found: FileAnchors): Array<{ from: number; to: number; speech: Cue[] }> {
  return found.windows
    .filter((w) => !w.bridge)
    .map((w) => ({ from: w.from, to: w.to, speech: (found.speechOnly ? w.cues : w.speech) ?? [] }))
    .filter((w) => w.speech.length >= SPEECH_WINDOW_VOICES);
}

/** Voices a window of speech needs to time anything by (speechHeard). */
const SPEECH_WINDOW_VOICES = 3;

/**
 * Where to hear more of a file whose speech hints at a step it can't place (stepHint): on the side
 * with fewer windows on its shift, from the file's start (or end) to the nearest window on the other
 * side's shift, so the stretch between the two sides, where the step lies, counts as the thin side's
 * too. Each spot goes in the middle of the longest stretch there not heard yet, as many as
 * MORE_SPOTS, so this round costs at most what that one did. A spot where the subtitle has fewer
 * lines than a window needs voices (SPEECH_WINDOW_VOICES, by the subtitle's own times: a step of a
 * few seconds moves few lines across a window's edge) can't time it, and isn't heard: an opening
 * song, credits, a scene with no dialogue. Both sides as thin: the whole file. Undefined when speech
 * hints at no step, or places it already (speechStep).
 */
export function stepSpots(found: FileAnchors, captions: Cue[], span: number): number[] | undefined {
  if (found.speechBy !== "silero" || !found.duration) return undefined;
  const curves = speechCurves(speechHeard(found), captions);
  if (speechStep(curves, SPEECH_STRETCH_WINDOWS)) return undefined;
  const hint = stepHint(curves);
  if (!hint) return undefined;
  const thinBefore = hint.before.anchors.length <= hint.after.anchors.length;
  const thinAfter = hint.after.anchors.length <= hint.before.anchors.length;
  const from = thinBefore ? 0 : Math.max(...hint.before.anchors.map((a) => a.to));
  const to = thinAfter ? found.duration : Math.min(...hint.after.anchors.map((a) => a.from));
  const lines = (at: number) => captions.filter((c) => c.start >= at && c.start < at + span).length;
  const spots = unheardMiddles(found.windows, from, to, span, MORE_SPOTS.length, (at) => lines(at) >= SPEECH_WINDOW_VOICES);
  return spots.length ? spots : undefined;
}

/**
 * A step speech hints at: the windows (in order) cut in two, each side's own best fit (fitCurves) on
 * at least SPEECH_STEP_SEEN_WINDOWS windows and meeting at least SPEECH_MIN_SCORE of its voices, the
 * two more than SPEECH_STEP_MIN_MS apart; of those cuts, the one meeting the most speech. Neither
 * side has to stand clear of its rivals (clearSpeech), so this only chooses where more of the audio
 * is heard (stepSpots), never a timing.
 */
function stepHint(curves: Array<{ w: { from: number; to: number }; curve: { matched: number[]; heard: number } }>): { before: SpeechFit; after: SpeechFit } | undefined {
  let best: { before: SpeechFit; after: SpeechFit; met: number } | undefined;
  const fair = (fit: SpeechFit | undefined): fit is SpeechFit => fit !== undefined && fit.anchors.length >= SPEECH_STEP_SEEN_WINDOWS && fit.score >= SPEECH_MIN_SCORE;
  for (let k = SPEECH_STEP_SEEN_WINDOWS; k <= curves.length - SPEECH_STEP_SEEN_WINDOWS; k++) {
    const before = fitCurves(curves.slice(0, k));
    const after = fitCurves(curves.slice(k));
    if (!fair(before) || !fair(after) || Math.abs(before.offset - after.offset) <= SPEECH_STEP_MIN_MS) continue;
    const met = before.score * before.heard + after.score * after.heard;
    if (!best || met > best.met) best = { before, after, met };
  }
  return best && { before: best.before, after: best.after };
}

/**
 * Up to `count` window starts between `from` and `to`, each in the middle of the longest stretch
 * there that no window covers yet (counting those placed before it), while one still holds a window
 * of `span`. A middle that `worth` refuses is passed over, its stretch split all the same, so the
 * halves on either side of it are tried in turn.
 */
export function unheardMiddles(windows: Array<{ from: number; to: number }>, from: number, to: number, span: number, count: number, worth: (at: number) => boolean = () => true): number[] {
  const gaps: Array<[number, number]> = [];
  let at = from;
  for (const w of [...windows].sort((a, b) => a.from - b.from)) {
    if (w.to <= at || w.from >= to) continue;
    if (w.from > at) gaps.push([at, w.from]);
    at = Math.max(at, w.to);
  }
  if (to > at) gaps.push([at, to]);
  const spots: number[] = [];
  while (spots.length < count && gaps.length) {
    let longest = 0;
    for (let i = 1; i < gaps.length; i++) if (gaps[i][1] - gaps[i][0] > gaps[longest][1] - gaps[longest][0]) longest = i;
    const [a, b] = gaps[longest];
    if (b - a < span) break;
    const start = Math.round((a + b - span) / 2);
    if (worth(start)) spots.push(start);
    gaps.splice(longest, 1, [a, start], [start + span, b]);
  }
  return spots.sort((x, y) => x - y);
}

/**
 * Whether a fit of speech says clearly where the captions go: enough windows on it, enough speech
 * met, and no rival close. Among few voices chance alone makes a peak stand out: the best shift must
 * meet more voices than any shift a second away by SPEECH_CHANCE times the square root of the voices
 * heard (the size of chance's spread), as well as by SPEECH_MIN_MARGIN of them.
 */
function clearSpeech(fit: SpeechFit | undefined, windows: number): fit is SpeechFit {
  return fit !== undefined && fit.anchors.length >= windows && fit.score >= SPEECH_MIN_SCORE && fit.margin >= Math.max(SPEECH_MIN_MARGIN, SPEECH_CHANCE / Math.sqrt(fit.heard));
}

/**
 * See clearSpeech. Over 12,000 made-up plays of another episode's or show's subtitle on a file with
 * no subtitle track whose voices were half to a fifth heard (5 and 10 windows), SPEECH_MIN_MARGIN
 * alone let 25 through; the two that came closest to this stood out by 1.09 and 1.13 times the
 * square root. Every timing by speech of the stored plays stands out by at least 1.24 (a subtitle
 * timed by 32 voices, margin 0.22). In between: it lets none of those 12,000 through, and costs 119 of
 * 5,931 timings (2%) of the episode's own subtitle on the same files, none where all voices are heard.
 */
const SPEECH_CHANCE = 1.2;

/**
 * Where the timing steps once, by speech: the windows (in order) cut in two, each side fitted on its
 * own (fitCurves) and clear (clearSpeech, with at least `windows` windows on its shift), the two
 * shifts more than SPEECH_STEP_MIN_MS apart. Of the cuts that do, the one meeting the most speech.
 * A subtitle that needs one shift has no such cut: each side's own best is that shift. Another
 * episode's subtitle would need two clear fits by chance, each over fewer windows than the whole.
 */
function speechStep(curves: Array<{ w: { from: number; to: number }; curve: { matched: number[]; heard: number } }>, windows: number): { before: SpeechFit; after: SpeechFit } | undefined {
  let best: { before: SpeechFit; after: SpeechFit; met: number } | undefined;
  for (let k = windows; k <= curves.length - windows; k++) {
    const before = fitCurves(curves.slice(0, k));
    const after = fitCurves(curves.slice(k));
    if (!clearSpeech(before, windows) || !clearSpeech(after, windows) || Math.abs(before.offset - after.offset) <= SPEECH_STEP_MIN_MS) continue;
    const met = before.score * before.heard + after.score * after.heard;
    if (!best || met > best.met) best = { before, after, met };
  }
  return best && { before: best.before, after: best.after };
}

/** Windows a stretch of speech needs of its own to be timed apart from the rest of the file (see bySpeech). */
const SPEECH_STRETCH_WINDOWS = 3;
/** Windows enough to show that the timing steps, though not to place the step (see bySpeech). */
const SPEECH_STEP_SEEN_WINDOWS = 2;
/** How far apart two stretches' shifts must be to count as a step: the drift a window may take (SPEECH_DRIFT_MS) is not one. */
const SPEECH_STEP_MIN_MS = 1000;

/**
 * Timing line by line (align.ts): for a subtitle that is the file's own dialogue but fits no shift
 * per stretch. Only on a file timed from its index, where every line of a text track is known. The
 * tracks are tried in order; the first one the captions surely share their dialogue with times them.
 * The anchors returned sum it up per window (the median shift of the lines landing there), for the
 * log and the dashboard: the timing itself is `shifts`, one per caption start.
 */
export function byLines(stored: FileAnchors, captions: Cue[], lang?: string): { shifts: Map<number, number>; anchors: Anchor[]; track: "first" | number; paired: number } | undefined {
  if (stored.source !== "index" || stored.image || stored.speechOnly) return undefined;
  for (const track of tracksToTry(stored, lang)) {
    const view = track === "first" ? stored : trackView(stored, track);
    const windows = view.windows.filter((w) => !w.bridge && !w.heard);
    const timed = timingByLines(captions, windows.flatMap((w) => w.cues));
    if (!timed) continue;
    const landed = [...timed.shifts].map(([start, shift]) => ({ at: start + shift, shift })).sort((a, b) => a.at - b.at);
    const score = Math.round(timed.alignment.captionShare * 100) / 100;
    const anchors = windows.flatMap((w) => {
      const here = landed.filter((l) => l.at >= w.from && l.at < w.to).map((l) => l.shift).sort((a, b) => a - b);
      return here.length ? [{ from: w.from, to: w.to, offset: here[Math.floor(here.length / 2)], score }] : [];
    });
    if (anchors.length === 0) continue;
    return { shifts: timed.shifts, anchors, track, paired: timed.alignment.pairs.length };
  }
  return undefined;
}

/** A shift for any caption start: its own when known, else that of the nearest start that has one. */
function shiftLookup(shifts: Map<number, number>): (start: number) => number {
  const starts = [...shifts.keys()].sort((a, b) => a - b);
  return (start) => {
    const own = shifts.get(start);
    if (own !== undefined) return own;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    const after = starts[lo];
    const before = starts[lo - 1];
    const nearest = before !== undefined && (after === undefined || start - before <= after - start) ? before : after;
    return nearest === undefined ? 0 : shifts.get(nearest) ?? 0;
  };
}

const SPEECH_MIN_ANCHORS = 3;
/** Over the recorded files: own lines scored 0.38 to 0.69, margins 0.14 to 0.42; another file's lines at most 0.40 and 0.13. */
const SPEECH_MIN_SCORE = 0.35;
const SPEECH_MIN_MARGIN = 0.15;
/**
 * How long before the voice it meets a translation timed by speech is placed. Lines lead the voice
 * Silero hears by an amount that depends on who timed them, so this is a compromise. Measured as the
 * shift at which speech best meets the lines where they belong: a file's own subtitle track 0.04 to
 * 0.26 s (median 0.07, 6 files), uploads to files with no subtitle track, as they came (taken to be
 * made for that release) 0.08 to 0.31 s (median about 0.23, 6 files). Over both, every lead from 0.14
 * to 0.2 s lands lines about as close (mean 83 to 86 ms off), so it stays at 0.2 s.
 */
export const SPEECH_LEAD_MS = 200;

/**
 * Speech that puts a subtitle within SPEECH_KEEP_MS of where it already is (the windows' median), with
 * no window further than SPEECH_KEEP_SPREAD_MS, leaves it as it came: speech starts are heard a frame
 * or two either side of where a line belongs, so a shift that small is the hearing's own scatter.
 */
const SPEECH_KEEP_MS = 100;
const SPEECH_KEEP_SPREAD_MS = 200;
/**
 * Speech timing for captions made for another frame rate (RATE_FACTORS), tried only when speech doesn't
 * time them as written: the rescaled captions must land at one shift (within AGREE_MS) in at least
 * SPEECH_SURE_WINDOWS windows reaching across RATE_MIN_REACH of the file, as a rescaled fit to a
 * subtitle track must. The rate with the most such windows, then the best score.
 */
export function bySpeechRescaled(found: FileAnchors, captions: Cue[], lead: number): (NonNullable<ReturnType<typeof bySpeech>> & { factor: number; captions: Cue[] }) | undefined {
  if (!found.duration) return undefined;
  let best: (NonNullable<ReturnType<typeof bySpeech>> & { factor: number; captions: Cue[] }) | undefined;
  for (const factor of RATE_FACTORS) {
    const scaled = scaleCues(captions, factor);
    const speech = bySpeech(found, scaled, lead);
    if (!speech || speech.anchors.length < SPEECH_SURE_WINDOWS || spread(speech.anchors) > AGREE_MS) continue;
    const sorted = [...speech.anchors].sort((a, b) => a.from - b.from);
    if (sorted[sorted.length - 1].to - sorted[0].from < found.duration * RATE_MIN_REACH) continue;
    if (!best || speech.anchors.length > best.anchors.length || (speech.anchors.length === best.anchors.length && speech.score > best.score)) best = { ...speech, factor, captions: scaled };
  }
  return best;
}

export function withinHearing(anchors: Anchor[]): boolean {
  if (anchors.length === 0) return false;
  const offsets = anchors.map((a) => a.offset).sort((a, b) => a - b);
  return Math.abs(offsets[offsets.length >> 1]) < SPEECH_KEEP_MS && offsets.every((o) => Math.abs(o) <= SPEECH_KEEP_SPREAD_MS);
}
/**
 * How long before the voice it meets a dub caption is placed: moved onto the voices (refineBySpeech)
 * or timed by speech alone. Dub caption uploads, where the voices put them, lead their voices by
 * about 0.12 to 0.23 s (4 uploads); English subtitle tracks lead English voices by 0.04 to 0.12 s
 * (3 files). The median over both is 0.12 s, 38 ms from each on average, against 82 ms at 0.2 s.
 */
export const VOICE_LEAD_MS = 120;

/**
 * How far ahead of the voices Silero hears a streaming service's own dub captions sit: further than
 * uploads. A dub release's own captions track (Anime Tosho's, see animetosho.ts) played on that very
 * file is right as it is, while the voice fit at VOICE_LEAD_MS would move it about 200 ms later: the
 * service starts a line about 0.32 s before the voice is heard, so those captions are moved to sit
 * this far ahead instead.
 *
 * Provisional: measured on a small sample. On the release they came from, the captions fit its own
 * track exactly and aren't moved at all (fitsOwnTrack); this only places them on other releases.
 */
export const OFFICIAL_CAPTIONS_LEAD_MS = 320;

/** The lead a dub caption file is placed at ahead of its voices: a service's own captions (Anime Tosho's "at" files) sit further ahead. */
export function voiceLeadFor(file: string): number {
  return /^at[0-9a-f]{8,13}-/.test(path.basename(file)) ? OFFICIAL_CAPTIONS_LEAD_MS : VOICE_LEAD_MS;
}

/**
 * Whether captions fit the file's own subtitle track almost exactly: nearly every window measured
 * (OWN_TRACK_SHARE) at one shift (within OWN_TRACK_SPREAD_MS of the windows' median) with near
 * perfect overlap (OWN_TRACK_SCORE). That is the track itself, as a release's own captions played on
 * that release are. Then the track's timing is the file's own, and it stands: dub captions aren't
 * moved onto the voices, by any lead. Uploads that follow a track score about as high but spread over hundreds of ms from window to window, so they
 * are moved onto the voices.
 */
export function fitsOwnTrack(windows: Array<{ measured: Pick<Measured, "offset" | "score"> }>): boolean {
  if (windows.length < OWN_TRACK_MIN_WINDOWS) return false;
  const offsets = windows.map((w) => w.measured.offset).sort((a, b) => a - b);
  const middle = offsets[offsets.length >> 1];
  const on = windows.filter((w) => Math.abs(w.measured.offset - middle) <= OWN_TRACK_SPREAD_MS && w.measured.score >= OWN_TRACK_SCORE).length;
  return on >= OWN_TRACK_SHARE * windows.length;
}

/** Windows enough to tell a track's own captions (fitsOwnTrack): the five of a first reading. */
const OWN_TRACK_MIN_WINDOWS = 5;
/** How far from one shift a window of the track's own captions may read (a window is read in 5 ms steps). */
const OWN_TRACK_SPREAD_MS = 50;
/** Overlap a window of the track's own captions reaches: the same lines, so all of the track's speech. */
const OWN_TRACK_SCORE = 0.95;
/** The share of windows that must say both: one may read a stretch of songs or signs differently. */
const OWN_TRACK_SHARE = 0.9;

/**
 * Dub captions (English that follows an English dub) timed closer by the dub's voices. The file's
 * subtitle track follows the original audio, and dub captions measured against it by overlap land a
 * beat off the English voices, typically 0.1 to 0.3 s early or late, though the uploads themselves are
 * right by the voices. So once the English audio
 * has been heard, the timing the track gave (`shift`) is taken as the coarse answer and refined:
 *
 * - The captions as the track times them are matched against where the voices start, in every heard
 *   window at once (speechCurve), over only ±REFINE_RANGE_MS. Unless that says clearly where the
 *   voices are (see voiceFit: at least SPEECH_MIN_ANCHORS windows agreeing, a share of voices met and
 *   a margin over any other move), the track's timing stands as it is.
 * - Each stretch of the track's timing (the lines between two of its steps) then moves by its own
 *   heard windows, when they agree with each other; a stretch moving far from the others needs two
 *   windows to say so. A stretch with no window of its own, or none that says clearly, moves as the
 *   whole file does. Steps stay where the track put them.
 * - Where the whole file's voices don't say one thing clearly, a stretch two of its own windows
 *   agree on still moves by them, and the rest stay where the track put them.
 *
 * A move puts each line `lead` before the voice it meets (VOICE_LEAD_MS; OFFICIAL_CAPTIONS_LEAD_MS for a service's own captions, see voiceLeadFor). This only ever refines captions the
 * track already found to be this file's, and by under a second: speech alone never decides that
 * captions belong. Returns the refined shift and the move of each stretch.
 */
export function refineBySpeech(
  found: FileAnchors,
  captions: Cue[],
  shift: (start: number) => number,
  lead = VOICE_LEAD_MS
): { shift: (start: number) => number; moves: Array<{ from: number; by: number; own: boolean }>; score: number; margin: number; windows: number } | undefined {
  if (found.speechBy !== "silero" || found.speechOnly || !voicesAreTheDub(found)) return undefined;
  const lines = [...captions].sort((a, b) => a.start - b.start).map((c) => ({ at: c.start, shift: shift(c.start), start: c.start + shift(c.start), end: c.end + shift(c.start) }));
  if (lines.length === 0) return undefined;
  // The track's stretches: lines in a row at one shift, from the first one's start (caption time).
  const stretches: Array<{ from: number }> = [];
  const stretchOf = lines.map((l, i) => {
    if (i === 0 || l.shift !== lines[i - 1].shift) stretches.push({ from: l.at });
    return stretches.length - 1;
  });
  const placed = [...lines].sort((a, b) => a.start - b.start);
  const windows = found.windows.flatMap((w) => {
    if (w.bridge || (w.speech?.length ?? 0) < 3) return [];
    const curve = speechCurve(w.speech!, placed, REFINE_RANGE_MS);
    if (!curve) return [];
    // The stretch most of the window's lines belong to.
    const counts = new Map<number, number>();
    lines.forEach((l, i) => {
      if (l.start >= w.from && l.start < w.to) counts.set(stretchOf[i], (counts.get(stretchOf[i]) ?? 0) + 1);
    });
    const stretch = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return stretch === undefined ? [] : [{ curve, stretch }];
  });
  const all = voiceFit(windows, lead);
  const fileSays = all !== undefined && all.agree >= SPEECH_MIN_ANCHORS && all.score >= SPEECH_MIN_SCORE && all.margin >= SPEECH_MIN_MARGIN;
  const fits = stretches.map((_, k) => {
    const own = windows.filter((w) => w.stretch === k);
    const fit = own.length ? voiceFit(own, lead) : undefined;
    return { own: own.length, fit, agreed: fit !== undefined && fit.agree === own.length && fit.margin >= SPEECH_MIN_MARGIN };
  });
  // The voices of the whole file don't say one thing clearly (stretches that sit differently on
  // their voices pull apart): each stretch two of its own windows vouch for still moves by them, and
  // the others stay where the track put them.
  if (!fileSays) {
    // Only where enough of the file was heard and its timing steps: too few windows say nothing.
    if (windows.length < SPEECH_MIN_ANCHORS || stretches.length < 2) return undefined;
    const sure = fits.map((f) => f.agreed && f.own >= 2 && f.fit!.score >= SPEECH_MIN_SCORE);
    if (!sure.some(Boolean)) return undefined;
    const moves = stretches.map(({ from }, k) => ({ from, by: sure[k] ? fits[k].fit!.by : 0, own: sure[k] }));
    const moveAt = (start: number) => {
      let k = 0;
      while (k + 1 < moves.length && moves[k + 1].from <= start) k++;
      return moves[k].by;
    };
    const vouching = fits.filter((_, k) => sure[k]);
    return { shift: (start) => shift(start) + moveAt(start), moves, score: Math.min(...vouching.map((f) => f.fit!.score)), margin: Math.min(...vouching.map((f) => f.fit!.margin)), windows: vouching.reduce((n, f) => n + f.own, 0) };
  }
  const moves = stretches.map(({ from }, k) => {
    const { own, fit, agreed } = fits[k];
    const clear = agreed && (own >= 2 || Math.abs(fit!.peak - all.peak) <= REFINE_AGREE_MS);
    return { from, by: clear ? fit!.by : all.by, own: clear };
  });
  const moveAt = (start: number) => {
    let k = 0;
    while (k + 1 < moves.length && moves[k + 1].from <= start) k++;
    return moves[k].by;
  };
  return { shift: (start) => shift(start) + moveAt(start), moves, score: all.score, margin: all.margin, windows: all.agree };
}

/**
 * Where the voices of these heard windows meet the placed line starts best, over ±REFINE_RANGE_MS
 * (their speechCurves added up). peak: that move, the middle of the curve's top (a voice meets a line
 * start anywhere within ONSET_TOLERANCE_MS either way, so the top is a plateau and its middle is where
 * most voices sit); score: the share of voices met there; margin: how far it stands above any move
 * REFINE_RIVAL_MS away; agree: how many windows on their own meet at least REFINE_WINDOW_SCORE of
 * their voices within REFINE_AGREE_MS of it. by: the move that puts the lines VOICE_LEAD_MS ahead
 * of their voices.
 */
function voiceFit(windows: Array<{ curve: { matched: number[]; heard: number } }>, lead = VOICE_LEAD_MS): { peak: number; by: number; score: number; margin: number; agree: number } | undefined {
  if (windows.length === 0) return undefined;
  const heard = windows.reduce((sum, w) => sum + w.curve.heard, 0);
  const total = windows[0].curve.matched.map((_, i) => windows.reduce((sum, w) => sum + w.curve.matched[i], 0) / heard);
  const best = curvePeaks(total, REFINE_RANGE_MS)[0];
  if (!best) return undefined;
  const at = (i: number) => -REFINE_RANGE_MS + i * SPEECH_STEP_MS;
  const rival = Math.max(0, ...total.filter((_, i) => Math.abs(at(i) - best.offset) > REFINE_RIVAL_MS));
  const agree = windows.filter(({ curve }) => Math.max(0, ...curve.matched.filter((_, i) => Math.abs(at(i) - best.offset) <= REFINE_AGREE_MS)) / curve.heard >= REFINE_WINDOW_SCORE).length;
  return { peak: best.offset, by: best.offset - lead, score: Math.round(best.score * 100) / 100, margin: Math.round((best.score - rival) * 100) / 100, agree };
}

/**
 * Whether the voices heard are the dub's: the audio heard is English (pickAudio takes English first),
 * or its language isn't tagged. Another language's voices (a file with no English audio) follow the
 * original, as the track does.
 */
export function voicesAreTheDub(found: Pick<FileAnchors, "audioLang">): boolean {
  return !found.audioLang || /^(en|eng|und)$/i.test(found.audioLang);
}

/** How far the track's timing of dub captions may be moved by their voices, either way. */
const REFINE_RANGE_MS = 1000;
/** A move this far from the best one is a rival: past the voices that meet the best one. */
const REFINE_RIVAL_MS = 400;
/** How near the best move a window's own best must be. */
const REFINE_AGREE_MS = 200;
/** The share of the window's voices that window's best must meet. */
const REFINE_WINDOW_SCORE = 0.45;

// ---------- syncing one caption file ----------

export interface SyncResult {
  file: string;
  anchors: Anchor[];
  /** The captions don't belong to this file (best fits scattered, e.g. another episode's). */
  noFit?: boolean;
  /** Its lines run far past the file's end: another title's (outrunsFile). */
  outruns?: boolean;
  /** The playing file and the cached subtitle synced to it, kept for the replay check (scripts/replay.ts). */
  filename?: string;
  source?: string;
  /** Timed by speech heard in the audio, the last resort (see bySpeech): alternates timed by the
   * file's own subtitles are preferred over it, unless that track is off the voices (overTrack). */
  bySpeech?: boolean;
  /** The file has no subtitle track, so speech was all there was: no alternate can do better. */
  speechOnly?: boolean;
  /** Timed line by line to the file's own lines (see byLines), not by a shift per stretch. */
  byLines?: boolean;
  /** A shift per stretch found by where lines start, not by how they overlap (see byStarts). */
  byStarts?: boolean;
  /** The captions were made for another frame rate: their times were multiplied by this (RATE_FACTORS). */
  factor?: number;
  /** Dub captions: ms the track's timing was moved by to meet the English voices (see refineBySpeech), the median over its stretches. */
  voiceShift?: number;
  /** What the timing was measured against: the subtitle track's language as tagged ("und" when it isn't), or "speech". */
  reference?: string;
  /** Lines moved onto the file's own line starts after the shift (see lineNudges). */
  snapped?: number;
  /** Lines moved onto their own line by the pairing by rhythm (see linesOverShift). */
  moved?: number;
  /**
   * Dub captions timed by the track alone while the file's English audio is still to be heard (see
   * hearDubVoices): synced again once it has been, and not to be kept by a player meanwhile.
   */
  voicesPending?: boolean;
  /**
   * A file with no subtitle track whose speech didn't time these captions clearly, timed (or left)
   * by its first five windows while more of its audio is heard (see hearMoreSpeech): synced again
   * once it has been, and not to be kept by a player meanwhile.
   */
  speechPending?: boolean;
  /**
   * A translation the track moved while the file's audio is heard to check that track against its
   * voices (hearVoiceSpots): synced again once it has been, and not to be kept by a player meanwhile.
   */
  trackCheckPending?: boolean;
  /** Served as it came: the voices heard are met by its own timing and not by the track's (trackcheck.ts). */
  asCame?: boolean;
  /**
   * Timed by speech on a file whose own track the same voices show to be off them (trackOffVoices):
   * no alternate that fits the track is preferred over it.
   */
  overTrack?: boolean;
  /**
   * With speechPending, once MORE_SPOTS are heard: where the audio is heard next, for a step speech
   * hints at and can't place (stepSpots). Kept with the result, so the read can be started again.
   */
  stepSpots?: number[];
}

const syncJobs = new Map<string, Promise<SyncResult | undefined>>();
/** First-pass timing of syncs still reading more of the file (see syncCaptions). */
const firstPass = new Map<string, SyncResult>();

/** Syncs whose captions fit nothing in the file's own subtitle track, and when (see trackMisfit). */
const misfits = new Map<string, number>();
const misfitWaiters = new Map<string, Set<() => void>>();

function noteTrackMisfit(key: string): void {
  forgetOld(misfits, (at) => at, JOB_KEPT_MS);
  misfits.set(key, Date.now());
  for (const wake of misfitWaiters.get(key) ?? []) wake();
  misfitWaiters.delete(key);
}

/**
 * True once the sync for `key` finds that its captions fit nothing in the playing file's own subtitle
 * track, so speech in the audio is all it has left; false when that isn't found within `withinMs`
 * (captions that fit the track, a file without one, or a sync still on its way). Timed only by speech,
 * captions lose to an alternate that fits the track (syncedWell), so the alternates are worth trying
 * from that moment, beside the speech read, rather than after it.
 */
export function trackMisfit(key: string, withinMs: number): Promise<boolean> {
  if (misfits.has(key)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      misfitWaiters.get(key)?.delete(wake);
      if (misfitWaiters.get(key)?.size === 0) misfitWaiters.delete(key);
      resolve(false);
    }, Math.max(0, withinMs));
    timer.unref?.();
    misfitWaiters.set(key, (misfitWaiters.get(key) ?? new Set()).add(wake));
  });
}

/** The timing from the first windows of a sync that is still refining, if it got that far. */
export function firstPassSync(key: string): SyncResult | undefined {
  return firstPass.get(key);
}

/** Bumped when the sync method changes: older results are ignored and download URLs change, so no cache keeps old timing. */
export const SYNC_VERSION = 37;

/**
 * Whether captions belong to the file at all: at least half of the measured
 * windows must have a best fit within AGREE_MS of another window's. A timing
 * step mid-episode still passes (windows on each side agree with each other).
 */
/** Whether at least half the measured windows' own best fits lie within AGREE_MS of the final timing there. */
/**
 * How far past the playing file's end a subtitle's lines may run and still be the file's: lines that
 * run further belong to something longer (a special, another cut, two episodes in one file) and are
 * not timed to it, unless the ones inside the file's length are the file's by its own track (the
 * first of two episodes in one subtitle). Calibration (11-15): a two-part special's subtitles ran to 54.8 min against a
 * 24.0 min episode, whose own subtitles ran to 22.4-24.0 min.
 */
const OUTRUN_FACTOR = 1.5;

/** When the last of these lines ends. */
export function lastLineEnd(captions: Cue[]): number {
  return captions.reduce((last, c) => Math.max(last, c.end), 0);
}

/**
 * Whether lines that run far past this file hold it at their start: the ones inside the file's length
 * are the file's by its own subtitle track (an episode and the next in one subtitle). From the file's
 * readings as they are kept: nothing is looked up or read for it.
 */
export async function holdsFileAtStart(filename: string, captions: Cue[]): Promise<boolean> {
  const stored = await storedAnchors(filename);
  if (!stored || stored.speechOnly || !outrunsFile(captions, stored.duration)) return false;
  return startIsTheFiles(stored, captions.filter((c) => c.start < stored.duration));
}

/**
 * Whether these lines, the part of a longer subtitle inside the file's length, are the file's: they
 * fit its own track, and at one shift. A subtitle that holds this episode and the next was made for
 * this cut, so its timing doesn't step; a long subtitle of another title, thick with lines, can fit
 * stretch by stretch at shifts seconds apart, and that is chance.
 *
 * Calibration: an episode's own subtitle held in a two-episode one fit at 9 points, all 0 ms; a film's
 * 144-minute subtitle against a 24-minute episode fit at 13 points whose shifts ran from -4.9 to 18.2 s.
 */
function startIsTheFiles(stored: FileAnchors, inside: Cue[]): boolean {
  if (inside.length === 0) return false;
  const judged = judge(stored, inside);
  if (judged.verdict !== "synced" || judged.anchors.length === 0) return false;
  const shifts = judged.anchors.map((a) => a.offset);
  return Math.max(...shifts) - Math.min(...shifts) <= AGREE_MS;
}

/** Whether these lines run far past the end of a file this long (OUTRUN_FACTOR). */
export function outrunsFile(captions: Cue[], durationMs: number | undefined): boolean {
  return Boolean(durationMs) && captions.length > 0 && lastLineEnd(captions) > (durationMs as number) * OUTRUN_FACTOR;
}

/**
 * How far into the playing file a subtitle's lines must reach to stand in for it while its sync is
 * under way: lines that end sooner belong to something shorter (another title, a part of one).
 * Calibration (2026-11-19 UTC): over 870 stored syncs, synced subtitles' lines reached 0.91 to 1.00 of the
 * file and refused ones 0.88 and more, but for two that reached 0.13; a film's subtitles played on a
 * file twice its length reach about 0.5.
 */
const SHORT_FACTOR = 0.7;

/** Whether these lines end far short of a file this long (SHORT_FACTOR). */
export function fallsShortOfFile(captions: Cue[], durationMs: number | undefined): boolean {
  return Boolean(durationMs) && captions.length > 0 && lastLineEnd(captions) < (durationMs as number) * SHORT_FACTOR;
}

export function landsOnTiming(windows: Array<{ from: number; measured: Measured }>, anchors: Anchor[]): boolean {
  if (windows.length < 3 || anchors.length === 0) return true;
  const timingAt = (from: number) => anchors.reduce((a, b) => (Math.abs(b.from - from) < Math.abs(a.from - from) ? b : a)).offset;
  const direct = windows.filter((w) => Math.abs(w.measured.offset - timingAt(w.from)) <= LAND_MS).length;
  return direct * 2 >= windows.length;
}

/**
 * How close a window's own best fit must be to the final timing to count as landing on it. Wider
 * than AGREE_MS, for timing that drifts a little; a coincidental fit sits seconds away.
 */
const LAND_MS = 1000;

export function fitsFile(windows: Array<{ measured: Measured }>): boolean {
  if (windows.length < 3) return true;
  const supported = windows.filter((w, i) => windows.some((o, j) => j !== i && Math.abs(o.measured.offset - w.measured.offset) <= AGREE_MS)).length;
  if (supported * 2 >= windows.length) return true;
  // Timing that drifts a little across the file spreads past AGREE_MS. Three windows within BAND_MS
  // of each other still fit:
  // another episode's captions scatter over the whole ±20 s. landsOnTiming checks again afterwards.
  const sorted = windows.map((w) => w.measured.offset).sort((a, b) => a - b);
  return sorted.some((offset, i) => i + 2 < sorted.length && sorted[i + 2] - offset <= BAND_MS);
}

/** How far apart three windows' readings may be and still count as one timing that drifts. */
const BAND_MS = 1500;

/**
 * How the captions, as timed by `shift`, sit on the file as a whole (see accountsForFile):
 * - inside: the share of their lines that start within the file, from 0 to its end;
 * - windows: the file's windows with dialogue (an index minute with INDEX_MIN_WINDOW_LINES lines or
 *   more, a window read or heard with 3 or more), and covered: how many of them hold a caption start;
 * - anchored, given the anchors: how many of those windows carry an anchor of the timing.
 */
export function wholeFile(found: FileAnchors, captions: Cue[], shift: (start: number) => number, anchors?: Anchor[]): { inside: number; windows: number; covered: number; anchored?: number } {
  const starts = captions.map((c) => c.start + shift(c.start)).sort((a, b) => a - b);
  const inside = starts.length && found.duration ? starts.filter((t) => t >= 0 && t <= found.duration).length / starts.length : 1;
  const fewest = found.source === "index" ? INDEX_MIN_WINDOW_LINES : 3;
  const windows = found.windows.filter((w) => !w.bridge && !w.heard && w.cues.length >= fewest);
  const holdsStart = (w: { from: number; to: number }) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < w.from) lo = mid + 1;
      else hi = mid;
    }
    return lo < starts.length && starts[lo] < w.to;
  };
  const anchoredAt = new Set(anchors?.map((a) => a.from));
  return {
    inside: Math.round(inside * 100) / 100,
    windows: windows.length,
    covered: windows.filter(holdsStart).length,
    ...(anchors ? { anchored: windows.filter((w) => anchoredAt.has(w.from)).length } : {})
  };
}

/**
 * Why the captions, as timed, can't be this file's, or undefined when nothing says so. The trust
 * checks above (fitsFile, landsOnTiming, holdsTogether) judge the windows that were measured, and a
 * window is measured only where the captions have lines near the file's own; with fewer than 3 they
 * judge nothing at all. So a subtitle that meets only a stretch of the file can pass them on the few
 * windows it meets, at chance shifts. Checked against every stored play with every cached subtitle
 * known to belong elsewhere (npm run negatives, docs/scoring.md), the ones that pass that way are all
 * timed by a shift per stretch: a film's subtitle on an episode, a long episode's on a short one, or
 * a subtitle covering only part of the file. A subtitle of the file is all of it:
 * - nearly all its lines start within the file (WHOLE_MIN_INSIDE). The file's own, on the stored
 *   plays: 0.99 at least; a film's on an episode: 0.17 to 0.69;
 * - it has lines in nearly every window of the file with dialogue (WHOLE_MIN_COVERED). Own: 0.96 at
 *   least (a minute the subtitle leaves out); the short ones: 0.02 to 0.67, one 0.95;
 * - given `anchors` (a timing by fits per window of the track: a shift per stretch, another frame
 *   rate), its timing rests on most of those windows, and on WHOLE_MIN_ANCHORS at least
 *   (WHOLE_MIN_ANCHORED). Own: 0.79 at least; the one that passed the two above: 0.38.
 * Timing by line starts and far off have landing tests of their own over every window (byStarts,
 * farTiming), and timing line by line and by speech rest on no window fits, so they get the first two.
 */
export function accountsForFile(found: FileAnchors, captions: Cue[], shift: (start: number) => number, anchors?: Anchor[]): string | undefined {
  const w = wholeFile(found, captions, shift, anchors);
  if (w.inside < WHOLE_MIN_INSIDE) return `only ${Math.round(w.inside * 100)}% of its lines start within the file`;
  if (w.windows > 0 && w.covered < WHOLE_MIN_COVERED * w.windows) return `it has lines in only ${w.covered} of the file's ${w.windows} windows with dialogue`;
  if (w.anchored !== undefined && w.windows > 0 && (w.anchored < WHOLE_MIN_ANCHORED * w.windows || w.anchored < WHOLE_MIN_ANCHORS)) return `its timing rests on only ${w.anchored} of the file's ${w.windows} windows with dialogue`;
  return undefined;
}

/** The share of a subtitle's lines that must start within the file. */
const WHOLE_MIN_INSIDE = 0.9;
/** The share of the file's windows with dialogue that must hold one of its lines. */
const WHOLE_MIN_COVERED = 0.75;
/** For a timing by fits per window, the share of those windows that must carry it, and how many. */
const WHOLE_MIN_ANCHORED = 0.6;
const WHOLE_MIN_ANCHORS = 3;

export function syncKey(ref: string | number, season: number | undefined, episode: number | undefined, filename: string, pick?: number): string {
  // The ref as every caller passes it ("ss123", "osar-456"): the key must not change, or every synced
  // result is made again. A pack's file found by the subtitle's own count (pick, see downloads.ts) can
  // be another file than the one found by the episode, so it has a key of its own.
  return cacheKey({ kind: "synced", subtitleId: ref, season, episode, filename, version: SYNC_VERSION, ...(pick !== undefined ? { pick } : {}) });
}

/**
 * What's already known about syncing this subtitle to this file, read from
 * earlier results only (nothing is fetched): "unsynced" when the file has no
 * embedded subtitles to sync to, or this subtitle matched none of them. "voices": timed by speech on a
 * file whose own track the voices show to be off them (overTrack), where speech is the timing to keep.
 */
export async function knownSync(key: string, filename: string): Promise<"synced" | "speech" | "voices" | "unsynced" | "wrong" | "unknown"> {
  try {
    const done = JSON.parse(await readFile(path.join(cachePath("synced"), `${key}.json`), "utf8")) as SyncResult;
    // Timed (or left) by a file's first five windows of speech while more was heard: once it has
    // been, this is to be synced again, so it isn't known yet. Asked before noFit: five windows can
    // find a subtitle not to be the file's (accountsForFile), and ten are judged again.
    if (done.speechPending) {
      const now = await storedAnchors(filename);
      if (now && !speechStillToHear(done, now) && (now.rounds ?? 0) > 0) return "unknown";
    }
    if (done.noFit) return "wrong";
    if (done.bySpeech && done.anchors.length > 0) return done.overTrack ? "voices" : "speech";
    return done.anchors.length > 0 ? "synced" : "unsynced";
  } catch {}
  try {
    const found = JSON.parse(await readFile(anchorsFile(filename), "utf8")) as FileAnchors;
    if (found.windows.length === 0 && stillValid(found)) return "unsynced";
  } catch {}
  return "unknown";
}

/** Whether the audio a sync waits on (speechPending) is still to be heard: MORE_SPOTS, or the spots its step calls for. */
function speechStillToHear(done: SyncResult, now: FileAnchors): boolean {
  return moreSpeechToHear(now) || (Boolean(done.stepSpots?.length) && stepSpeechToHear(now));
}

/**
 * Captions retimed to the playing file, or undefined when it can't be done
 * (no embedded text subtitles, no anchor agreed). Started when the list is
 * asked for; the download waits on the same job.
 */
export function syncCaptions(
  key: string,
  caption: () => Promise<{ file: string }>,
  /** The AIOStreams of whoever is playing: their search, their debrid, never someone else's. */
  aiostreamsUrl: string,
  videoId: string,
  type: string,
  filename: string,
  lang?: string,
  /** `forRelease`: the subtitle's names say it was made for the playing release (see trackcheck.ts). */
  opts: { forRelease?: boolean } = {}
): Promise<SyncResult | undefined> {
  const running = syncJobs.get(key);
  if (running) {
    // A finished sync whose file was deleted since (the daily clean-up, see cleanup.ts) is made again.
    return running.then((done) => {
      if (!done || existsSync(done.file)) return done;
      if (syncJobs.get(key) === running) syncJobs.delete(key);
      return syncCaptions(key, caption, aiostreamsUrl, videoId, type, filename, lang, opts);
    });
  }
  const job = (async () => {
    const meta = path.join(cachePath("synced"), `${key}.json`);
    try {
      const done = JSON.parse(await readFile(meta, "utf8")) as SyncResult;
      if (existsSync(done.file)) {
        if (!done.voicesPending && !done.speechPending && !done.trackCheckPending) return done;
        // The file's track is being checked against its voices: served as timed while that is heard,
        // and synced again below once it has been (or couldn't be).
        if (done.trackCheckPending && voiceSpotJobs.has(filename)) return done;
        const now = await storedAnchors(filename);
        // Timed by the track while the English audio was still to be heard: synced again once it has
        // been, else served as it is (and the audio asked for again, if no read is under way).
        if (done.voicesPending && (!now || voicesToHear(now))) {
          if (now) hearDubVoices(now, aiostreamsUrl, videoId, type, filename, done.anchors);
          return done;
        }
        // Timed (or left) by the first five windows of a file with no subtitle track while more of its
        // audio is heard: the same.
        if (done.speechPending && (!now || speechStillToHear(done, now))) {
          if (now) hearMoreSpeech(now, aiostreamsUrl, videoId, type, filename, done.stepSpots);
          return done;
        }
      }
    } catch {}

    const source = await caption();
    const ext = path.extname(source.file).toLowerCase();
    const text = decodeSubtitle(await readFile(source.file), lang);
    let captions = captionCues(text, ext);
    // stored: the file's readings as kept on disk; found: the track these captions are timed by.
    let stored = await fileAnchors(aiostreamsUrl, videoId, type, filename);
    if (!stored) return undefined; // lookup failed: try again next time
    // Lines running far past the file's end are another title's (outrunsFile): left as they are, with
    // nothing heard for them, so a fallback gets its turn at once. Unless they hold this file and more
    // after it (an episode and the next in one subtitle): then the lines inside the file's length are
    // the file's by its own track, and those are what is timed.
    const inside = outrunsFile(captions, stored.duration) && !stored.speechOnly ? captions.filter((c) => c.start < (stored as FileAnchors).duration) : [];
    if (startIsTheFiles(stored, inside)) {
      count("sync.outrunsPart");
      console.log(`sync: ${filename}: its lines run to ${Math.round(lastLineEnd(captions) / 60000)} min, past the file's ${Math.round(stored.duration / 60000)} min, but the ${inside.length} inside the file's length are the file's: timed by those`);
      captions = inside;
    }
    if (outrunsFile(captions, stored.duration)) {
      console.log(`sync: ${filename}: its lines run to ${Math.round(lastLineEnd(captions) / 60000)} min, past the file's ${Math.round(stored.duration / 60000)} min: another title's, not counted`);
      count("sync.outruns");
      count("sync.unsynced");
      if (!stored.speechOnly) noteTrackMisfit(key);
      const result: SyncResult = { file: source.file, anchors: [], noFit: true, outruns: true, filename, source: path.basename(source.file) };
      await mkdir(cachePath("synced"), { recursive: true });
      if (!standInFor(filename)) await writeWhole(meta, JSON.stringify(result));
      return result;
    }
    const pick: TrackPick = stored.speechOnly ? { track: "first" } : await finishBetweenRequests(trackChoiceSteps(stored, captions, lang));
    const track = pick.track;
    const viewOf = (s: FileAnchors) => (track === undefined ? noLines(s) : track === "first" ? s : trackView(s, track));
    let found = viewOf(stored);
    if (track === undefined) console.log(`sync: ${filename}: every subtitle track has under half as many lines as the captions, timing by speech only`);
    else if (track !== "first" && track === tracksToTry(stored, lang)[0]) {
      count("sync.ownLanguageTrack");
      console.log(`sync: ${filename}: timing by its own ${stored.trackLangs?.[String(track)]} track ${track}`);
    } else if (track !== "first") {
      count("sync.otherTrack");
      console.log(`sync: ${filename}: the first subtitle track doesn't fit, timing by track ${track}`);
    }

    let { measuredWindows, anchors } = found.speechOnly ? { measuredWindows: [] as ReturnType<typeof measureAll>["measuredWindows"], anchors: [] as Anchor[] } : (pick.asWritten ?? measureAll(found, captions));
    // Made for another frame rate: from here on the captions are rescaled to the file's.
    let factor = 1;
    const rated = found.speechOnly ? undefined : "rated" in pick ? pick.rated : await finishBetweenRequests(rescaledSteps(found, captions, { measuredWindows, anchors }));
    if (rated) {
      ({ factor, captions, measuredWindows, anchors } = rated);
      count("sync.rescaled");
      console.log(`sync: ${filename}: made for another frame rate, times x${factor.toFixed(4)}`);
    }
    if (found.speechOnly) found = { ...found, rounds: MAX_ROUNDS };
    // A step in dub captions' timing must earn its place by the file's line starts (dubStepsEarned).
    const earnSteps = (from: Anchor[]) => (!lang && !found.speechOnly && from.length ? dubStepsEarned(from, captions, found.windows.flatMap((w) => w.cues)) : from);
    anchors = earnSteps(anchors);
    // Dub captions (no language) timed by the track: moved onto the dub's voices where the English
    // audio has been heard and says so clearly (see refineBySpeech). Translations are left as timed,
    // and so are dub captions that are the file's own track (fitsOwnTrack): its timing is the file's.
    const ownTrack = () => !lang && fitsOwnTrack(measuredWindows);
    const byVoices = (plan: (start: number) => number): { shift: (start: number) => number; by?: ReturnType<typeof refineBySpeech> } => {
      const by = lang || ownTrack() ? undefined : refineBySpeech(found, captions, plan, voiceLeadFor(source.file));
      return by ? { shift: by.shift, by } : { shift: plan };
    };
    // Captions for this file fit at the same shift in window after window. When most windows' best
    // fits agree with no other window, they don't belong to this file: they are left as they are, and no more of the file is read for them.
    let noFit = false;
    if (!found.speechOnly && !fitsFile(measuredWindows)) {
      console.log(`sync: ${filename}: best fits scattered (${measuredWindows.map((w) => w.measured.offset).join(", ")} ms), the captions don't match this file`);
      count("sync.noFit");
      noFit = true;
      measuredWindows = [];
      anchors = [];
      found = { ...found, rounds: MAX_ROUNDS };
    }
    // The timing from the first windows, ready for a download that can't wait for the extra
    // rounds below (they can take another 10 to 20 s). Kept in memory only. Only a timing those
    // windows already vouch for as the final one must (trusted, accountsForFile): a download takes
    // it in place of the finished sync, which may yet refuse the subtitle.
    const firstLines = found.windows.flatMap((w) => w.cues);
    if (anchors.length > 0 && (found.rounds ?? 0) < MAX_ROUNDS && trusted({ measuredWindows, anchors }) && !accountsForFile(found, captions, planShifts(anchors, captions, firstLines), anchors)) {
      const first = path.join(cachePath("synced"), `${key}.first${ext}`);
      await mkdir(cachePath("synced"), { recursive: true });
      // Translations by the file's line starts (see followShifts), dub captions by the track and then
      // their voices where the English audio has been heard (see refineBySpeech).
      const lines = firstLines;
      const followed = lang && !found.speechOnly ? timingByStarts(anchors, captions, lines, false, found) : undefined;
      await writeFile(first, laidOutForPlayers(retime(text, ext, followed ? followed.shift : byVoices(planShifts(anchors, captions, lines)).shift, factor), ext));
      firstPass.set(key, { file: first, anchors });
    }
    // Gaps or disagreement: read more of the file there, then measure again. Rounds are
    // kept with the file, so later captions for it start from what's already read.
    while ((found.rounds ?? 0) < MAX_ROUNDS) {
      const spans =
        (found.rounds ?? 0) === 0
          ? refinementStarts(found, anchors).map((from) => ({ from, length: EXTRA_WINDOW_MS }))
          : bridgeSpans(found, anchors).map((span) => ({ ...span, bridge: true }));
      if (spans.length === 0) break;
      // More of the file is read for every track and kept as stored; these captions go on with theirs.
      const extended = await extendAnchors(stored, spans, aiostreamsUrl, videoId, type, filename);
      if (!extended || extended === stored) break;
      stored = extended;
      found = viewOf(stored);
      ({ measuredWindows, anchors } = measureAll(found, captions));
    }
    anchors = earnSteps(anchors);
    const notes = measuredWindows.flatMap((w) => {
      const kept = anchors.find((a) => a.from === w.from);
      const at = `${Math.round(w.from / 1000)}s`;
      if (!kept) return [`${at} ${w.measured.offset}ms set aside`];
      return kept.offset !== w.measured.offset ? [`${at} ${w.measured.offset}ms read as ${kept.offset}ms`] : [];
    });
    const unmatched = found.windows.filter((w) => !measuredWindows.some((m) => m.from === w.from)).map((w) => `${Math.round(w.from / 1000)}s (${w.cues.length} lines)`);
    if (unmatched.length) notes.push(`no match at ${unmatched.join(", ")}`);
    if (notes.length) console.log(`sync: ${filename}: ${notes.join("; ")}`);
    await mkdir(cachePath("synced"), { recursive: true });
    // A real sync lands most windows on the final timing with their own best fit (5 of 5 to 9 of 10 in
    // practice). One built mostly from second-best fits is a coincidence: it is left unsynced, so a
    // fallback gets its turn.
    if (anchors.length > 0 && !landsOnTiming(measuredWindows, anchors)) {
      console.log(`sync: ${filename}: timing rests on second-best fits, not counted as synced`);
      count("sync.noFit");
      noFit = true;
      anchors = [];
    }
    // A shift that jumps about from window to window is chance fits, not cuts (see holdsTogether):
    // the captions are for another version of the file. Left unsynced, so a fallback gets its turn.
    if (anchors.length > 0 && !holdsTogether(anchors)) {
      console.log(`sync: ${filename}: the shift jumps ${shiftChanges(anchors)} times over ${anchors.length} windows, more than cuts explain: not counted as synced`);
      count("sync.noFit");
      noFit = true;
      anchors = [];
    }
    // Every timing found below must also account for the file as a whole (see accountsForFile): a
    // subtitle that meets only a stretch of it can pass every test of the windows it met. Refused,
    // the next way of timing gets its turn, under the same test.
    const notTheFile = (view: FileAnchors, shift: (start: number) => number, how: string, perWindow?: Anchor[]): boolean => {
      const why = accountsForFile(view, captions, shift, perWindow);
      if (!why) return false;
      console.log(`sync: ${filename}: ${how}, but ${why}: not counted as synced`);
      count("sync.noFit");
      noFit = true;
      return true;
    };
    if (anchors.length > 0 && notTheFile(found, planShifts(anchors, captions, found.windows.flatMap((w) => w.cues)), `a shift per stretch fits ${anchors.length} windows`, anchors)) anchors = [];
    // Dub captions the windows' own fits timed: the timing in stretches takes over when it meets
    // more of the file's line starts (see stretchesOver).
    if (anchors.length > 0 && !lang && factor === 1) {
      const over = stretchesOver(found, captions, anchors);
      if (over && !accountsForFile(found, captions, planShifts(over.anchors, captions))) {
        anchors = over.anchors;
        count("sync.stretches");
        console.log(`sync: ${filename}: timed in stretches by the line starts, which meet more of the file's than the windows' own fits`);
      }
    }
    // No shift fits, yet it may be the file's own dialogue timed line by line to another recording:
    // then each line takes its own line's start (see byLines). Other languages only, as with
    // snapping: dub captions follow the dub, whose lines aren't the file's.
    let lineTimed: Map<number, number> | undefined;
    let lineTrack: "first" | number | undefined;
    if (anchors.length === 0 && lang) {
      const lined = byLines(stored, captions, lang);
      if (lined && !notTheFile(lined.track === "first" ? stored : trackView(stored, lined.track), shiftLookup(lined.shifts), "its lines pair with the file's")) {
        lineTimed = lined.shifts;
        lineTrack = lined.track;
        anchors = lined.anchors;
        noFit = false;
        count("sync.byLines");
        console.log(`sync: ${filename}: no shift fits, but it is the file's dialogue line for line: ${lined.paired} of ${captions.length} lines timed by the file's own${lined.track === "first" ? "" : ` (track ${lined.track})`}`);
      }
    }
    // Nothing fits within ±20 s, yet the line starts meet the file's at one shift far beyond it (a
    // recap in one release only): every window measured again around that shift (see farTiming).
    if (anchors.length === 0 && !lineTimed && !found.speechOnly) {
      const far = farTiming(found, captions);
      if (far && !notTheFile(found, planShifts(far.anchors, captions), `the line starts meet the file's ${Math.round(far.centre / 100) / 10} s off`)) {
        anchors = far.anchors;
        noFit = false;
        count("sync.far");
        console.log(`sync: ${filename}: nothing fits within 20 s, but the line starts meet the file's ${Math.round(far.centre / 100) / 10} s off: measured again around that shift, ${far.landed} of ${far.windows} windows on it`);
      }
    }
    // No shift fits by how the lines overlap, yet they start where the file's lines start, with a
    // shift per stretch (see byStarts). Translations only, as with snapping.
    let startTimed = false;
    if (anchors.length === 0 && lang) {
      const started = byStarts(found, captions);
      if (started && !notTheFile(found, planShifts(started.anchors, captions, [], true), "the line starts fit a shift per stretch")) {
        anchors = started.anchors;
        startTimed = true;
        noFit = false;
        count("sync.byStarts");
        console.log(`sync: ${filename}: no shift fits by overlap, but the line starts do: ${started.landed} of ${started.windows} windows on the timing`);
      }
    }
    // Nothing fits the subtitle track: speech in the audio, as a last resort.
    if (anchors.length === 0 && !found.speechOnly) noteTrackMisfit(key);
    let reference = found.windows.flatMap((w) => w.cues);
    let heard = false;
    /** Windows whose speech could be measured, when timed by speech: each should land on the timing. */
    let speechWindows = 0;
    // A file timed from its index has no audio read yet: it's heard now, the last resort's turn.
    if (anchors.length === 0 && stored.source === "index" && stored.audio !== undefined && stored.speechBy !== "silero") {
      const withSpeech = await addSpeech(stored, aiostreamsUrl, videoId, type, filename);
      if (withSpeech) {
        stored = withSpeech;
        found = viewOf(stored);
      }
    }
    if (anchors.length === 0) {
      // Dub captions lead their voices by less than translations do, and by how much depends on who
      // timed them (voiceLeadFor), as when they are moved onto the voices.
      const lead = lang ? SPEECH_LEAD_MS : voiceLeadFor(source.file);
      let speech = bySpeech(found, captions, lead);
      // Speech must account for the whole file too (accountsForFile), one shift or a shift per
      // stretch alike, by the stepped plan when it steps. On a file with no subtitle track this
      // judges whatever has been heard: the five windows of the first pass or, once more of the
      // audio is heard (hearMoreSpeech), all ten. Refused on five, it is heard at the five more
      // spots like any subtitle speech didn't time (speechPending below), and judged again on ten.
      // Speech gets the first two tests only, as timing line by line does. A timing that steps is
      // placed by each side's own windows, as a shift per stretch is, but bySpeech already holds it
      // to at least SPEECH_STRETCH_WINDOWS a side: six of at most ten windows heard, the share a
      // shift per stretch must rest on (test/speech.test.ts checks this).
      let whole = speech && !notTheFile(found, planShifts(speech.anchors, captions, speech.reference), "speech in the audio times it");
      // Not as written: made for another frame rate, speech may time them rescaled (as rescaled does by a track).
      if (!(speech && whole) && factor === 1) {
        const rated = bySpeechRescaled(found, captions, lead);
        if (rated && !notTheFile(found, planShifts(rated.anchors, rated.captions, rated.reference), "speech in the audio times them rescaled")) {
          ({ factor, captions } = rated);
          speech = rated;
          whole = true;
          count("sync.rescaled");
          console.log(`sync: ${filename}: made for another frame rate, times x${factor.toFixed(4)} (by speech)`);
        }
      }
      if (speech && whole) {
        ({ anchors, reference } = speech);
        speechWindows = speech.windows;
        heard = true;
        noFit = false;
        count("sync.bySpeech");
        console.log(`sync: ${filename}: ${found.speechOnly ? "no subtitle track" : "no fit to the subtitle track"}; timed by speech in the audio (score ${speech.score}, margin ${speech.margin})`);
        if (withinHearing(anchors)) {
          anchors = anchors.map((a) => ({ ...a, offset: 0 }));
          count("sync.speechKept");
          console.log(`sync: ${filename}: speech puts these within ${SPEECH_KEEP_MS} ms of where they are: left as they came`);
        }
      } else if (found.speechOnly && !speech) console.log(`sync: ${filename}: speech in the audio doesn't time these captions clearly enough, left as they are`);
    }
    // A file with no subtitle track whose speech didn't time these clearly (no fit, one resting on few
    // windows, or a window heard well that lands elsewhere: the timing may step there): more of its
    // audio is heard in the background, and they are synced again by it on the next request (see
    // hearMoreSpeech).
    // Once that is heard: speech that hints at a step it can't place (stepSpots), whether it timed
    // these by one shift or not at all, has the audio heard where the step calls for, once a file.
    const stepAt = found.speechOnly && stepSpeechToHear(stored) ? stepSpots(found, captions, windowMs(stored.bitrate)) : undefined;
    const speechPending = (Boolean(found.speechOnly) && (anchors.length < SPEECH_SURE_WINDOWS || anchors.length < speechWindows) && moreSpeechToHear(stored)) || stepAt !== undefined;
    if (stepAt) console.log(`sync: ${filename}: speech hints at a step it can't place; hearing the audio at ${stepAt.length} more spots (${stepAt.map((s) => `${Math.round(s / 1000)}s`).join(", ")})`);
    else if (speechPending) console.log(`sync: ${filename}: ${anchors.length ? `timed by ${anchors.length} of ${found.windows.length} windows of speech` : "not timed by speech yet"}; hearing ${MORE_SPOTS.length} more spots of the audio`);
    const pending: Partial<SyncResult> = speechPending ? { speechPending, ...(stepAt ? { stepSpots: stepAt } : {}) } : {};
    count(anchors.length ? "sync.synced" : "sync.unsynced");
    if (anchors.length === 0) {
      if (!noFit) console.log(`sync: ${filename}: no anchor matched, captions left as they are`);
      const result: SyncResult = { file: source.file, anchors, ...(noFit ? { noFit } : {}), filename, source: path.basename(source.file), ...pending };
      if (!standInFor(filename)) await writeWhole(meta, JSON.stringify(result));
      if (speechPending) hearMoreSpeech(stored, aiostreamsUrl, videoId, type, filename, stepAt);
      return result;
    }
    // A translation takes its timing from where the file's own lines start, where they were read
    // (see followShifts); timing heard in speech does too, once enough of those lines meet it. Dub
    // captions and English CC (lang unset) follow the dub, not the file's lines: planShifts.
    // Timing by line starts (byStarts) keeps a plan of its own: its anchors are fits by line starts
    // already, and within a stretch its shift follows them from minute to minute (planShifts with
    // follow, see followRun), held in order as followShifts holds its own (inOrder). Fitting those
    // anchors again with followShifts did no better: over the stored plays, 59.8% of those lines
    // within 0.3 s against 60.2%. Every test above judged the plan; the timing followShifts makes of
    // it must account for the whole file as well, or the plan is served (see timingByStarts).
    // A translation timed by speech on a file whose own track the same voices show to be off them
    // (trackOffVoices) keeps the timing speech gave it: the track's lines neither refine nor snap it,
    // and no subtitle that fits the track takes its place (overTrack, see syncedWell).
    let overTrack = false;
    if (heard && lang && !found.speechOnly) {
      const bySpeech = planShifts(anchors, captions, reference);
      const said = trackOffVoices(
        captions.map((c) => c.start + bySpeech(c.start)),
        trackStartsOf(found),
        voiceSpotsOf(found)
      );
      if (said.off) {
        overTrack = true;
        count("sync.overTrack");
        console.log(`sync: ${filename}: against the voices heard, ${said.subtitle.met} of ${said.subtitle.lines} line starts meet one as speech times them and ${said.track.met} of ${said.track.lines} of the file's own track (chance ${Math.round(said.chance * 100)}%): the track is off the voices, not followed`);
      }
    }
    const fileLines = found.windows.flatMap((w) => w.cues);
    const followed = lang && !lineTimed && !startTimed && !found.speechOnly && !overTrack ? timingByStarts(anchors, captions, fileLines, heard, found) : undefined;
    if (followed) {
      if (heard) console.log(`sync: ${filename}: the timing heard in speech is met by the file's own lines: timed by them`);
      anchors = followed.anchors;
    }
    let planned = lineTimed
      ? shiftLookup(lineTimed)
      : followed
        ? followed.shift
        : startTimed
          ? inOrder(captions, planShifts(anchors, captions, reference, true))
          : planShifts(anchors, captions, reference);
    // Dub captions (no language) timed by the track then move onto the English voices, where the
    // audio has been heard and says so clearly (see refineBySpeech). Translations never do: byVoices
    // leaves them as they are, and nothing below moves dub captions.
    let voiceShift: number | undefined;
    const ownTimed = !heard && !found.speechOnly && !lineTimed && ownTrack();
    if (ownTimed) {
      count("sync.ownTrack");
      console.log(`sync: ${filename}: dub captions fit the file's own subtitle track at one shift in ${measuredWindows.length} windows: its timing stands, not moved onto the voices`);
    } else if (!heard && !found.speechOnly && !lineTimed) {
      const voiced = byVoices(planned);
      if (voiced.by) {
        const plan = planned;
        planned = voiced.shift;
        // Each anchor as served: its window's lines (in caption time) moved with their stretch.
        anchors = anchors.map((a) => ({ ...a, offset: a.offset + (voiced.shift(a.from - a.offset) - plan(a.from - a.offset)) }));
        const moves = voiced.by.moves.map((m) => m.by).sort((a, b) => a - b);
        voiceShift = moves[moves.length >> 1];
        count("sync.byVoices");
        const ms = (by: number) => `${by >= 0 ? "+" : ""}${by} ms`;
        console.log(`sync: ${filename}: dub captions moved onto the English voices, ${voiced.by.moves.map((m) => `${ms(m.by)}${m.own ? "" : " (as the file)"}`).join(", ")} (${voiced.by.windows} windows agree, score ${voiced.by.score}, margin ${voiced.by.margin})`);
      }
    }
    // Lines in the windows read then move onto the file's own line starts (snapping): translations
    // only, and timing heard in speech only once the file's lines confirm it (followed).
    const snapping = Boolean(lang) && !found.speechOnly && !lineTimed && (!heard || Boolean(followed));
    const chosenLang = track === undefined ? undefined : stored.trackLangs?.[String(track === "first" ? stored.track : track)];
    const ownLanguage = Boolean(lang && chosenLang && sameLanguage(chosenLang, lang));
    // A line the subtitle cuts in two is one line to the steps below, and its pieces move together
    // (see cutLines): its first piece alone would be paired a line off or left where it was.
    const cuts = snapping ? cutLines(text, ext, factor) : new Map<number, number>();
    const lines = cuts.size ? joinCuts(captions, cuts) : captions;
    const lead = (start: number) => cuts.get(start) ?? start;
    // Captions that already sit on the file's lines, on any of its tracks read (onFileLines), move no
    // more than a frame below: a track timed apart from the chosen one has them where they are. Not on
    // the file's own track in the captions' language, which is this subtitle's timing for the release,
    // line for line, and is followed.
    const onLines = snapping && !ownLanguage ? onFileLines(lines, planned, trackLines(stored)) : undefined;
    const stays = (start: number, move: number) => Boolean(onLines?.on.has(start)) && Math.abs(move) > FILM_FRAME_MS;
    if (onLines?.on.size) console.log(`sync: ${filename}: ${onLines.on.size} of ${lines.length} lines already sit on the file's lines (${Math.round(onLines.share * 100)}%): they stay within a frame`);
    const snapped = (shift: (start: number) => number) => {
      const nudges = snapping ? lineNudges(lines, shift, fileLines, ownLanguage ? OWN_SNAP : SNAP) : new Map<number, number>();
      for (const [start, move] of nudges) if (stays(start, move)) nudges.delete(start);
      return { nudges, shift: nudges.size ? (start: number) => shift(start) + (nudges.get(start) ?? 0) : shift };
    };
    const asShifted = snapped(planned);
    // The per-line steps for a translation, in order, each from where the one before left the lines,
    // so no line is moved twice in conflicting directions:
    // 1. the shift per stretch (followShifts, or byStarts' own plan), held in order by inOrder;
    // 2. on a file timed from its index, a line whose pairing by rhythm agrees with the pairs around
    //    it moves onto its own line (linesOverShift). Its residuals are measured from the shift of
    //    step 1, the closest there is, so fewer lines need moving and a pairing a line off stands
    //    out. Never timing heard in speech, which no shift on the track vouches for;
    // 3. snapping, on top of 1 and 2: a line moved onto its own line already starts there, so it
    //    isn't snapped again, and it keeps the others from snapping onto its line;
    // 4. keptInOrder, against the timing of 1 and 3: moved lines stay, the others give way.
    const paired =
      snapping && !heard && !found.image && found.source === "index"
        ? linesOverShift(lines, found.windows.filter((w) => !w.heard && !w.bridge).flatMap((w) => w.cues), planned)?.moves
        : undefined;
    if (paired) for (const [start, shift] of paired) if (stays(start, shift - planned(start))) paired.delete(start);
    // On the file's own track in the captions' language the lines pair one for one, so an extra line of
    // the subtitle doesn't get to take a line its neighbour is nearer to (see nearerClaims).
    const moved = paired && ownLanguage ? nearerClaims(lines, planned, paired) : paired;
    const timed = moved?.size ? snapped((start) => moved.get(start) ?? planned(start)) : asShifted;
    // Many lines a pairing confirms were already there by snapping: only the others count as moved.
    const movedLines = moved ? [...moved].filter(([start, shift]) => shift !== asShifted.shift(start)).length : 0;
    if (movedLines) count("sync.linesMoved", movedLines);
    if (timed.nudges.size) count("sync.snapped", timed.nudges.size);
    // Timing that moves line by line keeps the lines in order and apart (see keptInOrder): byLines
    // against the lines as written (each of its lines sits where the pairing puts it, in order), the
    // moves above against the shift with snapping they started from.
    const perLine = lineTimed
      ? keptInOrder(captions, planned, new Set(lineTimed.keys()), () => 0)
      : moved?.size
        ? keptInOrder(lines, timed.shift, new Set(moved.keys()), asShifted.shift)
        : undefined;
    // A translation the track moves by a second or more may be right as it came, on a file whose own
    // track is off its voices (trackcheck.ts). Where the file has been heard for that, the voices
    // decide; where it hasn't, a subtitle made for the playing release has it heard, in the background.
    /** How far each line is moved as served, by its start. */
    const servedShift = (start: number) => (perLine ? perLine.shift(lead(start)) : timed.shift(lead(start)));
    let trackCheckPending = false;
    if (lang && !heard && !found.speechOnly && !lineTimed && factor === 1) {
      const cameStarts = captions.map((c) => c.start);
      const spots = await keptVoiceSpots(filename);
      if (spots) {
        const said = voicesSay(cameStarts, servedShift, spots);
        if (said.came.lines || said.served.lines) console.log(`sync: ${filename}: against the voices heard, ${said.came.met} of ${said.came.lines} line starts meet one as it came and ${said.served.met} of ${said.served.lines} as timed by the track (chance ${Math.round(said.chance * 100)}%)${said.verdict ? `: ${said.verdict} is on the voices` : ": no clear answer, the track's timing stands"}`);
        if (said.verdict === "as it came") {
          count("sync.trackOffVoices");
          const result: SyncResult = { file: source.file, anchors: anchors.map((a) => ({ ...a, offset: 0 })), filename, source: path.basename(source.file), asCame: true };
          if (!standInFor(filename)) await writeWhole(meta, JSON.stringify(result));
          return result;
        }
      } else if (opts.forRelease && SPEECH_SYNC && stored.audio !== undefined && !voiceSpotsTried.has(filename)) {
        let froms = trackCheckSpots(cameStarts, servedShift, stored.duration);
        // A file too heavy for three stretches hears two; one too heavy for two keeps the track's timing.
        while (froms.length > 2 && windowBytes(stored.bitrate, froms.length * TRACK_CHECK.spanMs) > TRACK_CHECK.maxBytes) froms = froms.slice(0, -1);
        const cost = windowBytes(stored.bitrate, froms.length * TRACK_CHECK.spanMs);
        if (froms.length && cost <= TRACK_CHECK.maxBytes && backgroundReadFits(cost)) {
          trackCheckPending = true;
          count("sync.trackCheck");
          console.log(`sync: ${filename}: made for this release by its names, yet its track moves it a second or more: hearing ${froms.length} stretches of the audio to see which is on the voices`);
          hearVoiceSpots(stored, froms, aiostreamsUrl, videoId, type, filename);
        }
      }
    }
    const out = path.join(cachePath("synced"), `${key}${ext}`);
    // Whole or not at all: a result synced again (voicesPending) replaces one a download may be reading.
    // Every piece of a cut line takes its first piece's move; the last piece's end ends the line. Its
    // songs are laid out for players' fonts here (laidOutForPlayers), so no download waits for it.
    await writeWhole(
      out,
      laidOutForPlayers(
        // No line stays up into the next when it didn't as written (endsApart).
        retime(
          text,
          ext,
          servedShift,
          factor,
          endsApart(
            parseCues(text, ext).map((c) => ({ start: Math.round(c.start * factor), end: Math.round(c.end * factor) })),
            servedShift,
            perLine ? (start, end) => perLine.end(lead(start), end) : undefined
          )
        ),
        ext
      )
    );
    const done = [...(movedLines ? [`${movedLines} lines moved onto their own line`] : []), ...(timed.nudges.size ? [`${timed.nudges.size} lines snapped to the file`] : [])];
    console.log(`sync: ${filename}: ${anchors.map((a) => `${Math.round(a.from / 1000)}s ${a.offset >= 0 ? "+" : ""}${a.offset}ms (${a.score})`).join(", ")}${done.length ? `; ${done.join(", ")}` : ""}`);
    const timedBy = lineTrack ?? track;
    const measuredBy = heard || found.speechOnly || timedBy === undefined ? "speech" : (stored.trackLangs?.[String(timedBy === "first" ? stored.track : timedBy)] ?? "und");
    const result: SyncResult = { file: out, anchors, filename, source: path.basename(source.file), ...(heard ? { bySpeech: true } : {}), ...(overTrack ? { overTrack: true } : {}), ...(found.speechOnly ? { speechOnly: true } : {}), ...(lineTimed ? { byLines: true } : {}), ...(startTimed ? { byStarts: true } : {}), ...(factor !== 1 ? { factor } : {}), ...(voiceShift !== undefined ? { voiceShift } : {}), reference: measuredBy, ...(timed.nudges.size ? { snapped: timed.nudges.size } : {}), ...(movedLines ? { moved: movedLines } : {}) };
    // Dub captions the track timed on a file whose English audio is still to be heard: it is read in
    // the background, and these are synced again by it on the next request (see hearDubVoices).
    // Not for the file's own track (ownTimed): the voices wouldn't move it.
    if (!lang && !heard && !lineTimed && !ownTimed && voiceShift === undefined && voicesToHear(stored)) result.voicesPending = true;
    Object.assign(result, pending);
    if (trackCheckPending) result.trackCheckPending = true;
    if (!standInFor(filename)) await writeWhole(meta, JSON.stringify(result));
    if (result.voicesPending) hearDubVoices(stored, aiostreamsUrl, videoId, type, filename, anchors);
    if (speechPending) hearMoreSpeech(stored, aiostreamsUrl, videoId, type, filename, stepAt);
    return result;
  })().catch((error) => {
    readFailed(filename, error);
    return undefined;
  });
  syncJobs.set(key, job);
  // Only while it runs, so the list and the download share one sync. A finished one is on disk and
  // read from there next time; a failed one is tried again.
  void job.then(() => {
    firstPass.delete(key);
    if (syncJobs.get(key) === job) syncJobs.delete(key);
  });
  return job;
}
