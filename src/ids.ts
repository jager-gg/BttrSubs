/**
 * Anime ids other than IMDb, and anime seasons by their own titles. AIOStreams' own Jellyfin server
 * asks subtitle addons with the title's own id, which for anime is often Kitsu ("kitsu:1000:13");
 * AIOMetadata converts to IMDb first, AIOStreams doesn't. SubSource is searched by IMDb id, so Kitsu
 * ids are mapped here with the Anime Kitsu addon's metadata, which gives each episode's IMDb season
 * and episode. Cached for a day.
 *
 * The same metadata gives a show's season map (seasonMap): Kitsu lists each season, part of a season
 * and special of a show as an entry of its own, with its own titles, and maps each of its episodes to
 * IMDb's season and episode. Uploaders name anime by those titles ("Show: Second Arc - 03"), so the
 * map is how such a name is read (matching.ts).
 */
import { anidbAnime, anidbConfigured } from "./anidb.js";
import { animeEpisode, animeLists, showEntries } from "./animelists.js";
import { datasetAnime, datasetEnabled, distinctTitles } from "./animetitles.js";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import type { SeasonMap } from "./types.js";

const KITSU = "https://anime-kitsu.strem.fun";
const DAY = 24 * 60 * 60;

interface KitsuMap {
  imdbId?: string;
  /** Kitsu episode -> [IMDb season, IMDb episode]. */
  episodes: Record<string, [number, number]>;
  /** Its name and aliases. An entry without them is fetched again for a season map. */
  titles?: string[];
}

export interface Mapped {
  imdbId: string;
  season?: number;
  episode?: number;
}

export function parseKitsuId(id: string): { kitsuId: string; episode?: number } | undefined {
  const match = id.match(/^kitsu:(\d+)(?::(\d+))?$/i);
  return match ? { kitsuId: match[1], episode: match[2] ? Number(match[2]) : undefined } : undefined;
}

interface KitsuMeta {
  imdb_id?: string;
  name?: string;
  aliases?: string[];
  videos?: Array<{ id?: string; episode?: number; imdbSeason?: number; imdbEpisode?: number }>;
}

/** One entry's metadata: undefined when the addon doesn't have it under this type; throws when the addon can't be reached. */
async function fetchKitsuMeta(type: string, kitsuId: string, ms: number): Promise<KitsuMap | undefined> {
  const response = await fetch(`${KITSU}/meta/${type}/kitsu:${kitsuId}.json`, { signal: AbortSignal.timeout(ms) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Anime Kitsu ${response.status}`);
  const meta = ((await response.json()) as { meta?: KitsuMeta }).meta;
  if (!meta) return undefined;
  const map: KitsuMap = { imdbId: meta.imdb_id, episodes: {}, titles: [meta.name, ...(meta.aliases ?? [])].filter((t): t is string => typeof t === "string" && t.trim() !== "") };
  for (const video of meta.videos ?? []) {
    const episode = video.episode ?? Number(video.id?.split(":")[2]);
    // Season 0 is IMDb's specials: a place like any other.
    if (episode && video.imdbSeason !== undefined && video.imdbSeason >= 0 && video.imdbEpisode) map.episodes[episode] = [video.imdbSeason, video.imdbEpisode];
  }
  return map;
}

async function kitsuMap(kitsuId: string): Promise<KitsuMap | undefined> {
  const key = cacheKey({ kind: "kitsu-imdb", kitsuId });
  const cached = await readJsonCache<KitsuMap>("results", key);
  if (cached) return cached;

  for (const type of ["series", "movie"]) {
    try {
      const map = await fetchKitsuMeta(type, kitsuId, 8000);
      if (!map) continue;
      await writeJsonCache("results", key, map, DAY);
      return map;
    } catch {
      // try the next type
    }
  }
  return undefined;
}

/** "kitsu:1000:13" -> { imdbId: "tt0000004", season: 1, episode: 13 }, or undefined when it can't be mapped. */
export async function kitsuToImdb(id: string): Promise<Mapped | undefined> {
  const parsed = parseKitsuId(id);
  if (!parsed) return undefined;
  const map = await kitsuMap(parsed.kitsuId);
  if (!map?.imdbId || !/^tt\d+$/.test(map.imdbId)) return undefined;
  if (parsed.episode === undefined) return { imdbId: map.imdbId };
  // A special (IMDb season 0) is looked up as before: by its Kitsu number, as if in season 1.
  const known = map.episodes[parsed.episode]?.[0] ? map.episodes[parsed.episode] : undefined;
  // Without a listed mapping, treat the Kitsu number as an absolute episode of season 1.
  return known ? { imdbId: map.imdbId, season: known[0], episode: known[1] } : { imdbId: map.imdbId, season: 1, episode: parsed.episode };
}

// ---------- a show's seasons by their own titles ----------

/** Entries of one show read at most: a long franchise lists many, and each is a fetch. One with more has no map. */
const MAX_ENTRIES = 24;
/**
 * Results the addon's catalog search gives at most: it has no further page, and it finds entries by
 * their names, so a show's own entries can be cut off or not found at all. The anime lists say which
 * entries a show has (animelists.ts, kitsuOfImdb), and a show they know is mapped by theirs and the
 * search's together. A show they don't know is mapped by the search alone, and then only by an
 * answer short of SEARCH_PAGE: a full one may have cut some off. Calibration (the 12 shows with the
 * most entries in the lists): the search gave every listed entry of none of them; of one with 12
 * series it gave 2, in a full answer that ended in other shows' entries.
 */
const SEARCH_PAGE = 20;
/** How long a map waits for the anime lists when they aren't read yet (they are read at start). */
const LISTS_WAIT_MS = 3000;
/** How maps are made: one kept from another way of making them is made again. */
const MAP_MADE = 2;
/** How long each look-up may take. A list doesn't wait past its own deadline; a slow first one finishes behind it and is cached. */
const SEARCH_MS = 5000;
const META_MS = 5000;
/** A map changes when a new season starts, so it is kept a week; a show without one is asked about again soon. */
const MAP_TTL = 7 * DAY;
const NONE_TTL = 60 * 60;
const FAILED_TTL = 10 * 60;

/** One entry's metadata for a season map: the day's cached copy (kitsuToImdb's too) when it has the titles. */
async function kitsuEntry(type: string, kitsuId: string): Promise<KitsuMap | undefined> {
  const key = cacheKey({ kind: "kitsu-imdb", kitsuId });
  const cached = await readJsonCache<KitsuMap>("results", key);
  if (cached?.titles) return cached;
  const map = await fetchKitsuMeta(type, kitsuId, META_MS);
  if (map) await writeJsonCache("results", key, map, DAY);
  return map;
}

/** An IMDb episode's Kitsu id as the anime lists place it ("kitsu:1000:37" for a show's season 2 episode 12; see animelists.ts). */
export async function kitsuEpisode(imdbId: string, season: number, episode: number): Promise<string | undefined> {
  const place = await animeEpisode(imdbId, season, episode);
  return place?.kitsuId ? `kitsu:${place.kitsuId}:${place.episode}` : undefined;
}

interface SearchResult {
  id?: string;
  type?: string;
  imdb_id?: string;
}

/**
 * The show's season map, from the Anime Kitsu addon: the entries the anime lists file under this
 * IMDb id and the ones its catalog, searched by the show's name, gives for it, each one's titles and
 * episodes read. Only a show with two entries or more has one (one entry says nothing a bare number
 * doesn't). An entry the search gave that can't be read means no map, and so does any failure: a map
 * missing an entry would read that entry's names as another's. An entry only the lists name is left
 * out when the addon doesn't have it, or files it under another show: its names are then ones the
 * map doesn't know, which aren't read. A show the lists don't know is mapped by the search alone,
 * when its answer may hold them all (SEARCH_PAGE); a show with more than MAX_ENTRIES has none.
 * Kept a week; a show with none, an hour; a failure, ten minutes.
 */
export async function seasonMap(imdbId: string, showName: () => Promise<string | undefined>): Promise<SeasonMap | undefined> {
  const key = cacheKey({ kind: "season-map", imdbId });
  const cached = await readJsonCache<{ map?: SeasonMap; made?: number }>("results", key);
  // A map whose entries lack their Kitsu ids is read again: Anime Tosho's episode search needs them.
  if (cached && cached.made === MAP_MADE && !cached.map?.entries.some((e) => !e.kitsuId)) return cached.map;
  const show = await showName();
  if (!show) return undefined;
  let map: SeasonMap | undefined;
  try {
    const lists = await Promise.race([animeLists(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), LISTS_WAIT_MS).unref())]);
    const listed = lists?.kitsuOfImdb.get(imdbId) ?? [];
    let found: SearchResult[] = [];
    try {
      const response = await fetch(`${KITSU}/catalog/anime/kitsu-anime-list/search=${encodeURIComponent(show)}.json`, { signal: AbortSignal.timeout(SEARCH_MS) });
      if (!response.ok) throw new Error(`Anime Kitsu ${response.status}`);
      found = ((await response.json()) as { metas?: SearchResult[] }).metas ?? [];
    } catch (error) {
      // The lists alone say which entries the show has; without them the search is all there is.
      if (!listed.length) throw error;
    }
    /** Each entry to read, by its Kitsu id: the kind to ask for it as, and whether the search gave it. */
    const wanted = new Map<string, { type: "series" | "movie"; searched: boolean }>();
    for (const m of found) {
      if (m.imdb_id === imdbId && /^kitsu:\d+$/.test(m.id ?? "")) wanted.set((m.id as string).slice("kitsu:".length), { type: m.type === "movie" ? "movie" : "series", searched: true });
    }
    for (const entry of listed) if (!wanted.has(String(entry.kitsuId))) wanted.set(String(entry.kitsuId), { type: entry.film ? "movie" : "series", searched: false });
    const whole = listed.length > 0 || found.length < SEARCH_PAGE;
    if (wanted.size >= 2 && wanted.size <= MAX_ENTRIES && whole) {
      const read = await Promise.all(
        [...wanted].map(async ([kitsuId, from]) => {
          let entry = await kitsuEntry(from.type, kitsuId);
          if (from.searched) {
            if (!entry) throw new Error(`Anime Kitsu has no metadata for kitsu:${kitsuId}`);
          } else {
            entry ??= await kitsuEntry(from.type === "movie" ? "series" : "movie", kitsuId);
            if (!entry || entry.imdbId !== imdbId) return undefined;
          }
          return { kitsuId, titles: entry.titles ?? [], episodes: entry.episodes };
        })
      );
      const entries = read.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      if (entries.length >= 2) map = { show, entries };
    }
  } catch {
    await writeJsonCache("results", key, { made: MAP_MADE }, FAILED_TTL);
    return undefined;
  }
  await writeJsonCache("results", key, map ? { map, made: MAP_MADE } : { made: MAP_MADE }, map ? MAP_TTL : NONE_TTL);
  // No map from the addon: one from titles (AniDB's, or the dataset's) is made behind this answer.
  if (!map) startTitlesMap(imdbId, show, key);
  return map;
}

/** Entries of one show a map is made of from titles at most: each is a request to AniDB, where its requests are few (anidb.ts). */
const TITLES_MAX_ENTRIES = 12;
/** A map made from the dataset while an AniDB client is set is kept this long only: AniDB's is made in its place once it can be. */
const STAND_IN_TTL = DAY;
/** Maps being made from titles, by show: one at a time each. */
const titleMaps = new Map<string, Promise<void>>();

/**
 * A season map from titles, for a show the Anime Kitsu addon gave none (it files some shows' entries
 * under other IMDb ids, or under none): the entries the anime lists give the show, each one's names,
 * and each one's episodes placed in TVDB's order by the lists, the order requests come in. The names
 * come from AniDB when a client is set (anidb.ts: exact, asked slowly, so a show's map can take
 * several requests to come); else, or until AniDB has answered for every entry, from the
 * anime-offline-database (animetitles.ts), with the names two entries share left out. Made behind the
 * answer, never waited for; kept like any map, for the next request. An entry without a Kitsu id in
 * the lists is left out (Anime Tosho finds an entry's releases by it), and so is one with no name
 * left; a show with more than TITLES_MAX_ENTRIES, or fewer than two left, has none.
 */
function startTitlesMap(imdbId: string, show: string, key: string): void {
  if ((!anidbConfigured() && !datasetEnabled()) || titleMaps.has(imdbId)) return;
  const job = (async () => {
    const lists = await animeLists();
    const listed = lists ? showEntries(lists, imdbId).filter((entry) => entry.kitsuId) : [];
    if (listed.length < 2 || listed.length > TITLES_MAX_ENTRIES) return;
    let named: Array<{ titles: string[]; episodes: number } | undefined> | undefined;
    let from = "AniDB's titles";
    if (anidbConfigured()) {
      const asked: Array<{ titles: string[]; episodes: number } | undefined> = [];
      for (const entry of listed) {
        const anime = await anidbAnime(entry.anidbId);
        // Not all of them yet (the day's count, a refusal): what was asked is kept, and the dataset stands in.
        if (!anime) break;
        asked.push(anime);
      }
      if (asked.length === listed.length) named = asked;
    }
    if (!named) {
      const dataset = await datasetAnime(listed.map((entry) => entry.anidbId));
      if (!dataset) return;
      named = distinctTitles(listed.map((entry) => dataset.get(entry.anidbId) ?? { titles: [], episodes: 0 })).map((anime) => (anime.titles.length ? anime : undefined));
      from = "the anime-offline-database's titles";
    }
    const entries: SeasonMap["entries"] = [];
    listed.forEach((entry, at) => {
      const anime = named![at];
      if (!anime) return;
      const episodes: Record<string, [number, number]> = {};
      for (let episode = 1; episode <= anime.episodes; episode++) {
        const placed = entry.place(episode);
        if (placed) episodes[episode] = placed;
      }
      entries.push({ kitsuId: String(entry.kitsuId), titles: anime.titles, episodes });
    });
    if (entries.length < 2) return;
    const standIn = from !== "AniDB's titles" && anidbConfigured();
    await writeJsonCache("results", key, { map: { show, entries }, made: MAP_MADE }, standIn ? STAND_IN_TTL : MAP_TTL);
    console.log(`season map: ${imdbId}: none from the Anime Kitsu addon; made from ${from}, ${entries.length} of ${listed.length} entries${standIn ? " (until AniDB has answered for all of them)" : ""}`);
  })()
    .catch((error) => console.error(`season map: ${imdbId}: from titles: ${error instanceof Error ? error.message : error}`))
    .finally(() => titleMaps.delete(imdbId));
  titleMaps.set(imdbId, job);
}

/** For tests: the map being made from titles for a show, if one is. */
export function titlesMapUnderWay(imdbId: string): Promise<void> | undefined {
  return titleMaps.get(imdbId);
}
