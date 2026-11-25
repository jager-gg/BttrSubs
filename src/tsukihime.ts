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
/** A subtitle track unpacks to a few hundred KB; anything far bigger isn't one. */
const MAX_TRACK_BYTES = 8_000_000;
/** And packed, a tenth of that at most. */
const MAX_PACKED_BYTES = 2_000_000;

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
  const kept = await readJsonCache<T>("results", key);
  if (kept !== undefined) return kept;
  try {
    const response = await paced("tsukihime", tsukihimePace, () => {
      count("api.tsukihime");
      return fetch(`${TSUKIHIME_API}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    });
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

/** The episode's releases: by the show's AniDB entry when the lists place the episode, else by the show's name. */
async function episodeReleases(request: StremioSubtitleRequest, showName: string | undefined): Promise<Release[]> {
  const placed = request.imdbId && request.season !== undefined && request.episode ? await animeEpisode(request.imdbId, request.season, request.episode).catch(() => undefined) : undefined;
  if (placed) {
    const anime = await getJson<{ id?: number; anime?: { id?: number }; results?: Array<{ id?: number }> }>(`/animes/anidb/${placed.anidbId}`, ANIME_TTL_S);
    const id = anime?.id ?? anime?.anime?.id ?? anime?.results?.[0]?.id;
    if (id) {
      const listed = await getJson<{ results?: Release[] }>(`/animes/${id}/episodes/${placed.episode}?limit=100`, EPISODE_TTL_S);
      // The ones whose names give another episode go last, so they take a place only when no other release wants it.
      const all = listed?.results ?? [];
      if (all.length) return [...all.filter((r) => !namesAnotherEpisode(r.name, request)), ...all.filter((r) => namesAnotherEpisode(r.name, request))];
    }
  }
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
export async function tsukihimeSubtitles(request: StremioSubtitleRequest, showName: string | undefined, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (request.type !== "series") return [];
  const wanted = languages.map((name) => ({ name, code: languageCode(name) })).filter((l): l is { name: string; code: string } => Boolean(l.code));
  if (wanted.length === 0) return [];
  const releases = await episodeReleases(request, showName);
  const holds = (r: Release) => wanted.filter((l) => (r.sublangs ?? []).some((code) => sameLanguage(code, l.code))).length;
  const playing = request.filename ? bare(request.filename) : undefined;
  const isPlaying = (r: Release) => (playing !== undefined && bare(r.name) === playing) || (request.videoSize !== undefined && String(r.totalsize ?? "") === String(request.videoSize));
  const open = releases
    .filter((r) => holds(r) > 0)
    .sort((a, b) => Number(isPlaying(b)) - Number(isPlaying(a)) || holds(b) - holds(a))
    .slice(0, MAX_RELEASES);
  const out: SubSourceSubtitle[] = [];
  const seen = new Set<string>();
  for (const release of open) {
    const detail = await getJson<{ files?: ReleaseFile[]; animetosho?: boolean; audiolangs?: string[] }>(`/torrents/${release.id}`, RELEASE_TTL_S);
    const files = detail?.files ?? [];
    const file = files.length === 1 ? files[0] : files.find((f) => isEpisode(f.filename, request));
    if (!file) continue;
    const dubbed = (detail?.audiolangs ?? release.audiolangs ?? []).some((code) => sameLanguage(code, "en"));
    for (const track of file.attachments ?? []) {
      const info = track.info ?? {};
      if (track.type !== 1 || !track.id || !/^(ass|ssa|srt|vtt)$/i.test(info.codec ?? "")) continue;
      const language = wanted.find((l) => sameLanguage(info.lang, l.code));
      const title = (info.name ?? "").trim();
      if (!language || info.forced === 1 || PARTIAL.test(title)) continue;
      const ref = `th${detail?.animetosho || release.animetosho ? "t" : ""}${track.id}`;
      if (seen.has(`${ref}|${language.name}`)) continue;
      seen.add(`${ref}|${language.name}`);
      const captions = language.code === "en" && dubbed && CAPTIONS.test(title);
      out.push({
        subtitleId: 0,
        ref,
        source: "tsukihime",
        movieId: 0,
        language: language.name,
        releaseInfo: [file.filename.replace(/\.(mkv|mp4)$/i, ""), ...(files.length === 1 && release.name !== file.filename ? [release.name] : [])],
        // What it is, in the words the ranking reads: a dub's captions are named so, a translation never is.
        commentary: captions ? `English Dub captions: the release's own "${title}" track` : `The release's own ${title ? `"${title}" ` : ""}subtitle track`,
        ...(captions ? { productionType: "official" } : {}),
        hearingImpaired: /\b(cc|sdh)\b/i.test(title),
        episodeTrusted: true,
        files: 1
      });
    }
  }
  return out;
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
