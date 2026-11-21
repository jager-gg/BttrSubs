/**
 * Anime titles without an account anywhere: the anime-offline-database (manami-project, ODbL 1.0), a
 * public dataset that gathers each anime's names from ten sites and says which AniDB entry it is. It is
 * the fallback for a show's season map when the Anime Kitsu addon gives none and no AniDB client is
 * set (ids.ts): AniDB's own titles are exact, these are many and loose.
 *
 * Nothing is fetched until a show needs it. Then the newest release is looked up on GitHub (once a
 * day at most), its one compressed file downloaded when the release changed (about 5 MB, 60 MB
 * unpacked), and only what is used is kept from it, in the cache folder: for each AniDB entry its
 * names in Latin or Japanese script and its number of episodes. That index is read from disk when a
 * map is made and not held in memory. A download that fails leaves the index at hand in use and is
 * tried again after an hour.
 *
 * What it can't give: where an entry's episodes sit in TVDB's order (the anime lists do that), and an
 * episode count that is AniDB's (its counts come from several sites, and include specials on some).
 */
import { mkdir, readFile } from "node:fs/promises";
import zlib from "node:zlib";
import { cachePath, writeFileAtomic } from "./cache.js";
import { config } from "./config.js";
import { count } from "./stats.js";

const LATEST = "https://api.github.com/repos/manami-project/anime-offline-database/releases/latest";
/** The dataset's file in a release: compressed, and plain for a Node that can't unpack Zstandard. */
const ASSETS = ["anime-offline-database-minified.json.zst", "anime-offline-database-minified.json"];
const HEADERS = { "user-agent": "BttrSubs", accept: "application/vnd.github+json" };
/** How often the newest release is looked up, and how soon after a failure. */
const CHECK_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const DOWNLOAD_MS = 120_000;
/** Names kept for one entry at most, the entry's own title first. */
const MAX_NAMES = 40;

export interface DatasetAnime {
  titles: string[];
  episodes: number;
}

interface Index {
  /** The release it was made from ("2026-27"), and when that was last found to be the newest. */
  release: string;
  checkedAt: number;
  byAnidb: Record<string, { t: string[]; e: number }>;
}

/** Whether the dataset is used: on unless ANIME_TITLES_DATASET turns it off. */
export function datasetEnabled(): boolean {
  return config.animeTitlesDataset;
}

const indexFile = () => cachePath("anime-titles", "index.json");

async function readIndex(): Promise<Index | undefined> {
  try {
    const read = JSON.parse(await readFile(indexFile(), "utf8")) as Index;
    return read && typeof read.release === "string" && read.byAnidb && typeof read.byAnidb === "object" ? read : undefined;
  } catch {
    return undefined;
  }
}

/** A name a subtitle upload could be written with: Latin letters, digits or Japanese script in it. */
const usable = (name: string) => /[a-z0-9぀-ヿ一-鿿]/i.test(name);

/** The dataset as the index keeps it: the entries that name an AniDB entry, their names and episode counts. */
export function indexOf(dataset: unknown): Index["byAnidb"] {
  const rows = (dataset as { data?: Array<{ sources?: unknown; title?: unknown; synonyms?: unknown; episodes?: unknown }> }).data;
  if (!Array.isArray(rows)) throw new Error("the dataset has no entries");
  const byAnidb: Index["byAnidb"] = {};
  for (const row of rows) {
    const sources = Array.isArray(row.sources) ? row.sources : [];
    const aids = sources.flatMap((s) => /^https?:\/\/anidb\.net\/anime\/(\d+)\/?$/.exec(String(s))?.[1] ?? []);
    if (!aids.length || typeof row.title !== "string") continue;
    const names = [row.title, ...(Array.isArray(row.synonyms) ? row.synonyms : [])].filter((n): n is string => typeof n === "string" && n.trim() !== "" && usable(n)).map((n) => n.trim());
    const titles = [...new Set(names)].slice(0, MAX_NAMES);
    if (!titles.length) continue;
    for (const aid of aids) byAnidb[aid] = { t: titles, e: Number.isInteger(row.episodes) && (row.episodes as number) > 0 ? (row.episodes as number) : 0 };
  }
  return byAnidb;
}

async function download(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(DOWNLOAD_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const unpack = (zlib as { zstdDecompressSync?: (data: Buffer) => Buffer }).zstdDecompressSync;
  const text = url.endsWith(".zst") ? unpack!(body).toString("utf8") : body.toString("utf8");
  return JSON.parse(text);
}

let refreshing: Promise<Index | undefined> | undefined;
let failedAt = 0;

/** The index, made or brought up to date first when it is due (see the top): undefined when there is none and none could be made. */
async function index(now = Date.now()): Promise<Index | undefined> {
  const kept = await readIndex();
  if (kept && now - kept.checkedAt < CHECK_MS) return kept;
  if (now - failedAt < RETRY_MS) return kept;
  refreshing ??= (async () => {
    try {
      count("api.github.animeTitles");
      const latest = await fetch(LATEST, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!latest.ok) throw new Error(`GitHub ${latest.status}`);
      const release = (await latest.json()) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
      if (!release.tag_name) throw new Error("the release has no name");
      if (kept && kept.release === release.tag_name) {
        const same: Index = { ...kept, checkedAt: Date.now() };
        await mkdir(cachePath("anime-titles"), { recursive: true });
        writeFileAtomic(indexFile(), JSON.stringify(same));
        return same;
      }
      const canUnpack = typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function";
      const asset = ASSETS.filter((name) => canUnpack || !name.endsWith(".zst"))
        .map((name) => release.assets?.find((a) => a.name === name)?.browser_download_url)
        .find((url): url is string => typeof url === "string" && url.startsWith("https://github.com/"));
      if (!asset) throw new Error(`release ${release.tag_name} has no dataset file`);
      const started = Date.now();
      const made: Index = { release: release.tag_name, checkedAt: Date.now(), byAnidb: indexOf(await download(asset)) };
      await mkdir(cachePath("anime-titles"), { recursive: true });
      writeFileAtomic(indexFile(), JSON.stringify(made));
      count("fetch.animeTitles");
      console.log(`anime titles: the dataset's release ${made.release} read in ${Date.now() - started} ms: ${Object.keys(made.byAnidb).length} AniDB entries kept`);
      return made;
    } catch (error) {
      failedAt = Date.now();
      console.error(`anime titles: the dataset couldn't be brought up to date (${error instanceof Error ? error.message : error}); ${kept ? `release ${kept.release} stays in use` : "there is none yet"}, tried again in an hour`);
      return kept;
    }
  })().finally(() => (refreshing = undefined));
  return refreshing;
}

/** The dataset's names and episode counts for these AniDB entries: one it doesn't have is left out. Undefined without a dataset. */
export async function datasetAnime(aids: number[]): Promise<Map<number, DatasetAnime> | undefined> {
  if (!datasetEnabled()) return undefined;
  const at = await index();
  if (!at) return undefined;
  const found = new Map<number, DatasetAnime>();
  for (const aid of aids) {
    const entry = at.byAnidb[String(aid)];
    if (entry) found.set(aid, { titles: entry.t, episodes: entry.e });
  }
  return found;
}

/** A name as two entries' names are compared: lower case, letters and digits only. */
const plain = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * One show's entries with the names that tell them apart: a name two or more of the show's entries
 * carry is left out of all of them (the dataset files a season's name under its sequel too), and so
 * is a name too short to be told from a word in another title.
 */
export function distinctTitles<T extends { titles: string[] }>(entries: T[]): T[] {
  const owners = new Map<string, number>();
  for (const entry of entries) for (const name of new Set(entry.titles.map(plain))) owners.set(name, (owners.get(name) ?? 0) + 1);
  return entries.map((entry) => ({ ...entry, titles: entry.titles.filter((name) => plain(name).length >= MIN_NAME && owners.get(plain(name)) === 1) }));
}
const MIN_NAME = 4;

/** For tests: forget a failed download, so the next look tries again. */
export function resetAnimeTitles(): void {
  failedAt = 0;
  refreshing = undefined;
}
