/**
 * Anime titles from the anime-offline-database (src/animetitles.ts), the fallback for a show's season
 * map when the Anime Kitsu addon gives none and no AniDB client is set (src/ids.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const CACHE = mkdtempSync(path.join(os.tmpdir(), "bttrsubs-animetitles-"));
let titles: typeof import("../src/animetitles.js");
let ids: typeof import("../src/ids.js");
let config: (typeof import("../src/config.js"))["config"];

const anime = (aid: number, title: string, synonyms: string[], episodes: number, more: string[] = []) => ({
  sources: [`https://anidb.net/anime/${aid}`, "https://kitsu.app/anime/1", ...more],
  title,
  synonyms,
  episodes,
  type: "TV"
});
const DATASET = {
  license: { name: "ODbL" },
  data: [
    anime(7101, "Titles Show", ["Titles Show: The Beginning", "TS", "Тайтл Шоу", "タイトルショー", "Titles Show Saga"], 12),
    anime(7102, "Titles Show: Second Arc", ["Titles Show 2", "Titles Show Saga", "Second Arc"], 15),
    anime(7103, "Titles Show: Third Arc", ["Titles Show 3"], 10),
    { sources: ["https://myanimelist.net/anime/5"], title: "No AniDB Show", synonyms: [], episodes: 3 }
  ]
};

/** What was asked of GitHub: the release look-ups and the dataset downloads. */
let asked: string[] = [];
let release = "2026-01";
const sites = (others?: (url: URL) => Response | undefined) =>
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      asked.push("latest");
      return new Response(JSON.stringify({ tag_name: release, assets: [{ name: "anime-offline-database-minified.json.zst", browser_download_url: `https://github.com/manami-project/anime-offline-database/releases/download/${release}/anime-offline-database-minified.json.zst` }] }));
    }
    if (url.hostname === "github.com") {
      asked.push("download");
      return new Response(new Uint8Array(zlib.zstdCompressSync(Buffer.from(JSON.stringify(DATASET)))));
    }
    return others?.(url) ?? new Response("not here", { status: 404 });
  });

beforeAll(async () => {
  process.env.CONFIG_SECRET = "animetitles-test-secret-animetitles-12";
  process.env.CACHE_DIR = CACHE;
  titles = await import("../src/animetitles.js");
  ids = await import("../src/ids.js");
  config = (await import("../src/config.js")).config;
});
beforeEach(() => {
  asked = [];
  titles.resetAnimeTitles();
  Object.assign(config, { anidbClient: undefined, anidbClientVer: undefined, animeTitlesDataset: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

describe("the dataset's index", () => {
  it("keeps, for each AniDB entry, its names in Latin or Japanese script and its episode count", () => {
    const index = titles.indexOf(DATASET);
    expect(Object.keys(index).sort()).toEqual(["7101", "7102", "7103"]);
    expect(index["7101"]).toEqual({ t: ["Titles Show", "Titles Show: The Beginning", "TS", "タイトルショー", "Titles Show Saga"], e: 12 });
    expect(() => titles.indexOf({})).toThrow();
  });

  it("leaves out of one show's entries the names two of them share, and names too short to tell apart", () => {
    const entries = titles.distinctTitles([
      { titles: ["Titles Show", "TS", "Titles Show Saga"], episodes: 12 },
      { titles: ["Titles Show: Second Arc", "titles show  saga", "Second Arc"], episodes: 15 }
    ]);
    expect(entries.map((e) => e.titles)).toEqual([["Titles Show"], ["Titles Show: Second Arc", "Second Arc"]]);
  });
});

describe("reading the dataset", () => {
  it("is downloaded the first time it is needed, kept, and looked up again a day later at most", async () => {
    sites();
    const found = await titles.datasetAnime([7102, 9999]);
    expect([...(found ?? [])]).toEqual([[7102, { titles: ["Titles Show: Second Arc", "Titles Show 2", "Titles Show Saga", "Second Arc"], episodes: 15 }]]);
    expect(asked).toEqual(["latest", "download"]);
    // The same day: nothing is asked of GitHub.
    expect((await titles.datasetAnime([7101]))?.get(7101)?.episodes).toBe(12);
    expect(asked).toEqual(["latest", "download"]);
    // A day later, the same release: looked up, not downloaded again.
    vi.useFakeTimers({ now: Date.now() + 25 * 60 * 60 * 1000, toFake: ["Date"] });
    await titles.datasetAnime([7101]);
    expect(asked).toEqual(["latest", "download", "latest"]);
    // A newer release: downloaded.
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    release = "2026-02";
    await titles.datasetAnime([7101]);
    expect(asked).toEqual(["latest", "download", "latest", "latest", "download"]);
  });

  it("is never downloaded when turned off, and a failed look-up keeps what is at hand and waits an hour", async () => {
    sites();
    config.animeTitlesDataset = false;
    expect(await titles.datasetAnime([7101])).toBeUndefined();
    expect(asked).toEqual([]);
    config.animeTitlesDataset = true;
    vi.useFakeTimers({ now: Date.now() + 80 * 60 * 60 * 1000, toFake: ["Date"] });
    vi.stubGlobal("fetch", async () => {
      asked.push("failed");
      return new Response("no", { status: 500 });
    });
    // The kept index answers though GitHub doesn't.
    expect((await titles.datasetAnime([7101]))?.get(7101)?.episodes).toBe(12);
    await titles.datasetAnime([7101]);
    expect(asked).toEqual(["failed"]);
  });
});

describe("a season map from the dataset", () => {
  const XML = `<anime-list>
<anime anidbid="7101" tvdbid="6100" defaulttvdbseason="1"><name>Titles Show</name></anime>
<anime anidbid="7102" tvdbid="6100" defaulttvdbseason="2"><name>Titles Show: Second Arc</name></anime>
<anime anidbid="7103" tvdbid="6100" defaulttvdbseason="3"><name>Titles Show: Third Arc</name></anime>
</anime-list>`;
  const LISTS = JSON.stringify([7101, 7102, 7103].map((aid) => ({ type: "TV", anidb_id: aid, kitsu_id: aid + 1000, imdb_id: "tt0006101", tvdb_id: 6100 })));
  const others = (url: URL) => {
    if (url.hostname === "raw.githubusercontent.com") return new Response(url.pathname.endsWith(".xml") ? XML : LISTS, { headers: { etag: '"1"' } });
    if (url.pathname.includes("/catalog/")) return new Response(JSON.stringify({ metas: [] }), { headers: { "content-type": "application/json" } });
    return undefined;
  };

  it("is made behind the answer when the addon gives none and no AniDB client is set, with the shared names left out", async () => {
    sites(others);
    expect(await ids.seasonMap("tt0006101", async () => "Titles Show")).toBeUndefined();
    await ids.titlesMapUnderWay("tt0006101");
    const map = await ids.seasonMap("tt0006101", async () => "Titles Show");
    expect(map?.entries.map((e) => e.kitsuId)).toEqual(["8101", "8102", "8103"]);
    expect(map?.entries[0].titles).toEqual(["Titles Show", "Titles Show: The Beginning", "タイトルショー"]);
    expect(map?.entries[1].titles).toEqual(["Titles Show: Second Arc", "Titles Show 2", "Second Arc"]);
    // The second entry's first episode is season 2's first, as the lists place it.
    expect(map?.entries[1].episodes["1"]).toEqual([2, 1]);
    expect(Object.keys(map?.entries[1].episodes ?? {})).toHaveLength(15);
  });

  it("stands in while an AniDB client is set but AniDB can't answer for every entry yet", async () => {
    const anidb = await import("../src/anidb.js");
    const cache = await import("../src/cache.js");
    sites(others);
    anidb.resetAnidb();
    Object.assign(config, { anidbClient: "testclient", anidbClientVer: 1 });
    // The day's count is spent: AniDB is asked nothing.
    const before = anidb.anidbPace.dailyMax;
    anidb.anidbPace.dailyMax = 0;
    try {
      await cache.writeJsonCache("results", cache.cacheKey({ kind: "season-map", imdbId: "tt0006101" }), {}, 1);
      expect(await ids.seasonMap("tt0006101", async () => "Titles Show")).toBeUndefined();
      await ids.titlesMapUnderWay("tt0006101");
      expect((await ids.seasonMap("tt0006101", async () => "Titles Show"))?.entries).toHaveLength(3);
      expect(asked.filter((a) => a === "download").length).toBeLessThanOrEqual(1);
    } finally {
      anidb.anidbPace.dailyMax = before;
    }
  });

  it("isn't made, and nothing is downloaded, when the dataset is turned off", async () => {
    sites(others);
    config.animeTitlesDataset = false;
    expect(await ids.seasonMap("tt0006102", async () => "Other Titles Show")).toBeUndefined();
    expect(ids.titlesMapUnderWay("tt0006102")).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
