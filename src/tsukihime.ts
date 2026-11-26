/**
 * TsukiHime (tsukihime.org): an index of anime releases that keeps every subtitle track of every file
 * it has processed, with the track's language and title, behind an open API with no key. It also holds
 * the archive Anime Tosho gathered.
 *
 * A release carries its subtitles in every language its service made them in, so this source answers
 * for any language asked: the episode's releases are listed, the ones holding a wanted language are
 * opened, and each such track becomes a subtitle. A track of the release being played is the playing
 * file's own; a track of another release is timed to it like any other subtitle.
 *
 * The episode is found by the show's AniDB id (from the anime lists this server already keeps, by its
 * IMDb id): the show's entry there, then that entry's episode. A show the lists don't hold is searched
 * by name. Its Torznab search answers nothing by IMDb or Kitsu id.
 *
 * Its documentation asks for fair use: "around 200 requests/minute per IP; slow down on 429 and honor
 * Retry-After". Every request goes through the gate in pace.ts at half that.
 */
import { animeEpisode } from "./animelists.js";
import { type SignsSource, videoSource } from "./animetosho.js";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { languageCode } from "./langcodes.js";
import { extractEpisodeMarkers } from "./matching.js";
import { readCapped } from "./net.js";
import { paced, type Pace } from "./pace.js";
import { count, noteError } from "./stats.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";
import { unxz } from "./xz.js";

export const TSUKIHIME_API = "https://api.tsukihime.org/v1";
export const TSUKIHIME_STORAGE = "https://storage.tsukihime.org";
const HEADERS = { accept: "application/json", "user-agent": "BttrSubs" };

/**
 * Its pace here. Calibration (its documentation): 200 requests a minute an address; half of it is
 * used, since everyone on a server shares the server's address.
 */
export const tsukihimePace: Pace = { perMinute: 100, inFlight: 3, pausedMs: 60_000, maxWaitMs: 6000 };

/** An episode's list of releases is kept this long; a show's entry, which doesn't change, a month. */
const EPISODE_TTL_S = 12 * 60 * 60;
const ANIME_TTL_S = 30 * 24 * 60 * 60;
/** A release's files and tracks don't change once it is processed. */
const RELEASE_TTL_S = 30 * 24 * 60 * 60;
/** Releases opened for an episode at most (each a request), likeliest first. */
const MAX_RELEASES = 4;
/**
 * And as many more for the dub's captions, when English is asked for: releases with English audio and
 * an English subtitle track that took none of those places.
 * Calibration (10 episodes whose dub captions came from the dub's own release): the episode's list
 * held 7 to 12 releases with English audio, the dub's own among them every time, and the 4 places
 * by language went to it once.
 */
const DUB_RELEASES = 2;
/**
 * A subtitle track unpacks to a few hundred KB, and a signs track that sets its songs frame by frame to
 * many MB: the same most as for the same archive's tracks fetched from Anime Tosho (animetosho.ts).
 */
const MAX_TRACK_BYTES = 32_000_000;
/** And packed, a quarter of that at most. */
const MAX_PACKED_BYTES = 8_000_000;

interface Release {
  id: number;
  name: string;
  totalsize?: number;
  audiolangs?: string[];
  sublangs?: string[];
  animetosho?: boolean;
}
interface Attachment {
  id: number;
  type: number;
  info?: { codec?: string; lang?: string; name?: string; forced?: number; default?: number };
}
interface ReleaseFile {
  id: number;
  filename: string;
  size?: number;
  attachments?: Attachment[];
}

/** One JSON answer, kept for `ttl`; undefined when the service refuses, fails or isn't asked (pace.ts). */
async function getJson<T>(path: string, ttl: number): Promise<T | undefined> {
  const key = cacheKey({ kind: "tsukihime", path });
  // Paths asked for side by side take their turn at the gate in the order they were asked: each looks
  // in the cache once the one before it has, or whichever read of the disk ended first would go first.
  const before = entering;
  let entered!: () => void;
  entering = new Promise<void>((resolve) => (entered = resolve));
  await before;
  try {
    const kept = await readJsonCache<T>("results", key);
    if (kept !== undefined) return kept;
    // Asked for by a list and by the signs' search at once, a path is asked once: both take that answer.
    const under = asking.get(path) as Promise<T | undefined> | undefined;
    if (under) return under;
    const work = ask<T>(path, key, ttl).finally(() => asking.delete(path));
    asking.set(path, work);
    return work;
  } finally {
    entered();
  }
}

/** The cache look of the path asked for last: the next one's waits for it (see getJson). */
let entering: Promise<void> = Promise.resolve();

/** Paths being asked right now, by path. */
const asking = new Map<string, Promise<unknown>>();

async function ask<T>(path: string, key: string, ttl: number): Promise<T | undefined> {
  try {
    const asked = Date.now();
    let sent = asked;
    const response = await paced("tsukihime", tsukihimePace, () => {
      count("api.tsukihime");
      sent = Date.now();
      return fetch(`${TSUKIHIME_API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    });
    // Where a look-up's time goes: its turn at the gate, then the service's answer.
    console.log(`tsukihime: ${path.split("?")[0]} waited ${sent - asked} ms for its turn, answered in ${Date.now() - sent} ms: HTTP ${response.status}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as T;
    await writeJsonCache("results", key, body, ttl);
    return body;
  } catch (error) {
    if ((error as Error).name !== "HeldBack") {
      count("api.tsukihime.fail");
      noteError("tsukihime", error);
    }
    return undefined;
  }
}

/** Whether a track's language code ("en", "zh-Hans", "pt-BR") is the one a language name here goes by ("en", "zh-cn", "pt-br"). */
export function sameLanguage(theirs: string | undefined, ours: string | undefined): boolean {
  if (!theirs || !ours) return false;
  const a = theirs.toLowerCase();
  const b = ours.toLowerCase();
  if (a === b) return true;
  // Chinese is two scripts; a track marked only "zh" doesn't say which, and is taken for either.
  const chinese = (c: string) => (/^zh-(hans|cn|sg)$/.test(c) ? "simplified" : /^zh-(hant|tw|hk)$/.test(c) ? "traditional" : c === "zh" ? "either" : undefined);
  if (chinese(a) && chinese(b)) return chinese(a) === "either" || chinese(b) === "either" || chinese(a) === chinese(b);
  // Portugal's and Brazil's are two languages here; a bare "pt" is Portugal's.
  if (a.startsWith("pt") || b.startsWith("pt")) return (a === "pt" ? "pt-pt" : a) === (b === "pt" ? "pt-pt" : b);
  return a.split("-")[0] === b.split("-")[0] && (a.length === 2 || b.length === 2);
}

/** A track that isn't a language's full subtitles: the lines shown with a dub (signs, songs), by its mark or its title. */
const PARTIAL = /\b(forced|signs?|songs?|s&s|karaoke|typeset)\b/i;
/** A track named as captions of what is said: the dub's, on a release with English voices. */
const CAPTIONS = /\b(cc|sdh|closed|captions?|dub|dubtitles?)\b/i;

/** Whether a season and episode a name gives are this episode's: its own, or the episode's number across the show under season 1 or none. */
const sameEpisode = (m: { season: number; episode: number }, request: StremioSubtitleRequest) =>
  (m.season === request.season && m.episode === request.episode) || (request.absoluteEpisode !== undefined && m.season <= 1 && m.episode === request.absoluteEpisode);

/** Whether a file's name is this episode's: by a season and episode it gives, or by the episode's number across the show. */
function isEpisode(name: string, request: StremioSubtitleRequest): boolean {
  return extractEpisodeMarkers(name).some((m) => sameEpisode(m, request));
}

/**
 * Whether a name gives a season and episode and none of them is this one: a release the service files
 * under the episode by its number alone ("Show 130 - S03E28" under episode 28) may be another
 * episode's, or one that numbers its seasons another way. A name with no season and episode
 * ("Show - 28") says nothing either way.
 */
function namesAnotherEpisode(name: string, request: StremioSubtitleRequest): boolean {
  const markers = extractEpisodeMarkers(name);
  return markers.length > 0 && !markers.some((m) => sameEpisode(m, request));
}

const bare = (name: string) => name.toLowerCase().replace(/\.(mkv|mp4|avi)$/, "");

/** Every release TsukiHime lists under the episode, by the show's AniDB entry; undefined when the lists don't place the episode or it doesn't answer. */
async function listedReleases(request: StremioSubtitleRequest): Promise<Release[] | undefined> {
  const placed = request.imdbId && request.season !== undefined && request.episode ? await animeEpisode(request.imdbId, request.season, request.episode).catch(() => undefined) : undefined;
  if (!placed) return undefined;
  const anime = await getJson<{ id?: number; anime?: { id?: number }; results?: Array<{ id?: number }> }>(`/animes/anidb/${placed.anidbId}`, ANIME_TTL_S);
  const id = anime?.id ?? anime?.anime?.id ?? anime?.results?.[0]?.id;
  if (!id) return undefined;
  return (await getJson<{ results?: Release[] }>(`/animes/${id}/episodes/${placed.episode}?limit=100`, EPISODE_TTL_S))?.results;
}

/**
 * How many of the episode's releases could hold the dub's captions: English audio and an English
 * subtitle track, by the list's own word for each release. Undefined when the episode's list isn't
 * known. With none, no release anywhere in this archive has them, and the archive is Anime Tosho's too.
 */
export async function dubReleasesListed(request: StremioSubtitleRequest): Promise<number | undefined> {
  const all = await listedReleases(request);
  if (!all?.length) return undefined;
  const has = (codes: string[] | undefined) => (codes ?? []).some((code) => sameLanguage(code, "en"));
  return all.filter((r) => has(r.audiolangs) && has(r.sublangs)).length;
}

/** The episode's releases: by the show's AniDB entry when the lists place the episode, else by the show's name. */
async function episodeReleases(request: StremioSubtitleRequest, showName: string | undefined): Promise<Release[]> {
  // The ones whose names give another episode go last, so they take a place only when no other release wants it.
  const all = await listedReleases(request);
  if (all?.length) return [...all.filter((r) => !namesAnotherEpisode(r.name, request)), ...all.filter((r) => namesAnotherEpisode(r.name, request))];
  if (!showName || request.season === undefined || !request.episode) return [];
  // Its search takes words, a phrase in quotes, | and a leading -: the show's name as plain words, then the episode as releases write it.
  const words = showName.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (words.length < 2) return [];
  const q = `${words} S${String(request.season).padStart(2, "0")}E${String(request.episode).padStart(2, "0")}`;
  const found = await getJson<{ results?: Release[] }>(`/search/torrents?q=${encodeURIComponent(q)}&limit=50`, EPISODE_TTL_S);
  return (found?.results ?? []).filter((r) => isEpisode(r.name, request));
}

/**
 * The subtitles TsukiHime holds for an episode in the languages asked, by their names here
 * ("english", "arabic", "portuguese (br)"). English tracks named as captions on a release with
 * English voices are the dub's, and are worded so (the ranking reads the wording); every other full
 * track is its language's subtitles. Tracks of signs and songs alone are left out.
 */
export function tsukihimeSubtitles(request: StremioSubtitleRequest, showName: string | undefined, languages: string[]): Promise<SubSourceSubtitle[]> {
  const work = lookUp(request, showName, languages).finally(() => lookUps.delete(work));
  lookUps.add(work);
  return work;
}

/**
 * The episode's list of releases, asked for as a list starts: it needs the episode's place in the
 * anime lists and nothing else, so it is in by the time the look-up has the show's name and season
 * map. A show the lists don't place is asked nothing.
 */
export function tsukihimeAhead(request: StremioSubtitleRequest): void {
  if (request.type !== "series") return;
  const work: Promise<unknown> = listedReleases(request).catch(() => undefined).finally(() => lookUps.delete(work));
  lookUps.add(work);
}

/**
 * Lists' look-ups under way. A viewer waits on a list and on nothing else here, and every request goes
 * through one gate (pace.ts): the signs' search stands aside while any is running (listsFirst).
 * Calibration (first plays on a server with nothing kept): with the signs' search asking beside the
 * list's look-up, that look-up took 6 to 16 s where it takes 2 to 3 s alone.
 */
const lookUps = new Set<Promise<unknown>>();
async function listsFirst(): Promise<void> {
  while (lookUps.size) await Promise.allSettled([...lookUps]);
}

async function lookUp(request: StremioSubtitleRequest, showName: string | undefined, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (request.type !== "series") return [];
  const wanted = languages.map((name) => ({ name, code: languageCode(name) })).filter((l): l is { name: string; code: string } => Boolean(l.code));
  if (wanted.length === 0) return [];
  const releases = await episodeReleases(request, showName);
  const holds = (r: Release) => wanted.filter((l) => (r.sublangs ?? []).some((code) => sameLanguage(code, l.code))).length;
  const playing = request.filename ? bare(request.filename) : undefined;
  const isPlaying = (r: Release) => (playing !== undefined && bare(r.name) === playing) || (request.videoSize !== undefined && String(r.totalsize ?? "") === String(request.videoSize));
  const byLanguage = releases
    .filter((r) => holds(r) > 0)
    .sort((a, b) => Number(isPlaying(b)) - Number(isPlaying(a)) || holds(b) - holds(a))
    .slice(0, MAX_RELEASES);
  // The dub's captions are in the releases the dub is in: with English asked for, those get places of
  // their own, a release whose only audio is English first (the dub's own), then ones with more audio.
  const english = (r: Release) => (r.sublangs ?? []).some((code) => sameLanguage(code, "en"));
  const forDub = wanted.some((l) => l.code === "en")
    ? releases
        .filter((r) => !byLanguage.includes(r) && english(r) && (r.audiolangs ?? []).some((code) => sameLanguage(code, "en")))
        .sort((a, b) => Number(isPlaying(b)) - Number(isPlaying(a)) || Number(englishOnly(b.audiolangs)) - Number(englishOnly(a.audiolangs)))
        // One release at two picture sizes holds the same tracks: one place for both.
        .filter((r, i, all) => all.findIndex((other) => otherSizes(other.name) === otherSizes(r.name)) === i)
        .slice(0, DUB_RELEASES)
    : [];
  const open = [...byLanguage, ...forDub];
  const out: SubSourceSubtitle[] = [];
  const seen = new Set<string>();
  // Every release is asked for at once, as many at a time as the gate lets through (pace.ts), and read in order.
  // Calibration (six releases of one episode): 1.5 s asked one after another, 0.5 s three at a time.
  const details = open.map((release) => getJson<{ files?: ReleaseFile[]; animetosho?: boolean; audiolangs?: string[] }>(`/torrents/${release.id}`, RELEASE_TTL_S));
  for (const [at, release] of open.entries()) {
    const detail = await details[at];
    const files = detail?.files ?? [];
    const file = files.length === 1 ? files[0] : files.find((f) => isEpisode(f.filename, request));
    if (!file) continue;
    const audio = detail?.audiolangs ?? release.audiolangs ?? [];
    const dubbed = audio.some((code) => sameLanguage(code, "en"));
    // The one English text track of a file whose every voice is English is its captions, named so or not.
    const fullEnglish = (file.attachments ?? []).filter((t) => t.type === 1 && /^(ass|ssa|srt|vtt)$/i.test(t.info?.codec ?? "") && sameLanguage(t.info?.lang, "en") && t.info?.forced !== 1 && !PARTIAL.test(t.info?.name ?? ""));
    const onlyCaptions = englishOnly(audio) && fullEnglish.length === 1 ? fullEnglish[0] : undefined;
    for (const track of file.attachments ?? []) {
      const info = track.info ?? {};
      if (track.type !== 1 || !track.id || !/^(ass|ssa|srt|vtt)$/i.test(info.codec ?? "")) continue;
      const language = wanted.find((l) => sameLanguage(info.lang, l.code));
      const title = (info.name ?? "").trim();
      if (!language || info.forced === 1 || PARTIAL.test(title)) continue;
      const ref = `th${detail?.animetosho || release.animetosho ? "t" : ""}${track.id}`;
      if (seen.has(`${ref}|${language.name}`)) continue;
      seen.add(`${ref}|${language.name}`);
      const captions = language.code === "en" && dubbed && (CAPTIONS.test(title) || track === onlyCaptions);
      out.push({
        subtitleId: 0,
        ref,
        source: "tsukihime",
        ...(/^(ass|ssa)$/i.test(info.codec ?? "") ? { styled: true } : {}),
        movieId: 0,
        language: language.name,
        releaseInfo: [file.filename.replace(/\.(mkv|mp4)$/i, ""), ...(files.length === 1 && release.name !== file.filename ? [release.name] : [])],
        // What it is, in the words the ranking reads: a dub's captions are named so, a translation never is.
        commentary: captions ? `English Dub captions: the release's own "${title || "English"}" track` : `The release's own ${title ? `"${title}" ` : ""}subtitle track`,
        ...(captions ? { productionType: "official" } : {}),
        hearingImpaired: /\b(cc|sdh)\b/i.test(title),
        episodeTrusted: true,
        files: 1
      });
    }
  }
  return out;
}

/** Whether a subtitle is the dub's captions as this source names them (tsukihimeSubtitles). */
export function isDubCaptions(subtitle: SubSourceSubtitle): boolean {
  return subtitle.source === "tsukihime" && subtitle.productionType === "official" && (subtitle.commentary ?? "").startsWith("English Dub captions");
}

/** The words of a "th" subtitle: its track from TsukiHime's storage, unpacked. */
export async function downloadTsukihime(ref: string): Promise<Buffer> {
  const place = /^th(t?)(\d{1,12})$/.exec(ref);
  if (!place) throw new Error(`unknown subtitle ${ref}`);
  const id = Number(place[2]);
  const url = `${TSUKIHIME_STORAGE}/${place[1] ? "tosho/attach" : "attach"}/${id.toString(16).toUpperCase().padStart(8, "0")}/${id}.xz`;
  const response = await paced("tsukihime", tsukihimePace, () => {
    count("api.tsukihime");
    return fetch(url, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(15_000) });
  });
  if (!response.ok) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
  // Its own tracks are packed with a SHA-256 check, the archive's with a CRC32: both are read (xz.ts).
  return unxz(await readCapped(response, MAX_PACKED_BYTES), MAX_TRACK_BYTES);
}

/** Whether a release's audio is English and nothing else: an English dub's own release. */
function englishOnly(audio: string[] | undefined): boolean {
  return (audio ?? []).length > 0 && (audio ?? []).every((code) => sameLanguage(code, "en"));
}

/** A release's name without its picture size and its file's check sum: the same for one release at 1080p and at 720p. */
function otherSizes(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b\d{3,4}p\b/g, "")
    .replace(/\[[0-9a-f]{8}\]/g, "")
    .replace(/\s+/g, " ");
}

/** A track of signs and songs alone, by its title; a forced track is one too. */
const SIGNS_TRACK = /sign|song|forced|karaoke|lyric|s&s|typeset/i;
/** Releases opened for an episode's signs at most (each a request for its files, unless kept). */
const SIGNS_RELEASES = 6;
/** Releases opened, none of them with a signs track, before a full track found meanwhile is given. */
const SIGNS_TRACK_LOOK = 2;

/**
 * The episode's signs sources from TsukiHime's list of its releases, best first, each given as soon as
 * it is found: per release, the file's signs track and the dialogue track that times it to the playing
 * file, else its full English track (its signs are taken from among its lines), by the same rules as
 * Anime Tosho's signs (animetosho.ts signsOf), whose archive this list holds. Releases whose video comes
 * from where the playing file's does go first (a disc's cut and timing are a disc's), then ones with the
 * dub beside the original (their signs are meant to be shown with the dub). A full track waits until
 * SIGNS_TRACK_LOOK releases gave no signs track.
 */
export async function* tsukihimeSigns(request: StremioSubtitleRequest, showName: string | undefined, filename?: string): AsyncGenerator<SignsSource> {
  if (request.type !== "series") return;
  const english = (codes: string[] | undefined) => (codes ?? []).some((code) => sameLanguage(code, "en"));
  const from = filename ? videoSource(filename) : undefined;
  const rank = (r: Release) => (from && videoSource(r.name) === from ? 2 : 0) + (english(r.audiolangs) && (r.audiolangs ?? []).length > 1 ? 1 : 0);
  await listsFirst();
  const releases = (await episodeReleases(request, showName)).filter((r) => english(r.sublangs)).sort((a, b) => rank(b) - rank(a));
  const held: SignsSource[] = [];
  let opened = 0;
  for (const release of releases) {
    if (opened >= SIGNS_RELEASES) break;
    opened++;
    await listsFirst();
    const detail = await getJson<{ files?: ReleaseFile[]; animetosho?: boolean }>(`/torrents/${release.id}`, RELEASE_TTL_S);
    const files = detail?.files ?? [];
    const file = files.length === 1 ? files[0] : files.find((f) => isEpisode(f.filename, request));
    const tracks = (file?.attachments ?? []).filter((t) => t.type === 1 && t.id && /^(ass|ssa)$/i.test(t.info?.codec ?? "") && sameLanguage(t.info?.lang, "en"));
    const partial = (t: Attachment) => t.info?.forced === 1 || SIGNS_TRACK.test(t.info?.name ?? "");
    const signs = tracks.find(partial);
    // The dialogue of the original audio: the dub's own captions follow other voices.
    const dialogue = tracks.find((t) => !partial(t) && !CAPTIONS.test(t.info?.name ?? ""));
    if (dialogue) {
      const ref = (t: Attachment) => `th${detail?.animetosho || release.animetosho ? "t" : ""}${t.id}`;
      if (signs) yield { signs: ref(signs), partner: ref(dialogue), full: false, signsName: signs.info?.name || "Signs", release: release.name };
      else held.push({ signs: ref(dialogue), partner: ref(dialogue), full: true, signsName: dialogue.info?.name || "English", release: release.name });
    }
    if (opened >= SIGNS_TRACK_LOOK) yield* held.splice(0);
  }
  yield* held.splice(0);
}
