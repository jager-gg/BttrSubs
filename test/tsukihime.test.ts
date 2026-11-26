/**
 * TsukiHime as a source (tsukihime.ts): an episode's releases found by the show's AniDB entry or by
 * name, their subtitle tracks turned into subtitles in the languages asked, and the pace its requests keep (pace.ts).
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = ".cache-tsukihime-test";
let placed: { anidbId: number; episode: number; run: boolean } | undefined = { anidbId: 15305, episode: 7, run: false };
vi.mock("../src/animelists.js", () => ({ animeEpisode: async () => placed }));

let source: typeof import("../src/tsukihime.js");
let pace: typeof import("../src/pace.js");

beforeAll(async () => {
  process.env.CACHE_DIR = CACHE;
  source = await import("../src/tsukihime.js");
  pace = await import("../src/pace.js");
});
afterEach(() => {
  vi.unstubAllGlobals();
  pace.forgetPaces();
  placed = { anidbId: 15305, episode: 7, run: false };
});
afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const track = (id: number, lang: string, name = "", extra: Record<string, unknown> = {}) => ({ id, type: 1, info: { codec: "ASS", lang, name, default: 0, forced: 0, ...extra } });
const font = { id: 5, type: 0, info: { name: "font.ttf", mime: "font/ttf" } };

/** The service as these answers: each path asked is noted. */
function service(answers: Record<string, unknown>, asked: string[] = []) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const pathAsked = url.pathname.replace(/^\/v1/, "") + url.search;
    asked.push(pathAsked);
    const hit = Object.keys(answers).find((k) => pathAsked.startsWith(k));
    return hit ? json(answers[hit]) : json({ error: true }, 404);
  });
  return asked;
}

describe("an episode's subtitles from its releases' own tracks", () => {
  const request = (n: number, extra: Record<string, unknown> = {}) => ({ type: "series", id: `tt90000${n}:2:7`, imdbId: `tt90000${n}`, season: 2, episode: 7, ...extra }) as never;

  it("asks for its releases side by side, and for the episode's list ahead of the look-up", async () => {
    placed = { anidbId: 15391, episode: 7, run: false };
    const releases = [1, 2, 3, 4].map((n) => ({ id: 9100 + n, name: `[Group${n}] Side Show - 07 [1080p]`, totalsize: 100 + n, audiolangs: ["ja"], sublangs: ["en"] }));
    const asked: string[] = [];
    let open = 0;
    let most = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const pathAsked = url.pathname.replace(/^\/v1/, "");
      asked.push(pathAsked);
      if (pathAsked === "/animes/anidb/15391") return json({ id: 6791 });
      if (pathAsked === "/animes/6791/episodes/7") return json({ results: releases });
      const release = releases.find((r) => pathAsked === `/torrents/${r.id}`);
      if (!release) return json({ error: true }, 404);
      most = Math.max(most, ++open);
      await new Promise((resolve) => setTimeout(resolve, 120));
      open--;
      return json({ files: [{ id: release.id, filename: `${release.name}.mkv`, attachments: [track(release.id * 10, "en")] }] });
    });
    // The list's start asks for the episode's releases; the look-up after it asks for them no second time.
    source.tsukihimeAhead(request(91));
    const rows = await source.tsukihimeSubtitles(request(91), "Side Show", ["english"]);
    expect(asked.filter((p) => p.startsWith("/animes/"))).toEqual(["/animes/anidb/15391", "/animes/6791/episodes/7"]);
    // Three at a time, as its pace lets through, and given in the order asked.
    expect(most).toBe(3);
    expect(rows.map((r) => r.ref)).toEqual(["th91010", "th91020", "th91030", "th91040"]);
  });

  it("finds the episode by the show's AniDB entry and gives each wanted language's full track, the playing release first", async () => {
    const asked = service({
      "/animes/anidb/15305": { id: 6730 },
      "/animes/6730/episodes/7": {
        results: [
          { id: 11, name: "[Group] Show - 07 [1080p]", totalsize: 500, audiolangs: ["ja"], sublangs: ["en"] },
          { id: 12, name: "Show.S02E07.1080p.WEB-DL.DUAL-TEAM", totalsize: 900, audiolangs: ["ja", "en"], sublangs: ["en", "ar", "pt-BR", "zh-Hans"] },
          { id: 13, name: "[Raw] Show - 07", totalsize: 400, audiolangs: ["ja"], sublangs: [] }
        ]
      },
      "/torrents/12": { files: [{ id: 1, filename: "Show.S02E07.1080p.WEB-DL.DUAL-TEAM.mkv", attachments: [font, track(101, "en"), track(102, "en", "Forced", { forced: 1 }), track(103, "en", "English [CC]"), track(104, "ar"), track(105, "pt-BR", "Brazilian"), track(106, "zh-Hans", "Simplified")] }] },
      "/torrents/11": { files: [{ id: 2, filename: "[Group] Show - 07 [1080p].mkv", attachments: [track(201, "en", "Signs & Songs"), track(202, "en", "Full Subtitles")] }] }
    });
    const rows = await source.tsukihimeSubtitles(request(1, { filename: "Show.S02E07.1080p.WEB-DL.DUAL-TEAM.mkv" }), "Show", ["english", "arabic", "portuguese (br)", "portuguese", "chinese (traditional)"]);
    // The release being played is opened first; a release with none of the languages isn't opened at all.
    expect(asked.filter((p) => p.startsWith("/torrents/"))).toEqual(["/torrents/12", "/torrents/11"]);
    expect(rows.map((r) => [r.ref, r.language])).toEqual([["th101", "english"], ["th103", "english"], ["th104", "arabic"], ["th105", "portuguese (br)"], ["th202", "english"]]);
    // A track named as captions, on a release with English voices, is the dub's and is worded so; a translation never is.
    const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]));
    expect(byRef.th103.commentary).toMatch(/^English Dub captions/);
    expect(byRef.th103.hearingImpaired).toBe(true);
    expect(byRef.th101.commentary).not.toMatch(/dub/i);
    expect(byRef.th202.commentary).not.toMatch(/dub/i);
    expect(rows.every((r) => r.source === "tsukihime" && r.episodeTrusted === true)).toBe(true);
    expect(byRef.th104.releaseInfo?.[0]).toBe("Show.S02E07.1080p.WEB-DL.DUAL-TEAM");
  });

  it("opens a release whose name gives another season's episode after the others, so it takes no place a release of the episode wants", async () => {
    placed = { anidbId: 15399, episode: 7, run: false };
    const asked = service({
      "/animes/anidb/15399": { id: 6799 },
      "/animes/6799/episodes/7": {
        results: [
          { id: 41, name: "[Group] Show 107 - S04E07 [1080p]", audiolangs: ["ja"], sublangs: ["en"] },
          { id: 42, name: "[Group] Show - 07 [1080p]", audiolangs: ["ja"], sublangs: ["en"] }
        ]
      },
      "/torrents/42": { files: [{ id: 4, filename: "[Group] Show - 07 [1080p].mkv", attachments: [track(401, "en")] }] },
      "/torrents/41": { files: [{ id: 5, filename: "[Group] Show 107 - S04E07 [1080p].mkv", attachments: [track(411, "en")] }] }
    });
    const rows = await source.tsukihimeSubtitles(request(7), "Show", ["english"]);
    // The service lists it first; its name gives season 4's 7th where season 2's was asked for, so it is opened last.
    expect(asked.filter((p) => p.startsWith("/torrents/"))).toEqual(["/torrents/42", "/torrents/41"]);
    expect(rows.map((r) => r.ref)).toEqual(["th401", "th411"]);
  });

  it("searches by the show's name when the lists don't place the episode, and keeps only that episode's releases", async () => {
    placed = undefined;
    const asked = service({
      "/search/torrents": { results: [{ id: 21, name: "Show Hes Here S02E07 1080p WEB-DL", sublangs: ["de"] }, { id: 22, name: "Show Hes Here S02E08 1080p WEB-DL", sublangs: ["de"] }] },
      "/torrents/21": { files: [{ id: 3, filename: "Show.Hes.Here.S02E07.1080p.WEB-DL.mkv", attachments: [track(301, "de")] }] }
    });
    const rows = await source.tsukihimeSubtitles(request(2), "Show: He's Here", ["german"]);
    expect(asked[0]).toBe(`/search/torrents?q=${encodeURIComponent("Show He s Here S02E07")}&limit=50`);
    expect(asked).not.toContain("/torrents/22");
    expect(rows.map((r) => r.ref)).toEqual(["th301"]);
  });

  it("takes a batch's file for the episode, a track from the archive it took over under its own storage path, and nothing for a film", async () => {
    placed = { anidbId: 15306, episode: 7, run: false };
    service({
      "/animes/anidb/15306": { id: 6731 },
      "/animes/6731/episodes/7": { results: [{ id: 1_000_000_031, name: "[Group] Show S2 (BD 1080p)", sublangs: ["en"] }] },
      "/torrents/1000000031": { animetosho: true, files: [{ id: 4, filename: "[Group] Show S02E06.mkv", attachments: [track(401, "en")] }, { id: 5, filename: "[Group] Show S02E07.mkv", attachments: [track(402, "en")] }] }
    });
    expect((await source.tsukihimeSubtitles(request(3), "Show", ["english"])).map((r) => r.ref)).toEqual(["tht402"]);
    expect(await source.tsukihimeSubtitles({ type: "movie", id: "tt9000009", imdbId: "tt9000009" } as never, "Film", ["english"])).toEqual([]);
  });

  it("matches a track's language code to a language's name here", () => {
    const same = source.sameLanguage;
    expect([same("en", "en"), same("zh-Hans", "zh-cn"), same("zh-Hant", "zh-tw"), same("zh", "zh-cn"), same("pt-BR", "pt-br"), same("pt", "pt-pt"), same("es-419", "es")]).toEqual([true, true, true, true, true, true, true]);
    expect([same("zh-Hans", "zh-tw"), same("pt-BR", "pt-pt"), same("pt", "pt-br"), same("de", "nl"), same(undefined, "en")]).toEqual([false, false, false, false, false]);
  });
});

describe("the dub's captions from the dub's own releases", () => {
  const request = (n: number) => ({ type: "series", id: `tt90001${n}:2:7`, imdbId: `tt90001${n}`, season: 2, episode: 7 }) as never;
  // Five releases with more subtitle languages than the dub's own, which has one: by language alone it gets no place.
  const many = (id: number) => ({ id, name: `[Subs${id}] Show - 07 [1080p]`, audiolangs: ["ja"], sublangs: ["en", "ar", "fr", "de"] });
  const translations = Object.fromEntries([921, 922, 923, 924, 925].map((id) => [`/torrents/${id}`, { files: [{ id, filename: `[Subs${id}] Show - 07 [1080p].mkv`, attachments: [track(id * 10, "en", "English")] }] }]));

  it("opens the release whose only audio is English beside the ones picked by language, and takes its one English track as captions, named so or not", async () => {
    placed = { anidbId: 25311, episode: 7, run: false };
    const asked = service({
      "/animes/anidb/25311": { id: 6741 },
      "/animes/6741/episodes/7": {
        results: [
          ...[921, 922, 923, 924, 925].map(many),
          { id: 931, name: "[Dubs] Show - S02E07 [English Dub] [WEB 1080p] [0A1B2C3D]", audiolangs: ["en"], sublangs: ["en"], animetosho: true },
          // The same release at another picture size: no place of its own.
          { id: 932, name: "[Dubs] Show - S02E07 [English Dub] [WEB 720p] [4E5F6A7B]", audiolangs: ["en"], sublangs: ["en"], animetosho: true },
          { id: 933, name: "[Dual] Show - 07 [Dual Audio]", audiolangs: ["ja", "en"], sublangs: ["en"] }
        ]
      },
      ...translations,
      "/torrents/931": { animetosho: true, audiolangs: ["en"], files: [{ id: 931, filename: "[Dubs] Show - S02E07 [English Dub] [WEB 1080p] [0A1B2C3D].mkv", attachments: [font, track(9311, "en-US", "")] }] },
      // A dual-audio file's plain English track is the translation; its captions are named.
      "/torrents/933": { audiolangs: ["ja", "en"], files: [{ id: 933, filename: "[Dual] Show - 07 [Dual Audio].mkv", attachments: [track(9331, "en", "English"), track(9332, "en", "English [CC]")] }] }
    });
    const got = await source.tsukihimeSubtitles(request(1), "Show", ["english"]);
    expect(asked.filter((p) => p.startsWith("/torrents/")).sort()).toEqual(["/torrents/921", "/torrents/922", "/torrents/923", "/torrents/924", "/torrents/931", "/torrents/933"]);
    const captions = got.filter(source.isDubCaptions).map((s) => s.ref);
    expect(captions.sort()).toEqual(["th9332", "tht9311"]);
    expect(got.find((s) => s.ref === "tht9311")!.commentary).toBe('English Dub captions: the release\'s own "English" track');
    expect(source.isDubCaptions(got.find((s) => s.ref === "th9331")!)).toBe(false);
    // The list's own word for each release: three of them could hold the dub's captions.
    expect(await source.dubReleasesListed(request(1))).toBe(3);
  });

  it("gives the dub's releases no place when English isn't asked for, and counts none where no release has English audio and an English track", async () => {
    placed = { anidbId: 25312, episode: 7, run: false };
    const asked = service({
      "/animes/anidb/25312": { id: 6742 },
      "/animes/6742/episodes/7": {
        results: [
          { id: 941, name: "[Subs] Show - 07", audiolangs: ["ja"], sublangs: ["en", "ar"] },
          // English voices with no subtitle track, and English subtitles with no English voices.
          { id: 942, name: "[Dubs] Show - S02E07 [English Dub]", audiolangs: ["en"], sublangs: [] },
          { id: 943, name: "[Raw] Show - 07", audiolangs: ["ja"], sublangs: ["en"] }
        ]
      },
      "/torrents/941": { files: [{ id: 941, filename: "[Subs] Show - 07.mkv", attachments: [track(9411, "ar", "Arabic")] }] }
    });
    const got = await source.tsukihimeSubtitles(request(2), "Show", ["arabic"]);
    expect(got.map((s) => s.ref)).toEqual(["th9411"]);
    expect(asked.filter((p) => p.startsWith("/torrents/"))).toEqual(["/torrents/941"]);
    expect(await source.dubReleasesListed(request(2))).toBe(0);
    // An episode the lists don't place has no list to count in.
    placed = undefined;
    expect(await source.dubReleasesListed(request(3))).toBeUndefined();
  });
});

describe("an episode's signs from its releases' own tracks", () => {
  const request = { type: "series", id: "tt9000201:2:7", imdbId: "tt9000201", season: 2, episode: 7 } as never;

  it("gives each release's signs track with the dialogue track that times it, a disc's release first for a disc's file, and a full track once two releases gave no signs track", async () => {
    placed = { anidbId: 25321, episode: 7, run: false };
    const asked = service({
      "/animes/anidb/25321": { id: 6751 },
      "/animes/6751/episodes/7": {
        results: [
          { id: 961, name: "[Web] Show - 07 [WEB 1080p]", audiolangs: ["ja"], sublangs: ["en"] },
          { id: 962, name: "[Disc] Show - 07 [BD 1080p] [Dual Audio]", audiolangs: ["ja", "en"], sublangs: ["en"] },
          { id: 963, name: "[Raw] Show - 07", audiolangs: ["ja"], sublangs: [] },
          { id: 964, name: "[Dub] Show - 07 [WEB 720p]", audiolangs: ["ja", "en"], sublangs: ["en"], animetosho: true }
        ]
      },
      // A full track only: held until a second release has given no signs track either.
      "/torrents/961": { files: [{ id: 1, filename: "[Web] Show - 07 [WEB 1080p].mkv", attachments: [track(9611, "en", "English")] }] },
      // The dub's captions are no dialogue to time signs by: the plain track is.
      "/torrents/962": { files: [{ id: 2, filename: "[Disc] Show - 07 [BD 1080p] [Dual Audio].mkv", attachments: [font, track(9621, "en", "English [CC]"), track(9622, "en", "Signs & Songs"), track(9623, "en", "English"), track(9624, "ar", "Arabic")] }] },
      // A forced track is a signs track; a track that isn't ASS can't be shown as signs.
      "/torrents/964": { animetosho: true, files: [{ id: 4, filename: "[Dub] Show - 07 [WEB 720p].mkv", attachments: [track(9641, "en", "", { forced: 1 }), track(9642, "en", "Dialogue"), track(9643, "en", "Songs", { codec: "SRT" })] }] }
    });
    const found = [];
    for await (const given of source.tsukihimeSigns(request, "Show", "Show.S02E07.BluRay.1080p-TEAM.mkv")) found.push(given);
    // The disc's release first (the playing file is a disc's), then the other with the dub, then the web one's full track.
    expect(asked.filter((p) => p.startsWith("/torrents/"))).toEqual(["/torrents/962", "/torrents/964", "/torrents/961"]);
    expect(found.map((s) => [s.signs, s.partner, s.full, s.signsName])).toEqual([
      ["th9622", "th9623", false, "Signs & Songs"],
      ["tht9641", "tht9642", false, "Signs"],
      ["th9611", "th9611", true, "English"]
    ]);
    expect(found[0].release).toBe("[Disc] Show - 07 [BD 1080p] [Dual Audio]");
  });
});

describe("the pace a service's requests keep", () => {
  const quick = { perMinute: 2, inFlight: 1, pausedMs: 40_000, maxWaitMs: 200 };

  it("sends no more in a minute than the pace allows: the one over is never sent", async () => {
    const sent: number[] = [];
    const send = async () => (sent.push(Date.now()), new Response("ok"));
    await pace.paced("svc", quick, send);
    await pace.paced("svc", quick, send);
    await expect(pace.paced("svc", quick, send)).rejects.toMatchObject({ name: "HeldBack" });
    expect(sent).toHaveLength(2);
    expect(pace.paceNow("svc").lastMinute).toBe(2);
  });

  it("stops asking a service that answers 429, for the time its Retry-After names", async () => {
    let sent = 0;
    const refused = await pace.paced("limited", quick, async () => (sent++, new Response("slow down", { status: 429, headers: { "retry-after": "30" } })));
    expect(refused.status).toBe(429);
    expect(pace.paceNow("limited").pausedMs).toBeGreaterThan(29_000);
    expect(pace.paceNow("limited").pausedMs).toBeLessThanOrEqual(30_000);
    await expect(pace.paced("limited", quick, async () => (sent++, new Response("ok")))).rejects.toMatchObject({ name: "HeldBack" });
    expect(sent).toBe(1);
    // Another service's pace is its own.
    expect((await pace.paced("other", quick, async () => new Response("ok"))).status).toBe(200);
  });

  it("reads a Retry-After in seconds or as a date, and pauses its own while when there is none", async () => {
    const now = Date.parse("2020-01-01T00:00:00Z");
    expect(pace.retryAfterMs("120", now)).toBe(120_000);
    expect(pace.retryAfterMs("Wed, 01 Jan 2020 00:00:45 GMT", now)).toBe(45_000);
    expect(pace.retryAfterMs("soon", now)).toBeUndefined();
    expect(pace.retryAfterMs(null, now)).toBeUndefined();
    await pace.paced("unnamed", quick, async () => new Response("slow down", { status: 429 }));
    expect(pace.paceNow("unnamed").pausedMs).toBeGreaterThan(39_000);
  });

  it("gives the source nothing, and no error, when its service is paused", async () => {
    placed = { anidbId: 15307, episode: 7, run: false };
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429, headers: { "retry-after": "60" } }));
    expect(await source.tsukihimeSubtitles({ type: "series", id: "tt9000004:2:7", imdbId: "tt9000004", season: 2, episode: 7 } as never, "Show", ["english"])).toEqual([]);
    let asked = 0;
    vi.stubGlobal("fetch", async () => (asked++, json({ id: 1 })));
    expect(await source.tsukihimeSubtitles({ type: "series", id: "tt9000005:2:7", imdbId: "tt9000005", season: 2, episode: 7 } as never, "Show", ["english"])).toEqual([]);
    expect(asked).toBe(0);
  });
});
