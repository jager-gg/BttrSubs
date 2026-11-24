/** aninzb as a source (aninzb.ts): an episode's releases in one request, and one subtitle a language from each release that has just one. */
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = ".cache-aninzb-test";
let placed: { anidbId: number; episode: number; run: boolean } | undefined;
vi.mock("../src/animelists.js", () => ({ animeEpisode: async () => placed }));

let source: typeof import("../src/aninzb.js");
let pace: typeof import("../src/pace.js");
let openUrl: (sealed: string) => string | undefined;

beforeAll(async () => {
  process.env.CACHE_DIR = CACHE;
  process.env.CONFIG_SECRET = "aninzb-test-secret-aninzb-test-secret-1";
  source = await import("../src/aninzb.js");
  pace = await import("../src/pace.js");
  openUrl = (await import("../src/profile.js")).openUrl;
});
afterEach(() => {
  vi.unstubAllGlobals();
  pace.forgetPaces();
  placed = undefined;
});
afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const fileOf = (release: string, track: number, lang: string, ext = "ass") => `https://api.aninzb.moe/files/re/77/key-of-its-own/${encodeURIComponent(`${release}.${track}.${lang}.${ext}`)}`;
const request = (n: number, extra: Record<string, unknown> = {}) => ({ type: "series", id: `tt91000${n}:1:5`, imdbId: `tt91000${n}`, season: 1, episode: 5, ...extra }) as never;

describe("an episode's subtitles from aninzb's releases", () => {
  it("asks once by the show's AniDB entry, and takes a language from a release only where the release has one track in it", async () => {
    placed = { anidbId: 19001, episode: 5, run: false };
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ total_count: 3, items: [
        { source: "release", filename: "Show.S01E05.1080p.WEB-DL.DUAL-TEAM", season: 1, episode: 5, subtitles: [fileOf("Show.S01E05.1080p.WEB-DL.DUAL-TEAM", 3, "eng"), fileOf("Show.S01E05.1080p.WEB-DL.DUAL-TEAM", 4, "eng"), fileOf("Show.S01E05.1080p.WEB-DL.DUAL-TEAM", 5, "spa"), fileOf("Show.S01E05.1080p.WEB-DL.DUAL-TEAM", 6, "ara", "srt")] },
        { source: "release", filename: "Show - S01E05 - Title (Dub Only)", season: 1, episode: 5, subtitles: [fileOf("Show - S01E05 - Title (Dub Only)", 2, "eng")] },
        { source: "release", filename: "[Raw] Show - 05", season: 1, episode: 5, subtitles: [] }
      ] }), { headers: { "content-type": "application/json" } });
    });
    const rows = await source.aninzbSubtitles(request(1), "Show", ["english", "arabic", "spanish", "dutch"]);
    expect(asked).toEqual(["https://api.aninzb.moe/?anidb=19001&episode=5&source=release"]);
    // The dual-audio release has two English tracks, with nothing to tell the full one by: only its Arabic and Spanish are taken.
    expect(rows.map((r) => [r.language, r.releaseInfo?.[0]])).toEqual([
      ["arabic", "Show.S01E05.1080p.WEB-DL.DUAL-TEAM"],
      ["spanish", "Show.S01E05.1080p.WEB-DL.DUAL-TEAM"],
      ["english", "Show - S01E05 - Title (Dub Only)"]
    ]);
    // A dub-only release's one English track is the dub's captions, and is worded so; the others never are.
    expect(rows[2].commentary).toMatch(/^English Dub captions/);
    expect(rows[0].commentary).not.toMatch(/dub/i);
    // Each carries its own address sealed, and a ref made from it.
    expect(rows.every((r) => r.source === "aninzb" && /^az[0-9a-f]{20}$/.test(r.ref ?? "") && r.sealedUrl && !r.sealedUrl.includes("aninzb"))).toBe(true);
    expect(openUrl(rows[0].sealedUrl as string)).toBe(fileOf("Show.S01E05.1080p.WEB-DL.DUAL-TEAM", 6, "ara", "srt"));
    // Asked again, it answers from what is kept.
    await source.aninzbSubtitles(request(1), "Show", ["english"]);
    expect(asked).toHaveLength(1);
  });

  it("asks by the show's name, its season and episode when the lists don't place it, and gives nothing for a film", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (asked.push(String(input)), new Response(JSON.stringify({ items: [{ filename: "Show.Name.S01E05.WEB", subtitles: [fileOf("Show.Name.S01E05.WEB", 2, "ger")] }, { filename: "Show.Name.S01E06.WEB", subtitles: [fileOf("Show.Name.S01E06.WEB", 2, "ger")] }] }))));
    const rows = await source.aninzbSubtitles(request(2), "Show Name", ["german"]);
    expect(asked[0]).toBe("https://api.aninzb.moe/?name=Show%20Name&season=1&episode=5&source=release");
    // A release whose name gives another episode isn't this one's, whatever the answer filed it under.
    expect(rows.map((r) => r.releaseInfo?.[0])).toEqual(["Show.Name.S01E05.WEB"]);
    expect(await source.aninzbSubtitles({ type: "movie", id: "tt9100009", imdbId: "tt9100009" } as never, "Film", ["english"])).toEqual([]);
  });

  it("reads a track's language from its file's name", () => {
    expect(source.trackLanguage(fileOf("Show.S01E05", 3, "eng"))).toBe("english");
    expect(source.trackLanguage(fileOf("Show.S01E05", 7, "ara", "srt"))).toBe("arabic");
    expect(source.trackLanguage("https://api.aninzb.moe/files/re/1/k/Show.S01E05.mkv")).toBeUndefined();
    expect(source.trackLanguage("not a url")).toBeUndefined();
  });

  it("fetches a track only from the address its ref names, and only from aninzb's own files", async () => {
    const url = fileOf("Show.S01E05", 3, "eng");
    const rows = await (async () => {
      placed = { anidbId: 19003, episode: 5, run: false };
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items: [{ filename: "Show.S01E05", subtitles: [url] }] })));
      return source.aninzbSubtitles(request(3), "Show", ["english"]);
    })();
    vi.stubGlobal("fetch", async () => new Response("[Script Info]\n"));
    expect((await source.downloadAninzb(rows[0].ref as string, url)).toString()).toBe("[Script Info]\n");
    await expect(source.downloadAninzb(rows[0].ref as string, fileOf("Show.S01E05", 4, "eng"))).rejects.toThrow(/no address/);
    await expect(source.downloadAninzb(rows[0].ref as string, undefined)).rejects.toThrow(/no address/);
    const elsewhere = "https://elsewhere.example/files/x.1.eng.ass";
    const { createHash } = await import("node:crypto");
    await expect(source.downloadAninzb(`az${createHash("sha256").update(elsewhere).digest("hex").slice(0, 20)}`, elsewhere)).rejects.toThrow(/isn't one of aninzb's files/);
  });
});
