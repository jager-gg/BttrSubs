/**
 * Anime episodes as AniDB numbers them, from the two public lists that anime trackers and media
 * centres read: Anime-Lists' anime-list-full.xml (each AniDB entry's place among a show's TVDB seasons)
 * and Fribb's anime-list-full.json (each entry's ids elsewhere: IMDb, TVDB, Kitsu). An episode asked for
 * by its IMDb id in TVDB's order (the order Cinemeta and AIOMetadata give anime in) becomes its AniDB
 * entry, the entry's own number for it, and the entry's Kitsu id.
 *
 * The XML is read by its own rules:
 * - an entry whose default TVDB season is "a" numbers a run straight through, each TVDB season one range
 *   of its episodes (start, end, and the offset from the TVDB number), and the episodes before every
 *   range it gives are season 1's, at their own numbers (TVDB's absolute order, which is season 1's
 *   there);
 * - one whose default season is a number is that season, from its episode offset on; entries that share
 *   a season split it at their offsets, or by ranges of their own;
 * - one whose default season is "0" holds specials and films, never a regular episode.
 * A reading is taken only when it leads back to the same TVDB episode: an entry that places an episode
 * twice, or one that can't place it back, gives nothing rather than a guess.
 *
 * Both lists are kept in the cache folder and asked for again a day later (a list that hasn't changed
 * isn't downloaded again); while that runs, and when it fails, the copy at hand is used.
 */
import { readFile, stat, utimes } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { cachePath, writeFileAtomic } from "./cache.js";

const LISTS = {
  xml: "https://raw.githubusercontent.com/Anime-Lists/anime-lists/refs/heads/master/anime-list-full.xml",
  json: "https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json"
} as const;
/** How old a list may be before it is asked for again. */
const REFRESH_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_MS = 60_000;
/** Fribb's kinds of entry that are series: anything else (a film, a music video) has no episodes. */
const SERIES_KINDS = new Set(["tv", "ova", "ona", "special"]);

interface Mapping {
  anidbSeason: number;
  tvdbSeason?: number;
  start?: number;
  end?: number;
  offset: number;
}
interface Entry {
  anidbId: number;
  tvdbId: number;
  /** "a", "0" or a TVDB season number, as the list writes it. */
  season: string;
  offset: number;
  mappings: Mapping[];
}
export interface AnimeLists {
  byTvdb: Map<number, Entry[]>;
  byAnidb: Map<number, Entry>;
  tvdbOfImdb: Map<string, number>;
  kitsuOfAnidb: Map<number, number>;
  /** Every Kitsu entry the lists file under an IMDb id, a film's among them: the whole of a show's entries (ids.ts, seasonMap). */
  kitsuOfImdb: Map<string, Array<{ kitsuId: number; film: boolean }>>;
}

const attributes = (text: string) => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const number = (value: string | undefined) => (value === undefined || value === "" ? undefined : Number.parseInt(value, 10));

/** Anime-Lists' XML: every entry with a TVDB id, by TVDB id (in the list's order) and by AniDB id. */
export function readXml(xml: string): Pick<AnimeLists, "byTvdb" | "byAnidb"> {
  const byTvdb = new Map<number, Entry[]>();
  const byAnidb = new Map<number, Entry>();
  for (const [, head, body = ""] of xml.matchAll(/<anime\s([^>]*?)(?:\/>|>([\s\S]*?)<\/anime>)/g)) {
    const a = attributes(head);
    const anidbId = number(a.anidbid);
    const tvdbId = number(a.tvdbid);
    if (!anidbId || !tvdbId || !a.defaulttvdbseason) continue;
    const mappings = [...body.matchAll(/<mapping\s([^>]*?)(?:\/>|>[^<]*<\/mapping>)/g)].map(([, m]) => {
      const b = attributes(m);
      return { anidbSeason: number(b.anidbseason) ?? 1, tvdbSeason: number(b.tvdbseason), start: number(b.start), end: number(b.end), offset: number(b.offset) ?? 0 };
    });
    const entry: Entry = { anidbId, tvdbId, season: a.defaulttvdbseason, offset: number(a.episodeoffset) ?? 0, mappings };
    byAnidb.set(anidbId, entry);
    byTvdb.set(tvdbId, [...(byTvdb.get(tvdbId) ?? []), entry]);
  }
  return { byTvdb, byAnidb };
}

/**
 * Fribb's JSON: a series' TVDB id by its IMDb id (the first series entry naming it), each AniDB
 * entry's Kitsu id, and every Kitsu entry filed under an IMDb id. A film or an entry of no kind that
 * names the IMDb id first doesn't hide the series.
 */
export function readJson(json: string): Pick<AnimeLists, "tvdbOfImdb" | "kitsuOfAnidb" | "kitsuOfImdb"> {
  const tvdbOfImdb = new Map<string, number>();
  const kitsuOfAnidb = new Map<number, number>();
  const kitsuOfImdb = new Map<string, Array<{ kitsuId: number; film: boolean }>>();
  for (const item of JSON.parse(json) as Array<{ type?: string; anidb_id?: number; kitsu_id?: number; tvdb_id?: number; imdb_id?: string | string[] }>) {
    if (item.anidb_id && item.kitsu_id) kitsuOfAnidb.set(item.anidb_id, item.kitsu_id);
    if (item.kitsu_id) {
      for (const imdb of [item.imdb_id ?? []].flat()) {
        if (!imdb) continue;
        const entries = kitsuOfImdb.get(imdb) ?? [];
        if (!entries.some((e) => e.kitsuId === item.kitsu_id)) entries.push({ kitsuId: item.kitsu_id, film: String(item.type).toLowerCase() === "movie" });
        kitsuOfImdb.set(imdb, entries);
      }
    }
    if (!item.tvdb_id || !SERIES_KINDS.has(String(item.type).toLowerCase())) continue;
    for (const imdb of [item.imdb_id ?? []].flat()) {
      if (imdb && !tvdbOfImdb.has(imdb)) tvdbOfImdb.set(imdb, item.tvdb_id);
    }
  }
  return { tvdbOfImdb, kitsuOfAnidb, kitsuOfImdb };
}

/** Entries that hold the same TVDB season of one show, the earliest first. */
const sameSeason = (lists: Pick<AnimeLists, "byTvdb">, entry: Entry) =>
  (lists.byTvdb.get(entry.tvdbId) ?? []).filter((e) => e.season === entry.season).sort((x, y) => x.offset - y.offset);

/** A run's regular ranges with a TVDB season, and where the first of them starts (season 1 unmapped comes before it). */
function runRanges(entry: Entry): { ranges: Mapping[]; first: number; ownSeasonOne: boolean } {
  const ranges = entry.mappings.filter((m) => m.anidbSeason === 1 && m.tvdbSeason !== undefined && m.start !== undefined);
  return { ranges, first: Math.min(...ranges.map((m) => m.start!)), ownSeasonOne: ranges.some((m) => m.tvdbSeason === 1) };
}

/** The AniDB entry and episode a TVDB episode is, by the list's first entry that places it. */
function toAnidb(lists: AnimeLists, tvdbId: number, season: number, episode: number): { entry: Entry; anidbSeason: number; episode: number } | undefined {
  for (const entry of lists.byTvdb.get(tvdbId) ?? []) {
    if (entry.season === "a") {
      for (const m of entry.mappings) {
        if (m.tvdbSeason !== season || m.start === undefined) continue;
        const own = episode - m.offset;
        if (own >= m.start && (m.end === undefined || own <= m.end)) return { entry, anidbSeason: m.anidbSeason, episode: own };
      }
      const run = runRanges(entry);
      if (season === 1 && !run.ownSeasonOne && episode < run.first) return { entry, anidbSeason: 1, episode };
      continue;
    }
    if (entry.season === "0" || Number(entry.season) !== season) continue;
    const own = episode - entry.offset;
    if (own <= 0) continue;
    const group = sameSeason(lists, entry);
    if (group.length === 1) return { entry, anidbSeason: 1, episode: own };
    const ranged = entry.mappings.find((m) => (m.tvdbSeason === undefined || m.tvdbSeason === season) && m.start !== undefined && m.end !== undefined && episode >= m.start + entry.offset && episode <= m.end + entry.offset);
    if (ranged) return { entry, anidbSeason: ranged.anidbSeason, episode: own };
    const next = group[group.indexOf(entry) + 1];
    if (next && episode > next.offset) continue;
    return { entry, anidbSeason: 1, episode: own };
  }
  return undefined;
}

/** The TVDB season and episode an AniDB entry's regular episode is (the way back of toAnidb). */
function toTvdb(lists: AnimeLists, entry: Entry, episode: number): { tvdbId: number; season: number; episode: number } | undefined {
  if (entry.season === "a") {
    for (const m of entry.mappings) {
      if (m.anidbSeason !== 1 || m.tvdbSeason === undefined || m.start === undefined) continue;
      if (episode >= m.start && (m.end === undefined || episode <= m.end)) return { tvdbId: entry.tvdbId, season: m.tvdbSeason, episode: episode + m.offset };
    }
    const run = runRanges(entry);
    return !run.ownSeasonOne && episode < run.first ? { tvdbId: entry.tvdbId, season: 1, episode } : undefined;
  }
  if (entry.season === "0" || episode < 1) return undefined;
  const season = Number(entry.season);
  const group = sameSeason(lists, entry);
  if (group.length > 1) {
    const ranged = entry.mappings.find((m) => m.anidbSeason === 1 && m.start !== undefined && m.end !== undefined && episode >= m.start && episode <= m.end);
    if (ranged) return { tvdbId: entry.tvdbId, season: ranged.tvdbSeason || season, episode: episode + (ranged.offset || entry.offset) };
    const next = group[group.indexOf(entry) + 1];
    if (next && episode + entry.offset > next.offset) return undefined;
  }
  return episode + entry.offset > 0 ? { tvdbId: entry.tvdbId, season, episode: episode + entry.offset } : undefined;
}

/**
 * An anime episode, by its IMDb id and its season and episode in TVDB's order: its AniDB entry and the
 * entry's own number for it, the entry's Kitsu id, and whether the entry numbers a run straight through
 * across seasons (`run`). Undefined for anything the lists don't place both ways.
 */
export function placeEpisode(lists: AnimeLists, imdbId: string, season: number, episode: number): { anidbId: number; episode: number; kitsuId?: number; run: boolean } | undefined {
  const tvdbId = lists.tvdbOfImdb.get(imdbId);
  if (!tvdbId) return undefined;
  const found = toAnidb(lists, tvdbId, season, episode);
  if (!found || found.anidbSeason !== 1) return undefined;
  const back = toTvdb(lists, found.entry, found.episode);
  if (!back || back.tvdbId !== tvdbId || back.season !== season || back.episode !== episode) return undefined;
  return { anidbId: found.entry.anidbId, episode: found.episode, kitsuId: lists.kitsuOfAnidb.get(found.entry.anidbId), run: found.entry.season === "a" };
}

/**
 * A show's AniDB entries that hold regular episodes, by its IMDb id, as the lists order them: each
 * one's Kitsu id, when the lists give it, and where its own episode sits in TVDB's order (`place`).
 * Entries of specials and films (default season "0") are left out.
 */
export function showEntries(lists: AnimeLists, imdbId: string): Array<{ anidbId: number; kitsuId?: number; place: (episode: number) => [number, number] | undefined }> {
  const tvdbId = lists.tvdbOfImdb.get(imdbId);
  if (!tvdbId) return [];
  return (lists.byTvdb.get(tvdbId) ?? [])
    .filter((entry) => entry.season !== "0")
    .map((entry) => ({
      anidbId: entry.anidbId,
      kitsuId: lists.kitsuOfAnidb.get(entry.anidbId),
      place: (episode: number) => {
        const at = toTvdb(lists, entry, episode);
        return at && at.tvdbId === tvdbId ? [at.season, at.episode] : undefined;
      }
    }));
}

/** A list's text: the kept copy while it is under a day old, else asked for again (by its ETag), else the kept copy. */
async function listText(name: "xml" | "json"): Promise<string | undefined> {
  const dir = cachePath("anime-lists");
  const file = `${dir}/anime-list-full.${name}`;
  const kept = await stat(file).catch(() => undefined);
  if (kept && Date.now() - kept.mtimeMs < REFRESH_MS) return readFile(file, "utf8");
  const etag = kept ? await readFile(`${file}.etag`, "utf8").catch(() => "") : "";
  try {
    const response = await fetch(LISTS[name], { headers: { "user-agent": "BttrSubs", ...(etag ? { "if-none-match": etag } : {}) }, signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (response.status === 304 && kept) {
      const now = new Date();
      await utimes(file, now, now);
      return readFile(file, "utf8");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(file, text);
    writeFileAtomic(`${file}.etag`, response.headers.get("etag") ?? "");
    return text;
  } catch (error) {
    console.error(`anime lists: ${name} not fetched (${error instanceof Error ? error.message : error})${kept ? ": the kept copy is used" : ""}`);
    return kept ? readFile(file, "utf8") : undefined;
  }
}

let held: { lists: AnimeLists; at: number } | undefined;
let reading: Promise<AnimeLists | undefined> | undefined;

/** Both lists, read; undefined until they have been fetched once. A day-old pair is read again behind the answer. */
export async function animeLists(): Promise<AnimeLists | undefined> {
  if (held && Date.now() - held.at < REFRESH_MS) return held.lists;
  reading ??= (async () => {
    const [xml, json] = await Promise.all([listText("xml"), listText("json")]);
    if (!xml || !json) return held?.lists;
    held = { lists: { ...readXml(xml), ...readJson(json) }, at: Date.now() };
    return held.lists;
  })()
    .catch(() => held?.lists)
    .finally(() => (reading = undefined));
  return held ? held.lists : reading;
}

/** An anime episode by its IMDb id and TVDB-order season and episode (placeEpisode), once the lists are in. */
export async function animeEpisode(imdbId: string, season: number, episode: number): Promise<ReturnType<typeof placeEpisode>> {
  const lists = await animeLists();
  return lists ? placeEpisode(lists, imdbId, season, episode) : undefined;
}

/** Reads the lists at start, so the first anime asked for doesn't wait for them. */
export function startAnimeLists(): void {
  void animeLists();
}
