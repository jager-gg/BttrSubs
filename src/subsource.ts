/**
 * SubSource's API (api.subsource.net/api/v1). Every call runs on the key of
 * the link that asked, and is counted against it (stats.ts). Results are public
 * data, so their cache is shared by everyone whatever key fetched them; the
 * cache keys below must not change, or every cached search is fetched again.
 */
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { config } from "./config.js";
import { animeEpisode } from "./animelists.js";
import { count, noteKeyCall } from "./stats.js";
import type { SeasonMap, StremioSubtitleRequest, SubSourceMovie, SubSourceSubtitle } from "./types.js";

const API = "https://api.subsource.net/api/v1";
/** Subtitles per page when listing a record (SubSource's maximum, by its API docs). */
export const PAGE_SIZE = 100;
/** Longest a search or a download may take before it is given up, as for every other source. */
export const SEARCH_TIMEOUT_MS = 10000;
export const DOWNLOAD_TIMEOUT_MS = 15000;
/**
 * Requests left in the key's minute at which a record's paging stops for now: the pages read are kept,
 * the rest are read by a later list, and downloads and other lists keep room. Calibration (free key,
 * 60 a minute): a list's searches and its first downloads take up to about 10.
 */
export const MINUTE_RESERVE = 10;
/** A record's whole list is kept this long; past the result lifetime only its newest page is asked again. */
const LIST_KEPT_S = 30 * 24 * 60 * 60;

/** SubSource's reply: the data, plus page counts on lists, and the requests left in the key's minute. */
interface Reply<T> {
  data: T;
  pagination?: { pages: number };
  remaining?: number;
}

/** Every call names the key it runs on: the owner's, or a friend's from their personal link. */
function requireKey(apiKey: string): string {
  if (!apiKey) throw new Error("No SubSource API key for this request");
  return apiKey;
}

/** A GET on the API, counted for its key. A refusal throws with SubSource's own message. */
async function apiGet<T>(apiKey: string, pathname: string, query: Record<string, string | number | undefined> = {}): Promise<Reply<T>> {
  const url = new URL(API + pathname);
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
  count("api.subsource");
  const response = await fetch(url, { headers: { "X-API-Key": requireKey(apiKey), Accept: "application/json" }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  noteKeyCall("subsource", apiKey, response);
  if (!response.ok) {
    count("api.subsource.fail");
    throw new Error(`SubSource ${response.status} for ${pathname}: ${await response.text()}`);
  }
  const left = Number(response.headers.get("x-ratelimit-remaining") ?? NaN);
  return { ...((await response.json()) as Reply<T>), ...(Number.isFinite(left) ? { remaining: left } : {}) };
}

/** A cached result, or the fetched one (then cached). */
async function cachedResult<T>(key: string, fetchIt: () => Promise<T>): Promise<T> {
  const kept = await readJsonCache<T>("results", key);
  if (kept) return kept;
  const fresh = await fetchIt();
  await writeJsonCache("results", key, fresh);
  return fresh;
}

/** SubSource's records for an IMDb id: one per season for a series. */
export function searchMoviesByImdb(imdbId: string, apiKey: string): Promise<SubSourceMovie[]> {
  return cachedResult(cacheKey({ kind: "movie-search-imdb", imdbId }), async () =>
    (await apiGet<SubSourceMovie[]>(apiKey, "/movies/search", { searchType: "imdb", imdb: imdbId })).data
  );
}

/** SubSource's records for a name, as its own search ranks them. */
export function searchMoviesByTitle(title: string, apiKey: string): Promise<SubSourceMovie[]> {
  return cachedResult(cacheKey({ kind: "movie-search-text", title: title.toLowerCase() }), async () =>
    (await apiGet<SubSourceMovie[]>(apiKey, "/movies/search", { searchType: "text", q: title })).data
  );
}

/** A title as compared: lower case, letters and digits only, one space between words. */
function plainTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f'\u2019]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Names searched for at most, and records taken from them at most. */
const NAMED_QUERIES = 2;
const NAMED_RECORDS = 2;
/** A record with more subtitles than this isn't read for its name alone: every page of it would be. */
const NAMED_MAX_SUBTITLES = 1000;
/** The fewest letters of a season's own name to search by: a short one names many titles. */
const NAMED_MIN_LENGTH = 12;

/**
 * Records filed under a season's own name instead of the show's IMDb id: uploaders put an anime
 * part's subtitles on whatever record carries its name, a film's included, and the IMDb search never
 * returns it. The season asked for is found in the season map; its names (not the show's own) are
 * searched as text, NAMED_QUERIES at most, and a record is taken when its title holds one of them
 * whole, it isn't one the IMDb search gave (`known`), and it has subtitles, NAMED_MAX_SUBTITLES at
 * most. Each search is kept as any result is, so a show costs these calls once per result lifetime.
 */
export async function namedRecords(request: StremioSubtitleRequest, seasonMap: SeasonMap, apiKey: string, known: SubSourceMovie[]): Promise<SubSourceMovie[]> {
  if (request.type !== "series" || request.season === undefined || !request.episode || seasonMap.entries.length < 2) return [];
  const entry = seasonMap.entries.find((e) => Object.values(e.episodes).some(([season, episode]) => season === request.season && episode === request.episode));
  if (!entry) return [];
  const show = plainTitle(seasonMap.show);
  const names = [...new Set(entry.titles.map(plainTitle))].filter((name) => name.length >= NAMED_MIN_LENGTH && name !== show && /^[a-z0-9 ]+$/.test(name));
  const taken = new Map<number, SubSourceMovie>();
  for (const name of names.slice(0, NAMED_QUERIES)) {
    for (const record of await searchMoviesByTitle(name, apiKey)) {
      if (taken.size >= NAMED_RECORDS) break;
      if (known.some((k) => k.movieId === record.movieId) || (request.imdbId && record.imdbId === request.imdbId)) continue;
      if (!record.subtitleCount || record.subtitleCount > NAMED_MAX_SUBTITLES) continue;
      if (!names.some((n) => ` ${plainTitle(record.title)} `.includes(` ${n} `))) continue;
      taken.set(record.movieId, record);
    }
  }
  return [...taken.values()];
}

/** Records searched for every series: the first FIRST_RECORDS of findCandidateMovies' order. */
export const FIRST_RECORDS = 3;
/**
 * Records of one show searched at most. Each is a list per language (cached 6 hours, and shared by
 * every episode of the show), so a show's first list costs a few calls more, not one per season.
 */
export const MAX_RECORDS = 8;

/**
 * SubSource records to try, best first, MAX_RECORDS at most. Anime is often filed on a whole-series
 * record (season 0) or on season 1 with absolute numbering, while the season record itself is empty.
 * The first FIRST_RECORDS are searched for every series; the rest only when the show's season map
 * can read names by title (app.ts), since uploaders file a season under another season's record.
 * Records with no subtitles at all are skipped, which costs no API calls.
 */
export async function findCandidateMovies(request: StremioSubtitleRequest, apiKey: string): Promise<SubSourceMovie[]> {
  if (!request.imdbId) return [];
  const records = await searchMoviesByImdb(request.imdbId, apiKey);
  if (request.type !== "series") {
    const film = records.find((record) => record.type === "movie") ?? records[0];
    return film ? [film] : [];
  }
  const seasons = records.filter((record) => record.type === "tvseries");
  const preferred = [request.season, 0, 1].map((season) => seasons.find((record) => record.season === season));
  const picked = new Map<number, SubSourceMovie>();
  for (const record of [...preferred, ...seasons]) {
    if (record && !picked.has(record.movieId)) picked.set(record.movieId, record);
  }
  const all = [...picked.values()].filter((record) => record.subtitleCount !== 0);
  // Past the first ones, the seasons nearest the one asked for come first, so the cap leaves out the farthest.
  const season = request.season ?? 1;
  const distance = (record: SubSourceMovie) => Math.abs((record.season ?? 0) - season);
  const rest = all.slice(FIRST_RECORDS).sort((a, b) => distance(a) - distance(b) || (a.season ?? 0) - (b.season ?? 0));
  return [...all.slice(0, FIRST_RECORDS), ...rest].slice(0, MAX_RECORDS);
}

/**
 * Episode number counted across seasons (specials excluded). For an anime (`anime`) that the anime
 * lists hold as one run numbered straight through, its number there (animelists.ts), as media centres
 * number it. Else from Cinemeta's episode list, each season counted to its last episode's number, so
 * an episode 0 a listing carries in it, an episode listed twice or one missing leaves the count as it
 * is. Calibration (12 anime, every episode AIOMetadata lists in TVDB order): the lists placed each the
 * same as AIOMetadata does (2,969 of 2,969), where Cinemeta's count was right for 627 of the 1,179 of
 * the longest run.
 */
export async function absoluteEpisode(imdbId: string, season: number, episode: number, anime = false): Promise<number | undefined> {
  if (anime) {
    const own = await animeEpisode(imdbId, season, episode).catch(() => undefined);
    if (own?.run) return own.episode;
  }
  if (season === 1) return episode;
  const key = cacheKey({ kind: "season-ends", imdbId });
  let sizes = await readJsonCache<Record<string, number>>("results", key);
  if (!sizes) {
    try {
      const response = await fetch(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { meta?: { videos?: Array<{ season?: number; episode?: number }> } };
      sizes = {};
      for (const video of body.meta?.videos ?? []) {
        const number = Number(video.episode);
        if (video.season && video.season > 0 && Number.isInteger(number) && number > 0) sizes[video.season] = Math.max(sizes[video.season] ?? 0, number);
      }
      await writeJsonCache("results", key, sizes, 24 * 60 * 60);
    } catch {
      return undefined;
    }
  }
  let before = 0;
  for (let s = 1; s < season; s++) {
    if (!sizes[s]) return undefined;
    before += sizes[s];
  }
  return before + episode;
}

/** Countries whose own shows and films are made in English: no English dub exists to caption. */
const ENGLISH_SPEAKING = new Set(["united states", "united kingdom", "canada", "australia", "ireland", "new zealand"]);

/**
 * Whether a title was made in English, from its country in Cinemeta's catalog: true when
 * the first country listed is an English-speaking one, false for any other, undefined when unknown. Cached a day.
 */
export async function madeInEnglish(type: string, imdbId: string): Promise<boolean | undefined> {
  const key = cacheKey({ kind: "made-in", imdbId });
  const cached = await readJsonCache<{ country: string }>("results", key);
  let country = cached?.country;
  if (country === undefined) {
    try {
      const kind = type === "movie" ? "movie" : "series";
      const response = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { meta?: { country?: string } };
      country = String(body.meta?.country ?? "");
      await writeJsonCache("results", key, { country }, 24 * 60 * 60);
    } catch {
      return undefined;
    }
  }
  // "United States, Canada": the first country listed is where it comes from.
  const first = country.split(",")[0].trim().toLowerCase();
  return first ? ENGLISH_SPEAKING.has(first) : undefined;
}

/**
 * A record's list as kept: its subtitles so far (newest first), the pages it had, how many of them are
 * read, and when its newest page was last asked for.
 */
interface KeptList {
  items: SubSourceSubtitle[];
  pages: number;
  read: number;
  checkedAt: number;
}

/** A record's paging under way, shared by every list asking for it at the same time. */
const paging = new Map<string, Promise<SubSourceSubtitle[]>>();

/**
 * SubSource's own names for the languages it doesn't name as they are named here. It answers a name
 * it doesn't know with an empty list, not an error.
 */
const SUBSOURCE_NAMES: Record<string, string> = {
  "portuguese (br)": "brazilian_portuguese",
  "persian": "farsi_persian",
  "sinhalese": "sinhala",
  "chinese (simplified)": "chinese_bg_code",
  "chinese (traditional)": "big_5_code"
};

/** Every subtitle of one SubSource record in one language, as it is named here (see listIn). */
export async function getSubtitlesIn(movieId: number, language: string, apiKey: string): Promise<SubSourceSubtitle[]> {
  const theirs = SUBSOURCE_NAMES[language.toLowerCase()];
  if (!theirs) return listIn(movieId, language, apiKey);
  return (await listIn(movieId, theirs, apiKey)).map((subtitle) => (subtitle.language === theirs ? { ...subtitle, language } : subtitle));
}

/**
 * Every subtitle of one SubSource record in one language (SubSource's name, e.g. "spanish"). Its
 * listing has no episode filter, so a long run held as one record (hundreds of episodes) is many
 * pages, newest first. Each page is kept as it is read, so a refusal or a stop loses none of them and
 * a later list reads on from there; paging stops with MINUTE_RESERVE requests left in the key's
 * minute. Once every page is read, the list is used as kept for the result lifetime, and after that
 * only its newest pages are asked for, until one holds a subtitle already kept: subtitles are added at
 * the front and older ones don't change. A list not yet read whole gives what it has.
 */
function listIn(movieId: number, language: string, apiKey: string): Promise<SubSourceSubtitle[]> {
  const key = cacheKey({ kind: "subtitle-pages", movieId, language });
  const running = paging.get(key);
  if (running) return running;
  const job = readList(key, movieId, language, apiKey).finally(() => paging.delete(key));
  paging.set(key, job);
  return job;
}

async function readList(key: string, movieId: number, language: string, apiKey: string): Promise<SubSourceSubtitle[]> {
  // A whole list kept the way lists were kept before pages were (kind "subtitles", for the result
  // lifetime) is taken as read whole, its newest page asked for at once.
  const before = await readJsonCache<SubSourceSubtitle[]>("results", cacheKey({ kind: "subtitles", movieId, language }));
  const kept = (await readJsonCache<KeptList>("results", key)) ?? (before ? { items: before, pages: 1, read: 1, checkedAt: 0 } : undefined);
  const whole = kept !== undefined && kept.read >= kept.pages;
  if (whole && Date.now() - kept.checkedAt < config.resultCacheTtlSeconds * 1000) return kept.items;
  const list: KeptList = kept ? { ...kept, items: [...kept.items] } : { items: [], pages: 1, read: 0, checkedAt: 0 };
  const known = new Set(list.items.map((s) => s.subtitleId));
  const save = () => writeJsonCache("results", key, list, LIST_KEPT_S);
  try {
    if (whole) {
      // Newest pages until one holds a subtitle already kept. Stopped before that (the minute's
      // reserve), what was read isn't joined on, or the ones between would be missed: the next list
      // asks again.
      const added: SubSourceSubtitle[] = [];
      let met = false;
      for (let page = 1; page <= list.pages && !met; page++) {
        const reply = await apiGet<SubSourceSubtitle[]>(apiKey, "/subtitles", { movieId, language, page, limit: PAGE_SIZE });
        added.push(...reply.data.filter((s) => !known.has(s.subtitleId)));
        list.pages = Math.max(list.pages, reply.pagination?.pages ?? page);
        met = reply.data.some((s) => known.has(s.subtitleId)) || page >= (reply.pagination?.pages ?? page);
        if (!met && (reply.remaining ?? Infinity) <= MINUTE_RESERVE) break;
      }
      if (!met) return list.items;
      list.items = [...added, ...list.items];
      list.read = list.pages;
      list.checkedAt = Date.now();
      count("subsource.listRefreshed");
      return list.items;
    }
    // Read on from the first page not read. A page that moved as subtitles were added (each moves the
    // rest one place on) is read again in part: what it repeats is kept once.
    for (let page = list.read + 1; page <= list.pages; page++) {
      const reply = await apiGet<SubSourceSubtitle[]>(apiKey, "/subtitles", { movieId, language, page, limit: PAGE_SIZE });
      for (const s of reply.data) if (!known.has(s.subtitleId)) (known.add(s.subtitleId), list.items.push(s));
      list.pages = reply.pagination?.pages ?? page;
      list.read = page;
      await save();
      if (page < list.pages && (reply.remaining ?? Infinity) <= MINUTE_RESERVE) {
        count("subsource.pagingPaused");
        break;
      }
    }
    if (list.read >= list.pages) list.checkedAt = Date.now();
    return list.items;
  } catch (error) {
    // A refusal part-way: the pages read are kept and given; with none, the failure is the answer.
    if (!list.items.length) throw error;
    return list.items;
  } finally {
    await save().catch(() => undefined);
  }
}

/** The subtitle's download as SubSource sends it: usually a zip, sometimes a lone file. */
export async function downloadSubtitleArchive(subtitleId: number, apiKey: string): Promise<Buffer> {
  count("api.subsource");
  const response = await fetch(`${API}/subtitles/${subtitleId}/download`, { headers: { "X-API-Key": requireKey(apiKey) }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  noteKeyCall("subsource", apiKey, response, true);
  if (!response.ok) throw new Error(`SubSource ${response.status} downloading subtitle ${subtitleId}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}
