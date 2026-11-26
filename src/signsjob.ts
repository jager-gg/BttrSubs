/**
 * Signs for a playing file, found and timed once and kept (cache/signs): the episode's signs sources
 * on Anime Tosho (animeToshoSigns) tried in order until one's dialogue track syncs well to the file,
 * as any subtitle does; its signs track is then moved line by line as that dialogue moved. A list
 * starts this for the file it is for (startSigns); English Dub's download takes the result
 * (readySigns) and merges it with the dub's lines (signs.ts). Signs taken from among a full track's
 * lines are given at once, and the look goes on for a signs track, which replaces them once one times
 * well: its makers typeset each sign, where a full track's signs are told from its dialogue by style.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cacheKey, cachePath, writeFileAtomic } from "./cache.js";
import { animeToshoSigns, type SignsSource, type Tier } from "./animetosho.js";
import { tsukihimeSigns } from "./tsukihime.js";
import { getCachedSubtitleFile } from "./downloads.js";
import { eventCount, ownStyleOf, parseScript, signsOfFull, writeScript, type OwnStyle, type Script } from "./signs.js";
import { laidOutForPlayers } from "./respace.js";
import { stamp } from "./srt.js";
import { count, noteError } from "./stats.js";
import { fileName, fileSubtitleTracks, readingsRef, retime, syncCaptions, syncKey } from "./sync.js";
import { decodeSubtitle } from "./text.js";
import type { SeasonMap, StremioSubtitleRequest } from "./types.js";

/** Kept when none is found: half a day, as a release may be mirrored meanwhile. Found signs are kept as long as the file's readings. */
const NONE_KEPT_MS = 12 * 3600_000;
/** Sources whose dialogue is synced per file at most: each costs a sync. */
const TRIES = 3;
/**
 * Sources looked at per file at most, those that can't be fetched included (a track too big to be a
 * subtitle, or one in another language). Calibration (an episode whose first three sources all carried
 * one fan group's 54.8 MB full track, over the cap): the fourth timed to the file at 0 ms.
 */
const SOURCES = 8;
/** Neighbouring lines whose moves differ by no more than this moved alike: a sign between them is moved in proportion. */
const ALIKE_MS = 100;
/** Moves are smoothed over this many lines, so one line snapped onto the file's own line doesn't carry a sign with it. */
const SMOOTHING = 7;

interface Kept {
  found: boolean;
  at: number;
  release?: string;
  signsName?: string;
  signs?: string;
  partner?: string;
  events?: number;
  /** The signs, moved onto the file, as an ASS script. */
  script?: string;
  /** No better signs are looked for: these are a signs track's, or the look for one is over. */
  settled?: boolean;
  /** Taken from a full track by this version of what is taken (FULL_KEPT). */
  version?: number;
}

/** Signs taken from among a full track's lines: its signs and its dialogue are the same track. */
const fromFull = (kept: Kept) => kept.found && Boolean(kept.partner) && kept.signs === kept.partner;
/** What a full track gives: 2 adds the runs that may be a song's lyrics (signsOfFull). Signs taken by an earlier version are taken again. */
const FULL_KEPT = 2;

const jobs = new Map<string, Promise<Kept>>();
// Signs are timed to the file that is read: kept under the release a link serves in a failed one's place.
const keyOf = (videoId: string, filename: string) => cacheKey({ kind: "signs", videoId, filename: readingsRef(filename) });
const keptFile = (key: string) => path.join(cachePath("signs"), `${key}.json`);

async function keptFor(key: string): Promise<Kept | undefined> {
  try {
    const kept = JSON.parse(await readFile(keptFile(key), "utf8")) as Kept;
    if (fromFull(kept) && kept.version !== FULL_KEPT) return undefined;
    if (kept.found || Date.now() - kept.at < NONE_KEPT_MS) return kept;
  } catch {}
  return undefined;
}

/** Each event's start, in the order written: an ASS script's Dialogue lines, or an SRT's or VTT's cues. A retimed copy keeps that order. */
export function startsInOrder(text: string): number[] {
  if (/^\[Script Info\]|^Dialogue:/m.test(text)) return [...text.matchAll(/^Dialogue:[^,]*,(\d+:\d{2}:\d{2}\.\d{2}),/gm)].map((m) => stamp(m[1]));
  return [...text.matchAll(/^\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})\s*-->/gm)].map((m) => stamp(m[1]));
}

/**
 * How far a line starting at t, in the release's time, moves onto the playing file: from the dialogue
 * track's lines before and after their sync (the same lines, in the same order), each line's move the
 * median of its SMOOTHING neighbours'. Between two lines that moved alike, in proportion (a subtitle
 * made for another frame rate moves more as it goes); across a step, as the nearer line moved.
 */
export function movesBy(before: number[], after: number[]): ((t: number) => number) | undefined {
  if (!before.length || before.length !== after.length) return undefined;
  const sorted = before.map((b, i) => ({ t: b, d: after[i] - b })).sort((x, y) => x.t - y.t);
  const pairs = sorted.map((p, i) => {
    // Centred on the line, narrower near the ends: a steady drift keeps its own value there.
    const half = Math.min(SMOOTHING >> 1, i, sorted.length - 1 - i);
    const near = sorted.slice(i - half, i + half + 1).map((q) => q.d).sort((a, b) => a - b);
    return { t: p.t, d: near[near.length >> 1] };
  });
  return (t) => {
    if (t <= pairs[0].t) return pairs[0].d;
    const last = pairs[pairs.length - 1];
    if (t >= last.t) return last.d;
    let lo = 0;
    let hi = pairs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const [a, b] = [pairs[lo], pairs[hi]];
    if (Math.abs(a.d - b.d) <= ALIKE_MS && b.t > a.t) return Math.round(a.d + ((b.d - a.d) * (t - a.t)) / (b.t - a.t));
    return t - a.t <= b.t - t ? a.d : b.d;
  };
}

interface For {
  request: StremioSubtitleRequest;
  show?: string;
  map?: SeasonMap;
  tvdbId?: number;
  aiostreamsUrl: string;
  videoId: string;
  type: string;
  filename: string;
  /** A file a player asked about ahead of playing it: the whole look goes behind everything else. */
  ahead?: boolean;
  /** Whether TsukiHime is among the configuration's sources: its list of the episode is searched first. */
  tsukihime?: boolean;
}

/**
 * The episode's signs sources, each once: TsukiHime's first where it is a source (its list of the
 * episode answers in about a second and holds Anime Tosho's archive), then Anime Tosho's own search,
 * which also finds releases no episode lists (a whole show's batch).
 */
async function* sourcesFor(input: For, lane: { tier: Tier }): AsyncGenerator<SignsSource> {
  const given = new Set<string>();
  const once = (source: SignsSource) => {
    // A track is the same track whichever service it is fetched from: "at" and "tht" name one archive's.
    const id = (ref: string) => (/^at[0-9a-f]+$/.test(ref) ? String(parseInt(ref.slice(2), 16)) : ref.replace(/^tht/, ""));
    const key = `${id(source.signs)}|${id(source.partner)}`;
    return given.has(key) ? false : (given.add(key), true);
  };
  if (input.tsukihime) for await (const source of tsukihimeSigns(input.request, input.show, fileName(input.filename))) if (once(source)) yield source;
  for await (const source of animeToshoSigns(input.request, input.show, input.map, { tvdbId: input.tvdbId, filename: fileName(input.filename), lane })) if (once(source)) yield source;
}

/**
 * One source's signs moved onto the file, or why not (its dialogue doesn't sync well to the file, its
 * lines don't pair, it has no signs). Throws when a track can't be fetched.
 */
async function timed(source: SignsSource, { request, aiostreamsUrl, videoId, type, filename }: For): Promise<Kept | string> {
  const { season, episode } = request;
  // The signs track is fetched while its dialogue is fetched and synced. A signs track has too few
  // words to be checked for its language: the dialogue track beside it is.
  const signsFile = source.full ? undefined : getCachedSubtitleFile(source.signs, season, episode, {});
  signsFile?.catch(() => undefined);
  const partner = await getCachedSubtitleFile(source.partner, season, episode, {}, undefined, "english");
  const result = await syncCaptions(syncKey(source.partner, season, episode, filename), async () => partner, aiostreamsUrl, videoId, type, filename, "English");
  // Timed by the file's own lines, or by speech on a file that has none: a speech guess where lines exist isn't enough to place signs.
  if (!result || !result.anchors.length || result.noFit || result.speechPending || (result.bySpeech && !result.speechOnly)) return "its dialogue doesn't sync well to the file";
  const original = decodeSubtitle(await readFile(partner.file), "english");
  const move = movesBy(startsInOrder(original), startsInOrder(decodeSubtitle(await readFile(result.file), "english")));
  if (!move) return "its dialogue's lines don't pair before and after the sync";
  const text = signsFile ? decodeSubtitle(await readFile((await signsFile).file), "english") : original;
  const parsed = parseScript(retime(text, ".ass", move));
  const script: Script | undefined = parsed && (source.full ? signsOfFull(parsed) : parsed);
  if (!script || !eventCount(script)) return "no signs in it";
  return {
    found: true,
    at: Date.now(),
    ...(source.full ? { version: FULL_KEPT } : {}),
    release: source.release,
    signsName: source.signsName,
    signs: source.signs,
    partner: source.partner,
    events: eventCount(script),
    // Songs laid out for players' fonts now, so English Dub's download sends the merge as it is.
    script: laidOutForPlayers(writeScript(script), ".ass"),
    settled: !source.full
  };
}

/**
 * Times the episode's signs sources to the file in turn, from `before` (signs from a full track, kept):
 * `give` gets the first that times well; one from a full track is kept, and a signs track that times
 * well later replaces it.
 */
async function look(input: For, key: string, before: Kept | undefined, give: (kept: Kept) => void): Promise<void> {
  let best = before;
  // Each source is timed as soon as the search gives it. One that can't be fetched doesn't use up a try.
  let tried = 0;
  let looked = 0;
  // Once there are signs, the look for better ones waits behind everything else, as does a file asked about ahead.
  const lane: { tier: Tier } = { tier: best || input.ahead ? "later" : "signs" };
  for await (const source of sourcesFor(input, lane)) {
    // With signs in, only a signs track can do better.
    if (best && source.full) continue;
    if (looked++ >= SOURCES || tried >= TRIES) break;
    const done = await timed(source, input).catch((error: unknown) => `not fetched: ${error instanceof Error ? error.message : String(error)}`);
    if (typeof done === "string") {
      if (!done.startsWith("not fetched")) tried++;
      console.log(`signs: ${input.filename}: "${source.signsName}" of ${source.release}: ${done}`);
      continue;
    }
    tried++;
    writeFileAtomic(keptFile(key), JSON.stringify(done));
    if (best) {
      count("signs.better");
      console.log(`signs: ${input.filename}: ${done.events} from "${done.signsName}" of ${done.release}, in place of ${best.events} from "${best.signsName}" of ${best.release}`);
      jobs.set(key, Promise.resolve(done));
    } else {
      count("signs.found");
      console.log(`signs: ${input.filename}: ${done.events} from "${done.signsName}" of ${done.release}${done.settled ? "" : "; looking on for a signs track"}`);
      give(done);
    }
    best = done;
    lane.tier = "later";
    if (done.settled) return;
  }
  if (best) {
    // The full track's signs stay, and the look isn't made again.
    const kept: Kept = { ...best, settled: true };
    writeFileAtomic(keptFile(key), JSON.stringify(kept));
    jobs.set(key, Promise.resolve(kept));
    console.log(`signs: ${input.filename}: no signs track that times to it (${looked} looked at, ${tried} synced); "${best.signsName}" of ${best.release} kept`);
    return;
  }
  const none: Kept = { found: false, at: Date.now() };
  writeFileAtomic(keptFile(key), JSON.stringify(none));
  count("signs.none");
  console.log(`signs: ${input.filename}: none that time to it (${looked} looked at, ${tried} synced)`);
  give(none);
}

/**
 * Finds and times the signs for the file a list is for, unless kept or under way; signs kept from a
 * full track are given at once while the look for a signs track goes on, unless it was made already.
 */
export function startSigns(input: For): void {
  const key = keyOf(input.videoId, input.filename);
  if (jobs.has(key)) return;
  let give!: (kept: Kept) => void;
  jobs.set(key, new Promise<Kept>((resolve) => (give = resolve)));
  (async () => {
    const before = await keptFor(key);
    if (before) give(before);
    if (before && !(fromFull(before) && !before.settled)) return;
    await look(input, key, before, give);
  })()
    .catch((error: unknown) => {
      noteError("signs", error);
      // Given already, this changes nothing.
      give({ found: false, at: Date.now() });
    })
    .finally(() => setTimeout(() => jobs.delete(key), 60_000).unref());
}

/**
 * The signs kept for the file, or the ones under way within waitMs: "pending" when they are still
 * being found or timed by then, undefined when there are none. `settled` is false while a signs
 * track that would replace them may still be found.
 */
export async function readySigns(
  videoId: string,
  filename: string,
  waitMs: number
): Promise<{ script: Script; release: string; signsName: string; settled: boolean } | "pending" | undefined> {
  const key = keyOf(videoId, filename);
  const running = jobs.get(key);
  const done = running ? await Promise.race([running, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), Math.max(0, waitMs)).unref())]) : await keptFor(key);
  if (done === "pending") return done;
  if (!done?.found || !done.script) return undefined;
  const script = parseScript(done.script);
  return script ? { script, release: done.release ?? "", signsName: done.signsName ?? "", settled: !fromFull(done) || Boolean(done.settled) } : undefined;
}

/** The signs job under way for the file, if any: done once it has given its first signs, or none. */
export function signsUnderWay(videoId: string, filename: string): Promise<unknown> | undefined {
  return jobs.get(keyOf(videoId, filename));
}

/** What's kept about a file's signs, for diagnostics, the script left out: found or none, from where, how many, settled or still looked for. */
export async function signsKept(videoId: string, filename: string): Promise<Omit<Kept, "script"> | undefined> {
  try {
    const { script: _script, ...rest } = JSON.parse(await readFile(keptFile(keyOf(videoId, filename)), "utf8")) as Kept;
    return rest;
  } catch {
    return undefined;
  }
}

/** The playing file's own dialogue style (signs.ts ownStyleOf), from its header's subtitle tracks; read once, within waitMs. */
export async function fileOwnStyle(aiostreamsUrl: string, videoId: string, type: string, filename: string, waitMs: number): Promise<OwnStyle | undefined> {
  const tracks = await Promise.race([fileSubtitleTracks(aiostreamsUrl, videoId, type, filename), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), Math.max(0, waitMs)).unref())]);
  return tracks ? ownStyleOf(tracks) : undefined;
}
