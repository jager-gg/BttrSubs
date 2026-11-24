/**
 * Getting a subtitle file onto disk: one download per subtitle from its source
 * (cached in downloads/), then the episode's file taken out of a pack and
 * stored as UTF-8 in subtitles/ under "<subtitle>-<season>-<episode>".
 */
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { cachePath, writeFileWhole } from "./cache.js";
import { fetchPublic, readCapped } from "./net.js";
import { decodeSubtitle, utf16ToUtf8 } from "./text.js";
import { count, noteError, noteKeyCall } from "./stats.js";
import { downloadSubtitleArchive } from "./subsource.js";
import { downloadSubtitleCat, notWrittenIn } from "./subtitlecat.js";
import { downloadAnimeTosho } from "./animetosho.js";
import { downloadTsukihime } from "./tsukihime.js";
import { downloadAninzb } from "./aninzb.js";
import { gestdownDownloadUrl } from "./gestdown.js";
import { downloadWyzie } from "./wyzie.js";
import { theSubtitleDbDownloadUrl } from "./thesubtitledb.js";
import { readKept } from "./kept.js";
import { openSubtitlesDownloadUrl, repairOpenSubtitlesVtt, subdlDownloadUrl } from "./sources.js";
import { bareEpisodeMarkerMatches, bareNumbers, episodeMarkerMatches, extractEpisodeMarkers, extractEpisodeRange, fileLooksLikeSubtitle } from "./matching.js";

/** The keys a download may need, from whoever asked for it. */
export interface SourceKeys {
  subsource?: string;
  subdl?: string;
  wyzie?: string;
  /** An added addon's subtitle URL (opened from the download link), for "cx" refs. */
  addonUrl?: string;
}

/** A zip starts with "PK". */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const isZip = (buffer: Buffer) => buffer.subarray(0, 4).equals(ZIP_SIGNATURE);

/**
 * A pack's bytes with every repeated file name made its own. The zip reader refuses a whole archive
 * that lists one name twice, and uploaded packs do. Later entries under a name already taken get a
 * "~" and a number over the end of their name in the archive's directory (the same length, so nothing
 * else moves): the first keeps the name, the rest stop looking like subtitles and are passed over.
 * The buffer is returned as it is when it holds no repeat or doesn't read as a zip.
 */
export function withOwnNames(buffer: Buffer): Buffer {
  // The end record: the last "PK\x05\x06", then the directory's size and offset.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) return buffer;
  const from = buffer.readUInt32LE(end + 16);
  const names: Array<{ at: number; length: number; name: string }> = [];
  for (let at = from; at + 46 <= end && buffer.readUInt32LE(at) === 0x02014b50; ) {
    const length = buffer.readUInt16LE(at + 28);
    names.push({ at: at + 46, length, name: buffer.toString("latin1", at + 46, at + 46 + length) });
    at += 46 + length + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  const taken = new Set<string>();
  let out = buffer;
  for (const entry of names) {
    if (!taken.has(entry.name)) {
      taken.add(entry.name);
      continue;
    }
    for (let n = 1; n < 10_000; n++) {
      const tail = `~${n}`;
      if (tail.length > entry.length) break;
      const renamed = entry.name.slice(0, entry.length - tail.length) + tail;
      if (taken.has(renamed)) continue;
      if (out === buffer) out = Buffer.from(buffer);
      out.write(tail, entry.at + entry.length - tail.length, "latin1");
      taken.add(renamed);
      break;
    }
  }
  return out;
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/** Extensions a stored subtitle can have, in the order they're looked for. */
const STORED_FORMATS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];

/** "ss123" and plain "123" are SubSource; cache names stay as they were for it. */
function cacheName(ref: string): string {
  const plain = ref.match(/^(?:ss)?(\d+)$/);
  return plain ? plain[1] : ref.replace(/[^\w-]/g, "_");
}

async function fetchSource(ref: string, keys: SourceKeys): Promise<Buffer> {
  const subsource = ref.match(/^(?:ss)?(\d+)$/);
  if (subsource) {
    if (!keys.subsource) throw new Error("no SubSource key for this subtitle");
    return downloadSubtitleArchive(Number(subsource[1]), keys.subsource);
  }
  if (ref.startsWith("cx")) {
    const url = keys.addonUrl;
    if (!url || `cx${createHash("sha256").update(url).digest("hex").slice(0, 20)}` !== ref) throw new Error(`no address for subtitle ${ref}`);
    // Never put the URL in the message: an addon's links can carry its keys.
    const response = await fetchPublic(url, 20000);
    if (!response.ok) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
    const body = await readCapped(response, 10_000_000);
    return body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body, { maxOutputLength: 20_000_000 }) : body;
  }
  if (ref.startsWith("kc")) return readKept(ref);
  if (ref.startsWith("sc")) return downloadSubtitleCat(ref);
  if (ref.startsWith("at")) return downloadAnimeTosho(ref);
  if (ref.startsWith("th")) return downloadTsukihime(ref);
  if (ref.startsWith("az")) return downloadAninzb(ref, keys.addonUrl);
  if (ref.startsWith("wz")) return downloadWyzie(ref, keys.wyzie);
  if (ref.startsWith("tb") || ref.startsWith("gd")) {
    // The keyless sources' links lead on to hosts they choose (TheSubtitleDB's to its file store), so
    // each hop is checked like an addon's, and a body far bigger than a subtitle is refused.
    const free = ref.startsWith("tb") ? theSubtitleDbDownloadUrl(ref) : gestdownDownloadUrl(ref);
    if (!free) throw new Error(`unknown subtitle ${ref}`);
    const response = await fetchPublic(free, 20000, { headers: { "user-agent": "BttrSubs" } });
    if (!response.ok) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
    return readCapped(response, 10_000_000);
  }
  let url: string | undefined;
  if (ref.startsWith("sd")) {
    if (!keys.subdl) throw new Error("no SubDL key for this subtitle");
    url = subdlDownloadUrl(ref, keys.subdl);
  } else if (ref.startsWith("os")) {
    url = openSubtitlesDownloadUrl(ref);
  }
  if (!url) throw new Error(`unknown subtitle ${ref}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (ref.startsWith("sd")) noteKeyCall("subdl", keys.subdl, response, true);
  // Never put the URL in the message: SubDL's carries the key.
  if (!response.ok) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  return ref.startsWith("os") ? Buffer.from(repairOpenSubtitlesVtt(body.toString("utf8")), "utf8") : body;
}

const downloadFile = (ref: string) => path.join(cachePath("downloads"), `${cacheName(ref)}.bin`);

/** Whether this subtitle was downloaded already, so getting it again costs its source nothing. */
export function isDownloaded(ref: string): Promise<boolean> {
  return exists(downloadFile(ref));
}

/** Downloads under way, by subtitle: a list's pack check, its sync and a player's request share one. */
const fetching = new Map<string, Promise<string>>();

/**
 * The subtitle as its source sends it, on disk: downloaded once, however many ask at the same moment
 * (each real download counts against a key's daily allowance), and written whole or not at all, so
 * nothing reads half of one.
 */
function ensureDownloadCached(ref: string, keys: SourceKeys): Promise<string> {
  const running = fetching.get(ref);
  if (running) return running;
  const job = downloadOnce(ref, keys).finally(() => fetching.delete(ref));
  fetching.set(ref, job);
  return job;
}

async function downloadOnce(ref: string, keys: SourceKeys): Promise<string> {
  const folder = cachePath("downloads");
  await mkdir(folder, { recursive: true });
  const file = downloadFile(ref);
  if (!(await exists(file))) {
    // One real download from a source; a cached file costs nothing.
    const source = /^(?:ss)?\d+$/.test(ref) ? "subsource" : ref.startsWith("sd") ? "subdl" : ref.startsWith("os") ? "opensubtitles" : ref.startsWith("sc") ? "subtitlecat" : ref.startsWith("tb") ? "thesubtitledb" : ref.startsWith("gd") ? "gestdown" : ref.startsWith("at") ? "animetosho" : ref.startsWith("th") ? "tsukihime" : ref.startsWith("az") ? "aninzb" : ref.startsWith("wz") ? "wyzie" : ref.startsWith("kc") ? "kept" : "addons";
    count(`fetch.${source}`);
    try {
      await writeFileWhole(file, await fetchSource(ref, keys));
    } catch (error) {
      noteError("download", error);
      throw error;
    }
  }
  return file;
}


/** The format of a lone subtitle file, from its first bytes. */
function sniffExtension(buffer: Buffer): string {
  const head = buffer.subarray(0, 64).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("WEBVTT")) return ".vtt";
  if (head.startsWith("[Script Info]")) return ".ass";
  return ".srt";
}

/**
 * The pack's file for this episode: one named with its season and episode
 * first, else one with the episode as a number of its own.
 */
/** Subtitle files run to a few hundred KB; a long, heavily styled ASS stays well under this. */
const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

/**
 * The run of episodes one file covers, when its name gives one of three or more: "EP1-EP9 en.srt",
 * "10-18en.srt". Such a file is the subtitle of a compilation video, not of any one episode: its
 * "EP1" would otherwise be taken for episode 1. Two episodes ("S01E01-E02") is a double episode and stays.
 */
export function compilationRange(name: string): { from: number; to: number } | undefined {
  const base = name.replace(/^.*[\\/]/, "");
  const spelled = extractEpisodeRange(base);
  const bare = /^\s*0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})(?=\D|$)/.exec(base);
  const range = spelled ?? (bare ? { from: Number(bare[1]), to: Number(bare[2]) } : undefined);
  return range && range.to - range.from >= 2 ? range : undefined;
}

/**
 * A name without the season half of its season-and-episode markers ("Show - S02E01" -> "Show - E01",
 * "2x01" -> "x01", "E01 S02" -> "E01 "), so a season's digits are never read as a bare episode number:
 * "S02E01" was taken for episode 2 (a SubDL "season pack" holding only episode 1).
 */
export function withoutSeasons(name: string): string {
  return name
    .replace(/s\s*\d{1,2}(?=\s*e\s*\d)/gi, "")
    .replace(/(e\s*\d{1,3}\D{0,4})s\s*\d{1,2}(?!\d)/gi, "$1")
    .replace(/\b\d{1,2}(?=x\d)/gi, "");
}

/**
 * A name without the numbers of its title's season or part ("Show Part 2 - 01" -> "Show - 01",
 * "Show Season 2 - 03" -> "Show - 03"), so they aren't read as the episode: every file of a part's
 * pack says "Part 2", and episode 2 would be found in each.
 */
export function withoutTitleNumbers(name: string): string {
  return name.replace(/\b(?:season|part|cour)[\s._-]*\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)[\s._-]*(?:season|part|cour)\b/gi, " ");
}

/** The episode numbers a file's name gives, its title's season and part numbers left out. */
const numbersOf = (name: string) => bareNumbers(withoutTitleNumbers(withoutSeasons(name.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,4}$/i, ""))));

/**
 * The pack's file for this episode. pick: the episode's number within the season or part the
 * subtitle's name gave ("Show: Third Arc Part 2 [1 ~ 11]" holds IMDb's season 3 episode 12 as its
 * "- 01"), when that isn't the IMDb episode. Season 0 is IMDb's specials, an episode like any other
 * ("S00E01"), not a film.
 */
export function selectArchiveEntry(zip: AdmZip, season?: number, episode?: number, pick?: number): AdmZip.IZipEntry | undefined {
  return selectEntry(zip.getEntries(), season, episode, pick);
}

/**
 * Whether a pack whose files a source lists by name (SubDL's unpack_files) holds the one a download
 * of this episode would take (selectArchiveEntry, by the same rules): known before downloading it.
 * Only the names are read: a source's own episode numbers for them can be wrong.
 */
export function listedPackHolds(names: string[], season: number | undefined, episode: number | undefined, pick?: number): boolean {
  return Boolean(selectEntry(names.map((entryName) => ({ entryName, isDirectory: false, header: { size: 0 } })), season, episode, pick));
}

/** What picking a pack's file reads of each entry. */
type PackEntry = { entryName: string; isDirectory: boolean; header: { size: number } };

function selectEntry<T extends PackEntry>(entries: T[], season?: number, episode?: number, pick?: number): T | undefined {
  const every = entries.filter((entry) => !entry.isDirectory && fileLooksLikeSubtitle(entry.entryName));
  const anEpisode = season !== undefined && Boolean(episode);
  // For an episode, files that each cover a run of episodes aren't candidates.
  const files = anEpisode ? every.filter((entry) => !compilationRange(entry.entryName)) : every;
  if (episode && pick !== undefined) return pickedEntry(files, season, episode, pick);
  if (anEpisode && episode) {
    const named =
      files.find((entry) => episodeMarkerMatches(entry.entryName, season, episode)) ??
      files.find((entry) => bareEpisodeMarkerMatches(withoutTitleNumbers(withoutSeasons(entry.entryName)), episode));
    if (named) return named;
  }

  // A film's zip often holds the same subtitle under several release names: the fullest one is
  // taken, never a forced-lines file. Sync then checks it fits.
  if (!anEpisode && files.length > 1) {
    const full = files.filter((entry) => !/forced|signs?\b/i.test(entry.entryName));
    return (full.length ? full : files).reduce((a, b) => (b.header.size > a.header.size ? b : a));
  }

  // A lone file is the episode only if its name doesn't say it's another one: SubDL lists
  // "season packs" that hold just episode 1 ("Show - S01E01 (001).srt").
  if (files.length !== 1) return undefined;
  return anEpisode && episode && namesAnotherEpisode(files[0].entryName, episode) ? undefined : files[0];
}

/**
 * The file numbered as the subtitle's name counts (pick), for the IMDb episode asked for: one named
 * with the IMDb season and episode first, then one numbered pick (one that also gives the IMDb number,
 * "Show - 15 [P2 - 04]", before one that gives pick alone). A pack of a part holds no other episode
 * of that number, so a file numbered like the IMDb episode is taken only when none is numbered pick
 * (a part's pack whose files count on within the season). A lone file is taken unless it names
 * another episode in both counts.
 */
function pickedEntry<T extends PackEntry>(files: T[], season: number | undefined, episode: number, pick: number): T | undefined {
  if (season !== undefined) {
    const spelled = files.find((entry) => episodeMarkerMatches(entry.entryName, season, episode));
    if (spelled) return spelled;
  }
  // A file whose season-and-episode marker is another episode in both counts is never it.
  const markers = (entry: PackEntry) => extractEpisodeMarkers(entry.entryName.replace(/^.*[\\/]/, ""));
  const open = files.filter((entry) => markers(entry).length === 0 || markers(entry).some((m) => m.episode === pick));
  const numbered = open.filter((entry) => numbersOf(entry.entryName).includes(pick));
  const best = numbered.find((entry) => numbersOf(entry.entryName).includes(episode)) ?? numbered.find((entry) => numbersOf(entry.entryName).length === 1) ?? numbered[0];
  if (best) return best;
  const imdbNumbered = open.find((entry) => markers(entry).length === 0 && numbersOf(entry.entryName).includes(episode));
  if (imdbNumbered) return imdbNumbered;
  return files.length === 1 && open.length === 1 && numbersOf(files[0].entryName).length === 0 ? files[0] : undefined;
}

/** "S01E01", "E01", "- 001" and the like that point at an episode other than this one. */
export function namesAnotherEpisode(name: string, episode: number): boolean {
  const markers = extractEpisodeMarkers(name);
  if (markers.length) return !markers.some((m) => m.episode === episode);
  const numbers = bareNumbers(name.replace(/\.[a-z0-9]{2,4}$/i, ""));
  return numbers.length > 0 && !numbers.includes(episode);
}

/** Packs known not to hold this episode, so the list can leave them out. */
function missingFile(cacheStem: string): string {
  return path.join(cachePath("subtitles"), `${cacheStem}.missing`);
}

/**
 * What a subtitle's file for this episode is stored as: "<subtitle>-<season>-<episode>", and
 * "-p<pick>" after it when the pack's file is found by the subtitle's own count (selectArchiveEntry),
 * which can be another file of the same pack.
 */
const stemOf = (ref: string | number, season: number | undefined, episode: number | undefined, pick?: number) =>
  `${cacheName(String(ref))}-${season ?? "movie"}-${episode ?? "full"}${pick !== undefined ? `-p${pick}` : ""}`;

/** The format this subtitle is stored in for this episode (".ass", ".srt", …), once it has been downloaded. */
export async function storedSubtitleExt(ref: string | number, season: number | undefined, episode: number | undefined, pick?: number): Promise<string | undefined> {
  const cacheStem = stemOf(String(ref), season, episode, pick);
  for (const ext of STORED_FORMATS) if (await exists(path.join(cachePath("subtitles"), cacheStem + ext))) return ext;
  return undefined;
}

/** Archives already downloaded, by subtitle and episode: whether each holds the episode (see knownMissing). */
const held = new Map<string, boolean>();

/**
 * Whether this subtitle is known not to have the episode: its pack held another one when asked for
 * it, or its archive, downloaded for another episode, holds no file for this one (selectArchiveEntry,
 * as a download would pick it). A single episode's upload a source lists for its whole season is so
 * left out of the season's other episodes once it has been downloaded for any of them.
 */
export async function knownMissing(ref: string | number, season: number | undefined, episode: number | undefined, pick?: number): Promise<boolean> {
  const stem = stemOf(ref, season, episode, pick);
  if (await exists(missingFile(stem))) return true;
  let holds = held.get(stem);
  if (holds === undefined) {
    const buffer = await readFile(downloadFile(String(ref))).catch(() => undefined);
    if (!buffer || !isZip(buffer)) return false;
    try {
      holds = Boolean(selectArchiveEntry(new AdmZip(withOwnNames(buffer)), season, episode, pick));
    } catch {
      return false;
    }
    held.set(stem, holds);
    if (!holds) await writeFile(missingFile(stem), "").catch(() => {});
  }
  return !holds;
}

/**
 * A subtitle file for this episode, downloaded (and taken out of its pack) once. With `language`,
 * the one it is listed under, a file surely written in another language (notWrittenIn) is refused
 * like a pack without the episode: marked missing, so lists leave it out and the next in line serves.
 */
export function getCachedSubtitleFile(
  ref: string | number,
  season: number | undefined,
  episode: number | undefined,
  keys: SourceKeys,
  pick?: number,
  language?: string
): Promise<{ file: string; filename: string }> {
  // One at a time per stored file: two requests for the same episode's file share the work.
  const key = `${stemOf(String(ref), season, episode, pick)}|${language ?? ""}`;
  const running = storing.get(key);
  if (running) return running;
  const job = storeSubtitleFile(ref, season, episode, keys, pick, language).finally(() => storing.delete(key));
  storing.set(key, job);
  return job;
}

/** Episode files being taken out and stored, by their name and the language asked for. */
const storing = new Map<string, Promise<{ file: string; filename: string }>>();

async function storeSubtitleFile(
  ref: string | number,
  season: number | undefined,
  episode: number | undefined,
  keys: SourceKeys,
  pick?: number,
  language?: string
): Promise<{ file: string; filename: string }> {
  const id = String(ref);
  const stored = cachePath("subtitles");
  await mkdir(stored, { recursive: true });

  // Already taken out for this episode: any format will do.
  const cacheStem = stemOf(id, season, episode, pick);
  for (const ext of STORED_FORMATS) {
    const file = path.join(stored, cacheStem + ext);
    if (await exists(file)) return { file, filename: path.basename(file) };
  }

  const buffer = await readFile(await ensureDownloadCached(id, keys));
  const refuseOtherLanguage = async (text: Buffer) => {
    if (!language || !notWrittenIn(decodeSubtitle(text, language), language)) return;
    await writeFile(missingFile(cacheStem), "");
    const other = new Error(`Subtitle ${id} isn't written in ${language}, though listed as it.`);
    // Expected, not a fault: the upload is refused and left out of later lists, as a pack without the episode is.
    other.name = "WrongLanguage";
    throw other;
  };

  // Stored as UTF-8 when it came as UTF-16, so the format check, sync and players all read it.
  if (!isZip(buffer)) {
    const text = utf16ToUtf8(buffer);
    await refuseOtherLanguage(text);
    const file = path.join(stored, cacheStem + sniffExtension(text));
    await writeFileWhole(file, text);
    return { file, filename: path.basename(file) };
  }

  const entry = selectArchiveEntry(new AdmZip(withOwnNames(buffer)), season, episode, pick);
  if (!entry) {
    await writeFile(missingFile(cacheStem), "");
    const notInPack = new Error(`Subtitle ${id} is an archive without S${season}E${episode} in it.`);
    // Expected, not a fault: the pack is refused and left out of later lists (see stats noteError).
    notInPack.name = "EpisodeNotInPack";
    throw notInPack;
  }

  // Packs come from other people's uploads: a file inside that unpacks to more than a subtitle ever is
  // (a zip bomb) is refused before and after unpacking, whatever size it declares.
  if (entry.header.size > MAX_UNPACKED_BYTES) throw new Error(`Subtitle ${id}: the file in the pack is too large to be a subtitle`);
  const data = entry.getData();
  if (data.length > MAX_UNPACKED_BYTES) throw new Error(`Subtitle ${id}: the file in the pack is too large to be a subtitle`);
  const text = utf16ToUtf8(data);
  await refuseOtherLanguage(text);
  const file = path.join(stored, cacheStem + (path.extname(entry.entryName).toLowerCase() || ".srt"));
  await writeFileWhole(file, text);
  return { file, filename: path.basename(entry.entryName) };
}
