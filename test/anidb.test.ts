/**
 * AniDB as an option (src/anidb.ts): never asked without a client; with one, asked slowly, each anime
 * once, a day's count at most, and not at all after a refusal. And the season map made from its titles
 * for a show the Anime Kitsu addon gives none (src/ids.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const CACHE = mkdtempSync(path.join(os.tmpdir(), "bttrsubs-anidb-"));
let anidb: typeof import("../src/anidb.js");
let ids: typeof import("../src/ids.js");
let config: (typeof import("../src/config.js"))["config"];

const anime = (main: string, episodes: number, more = "") => `<?xml version="1.0" encoding="UTF-8"?>
<anime id="1" restricted="false"><type>TV Series</type><episodecount>${episodes}</episodecount>
<titles>
<title xml:lang="x-jat" type="main">${main}</title>
<title xml:lang="en" type="official">${main} in English</title>
<title xml:lang="en" type="short">MS</title>
<title xml:lang="fr" type="official">${main} en francais</title>
${more}
</titles>
<episodes><episode id="9"><epno type="1">1</epno><title xml:lang="en">An episode&apos;s own title</title></episode></episodes>
</anime>`;

/** Every request made to AniDB, with when. */
let asked: Array<{ aid: number; at: number }> = [];
const answer = (reply: (aid: number) => Response | Promise<Response>, others?: (url: URL) => Response | undefined) =>
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anidb.net") {
      const aid = Number(url.searchParams.get("aid"));
      asked.push({ aid, at: Date.now() });
      expect(url.searchParams.get("client")).toBe("testclient");
      expect(url.searchParams.get("clientver")).toBe("1");
      return reply(aid);
    }
    return others?.(url) ?? new Response("not here", { status: 404 });
  });

beforeAll(async () => {
  process.env.CONFIG_SECRET = "anidb-test-secret-anidb-test-secret-12";
  process.env.CACHE_DIR = CACHE;
  anidb = await import("../src/anidb.js");
  ids = await import("../src/ids.js");
  config = (await import("../src/config.js")).config;
});
beforeEach(() => {
  asked = [];
  // Each test starts with a line that isn't stopped: what an earlier one left on disk is taken away.
  rmSync(path.join(CACHE, "anidb", "state.json"), { force: true });
  anidb.resetAnidb();
  Object.assign(anidb.anidbPace, { everyMs: 0, dailyMax: 100 });
  Object.assign(config, { anidbClient: "testclient", anidbClientVer: 1, animeTitlesDataset: false });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

describe("AniDB's answer", () => {
  it("gives the main title, the official ones and the synonyms in romaji, English and Japanese, and the episode count", () => {
    const read = anidb.readAnime(anime("Show: Second Arc", 24, '<title xml:lang="x-jat" type="synonym">Show 2 &amp; More</title><title xml:lang="ja" type="official">ショー</title>'));
    expect(read).toEqual({ titles: ["Show: Second Arc", "Show: Second Arc in English", "Show 2 & More", "ショー"], episodes: 24 });
    expect(anidb.readAnime("<anime><episodecount>3</episodecount></anime>")).toBeUndefined();
    expect(anidb.anidbError('<error code="500">banned</error>')).toBe("banned");
    expect(anidb.anidbError(anime("Show", 1))).toBeUndefined();
  });
});

describe("asking AniDB", () => {
  it("never happens without a client, or with only half of one", async () => {
    answer(() => new Response(anime("Show", 12)));
    Object.assign(config, { anidbClient: undefined, anidbClientVer: 1 });
    expect(await anidb.anidbAnime(101)).toBeUndefined();
    Object.assign(config, { anidbClient: "testclient", anidbClientVer: undefined });
    expect(await anidb.anidbAnime(101)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("asks for an anime once: requests at the same moment share one, and what it answered is kept", async () => {
    answer(() => new Response(anime("Show", 12)));
    const [a, b] = await Promise.all([anidb.anidbAnime(102), anidb.anidbAnime(102)]);
    expect(a).toEqual({ titles: ["Show", "Show in English"], episodes: 12 });
    expect(b).toEqual(a);
    expect(await anidb.anidbAnime(102)).toEqual(a);
    // After a restart too: it is on disk.
    anidb.resetAnidb();
    expect(await anidb.anidbAnime(102)).toEqual(a);
    expect(await anidb.keptAnime(102)).toEqual(a);
    expect(asked.map((r) => r.aid)).toEqual([102]);
    // An anime AniDB doesn't have is kept as that, and not asked for again either.
    answer(() => new Response('<error>Anime not found</error>'));
    expect(await anidb.anidbAnime(103)).toBeUndefined();
    expect(await anidb.anidbAnime(103)).toBeUndefined();
    expect(asked.map((r) => r.aid)).toEqual([102, 103]);
  });

  it("goes one request at a time, the gap apart, however many are asked at once", async () => {
    anidb.anidbPace.everyMs = 250;
    answer(() => new Response(anime("Show", 12)));
    await Promise.all([anidb.anidbAnime(111), anidb.anidbAnime(112), anidb.anidbAnime(113)]);
    expect(asked.map((r) => r.aid).sort()).toEqual([111, 112, 113]);
    expect(asked[1].at - asked[0].at).toBeGreaterThanOrEqual(240);
    expect(asked[2].at - asked[1].at).toBeGreaterThanOrEqual(240);
  });

  it("stops at the day's count, which a restart doesn't start again", async () => {
    answer(() => new Response(anime("Show", 12)));
    const before = (await anidb.anidbNow()).askedToday;
    anidb.anidbPace.dailyMax = before + 2;
    await anidb.anidbAnime(121);
    await anidb.anidbAnime(122);
    anidb.resetAnidb();
    expect(await anidb.anidbAnime(123)).toBeUndefined();
    expect(asked.map((r) => r.aid)).toEqual([121, 122]);
    expect((await anidb.anidbNow()).askedToday).toBe(before + 2);
    // Not kept as an anime with no answer: it is asked for once the count allows.
    anidb.anidbPace.dailyMax = 100;
    expect(await anidb.anidbAnime(123)).toMatchObject({ episodes: 12 });
  });

  it("asks nothing more after a ban or a client AniDB doesn't accept, across a restart", async () => {
    answer(() => new Response('<error code="500">banned</error>'));
    expect(await anidb.anidbAnime(131)).toBeUndefined();
    expect(await anidb.anidbAnime(132)).toBeUndefined();
    anidb.resetAnidb();
    expect(await anidb.anidbAnime(133)).toBeUndefined();
    expect(asked.map((r) => r.aid)).toEqual([131]);
    const now = await anidb.anidbNow();
    expect(now.stoppedForMs).toBeGreaterThan(35 * 60 * 60 * 1000);
    expect(now.why).toBe("banned");
    // The stop ends by itself; the banned request was not kept as an anime with no answer.
    answer(() => new Response(anime("Show", 12)));
    vi.useFakeTimers({ now: Date.now() + 37 * 60 * 60 * 1000, toFake: ["Date"] });
    try {
      anidb.resetAnidb();
      expect(await anidb.anidbAnime(131)).toMatchObject({ episodes: 12 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a client AniDB refused", () => {
  it("stops every request until the client is changed; a ban stays whatever the client", async () => {
    answer(() => new Response("<error>client version missing or invalid</error>"));
    expect(await anidb.anidbAnime(141)).toBeUndefined();
    expect((await anidb.anidbNow()).stoppedForMs).toBeGreaterThan(0);
    await anidb.anidbClientChanged();
    expect((await anidb.anidbNow()).stoppedForMs).toBe(0);
    answer(() => new Response(anime("Show", 12)));
    expect(await anidb.anidbAnime(141)).toMatchObject({ episodes: 12 });
    // A ban is on the address: a new client doesn't lift it.
    answer(() => new Response('<error code="500">banned</error>'));
    expect(await anidb.anidbAnime(142)).toBeUndefined();
    await anidb.anidbClientChanged();
    expect((await anidb.anidbNow()).stoppedForMs).toBeGreaterThan(0);
  });
});

describe("a season map from AniDB", () => {
  const XML = `<anime-list>
<anime anidbid="7001" tvdbid="6000" defaulttvdbseason="1"><name>Map Show</name></anime>
<anime anidbid="7002" tvdbid="6000" defaulttvdbseason="2"><name>Map Show: Second Arc</name></anime>
<anime anidbid="7003" tvdbid="6000" defaulttvdbseason="0"><name>Map Show film</name></anime>
</anime-list>`;
  const JSON_LIST = JSON.stringify([
    { type: "TV", anidb_id: 7001, kitsu_id: 8001, imdb_id: "tt0006001", tvdb_id: 6000 },
    { type: "TV", anidb_id: 7002, kitsu_id: 8002, imdb_id: "tt0006001", tvdb_id: 6000 },
    { type: "Movie", anidb_id: 7003, kitsu_id: 8003, imdb_id: "tt0006001", tvdb_id: 6000 }
  ]);
  const others = (url: URL) => {
    if (url.hostname === "raw.githubusercontent.com") return new Response(url.pathname.endsWith(".xml") ? XML : JSON_LIST, { headers: { etag: '"1"' } });
    // The addon knows none of the show's entries under this IMDb id.
    if (url.pathname.includes("/catalog/")) return new Response(JSON.stringify({ metas: [] }), { headers: { "content-type": "application/json" } });
    return undefined;
  };

  it("is made behind the answer for a show the addon gives none, from the lists' entries and AniDB's titles, and kept", async () => {
    answer((aid) => new Response(anime(aid === 7001 ? "Map Show" : "Map Show: Second Arc", aid === 7001 ? 12 : 13)), others);
    // The first answer has none, and doesn't wait.
    expect(await ids.seasonMap("tt0006001", async () => "Map Show")).toBeUndefined();
    await ids.titlesMapUnderWay("tt0006001");
    const map = await ids.seasonMap("tt0006001", async () => "Map Show");
    expect(map?.entries.map((e) => e.kitsuId)).toEqual(["8001", "8002"]);
    expect(map?.entries[1].titles).toContain("Map Show: Second Arc");
    // The second entry's own first episode is season 2's first, in the order requests come in.
    expect(map?.entries[1].episodes["1"]).toEqual([2, 1]);
    expect(map?.entries[0].episodes["12"]).toEqual([1, 12]);
    expect(Object.keys(map?.entries[1].episodes ?? {})).toHaveLength(13);
    // The film's entry isn't asked for, and nothing is asked twice.
    expect(asked.map((r) => r.aid).sort()).toEqual([7001, 7002]);
  });

  it("isn't made without a client, and isn't a part of one while AniDB hasn't answered for every entry", async () => {
    Object.assign(config, { anidbClient: undefined });
    answer(() => new Response(anime("Map Show", 12)), others);
    expect(await ids.seasonMap("tt0006001", async () => "Map Show")).toBeDefined(); // kept from the test before
    const none = "tt0006002";
    expect(await ids.seasonMap(none, async () => "Unlisted Show")).toBeUndefined();
    expect(ids.titlesMapUnderWay(none)).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
