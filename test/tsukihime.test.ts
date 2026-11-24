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
