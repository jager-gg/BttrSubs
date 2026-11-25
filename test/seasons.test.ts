/**
 * Anime seasons named by their own titles: the season map built from the Anime Kitsu addon (its
 * catalog searched by the show's name, each entry's titles and episodes), names read through it
 * ("Show: Second Arc - 03" is season 2's third, "Show: Third Arc Part 2 - 01" is season 3's twelfth),
 * every SubSource record of the show searched, the file of a part's pack found by its own number, and
 * everything as before without a map.
 */
import AdmZip from "adm-zip";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SeasonMap, StremioSubtitleRequest, SubSourceSubtitle } from "../src/types.js";

const CACHE = ".cache-seasons-test";
let ids: typeof import("../src/ids.js");
let matching: typeof import("../src/matching.js");
let downloads: typeof import("../src/downloads.js");
let subsource: typeof import("../src/subsource.js");
let cache: typeof import("../src/cache.js");

beforeAll(async () => {
  process.env.CACHE_DIR = CACHE;
  ids = await import("../src/ids.js");
  matching = await import("../src/matching.js");
  downloads = await import("../src/downloads.js");
  subsource = await import("../src/subsource.js");
  cache = await import("../src/cache.js");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

/** The anime lists as served (animelists.ts): a run numbered through, its film, a run Cinemeta splits otherwise, a show of an entry a season. */
const ANIME_XML = `<anime-list>
<anime anidbid="900" tvdbid="5000" defaulttvdbseason="a"><name>Show</name><mapping-list><mapping anidbseason="1" tvdbseason="2" start="26" end="55" offset="-25"/></mapping-list></anime>
<anime anidbid="901" tvdbid="5000" defaulttvdbseason="0"><name>Show film</name></anime>
<anime anidbid="910" tvdbid="5010" defaulttvdbseason="a"><name>Show</name><mapping-list><mapping anidbseason="1" tvdbseason="2" start="26" end="55" offset="-25"/></mapping-list></anime>
<anime anidbid="920" tvdbid="5020" defaulttvdbseason="1"><name>Other Show</name></anime>
<anime anidbid="921" tvdbid="5020" defaulttvdbseason="2"><name>Other Show second</name></anime>
</anime-list>`;
const ANIME_JSON = JSON.stringify([
  { type: "TV", anidb_id: 900, kitsu_id: 900, imdb_id: ["tt0000902"], tvdb_id: 5000 },
  { type: "Movie", anidb_id: 901, kitsu_id: 901, imdb_id: ["tt0000903"], tvdb_id: 5000 },
  { type: "TV", anidb_id: 910, kitsu_id: 910, imdb_id: "tt0000911", tvdb_id: 5010 },
  { type: "TV", anidb_id: 920, kitsu_id: 920, imdb_id: ["tt0000912"], tvdb_id: 5020 },
  { type: "TV", anidb_id: 921, kitsu_id: 921, tvdb_id: 5020 },
  // A show of five entries, a film among them, and one of twenty-five.
  { type: "TV", anidb_id: 9701, kitsu_id: 9701, imdb_id: "tt0000971", tvdb_id: 5070 },
  { type: "TV", anidb_id: 9702, kitsu_id: 9702, imdb_id: "tt0000971", tvdb_id: 5070 },
  { type: "Movie", anidb_id: 9703, kitsu_id: 9703, imdb_id: "tt0000971", tvdb_id: 5070 },
  { type: "OVA", anidb_id: 9704, kitsu_id: 9704, imdb_id: "tt0000971", tvdb_id: 5070 },
  { type: "Special", anidb_id: 9705, kitsu_id: 9705, imdb_id: "tt0000971", tvdb_id: 5070 },
  ...Array.from({ length: 25 }, (_, i) => ({ type: "TV", anidb_id: 9801 + i, kitsu_id: 9801 + i, imdb_id: "tt0000972", tvdb_id: 5080 }))
]);
const animeList = (url: URL) =>
  url.hostname === "raw.githubusercontent.com" ? new Response(url.pathname.endsWith(".xml") ? ANIME_XML : ANIME_JSON, { headers: { etag: '"1"' } }) : undefined;

describe("a file numbered with no season, found as the anime numbers its episode", () => {
  it("asks AIOStreams for the Kitsu episode when the IMDb episode's list lacks the file, and takes it only there", async () => {
    const sync = await import("../src/sync.js");
    const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
    const PLAYED = "[Group] Show 037 [BD 1080p][ABCD1234].mkv";
    const lists: Record<string, string[]> = { "tt0000902:2:12": ["[Group] Show 038 [BD 1080p][EF015678].mkv"], "kitsu:900:37": [PLAYED] };
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      const list = animeList(url);
      if (list) return list;
      const stream = /\/stream\/series\/(.+)\.json$/.exec(decodeURIComponent(url.pathname));
      if (stream) {
        asked.push(stream[1]);
        return json({ streams: (lists[stream[1]] ?? []).map((filename) => ({ url: `https://debrid.example/${encodeURIComponent(filename)}`, behaviorHints: { filename } })) });
      }
      return new Response("x", { status: 200 });
    });
    expect(await sync.lookUpStreamAgain(AIO, "tt0000902:2:12", "series", PLAYED, [1])).toBe(`https://debrid.example/${encodeURIComponent(PLAYED)}`);
    expect(asked).toEqual(["tt0000902:2:12", "kitsu:900:37"]);
    // A season the lists don't place: only the IMDb episode's list, asked again.
    asked.length = 0;
    expect(await sync.lookUpStreamAgain(AIO, "tt0000902:3:1", "series", "[Group] Show 051 [BD 1080p].mkv", [1])).toBeUndefined();
    expect(asked).toEqual(["tt0000902:3:1", "tt0000902:3:1"]);
  });

  it("asks for the Kitsu episode for a file named with its season too: a player that lists anime by Kitsu ids chose from that list", async () => {
    const sync = await import("../src/sync.js");
    sync.forgetStreams();
    const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
    const PLAYED = "Show - S02E12 - 037 [1080p][JA+EN]-TEAM";
    const lists: Record<string, string[]> = { "tt0000902:2:12": ["Show.S02E12.1080p.BluRay.x265-CREW"], "kitsu:900:37": ["Show.S02E12.1080p.BluRay.x265-CREW", PLAYED] };
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      const list = animeList(url);
      if (list) return list;
      const stream = /\/stream\/series\/(.+)\.json$/.exec(decodeURIComponent(url.pathname));
      if (stream) {
        asked.push(stream[1]);
        return json({ streams: (lists[stream[1]] ?? []).map((filename) => ({ url: `https://debrid.example/${encodeURIComponent(filename)}`, behaviorHints: { filename } })) });
      }
      return new Response("x", { status: 200 });
    });
    expect(await sync.lookUpStreamAgain(AIO, "tt0000902:2:12", "series", PLAYED, [1])).toBe(`https://debrid.example/${encodeURIComponent(PLAYED)}`);
    expect(asked).toEqual(["tt0000902:2:12", "kitsu:900:37"]);
    // A file its own list holds is taken there, and the Kitsu episode isn't asked for.
    asked.length = 0;
    sync.forgetStreams();
    expect(await sync.lookUpStreamAgain(AIO, "tt0000902:2:12", "series", "Show.S02E12.1080p.BluRay.x265-CREW", [1])).toBeDefined();
    expect(asked).toEqual(["tt0000902:2:12"]);
  });

  it("asks only by the id it was given for a title the anime lists don't hold", async () => {
    const sync = await import("../src/sync.js");
    sync.forgetStreams();
    const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
    const asked: string[] = [];
    const lists: Record<string, string[]> = { "kitsu:900:37": ["Show - S02E12 - 037-TEAM"], "tt0000950:1:3": ["Other.Show.S01E03.1080p.WEB-CREW"] };
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      const list = animeList(url);
      if (list) return list;
      const stream = /\/stream\/series\/(.+)\.json$/.exec(decodeURIComponent(url.pathname));
      if (stream) {
        asked.push(stream[1]);
        return json({ streams: (lists[stream[1]] ?? []).map((filename) => ({ url: `https://debrid.example/${encodeURIComponent(filename)}`, behaviorHints: { filename } })) });
      }
      return new Response("x", { status: 200 });
    });
    expect(await sync.lookUpStreamAgain(AIO, "tt0000902:2:12", "series", "Show - S02E12 - 037-TEAM", [1])).toBeDefined();
    asked.length = 0;
    expect(await sync.lookUpStreamAgain(AIO, "tt0000950:1:3", "series", "Other.Show.S01E03.1080p.WEB-CREW", [1])).toBeDefined();
    expect(asked).toEqual(["tt0000950:1:3"]);
  });
});

describe("an episode counted across seasons", () => {
  it("counts each earlier season to its last episode, not its entries", async () => {
    const run1to = (season: number, last: number, skip = 0) => Array.from({ length: last }, (_, i) => ({ season, episode: i + 1 })).filter((v) => v.episode !== skip);
    const videos = [{ season: 0, episode: 1 }, { season: 1, episode: 0 }, ...run1to(1, 25), { season: 1, episode: 25 }, ...run1to(2, 41, 20), { season: 3, episode: 1 }];
    vi.stubGlobal("fetch", async (input: string | URL) => (String(input).endsWith("/meta/series/tt0000901.json") ? json({ meta: { videos } }) : json({}, 404)));
    // Season 1 lists an episode 0 and its 25th twice: season 2's 12th is the 37th. Season 2 lacks its 20th and ends at 41.
    expect(await subsource.absoluteEpisode("tt0000901", 2, 12)).toBe(37);
    expect(await subsource.absoluteEpisode("tt0000901", 3, 1)).toBe(25 + 41 + 1);
    expect(await subsource.absoluteEpisode("tt0000901", 1, 9)).toBe(9);
  });

  it("counts an anime the lists hold as one run by its number there", async () => {
    // Cinemeta splits the seasons otherwise (season 1 ends at 27); the lists number the run straight through.
    const run1to = (season: number, last: number) => Array.from({ length: last }, (_, i) => ({ season, episode: i + 1 }));
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      const list = animeList(url);
      if (list) return list;
      const cinemeta = /\/meta\/series\/(tt\d+)\.json$/.exec(url.pathname)?.[1];
      if (cinemeta === "tt0000911") return json({ meta: { name: "Show", videos: [...run1to(1, 27), ...run1to(2, 30)] } });
      if (cinemeta === "tt0000912") return json({ meta: { name: "Other Show", videos: [...run1to(1, 13), ...run1to(2, 12)] } });
      return json({}, 404);
    });
    expect(await subsource.absoluteEpisode("tt0000911", 2, 12, true)).toBe(37);
    // Not known as anime: Cinemeta's count, as before.
    expect(await subsource.absoluteEpisode("tt0000911", 2, 12)).toBe(27 + 12);
    // An entry a season numbers its season, not the run: Cinemeta's count.
    expect(await subsource.absoluteEpisode("tt0000912", 2, 5, true)).toBe(13 + 5);
    // An episode the run's ranges don't reach: Cinemeta's count.
    expect(await subsource.absoluteEpisode("tt0000911", 2, 31, true)).toBe(27 + 31);
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Episodes own number -> IMDb place: from..to of this entry, starting at IMDb's season and episode. */
const run = (count: number, season: number, first = 1) => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), [season, first + i] as [number, number]]));

/** A show with a base season, a second arc, a third arc in two parts and a special, as Anime Kitsu lists such a show. */
const MAP: SeasonMap = {
  show: "Show",
  entries: [
    { titles: ["Show", "SHOW"], episodes: run(12, 1) },
    { titles: ["Show: Second Arc", "Show 2nd Season", "Show Second Season"], episodes: run(11, 2) },
    { titles: ["Show: Third Arc", "Show Season 3"], episodes: run(11, 3) },
    { titles: ["Show: Third Arc Part 2", "Show Season 3 Part 2", "ショー 第3期"], episodes: run(11, 3, 12) },
    { titles: ["Show: Second Arc Special", "Show (2016)"], episodes: { "1": [0, 1] } }
  ]
};

const sub = (subtitleId: number, names: string[], extra: Partial<SubSourceSubtitle> = {}): SubSourceSubtitle => ({
  subtitleId,
  movieId: 1,
  language: "arabic",
  releaseInfo: names,
  commentary: null,
  files: null,
  downloads: 0,
  rating: null,
  ...extra
});
const episode = (season: number, ep: number, absoluteEpisode?: number): StremioSubtitleRequest => ({ type: "series", id: `tt0000981:${season}:${ep}`, imdbId: "tt0000981", season, episode: ep, absoluteEpisode });
/** Which of these subtitles fit the request, read with the map (or without one: null). */
const fitting = (subs: SubSourceSubtitle[], request: StremioSubtitleRequest, map: SeasonMap | null = MAP) =>
  matching.filterAndRankDubtitles(subs, request, { requireDub: false, seasonMap: map ?? undefined }).map((s) => s.subtitleId);
const read = (name: string, request: StremioSubtitleRequest, extra: Partial<SubSourceSubtitle> = {}) => matching.readByTitle(sub(1, [name], extra), request, MAP);

describe("the season map", () => {
  const search = (metas: unknown[]) => json({ metas });
  const meta = (name: string, aliases: string[], videos: Array<[number, number, number]>) =>
    json({ meta: { name, aliases, imdb_id: "tt0000982", videos: videos.map(([episode, imdbSeason, imdbEpisode]) => ({ id: `kitsu:0:${episode}`, episode, imdbSeason, imdbEpisode })) } });

  it("is built from the catalog search, keeping only this show's entries, and cached", async () => {
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.push(url);
      if (url.includes("/catalog/anime/kitsu-anime-list/search=Show%20Two.json")) {
        return search([
          { id: "kitsu:9001", type: "series", imdb_id: "tt0000982" },
          { id: "kitsu:9002", type: "series", imdb_id: "tt0000982" },
          { id: "kitsu:9003", type: "series", imdb_id: "tt0000999" },
          { id: "kitsu:9004", type: "series" }
        ]);
      }
      if (url.endsWith("/meta/series/kitsu:9001.json")) return meta("Show Two", ["SHOW TWO"], [[1, 1, 1], [2, 1, 2]]);
      if (url.endsWith("/meta/series/kitsu:9002.json")) return meta("Show Two: Second Arc", ["Show Two 2nd Season"], [[1, 2, 1], [2, 2, 2]]);
      return new Response("not here", { status: 404 });
    });
    const map = await ids.seasonMap("tt0000982", async () => "Show Two");
    expect(map).toEqual({
      show: "Show Two",
      entries: [
        { kitsuId: "9001", titles: ["Show Two", "SHOW TWO"], episodes: { "1": [1, 1], "2": [1, 2] } },
        { kitsuId: "9002", titles: ["Show Two: Second Arc", "Show Two 2nd Season"], episodes: { "1": [2, 1], "2": [2, 2] } }
      ]
    });
    // Another show's entry and one without an IMDb id aren't fetched.
    expect(hits.filter((h) => h.includes("/meta/"))).toHaveLength(2);
    // Kept: asked again, nothing is fetched, not even the show's name.
    const asked = hits.length;
    const name = vi.fn(async () => "Show Two");
    expect(await ids.seasonMap("tt0000982", name)).toEqual(map);
    expect(hits).toHaveLength(asked);
    expect(name).not.toHaveBeenCalled();
  });

  it("is read again when the kept one has no Kitsu ids", async () => {
    const key = cache.cacheKey({ kind: "season-map", imdbId: "tt0000989" });
    await cache.writeJsonCache("results", key, { map: { show: "Show Nine", entries: [{ titles: ["Show Nine"], episodes: { "1": [1, 1] } }, { titles: ["Show Nine: Second Arc"], episodes: { "1": [2, 1] } }] } }, 3600);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search=Show%20Nine.json")) return search([{ id: "kitsu:9091", type: "series", imdb_id: "tt0000989" }, { id: "kitsu:9092", type: "series", imdb_id: "tt0000989" }]);
      if (url.endsWith("/meta/series/kitsu:9091.json")) return meta("Show Nine", [], [[1, 1, 1]]);
      if (url.endsWith("/meta/series/kitsu:9092.json")) return meta("Show Nine: Second Arc", [], [[1, 2, 1]]);
      return new Response("not here", { status: 404 });
    });
    expect((await ids.seasonMap("tt0000989", async () => "Show Nine"))?.entries.map((e) => e.kitsuId)).toEqual(["9091", "9092"]);
  });

  it("is none for a show with one entry, and none when any entry can't be read", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search=Show%20One.json")) return search([{ id: "kitsu:9011", type: "series", imdb_id: "tt0000983" }]);
      if (url.includes("search=Show%20Three.json")) return search([{ id: "kitsu:9021", type: "series", imdb_id: "tt0000984" }, { id: "kitsu:9022", type: "series", imdb_id: "tt0000984" }]);
      if (url.endsWith("/meta/series/kitsu:9021.json")) return meta("Show Three", [], [[1, 1, 1]]);
      if (url.endsWith("/meta/series/kitsu:9022.json")) return new Response("busy", { status: 503 });
      return new Response("not here", { status: 404 });
    });
    expect(await ids.seasonMap("tt0000983", async () => "Show One")).toBeUndefined();
    // A map missing an entry would read that entry's names as another's.
    expect(await ids.seasonMap("tt0000984", async () => "Show Three")).toBeUndefined();
  });

  it("is none, not a part of one, for a show the anime lists don't know, when the search's answer is full", async () => {
    const metas: string[] = [];
    const entries = (imdbId: string, count: number, first: number) => Array.from({ length: count }, (_, i) => ({ id: `kitsu:${first + i}`, type: "series", imdb_id: imdbId }));
    const others = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `kitsu:${9900 + i}`, type: "series", imdb_id: "tt0000999" }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      // Twenty results, the most the search gives: two of this show's, eighteen of others. More of its
      // entries may have been cut off, and nothing else says which entries it has.
      if (url.includes("search=Show%20Full.json")) return search([...entries("tt0000987", 2, 9051), ...others(18)]);
      if (url.includes("search=Show%20Room.json")) return search([...entries("tt0000988", 2, 9061), ...others(17)]);
      const id = /kitsu:(\d+)\.json$/.exec(url)?.[1];
      if (id) {
        metas.push(id);
        return meta(`Show ${id}`, [], [[1, Number(id) - 9000, 1]]);
      }
      return new Response("not here", { status: 404 });
    });
    expect(await ids.seasonMap("tt0000987", async () => "Show Full")).toBeUndefined();
    // Nothing was fetched for it.
    expect(metas).toEqual([]);
    // One result fewer: the answer held them all.
    expect((await ids.seasonMap("tt0000988", async () => "Show Room"))?.entries).toHaveLength(2);
  });

  it("holds every entry the anime lists file under the show, whatever the search gave of them", async () => {
    const asked: string[] = [];
    const others = Array.from({ length: 19 }, (_, i) => ({ id: `kitsu:${9900 + i}`, type: "series", imdb_id: "tt0000999" }));
    const entry = (id: number, imdb = "tt0000971") => json({ meta: { name: `Listed Show ${id}`, aliases: [], imdb_id: imdb, videos: [{ id: `kitsu:${id}:1`, episode: 1, imdbSeason: id - 9700, imdbEpisode: 1 }] } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const list = animeList(url);
      if (list) return list;
      asked.push(url.pathname);
      // A full answer with one of the show's four listed entries in it: the search finds entries by name.
      if (url.pathname.includes("search=Listed%20Show.json")) return search([{ id: "kitsu:9701", type: "series", imdb_id: "tt0000971" }, ...others]);
      // Too many for one show, by the lists.
      if (url.pathname.includes("search=Listed%20Many.json")) return search([{ id: "kitsu:9801", type: "series", imdb_id: "tt0000972" }]);
      // The lists' third entry is a film the addon has only as a film; their fourth it files under another show; their fifth it doesn't have.
      if (url.pathname.endsWith("/meta/series/kitsu:9703.json") || url.pathname.endsWith("kitsu:9705.json")) return new Response("not here", { status: 404 });
      if (url.pathname.endsWith("kitsu:9704.json")) return entry(9704, "tt0000999");
      const id = /kitsu:(\d+)\.json$/.exec(url.pathname)?.[1];
      return id ? entry(Number(id)) : new Response("not here", { status: 404 });
    });
    const map = await ids.seasonMap("tt0000971", async () => "Listed Show");
    expect(map?.entries.map((e) => e.kitsuId).sort()).toEqual(["9701", "9702", "9703"]);
    expect(asked).toContain("/meta/movie/kitsu:9703.json");
    // A show the lists give more entries than are read has none, and none of them is asked for.
    asked.length = 0;
    expect(await ids.seasonMap("tt0000972", async () => "Listed Many")).toBeUndefined();
    expect(asked.filter((p) => p.includes("/meta/"))).toEqual([]);
  });

  it("is made again when the kept one was made before the lists were read for it", async () => {
    const key = cache.cacheKey({ kind: "season-map", imdbId: "tt0000973" });
    await cache.writeJsonCache("results", key, { map: { show: "Old Show", entries: [{ kitsuId: "1", titles: ["Old Show"], episodes: {} }, { kitsuId: "2", titles: ["Old Show 2"], episodes: {} }] } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("search=Old%20Show.json")) return search([{ id: "kitsu:9711", type: "series", imdb_id: "tt0000973" }, { id: "kitsu:9712", type: "series", imdb_id: "tt0000973" }]);
      const id = /kitsu:(\d+)\.json$/.exec(url)?.[1];
      return id ? json({ meta: { name: `Old Show ${id}`, aliases: [], imdb_id: "tt0000973", videos: [] } }) : new Response("not here", { status: 404 });
    });
    expect((await ids.seasonMap("tt0000973", async () => "Old Show"))?.entries.map((e) => e.kitsuId)).toEqual(["9711", "9712"]);
  });

  it("is none when the addon can't be reached, and that is kept briefly, not asked again at once", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new TypeError("fetch failed");
    });
    expect(await ids.seasonMap("tt0000985", async () => "Show Four")).toBeUndefined();
    expect(await ids.seasonMap("tt0000985", async () => "Show Four")).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("a name read through the season map", () => {
  it("tells two specials apart by their titles, however a long vowel is spelled and whatever year the name gives", () => {
    const specials: SeasonMap = {
      show: "Show",
      entries: [
        { titles: ["Show"], episodes: run(12, 1) },
        { titles: ["Show: Special Feature"], episodes: { "1": [0, 1] } },
        { titles: ["Show: Kuuki"], episodes: { "1": [0, 2] } }
      ]
    };
    const names = [sub(1, ["Show.Kuki.2022.JAPANESE.WEB-DL"], { recordSeason: 3 }), sub(2, ["[Group] Show Kuki Special (2022)"], { recordSeason: 3 })];
    expect(fitting(names, episode(0, 2), specials)).toEqual([1, 2]);
    expect(fitting(names, episode(0, 1), specials)).toEqual([]);
    // A year isn't an episode: the number after it is.
    expect(matching.readByTitle(sub(3, ["Show 2022 - 05"]), episode(1, 5), specials)).toEqual({ fits: true, exact: true });
  });

  it("with the show's title alone is the first season's", () => {
    const base = [sub(1, ["[Group] Show - 03 [1080p]"])];
    expect(fitting(base, episode(1, 3))).toEqual([1]);
    expect(fitting(base, episode(2, 3, 15))).toEqual([]);
    expect(fitting(base, episode(3, 3, 26))).toEqual([]);
  });

  it("with a later season's title is that season's, from whichever season's record it is listed under", () => {
    const names = [sub(1, ["Show - 03"], { recordSeason: 4 }), sub(2, ["Show: Second Arc - 03"], { recordSeason: 4 }), sub(3, ["Show: Third Arc - 03"], { recordSeason: 4 })];
    expect(fitting(names, episode(2, 3, 15))).toEqual([2]);
    expect(fitting(names, episode(3, 3, 26))).toEqual([3]);
    expect(fitting(names, episode(1, 3))).toEqual([1]);
    // Its number names this exact episode.
    expect(read("Show: Second Arc - 03", episode(2, 3, 15))).toEqual({ fits: true, exact: true });
  });

  it("counts a part's episodes from 1, as the part's own title does", () => {
    expect(read("Show: Third Arc Part 2 - 01", episode(3, 12, 35))).toEqual({ fits: true, exact: true, pick: 1 });
    expect(read("Show: Third Arc Part 2 - 01", episode(3, 1, 24))).toEqual({ fits: false });
    // "Cour 2" and "Cour Part 2" are the same part.
    expect(read("[Group] Show - Third Arc Cour Part 2 - 01 [1080p]", episode(3, 12, 35))?.pick).toBe(1);
    expect(read("[Group] Show - Third Arc Cour 2 - 011 [1080p]", episode(3, 22, 45))?.pick).toBe(11);
    // A number past the first part's own episodes counts on within its season.
    expect(read("Show: Third Arc - 21", episode(3, 21, 44))).toEqual({ fits: true, exact: true });
    // The same file named both ways: the number right after the title counts, the part's in brackets doesn't.
    expect(read("Show: Third Arc - 21 [P2 - 10]", episode(3, 10, 33))).toEqual({ fits: false });
    expect(read("Show: Third Arc - 21 [P2 - 10]", episode(3, 21, 44))).toEqual({ fits: true, exact: true });
    expect(fitting([sub(4, ["Show: Third Arc Part 2 - 10", "Show: Third Arc - 21 [P2 - 10]"])], episode(3, 10, 33))).toEqual([]);
    expect(fitting([sub(4, ["Show: Third Arc Part 2 - 10", "Show: Third Arc - 21 [P2 - 10]"])], episode(3, 21, 44))).toEqual([4]);
  });

  it("knows a season by its aliases, in any of their forms", () => {
    for (const name of ["Show 2nd Season - 05", "Show Second Season - 05", "Show S2 - 05", "Show Season 2 - 05", "Show.Season.Two.05"]) {
      expect(read(name, episode(2, 5, 17)), name).toEqual({ fits: true, exact: true });
    }
    expect(read("Show Season 3 Part 2 - 02", episode(3, 13, 36))?.pick).toBe(2);
    // An alias in another script is left out; one that is a year tells nothing.
    expect(read("Show (2016) - 01", episode(0, 1))?.fits).not.toBe(true);
  });

  it("takes a pack's range in the part's own count", () => {
    const pack = sub(1, ["Show: Third Arc Part 2 [1 ~ 11]"]);
    expect(matching.readByTitle(pack, episode(3, 15, 38), MAP)).toEqual({ fits: true, exact: false, pick: 4 });
    expect(matching.readByTitle(pack, episode(3, 4, 27), MAP)).toEqual({ fits: false });
    expect(fitting([sub(2, ["[Group] Show: Second Arc 01-11 Complete"], { files: 11 })], episode(2, 7, 19))).toEqual([2]);
    // Reversed, and counted on within the season.
    expect(fitting([sub(3, ["Show: Third Arc [22 ~ 12]"])], episode(3, 12, 35))).toEqual([3]);
    // A title alone is its whole season or part, unless a number stands before it.
    expect(fitting([sub(4, ["Show: Second Arc"])], episode(2, 9, 21))).toEqual([4]);
    expect(matching.readByTitle(sub(6, ["[Group] 03 - Show: Second Arc"]), episode(2, 9, 21), MAP)).toBeUndefined();
    // A lone file can't hold a range: its name isn't read so, and the rules without a map decide.
    expect(matching.readByTitle(sub(5, ["Show: Third Arc Part 2 [1 ~ 11]"], { files: 1 }), episode(3, 15, 38), MAP)).toBeUndefined();
  });

  it("keeps the season rule for a name that gives another season by number", () => {
    // The show's title with "Season 5": not a season the map has, so it's for season 5 as before.
    const fifth = sub(1, ["Show Season 5 Ep 17"], { recordSeason: 5 });
    expect(matching.readByTitle(fifth, episode(2, 17, 29), MAP)).toBeUndefined();
    expect(fitting([fifth], episode(2, 17, 29))).toEqual([]);
    expect(fitting([fifth], episode(5, 17, 70))).toEqual([1]);
    // A season's title with another season's number can't be read either.
    expect(read("Show: Second Arc S3 - 03", episode(2, 3, 15))).toBeUndefined();
  });

  it("leaves names that spell out the season and episode to their markers", () => {
    const spelled = sub(1, ["Show: Third Arc Part 2 S03E12 1080p"], { recordSeason: 4 });
    expect(matching.readByTitle(spelled, episode(3, 12, 35), MAP)).toBeUndefined();
    expect(fitting([spelled], episode(3, 12, 35))).toEqual([1]);
    expect(fitting([sub(2, ["Show.S02E03.1080p"], { recordSeason: 4 })], episode(2, 3, 15))).toEqual([2]);
  });

  it("isn't read when the map can't tell: an unknown title, two numbers, the show's title alone", () => {
    // A season the map doesn't list yet isn't taken for the first season's.
    expect(read("Show: Fourth Arc - 03", episode(1, 3))).toBeUndefined();
    expect(read("Show 2 - 03", episode(2, 3, 15))).toBeUndefined();
    // A number in brackets after a word of its own is a tag's, not the episode's.
    expect(read("Show: Second Arc [Group 2]", episode(2, 2, 14))).toBeUndefined();
    expect(read("Show: Third Arc [P2 - 10]", episode(3, 10, 33))).toBeUndefined();
    // A tag in brackets before the number is passed over.
    expect(read("Show: Second Arc (TV) - 03", episode(2, 3, 15))).toEqual({ fits: true, exact: true });
    expect(read("Show [Arabic]", episode(1, 3))).toBeUndefined();
    // Unless it gives its season: then it is that season's.
    expect(read("Show (Season 1) [1080p x265]", episode(1, 3))).toEqual({ fits: true, exact: false });
    // A part the map doesn't know after a title it does.
    expect(read("Show: Second Arc Part 2 - 01", episode(2, 1, 13))).toBeUndefined();
    // Nothing of the show's titles at all.
    expect(read("[Group] 03 [1080p]", episode(1, 3))).toBeUndefined();
  });

  it("from a source that searched for the episode, lets only a later season's own title overrule it", () => {
    const trusted = (id: number, name: string) => sub(id, [name], { episodeTrusted: true });
    // "Show - 03" returned for season 2's third: the show's title alone doesn't say otherwise.
    expect(fitting([trusted(1, "Show - 03")], episode(2, 3, 15))).toEqual([1]);
    // A part's own title does: it's season 3's twelfth, not its first.
    expect(fitting([trusted(2, "Show: Third Arc Part 2 - 01")], episode(3, 1, 24))).toEqual([]);
    expect(fitting([trusted(2, "Show: Third Arc Part 2 - 01")], episode(3, 12, 35))).toEqual([2]);
  });

  it("without a map, or with one entry, reads everything as before", () => {
    const names = [sub(1, ["Show - 03"], { recordSeason: 4 }), sub(2, ["Show: Second Arc - 03"], { recordSeason: 4 })];
    expect(fitting(names, episode(2, 3, 15), null)).toEqual([]);
    const single: SeasonMap = { show: "Show", entries: [MAP.entries[0]] };
    expect(fitting(names, episode(2, 3, 15), single)).toEqual([]);
    expect(matching.readByTitle(names[1], episode(2, 3, 15), single)).toBeUndefined();
    // Season 1's record, no map: the bare number fits any season, as it always has.
    expect(fitting([sub(3, ["Show - 03"], { recordSeason: 1 })], episode(2, 3, 15), null)).toEqual([3]);
    expect(fitting([sub(3, ["Show - 03"], { recordSeason: 1 })], episode(2, 3, 15))).toEqual([]);
  });

  it("with the show's title alone, under the requested season's own record, is judged as without a map", () => {
    // SubSource's season 2 record holds season 2's subtitles, named with the show's title alone.
    const own = sub(1, ["[Group] Show - 03 [1080p]"], { recordSeason: 2, movieId: 2 });
    expect(fitting([own], episode(2, 3, 15))).toEqual([1]);
    expect(fitting([own], episode(2, 3, 15), null)).toEqual([1]);
    expect(fitting([own], episode(2, 4, 16))).toEqual([]);
    // Its own season's title and a special's beside it don't make the record a mixed one.
    const beside = [own, sub(2, ["Show: Second Arc - 05"], { recordSeason: 2, movieId: 2 }), sub(3, ["Show: Second Arc Special"], { recordSeason: 2, movieId: 2 })];
    expect(fitting(beside, episode(2, 3, 15))).toEqual([1]);
    // Nor does another record's list, ranked with it.
    expect(fitting([own, sub(4, ["Show: Third Arc - 03"], { recordSeason: 3, movieId: 3 })], episode(2, 3, 15))).toEqual([1]);
  });

  it("with the show's title alone, under a record that mixes seasons, is the first season's", () => {
    // The season 2 record also holds a third season's names: it is filed by uploader, not by season.
    const mixed = [
      sub(1, ["[Group] Show - 03 [1080p]"], { recordSeason: 2, movieId: 2 }),
      sub(2, ["[Group] Show: Second Arc - 03 [1080p]"], { recordSeason: 2, movieId: 2 }),
      sub(3, ["[Group] Show: Third Arc - 03 [1080p]"], { recordSeason: 2, movieId: 2 })
    ];
    expect(fitting(mixed, episode(2, 3, 15))).toEqual([2]);
    expect(fitting(mixed, episode(1, 3))).toEqual([1]);
    expect(matching.mixedRecords(mixed, MAP)).toEqual(new Set([2]));
    // The same for a show's every season under its third season's record.
    const one = [sub(4, ["Show - 03"], { recordSeason: 3, movieId: 3 }), sub(5, ["Show: Second Arc - 03"], { recordSeason: 3, movieId: 3 })];
    expect(fitting(one, episode(3, 3, 26))).toEqual([]);
  });

  it("for a special (season 0), refuses a name that gives only another season", () => {
    const special = episode(0, 1);
    for (const map of [MAP, null]) {
      expect(fitting([sub(1, ["Show.S03.1080p.WEB"], { files: 11 })], special, map), "a season's pack").toEqual([]);
      expect(fitting([sub(2, ["Show.S03E05.1080p.WEB"])], special, map)).toEqual([]);
      expect(fitting([sub(3, ["Show.S00E02.1080p.WEB"])], special, map), "another special").toEqual([]);
      expect(fitting([sub(4, ["Show.S00E01.1080p.WEB"])], special, map)).toEqual([4]);
      expect(fitting([sub(5, ["Show Season 0"], { files: 3 })], special, map)).toEqual([5]);
      // A name that says it is a special may give its season; one that names none is taken as before.
      expect(fitting([sub(6, ["Show 2nd Season OVA"])], special, map)).toEqual([6]);
    }
    expect(fitting([sub(7, ["Show Specials"])], special, null)).toEqual([7]);
    // With the map, a special's own title places it.
    expect(fitting([sub(8, ["Show: Second Arc Special"])], special)).toEqual([8]);
    expect(fitting([sub(9, ["[Group] Show - 03 [1080p]"])], special)).toEqual([]);
  });

  it("ranks a single episode's subtitle above a pack holding it", () => {
    const pack = sub(1, ["Show: Second Arc [1 ~ 11]"], { downloads: 900 });
    const single = sub(2, ["Show: Second Arc - 03"], { downloads: 1 });
    expect(fitting([pack, single], episode(2, 3, 15))).toEqual([2, 1]);
  });
});

describe("SubSource's records of a show", () => {
  it("are all kept in order, the requested season, the whole series and season 1 first, the rest nearest first", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/movies/search")) {
        return json({
          data: [6, 1, 3, 0, 5, 2, 4, 7, 8, 9].map((season) => ({ movieId: 9900 + season, title: "Show", type: "tvseries", season, subtitleCount: season === 7 ? 0 : 5 }))
        });
      }
      return new Response("not here", { status: 404 });
    });
    const records = await subsource.findCandidateMovies(episode(4, 3, 40), "sk_records_test_0981");
    expect(records.map((r) => r.season)).toEqual([4, 0, 1, 3, 5, 2, 6, 8]);
    expect(records.slice(0, subsource.FIRST_RECORDS).map((r) => r.season)).toEqual([4, 0, 1]);
    expect(records.length).toBeLessThanOrEqual(subsource.MAX_RECORDS);
  });
});

describe("a season filed under a record of its own name", () => {
  const hits: string[] = [];
  const search = () =>
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/movies/search")) return new Response("not here", { status: 404 });
      hits.push(url.searchParams.get("q") ?? "imdb");
      return json({
        data: [
          { movieId: 7001, title: "Second Hand Arc", type: "movie", imdbId: "tt0000001", subtitleCount: 200 },
          { movieId: 7002, title: "Show: Second Arc - Chapter 1", type: "movie", imdbId: "tt0000002", subtitleCount: 97 },
          { movieId: 7003, title: "Show: Second Arc", type: "tvseries", imdbId: "tt0000981", season: 2, subtitleCount: 12 },
          { movieId: 7004, title: "Show: Second Arc Collection", type: "tvseries", imdbId: "tt0000003", subtitleCount: 5000 },
          { movieId: 7005, title: "Show: Second Arc Extras", type: "tvseries", imdbId: "tt0000004", subtitleCount: 0 }
        ]
      });
    });

  it("is found by the season's name: a record whose title holds it whole, that the show's own search didn't give", async () => {
    search();
    const known = [{ movieId: 7100, title: "Show", type: "tvseries", season: 0, subtitleCount: 9 }];
    const records = await subsource.namedRecords(episode(2, 3, 15), MAP, "sk_named_test_0001", known);
    // Not another title, the show's own record, one too large to read for its name, or an empty one.
    expect(records.map((r) => r.movieId)).toEqual([7002]);
    // The season's names are searched, two at most, never the show's own.
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits).not.toContain("show");
    // Kept: the same season asks nothing again.
    const before = hits.length;
    await subsource.namedRecords(episode(2, 4, 16), MAP, "sk_named_test_0001", known);
    expect(hits.length).toBe(before);
  });

  it("is not looked for where the season has no name of its own, or the show is one entry", async () => {
    search();
    hits.length = 0;
    expect(await subsource.namedRecords(episode(1, 3, 3), MAP, "sk_named_test_0001", [])).toEqual([]);
    expect(await subsource.namedRecords(episode(2, 3, 15), { show: "Show", entries: [MAP.entries[1]] }, "sk_named_test_0001", [])).toEqual([]);
    expect(hits).toEqual([]);
  });

  it("gives only what its own names place on the episode, and none of a film's own subtitles", () => {
    const from = (id: number, names: string[], namedRecord: "series" | "film") => sub(id, names, { movieId: 7002, namedRecord });
    const listed = [
      from(1, ["[Group] Show: Second Arc [1 ~ 11]"], "film"),
      from(2, ["Show: Second Arc - 03"], "film"),
      // The film's own: its name carries the season's and a year.
      from(3, ["Show.Second.Arc.Chapter.3.2017.720p.BluRay.x264-TEAM"], "film"),
      // Nothing in the name places it: under the show's own records the bare number would.
      from(4, ["[Group] 03 [1080p]"], "series"),
      from(5, ["Show: Third Arc - 03"], "series")
    ];
    expect(fitting(listed, episode(2, 3, 15)).sort()).toEqual([1, 2]);
  });
});

describe("a part's pack", () => {
  const zip = (names: string[]) => {
    const z = new AdmZip();
    for (const name of names) z.addFile(name, Buffer.alloc(4000, 65));
    return new AdmZip(z.toBuffer());
  };
  const pad = (n: number) => String(n).padStart(2, "0");

  it("gives up its file by the part's own number", () => {
    const own = zip(Array.from({ length: 11 }, (_, i) => `Show - Third Arc Part 2 - ${pad(i + 1)}.ass`));
    expect(downloads.selectArchiveEntry(own, 3, 12, 1)?.entryName).toBe("Show - Third Arc Part 2 - 01.ass");
    // "Part 2" in every name isn't episode 2.
    expect(downloads.selectArchiveEntry(own, 3, 13, 2)?.entryName).toBe("Show - Third Arc Part 2 - 02.ass");
    // Named both ways: the one with both numbers.
    const both = zip(Array.from({ length: 11 }, (_, i) => `Show: Third Arc - ${pad(i + 12)} [P2 - ${pad(i + 1)}].ass`));
    expect(downloads.selectArchiveEntry(both, 3, 15, 4)?.entryName).toBe("Show: Third Arc - 15 [P2 - 04].ass");
    // Files counted on within the season: none has the part's number, so the season's.
    const counted = zip(Array.from({ length: 11 }, (_, i) => `Show - Third Arc - ${pad(i + 12)}.ass`));
    expect(downloads.selectArchiveEntry(counted, 3, 15, 4)?.entryName).toBe("Show - Third Arc - 15.ass");
    // Spelled out with the IMDb season and episode, that comes first.
    const spelled = zip(["Show.S03E12.ass", "Show.S03E13.ass"]);
    expect(downloads.selectArchiveEntry(spelled, 3, 13, 2)?.entryName).toBe("Show.S03E13.ass");
  });

  it("and a second arc's pack numbered like IMDb finds its file as before", () => {
    const arc = zip(Array.from({ length: 11 }, (_, i) => `Show: Second Arc - ${pad(i + 1)}.ass`));
    expect(downloads.selectArchiveEntry(arc, 2, 3)?.entryName).toBe("Show: Second Arc - 03.ass");
    // A part IMDb counts as a season of its own: "Part 2" in its names isn't episode 2 either.
    const part = zip(["Show Part 2 - 01.ass", "Show Part 2 - 02.ass"]);
    expect(downloads.selectArchiveEntry(part, 5, 2)?.entryName).toBe("Show Part 2 - 02.ass");
  });

  it("refuses a lone file that is another episode in both counts", () => {
    expect(downloads.selectArchiveEntry(zip(["Show - Third Arc Part 2 - 01.ass"]), 3, 13, 2)).toBeUndefined();
    expect(downloads.selectArchiveEntry(zip(["Show - Third Arc Part 2 - 01.ass"]), 3, 12, 1)?.entryName).toBe("Show - Third Arc Part 2 - 01.ass");
  });
});
