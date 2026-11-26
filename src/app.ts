import cors from "cors";
import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accessRoutes, adminWrite, checkLimit, csrfToken, renewSession, requireRole, sessionRoles } from "./access.js";
import { config, DEFAULTS } from "./config.js";
import { passwordOf } from "./installUrls.js";
import { getCachedSubtitleFile, isDownloaded, knownMissing, listedPackHolds, storedSubtitleExt } from "./downloads.js";
import { compareRanked, episodeOnScreen, filterAndRankDubtitles } from "./matching.js";
import { LATE_ALTERNATES, lateAlternates, noteLateAlternates } from "./lateAlternates.js";
import { baseLanguage, filedUnder, forVariant, languageLabel, otherKind } from "./variants.js";
import { addonSubtitles, OFFICIAL_OPENSUBTITLES, openSubtitles, openSubtitlesByHash, openSubtitlesOwnSearchOn, refOf, subdlSubtitles, withHashMatches, withoutCopies } from "./sources.js";
import type { SourceKeys } from "./downloads.js";
import { REGULAR_ENGLISH, configurePathOf, deleteLink, installUrlOf, isPaused, keptLinkSettings, knownLinks, noteLinkToken, openUrl, RAISE_MAX, RAISE_MIN, renameLink, routePath, setPaused, storeSettings, styleFor, type LinkChange, type Profile, type Settings } from "./profile.js";
import { addonPasswordFingerprint, changeSettings, loadSettings, resetSettings } from "./settings.js";
import { checkStep, configurePage, saveConfiguration, testAccount } from "./configure.js";
import { addToAiostreams, entryTimeoutMs, fileWaitFor } from "./aiostreamsAddon.js";
import { kitsuToImdb, seasonMap } from "./ids.js";
import { absoluteEpisode, findCandidateMovies, FIRST_RECORDS, getSubtitlesIn, madeInEnglish, namedRecords } from "./subsource.js";
import { subtitleCatSubtitles, titleOf } from "./subtitlecat.js";
import { animeToshoSubtitles, dubPhaseOf, startEpisodeSearch } from "./animetosho.js";
import { dubReleasesListed, isDubCaptions, tsukihimeAhead, tsukihimeSubtitles } from "./tsukihime.js";
import { aninzbSubtitles } from "./aninzb.js";
import { isAnime, metaOf } from "./cinemeta.js";
import { gestdownSubtitles } from "./gestdown.js";
import { keptSubtitles } from "./kept.js";
import { theSubtitleDbSubtitles } from "./thesubtitledb.js";
import { wyzieSubtitles } from "./wyzie.js";
import { fileOwnStyle, readySigns, signsKept, signsUnderWay, startSigns } from "./signsjob.js";
import { dialogueStyleOf, MAX_MERGED_BYTES, mergeWithSigns } from "./signs.js";
import { laidOut, respaceSongs } from "./respace.js";
import { keptInScreenOrder, readRightToLeft } from "./rtl.js";
import { decodeSubtitle } from "./text.js";
import { languageTitle } from "./langcodes.js";
import { lookOf, toAss, toSrt, withNotice } from "./srt.js";
import { withoutSounds } from "./clean.js";
import { tierName, type QualityTier } from "./quality.js";
import { ADDON_ID, type RankedSubtitle, type SeasonMap, type StremioSubtitleRequest, type SubSourceSubtitle } from "./types.js";
import { isWatched, watching } from "./turns.js";
import { noteViewer, viewerAddress } from "./viewers.js";
import { readingsRef, listFinishing, embeddedLanguages, holdFileLookup, lookupMissed, completeLanguages, holdsFileAtStart, fileDuration, fileHasSubtitles, fileName, hasEnglishVoices, headerUnderWay, fileRef, sameFileRef, scopedRef, firstPassSync, outrunsFile, fallsShortOfFile, captionCues, knownSync, startFileHash, storedFileHash, SYNC_VERSION, syncCaptions, syncedByVoices, syncKey, trackMisfit, type SyncResult, notListed } from "./sync.js";
import { type ActivityDetail, listedRelease, clearActivity, clearErrors, clearLinkActivity, clearLinkErrors, undoClearActivity, undoClearErrors, undoClearLinkActivity, undoClearLinkErrors, count, downloadsToday, noteActivity, noteError, noteLinkKeys, noteLinkLabel, requestContext, scrub, setLinkLabel, statsView } from "./stats.js";
import { serveUi, SOURCE_ICONS, webManifest } from "./ui.js";
import { diagnosticsText } from "./diagnostics.js";
import { sendLogs } from "./logs.js";
import { dashboardPage } from "./statsPage.js";
import { dashboardData, dashboardSettings, settingsStatus } from "./dashboardData.js";
import { anidbNow } from "./anidb.js";
import { parseExtraArgs, parseStremioSubtitleRequest, rawExtraSegment, VIDEO_ID, VIDEO_TYPES } from "./stremio.js";

/** Where links in answers point: PUBLIC_BASE_URL, or the address the request came in on. */
function publicBase(req: Request): string {
  return config.publicBaseUrl ?? `${req.protocol}://${req.get("host")}`;
}

/**
 * The track's language as sent: the language alone ("Spanish"; the dub captions and English CC are
 * "English"), so a player's preferred subtitle language picks it. The status is in the label beside
 * it ("Spanish - Synced · BttrSubs" in a Jellyfin client).
 */
export function sentLanguage(track: { code?: string }): string {
  return track.code ? languageLabel(languageTitle(track.code)) : "English";
}

interface PlayingFile {
  videoId: string;
  type: string;
  filename: string;
}

function downloadUrl(
  baseUrl: string,
  profile: Profile,
  subtitle: RankedSubtitle,
  season?: number,
  episode?: number,
  playing?: PlayingFile,
  lang?: string,
  alts: Array<{ ref: string; at: Array<number | undefined>; pick?: number }> = [],
  ass = false,
  raise?: number,
  look?: string,
  own = false
): string {
  // Signs & songs with English Dub (Settings.signs), and every track in the playing file's own
  // subtitle style (Settings.ownStyle): both for a file being played, and both sent as ASS.
  const signs = Boolean(profile.signs && playing && !lang);
  const fileStyle = Boolean(profile.ownStyle && playing);
  // "subtitle.ass" for a subtitle sent as ASS (Settings.keepAss, a style's look or height, signs or the
  // file's style): players that go by the name read it as ASS.
  const url = new URL(`${profile.prefix}/download/${refOf(subtitle)}/subtitle.${ass || raise || look || signs || fileStyle ? "ass" : "srt"}`, baseUrl);
  if (signs) url.searchParams.set("signs", "1");
  if (fileStyle) url.searchParams.set("filestyle", "1");
  // A style's height and look (Settings.styles), in the link: a changed style is a new link to players.
  // `own`: an upload's own styling comes first (Keep the subtitle's own styling), before the file's
  // style and a look; without it an upload is sent as plain lines.
  if (raise) url.searchParams.set("raise", String(raise));
  if (look) url.searchParams.set("look", look);
  if (own && url.pathname.endsWith(".ass")) url.searchParams.set("own", "1");
  // Sound descriptions taken out (Settings.dropSounds), in the link too: switching it is a new link to players.
  if (profile.dropSounds) url.searchParams.set("sounds", "0");
  // An added addon's subtitle: its own URL, sealed, since it can carry that addon's keys.
  if (subtitle.sealedUrl) url.searchParams.set("src", subtitle.sealedUrl);
  if (lang) url.searchParams.set("lang", lang);
  if (season) url.searchParams.set("season", String(season));
  if (episode) url.searchParams.set("episode", String(episode));
  // Its number within the season or part its name gives, for its file in a pack (see RankedSubtitle.pick).
  if (subtitle.pick !== undefined) url.searchParams.set("pick", String(subtitle.pick));
  if (playing) {
    url.searchParams.set("sv", String(SYNC_VERSION));
    url.searchParams.set("vid", playing.videoId);
    url.searchParams.set("type", playing.type);
    url.searchParams.set("file", playing.filename);
    // "ref@season:episode[:pick],…": tried in order when this subtitle can't be synced to the file.
    if (alts.length) url.searchParams.set("alt", alts.map((a) => `${a.ref}@${a.at[0] ?? ""}:${a.at[1] ?? ""}${a.pick !== undefined ? `:${a.pick}` : ""}`).join(","));
  }
  return url.toString();
}

/**
 * How long a download waits for its sync. Players give up on a subtitle that takes longer than about
 * 10 s and show nothing (a 2160p remux read the slow way: 12 s, and no text). The whole
 * download, fetching the subtitle and trying fallbacks included, stays inside DOWNLOAD_BUDGET_MS from
 * the moment it is asked for; past it, a stand-in is sent and the next request gets the finished sync.
 */
const SYNC_WAIT_MS = 5000;
const DOWNLOAD_BUDGET_MS = 8000;
/** The longest playing file's name (with its size) a download link may carry. */
const MAX_FILE_NAME = 1024;
/**
 * What a player gets in place of a subtitle the sync judged another file's, once no fallback fits
 * either: one line saying so. Its lines are another episode's or another title's, at another's times;
 * shown, they read as a subtitle that is merely late.
 */
/** A download's first line when the playing file couldn't be found, so it isn't timed to it (see withNotice). */
const FILE_NOT_FOUND = "BttrSubs: the file playing isn't in your AIOStreams list any more, so this subtitle isn't timed to it. Picking the stream again usually fixes it.";
/** A line shown for seven seconds at the start of every minute, for four hours: a track picked anywhere in the file says it within the minute. */
const everyMinute = (line: string) =>
  Array.from({ length: 240 }, (_, minute) => {
    const at = (second: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:${String(second).padStart(2, "0")},000`;
    return `${minute + 1}\n${at(1)} --> ${at(8)}\n${line}\n`;
  }).join("\n");
const NOT_THIS_FILE = everyMinute("BttrSubs: no subtitle found for this track fits this file.");
/**
 * What a player gets in place of a subtitle whose source gave no answer in time, once none next in
 * line could be had either: one line saying so, never kept, so picking the track again asks afresh.
 * An error answer shows as an empty track with nothing to say why.
 */
const SOURCE_SILENT = everyMinute("BttrSubs: this subtitle's source didn't answer. Pick this track again in a minute.");
/**
 * How long a download waits for its listed subtitle to arrive from its source before the next in line
 * is asked for: what the budget leaves beside the sync's own wait, so a source that has stopped
 * answering still leaves the others their turn inside the budget.
 */
const FETCH_WAIT_MS = DOWNLOAD_BUDGET_MS - SYNC_WAIT_MS;
/** Downloads bigger than this go gzipped to a player whose request accepts it. */
const GZIP_FROM_BYTES = 256 * 1024;
/**
 * How long English Dub waits for its signs (or the file's own style) still being found when it is asked
 * for: the dub's lines go first. Calibration (a first play whose signs were still being looked for):
 * waiting the whole budget held the dub back 8.1 s.
 */
const STYLE_WAIT_MS = 2000;
/** Fallback candidates kept per other-language track, tried in order when its own subtitle can't be synced. */
const ALTERNATES = 4;
/**
 * A season pack can number its files its own way, so the pack's files this many episodes either side
 * of the one its numbers give stand behind it as fallbacks too, nearest first: where the file named
 * for the episode fits nothing in the playing file, the one whose timing does is taken (the
 * fallbacks' sync), not the numbers. Calibration (11-15): a pack counting a two-part special as its
 * episodes 1 and 2 held the episode as its 6, its other files meeting the file at chance (16-24% of
 * line starts, against 88%).
 */
const PACK_NEIGHBOURS = [1, -1, 2, -2];
/**
 * How long a list's background check of a track listens for its subtitle to fit nothing in the file's
 * subtitle track (trackMisfit) before it simply waits for that subtitle's sync: past a first play's
 * stream lookup and header read, which can take tens of seconds.
 */
const BACKGROUND_SYNC_WAIT_MS = 2 * 60 * 1000;
/**
 * The release match from which a subtitle counts as made for the playing release, for the check of a
 * file's own track against its voices (trackcheck.ts): its group (+3) and its service or source.
 */
const FOR_RELEASE_MATCH = 4;
/**
 * SubDL allows a key 50 downloads a UTC day. Work a list starts (pre-syncing, opening packs, trying
 * fallbacks) may be for an episode nobody plays (AIOMetadata asks ahead for the next one), so once a
 * key is down to its last SUBDL_SPARE downloads, a list fetches nothing new from SubDL: those are kept
 * for subtitles a player asks for. Already downloaded ones cost nothing and are used as before.
 */
const SUBDL_DAILY_DOWNLOADS = 50;
const SUBDL_SPARE = 10;
/**
 * How long a subtitle list may take is config.listBudgetMs (LIST_BUDGET_MS, 8 s unless set): AIOStreams
 * waits 7 s for an addon unless its timeout is raised, and then drops all of it. With the list's grace (FILE_WAIT_MS) a
 * list answers within that budget plus 1.5 s, so the configure page raises that timeout or names it.
 */
/**
 * A player can ask for the next episode's subtitles, with that episode's own file, while the one before
 * it is starting (a preload). Such a list, from the same configuration within AHEAD_MS of that episode's
 * and for a file nobody is watching yet, is asked ahead: its Anime Tosho work waits for the starting
 * episode's (its list's look-up, then its signs), at most AHEAD_WAIT_MS, then goes at the back of the
 * line, since Anime Tosho answers one request at a time. Its file's look-up in AIOStreams waits the
 * same way (holdFileLookup): AIOStreams asks its own indexers for it, Anime Tosho among them. Calibration (a week of lists, 156 of them):
 * 58 next-episode lists began 0.06-97.7 s after the episode's own (median 2.4 s), each with the next
 * episode's file; 13 of those 58 episodes were played afterwards. A next episode played for real
 * comes an episode's length later.
 */
const AHEAD_MS = 120_000;
const AHEAD_WAIT_MS = 30_000;
/** Lists of a playing file being made, by configuration and request id, until they are answered: what a list asked ahead waits for. */
const listsUnderWay = new Map<string, Promise<void>>();
/** Each configuration's newest list of a show's season with a playing file: its episode, request id and file. */
const recentLists = new Map<string, { episode: number; id: string; file: string; at: number; ahead: boolean }>();

/** The list of the episode before this one, when this list is asked ahead for it (see AHEAD_MS); notes this list. */
export function askedAheadOf(link: string, id: string, file: string | undefined, now = Date.now()): { id: string; file: string } | undefined {
  for (const [key, entry] of recentLists) if (now - entry.at >= AHEAD_MS) recentLists.delete(key);
  const m = /^(.+):(\d+)$/.exec(id);
  if (!m || !file) return undefined;
  const key = `${link}|${m[1]}`;
  const episode = Number(m[2]);
  const before = recentLists.get(key);
  // Asked ahead only of an episode that is starting: the one after an episode itself only asked ahead
  // is a jump two episodes on, a play of its own.
  const aheadOf = before && !before.ahead && before.episode === episode - 1 && !isWatched(file, now) ? { id: before.id, file: before.file } : undefined;
  recentLists.set(key, { episode, id, file, at: now, ahead: Boolean(aheadOf) });
  return aheadOf;
}
/**
 * How long before a list's time ends its tracks' syncs get their head start (see the list's pick).
 *
 * Calibration (a week of downloads that had to time their subtitle, 38): half took under 0.8 s, three
 * in four under 1.6 s, nine in ten under 3.3 s. With the list's grace at its default this leaves a sync 3.5 s.
 */
const SYNC_HEAD_START_MS = 2000;
/** Extra wait when even the first windows aren't read yet, before sending the file as it came. */
const SYNC_SLOW_MS = 2500;

/**
 * A track's description: what it is, how it's timed, whether it carries signs, and whose addon it comes
 * from. A player keeps the list it got for the whole play, so the label says only what holds for all of
 * it. synced: true once the track is known to be timed to the playing file; "pending" while that isn't
 * known yet (its sync is still running when the list goes out, or starts with the download), labelled
 * "Auto sync", since "Synced" would claim what a download may not bear out; false when it is known not
 * to sync, or no file is playing. audio: "synced" when the track was timed by speech in the audio;
 * "trying" when the file has no subtitle track and the audio sync is still running, labelled by the
 * method ("Audio sync") rather than a state that would look stuck. signs: signs & songs found for the
 * playing file, sent with this track.
 */
export function trackLabel(code: string | undefined, synced: boolean | "pending", audio?: "synced" | "trying", cc = false, signs = false): string {
  const how = !synced ? undefined : audio === "synced" ? "Synced by audio" : audio === "trying" ? "Audio sync" : synced === "pending" ? "Auto sync" : "Synced";
  // The player shows the language beside the label, so the label doesn't repeat "English".
  return [code ? undefined : cc ? "CC" : "Dub", how, signs ? "Signs" : undefined, "BttrSubs"].filter(Boolean).join(" · ");
}

/**
 * Whether a sync result is good enough to serve or list as synced: anchors found, and not timed by
 * speech alone unless the file has no subtitle track (then speech is all there is, and no alternate
 * can do better) or its track is off the voices that timed it (overTrack: an alternate that fits
 * the track would be off them too). Every place that weighs a subtitle against its fallbacks asks
 * this one question.
 */
export function syncedWell(result: SyncResult | undefined | "late" | "wait" | "misfit" | { alternate: Alternate }): result is SyncResult {
  return typeof result === "object" && "anchors" in result && result.anchors.length > 0 && (!result.bySpeech || result.speechOnly === true || result.overTrack === true);
}

/**
 * A sync, or "misfit" as soon as it is known to fit nothing in the file's own subtitle track
 * (trackMisfit): timed by speech after that, it can't count as synced well (syncedWell), so a search
 * through a track's subtitles goes on to the next one without waiting for that speech read.
 */
function unlessMisfit(job: Promise<SyncResult | undefined>, key: string, withinMs: number): Promise<SyncResult | undefined | "misfit"> {
  return Promise.race([job, trackMisfit(key, withinMs).then((misfit): Promise<SyncResult | undefined | "misfit"> => (misfit ? Promise.resolve("misfit") : job))]);
}

/** At most this long for the title's runtime when a download needs it (it is usually cached by the list). */
const RUNTIME_WAIT_MS = 1500;

/**
 * Whether a subtitle's lines run far past the episode's length (outrunsFile): "certain" by the playing
 * file's length once read; "likely" by the runtime Cinemeta gives the title (an episode's, for a
 * series), known before a first play's header is read. A runtime is a typical episode's, and a
 * double-length one runs past it, so it only decides what stands in, never that a sync is skipped.
 */
async function outrunsEpisode(subtitleFile: string, lang: string | undefined, file: string, vid: string, type: string): Promise<"certain" | "likely" | undefined> {
  try {
    const timeout = <T,>(job: Promise<T>) => Promise.race([job, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), RUNTIME_WAIT_MS).unref())]);
    const lines = async () => captionCues(decodeSubtitle(await readFile(subtitleFile), lang), path.extname(subtitleFile).toLowerCase());
    const length = await fileDuration(file);
    if (length) return outrunsFile(await lines(), length) ? "certain" : undefined;
    const imdb = /^tt\d+/.exec(vid)?.[0] ?? (await timeout(kitsuToImdb(vid).catch(() => undefined)))?.imdbId;
    const runtime = imdb ? (await timeout(metaOf(type, imdb)))?.runtimeMs : undefined;
    return runtime && outrunsFile(await lines(), runtime) ? "likely" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a subtitle's lines end far short of the playing file (fallsShortOfFile), by the file's
 * length once read. Unknown, it isn't judged: a title's runtime can be a typical episode's, and a
 * short episode ends well before it.
 */
async function shortOfFile(subtitleFile: string, lang: string | undefined, file: string): Promise<boolean> {
  try {
    const length = await fileDuration(file);
    return Boolean(length) && fallsShortOfFile(captionCues(decodeSubtitle(await readFile(subtitleFile), lang), path.extname(subtitleFile).toLowerCase()), length);
  } catch {
    return false;
  }
}

/** Whether a subtitle's lines run far past the playing file or end far short of it, by the file's length once read. */
async function missesLength(subtitleFile: string, lang: string | undefined, file: string): Promise<boolean> {
  try {
    const length = await fileDuration(file);
    if (!length) return false;
    const lines = captionCues(decodeSubtitle(await readFile(subtitleFile), lang), path.extname(subtitleFile).toLowerCase());
    return outrunsFile(lines, length) || fallsShortOfFile(lines, length);
  } catch {
    return false;
  }
}

/** A subtitle next in line for a track, synced well to the playing file in place of the listed one. */
interface Alternate {
  ref: string;
  result: SyncResult;
}

/** A route parameter as one string (Express can hand over an array). */
function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** A sync's timing in a few words, for the download log: the method, the median shift, and the move onto the voices. */
/**
 * Anime Tosho's dub captions for an episode, best first: what its look-up keeps (a list's own look-up
 * goes on after the list, so a download a little later finds it kept), else a look-up within `waitMs`.
 * For anime only, as the list asks it (a Kitsu id, or Cinemeta's animation from anime countries).
 */
async function animeToshoFor(videoId: string, type: string, waitMs: number): Promise<SubSourceSubtitle[]> {
  if (type !== "series" || waitMs <= 0) return [];
  const work = (async () => {
    const own = /^(tt\d+):(\d+):(\d+)$/.exec(videoId);
    const mapped = own ? { imdbId: own[1], season: Number(own[2]), episode: Number(own[3]) } : await kitsuToImdb(videoId);
    if (!mapped) return [];
    const request: StremioSubtitleRequest = { type, id: videoId, imdbId: mapped.imdbId, season: mapped.season, episode: mapped.episode };
    const kitsu = videoId.startsWith("kitsu");
    const meta = await metaOf(type, mapped.imdbId);
    if (!kitsu && !isAnime(meta)) return [];
    const [map, counted] = await Promise.all([
      seasonMap(mapped.imdbId, async () => meta?.name ?? (await titleOf("series", mapped.imdbId))?.name).catch(() => undefined),
      mapped.season && mapped.episode
        ? absoluteEpisode(mapped.imdbId, mapped.season, mapped.episode, true).catch(() => undefined)
        : undefined
    ]);
    if (counted !== undefined) request.absoluteEpisode = counted;
    return animeToshoSubtitles(request, meta?.name ?? map?.show, map, { tvdbId: meta?.tvdbId });
  })().catch(() => [] as SubSourceSubtitle[]);
  return Promise.race([work, new Promise<SubSourceSubtitle[]>((resolve) => setTimeout(() => resolve([]), waitMs).unref())]);
}

/** A source's name as the dashboard shows it, from a subtitle's ref. */
function sourceOfRef(ref: string): string {
  if (ref.startsWith("sd")) return "SubDL";
  if (ref.startsWith("os")) return "OpenSubtitles";
  if (ref.startsWith("sc")) return "Subtitle Cat";
  if (ref.startsWith("at")) return "Anime Tosho";
  if (ref.startsWith("th")) return "TsukiHime";
  if (ref.startsWith("az")) return "aninzb";
  if (ref.startsWith("tb")) return "TheSubtitleDB";
  if (ref.startsWith("gd")) return "Gestdown";
  if (ref.startsWith("wz")) return "Wyzie Subs";
  if (ref.startsWith("cx")) return "An added addon";
  if (ref.startsWith("kc")) return "This server";
  return "SubSource";
}

/** How well a sync fits the file: the median of its windows' scores, as a percentage. */
function fitOf(synced: SyncResult): { fit?: number; windows?: number } {
  if (!synced.anchors.length) return {};
  const scores = synced.anchors.map((a) => a.score).sort((a, b) => a - b);
  return { fit: Math.round(scores[scores.length >> 1] * 100), windows: synced.anchors.length };
}

/**
 * The shifts a timing holds, in the file's order: a stretch is a run of windows within STRETCH_APART_MS
 * of each other, given by its middle shift. One stretch for most files; a broadcast's captions on a
 * disc's file have one before the opening song, one after it and one after each break.
 */
export function stretchesOf(anchors: SyncResult["anchors"]): number[] {
  const runs: number[][] = [];
  for (const a of [...anchors].sort((x, y) => x.from - y.from)) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(a.offset - last[last.length - 1]) <= STRETCH_APART_MS) last.push(a.offset);
    else runs.push([a.offset]);
  }
  return runs.map((run) => [...run].sort((x, y) => x - y)[run.length >> 1]);
}

const STRETCH_APART_MS = 1000;
/** Stretches named in the timing's text at most; the rest are counted. */
const STRETCHES_NAMED = 4;

function describeTiming(synced: SyncResult): string {
  if (synced.noFit) return "another file's";
  if (synced.anchors.length === 0) return "no timing found";
  if (synced.asCame) return "as it came: on the voices, where the file's own track isn't";
  const offsets = synced.anchors.map((a) => a.offset).sort((a, b) => a - b);
  const method = synced.byLines ? "line by line" : synced.bySpeech ? "by speech" : synced.byStarts ? "by line starts" : synced.byCover ? "by the moments its lines fill" : synced.factor ? `rate x${synced.factor.toFixed(4)}` : "shift";
  const voiced = synced.reference === "voiced" ? ", by a subtitle on the voices, where the file's own track isn't" : synced.reference === "subtitle" ? ", by a subtitle that fits the file's own track, which this one doesn't" : "";
  const voices = voiced ? voiced : synced.voiceShift !== undefined ? `, voices ${synced.voiceShift >= 0 ? "+" : ""}${synced.voiceShift} ms` : synced.voicesPending ? ", voices pending" : synced.trackCheckPending ? ", track check pending" : "";
  // Several stretches: one middle shift would be the shift of none of them, or of one only.
  const stretches = synced.byLines ? [] : stretchesOf(synced.anchors);
  if (stretches.length > 1) {
    const seconds = (ms: number) => `${ms >= 0 ? "+" : "-"}${(Math.abs(ms) / 1000).toFixed(1)} s`;
    const named = stretches.slice(0, STRETCHES_NAMED).map(seconds).join(", then ");
    return `${method === "shift" ? "" : `${method}, `}${stretches.length} stretches: ${named}${stretches.length > STRETCHES_NAMED ? ", ..." : ""}${voices}`;
  }
  return `${method} ${offsets[offsets.length >> 1] >= 0 ? "+" : ""}${offsets[offsets.length >> 1]} ms${voices}`;
}

/** For the activity detail: what a sync was measured against, the lines it moved, and how far its shifts spread. */
function howTimed(synced: SyncResult): Pick<ActivityDetail, "reference" | "snapped" | "moved" | "spread"> {
  const offsets = synced.anchors.map((a) => a.offset);
  return {
    ...(synced.reference ? { reference: synced.reference } : {}),
    ...(synced.snapped ? { snapped: synced.snapped } : {}),
    ...(synced.moved ? { moved: synced.moved } : {}),
    ...(offsets.length ? { spread: [Math.min(...offsets), Math.max(...offsets)] as [number, number] } : {})
  };
}

/** For the activity detail: the playing file's whole name and size (from its "name/bytes" ref), and the video. */
/** A request's User-Agent as the activity keeps it: printable, at most 80 characters. */
export function clientOf(agent: string | undefined): string | undefined {
  const text = (agent ?? "").replace(/[^\x20-\x7e]/g, "").trim();
  return text ? text.slice(0, 80) : undefined;
}

function playedFile(ref: string, video: string): Pick<ActivityDetail, "file" | "size" | "video"> {
  const size = Number(ref.match(/\/(\d+)$/)?.[1]);
  return { ...(ref ? { file: fileName(ref) } : {}), ...(size > 0 ? { size } : {}), ...(video ? { video } : {}) };
}

function keysOf(profile: Profile): SourceKeys {
  return { subsource: profile.subsourceKey || undefined, subdl: profile.subdlKey, wyzie: profile.wyzieKey };
}

function profileOf(res: Response): Profile | undefined {
  return res.locals.profile as Profile | undefined;
}

const MANIFEST = {
  id: ADDON_ID,
  // One version for the package and the manifest: package.json sits next to src/ and dist/ alike.
  version: (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
  name: "BttrSubs",
  description:
    "Smooth, buttery subtitles, synced better to your file. English dub captions, and the best subtitle in your other languages, from SubSource, SubDL, OpenSubtitles and any subtitle addon you add.",
  resources: [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }],
  types: ["movie", "series"],
  catalogs: []
};

/** A request's subject for the activity list: the file's name when known, short. */
export function describe(filename: string | undefined, fallback: string, season?: number, episode?: number): string {
  let text = filename ? fileName(filename).replace(/\.(mkv|mp4|avi|m4v|webm)$/i, "") : fallback;
  // A file named by a random id ("po0xCP6G") says nothing; the episode goes in front of it.
  const pad = (v: number) => String(v).padStart(2, "0");
  if (filename && season !== undefined && episode !== undefined && !/s\d{1,2}[ ._-]?e\d{1,4}|\d{1,2}x\d{1,3}|(?:^|\D)\d{2,4}(?:\D|$)/i.test(text)) {
    text = `S${pad(season)}E${pad(episode)} · ${text}`;
  }
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
}

/** The configure page's password (ADDON_PASSWORD) and the dashboard's (ADMIN_PASSWORD), when set: see access.ts. */
const configureGate = requireRole("addon");
const statsGate = requireRole("admin");

/**
 * Codes that let a saved configuration be added to its AIOStreams account, by link: a save's answer
 * carries one and Add to AIOStreams sends it back. So the person who saved can add it, and someone
 * who only holds the configuration's install URL can't have its AIOStreams account written to. A
 * code lasts ADD_CODE_MS and is spent once the add has worked; a failed add can be tried again.
 */
const addCodes = new Map<string, { link: string; until: number }>();
const ADD_CODE_MS = 15 * 60 * 1000;

/** A new code for adding this link to its AIOStreams account (and the expired ones gone). */
export function issueAddCode(link: string): string {
  const now = Date.now();
  for (const [code, held] of addCodes) if (held.until <= now) addCodes.delete(code);
  const code = randomBytes(18).toString("base64url");
  addCodes.set(code, { link, until: now + ADD_CODE_MS });
  return code;
}

/** Whether a code was issued for this link and hasn't run out. */
function addCodeFits(link: string, code: string | undefined): boolean {
  const held = code ? addCodes.get(code) : undefined;
  return Boolean(held && held.link === link && held.until > Date.now());
}

/** The link token in an install URL (`…/<token>/manifest.json`). */
const linkOf = (manifestUrl: string) => new URL(manifestUrl).pathname.split("/").at(-2) ?? "";

/** The addon's routes, the same for the owner (/) and for a personal link (/u/<token>/). */
function addonRoutes(): express.Router {
  const router = express.Router({ mergeParams: true });
  // What players and AIOStreams ask for can be read from any site (a player in a browser asks from its
  // own): the manifest, the lists and the downloads. The pages and the dashboard's data can't.
  const anySite = cors();

  // configurable: AIOStreams then shows a Reconfigure button that opens <manifest base>/configure.
  router.get("/manifest.json", anySite, (_req, res) => {
    res.set("Cache-Control", "no-store");
    const configured = Boolean(res.locals.profile);
    const logo = config.publicBaseUrl ? { logo: `${config.publicBaseUrl}/logo.png` } : {};
    res.json({ ...MANIFEST, ...logo, behaviorHints: { configurable: true, configurationRequired: !configured } });
  });

  router.get("/configure", configureGate, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.type("html").send(configurePage(res.locals.settings as Settings | undefined, sessionRoles(req), res.locals.lapsed === true));
  });

  router.post("/configure", configureGate, checkLimit, express.json({ limit: "16kb" }), async (req, res, next) => {
    try {
      const result = await saveConfiguration(req.body ?? {}, res.locals.settings as Settings | undefined);
      res.set("Cache-Control", "no-store");
      if ("error" in result) {
        res.status(400).json(result);
        return;
      }
      count("saves");
      // Editing a link: its new settings are kept under it, and its URL stays the one AIOStreams has.
      const token = res.locals.token as string | undefined;
      if (token && config.publicBaseUrl) {
        // It keeps its id, though the edit may change what the id is worked out from (keptLinkSettings).
        const kept = keptLinkSettings(result.settings, res.locals.settings as Settings | undefined, token);
        storeSettings(token, kept);
        console.log(`configure: link edited in place (${result.settings.languages.length} languages)`);
        // The page can still offer to add it: that also puts an entry made by hand right (its timeout).
        res.json({ manifestUrl: `${config.publicBaseUrl}/${token}/manifest.json`, inPlace: true, timeoutMs: entryTimeoutMs(), ...(kept.aiostreamsPassword ? { canAdd: true, addCode: issueAddCode(token) } : {}) });
        return;
      }
      console.log(`configure: link saved (${(req.body?.languages ?? []).length} languages)`);
      // With the account's password kept, the page can offer to add the URL to AIOStreams itself;
      // for adding it by hand, it names the timeout the entry needs.
      res.json({ manifestUrl: result.manifestUrl, timeoutMs: entryTimeoutMs(), ...(result.settings.aiostreamsPassword ? { canAdd: true, addCode: issueAddCode(linkOf(result.manifestUrl)) } : {}) });
    } catch (error) {
      next(error);
    }
  });

  // One step of the flow, checked before the page moves on: { step, ...the form }.
  router.post("/configure/check", configureGate, checkLimit, express.json({ limit: "16kb" }), async (req, res, next) => {
    try {
      const { step, ...input } = (req.body ?? {}) as { step?: unknown };
      const result = await checkStep(String(step ?? ""), input, res.locals.settings as Settings | undefined);
      res.set("Cache-Control", "no-store");
      res.status("error" in result ? 400 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // The Sync step's checks: the sign-in and what each kind of app needs, part by part.
  router.post("/configure/test", configureGate, checkLimit, express.json({ limit: "16kb" }), async (req, res, next) => {
    try {
      const result = await testAccount(req.body ?? {}, res.locals.settings as Settings | undefined);
      res.set("Cache-Control", "no-store");
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // Adds this configuration to its own AIOStreams account, in place of pasting its install URL there:
  // with the code its save gave (addCodes), never on the install URL alone.
  router.post("/configure/add", configureGate, checkLimit, async (req, res, next) => {
    try {
      const token = res.locals.token as string | undefined;
      res.set("Cache-Control", "no-store");
      if (!token || !config.publicBaseUrl) {
        res.status(400).json({ error: "Save the configuration first" });
        return;
      }
      const code = req.get("X-Add-Code");
      if (!addCodeFits(token, code)) {
        res.status(403).json({ error: "Save the configuration again, then add it to AIOStreams." });
        return;
      }
      const result = await addToAiostreams(res.locals.settings as Settings | undefined, `${config.publicBaseUrl}/${token}/manifest.json`);
      if (!("error" in result)) addCodes.delete(code!);
      if (!("error" in result)) console.log(`configure: link ${result.state === "present" ? "already in" : result.state === "added" ? "added to" : "put right in"} its AIOStreams account`);
      res.status("error" in result ? 400 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  async function subtitlesHandler(req: Request, res: Response): Promise<void> {
    const profile = profileOf(res);
    if (!profile) {
      res.status(404).json({ error: "Configure BttrSubs first" });
      return;
    }
    const who = `[${profile.name}]`;
    // What this list may take past its time: the grace set, as far as the configuration's entry in AIOStreams allows (fileWaitFor).
    const graceSet = fileWaitFor(profile.aiostreamsUrl, profile.aiostreamsUrl ? passwordOf(profile.aiostreamsUrl) : undefined);
    count("lists", 1, profile.name);
    // The extra segment is read from the path as it came, not from the route's decoded parameter.
    const extra = parseExtraArgs(req.params.extra === undefined ? "" : rawExtraSegment(req.path));
    const stremioRequest = parseStremioSubtitleRequest(param(req.params.type), param(req.params.id), extra);
    // Films and series only, as the manifest says: the kind goes on into the stream lookup's address.
    if (!VIDEO_TYPES.includes(stremioRequest.type)) {
      res.set("Cache-Control", "max-age=300");
      res.json({ subtitles: [], cacheMaxAge: 300 });
      return;
    }
    // The viewer's address, for this episode's stream lookups (viewers.ts). Taken from lists, not
    // downloads: a list asked through AIOStreams carries the address AIOStreams keys the viewer's
    // stream list by, and a download can come from a server that fetches subtitles for a player.
    if (profile.aiostreamsUrl) noteViewer(profile.aiostreamsUrl, stremioRequest.id, viewerAddress(req));
    // How often a player sends the file's hash, which subtitles matched to it need.
    if (stremioRequest.videoHash) count("lists.withHash");
    // A link paused on the dashboard still answers, with nothing in it, briefly cached so a resume shows soon.
    if (isPaused(profile.name)) {
      res.locals.activity = { kind: "list", what: describe(stremioRequest.filename, stremioRequest.id, stremioRequest.season, stremioRequest.episode), result: "paused" };
      res.set("Cache-Control", "max-age=60");
      res.json({ subtitles: [], cacheMaxAge: 60 });
      return;
    }

    // The playing file's ref, for this configuration's readings (scopedRef), under the size it was first read at (sameFileRef).
    const playingRef = stremioRequest.filename ? await sameFileRef(scopedRef(profile.aiostreamsUrl, fileRef(stremioRequest.filename, stremioRequest.videoSize))) : undefined;
    /** The grace as it stands: the default once the playing file is known to be in none of AIOStreams' lists (lookupMissed). */
    const grace = () => (playingRef && lookupMissed(playingRef) ? Math.min(graceSet, DEFAULTS.fileWaitMs) : graceSet);
    const aheadOf = askedAheadOf(profile.name, stremioRequest.id, playingRef);
    const listKey = `${profile.name}|${stremioRequest.id}`;
    if (aheadOf && playingRef) {
      console.log(`${who} ${stremioRequest.id}: asked ahead while ${aheadOf.id} starts; its file's and its Anime Tosho look-ups wait behind that one's`);
      // The starting episode's list, then the dub captions and signs it set going: nothing of the next
      // episode's is asked of AIOStreams before, at most AHEAD_WAIT_MS.
      const ended = (work: Promise<unknown> | undefined) => (work ?? Promise.resolve()).then(() => undefined, () => undefined);
      const starting = ended(listsUnderWay.get(`${profile.name}|${aheadOf.id}`)).then(() => Promise.all([ended(dubPhaseOf(aheadOf.id)), ended(signsUnderWay(aheadOf.id, aheadOf.file))]));
      holdFileLookup(playingRef, Promise.race([starting, new Promise((resolve) => setTimeout(resolve, AHEAD_WAIT_MS).unref())]));
    } else if (playingRef) {
      // A kept reading without its picture tracks' languages is completed from the start, so the list knows them in time.
      if (profile.skipEmbedded && profile.aiostreamsUrl) completeLanguages(profile.aiostreamsUrl, stremioRequest.id, stremioRequest.type, playingRef);
      const out = new Promise<void>((resolve) => res.once("close", resolve));
      listsUnderWay.set(listKey, out);
      void out.then(() => {
        if (listsUnderWay.get(listKey) === out) listsUnderWay.delete(listKey);
      });
    }

    // Answer within LIST_BUDGET_MS: AIOStreams gives an addon 7 s and drops all of it after that,
    // and a site seeing an episode for the first time can take longer (OpenSubtitles V3+: 6 to 9 s).
    // Every lookup starts at once and is waited on by itself: whatever isn't back by the deadline is
    // left out of this answer but keeps going, so its results are cached for the next request, and
    // the sources that did answer are listed; a lookup that finds its results one by one (`sofar`)
    // gives those it has. A lookup that fails counts as one that found nothing. A partial answer is
    // cached briefly, so the next request gets the full list.
    const deadline = Date.now() + config.listBudgetMs;
    // From the end of its time to its answer, the list has this thread to itself (listFinishing).
    {
      const sent = new Promise<void>((resolve) => res.once("close", resolve));
      const lastStretch = setTimeout(() => listFinishing(sent), config.listBudgetMs + grace());
      lastStretch.unref();
      void sent.then(() => clearTimeout(lastStretch));
    }
    let partial = false;
    const lateSources = new Set<string>();
    /** Every source the list waited on: how long, how many it gave, and whether it was in time (for diagnostics). */
    const sourcesSeen: NonNullable<ActivityDetail["sources"]> = [];
    // Sources this list had no reason to ask (Anime Tosho, for a title that isn't anime): timed like
    // the rest while that is found out, then left out of what the list records.
    const notAsked = new Set<string>();
    const askedSources = () => sourcesSeen.filter((s) => !notAsked.has(s.name));
    const askedLate = () => [...lateSources].filter((name) => !notAsked.has(name.endsWith(" (partly)") ? name.slice(0, -" (partly)".length) : name));
    /** The playing file, once its header read has started (below): its key for headerUnderWay. */
    let headerFile: string | undefined;
    /**
     * A first list waits for the playing file's header read, up to the list's grace past its deadline:
     * while that read is under way the list isn't going out yet, so a source still answering may too.
     */
    const listStaysOpen = () => (headerFile ? headerUnderWay(headerFile) : undefined);
    /**
     * `work` within the list's time, else what it has so far (`sofar`). `hold`, when it gives a promise
     * at the deadline (something that will add to `sofar` is under way, or the list stays open anyway,
     * the default), lets the list wait for that too, up to the list's grace past the deadline.
     */
    const inTime = <T,>(work: Promise<T>, fallback: T, name?: string, sofar?: () => T, hold: () => Promise<unknown> | undefined = listStaysOpen): Promise<T> => {
      const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now())).unref());
      const askedAt = Date.now();
      // A rejection never reaches the list. Sources log their own failures; anything else that throws
      // (a full disk under the cache, say) is logged here, so a source left out is never left out silently.
      const settled = work.then(
        (value) => ({ value, failed: false }),
        (error: unknown) => {
          console.error(`${who} subtitles: a lookup failed, left out of the list: ${scrub(error instanceof Error ? error.message : String(error))}`);
          return { value: fallback, failed: true };
        }
      );
      const seen = (state: "in time" | "late" | "partly" | "failed", value: unknown) => {
        if (name) sourcesSeen.push({ name, ms: Date.now() - askedAt, ...(Array.isArray(value) ? { got: value.length } : {}), state });
      };
      return Promise.race([settled, late]).then(async (r) => {
        if (r !== "late") {
          seen(r.failed ? "failed" : "in time", r.value);
          return r.value;
        }
        const held = hold();
        if (held) {
          const graceEnds = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, deadline + grace() - Date.now())).unref());
          const after = await Promise.race([settled, held.then(() => "held" as const, () => "held" as const), graceEnds]);
          if (after !== "late" && after !== "held") {
            seen(after.failed ? "failed" : "in time", after.value);
            return after.value;
          }
        }
        partial = true;
        // How long it took in the end, for judging whether a longer budget would have had it.
        if (name) {
          void settled.then((r) => {
            const over = Date.now() - deadline;
            count(over <= 2000 ? "lists.late.within2s" : over <= 5000 ? "lists.late.within5s" : "lists.late.later");
            console.log(`${who} ${stremioRequest.id}: ${name} answered ${Date.now() - askedAt} ms after it was asked, ${over} ms past the list's time${r.failed ? " (failed)" : Array.isArray(r.value) ? ` (${r.value.length} found)` : ""}`);
          });
        }
        const got = sofar?.();
        seen(Array.isArray(got) && got.length ? "partly" : "late", got);
        if (name) lateSources.add(Array.isArray(got) && got.length ? `${name} (partly)` : name);
        return got ?? fallback;
      });
    };

    if (!stremioRequest.imdbId) {
      // Kitsu ids (AIOStreams' Jellyfin server sends them for anime) are mapped to IMDb season/episode.
      // The original id stays as stremioRequest.id, which AIOStreams understands for the sync lookup.
      // A first look-up can take up to 16 s; it goes on after the deadline and is cached for the next ask.
      const mapped = await inTime(kitsuToImdb(stremioRequest.id), undefined, "Kitsu's ids");
      if (mapped) {
        stremioRequest.imdbId = mapped.imdbId;
        stremioRequest.season = mapped.season;
        stremioRequest.episode = mapped.episode;
      }
    }
    if (!stremioRequest.imdbId) {
      // Without an IMDb id the episode can't be placed; a title search would return every pack.
      console.log(`${who} subtitles ${stremioRequest.id}: ${partial ? "its IMDb id isn't known yet (looking it up)" : "no IMDb id for it, skipped"}`);
      const age = partial ? 30 : 300;
      res.set("Cache-Control", `max-age=${age}`);
      res.json({ subtitles: [], cacheMaxAge: age });
      return;
    }
    // The playing file's header (whether it has a subtitle track, and which languages it already has
    // full subtitles in) is read from now on, beside the searches, not after them: on a file nobody
    // has played yet it can take 4 to 6 s, and the list can't wait for it past deadline + grace. A
    // first list answered before it knows lists the file's own languages too.
    if (profile.aiostreamsUrl && stremioRequest.filename) {
      const [aio, file] = [profile.aiostreamsUrl, (playingRef as string)];
      const header = fileHasSubtitles(aio, stremioRequest.id, stremioRequest.type, file, 0).catch(() => undefined);
      headerFile = file;
      // The file's own hash, worked out once in the background for the lists after this one, when the
      // player sends none. Started once the header read is under way, so the two share its stream lookup.
      if (!stremioRequest.videoHash) void header.then(() => startFileHash(aio, stremioRequest.id, stremioRequest.type, file));
    }
    // That hash, from an earlier play, stands in for the player's: the sites are asked with it as a player would.
    const ownHash = !stremioRequest.videoHash && profile.aiostreamsUrl && stremioRequest.filename ? await storedFileHash((playingRef as string)) : undefined;
    if (ownHash) count("lists.ownHash");
    const asked: StremioSubtitleRequest = ownHash ? { ...stremioRequest, videoHash: ownHash.hash, videoSize: String(ownHash.size) } : stremioRequest;
    const key = profile.subsourceKey;
    const keys = keysOf(profile);
    const what = describe(stremioRequest.filename, stremioRequest.id, stremioRequest.season, stremioRequest.episode);
    res.locals.activity = { kind: "list", what, result: "error" };

    // A regional kind (variants.ts) is filled from the language sites file it under, so that one is asked for too.
    const wanted = [...new Set([...(profile.dub ? ["english"] : []), ...profile.extraLanguages.flatMap((l) => [l.name, ...(baseLanguage(l.name) ? [baseLanguage(l.name)!] : [])])])];
    // Regular English (REGULAR_ENGLISH): translated from the original audio. Dub captions follow the dub.
    const regularEnglish = profile.extraLanguages.some((l) => l.name === "english");
    // Counted across seasons: for an anime (a Kitsu id, or Cinemeta's animation from anime countries),
    // by its own run where one Kitsu entry holds it (absoluteEpisode).
    const across = async (imdbId: string, season: number, episode: number) => {
      const kitsu = stremioRequest.id.startsWith("kitsu");
      const meta = kitsu ? undefined : await metaOf("series", imdbId).catch(() => undefined);
      return absoluteEpisode(imdbId, season, episode, kitsu || isAnime(meta));
    };
    const absolute =
      stremioRequest.imdbId && stremioRequest.season && stremioRequest.episode
        ? inTime(across(stremioRequest.imdbId, stremioRequest.season, stremioRequest.episode), undefined, "the episode's numbering")
        : Promise.resolve(undefined);
    // SubSource refusing (a key it no longer accepts, too many calls, an outage) leaves SubSource out of
    // this list, noted once for the dashboard; the other sources are still listed.
    let subsourceNoted = false;
    const subsourceFailed = (error: unknown): never[] => {
      if (!subsourceNoted) {
        subsourceNoted = true;
        noteError("subsource", error);
        console.error(`subsource: search failed: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
      }
      return [];
    };
    const moviesJob = key ? findCandidateMovies(stremioRequest, key).catch(subsourceFailed) : Promise.resolve([]);
    // The show's seasons by their own titles (an anime's Anime Kitsu entries), looked up beside the
    // searches: names like "Show: Second Arc - 03" are read with it, and SubSource's other records are
    // searched too. A first look-up that isn't back by the deadline leaves this list as it would be
    // without one (partial, so it is asked for again soon) and is kept for the next. Anime only (a
    // Kitsu id, or Cinemeta's animation from anime countries): another show's list waits on nothing
    // but Cinemeta's answer, and the addon isn't asked about it.
    const imdbId = stremioRequest.imdbId;
    const kitsuId = stremioRequest.id.startsWith("kitsu");
    const seasonMapJob: Promise<SeasonMap | undefined> =
      stremioRequest.type === "series" && stremioRequest.episode !== undefined
        ? (async () => {
            const meta = kitsuId ? undefined : await metaOf("series", imdbId);
            // Only anime has one: for any other show nothing is asked, and the list doesn't show it as asked.
            if (!kitsuId && !isAnime(meta)) {
              notAsked.add("the season map");
              return undefined;
            }
            return seasonMap(imdbId, async () => meta?.name ?? (await titleOf("series", imdbId))?.name);
          })().catch(() => undefined)
        : Promise.resolve(undefined);
    const seasons = inTime(seasonMapJob, undefined, "the season map");
    // Made in English: there's no dub to caption, so the best English subtitle is the
    // one. Anime (Kitsu ids too) and other foreign titles, or unknown: dub captions come first.
    const englishJob = inTime<boolean | undefined>(
      profile.dub && stremioRequest.imdbId && !stremioRequest.id.startsWith("kitsu") ? madeInEnglish(stremioRequest.type, stremioRequest.imdbId) : Promise.resolve(false),
      undefined,
      "Cinemeta"
    );
    /** Where signs for the playing file are timed through (Settings.signs), and whether Anime Tosho's dub captions are asked for. */
    const signsThrough = profile.signs ? profile.aiostreamsUrl : undefined;
    const signsFromTsukihime = Boolean(profile.tsukihime);
    const toshoCaptions = profile.animetosho;
    /** Anime Tosho is asked about anime only: a Kitsu id, a show with a season map, or Cinemeta's animation from anime countries. */
    async function animeToshoJob(found: SubSourceSubtitle[]) {
      // Its own copy, taken before any wait: the list's request is changed later (its absolute episode
      // is set once known), at a moment this job can't see. The absolute episode is waited for here instead.
      const request = { ...stremioRequest };
      // The episode's search goes out as soon as Cinemeta says the show is anime, beside the season
      // map's own look-up, instead of after it: on a show's first look, that look-up is about a second.
      const metaJob = metaOf(request.type, imdbId);
      // A list asked ahead (aheadOf) asks nothing before the starting episode's look-up is done.
      if (!aheadOf) void metaJob.then((meta) => (request.id.startsWith("kitsu") || isAnime(meta) ? startEpisodeSearch(request, meta?.tvdbId, "first", meta?.name) : undefined)).catch(() => undefined);
      const [meta, map, counted] = await Promise.all([metaJob, seasonMapJob, absolute]);
      if (counted !== undefined) request.absoluteEpisode = counted;
      if (!map && !request.id.startsWith("kitsu") && !isAnime(meta)) {
        notAsked.add("Anime Tosho");
        return [];
      }
      if (aheadOf) {
        const settled = (work: Promise<unknown> | undefined) => (work ?? Promise.resolve()).then(() => undefined, () => undefined);
        await Promise.race([
          Promise.all([settled(dubPhaseOf(aheadOf.id)), settled(signsUnderWay(aheadOf.id, aheadOf.file))]),
          new Promise((resolve) => setTimeout(resolve, AHEAD_WAIT_MS).unref())
        ]);
      }
      // Signs & songs for the file being played (Settings.signs): found and timed in the background,
      // for English Dub's download to take.
      // The dub captions' look-up starts first: the signs' search waits for its own searches and reads.
      const dubJob = toshoCaptions
        ? animeToshoSubtitles(request, meta?.name ?? map?.show, map, { found, tvdbId: meta?.tvdbId, opening: toshoOpening, listWaitMs: Math.max(0, deadline + grace() - Date.now()), ahead: Boolean(aheadOf) })
        : Promise.resolve([]);
      if (signsThrough && request.filename) {
        startSigns({ request, show: meta?.name ?? map?.show, map, tvdbId: meta?.tvdbId, aiostreamsUrl: signsThrough, videoId: request.id, type: request.type, filename: (playingRef as string), ahead: Boolean(aheadOf), tsukihime: signsFromTsukihime });
      }
      if (!toshoCaptions) return [];
      const all = await dubJob;
      if (all.length) noteFirstTosho();
      // A show with dub releases there: the next episode is looked into now, so its first list has them.
      // Its own count across the show isn't known, so this one's isn't carried over.
      const next = /^(tt\d+):(\d+):(\d+)$/.exec(request.id);
      if (all.length && next && !aheadOf) {
        const episode = Number(next[3]) + 1;
        const ahead = { ...request, id: `${next[1]}:${next[2]}:${episode}`, episode, absoluteEpisode: undefined, filename: undefined, videoHash: undefined, videoSize: undefined };
        void animeToshoSubtitles(ahead, meta?.name ?? map?.show, map, { tvdbId: meta?.tvdbId, ahead: true }).catch(() => undefined);
      }
      return all;
    }
    /** A source of anime releases' own tracks (tsukihime.ts, aninzb.ts): asked about anime only, as Anime Tosho is, and for every language picked. */
    async function releaseTracksJob(name: string, ask: typeof tsukihimeSubtitles): Promise<SubSourceSubtitle[]> {
      const request = { ...stremioRequest };
      const [meta, map, counted] = await Promise.all([metaOf(request.type, imdbId), seasonMapJob, absolute]);
      if (counted !== undefined) request.absoluteEpisode = counted;
      if (!map && !request.id.startsWith("kitsu") && !isAnime(meta)) {
        notAsked.add(name);
        return [];
      }
      return ask(request, meta?.name ?? map?.show, wanted);
    }
    // Anime Tosho's tracks as each release is read: a list that can't wait for the rest has these.
    const toshoFound: SubSourceSubtitle[] = [];
    // When its first dub track comes in, against the list's time: once a list, however it comes (a
    // release read while the look-up goes on, or the look-up's own answer).
    let toshoFirstNoted = false;
    const noteFirstTosho = () => {
      if (toshoFirstNoted) return;
      toshoFirstNoted = true;
      const over = Date.now() - deadline;
      count(over <= 0 ? "lists.toshoFirst.inTime" : over <= 2000 ? "lists.toshoFirst.within2s" : over <= 5000 ? "lists.toshoFirst.within5s" : "lists.toshoFirst.later");
      console.log(`${who} ${stremioRequest.id}: Anime Tosho's first dub track came ${Date.now() - (deadline - config.listBudgetMs)} ms after the list began, ${over <= 0 ? `${-over} ms inside its time` : `${over} ms past its time`}`);
    };
    const addFound = toshoFound.push.bind(toshoFound);
    toshoFound.push = (...tracks: SubSourceSubtitle[]) => {
      if (tracks.length) noteFirstTosho();
      return addFound(...tracks);
    };
    // The reads of releases its episode search found, under way: while there's one, a dub track is on
    // its way, and the list waits for it a little past its deadline (inTime's hold).
    const toshoOpening = new Set<Promise<unknown>>();
    // The other sources are asked once for every language this person wants, each waited on by itself.
    // What each answers in the end is kept too: one that misses the list still gives its subtitles to
    // the list's tracks as fallbacks (lateAlternates.ts).
    const answers: Array<{ name: string; found: Promise<SubSourceSubtitle[]> }> = [];
    /** Every one of them as it was asked: what each has answered so far is what the syncs' head start picks from (pick). */
    const lookups: Array<{ work: Promise<SubSourceSubtitle[]>; sofar?: () => SubSourceSubtitle[]; openSubtitles?: boolean; lastResort?: boolean }> = [];
    const noted = (work: Promise<SubSourceSubtitle[]>, sofar?: () => SubSourceSubtitle[]): Promise<SubSourceSubtitle[]> => {
      lookups.push({ work, sofar });
      return work;
    };
    const source = (work: Promise<SubSourceSubtitle[]>, name: string): Promise<SubSourceSubtitle[]> => {
      answers.push({ name, found: work.catch(() => []) });
      lookups.push({ work, openSubtitles: name === "OpenSubtitles" });
      return inTime(work, [], name);
    };
    // TsukiHime holds Anime Tosho's archive and answers in about a second, where that feed takes a
    // request every few: once it has given the dub's captions the list has them, and stops waiting
    // for Anime Tosho with what that has found so far. Anime Tosho's look-up goes on behind the list.
    // The same when its list of the episode holds no release that could have them (dubReleasesListed).
    let dubReleases: number | undefined;
    if (profile.tsukihime) tsukihimeAhead(stremioRequest);
    const tsukihimeWork = profile.tsukihime
      ? releaseTracksJob("TsukiHime", async (request, show, languages) => {
          const got = await tsukihimeSubtitles(request, show, languages);
          dubReleases = await dubReleasesListed(request).catch(() => undefined);
          return got;
        })
      : undefined;
    // Subtitle Cat is searched by name alone and is there for what the indexed sources lack
    // (subtitlecat.ts): once every one of those has answered and each language asked for has a
    // subtitle from them, the list goes on without it (coveredHere, below). What it finds after that
    // stands behind the list's tracks like any late source's (answers).
    let coveredHere: () => void = () => {};
    const covered = new Promise<void>((resolve) => (coveredHere = resolve));
    let catLeft = false;
    const lastResort = (work: Promise<SubSourceSubtitle[]>, name: string): Promise<SubSourceSubtitle[]> => {
      answers.push({ name, found: work.catch(() => []) });
      const forList = Promise.race([work, covered.then((): SubSourceSubtitle[] => ((catLeft = true), []))]);
      lookups.push({ work: forList, lastResort: true });
      return inTime(forList, [], name).then((got) => {
        if (catLeft) {
          const seen = sourcesSeen.find((source) => source.name === name);
          if (seen) seen.state = "late";
          count("lists.lastResortLeft");
        }
        return got;
      });
    };
    let captionsHere: () => void = () => {};
    const captionsIn = new Promise<void>((resolve) => (captionsHere = resolve));
    void tsukihimeWork?.then((got) => (got.some(isDubCaptions) || dubReleases === 0 ? captionsHere() : undefined), () => undefined);
    // A playing file with no English voices is listed no dub captions (pick): once its header says so,
    // there is nothing of Anime Tosho's this list would use, and it waits for none.
    if (headerFile) void hasEnglishVoices(headerFile, Math.max(0, deadline - Date.now())).then((voices) => (voices === false ? captionsHere() : undefined), () => undefined);
    const othersJob = Promise.all([
      profile.subdlKey ? source(subdlSubtitles(profile.subdlKey, stremioRequest, wanted), "SubDL") : Promise.resolve([]),
      // Wyzie relays OpenSubtitles too: left out of its answer when OpenSubtitles is listed from its own search.
      profile.wyzieKey ? source(wyzieSubtitles(profile.wyzieKey, stremioRequest, wanted, Boolean(profile.opensubtitles) && openSubtitlesOwnSearchOn()), "Wyzie Subs") : Promise.resolve([]),
      profile.opensubtitles ? source(openSubtitles(asked, wanted, profile.allowMachine), "OpenSubtitles") : Promise.resolve([]),
      profile.subtitlecat ? lastResort(subtitleCatSubtitles(stremioRequest, wanted), "Subtitle Cat") : Promise.resolve([]),
      profile.thesubtitledb ? source(theSubtitleDbSubtitles(stremioRequest, wanted), "TheSubtitleDB") : Promise.resolve([]),
      profile.gestdown ? source(gestdownSubtitles(stremioRequest, wanted), "Gestdown") : Promise.resolve([]),
      // Subtitles the operator keeps on this server (kept.ts): a folder read, for every configuration.
      inTime(noted(keptSubtitles(stremioRequest, wanted)), [], "this server's kept subtitles"),
      // Dub captions from anime releases' own tracks (animetosho.ts): anime only, when dub captions are wanted.
      profile.dub && (profile.animetosho || profile.signs)
        ? inTime(Promise.race([noted(animeToshoJob(toshoFound), () => [...toshoFound]), captionsIn.then(() => [...toshoFound])]), [], "Anime Tosho", () => [...toshoFound], () => {
            // Its releases being read, and the list staying open for the header, whichever ends later.
            const reading = toshoOpening.size ? Promise.allSettled([...toshoOpening]) : undefined;
            const open = listStaysOpen();
            return reading || open ? Promise.all([reading, open]) : undefined;
          })
        : Promise.resolve([]),
      // Anime releases' own subtitle tracks, in every language picked (tsukihime.ts): anime only.
      tsukihimeWork ? source(tsukihimeWork, "TsukiHime") : Promise.resolve([]),
      profile.aninzb ? source(releaseTracksJob("aninzb", aninzbSubtitles), "aninzb") : Promise.resolve([]),
      ...profile.addons.map((addon) => inTime(noted(addonSubtitles(addon, asked, wanted)), [], "an added addon"))
    ]);
    // Subtitles matched to the file's hash, when there is one (unless that addon is added already),
    // asked beside the others and folded into OpenSubtitles V3+'s list (withHashMatches).
    const byHashWork = profile.opensubtitles && asked.videoHash && !profile.addons.some((a) => a.url === OFFICIAL_OPENSUBTITLES.url) ? openSubtitlesByHash(asked, wanted) : undefined;
    const byHashJob = byHashWork ? inTime(byHashWork, [], "OpenSubtitles by hash") : Promise.resolve([]);
    /**
     * SubSource's lists in one language, one per record in order (season, whole series, season 1),
     * fetched side by side: the first FIRST_RECORDS for every series, the others of the show only once
     * its season map is known (they're of use only read by title).
     */
    // Records filed under the season's own name (namedRecords), looked for once the season map is known.
    const namedJob = Promise.all([moviesJob, seasonMapJob]).then(([movies, map]) => (key && map ? namedRecords(stremioRequest, map, key, movies).catch(subsourceFailed) : []));
    const subsourceIn = (language: string) => {
      const listOf = async (movie: Awaited<typeof moviesJob>[number]) =>
        (await getSubtitlesIn(movie.movieId, language, key).catch(subsourceFailed)).map((subtitle) => ({ ...subtitle, recordSeason: movie.season ?? undefined }));
      const first = moviesJob.then((movies) => Promise.all(movies.slice(0, FIRST_RECORDS).map(listOf)));
      const more = Promise.all([moviesJob, seasonMapJob]).then(([movies, map]) => (map ? Promise.all(movies.slice(FIRST_RECORDS).map(listOf)) : []));
      const named = namedJob.then((records) =>
        Promise.all(
          records.map(async (record) =>
            (await getSubtitlesIn(record.movieId, language, key).catch(subsourceFailed)).map((subtitle) => ({ ...subtitle, namedRecord: record.type === "movie" ? ("film" as const) : ("series" as const) }))
          )
        )
      );
      return { first, more, named };
    };
    // Each language's SubSource lookup starts now too, so they run side by side.
    const subsourceJobs = new Map(wanted.map((language) => [language, subsourceIn(language)] as const));

    stremioRequest.absoluteEpisode = await absolute;
    // The playing file's own number, when its name gives one near this count: the subtitle follows the
    // file on screen (episodeOnScreen), within the reach a pack's neighbours already cover.
    const onScreen = episodeOnScreen(stremioRequest.filename, stremioRequest.absoluteEpisode, Math.max(...PACK_NEIGHBOURS.map(Math.abs)));
    if (onScreen !== undefined && onScreen !== stremioRequest.absoluteEpisode) {
      count("lists.episodeOnScreen");
      console.log(`${who} ${stremioRequest.id}: the file names episode ${onScreen}, not ${stremioRequest.absoluteEpisode}: going by the file`);
      stremioRequest.absoluteEpisode = onScreen;
    }
    type RankOptions = Parameters<typeof filterAndRankDubtitles>[2];
    /**
     * What a pick of the list's tracks goes by: every source's answer as far as it waits for it. The
     * list's own pick waits out the list's time (inTime); the head start's takes what has answered.
     */
    type PickView = {
      /** The sources other than SubSource: their subtitles filed under a language. */
      others: (language: string) => SubSourceSubtitle[];
      wait: <T>(work: Promise<T>, fallback: T, name?: string) => Promise<T>;
      map: Promise<SeasonMap | undefined>;
    };
    /** Every source's candidates in one language, ranked together. */
    const pool = async (language: string, options: RankOptions, view: PickView): Promise<RankedSubtitle[]> => {
      const map = await view.map;
      // SubSource has one list a language: a kind reads the list of the language it is filed under.
      const job = subsourceJobs.get(baseLanguage(language) ?? language);
      // A record named for this very season comes first: its names say the season outright.
      const lists = job
        ? [...(map ? await view.wait(job.named, [], `SubSource ${language}, by the season's name`) : []), ...(await view.wait(job.first, [], `SubSource ${language}`)), ...(map ? await view.wait(job.more, [], `SubSource ${language}, more records`) : [])]
        : [];
      // SubSource: the first record (in order) that has any for this episode, as before.
      let fromSubSource: RankedSubtitle[] = [];
      for (const list of lists) {
        fromSubSource = filterAndRankDubtitles(list, stremioRequest, { ...options, seasonMap: map });
        if (fromSubSource.length > 0) break;
      }
      return forVariant([...fromSubSource, ...filterAndRankDubtitles(view.others(language), stremioRequest, { ...options, seasonMap: map })].sort(compareRanked), language);
    };

    const place = (subtitle: RankedSubtitle) =>
      subtitle.absoluteNumbered && stremioRequest.absoluteEpisode
        ? [1, subtitle.packEpisode ?? stremioRequest.absoluteEpisode]
        : [stremioRequest.season, subtitle.packEpisode ?? stremioRequest.episode];
    /** A pack's files for the episodes next to the one its numbers give, as fallbacks (PACK_NEIGHBOURS). */
    const packNeighbours = (subtitle: RankedSubtitle): RankedSubtitle[] => {
      // A pick already names its file by the pack's own count (a part's pack).
      if ((subtitle.files ?? 0) < 2 || subtitle.sealedUrl || subtitle.pick !== undefined) return [];
      const base = place(subtitle)[1];
      if (base === undefined) return [];
      return PACK_NEIGHBOURS.map((k) => base + k)
        .filter((n) => n >= 1)
        .map((n) => ({ ...subtitle, packEpisode: n }));
    };
    /**
     * Whether a subtitle is known not to hold this place: its pack's listed files have none a download
     * would take (listedPackHolds), or it was opened and had none (knownMissing).
     */
    const lacks = async (subtitle: RankedSubtitle, season: number | undefined, episode: number | undefined): Promise<boolean> =>
      Boolean(subtitle.packFiles?.length && episode && !listedPackHolds(subtitle.packFiles, season, episode, subtitle.pick)) ||
      (await knownMissing(refOf(subtitle), season, episode, subtitle.pick));
    /** Leaves out packs known not to hold this episode (a "season pack" holding only episode 1). */
    const notKnownMissing = async (subtitles: RankedSubtitle[]) => {
      const missing = await Promise.all(subtitles.map((s) => lacks(s, place(s)[0], place(s)[1])));
      return subtitles.filter((_, i) => !missing[i]);
    };
    // The wait on Anime Tosho is for the dub's captions. Once any source has given the list some that
    // the pick keeps (told as it tells them, and not a pack known to lack the episode), the list has
    // what it waited for and waits no longer (captionsIn): a release's own track found after that is
    // kept for the next list.
    {
      const dubIn = async (rows: SubSourceSubtitle[]) => {
        const english = rows.filter((sub) => filedUnder(sub, "english"));
        if (english.length === 0) return;
        const map = await seasonMapJob.catch(() => undefined);
        if ((await notKnownMissing(filterAndRankDubtitles(english, stremioRequest, { allowMachine: profile.allowMachine, seasonMap: map }))).length > 0) captionsHere();
      };
      for (const lookup of lookups) if (!lookup.sofar && !lookup.lastResort) void lookup.work.then(dubIn).catch(() => undefined);
      const listed = subsourceJobs.get("english");
      if (listed) for (const lists of [listed.first, listed.more, listed.named]) void lists.then((all) => dubIn(all.flat())).catch(() => undefined);
    }
    // How many each language lists: what the configuration asks for, within what the server allows.
    // The ones not listed still stand behind the listed ones as fallbacks. English CC lists one.
    const perLanguage = Math.max(1, Math.min(profile.perLanguage, config.maxPerLanguage));
    /**
     * The list's tracks from what a view holds: the dub captions (or the official English CC standing
     * in for them), each other language's best, and what stands behind each. `facts`: whether the
     * title was made in English and whether the playing file has English voices, asked for once the
     * other languages' lookups are under way.
     */
    const pick = async (view: PickView, facts: () => Promise<{ englishOriginal: boolean; englishVoices: boolean | undefined }>) => {
      // English Dub: subtitles tagged as dub captions, from any source. Other languages at the same time.
      const extraLists = Promise.all(
        profile.extraLanguages.map(async (language) => {
          const found = await pool(language.name, { requireDub: false, allowMachine: profile.allowMachine, hearingImpaired: profile.hearingImpaired }, view);
          if (language.name !== "english") return found;
          // Regular English never serves dub captions: those follow the English voices, not the original audio.
          const dubTagged = new Set((await pool("english", { allowMachine: true }, view)).map((s) => refOf(s)));
          return found.filter((s) => !dubTagged.has(refOf(s)));
        })
      );
      const { englishOriginal, englishVoices } = await facts();
      // Dub captions follow English voices: a playing file whose audio is all in another language (an
      // anime's original-language release) gets the regular English instead, like any other language,
      // and none when it carries its own.
      const dubbed = profile.dub && !englishOriginal && englishVoices !== false;
      // Dub captions known not to be in their pack don't count, so the English CC and regular English
      // fallbacks below get their turn instead of the episode listing nothing.
      let ranked: RankedSubtitle[] = dubbed ? await notKnownMissing(await pool("english", { allowMachine: profile.allowMachine }, view)) : [];

      // No dub captions tagged as such: fall back to an official English hearing-impaired track
      // (Netflix and the like), whose "English (CC)" usually transcribes the dub. Marked "English CC".
      // One is listed; the other official ones stand behind it as its fallbacks.
      let closedCaptions = false;
      if (dubbed && ranked.length === 0) {
        const cc = (await notKnownMissing(await pool("english", { requireDub: false, allowMachine: false, hearingImpaired: "only" }, view))).filter((sub) => sub.quality === 3);
        if (cc.length > 0) {
          ranked = cc;
          closedCaptions = true;
        }
      }
      const dubListed = ranked.slice(0, closedCaptions ? 1 : perLanguage);
      // Behind the dub captions stand the other English subtitles that write down what is said, best first:
      // whether dub captions are listed says nothing of whether they fit the file (a pack's file for an
      // episode can be another episode's). First the closed captions that aren't tagged as the dub's (on a
      // file with English voices, what is said is the dub), then the subtitles made for a release named as a
      // dub, which are tied to that release's cut. Each is timed like any dub captions.
      const standIns: RankedSubtitle[] = [];
      if (dubbed) {
        const captions = await notKnownMissing(await pool("english", { requireDub: false, allowMachine: false, hearingImpaired: "only" }, view));
        const forDubs = await notKnownMissing(await pool("english", { allowMachine: false, releaseDub: true }, view));
        for (const sub of [...captions, ...forDubs]) if (![...ranked, ...standIns].some((r) => refOf(r) === refOf(sub))) standIns.push(sub);
      }

      // Other languages: the best subtitle for the episode in each, from any source.
      // Each also keeps its next two candidates: when the best one can't be synced to the file, the
      // first fallback that syncs is used instead.
      const extras: Array<{ subtitle: RankedSubtitle; lang: string; alts: RankedSubtitle[] }> = [];
      (await extraLists).forEach((found, i) => {
        const per = perLanguage;
        // Fallbacks from added addons are left out: their download needs a sealed address of its own.
        const alts = found.slice(per).filter((s) => !s.sealedUrl).slice(0, ALTERNATES);
        extras.push(...found.slice(0, per).map((subtitle) => ({ subtitle, lang: profile.extraLanguages[i].code, alts: [...alts, ...packNeighbours(subtitle)] })));
      });

      // The best regular English subtitle: the English track for titles made in English, and the last
      // fallback for the rest (no dub captions, no official CC). Shown as plain English, synced like the
      // other languages, never as dub captions.
      if (profile.dub && ranked.length === 0 && !regularEnglish) {
        let plain = await notKnownMissing(await pool("english", { requireDub: false, allowMachine: profile.allowMachine, hearingImpaired: profile.hearingImpaired }, view));
        // A file without English voices takes no dub captions here either.
        if (englishVoices === false) {
          const dubTagged = new Set((await pool("english", { allowMachine: true }, view)).map((s) => refOf(s)));
          plain = plain.filter((s) => !dubTagged.has(refOf(s)));
        }
        if (plain[0]) extras.unshift({ subtitle: plain[0], lang: "English", alts: [...plain.slice(1).filter((s) => !s.sealedUrl).slice(0, ALTERNATES), ...packNeighbours(plain[0])] });
      }
      return { ranked, closedCaptions, dubListed, extras, dubbed, standIns };
    };
    const playing: PlayingFile | undefined =
      profile.aiostreamsUrl && stremioRequest.filename && stremioRequest.imdbId
        ? { videoId: stremioRequest.id, type: stremioRequest.type, filename: (playingRef as string) }
        : undefined;
    /** Whether work this list starts may fetch this subtitle now (see SUBDL_SPARE). */
    const listMayFetch = async (subtitle: RankedSubtitle): Promise<boolean> => {
      if (!refOf(subtitle).startsWith("sd") || !profile.subdlKey) return true;
      if (downloadsToday("subdl", profile.subdlKey) < SUBDL_DAILY_DOWNLOADS - SUBDL_SPARE) return true;
      if (await isDownloaded(refOf(subtitle))) return true;
      count("tracks.subdlSpared");
      return false;
    };
    /** Starts the sync of one subtitle to the playing file, or joins the one running. */
    const syncOne = (subtitle: RankedSubtitle, season: number | undefined, episode: number | undefined, code: string | undefined): Promise<SyncResult | undefined> =>
      playing && profile.aiostreamsUrl
        ? syncCaptions(
            syncKey(refOf(subtitle), season, episode, playing.filename, subtitle.pick),
            () => getCachedSubtitleFile(refOf(subtitle), season, episode, { ...keys, addonUrl: subtitle.sealedUrl ? openUrl(subtitle.sealedUrl) : undefined }, subtitle.pick, subtitle.language),
            profile.aiostreamsUrl,
            playing.videoId,
            playing.type,
            playing.filename,
            code,
            // Named for the playing release by its group and its service or source (releaseMatch).
            { forRelease: (subtitle.releaseMatch ?? 0) >= FOR_RELEASE_MATCH }
          ).catch(() => undefined)
        : Promise.resolve(undefined);

    // Whether the indexed sources cover the list (covered): each has answered, and every language
    // asked for has a subtitle of theirs for this episode that isn't known to be missing from its
    // pack; the dub's captions too where they are asked for.
    if (profile.subtitlecat) {
      void (async () => {
        const settled = (work: Promise<unknown>) => work.then(() => undefined, () => undefined);
        const indexed = lookups.filter((lookup) => !lookup.sofar && !lookup.lastResort);
        await Promise.all([...indexed.map((lookup) => settled(lookup.work)), ...[...subsourceJobs.values()].flatMap((job) => [settled(job.first), settled(job.more), settled(job.named)]), settled(seasonMapJob)]);
        const all = withoutCopies((await Promise.all(indexed.map((lookup) => lookup.work.catch((): SubSourceSubtitle[] => [])))).flat());
        const view: PickView = { others: (language) => all.filter((sub) => filedUnder(sub, language)), wait: (work, fallback) => work.catch(() => fallback), map: seasonMapJob };
        for (const language of profile.extraLanguages) {
          if ((await notKnownMissing(await pool(language.name, { requireDub: false, allowMachine: profile.allowMachine, hearingImpaired: profile.hearingImpaired }, view))).length === 0) return;
        }
        // The dub's captions are listed for a title made in another language, on a file with English
        // voices: where the file is known to have none, its place is the regular English's.
        if (profile.dub && (await englishJob) !== true) {
          const voices = playing ? await hasEnglishVoices(playing.filename, 0).catch(() => undefined) : undefined;
          const english = voices === false ? await pool("english", { requireDub: false, allowMachine: profile.allowMachine, hearingImpaired: profile.hearingImpaired }, view) : await pool("english", { allowMachine: profile.allowMachine }, view);
          if ((await notKnownMissing(english)).length === 0) return;
        }
        coveredHere();
      })().catch(() => undefined);
    }

    /**
     * A head start for the syncs. The list picks its tracks only once every source has answered or its
     * time is up, so one slow source leaves the syncs no time and every track says "Auto sync" on a
     * file whose timing takes a second. SYNC_HEAD_START_MS before the list's time ends, the tracks are
     * picked from what has answered by then, the same way the list picks them, and their syncs are
     * started. The list's own pick, made at the end, finds those syncs done or under way (one job a
     * subtitle and file); a track a late source changes is synced from there. Nothing the list sends
     * waits for this, and only a file known to have a subtitle track gets it.
     */
    let pickedAt: number | undefined;
    let numbered = false;
    if (playing && profile.aiostreamsUrl) {
      const aio = profile.aiostreamsUrl;
      void (async () => {
        // Sooner where nothing is left to wait for but a source that gives what it finds as it goes
        // (`sofar`): every other source, the title's facts and the file's header are in, so the pick
        // made now is the one made at that moment, and the syncs get the seconds in between.
        const settled = (work: Promise<unknown>) => work.then(() => undefined, () => undefined);
        const ready = Promise.all([
          ...lookups.filter((lookup) => !lookup.sofar).map((lookup) => settled(lookup.work)),
          ...[...subsourceJobs.values()].flatMap((job) => [settled(job.first), settled(job.more), settled(job.named)]),
          settled(seasons),
          settled(englishJob),
          ...(byHashWork ? [settled(byHashWork)] : [])
        ]).then(() => fileHasSubtitles(aio, playing.videoId, playing.type, playing.filename, Math.max(0, deadline - SYNC_HEAD_START_MS - Date.now())).catch(() => undefined));
        await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - SYNC_HEAD_START_MS - Date.now())).unref())]);
        // Every source answered before this: the list's own pick is made, and its syncs have the time.
        if (pickedAt !== undefined || !numbered) return;
        if ((await fileHasSubtitles(aio, playing.videoId, playing.type, playing.filename, 0).catch(() => undefined)) !== true) return;
        const NOT_YET = Symbol("not yet");
        /** A lookup's answer if it has one already, else `fallback`: never waited for. */
        const already = <T,>(work: Promise<T>, fallback: T): Promise<T> =>
          Promise.race([work, Promise.resolve(NOT_YET)]).then((got) => (got === NOT_YET ? fallback : (got as T)), () => fallback);
        // Whether the title was made in English decides which tracks are dub captions: not known yet, no head start.
        const english = await already<boolean | undefined | typeof NOT_YET>(englishJob, NOT_YET);
        if (profile.dub && english === NOT_YET) return;
        const sofar = await Promise.all(lookups.map(async (lookup) => ({ ...lookup, answered: (await already<unknown>(lookup.work, NOT_YET)) !== NOT_YET, got: await already(lookup.work, lookup.sofar?.() ?? []) })));
        const byHash = byHashWork ? await already(byHashWork, []) : [];
        const all = withoutCopies(sofar.flatMap((lookup) => (lookup.openSubtitles ? withHashMatches(lookup.got, byHash) : lookup.got)));
        const view: PickView = { others: (language) => all.filter((sub) => filedUnder(sub, language)), wait: (work, fallback) => already(work, fallback), map: already(seasons, undefined) };
        const lead = await pick(view, async () => ({ englishOriginal: english === true, englishVoices: await hasEnglishVoices(playing.filename, 0) }));
        if (pickedAt !== undefined) return;
        // The languages the file has in full are left out of the list (skipEmbedded): not synced here either.
        const have = profile.skipEmbedded ? new Set(((await embeddedLanguages(playing.filename, 0)) ?? []).map((code) => languageTitle(code).toLowerCase())) : new Set<string>();
        const leading = [...lead.dubListed.map((subtitle) => ({ subtitle, code: undefined as string | undefined })), ...lead.extras.map((extra) => ({ subtitle: extra.subtitle, code: extra.lang as string | undefined }))].filter(
          (track) => !(track.code && have.has(languageTitle(track.code).toLowerCase()))
        );
        let started = 0;
        for (const track of leading) {
          const [season, episode] = place(track.subtitle);
          if ((await lacks(track.subtitle, season, episode)) || !(await listMayFetch(track.subtitle))) continue;
          started++;
          void syncOne(track.subtitle, season, episode, track.code);
        }
        if (started) {
          count("lists.headStart");
          console.log(`${who} ${stremioRequest.id}: ${started} of its tracks' syncs started ${deadline - Date.now()} ms before the list's time ends, with ${sofar.filter((lookup) => !lookup.answered).length} of ${sofar.length} sources still to answer`);
        }
      })().catch(() => undefined);
    }

    numbered = true;
    const movies = await inTime(moviesJob, [], "SubSource search");
    const [subdl, fromWyzie, opensubsListed, fromCat, ...fromAddons] = await othersJob;
    const opensubs = withHashMatches(opensubsListed, await byHashJob);
    const everyOther = withoutCopies([...subdl, ...fromWyzie, ...opensubs, ...fromCat, ...fromAddons.flat()]);
    const others = (language: string) => everyOther.filter((sub) => filedUnder(sub, language));
    const final: PickView = { others, wait: inTime, map: seasons };
    const { ranked, closedCaptions, dubListed, extras, dubbed, standIns } = await pick(final, async () => {
      const englishOriginal = (await englishJob) === true;
      // The playing file's voices are known from its header within the time the list keeps for it.
      const englishVoices = headerFile ? await hasEnglishVoices(headerFile, Math.max(0, deadline + grace() - Date.now())) : undefined;
      if (profile.dub && !englishOriginal && englishVoices === false) count("lists.notDubbed");
      // From here the list's own tracks are being picked: a head start not begun yet has nothing to add.
      pickedAt = Date.now();
      return { englishOriginal, englishVoices };
    });

    if (ranked.length === 0 && extras.length === 0) {
      // Without a season map only the first FIRST_RECORDS were searched (see subsourceIn).
      const tried = (await seasons) ? movies : movies.slice(0, FIRST_RECORDS);
      const left = movies.length - tried.length;
      console.log(
        `${who} subtitles ${stremioRequest.id} file=${stremioRequest.filename ?? "-"} results=0 (records tried: ${tried.map((m) => `s${m.season}`).join(",") || "none"}${left > 0 ? `; ${left} more not searched, no season map` : ""})`
      );
      const age = partial ? 30 : 300;
      res.set("Cache-Control", `max-age=${age}`);
      res.locals.activity = { kind: "list", what, result: partial ? "nothing yet (sites slow)" : "nothing found", detail: { ...(askedLate().length ? { late: askedLate() } : {}), sources: askedSources(), ...(aheadOf ? { ahead: true } : {}) } };
      count("lists.empty");
      if (partial) count("lists.partial");
      res.json({ subtitles: [], cacheMaxAge: age });
      return;
    }

    count("tracks", dubListed.length + extras.length);
    count("tracks.hashMatch", [...dubListed, ...extras.map((e) => e.subtitle)].filter((s) => s.hashMatch).length);
    const baseUrl = publicBase(req);
    // English in the file's own style (Settings.ownStyle): its header's styles read now, for the downloads.
    if (playing && profile.ownStyle && profile.aiostreamsUrl) void fileOwnStyle(profile.aiostreamsUrl, playing.videoId, playing.type, playing.filename, 0);
    const placed = [
      // Each dub track falls back on the ones after it, listed or not: two uploads often carry the same
      // dub captions, one of them off by a second or so and harder to fit. After those, the closed
      // captions from other uploads (standIns), and last its own pack's neighbouring files.
      ...dubListed.map((subtitle, index) => ({
        subtitle,
        code: undefined as string | undefined,
        cc: closedCaptions,
        alts: [...[...ranked.slice(index + 1), ...standIns].filter((s) => !s.sealedUrl).slice(0, ALTERNATES), ...packNeighbours(subtitle)]
      })),
      ...extras.map(({ subtitle, lang, alts }) => ({
        subtitle,
        code: lang as string | undefined,
        cc: false,
        alts
      }))
    ].map((track) => {
      const [season, episode] = place(track.subtitle);
      return { ...track, season, episode };
    });
    // A source that answered after this list's time: once it has, its subtitles stand behind this
    // list's tracks, ranked as the list ranks them, for a download whose listed ones all fail.
    if (playing) {
      const asLate = (subtitles: RankedSubtitle[]) => subtitles.filter((sub) => !sub.sealedUrl).slice(0, LATE_ALTERNATES).map((sub) => ({ ref: refOf(sub), season: place(sub)[0], episode: place(sub)[1], pick: sub.pick }));
      for (const { name, found } of answers) {
        if (!lateSources.has(name) && !lateSources.has(`${name} (partly)`)) continue;
        void found
          .then(async (subtitles) => {
            const map = await seasons;
            const ranked = (language: string, options: RankOptions) => forVariant(filterAndRankDubtitles(subtitles.filter((sub) => filedUnder(sub, language)), stremioRequest, { ...options, seasonMap: map }).sort(compareRanked), language);
            const dubTagged = new Set(ranked("english", { allowMachine: true }).map((sub) => refOf(sub)));
            if (dubbed && !closedCaptions) noteLateAlternates(profile.prefix, playing.videoId, undefined, asLate(await notKnownMissing(ranked("english", { allowMachine: profile.allowMachine }))));
            for (const language of profile.extraLanguages) {
              const own = ranked(language.name, { requireDub: false, allowMachine: profile.allowMachine, hearingImpaired: profile.hearingImpaired });
              const kept = await notKnownMissing(language.name === "english" ? own.filter((sub) => !dubTagged.has(refOf(sub))) : own);
              noteLateAlternates(profile.prefix, playing.videoId, language.code, asLate(kept));
              if (kept.length) count("lists.lateAlternates", Math.min(kept.length, LATE_ALTERNATES));
            }
          })
          .catch(() => undefined);
      }
    }
    // A pack found not to hold this episode (its only file is another one) gives its place to the
    // next subtitle in line that isn't known to lack it, and the track is left out when there is none.
    // A closed-captions stand-in that took a dub track's place is named as closed captions, as one listed outright is.
    const standInRefs: ReadonlySet<string> = new Set(standIns.map((sub) => refOf(sub)));
    const isCc = (track: { cc: boolean; subtitle: RankedSubtitle }) => track.cc || standInRefs.has(refOf(track.subtitle));
    const tracks: typeof placed = [];
    for (const track of placed) {
      let current: (typeof placed)[number] | undefined = track;
      while (current && (await lacks(current.subtitle, current.season, current.episode))) {
        const next: RankedSubtitle | undefined = current.alts[0];
        if (!next) {
          current = undefined;
          break;
        }
        const [season, episode] = place(next);
        current = { ...current, subtitle: next, alts: current.alts.slice(1), season, episode };
      }
      if (current) tracks.push(current);
    }
    // A pack is only known to hold the episode once it is opened. With a file playing, the sync
    // opens it anyway, so each is opened from here on, beside the header read, and
    // asked about further down.
    const opening = new Map<string, Promise<boolean>>();
    // A track for a regional kind opens its subtitle too, pack or not: its words say which kind it is (otherKind).
    const holds = (subtitle: RankedSubtitle, code?: string): Promise<boolean> => {
      const kind = code && baseLanguage(code.toLowerCase()) ? code.toLowerCase() : undefined;
      if (subtitle.files === 1 && !kind) return Promise.resolve(true);
      const [s, e] = place(subtitle);
      const id = `${refOf(subtitle)}|${s}|${e}|${subtitle.pick ?? ""}|${kind ?? ""}`;
      let job = opening.get(id);
      if (!job) {
        // A pack this list may not fetch now is listed as it is, as one not opened in time would be.
        job = listMayFetch(subtitle).then((may) =>
          !may
            ? true
            : getCachedSubtitleFile(refOf(subtitle), s, e, { ...keys, addonUrl: subtitle.sealedUrl ? openUrl(subtitle.sealedUrl) : undefined }, subtitle.pick, subtitle.language).then(
                async (got) => !(await otherKind(got.file, kind)),
                (error) => !(error instanceof Error && (error.name === "EpisodeNotInPack" || error.name === "WrongLanguage"))
              )
        );
        opening.set(id, job);
      }
      return job;
    };
    if (playing) for (const track of tracks) void holds(track.subtitle, track.code);

    // The file has no embedded subtitles (from its header, read now on a first play, waited on
    // for at most 4 s), or this subtitle matched none of them before: those tracks don't claim
    // "Synced" and skip the sync work.
    const fileHas = playing && profile.aiostreamsUrl && tracks.length > 0
      ? await fileHasSubtitles(profile.aiostreamsUrl, playing.videoId, playing.type, playing.filename, Math.min(4000 - DEFAULTS.fileWaitMs + grace(), Math.max(0, deadline + grace() - Date.now())), Math.min(4000, Math.max(0, deadline + DEFAULTS.fileWaitMs - Date.now())))
      : undefined;
    // The file's own full subtitles are timed to it already: those languages are left out, unless the
    // link asks for ours too (keepEmbedded). Dub and CC tracks stay: a file's English is the
    // translation, not what the dub says.
    if (playing && profile.skipEmbedded) {
      if (profile.aiostreamsUrl) completeLanguages(profile.aiostreamsUrl, playing.videoId, playing.type, playing.filename);
      const have = await embeddedLanguages(playing.filename, Math.max(0, deadline + grace() - Date.now()));
      if (have?.length) {
        const names = new Set(have.map((code) => languageTitle(code).toLowerCase()));
        const before = tracks.length;
        for (let i = tracks.length - 1; i >= 0; i--) {
          const code = tracks[i].code;
          if (code && names.has(languageTitle(code).toLowerCase())) tracks.splice(i, 1);
        }
        if (tracks.length < before) {
          count("tracks.embedded", before - tracks.length);
          console.log(`${who} ${stremioRequest.id}: ${before - tracks.length} left out, the file has them (${have.join(", ")})`);
        }
      }
    }
    // A file timed by its own subtitle track syncs in a second or two once its header is read: the
    // list waits for that, so the first list already says which tracks synced and can list a fallback
    // in place of one that doesn't. The tracks are known only once every source has answered or the
    // list's time is up, so the wait runs into the grace: a source that takes the whole of the list's
    // time leaves the syncs that much, not none.
    const until = () => deadline + grace();
    const byListsEnd = <T>(work: Promise<T>): Promise<T | "late"> =>
      Promise.race([work, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, until() - Date.now())).unref())]);
    /**
     * One track settled: its own subtitle synced, and where that one doesn't fit the file, the first
     * fallback that does listed in its place. Each track by itself, so a track waiting on the audio
     * holds no other track's fallbacks back; and a track's fallbacks are tried from the moment its own
     * subtitle is known to fit nothing in the file's track, beside its read of the audio, not after it.
     * Which one is listed is still decided once its own sync has ended: timed by speech on a file whose
     * track is off its voices, it stays.
     */
    const settleTrack = async (track: (typeof tracks)[number]): Promise<void> => {
      if (!playing) return;
      const file = playing.filename;
      const key = syncKey(refOf(track.subtitle), track.season, track.episode, file, track.subtitle.pick);
      const speechOnly = fileHas === "speech";
      /** The first fallback known to sync, or that syncs now: the file's windows are read by then, so each try is a download and a measurement. */
      const fitting = async () => {
        for (const alt of track.alts) {
          const [s, e] = place(alt);
          const altKey = syncKey(refOf(alt), s, e, file, alt.pick);
          let state = await knownSync(altKey, file);
          if (state === "unknown" && profile.aiostreamsUrl && Date.now() < until() && (await listMayFetch(alt))) {
            // A pack without that episode (a neighbour past its end) is passed over like one that doesn't sync.
            const result = await byListsEnd(unlessMisfit(syncOne(alt, s, e, track.code).catch(() => undefined), altKey, until() - Date.now()));
            if (syncedWell(result === "late" ? undefined : result)) state = "synced";
          }
          if (state === "synced" || state === "voices" || (speechOnly && state === "speech")) return { alt, s, e };
        }
        return undefined;
      };
      let ahead: ReturnType<typeof fitting> | undefined;
      if (fileHas === true && Date.now() < until() && (await listMayFetch(track.subtitle))) {
        const own = syncOne(track.subtitle, track.season, track.episode, track.code).catch(() => undefined);
        if (track.alts.length && (await byListsEnd(unlessMisfit(own, key, until() - Date.now()))) === "misfit") ahead = fitting();
        await byListsEnd(own);
      }
      if (!track.alts.length) return;
      const state = await knownSync(key, file);
      // Timed only by speech (the last resort) counts as not fitting here: an alternate that fits the
      // file's subtitles is better. Not where the voices show those subtitles to be off them ("voices").
      if (state !== "wrong" && state !== "unsynced" && state !== "speech") return;
      // A file with no subtitle track: speech is all there is. Timed by it, the top one stays; not
      // timed, an alternate that speech does time takes its place.
      if (speechOnly && state === "speech") return;
      const found = await byListsEnd(ahead ?? fitting());
      if (!found || found === "late") return;
      track.alts = track.alts.filter((a) => a !== found.alt);
      Object.assign(track, { subtitle: found.alt, season: found.s, episode: found.e });
      count("tracks.fallback");
      console.log(`${who} ${stremioRequest.id}: listing fallback ${refOf(found.alt)}, the top one doesn't sync to this file`);
    };
    const settleTracks = () => Promise.all(tracks.map((track) => settleTrack(track).catch(() => undefined)));
    if (playing) {
      await settleTracks();
      // Opening the file can show its link to serve another listed release (the one under its name
      // failed over). What is read of it, and every sync to it, is kept under that release, and a sync
      // made under the name asked by isn't kept at all: the list goes by the served release from here
      // on, and settles its tracks on it now, its readings being in hand.
      if (readingsRef(playing.filename) !== playing.filename) {
        playing.filename = readingsRef(playing.filename);
        await settleTracks();
      }
      // A dub track that took the place of the one above it now lists the same subtitle as the
      // track it came from: list it once.
      const seen = new Set<string>();
      for (let i = 0; i < tracks.length; ) {
        const id = `${tracks[i].code ?? (isCc(tracks[i]) ? "cc" : "dub")}|${refOf(tracks[i].subtitle)}|${tracks[i].season}|${tracks[i].episode}`;
        if (seen.has(id)) tracks.splice(i, 1);
        else (seen.add(id), i++);
      }
    }
    // The packs opened above: one without the episode gives its place to the next in line, or isn't
    // listed. One not opened in what is left of this list's time is listed as it was.
    if (playing) {
      const inTimeHolds = (subtitle: RankedSubtitle, code?: string): Promise<boolean> =>
        Promise.race([holds(subtitle, code), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), Math.max(0, deadline - Date.now())).unref())]);
      const kept = await Promise.all(
        tracks.map(async (track) => {
          while (!(await inTimeHolds(track.subtitle, track.code))) {
            const next = track.alts.shift();
            if (!next) return false;
            const [s, e] = place(next);
            count("tracks.packWithoutEpisode");
            Object.assign(track, { subtitle: next, season: s, episode: e });
          }
          return true;
        })
      );
      for (let i = tracks.length - 1; i >= 0; i--) if (!kept[i]) tracks.splice(i, 1);
    }
    // Subtitle Cat is searched by name alone (subtitlecat.ts), so its subtitles are listed only once
    // they have synced to the playing file: tried now, within what is left of this list's time. One
    // that hasn't gives its place to the next subtitle from another source, or isn't listed.
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.subtitle.source !== "subtitlecat") continue;
      let fits = false;
      if (playing && profile.aiostreamsUrl) {
        const key = syncKey(refOf(track.subtitle), track.season, track.episode, playing.filename, track.subtitle.pick);
        let state = await knownSync(key, playing.filename);
        if (state === "unknown") {
          const job = syncOne(track.subtitle, track.season, track.episode, track.code);
          const result = await Promise.race([job, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), Math.max(0, deadline + grace() - Date.now())).unref())]);
          // Timed by speech counts only on a file with no subtitle track, where speech is all there is.
          if (syncedWell(result)) state = "synced";
        }
        fits = state === "synced" || state === "voices" || (state === "speech" && fileHas === "speech");
      }
      if (fits) continue;
      count("tracks.subtitlecatHeld");
      const next = track.alts.find((alt) => alt.source !== "subtitlecat");
      if (next) {
        const [s, e] = place(next);
        track.alts = track.alts.filter((alt) => alt !== next && alt.source !== "subtitlecat");
        Object.assign(track, { subtitle: next, season: s, episode: e });
      } else tracks.splice(i, 1);
    }
    // A track that took another's place above (a pack without the episode, a Subtitle Cat subtitle
    // that didn't sync) can now list the same subtitle as the track beside it: listed once.
    {
      const seen = new Set<string>();
      for (let i = 0; i < tracks.length; ) {
        const id = `${tracks[i].code ?? (isCc(tracks[i]) ? "cc" : "dub")}|${refOf(tracks[i].subtitle)}|${tracks[i].season}|${tracks[i].episode}`;
        if (seen.has(id)) tracks.splice(i, 1);
        else (seen.add(id), i++);
      }
    }
    const known = await Promise.all(
      tracks.map((t) =>
        playing
          ? fileHas === false
            ? "unsynced"
            : knownSync(syncKey(refOf(t.subtitle), t.season, t.episode, playing.filename, t.subtitle.pick), playing.filename)
          : "unknown"
      )
    );
    // A track whose own subtitle doesn't sync, with one next in line not tried yet (the list's time
    // ran out first): the download tries those, so the track isn't known not to sync. It says
    // "Auto sync", like any track whose sync is still to finish.
    const untried = await Promise.all(
      tracks.map(async (t, i) => {
        if (!playing || fileHas === false || (known[i] !== "unsynced" && known[i] !== "wrong")) return false;
        for (const alt of t.alts) {
          const [s, e] = place(alt);
          if ((await knownSync(syncKey(refOf(alt), s, e, playing.filename, alt.pick), playing.filename)) === "unknown") return true;
        }
        return false;
      })
    );
    const unsynced = new Set(tracks.filter((_, i) => known[i] === "unsynced" && !untried[i]).map((t) => t.subtitle));
    // Captions that couldn't be fitted to this file stay listed, unsynced: timing alone can't tell
    // another episode from the same one cut differently. Only the pack check, which reads episode
    // names, removes one.
    for (let i = 0; i < tracks.length; i++) if (known[i] === "wrong" && !untried[i]) unsynced.add(tracks[i].subtitle);
    const synced = (t: (typeof tracks)[number]) => Boolean(playing) && !unsynced.has(t.subtitle);
    // Known to be timed to this file, as against a sync still to finish (or to start with the download):
    // only these say "Synced" and count as synced.
    const timed = new Set(tracks.filter((_, i) => known[i] === "synced" || known[i] === "speech" || known[i] === "voices").map((t) => t.subtitle));
    const confirmed = (t: (typeof tracks)[number]) => synced(t) && timed.has(t.subtitle);
    // Timed by speech in the audio (the file has no subtitle track, or nothing else fit): labelled
    // apart, so it's easy to spot and report.
    const audioOf = new Map<RankedSubtitle, "synced" | "trying">();
    tracks.forEach((t, i) => {
      if (!synced(t)) return;
      if (known[i] === "speech" || known[i] === "voices") audioOf.set(t.subtitle, "synced");
      else if (fileHas === "speech" && known[i] === "unknown") audioOf.set(t.subtitle, "trying");
    });
    console.log(`${who} subtitles ${stremioRequest.id} file=${stremioRequest.filename ?? "-"} results=${ranked.length}${ranked[0] ? `(${closedCaptions ? "cc:" : ""}${refOf(ranked[0])}${ranked[0].hashMatch ? " hash" : ""})` : ""} extra=${extras.map((e) => `${e.lang}:${refOf(e.subtitle)}(${tierName((e.subtitle.quality ?? 1) as QualityTier)}${e.subtitle.releaseMatch ? ` match ${e.subtitle.releaseMatch}` : ""}${e.subtitle.hashMatch ? " hash" : ""})`).join(",") || "none"} sync=${playing ? (unsynced.size ? `on, ${unsynced.size} known unsynced` : "on") : "off"} hints=${stremioRequest.videoHash ? "hash" : ownHash ? "own hash" : "-"},${stremioRequest.videoSize ? "size" : "-"}`);

    // Start syncing now, so they're ready when one is picked.
    if (playing && profile.aiostreamsUrl) {
      // Fallbacks only when the track's own subtitle turns out not to sync, one at a time, so a
      // normal play costs nothing extra; the first that syncs is ready for the download and the next list.
      for (const track of tracks.filter((t) => t.alts.length)) {
        void (async () => {
          if (!(await listMayFetch(track.subtitle))) return;
          // Once the track's own subtitle fits nothing in the file's subtitle track, speech is all it
          // has left, and a fallback that fits the track beats that: the fallbacks are tried from then
          // on, beside its speech read, so the first that syncs is ready sooner for the download.
          const own = syncOne(track.subtitle, track.season, track.episode, track.code);
          if (syncedWell(await unlessMisfit(own, syncKey(refOf(track.subtitle), track.season, track.episode, playing.filename, track.subtitle.pick), BACKGROUND_SYNC_WAIT_MS))) return;
          for (const alt of track.alts) {
            if (!(await listMayFetch(alt))) continue;
            const [s, e] = place(alt);
            const result = await unlessMisfit(syncOne(alt, s, e, track.code).catch(() => undefined), syncKey(refOf(alt), s, e, playing.filename, alt.pick), BACKGROUND_SYNC_WAIT_MS);
            if (syncedWell(result)) {
              // Its speech read may yet show the track to be off the voices (overTrack): then it stays.
              if (syncedWell(await own.catch(() => undefined))) return;
              console.log(`${who} ${stremioRequest.id}: ${refOf(track.subtitle)} doesn't sync to this file; fallback ${refOf(alt)}${alt.packEpisode !== undefined ? ` (its pack's episode ${alt.packEpisode})` : ""} does`);
              return;
            }
          }
        })().catch(() => undefined);
      }
      for (const { subtitle, season, episode, code } of tracks.filter((t) => synced(t) && !t.alts.length)) {
        void listMayFetch(subtitle)
          .then((may) => (may ? syncOne(subtitle, season, episode, code) : undefined))
          .catch(() => undefined);
      }
    }

    // The link lists only what syncs: tracks known not to fit this file are left out. Syncs still
    // being worked out stay, and their fallbacks keep trying above, so a later list can show them.
    if (playing && profile.hideUnsynced) {
      const before = tracks.length;
      for (let i = tracks.length - 1; i >= 0; i--) if (unsynced.has(tracks[i].subtitle)) tracks.splice(i, 1);
      if (tracks.length < before) {
        count("tracks.hiddenUnsynced", before - tracks.length);
        console.log(`${who} ${stremioRequest.id}: ${before - tracks.length} unsynced left out (this link lists synced only)`);
      }
    }
    const syncedCount = tracks.filter(confirmed).length;
    const pendingCount = tracks.filter((t) => synced(t) && !confirmed(t)).length;
    const trackDetail = tracks.map((t) => ({
      lang: t.code ? languageTitle(t.code) : isCc(t) ? "English CC" : "English Dub",
      source: sourceOfRef(refOf(t.subtitle)),
      ref: refOf(t.subtitle),
      release: (t.subtitle.releaseInfo ?? []).find(Boolean) ?? undefined,
      state: (playing ? (confirmed(t) ? "synced" : synced(t) ? "sync pending" : "not synced") : "no file") as "synced" | "sync pending" | "not synced" | "no file"
    }));
    res.locals.activity = {
      kind: "list",
      what,
      result: `${tracks.length} track${tracks.length === 1 ? "" : "s"}${playing ? `, ${syncedCount} synced${pendingCount ? `, ${pendingCount} pending` : ""}` : ""}${partial ? ", partial" : ""}`,
      detail: { tracks: trackDetail, ...(askedLate().length ? { late: askedLate() } : {}), sources: askedSources(), ...(aheadOf ? { ahead: true } : {}), ...playedFile(stremioRequest.filename ? (playingRef as string) : "", stremioRequest.id) }
    };
    // A list that isn't settled is kept half a minute, not five: whoever keeps it (AIOStreams, a
    // player) asks again sooner and gets the settled one. Not settled: a track's audio sync is still
    // running ("Audio sync"), a sync wasn't finished by the deadline (its "Synced" isn't known yet), or a source
    // didn't answer in time.
    const settling = [...audioOf.values()].includes("trying") || (Boolean(playing) && known.includes("unknown")) || partial;
    const keepFor = settling ? 30 : 300;
    res.set("Cache-Control", settling ? "max-age=30" : "max-age=300, stale-while-revalidate=900");
    // With "Keep the subtitle's own styling", a subtitle stored as ASS (downloaded already, by this
    // list's syncs or earlier) is listed under a link ending in ".ass"; one not downloaded yet goes as
    // SRT. With a style for this title (its look, its height, or both), every subtitle goes as ASS,
    // whatever its format. Anime is looked up only when a style is for anime (Cinemeta, kept by metaOf).
    const anime = profile.styles.some((r) => r.scope === "anime")
      ? stremioRequest.id.startsWith("kitsu") || isAnime(await Promise.race([metaOf(stremioRequest.type, stremioRequest.imdbId).catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), RUNTIME_WAIT_MS).unref())]))
      : false;
    // A track's style: the title's, for the track's language as the configuration names it (the dub and its CC are "English").
    const styleOf = (code: string | undefined) => styleFor(profile.styles, { imdbId: stremioRequest.imdbId, type: stremioRequest.type, anime }, code === undefined ? "English" : code === "English" ? REGULAR_ENGLISH : code);
    const asAss = new Set<RankedSubtitle>();
    if (profile.keepAss) {
      await Promise.all(
        tracks.map(async (t) => {
          const ext = await storedSubtitleExt(refOf(t.subtitle), t.season, t.episode, t.subtitle.pick).catch(() => undefined);
          // Not fetched yet: a source that names its format says what it will be, so a first play gets its styling too.
          if (ext === ".ass" || ext === ".ssa" || (ext === undefined && t.subtitle.styled)) asAss.add(t.subtitle);
        })
      );
    }
    // Signs & songs already found for the playing file go with its English Dub and CC (signs=1 in their link).
    const signsFound = Boolean(profile.signs && playing && playingRef && (await signsKept(stremioRequest.id, playingRef).catch(() => undefined))?.found);
    res.json({
      subtitles: tracks.map((track) => ({
        id: `bttrsub-${refOf(track.subtitle)}`,
        lang: sentLanguage(track),
        // Players and AIOStreams' and AIOMetadata's Jellyfin servers show label as the track's description.
        label: trackLabel(track.code, confirmed(track) || audioOf.has(track.subtitle) ? true : synced(track) ? "pending" : false, audioOf.get(track.subtitle), isCc(track), signsFound && !track.code && (synced(track) || track.alts.length > 0)),
        url: downloadUrl(baseUrl, profile, track.subtitle, track.season, track.episode, synced(track) || track.alts.length ? playing : undefined, track.code, track.alts.map((alt) => ({ ref: refOf(alt), at: place(alt), pick: alt.pick })), asAss.has(track.subtitle), styleOf(track.code).up, styleOf(track.code).look, profile.keepAss)
      })),
      cacheMaxAge: keepFor,
      staleRevalidate: settling ? 0 : 900,
      staleError: 900
    });
  }

  router.get("/subtitles/:type/:id.json", anySite, (req, res, next) => {
    subtitlesHandler(req, res).catch(next);
  });

  router.get("/subtitles/:type/:id/:extra.json", anySite, (req, res, next) => {
    subtitlesHandler(req, res).catch(next);
  });

  router.get("/download/:subtitleId/:filename", anySite, async (req, res, next) => {
    try {
      const profile = profileOf(res);
      if (!profile) {
        res.status(404).send("Configure BttrSubs first");
        return;
      }
      if (isPaused(profile.name)) {
        res.set("Cache-Control", "no-store").status(404).send("This configuration is paused");
        return;
      }
      count("downloads", 1, profile.name);
      // Everything below, the subtitle's own fetch included, shares this one budget (see DOWNLOAD_BUDGET_MS).
      const deadline = Date.now() + DOWNLOAD_BUDGET_MS;
      let ref = param(req.params.subtitleId);
      if (!/^(?:ss|sd|os)?[\w-]{1,64}$/.test(ref)) {
        res.status(400).send("Invalid subtitle id");
        return;
      }

      // The playing file as the list's link names it: its video id, its kind and its name. They go on into
      // the stream lookup and the caches, so anything else is refused, as a link nobody listed.
      const asked = (name: string) => (typeof req.query[name] === "string" ? (req.query[name] as string) : "");
      if (
        (asked("vid") && !VIDEO_ID.test(asked("vid"))) ||
        (asked("type") && !VIDEO_TYPES.includes(asked("type"))) ||
        asked("file").length > MAX_FILE_NAME ||
        /[\x00-\x1f]/.test(asked("file")) ||
        [req.query.season, req.query.episode].some((n) => n !== undefined && !(typeof n === "string" && /^\d{1,6}$/.test(n)))
      ) {
        res.status(400).send("Invalid playing file");
        return;
      }

      let season = req.query.season ? Number(req.query.season) : undefined;
      let episode = req.query.episode ? Number(req.query.episode) : undefined;
      // The subtitle's own count for its file in a pack, when its name gave one (see RankedSubtitle.pick).
      const pickOf = (value: unknown) => (typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : undefined);
      let pick = pickOf(req.query.pick);
      const src = typeof req.query.src === "string" ? openUrl(req.query.src) : undefined;
      const keys: SourceKeys = { ...keysOf(profile), addonUrl: src };
      const lang0 = typeof req.query.lang === "string" ? req.query.lang : undefined;
      // The language the track is listed under (dub captions and English CC carry none: English).
      const listedAs = lang0 ?? "english";
      // The playing file, as this configuration's readings of it are kept (scopedRef).
      const fileName = typeof req.query.file === "string" && req.query.file ? await sameFileRef(scopedRef(profile.aiostreamsUrl, req.query.file)) : undefined;
      // Someone is watching this file: its hearing goes before any file listed ahead (turns.ts).
      if (fileName) watching(fileName);
      const what = `${lang0 ?? "English Dub"} · ${describe(fileName, `${ref}${season !== undefined ? ` S${season}E${episode ?? "?"}` : ""}`, season, episode)}`;
      res.locals.activity = { kind: "download", what, result: "error" };
      // "ref@season:episode[:pick],…" from the list: the subtitles next in line for this track, and a
      // pack's files for the episodes beside its own (PACK_NEIGHBOURS) after them.
      const altOf = (text: string) => text.match(/^((?:ss|sd|os)?[\w-]{1,64})@(\d*):(\d*)(?::(\d{1,4}))?$/);
      let alts = (typeof req.query.alt === "string" ? req.query.alt : "")
        .split(",")
        .map(altOf)
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .slice(0, ALTERNATES + PACK_NEIGHBOURS.length);
      // Subtitles a source offered after the list went out stand behind the ones the link names (lateAlternates.ts).
      for (const late of asked("vid") ? lateAlternates(profile.prefix, asked("vid"), lang0) : []) {
        const match = late.ref === ref || alts.some((a) => a[1] === late.ref) ? null : altOf(`${late.ref}@${late.season ?? ""}:${late.episode ?? ""}${late.pick !== undefined ? `:${late.pick}` : ""}`);
        if (match) alts.push(match);
      }
      // A subtitle file for this track. On a regional kind's track, one written in the other kind is
      // refused like one in another language (variants.ts), so the next in line takes its place.
      const fileFor = async (...args: Parameters<typeof getCachedSubtitleFile>) => {
        const got = await getCachedSubtitleFile(...args);
        if (await otherKind(got.file, lang0?.toLowerCase())) {
          const other = new Error(`Subtitle ${args[0]} is written in another kind of ${listedAs} than its track.`);
          other.name = "WrongLanguage";
          throw other;
        }
        return got;
      };
      /** The work, or a refusal once `until` has come: the fetch itself goes on, and what it brings is kept for the next request. */
      const inTime = <T>(work: Promise<T>, until: number) =>
        new Promise<T>((resolve, reject) => {
          const late = setTimeout(() => reject(Object.assign(new Error("the subtitle's source didn't answer in time"), { name: "SourceSilent" })), Math.max(0, until - Date.now()));
          work.then(resolve, reject).finally(() => clearTimeout(late));
        });
      let subtitle: Awaited<ReturnType<typeof getCachedSubtitleFile>> | undefined;
      /** The subtitle's source gave no answer, and nothing next in line could be had: SOURCE_SILENT goes out. */
      let sourceSilent = false;
      const listed = fileFor(ref, season, episode, keys, pick, listedAs);
      /** The listed subtitle, should it still arrive while those next in line are asked for: a slow source's answer is taken whenever it comes inside the budget. */
      const late = listed.then((got) => ({ got, late: true as const }), () => new Promise<never>(() => undefined));
      try {
        subtitle = await inTime(listed, deadline - DOWNLOAD_BUDGET_MS + FETCH_WAIT_MS);
      } catch (error) {
        // This one can't be had (a pack that turned out not to hold the episode, a failed download, a
        // source that hasn't answered yet): the next in line takes its place now, so the player never
        // gets an empty track. Subtitle Cat's are passed over here: they are sent only once synced,
        // further down. Each gets an even share of the time left, so one more source that doesn't
        // answer leaves the rest theirs.
        const inLine = alts.filter((a) => !a[1].startsWith("sc")).length;
        let tried = 0;
        for (const [index, [, altRef, altSeason, altEpisode, altPick]] of alts.entries()) {
          if (Date.now() > deadline) break;
          if (altRef.startsWith("sc")) continue;
          const s = altSeason ? Number(altSeason) : undefined;
          const e = altEpisode ? Number(altEpisode) : undefined;
          const p = pickOf(altPick);
          const next = inTime(fileFor(altRef, s, e, keysOf(profile), p, listedAs), Date.now() + (deadline - Date.now()) / (inLine - tried++)).then((got) => ({ got, late: false as const }));
          next.catch(() => undefined);
          let first: Awaited<typeof next> | Awaited<typeof late>;
          try {
            first = await Promise.race([next, late]);
          } catch {
            continue;
          }
          subtitle = first.got;
          // The listed one came after all: it is the one sent.
          if (first.late) break;
          const why = error instanceof Error && error.name === "EpisodeNotInPack" ? "its pack doesn't hold the episode" : error instanceof Error && error.name === "WrongLanguage" ? "it's in another language" : "couldn't be fetched";
          console.log(`download ${ref}: ${why}; ${altRef} takes its place`);
          count("downloads.nextInLine");
          [ref, season, episode, pick] = [altRef, s, e, p];
          alts = alts.slice(index + 1);
          break;
        }
        const vid0 = typeof req.query.vid === "string" ? req.query.vid : "";
        const type0 = typeof req.query.type === "string" ? req.query.type : "";
        // Dub captions (a track listed with no language) none of whose listed subtitles hold the
        // episode: Anime Tosho's, whose look-up may have come in only after the list was sent.
        if (!subtitle && lang0 === undefined && profile.animetosho && profile.dub && vid0) {
          const leave = 1500;
          for (const tosho of await animeToshoFor(vid0, type0, deadline - Date.now() - leave)) {
            const atRef = refOf(tosho);
            try {
              subtitle = await getCachedSubtitleFile(atRef, season, episode, keysOf(profile), undefined, listedAs);
            } catch {
              continue;
            }
            const why = error instanceof Error && error.name === "EpisodeNotInPack" ? "its pack doesn't hold the episode" : "couldn't be had";
            console.log(`download ${ref}: ${why}; Anime Tosho's ${atRef} takes its place`);
            count("downloads.nextInLine");
            [ref, pick] = [atRef, undefined];
            alts = [];
            break;
          }
        }
        if (!subtitle) {
          // Nothing but Subtitle Cat's left: one of those, if it syncs to the file in time.
          for (const [, altRef, altSeason, altEpisode, altPick] of alts.filter((a) => a[1].startsWith("sc"))) {
            if (!profile.aiostreamsUrl || !vid0 || !type0 || !fileName || Date.now() > deadline) break;
            const s = altSeason ? Number(altSeason) : undefined;
            const e = altEpisode ? Number(altEpisode) : undefined;
            const p = pickOf(altPick);
            try {
              const altFile = await fileFor(altRef, s, e, keysOf(profile), p, listedAs);
              const job = syncCaptions(syncKey(altRef, s, e, fileName, p), async () => altFile, profile.aiostreamsUrl, vid0, type0, fileName, lang0);
              const done = await Promise.race([job, new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), Math.max(0, deadline - Date.now())))]);
              if (syncedWell(done)) {
                subtitle = altFile;
                [ref, season, episode, pick] = [altRef, s, e, p];
                alts = [];
                count("downloads.nextInLine");
                console.log(`download: the subtitle listed couldn't be had; ${altRef} synced and takes its place`);
                break;
              }
            } catch {}
          }
        }
        // Nothing next in line either: the listed one's source has the rest of the budget to answer.
        if (!subtitle && error instanceof Error && error.name === "SourceSilent") subtitle = await inTime(listed, deadline).catch(() => undefined);
        // A pack without the episode or a subtitle in another language is an answer, and an error. A source
        // that gave none (no answer in time, a failed connection, a refusal for now) is said in the track.
        const silent = error instanceof Error && (["SourceSilent", "TimeoutError", "AbortError", "TypeError"].includes(error.name) || /failed: HTTP (?:429|5\d\d)$/.test(error.message));
        if (!subtitle && !silent) throw error;
        if (!subtitle) {
          sourceSilent = true;
          count("downloads.sourceSilent");
          console.log(`download ${ref}: its source didn't answer, and nothing next in line could be had`);
        }
      }
      const listedRef = param(req.params.subtitleId);
      let served = subtitle?.file ?? "";
      let outcome = sourceSilent ? "its source didn't answer, not sent" : "sent as it came";
      let usedSync: SyncResult | undefined;
      let fallback: string | undefined;
      /** The subtitle is another file's and nothing took its place: NOT_THIS_FILE goes out, not its lines. */
      let notThisFile = sourceSilent;
      /** How the sent file was timed, for the log: the shift onto the file and the move onto the voices. */
      let timing = "";

      const vid = typeof req.query.vid === "string" ? req.query.vid : "";
      const type = typeof req.query.type === "string" ? req.query.type : "";
      const file = fileName ?? "";
      const lang = typeof req.query.lang === "string" ? req.query.lang : undefined;
      // Final timing is cached for good; a stand-in (first-pass timing, or the file as it came) is
      // sent with no-store, so the next request gets the finished sync.
      let final = !sourceSilent;
      if (subtitle && profile.aiostreamsUrl && vid && type && file) {
        const key = syncKey(ref, season, episode, file, pick);
        const fetched = subtitle;
        const aio = profile.aiostreamsUrl;
        // Lines running far past the episode's length are another title's (outrunsEpisode): by the
        // file's own length, not synced and its fallbacks tried at once; by the runtime alone, synced as
        // usual. Either way the first fallback stands in for it when nothing syncs in time.
        const outrunsAll = await outrunsEpisode(fetched.file, lang, file, vid, type);
        // Lines that run past the file but hold it at their start (holdsFileAtStart) are timed like any other.
        const partly = outrunsAll === "certain" && (await holdsFileAtStart(file, captionCues(decodeSubtitle(await readFile(fetched.file), lang), path.extname(fetched.file).toLowerCase())).catch(() => false));
        const outruns = partly ? undefined : outrunsAll;
        if (outruns) {
          count(`downloads.outruns.${outruns}`);
          console.log(`download ${ref}: its lines run far past the episode's ${outruns === "certain" ? "file" : "runtime"}, another title's`);
        }
        const job: Promise<SyncResult | undefined> =
          outruns === "certain" ? Promise.resolve({ file: fetched.file, anchors: [], noFit: true, outruns: true, filename: file, source: path.basename(fetched.file) }) : syncCaptions(key, async () => fetched, aio, vid, type, file, lang);
        /** The first fallback fetched that fits the file's length: the stand-in for a subtitle that runs past the episode or ends far short of the file. */
        let standIn: { ref: string; file: string } | undefined;
        const firstFetched = async () => {
          for (const [, altRef, altSeason, altEpisode, altPick] of alts) {
            if (standIn || Date.now() > deadline) break;
            try {
              const altFile = await fileFor(altRef, altSeason ? Number(altSeason) : undefined, altEpisode ? Number(altEpisode) : undefined, keysOf(profile), pickOf(altPick), listedAs);
              // A fallback whose own lines miss the file's length (missesLength) doesn't stand in either.
              if (await missesLength(altFile.file, lang, file)) continue;
              standIn ??= { ref: altRef, file: altFile.file };
            } catch {}
          }
          return standIn;
        };
        /** The first alternate, in list order, that syncs well within the budget; looked for once. */
        let alternates: Promise<Alternate | undefined> | undefined;
        const firstAlternate = () =>
          (alternates ??= (async () => {
            for (const [, altRef, altSeason, altEpisode, altPick] of alts) {
              if (Date.now() > deadline) break;
              const s = altSeason ? Number(altSeason) : undefined;
              const e = altEpisode ? Number(altEpisode) : undefined;
              const p = pickOf(altPick);
              try {
                const altFile = await fileFor(altRef, s, e, keysOf(profile), p, listedAs);
                // Remembered as the stand-in under the same rule firstFetched keeps: never one that misses the file's length.
                if (!standIn && !(await missesLength(altFile.file, lang, file))) standIn = { ref: altRef, file: altFile.file };
                const altKey = syncKey(altRef, s, e, file, p);
                const altJob = unlessMisfit(syncCaptions(altKey, async () => altFile, aio, vid, type, file, lang), altKey, deadline - Date.now());
                const altSynced = await Promise.race([altJob, new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), Math.max(0, deadline - Date.now())))]);
                if (syncedWell(altSynced)) return { ref: altRef, result: altSynced };
              } catch {}
            }
            return undefined;
          })());
        // Captions that fit nothing in the file's own subtitle track have only speech left, which an
        // alternate that fits the track beats (see below): the alternates are tried from that moment,
        // beside the speech read, and one that syncs is sent without waiting for it.
        const alternateWins = trackMisfit(key, deadline - Date.now()).then((misfit) => (misfit ? firstAlternate() : undefined));
        const won = new Promise<{ alternate: Alternate }>((resolve) => void alternateWins.then((a) => a && resolve({ alternate: a })));
        const within = (ms: number) => Promise.race([job, won, new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), Math.max(0, Math.min(ms, deadline - Date.now()))))]);
        const wonBy = (r: unknown): r is { alternate: Alternate } => typeof r === "object" && r !== null && "alternate" in r;
        let synced = await within(SYNC_WAIT_MS);
        // Still refining after the wait: the first windows' timing is nearly always right already.
        if (synced === "wait" && firstPassSync(key)) {
          count("downloads.firstPass");
          served = (firstPassSync(key) as { file: string }).file;
          outcome = "first-pass timing";
          final = false;
        } else {
          // Not even the first windows yet (a slow stream lookup): a little longer, then the file as it came.
          if (synced === "wait") synced = await within(SYNC_SLOW_MS);
          if (synced === "wait") {
            const first = firstPassSync(key);
            // Lines that end far short of the file (shortOfFile) are another title's or part of one:
            // like lines that run past the episode, they never stand in for it. The sync goes on as usual.
            const short = !first && (await shortOfFile(fetched.file, lang, file));
            if (short) {
              count("downloads.short");
              console.log(`download ${ref}: its lines end far short of the file, not its stand-in`);
            }
            if (first) served = first.file;
            outcome = first ? "first-pass timing" : "unsynced stand-in";
            final = false;
            // The first fallback as it came instead; with none, the line saying nothing fits this file.
            const instead = !first && (outruns || short) ? await firstFetched() : undefined;
            if (instead) (served = instead.file), (fallback = instead.ref);
            if (short && !instead) {
              notThisFile = true;
              outcome = "another file's, not sent";
              count("downloads.notThisFile");
            } else count(first ? "downloads.firstPass" : "downloads.unsyncedStandIn");
          } else if (synced && !wonBy(synced)) {
            // Dub captions timed by the track while the English audio is heard, or a translation while
            // its file's track is checked against the voices: the read, under way since the list's sync,
            // is waited for within the budget, and they go out as the voices say.
            if (synced.voicesPending || synced.trackCheckPending) {
              const voiced = await syncedByVoices(key, async () => fetched, aio, vid, type, file, lang, deadline - Date.now());
              if (voiced) {
                count("downloads.voicesWaited");
                synced = voiced;
              }
            }
            served = synced.file;
            outcome = synced.anchors.length > 0 ? (synced.bySpeech ? "synced (audio)" : "synced") : "couldn't sync";
            timing = describeTiming(synced);
            usedSync = synced;
            // Dub captions timed by the track while the English audio is heard in the background: the
            // next request gets them timed by the voices, so a player mustn't keep this answer. The
            // same for a file with no subtitle track while more of its audio is heard.
            if (synced.voicesPending || synced.speechPending || synced.trackCheckPending) final = false;
          }
        }
        // Timed only by speech: an alternate that fits the file's subtitles is sent instead, if one does
        // (found already when one synced while these captions were heard).
        const alternate = wonBy(synced) ? synced.alternate : final && !syncedWell(synced) ? await firstAlternate() : undefined;
        if (alternate) {
          served = alternate.result.file;
          outcome = "synced (fallback)";
          timing = `${alternate.ref}, ${describeTiming(alternate.result)}`;
          usedSync = alternate.result;
          fallback = alternate.ref;
          final = true;
          count("downloads.fallback");
          if (wonBy(synced)) count("downloads.fallbackEarly");
          console.log(`download ${ref}: not synced to ${file}; sent fallback ${alternate.ref} instead`);
        } else if ((outruns === "certain" || (typeof synced === "object" && synced !== null && "outruns" in synced && synced.outruns === true)) && (await firstFetched())) {
          // None synced in time: the first fallback as it came, for the next request to sync.
          served = standIn!.file;
          outcome = "unsynced stand-in";
          fallback = standIn!.ref;
          final = false;
          usedSync = undefined;
          timing = "";
        } else if (usedSync?.noFit) {
          // Judged another file's, and no fallback fits: its lines aren't sent. Not kept, so a fallback
          // that syncs later, or more of the file heard, reaches the next request.
          notThisFile = true;
          outcome = "another file's, not sent";
          final = false;
          count("downloads.notThisFile");
        }
      }

      const ext = notThisFile ? ".srt" : path.extname(served).toLowerCase();
      // As the link's name says: players that go by it (Jellyfin through AIOMetadata) read the file as
      // that format. SRT unless the link keeps ASS styling or carries a style ("subtitle.ass", see downloadUrl).
      const asAss = /\.(ass|ssa)$/i.test(param(req.params.filename));
      const raise = Number(typeof req.query.raise === "string" ? req.query.raise : "");
      const raised = asAss && Number.isInteger(raise) && raise >= RAISE_MIN && raise <= RAISE_MAX ? raise : undefined;
      // Any look this server can draw: a preset's name, or one with a style's own changes on it (lookOf).
      const look = asAss && typeof req.query.look === "string" && lookOf(req.query.look) ? req.query.look : undefined;
      // Sound descriptions come out of the text sent, after the timing: the sync never sees the difference.
      const decoded = sourceSilent ? SOURCE_SILENT : notThisFile ? NOT_THIS_FILE : decodeSubtitle(await readFile(served), lang);
      const text = req.query.sounds === "0" && !notThisFile ? withoutSounds(decoded, ext) : decoded;
      // A look's order: the downloaded subtitle's own styling (Keep the subtitle's own styling: `own=1`, or
      // an ASS link with no other reason to be one, which a list made by an older version still holds), then
      // the playing file's own subtitle style (filestyle=1), then the style's look, then the plain look.
      const keepsOwn = req.query.own === "1" || (req.query.raise === undefined && req.query.look === undefined && req.query.signs !== "1" && req.query.filestyle !== "1");
      const uploadStyle = keepsOwn && !notThisFile && (req.query.signs === "1" || req.query.filestyle === "1") && /^\.(ass|ssa)$/.test(ext) ? dialogueStyleOf(text) : undefined;
      // Signs & songs with English Dub (signs=1) and the file's own style (filestyle=1): one script of the
      // signs and the dub's lines, each waited on for at most STYLE_WAIT_MS. Signs still being found or
      // timed by then: sent without, and not kept, so the next request has them; signs that a signs track
      // may still replace: sent, and not kept either. A subtitle with styling of its own that it keeps
      // goes as it is, or, merged with signs, has its lines in its own dialogue style.
      let merged: ReturnType<typeof mergeWithSigns> | undefined;
      let signsFrom: string | undefined;
      let styledBy: "file" | "subtitle" | undefined;
      const wantsSigns = !notThisFile && asAss && req.query.signs === "1" && !lang && Boolean(vid && file);
      const wantsOwn = !notThisFile && asAss && req.query.filestyle === "1" && !uploadStyle && Boolean(profile.aiostreamsUrl && vid && type && file);
      if (wantsSigns || wantsOwn) {
        // The dub's own lines go first: they wait at most STYLE_WAIT_MS for signs or a style still on their way.
        const left = Math.min(STYLE_WAIT_MS, Math.max(0, deadline - Date.now()));
        const [signs, own] = await Promise.all([
          wantsSigns ? readySigns(vid, file, left) : Promise.resolve(undefined),
          wantsOwn && profile.aiostreamsUrl ? fileOwnStyle(profile.aiostreamsUrl, vid, type, file, left) : Promise.resolve(undefined)
        ]);
        if (signs === "pending" || (signs && !signs.settled)) final = false;
        const found = signs && signs !== "pending" ? signs : undefined;
        if (found || own) {
          merged = mergeWithSigns({ dub: text, ext, signs: found?.script, own: (found && uploadStyle) || own, look: look ? lookOf(look) : undefined, raise: raised, maxBytes: MAX_MERGED_BYTES });
          if (merged.dropped.heavy || merged.dropped.plained) {
            count("downloads.signsTooHeavy");
            console.log(`download ${ref}: the signs are too heavy to send whole: ${merged.dropped.plained ?? 0} of the songs' events made plain lyric lines, ${merged.dropped.heavy ?? 0} events left out, by style, the songs first`);
          }
          if (found) signsFrom = `${found.signsName}, ${found.release}`;
          styledBy = found && uploadStyle ? "subtitle" : own ? "file" : undefined;
        }
      }
      // The playing file isn't in AIOStreams' list (a release its host no longer has, replaced by
      // another under the same link): the subtitle goes as it came, and its first line says why, since
      // the track's name was written before that was known. Not kept, so a later request is tried again.
      const unfound = !usedSync && !notThisFile && Boolean(profile.aiostreamsUrl && vid && file) && notListed(file);
      if (unfound) {
        final = false;
        outcome = `${outcome}: the playing file isn't in AIOStreams' list`;
        count("downloads.fileNotFound");
      }
      const made = merged ? merged.text : asAss ? toAss(text, ext, raised, look, keepsOwn) : toSrt(text, ext);
      // Songs set piece by piece in a font players lack, laid out again in one they have (respace.ts).
      // Done when the subtitle was synced or its signs kept (laidOutForPlayers); here only for one saved before that.
      const respaced = (merged || asAss) && !laidOut(made) ? respaceSongs(made) : undefined;
      // Right-to-left signs typed in screen order, marked so that every renderer keeps that order (rtl.ts):
      // a fraction of a millisecond for a script without any, so it is done here, however the script was saved.
      const laid = respaced?.text ?? made;
      const ordered = merged || asAss ? (keptInScreenOrder(laid)?.text ?? laid) : laid;
      // Then its right-to-left lines said to be so, for a renderer that lays every line out left to right (rtl.ts).
      const sentText = merged || asAss ? (readRightToLeft(ordered)?.text ?? ordered) : ordered;
      const body = Buffer.from(unfound ? withNotice(sentText, Boolean(merged) || asAss, FILE_NOT_FOUND) : sentText, "utf8");

      const release = listedRelease(fallback ?? ref);
      res.locals.activity = {
        kind: "download",
        what,
        result: outcome,
        detail: {
          source: sourceOfRef(fallback ?? ref),
          ref: fallback ?? ref,
          ...(listedRef !== ref ? { listed: listedRef } : {}),
          ...(fallback ? { fallback } : {}),
          ...(usedSync ? { timing: describeTiming(usedSync), ...fitOf(usedSync), ...howTimed(usedSync) } : {}),
          ...playedFile(file, vid),
          ...(lang ? { lang } : {}),
          ...(release ? { release } : {}),
          ...(signsFrom && merged ? { signs: signsFrom, signsDropped: merged.dropped } : {}),
          ...(styledBy ? { styled: styledBy } : {}),
          ...(respaced ? { respaced: respaced.lines } : {})
        }
      };
      // One line per download: which subtitle went to which file, and how it was timed.
      console.log(
        `[${profile.name}] download ${ref}${season !== undefined ? ` S${season}E${episode ?? "?"}` : ""} ${lang0 ?? "English Dub"}${file ? ` file=${file}` : ""}: ${outcome}${timing ? ` (${timing})` : ""}${final ? "" : ", not kept"} in ${Date.now() - (deadline - DOWNLOAD_BUDGET_MS)} ms`
      );
      // Kept only when it's synced (or sync isn't asked for): a subtitle left unsynced may sync later (a
      // fallback, better rules). A synced one is kept an hour, not for good, so timing that better rules
      // redo reaches a player that plays the same file again, for one quick request (the synced file is
      // stored). Past the hour, a player that supports it keeps its copy while this server can't be reached.
      const syncAsked = Boolean(profile.aiostreamsUrl && vid && type && file);
      const keep = final && (!syncAsked || outcome.startsWith("synced"));
      res.set("Cache-Control", keep ? "public, max-age=3600, stale-if-error=2592000" : "no-store");
      res.set("Content-Disposition", `inline; filename="${(subtitle?.filename ?? "subtitle.srt").replace(/"/g, "").replace(/\.(srt|ass|ssa|vtt)$/i, asAss ? ".ass" : ".srt")}"`);
      res.type(asAss ? "text/x-ssa; charset=utf-8" : "text/plain; charset=utf-8");
      // A big script (signs typeset frame by frame run to many MB) goes compressed to a player that takes it.
      // Calibration (a merged episode with motion-tracked signs): 17.0 MB, 3.0 MB gzipped.
      res.set("Vary", "Accept-Encoding");
      const gzip = body.length > GZIP_FROM_BYTES && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      (res.locals.activity.detail as ActivityDetail).sent = { format: asAss ? "ass" : "srt", bytes: body.length, kept: keep, ...(gzip ? { gzip: true } : {}) };
      if (gzip) {
        res.set("Content-Encoding", "gzip");
        res.send(gzipSync(body));
      } else res.send(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createApp(): express.Express {
  // Settings changed on the dashboard, over .env's (see settings.ts).
  loadSettings();
  const app = express();
  // A reverse proxy's X-Forwarded-For and -Proto are believed only from proxies on this machine or a
  // private network (Docker, LAN): someone reaching the port directly can't pick their own address
  // to dodge the sign-in lockout.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  // No page of this server is drawn inside another site's frame, and no answer is read as another type
  // than it says: the dashboard and setup act on a click, and a framed page can be clicked through.
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });

  // Bubs' head: alone (mark.png), on a rounded tile for tabs (favicon.png), and on a full tile for addon lists
  // and the home-screen app (logo.png; see LOGO_URL).
  for (const [route, file] of [["/mark.png", "bttr-subs-mark.png"], ["/favicon.png", "bttr-subs-favicon-64.png"], ["/logo.png", "bttr-subs-logo-512.png"]]) {
    app.get(route, (_req, res) => {
      res.set("Cache-Control", "public, max-age=86400");
      res.sendFile(fileURLToPath(new URL(`../assets/${file}`, import.meta.url)));
    });
  }

  // Each source's icon, from this server (never the source's site): a month in the cache, a new ?v= when one changes.
  app.get("/sources/:file", (req, res) => {
    const id = req.params.file.replace(/\.png$/, "");
    if (!req.params.file.endsWith(".png") || !(SOURCE_ICONS as readonly string[]).includes(id)) {
      res.status(404).type("text").send("Not found");
      return;
    }
    res.set("Cache-Control", "public, max-age=2592000, immutable");
    res.sendFile(fileURLToPath(new URL(`../assets/sources/${id}.png`, import.meta.url)));
  });

  // The pages' own styles, scripts and fonts (assets/ui).
  app.use("/ui", serveUi);

  // The pages as a home-screen app: the dashboard's for its owner, setup's for everyone else (see webManifest).
  for (const start of ["/dashboard", "/configure"] as const) {
    app.get(`/app${start}/manifest.json`, (_req, res) => {
      res.set("Cache-Control", "public, max-age=86400");
      res.type("application/manifest+json").send(JSON.stringify(webManifest(start)));
    });
  }

  app.get("/", (_req, res) => {
    res.redirect("/configure");
  });

  // Signing in and out (ADDON_PASSWORD, ADMIN_PASSWORD).
  app.use(accessRoutes());

  // The dashboard (usage, health, links and settings): ADMIN_PASSWORD, or a login at the proxy, since it lists what was played.
  app.get("/dashboard", statsGate, async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.set("Referrer-Policy", "no-referrer");
      res.type("html").send(dashboardPage(dashboardData(await statsView(MANIFEST.version), Date.now(), await anidbNow()), { csrf: csrfToken(req), signedIn: sessionRoles(req).length > 0 }));
    } catch (error) {
      next(error);
    }
  });

  // The dashboard's data again, for its Refresh button and after each change. Behind the same password.
  app.get("/dashboard/data", statsGate, async (_req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(dashboardData(await statsView(MANIFEST.version), Date.now(), await anidbNow()));
    } catch (error) {
      next(error);
    }
  });

  // The kept log files, oldest first, as one text file for a bug report (addresses cut to their host).
  app.get("/dashboard/logs", statsGate, async (_req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.type("text/plain; charset=utf-8").attachment(`bttrsubs-logs-${new Date().toISOString().slice(0, 10)}.txt`);
      await sendLogs(res);
    } catch (error) {
      next(error);
    }
  });

  // Diagnostics for troubleshooting (diagnostics.ts): one request's, named by its time and configuration
  // as the activity gives them, or the server's and its newest requests'.
  app.get("/dashboard/diagnostics", statsGate, async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      const at = Number(req.query.at);
      const link = typeof req.query.link === "string" && req.query.link.length <= 64 ? req.query.link : undefined;
      const text = await diagnosticsText(MANIFEST.version, Number.isFinite(at) && at > 0 && link ? { at, link } : undefined);
      console.log(`dashboard: diagnostics copied (${link && at ? `a request of ${link}` : "the server's"})`);
      res.type("text/plain; charset=utf-8").send(text);
    } catch (error) {
      next(error);
    }
  });

  // A link's configure page, opened from the dashboard by the link's id: the page itself never holds a token.
  app.get("/dashboard/links/configure", statsGate, (req, res) => {
    const to = typeof req.query.link === "string" ? configurePathOf(req.query.link) : undefined;
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    if (!to) {
      res.status(404).type("text").send("That configuration isn't known here any more. Reload the dashboard.");
      return;
    }
    res.redirect(303, to);
  });

  // Everything the dashboard changes: a POST, from the dashboard itself, by the admin (see adminWrite).
  const body = [express.json({ limit: "8kb" }), express.urlencoded({ extended: false, limit: "4kb" })];
  const wantsJson = (req: Request) => req.is("application/json") === "application/json";

  /** A clear's one link, from ?link= (a link id: letters, digits and . _ - /), or none for all of them. */
  const linkParam = (req: Request): string | undefined => {
    const link = typeof req.query.link === "string" ? req.query.link : undefined;
    return link && link.length <= 120 && /^[\w./-]+$/.test(link) ? link : undefined;
  };

  // Clearing the dashboard's recent errors, or undoing that: JSON for the page's script, the dashboard for a plain form.
  app.post("/dashboard/errors/clear", ...body, ...adminWrite, async (req, res, next) => {
    try {
      const link = linkParam(req);
      if (link) {
        if (req.query.undo === "1") await undoClearLinkErrors(link);
        else await clearLinkErrors(link);
      } else if (req.query.undo === "1") await undoClearErrors();
      else await clearErrors();
      if (wantsJson(req)) res.json({ ok: true });
      else res.redirect(303, "/dashboard#errors");
    } catch (error) {
      next(error);
    }
  });

  // Clearing the activity log, or undoing that: the log and the 24-hour track start after it.
  app.post("/dashboard/activity/clear", ...body, ...adminWrite, async (req, res, next) => {
    try {
      const link = linkParam(req);
      if (link) {
        if (req.query.undo === "1") await undoClearLinkActivity(link);
        else await clearLinkActivity(link);
      } else if (req.query.undo === "1") await undoClearActivity();
      else await clearActivity();
      if (wantsJson(req)) res.json({ ok: true });
      else res.redirect(303, "/dashboard#settings");
    } catch (error) {
      next(error);
    }
  });

  // Errors and activity cleared together, for everything or one configuration (?link=); each is undone on its own.
  app.post("/dashboard/clear", ...body, ...adminWrite, async (req, res, next) => {
    try {
      const link = linkParam(req);
      if (link) {
        await clearLinkErrors(link);
        await clearLinkActivity(link);
      } else {
        await clearErrors();
        await clearActivity();
      }
      if (wantsJson(req)) res.json({ ok: true });
      else res.redirect(303, "/dashboard#settings");
    } catch (error) {
      next(error);
    }
  });

  // Server settings: { set: { timeZone: "Europe/London", … } } or { reset: ["timeZone"] }. Answers with the
  // settings as they now are, and a fresh CSRF token when a password change re-signed the session.
  app.post("/dashboard/settings", ...body, ...adminWrite, async (req, res, next) => {
    try {
      if (!wantsJson(req)) {
        res.status(415).json({ error: "Send JSON" });
        return;
      }
      // The session's roles before the change: a new configure-page password changes the session key.
      const before = addonPasswordFingerprint();
      const roles = sessionRoles(req);
      const input = (req.body ?? {}) as { set?: unknown; reset?: unknown };
      const result =
        input.reset !== undefined
          ? resetSettings(input.reset)
          : input.set && typeof input.set === "object" && !Array.isArray(input.set)
            ? await changeSettings(input.set as Record<string, unknown>)
            : ({ error: "Nothing to change" } as const);
      if ("error" in result) {
        res.status(400).json(result);
        return;
      }
      // Key names only: the values (a password above all) never go in a log.
      if (result.changed.length) console.log(`dashboard: settings ${input.reset !== undefined ? "reset" : "changed"} (${result.changed.join(", ")})`);
      const csrf = addonPasswordFingerprint() !== before ? renewSession(req, res, roles) : csrfToken(req);
      res.json({ ok: true, changed: result.changed, csrf, settings: dashboardSettings(), settingsStatus: settingsStatus(await anidbNow()) });
    } catch (error) {
      next(error);
    }
  });

  // Managing a link by its id: { link, name } to rename, { link, paused } to pause or resume, { link, confirm: link } to delete.
  const linkAction = (run: (link: string, body: Record<string, unknown>) => LinkChange | { error: string; status: number }) =>
    (req: Request, res: Response, next: express.NextFunction) => {
      try {
        if (!wantsJson(req)) {
          res.status(415).json({ error: "Send JSON" });
          return;
        }
        const input = (req.body ?? {}) as Record<string, unknown>;
        const link = typeof input.link === "string" ? input.link : "";
        if (!link || link.length > 80 || !Object.hasOwn(knownLinks(), link)) {
          res.status(404).json({ error: "That configuration isn't known here any more. Reload the dashboard" });
          return;
        }
        const result = run(link, input);
        if ("error" in result) {
          res.status(result.status).json({ error: result.error });
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    };
  app.post("/dashboard/links/rename", ...body, ...adminWrite, linkAction((link, input) => {
    if (input.name !== undefined && typeof input.name !== "string") return { error: "Name: text, or empty for none", status: 400 };
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const result = renameLink(link, name || undefined);
    if ("ok" in result) {
      setLinkLabel(link, name || undefined);
      console.log(`dashboard: link ${link} renamed`);
    }
    return result;
  }));
  app.post("/dashboard/links/pause", ...body, ...adminWrite, linkAction((link, input) => {
    if (typeof input.paused !== "boolean") return { error: "Pause: true or false", status: 400 };
    const result = setPaused(link, input.paused);
    if ("ok" in result) console.log(`dashboard: link ${link} ${input.paused ? "paused" : "resumed"}`);
    return result;
  }));
  // A configuration's install URL, for the Copy install URL button: sent only when asked, never in the page.
  app.post("/dashboard/links/install-url", ...body, ...adminWrite, (req, res) => {
    const link = typeof req.body?.link === "string" ? req.body.link : "";
    const url = link && link.length <= 80 ? installUrlOf(link) : undefined;
    if (!url) {
      res.status(404).json({ error: config.publicBaseUrl ? "That configuration isn't known here any more. Reload the dashboard" : "This server has no PUBLIC_BASE_URL set" });
      return;
    }
    console.log(`dashboard: install URL of ${link} copied`);
    res.json({ url });
  });
  app.post("/dashboard/links/delete", ...body, ...adminWrite, linkAction((link, input) => {
    // The page asks first; the request repeats the link's id, so a stray click can't delete another.
    if (input.confirm !== link) return { error: "Confirm by naming the configuration", status: 400 };
    const result = deleteLink(link);
    if ("ok" in result) console.log(`dashboard: link ${link} deleted`);
    return result;
  }));

  const routes = addonRoutes();

  // Settings come from the path AIOStreams builds (see profile.ts); the router then sees only the resource.
  app.use((req, res, next) => {
    const routed = routePath(req.path);
    if (!routed) {
      res.status(404).json({ error: "Unknown configuration. Open /configure to make one" });
      return;
    }
    res.locals.profile = routed.profile;
    res.locals.settings = routed.settings;
    res.locals.token = routed.token;
    res.locals.lapsed = routed.lapsed === true;
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    req.url = routed.resource + query;
    const link = (routed.profile as Profile | undefined)?.name;
    if (!link) {
      next();
      return;
    }
    // Everything this request starts (searches, downloads, syncs) is counted for its link, and a
    // list or download handler leaves a line for the recent-activity list.
    const owner = routed.profile as Profile;
    noteLinkKeys(link, [["subsource", owner.subsourceKey], ["subdl", owner.subdlKey], ["wyzie", owner.wyzieKey]]);
    noteLinkLabel(link, owner.label);
    // The dashboard's Edit opens the link a player or AIOStreams last used: its subtitle lists and
    // downloads count, a configure page someone opened doesn't (an old or copied link stays out).
    if (routed.token && /^\/(subtitles|download)\//.test(routed.resource)) noteLinkToken(link, routed.token);
    const started = Date.now();
    // The request's id: its activity row and any error noted while its work goes on (a source that
    // fails after the list went out, say) carry it, so the dashboard can show one from the other.
    const id = randomBytes(6).toString("base64url");
    // Who asked: a player, or a server asking for one (AIOStreams), by its own name for itself.
    const client = clientOf(req.get("user-agent"));
    res.on("finish", () => {
      const note = res.locals.activity as { kind: "list" | "download"; what: string; result: string; detail?: ActivityDetail } | undefined;
      // A list AIOStreams has stopped waiting for is dropped whole: the viewer sees no subtitles from
      // it, and here it looks like any list that went out. Noted as an error, for the one being played.
      const took = Date.now() - started;
      if (note?.kind === "list" && !note.detail?.ahead && client?.startsWith("AIOStreams") && took > entryTimeoutMs()) {
        count("lists.afterTimeout");
        noteError("list", new Error(`The list took ${(took / 1000).toFixed(1)} s to answer: AIOStreams waits ${(entryTimeoutMs() / 1000).toFixed(1)} s for it, then shows none of its subtitles until the episode is opened again.`), note.what);
      }
      if (note)
        noteActivity({
          ...note,
          ...(client || note.detail ? { detail: { ...note.detail, ...(client ? { client } : {}) } } : {}),
          link,
          req: id,
          ms: Date.now() - started,
          result: res.statusCode >= 400 && !note.result.startsWith("error") ? `error ${res.statusCode}` : note.result
        });
    });
    requestContext.run({ link, req: id }, next);
  }, routes);

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    // Messages can carry upstream bodies, never keys; the token stays out of logs (no URL logging).
    const message = error instanceof Error ? error.message : "Unexpected error";
    noteError("request", error, (res.locals.activity as { what?: string } | undefined)?.what);
    if (error instanceof Error && error.name === "EpisodeNotInPack") {
      if (res.locals.activity) res.locals.activity.result = "not in this pack";
      res.status(404).json({ error: "This subtitle pack doesn't have this episode" });
      return;
    }
    if (error instanceof Error && error.name === "WrongLanguage") {
      if (res.locals.activity) res.locals.activity.result = "in another language";
      res.status(404).json({ error: "This subtitle is in another language than it is listed under" });
      return;
    }
    console.error(message);
    res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
