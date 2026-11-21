/**
 * Anime episodes placed by the two public anime lists (animelists.ts): Anime-Lists' XML for each AniDB
 * entry's place among TVDB's seasons, Fribb's JSON for its other ids. Read by the XML's own rules, and
 * taken only when the reading leads back to the same TVDB episode.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = ".cache-animelists-test";
let lists: typeof import("../src/animelists.js");
beforeAll(async () => {
  process.env.CACHE_DIR = CACHE;
  lists = await import("../src/animelists.js");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const XML = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="100" tvdbid="1000" defaulttvdbseason="a">
    <name>Show</name>
    <mapping-list>
      <mapping anidbseason="0" tvdbseason="0">;1-3;2-4;</mapping>
      <mapping anidbseason="1" tvdbseason="2" start="26" end="40" offset="-25"/>
      <mapping anidbseason="1" tvdbseason="3" start="41" offset="-40"/>
    </mapping-list>
  </anime>
  <anime anidbid="101" tvdbid="1000" defaulttvdbseason="0" imdbid="tt0000109"><name>Show film</name></anime>
  <anime anidbid="200" tvdbid="2000" defaulttvdbseason="1"><name>Other</name></anime>
  <anime anidbid="201" tvdbid="2000" defaulttvdbseason="2"><name>Other second</name></anime>
  <anime anidbid="202" tvdbid="2000" defaulttvdbseason="2" episodeoffset="11"><name>Other second, part 2</name></anime>
  <anime anidbid="400" tvdbid="4000" defaulttvdbseason="1"><name>Named first by its film</name></anime>
  <anime anidbid="300" tvdbid="3000" defaulttvdbseason="a">
    <name>Placed twice</name>
    <mapping-list>
      <mapping anidbseason="1" tvdbseason="1" start="1" end="20"/>
      <mapping anidbseason="1" tvdbseason="2" start="15" end="30" offset="-14"/>
    </mapping-list>
  </anime>
</anime-list>`;
const JSON_LIST = JSON.stringify([
  { type: "TV", anidb_id: 100, kitsu_id: 10, imdb_id: ["tt0000100"], tvdb_id: 1000 },
  { type: "Movie", anidb_id: 101, kitsu_id: 11, imdb_id: ["tt0000109"], tvdb_id: 1000 },
  { type: "TV", anidb_id: 200, kitsu_id: 20, imdb_id: ["tt0000200"], tvdb_id: 2000 },
  // A later entry naming the same IMDb id doesn't take it over.
  { type: "Movie", anidb_id: 999, imdb_id: ["tt0000200"] },
  { type: "TV", anidb_id: 201, kitsu_id: 21, tvdb_id: 2000 },
  { type: "TV", anidb_id: 202, kitsu_id: 22, tvdb_id: 2000 },
  { type: "TV", anidb_id: 300, kitsu_id: 30, imdb_id: "tt0000300", tvdb_id: 3000 },
  // A film, and an entry of no kind, name the series' IMDb id before the series does.
  { type: "MOVIE", anidb_id: 401, imdb_id: ["tt0000400"], tvdb_id: 4000 },
  { anidb_id: 402, imdb_id: ["tt0000400"], tvdb_id: 4000 },
  { type: "TV", anidb_id: 400, kitsu_id: 40, imdb_id: ["tt0000400"], tvdb_id: 4000 }
]);

describe("anime episodes placed by the anime lists", () => {
  const read = () => ({ ...lists.readXml(XML), ...lists.readJson(JSON_LIST) });

  it("numbers a run straight through: season 1 before every range at its own numbers, each later season by its range", () => {
    const l = read();
    expect(lists.placeEpisode(l, "tt0000100", 1, 5)).toEqual({ anidbId: 100, episode: 5, kitsuId: 10, run: true });
    expect(lists.placeEpisode(l, "tt0000100", 2, 12)).toEqual({ anidbId: 100, episode: 37, kitsuId: 10, run: true });
    // A range with no end reaches on.
    expect(lists.placeEpisode(l, "tt0000100", 3, 9)).toEqual({ anidbId: 100, episode: 49, kitsuId: 10, run: true });
    // Past a range's end, and season 1 past where season 2 starts: not placed.
    expect(lists.placeEpisode(l, "tt0000100", 2, 16)).toBeUndefined();
    expect(lists.placeEpisode(l, "tt0000100", 1, 26)).toBeUndefined();
  });

  it("splits a season shared by two entries at the second one's offset", () => {
    const l = read();
    expect(lists.placeEpisode(l, "tt0000200", 1, 4)).toEqual({ anidbId: 200, episode: 4, kitsuId: 20, run: false });
    expect(lists.placeEpisode(l, "tt0000200", 2, 11)).toEqual({ anidbId: 201, episode: 11, kitsuId: 21, run: false });
    expect(lists.placeEpisode(l, "tt0000200", 2, 12)).toEqual({ anidbId: 202, episode: 1, kitsuId: 22, run: false });
  });

  it("places no special, film or IMDb id the lists don't hold as a series", () => {
    const l = read();
    expect(lists.placeEpisode(l, "tt0000100", 0, 3)).toBeUndefined();
    expect(lists.placeEpisode(l, "tt0000109", 1, 1)).toBeUndefined();
    expect(lists.placeEpisode(l, "tt0000999", 1, 1)).toBeUndefined();
  });

  it("finds a series whose IMDb id a film or an entry of no kind names first", () => {
    const l = read();
    expect(lists.placeEpisode(l, "tt0000400", 1, 2)).toEqual({ anidbId: 400, episode: 2, kitsuId: 40, run: false });
  });

  it("takes a reading only when it leads back to the same TVDB episode", () => {
    const l = read();
    // Season 2's episode 1 is AniDB's 15, which season 1's range claims first on the way back.
    expect(lists.placeEpisode(l, "tt0000300", 2, 1)).toBeUndefined();
    expect(lists.placeEpisode(l, "tt0000300", 2, 7)).toEqual({ anidbId: 300, episode: 21, kitsuId: 30, run: true });
  });

  it("fetches both lists once, keeps them, and answers nothing when neither has ever been fetched", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect(await lists.animeEpisode("tt0000100", 2, 12)).toBeUndefined();
    const fetch = vi.fn(async (input: string | URL) => new Response(String(input).endsWith(".xml") ? XML : JSON_LIST, { headers: { etag: '"a"' } }));
    vi.stubGlobal("fetch", fetch);
    expect(await lists.animeEpisode("tt0000100", 2, 12)).toMatchObject({ episode: 37, kitsuId: 10 });
    expect(fetch).toHaveBeenCalledTimes(2);
    // Held: no more fetches, and the answer stays when the lists can't be asked for.
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect(await lists.animeEpisode("tt0000200", 2, 12)).toMatchObject({ anidbId: 202, episode: 1 });
  });
});
