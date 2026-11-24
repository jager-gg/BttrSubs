/**
 * The subtitle list and the download, end to end against stand-ins for every site: a source that
 * fails or is slow never costs the others, a list waits for syncs it can finish and lists a fallback
 * in place of a subtitle that doesn't fit, the dub and CC tracks, SubDL's daily downloads, and the
 * download's one time budget.
 */
import AdmZip from "adm-zip";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/profile.js";
import type { Cue } from "../src/sync.js";
import { ASS_HEADER, ASS_LINES, release } from "./mkvfile.js";

const CACHE = ".cache-lists-test";
const AIO = "https://aiostreams.example.com/stremio/list-test-uuid/pass/manifest.json";
let base = "";
let close = () => {};
let seal: (s: Settings) => string;
let stats: typeof import("../src/stats.js");
let cacheKey: (what: unknown) => string;
const realFetch = globalThis.fetch;
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

beforeAll(async () => {
  process.env.CONFIG_SECRET = "lists-test-secret-lists-test-secret-123";
  // This server's own AIOStreams: its accounts share a file's readings, kept under the file's plain ref.
  process.env.OWN_AIOSTREAMS = "https://aiostreams.example.com";
  process.env.PUBLIC_BASE_URL = "https://sync.example";
  process.env.CACHE_DIR = CACHE;
  // The times these tests wait and expect are written for a list of 4 s.
  process.env.LIST_BUDGET_MS = "4000";
  process.on("unhandledRejection", onRejection);
  seal = (await import("../src/profile.js")).sealSettings;
  stats = await import("../src/stats.js");
  // The stand-in Anime Tosho doesn't block: unpaced.
  (await import("../src/animetosho.js")).feedPace.everyMs = 0;
  cacheKey = (await import("../src/cache.js")).cacheKey;
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  close();
  process.off("unhandledRejection", onRejection);
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = <T,>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
/** A site that never answers: what waits on it is still waiting when the test ends, and nothing it would do afterwards reaches another test. */
const never = () => new Promise<Response>(() => {});
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Every site this test talks to, answered by `handle`; this server itself is reached for real. */
function sites(handle: Handler, hits: string[] = []) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input instanceof Request ? input.url : input);
    if (raw.startsWith(base)) return realFetch(input, init);
    hits.push(raw);
    return (await handle(new URL(raw), init)) ?? new Response("not here", { status: 404 });
  });
  return hits;
}

const sub = (id: number, release: string, extra: Record<string, unknown> = {}) => ({
  subtitleId: id, movieId: 1, language: "english", releaseInfo: [release], commentary: null, files: 1, hearingImpaired: false, downloads: 0, rating: null, ...extra
});

/** SubSource with one season-1 record (its id unique per test: SubSource's lists are cached by it) and these subtitles per language. */
function subsource(url: URL, lists: Record<string, unknown[]>, files: Record<string, string> = {}, movieId = 1): Response | undefined {
  if (url.hostname !== "api.subsource.net") return undefined;
  if (url.pathname.endsWith("/movies/search")) return json({ data: [{ movieId, title: "Show", type: "tvseries", season: 1, subtitleCount: 9 }] });
  if (url.pathname.endsWith("/subtitles")) return json({ data: lists[url.searchParams.get("language") ?? ""] ?? [], pagination: { pages: 1 } });
  const download = url.pathname.match(/\/subtitles\/(\d+)\/download$/);
  if (download && files[download[1]]) return new Response(files[download[1]]);
  return undefined;
}

/** Cinemeta for an anime (animation from Japan): the season map is looked up only for one. */
const cinemeta = (url: URL) => (url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { country: "Japan", genres: ["Animation"], name: "Show" } }) : undefined);
const openSubtitlesArabic = (url: URL, id: number) =>
  url.hostname === "opensubtitles.stremio.homes" ? json({ subtitles: [{ sub_id: id, lang_code: "ar", title: "Show.S01E05.1080p.WEB" }] }) : undefined;

type Track = { lang: string; label: string; url: string };
async function list(settings: Settings, id: string, extra = "") {
  const started = Date.now();
  const res = await realFetch(`${base}/${seal(settings)}/subtitles/series/${encodeURIComponent(id)}${extra}.json`);
  const body = (await res.json()) as { subtitles: Track[]; cacheMaxAge: number };
  return { status: res.status, ms: Date.now() - started, cache: res.headers.get("cache-control") ?? "", ...body };
}
const refOfTrack = (t: Track) => new URL(t.url).pathname.split("/").at(-2);
const altsOf = (t: Track) => (new URL(t.url).searchParams.get("alt") ?? "").split(",").filter(Boolean).map((a) => a.split("@")[0]);

/** A dialogue's timing, made up but irregular like real speech (a seeded random walk). */
function dialogue(seed: number, until = 20 * 60000): Cue[] {
  let s = seed;
  const random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Cue[] = [];
  for (let t = 30000; t < until - 5000; ) {
    const length = 900 + Math.round(random() * 2600);
    out.push({ start: t, end: t + length });
    t += length + 150 + Math.round(random() * (random() < 0.15 ? 6000 : 1500));
  }
  return out;
}
const stamp = (ms: number) =>
  `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
// The lines carry no words, so the check of an upload's language (notWrittenIn) can't judge them: these
// subtitles stand for one in any language.
const srt = (cues: Cue[]) => cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n#${i + 1}\n`).join("\n");

/** The playing file as if its Matroska index had been read: these lines on its subtitle track (and `more` in its record). */
async function fileWithTrack(filename: string, lines: Cue[], more: Record<string, unknown> = {}) {
  const duration = 20 * 60000;
  const windows = [];
  for (let from = 0; from < duration; from += 60000) windows.push({ from, to: from + 60000, cues: lines.filter((c) => c.start >= from && c.start < from + 60000) });
  await mkdir(path.join(process.cwd(), CACHE, "anchors"), { recursive: true });
  await writeFile(path.join(process.cwd(), CACHE, "anchors", `${cacheKey({ kind: "file-anchors", filename })}.json`), JSON.stringify({ filename, duration, windows, track: 2, source: "index", rounds: 2, subtitleLangs: [], ...more }));
}

/** The playing file as one with no subtitle track and no audio to hear: nothing syncs to it. */
async function fileWithoutTrack(filename: string) {
  await mkdir(path.join(process.cwd(), CACHE, "anchors"), { recursive: true });
  await writeFile(path.join(process.cwd(), CACHE, "anchors", `${cacheKey({ kind: "file-anchors", filename })}.json`), JSON.stringify({ filename, duration: 1200000, windows: [], speechChecked: true, subtitleLangs: [] }));
}

const playing = (filename: string) => `/${new URLSearchParams({ filename })}`;

describe("a source that fails", () => {
  it("leaves SubSource out when it refuses, and still lists the others, with no crash", async () => {
    sites((url) => (url.hostname === "api.subsource.net" ? new Response("too many requests", { status: 429 }) : openSubtitlesArabic(url, 9101)));
    const answer = await list({ subsource: "sk_failing_key_0001", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000701:1:5");
    expect(answer.status).toBe(200);
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9101"]);
    await later(50, () => undefined);
    expect(rejections).toEqual([]);
    const noted = (await stats.statsView("test")).errors.filter((e) => e.where === "subsource");
    expect(noted.length).toBe(1);
    expect(noted[0].message).toMatch(/SubSource 429/);
    // The error carries its request's id: that list, which still answered, shows under Errors.
    const row = stats.activityPage({ kind: "error", limit: 50 }).rows.find((r) => r.req === noted[0].req);
    expect(row?.kind).toBe("list");
    expect(row?.failed?.map((f) => f.where)).toEqual(["subsource"]);
  });

  it("does the same when SubSource can't be reached at all", async () => {
    sites((url) => {
      if (url.hostname === "api.subsource.net") throw new TypeError("fetch failed");
      return openSubtitlesArabic(url, 9102);
    });
    const answer = await list({ subsource: "sk_offline_key_00002", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000702:1:5");
    expect(answer.status).toBe(200);
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9102"]);
    await later(50, () => undefined);
    expect(rejections).toEqual([]);
  });

  it("loses only the language whose SubSource list failed", async () => {
    sites((url) => {
      if (url.hostname === "api.subsource.net" && url.pathname.endsWith("/subtitles") && url.searchParams.get("language") === "arabic") return new Response("oops", { status: 500 });
      return subsource(url, { dutch: [sub(9103, "Show S01E05", { language: "dutch" })] }, {}, 103);
    });
    const answer = await list({ subsource: "sk_half_broken_00003", languages: ["Arabic", "Dutch"], allowMachine: false, hearingImpaired: "include" }, "tt0000703:1:5");
    expect(answer.status).toBe(200);
    expect(answer.subtitles.map((t) => [t.lang, refOfTrack(t)])).toEqual([["Dutch", "ss9103"]]);
    await later(50, () => undefined);
    expect(rejections).toEqual([]);
  });
});

describe("a slow source", () => {
  it("doesn't take the fast ones' results with it, and the partial list is kept briefly", async () => {
    sites((url) => {
      if (url.hostname === "api.subdl.com") return json({ status: true, subtitles: [{ url: "/subtitle/9104-1.zip", language: "AR", release_name: "Show S01E05", season: 1, episode: 5 }] });
      if (url.hostname === "opensubtitles.stremio.homes") return later(6000, () => json({ subtitles: [] }));
      return undefined;
    });
    const answer = await list({ subdl: "subdl_fast_key_0004", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000704:1:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["sd9104-1"]);
    expect(answer.ms).toBeLessThan(5000);
    expect(answer.cache).toBe("max-age=30");
    expect(answer.cacheMaxAge).toBe(30);
    // The activity row names the source left out, and what was sent.
    const row = stats.activityPage({ kind: "list", limit: 50 }).rows[0];
    expect(row.result).toBe("1 track, partial");
    expect(row.detail).toMatchObject({ tracks: [{ lang: "Arabic", source: "SubDL", ref: "sd9104-1", release: "Show S01E05", state: "no file" }], late: ["OpenSubtitles"], video: "tt0000704:1:5" });
    // Each source it waited on, with what it gave and when: the slow one left out at the deadline.
    const asked = Object.fromEntries((row.detail?.sources ?? []).map((s) => [s.name, s]));
    expect(asked.SubDL).toMatchObject({ state: "in time", got: 1 });
    expect(asked.OpenSubtitles).toMatchObject({ state: "late" });
    expect(asked.OpenSubtitles.got).toBeUndefined();
    expect(asked.OpenSubtitles.ms).toBeGreaterThanOrEqual(3900);
    // Sources this link has off aren't asked, so they aren't there.
    expect(asked["Wyzie Subs"]).toBeUndefined();
    expect(row.detail?.client).toMatch(/\S/);
  }, 15000);

  it("doesn't record Anime Tosho for a title that isn't anime: it is asked nothing there", async () => {
    sites((url) => (url.hostname === "opensubtitles.stremio.homes" ? json({ subtitles: [] }) : undefined));
    await list({ opensubtitles: true, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000705:1:5");
    const row = stats.activityPage({ kind: "list", limit: 50 }).rows[0];
    const names = (row.detail?.sources ?? []).map((s) => s.name);
    expect(names).toContain("OpenSubtitles");
    expect(names).not.toContain("Anime Tosho");
    expect(row.detail?.late ?? []).not.toContain("Anime Tosho");
  }, 15000);

  it("reads a file's name as the player wrote it: a plus, an ampersand and a percent sign stay in it", async () => {
    sites((url) => (url.hostname === "opensubtitles.stremio.homes" ? json({ subtitles: [] }) : undefined));
    const name = "Show - S01E05 - 005 [JA+EN] Tom & Co 100% [1080p]-TEAM";
    await list({ opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000716:1:5", `/videoSize=1986148202&filename=${encodeURIComponent(name)}`);
    const row = stats.activityPage({ kind: "list", limit: 50 }).rows[0];
    expect(JSON.stringify(row)).toContain(JSON.stringify(name).slice(1, -1));
    // A space written as a plus, as a form would, is still a space.
    await list({ opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000716:1:6", "/filename=Show+-+S01E06+-TEAM");
    expect(JSON.stringify(stats.activityPage({ kind: "list", limit: 50 }).rows[0])).toContain("Show - S01E06 -TEAM");
  }, 15000);

  it("carries any file name whole from the list into its download links, and takes those links back", async () => {
    const names = [
      "Show - S01E05 [JA+EN] Tom & Co 100%-TEAM",
      "Show.S01E05.What's.Up? #1 (2020) [1080p].mkv",
      "Show S01E05 = Part 1; 50% off, «quoted» \"twice\"",
      "Série S01E05 – Épisode ñ 日本語 مرحبا 🎬",
      "Show/S01E05\\with slashes",
      " Show S01E05 leading and trailing spaces ",
      "Show.S01E05..mkv.",
      "%41%2B%zz Show S01E05",
    ];
    for (const [i, name] of names.entries()) {
      sites((url) => openSubtitlesArabic(url, 9300 + i));
      const size = String(2_000_000_000 + i);
      const answer = await list({ opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, `tt000072${i}:1:5`, `/filename=${encodeURIComponent(name)}&videoSize=${size}`);
      expect(answer.subtitles.length, name).toBe(1);
      const link = new URL(answer.subtitles[0].url);
      expect(link.searchParams.get("file"), name).toBe(`${name}/${size}`);
      // The link is taken back with its file's name (without the video id, so nothing is looked up or read).
      const back = new URL(answer.subtitles[0].url.replace("https://sync.example", base));
      back.searchParams.delete("vid");
      // Asked again when it fails once: on Windows the list's own sync can hold the subtitle's cached
      // file open while the download replaces it. A name the server can't take fails every time.
      let download = await realFetch(back);
      for (let again = 0; again < 3 && download.status === 500; again++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        download = await realFetch(back);
      }
      expect(download.status, name).toBe(200);
    }
  }, 60000);

  it("waits past the deadline for a release its episode search found, while it's being read, and lists its dub track", async () => {
    const release = {
      id: 7121,
      title: "[Group] Hold Show S2 - 02 [English Dub] [WEB 1080p]",
      files: [{ filename: "[Group] Hold Show S2 - 02 [English Dub] [WEB 1080p].mkv", info: { mediainfo: "" }, attachments: [{ type: "subtitle", url: "https://storage.animetosho.net/attachments/000f7/121.xz", info: { name: "English [CC]", language_code: "eng", format: "ASS" } }] }]
    };
    const start = Date.now();
    sites((url) => {
      if (url.hostname === "anime-kitsu.strem.fun") return url.pathname.includes("/catalog/") ? json({ metas: [] }) : json({ meta: { imdb_id: "tt0000712", videos: [{ episode: 2, imdbSeason: 2, imdbEpisode: 2 }] } });
      if (url.hostname === "feed.animetosho.net") {
        if (url.pathname === "/api") return new Response(`<rss><channel><item><title>${release.title}</title><guid>https://animetosho.net/view/7121</guid><torznab:attr name="files" value="1"/></item></channel></rss>`);
        // The release is read slowly: it comes in 4.6 s into the list, after its 4 s deadline, within its grace.
        if (url.searchParams.get("show") === "torrent") return later(Math.max(0, 4600 - (Date.now() - start)), () => json(release));
        return json([]);
      }
      // Its own show name: its searches by name are kept apart from the other tests'.
      return url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { country: "Japan", genres: ["Animation"], name: "Hold Show" } }) : undefined;
    });
    const answer = await list({ opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "kitsu:7120:2");
    expect(answer.subtitles.map(refOfTrack)).toContain("at000f7121");
    expect(answer.ms).toBeGreaterThan(4500);
    expect(answer.ms).toBeLessThan(5600);
  }, 15000);

  it("reads the episode's dub release while the season map is still being looked up, so a slow map doesn't cost the list its dub track", async () => {
    const release = {
      id: 7131,
      title: "[Group] Early Show S02E02 [English Dub] [WEB 1080p]",
      files: [{ filename: "[Group] Early Show S02E02 [English Dub] [WEB 1080p].mkv", info: { mediainfo: "" }, attachments: [{ type: "subtitle", url: "https://storage.animetosho.net/attachments/000f7/131.xz", info: { name: "English [CC]", language_code: "eng", format: "ASS" } }] }]
    };
    const asked: Array<{ what: string; at: number }> = [];
    const start = Date.now();
    sites((url) => {
      // The season map's look-up answers 3.5 s in; the release takes 2.5 s to read. One after the other,
      // the track would come 6 s in, past the list's 5.5 s; side by side, inside it.
      if (url.hostname === "anime-kitsu.strem.fun") return later(Math.max(0, 3500 - (Date.now() - start)), () => (asked.push({ what: "map", at: Date.now() - start }), json({ metas: [] })));
      if (url.hostname === "feed.animetosho.net") {
        if (url.pathname === "/api") return new Response(`<rss><channel><item><title>${release.title}</title><guid>https://animetosho.net/view/7131</guid><torznab:attr name="files" value="1"/></item></channel></rss>`);
        if (url.searchParams.get("show") === "torrent") {
          asked.push({ what: "release", at: Date.now() - start });
          return later(2500, () => json(release));
        }
        asked.push({ what: `search ${url.searchParams.get("q") ?? ""}`, at: Date.now() - start });
        return json([]);
      }
      return url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { country: "Japan", genres: ["Animation"], name: "Early Show" } }) : undefined;
    });
    // An id of its own: nothing kept for another test's episode answers for this one.
    const answer = await list({ opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "tt0000719:2:2");
    expect(answer.subtitles.map(refOfTrack)).toContain("at000f7131");
    // The release was asked for before the map answered, and once.
    expect(asked.filter((a) => a.what === "release")).toHaveLength(1);
    expect(asked.find((a) => a.what === "release")!.at).toBeLessThan(1500);
    expect(answer.ms).toBeLessThan(5600);
    // The look-up goes on after the list (the show's wide searches): waited for, so it asks nothing of the next test's sites.
    await vi.waitFor(() => expect(asked.some((a) => a.what === "search Early Show Dubbed")).toBe(true), { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 20000);

  describe("the episode's dub captions, asked in turn", () => {
    it("reads a release named as the episode's English dub as soon as its search finds it, before a dual-audio one and before the show's wide searches", async () => {
      const { animeToshoSubtitles } = await import("../src/animetosho.js");
      const asked: string[] = [];
      const dual = { id: 8631, title: "[Group] Turn Show - S01E05 [Dual Audio] [WEB 1080p]", status: "complete", files: [{ filename: "[Group] Turn Show - S01E05 [Dual Audio] [WEB 1080p].mkv", info: { mediainfo: "" }, attachments: [{ type: "subtitle", url: "https://storage.animetosho.net/attachments/000f8/631.xz", info: { name: "English", language_code: "eng", format: "ASS" } }] }] };
      const dub = { id: 8632, title: "[Dubs] Turn Show - S01E05 [English Dub] [WEB 1080p]", status: "complete", files: [{ filename: "[Dubs] Turn Show - S01E05 [English Dub] [WEB 1080p].mkv", info: { mediainfo: "" }, attachments: [{ type: "subtitle", url: "https://storage.animetosho.net/attachments/000f8/632.xz", info: { name: "English [CC]", language_code: "eng", format: "ASS" } }] }] };
      sites((url) => {
        if (url.hostname !== "feed.animetosho.net") return undefined;
        if (url.pathname === "/api") return (asked.push("episode search"), new Response(`<rss><channel><item><title>${dual.title}</title><guid>https://animetosho.net/view/${dual.id}</guid><torznab:attr name="files" value="1"/></item></channel></rss>`));
        if (url.searchParams.get("show") === "torrent") {
          const id = Number(url.searchParams.get("id"));
          asked.push(`release ${id}`);
          return json([dual, dub].find((r) => r.id === id));
        }
        const q = url.searchParams.get("q") ?? "";
        asked.push(`search ${q}`);
        return json(q === `Turn Show "English Dub" 05` ? [{ id: dub.id, title: dub.title, num_files: 1, status: "complete" }] : []);
      });
      const request = { type: "series" as const, id: "tt0000863:1:5", imdbId: "tt0000863", season: 1, episode: 5 };
      const found: Array<{ ref?: string }> = [];
      const all = await animeToshoSubtitles(request, "Turn Show", undefined, { found: found as never[] });
      expect(all.map((s) => s.ref)).toContain("at000f8632");
      const at = (what: string) => asked.indexOf(what);
      expect(at(`search Turn Show "English Dub" 05`)).toBeGreaterThan(at("episode search"));
      expect(at("release 8632")).toBe(at(`search Turn Show "English Dub" 05`) + 1);
      expect(at("release 8632")).toBeLessThan(at(`search Turn Show "Dual Audio" S01E05`));
      expect(at("release 8631")).toBeGreaterThan(at(`search Turn Show "Dual Audio" S01E05`));
      expect(at("release 8631")).toBeLessThan(at(`search Turn Show "English Dub"`));
    });
  });

  describe("the episode's signs", () => {
    const track = (n: number, name: string, extra: Record<string, unknown> = {}) => ({ type: "subtitle", url: `https://storage.animetosho.net/attachments/000f8/${n}.xz`, info: { name, language_code: "eng", format: "ASS", ...extra } });
    const rel = (id: number, title: string, attachments: unknown[]) => ({ id, title, status: "complete", files: [{ filename: `${title}.mkv`, info: { mediainfo: "" }, attachments }] });
    /** Anime Tosho with these releases filed under the episode, read in turn; `read` gets each release asked for. */
    const feedWith = (releases: Array<ReturnType<typeof rel>>, read: number[]) =>
      sites((url) => {
        if (url.hostname !== "feed.animetosho.net") return undefined;
        if (url.pathname === "/api") return new Response(`<rss><channel>${releases.map((r) => `<item><title>${r.title}</title><guid>https://animetosho.net/view/${r.id}</guid><torznab:attr name="files" value="1"/></item>`).join("")}</channel></rss>`);
        const id = Number(url.searchParams.get("id"));
        if (url.searchParams.get("show") === "torrent") return (read.push(id), json(releases.find((r) => r.id === id)));
        return json([]);
      });

    it("gives a signs track as soon as the release holding it is read, without reading the rest", async () => {
      const { animeToshoSigns } = await import("../src/animetosho.js");
      const read: number[] = [];
      feedWith(
        [
          rel(8611, "[Group] First Signs Show - 05 [BD 1080p][Dual Audio]", [track(611, "Signs & Songs", { forced: true }), track(612, "Dialogue")]),
          rel(8612, "[Other] First Signs Show - 05 [WEB 1080p]", [track(621, "Full Subtitles")]),
          rel(8613, "[Third] First Signs Show - 05 [WEB 720p]", [track(631, "Full Subtitles")])
        ],
        read
      );
      const request = { type: "series" as const, id: "tt0000861:1:5", imdbId: "tt0000861", season: 1, episode: 5 };
      const sources = animeToshoSigns(request, "First Signs Show", undefined, { filename: "[Mine] First Signs Show 05 (BD 1080p).mkv" });
      const first = await sources.next();
      expect(first.value).toMatchObject({ signs: "at000f8611", partner: "at000f8612", full: false });
      expect(read).toEqual([8611]);
      await sources.return(undefined);
    });

    it("reads a release with a dub that the episode's own search lists before it asks its name searches", async () => {
      const { animeToshoSigns } = await import("../src/animetosho.js");
      const asked: string[] = [];
      const own = rel(8641, "[Group] Early Signs Show - 05 [WEB 1080p][Dual-Audio]", [track(661, "Signs & Songs", { forced: true }), track(662, "Dialogue")]);
      const plain = rel(8642, "[Other] Early Signs Show - 05 [WEB 1080p][Multi-Subs]", [track(671, "Full Subtitles")]);
      const disc = rel(8643, "[Third] Early Signs Show - 05 [BD 1080p][Dual Audio]", [track(681, "Signs & Songs", { forced: true }), track(682, "Dialogue")]);
      sites((url) => {
        if (url.hostname !== "feed.animetosho.net") return undefined;
        if (url.pathname === "/api") {
          asked.push("episode search");
          return new Response(`<rss><channel>${[plain, own].map((r) => `<item><title>${r.title}</title><guid>https://animetosho.net/view/${r.id}</guid><torznab:attr name="files" value="1"/></item>`).join("")}</channel></rss>`);
        }
        const id = Number(url.searchParams.get("id"));
        if (url.searchParams.get("show") === "torrent") return (asked.push(`release ${id}`), json([own, plain, disc].find((r) => r.id === id)));
        const q = url.searchParams.get("q") ?? "";
        asked.push(`search ${q}`);
        return json(q.includes("Dual Audio") ? [{ id: disc.id, title: disc.title, status: "complete", num_files: 1 }] : []);
      });
      const request = { type: "series" as const, id: "tt0000864:1:5", imdbId: "tt0000864", season: 1, episode: 5 };
      const sources = animeToshoSigns(request, "Early Signs Show", undefined, { filename: "[Mine] Early Signs Show 05 (BD 1080p).mkv" });
      // The first signs come from the release in hand, with nothing asked but it.
      expect((await sources.next()).value).toMatchObject({ signs: "at000f8661", full: false });
      expect(asked).toEqual(["episode search", "release 8641"]);
      // Asked for more, it goes on as before: its name searches, then the release from the playing file's kind of source.
      expect((await sources.next()).value).toMatchObject({ signs: "at000f8681", full: false });
      expect(asked.indexOf("release 8643")).toBeGreaterThan(asked.findIndex((what) => what.startsWith("search ")));
      expect(asked.filter((what) => what === "release 8641")).toHaveLength(1);
      await sources.return(undefined);
    });

    it("gives a signs track found in a later release before a full track found first", async () => {
      const { animeToshoSigns } = await import("../src/animetosho.js");
      const read: number[] = [];
      feedWith(
        [
          rel(8621, "[Group] Second Signs Show - 05 [BD 1080p][Dual Audio]", [track(641, "Full Subtitles")]),
          rel(8622, "[Other] Second Signs Show - 05 [WEB 1080p]", [track(651, "Signs/Songs"), track(652, "Full Subtitles")])
        ],
        read
      );
      const request = { type: "series" as const, id: "tt0000862:1:5", imdbId: "tt0000862", season: 1, episode: 5 };
      const all = [];
      for await (const s of animeToshoSigns(request, "Second Signs Show", undefined, { filename: "[Mine] Second Signs Show 05 (BD 1080p).mkv" })) all.push(s);
      expect(all.map((s) => [s.signs, s.full])).toEqual([["at000f8651", false], ["at000f8641", true]]);
    });
  });

  it("asks for the episode by its ids while the season map is still being looked up", async () => {
    const seen: Array<{ what: string; at: number }> = [];
    const start = Date.now();
    sites((url) => {
      if (url.hostname === "anime-kitsu.strem.fun") {
        // The show's first look: its catalog search takes a while.
        if (url.pathname.includes("/catalog/")) return later(1500, () => (seen.push({ what: "kitsu answered", at: Date.now() - start }), json({ metas: [] })));
        return json({ meta: {} });
      }
      if (url.hostname === "feed.animetosho.net") {
        if (url.pathname === "/api") {
          seen.push({ what: "episode search asked", at: Date.now() - start });
          return new Response("<rss><channel></channel></rss>");
        }
        return json([]);
      }
      return url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { country: "Japan", genres: ["Animation"], name: "Early Show" } }) : undefined;
    });
    await list({ opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "tt0000714:2:2");
    const asked = seen.find((s) => s.what === "episode search asked");
    const answered = seen.find((s) => s.what === "kitsu answered");
    expect(asked).toBeDefined();
    expect(answered).toBeDefined();
    expect(asked!.at).toBeLessThan(answered!.at);
  }, 15000);

  it("sends Anime Tosho's dub track for an English Dub track whose packs don't hold the episode, though it came in after the list", async () => {
    // An Anime Tosho track, xz-packed as its storage keeps them.
    const xz = Buffer.from("/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4AC+AJddAC2UyMtHifLr5yTJxebCHTfb/GkkOgEs1COSDHvfUSrdi+HDOaw/neUZiBNOgWB9UgTMNuUJeKKiTKdCELzwQPFCCw/dHoafq6DXwausOU+06ZjbiHLOkGHvkmKnZkaS9EjOIJ8XOP7kZC//bi5gpZkG/ourY8BarwDJnUBqAA4FJHysRYvM8YaD5DaJzSG6SObJvZ302qAAAPoAVGdZzPlBAAGzAb8BAABNqLgmscRn+wIAAAAABFla", "base64");
    const release = {
      id: 7161,
      title: "[Group] Pack Show S2 - 02 [English Dub] [WEB 1080p]",
      files: [{ filename: "[Group] Pack Show S2 - 02 [English Dub] [WEB 1080p].mkv", info: { mediainfo: "" }, attachments: [{ type: "subtitle", url: "https://storage.animetosho.net/attachments/000f8/161.xz", info: { name: "English [CC]", language_code: "eng", format: "ASS" } }] }]
    };
    // SubDL's pack of the season holds other episodes only.
    const pack = new AdmZip();
    pack.addFile("Pack Show S02E03.srt", Buffer.from(srt(dialogue(16))));
    sites((url) => {
      if (url.hostname === "dl.subdl.com") return new Response(new Uint8Array(pack.toBuffer()));
      if (url.hostname === "anime-kitsu.strem.fun") return json({ metas: [] });
      if (url.hostname === "feed.animetosho.net") {
        if (url.pathname === "/api") return new Response(`<rss><channel><item><title>${release.title}</title><guid>https://animetosho.net/view/7161</guid><torznab:attr name="files" value="1"/></item></channel></rss>`);
        if (url.searchParams.get("show") === "torrent") return json(release);
        return json([]);
      }
      if (url.hostname === "storage.animetosho.net") return url.pathname === "/attachments/000f8/161.xz" ? new Response(new Uint8Array(xz)) : undefined;
      return url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { country: "Japan", genres: ["Animation"], name: "Pack Show" } }) : undefined;
    });
    const settings: Settings = { subdl: "subdl_pack_key_00016", languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    const link = `${base}/${seal(settings)}/download/sd9516-1/subtitle.srt?season=2&episode=2&vid=${encodeURIComponent("tt0000736:2:2")}&type=series`;
    const sent = await realFetch(link);
    expect(sent.status).toBe(200);
    expect((await sent.text()).length).toBeGreaterThan(0);
    const row = stats.activityPage({ kind: "download", limit: 50 }).rows[0];
    expect(row.detail?.ref).toBe("at000f8161");
    expect(row.detail?.source).toBe("Anime Tosho");
  }, 15000);

  it("lists the Anime Tosho tracks it has read by the deadline, and says it's partly in", async () => {
    const release = {
      id: 7111,
      title: "[Group] Show S2 - 02 [English Dub] [WEB 1080p]",
      files: [{ filename: "[Group] Show S2 - 02 [English Dub] [WEB 1080p].mkv", info: { mediainfo: "" }, attachments: [{ type: "subtitle", url: "https://storage.animetosho.net/attachments/000f7/101.xz", info: { name: "English [CC]", language_code: "eng", format: "ASS" } }] }]
    };
    sites((url) => {
      if (url.hostname === "anime-kitsu.strem.fun") return url.pathname.includes("/catalog/") ? json({ metas: [] }) : json({ meta: { imdb_id: "tt0000711", videos: [{ episode: 2, imdbSeason: 2, imdbEpisode: 2 }] } });
      if (url.hostname === "feed.animetosho.net") {
        if (url.pathname === "/api") {
          return new Response(`<rss><channel><item><title>${release.title}</title><guid>https://animetosho.net/view/7111</guid><torznab:attr name="files" value="1"/></item></channel></rss>`);
        }
        if (url.searchParams.get("show") === "torrent") return json(release);
        return later(6000, () => json([]));
      }
      return cinemeta(url);
    });
    const answer = await list({ opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "kitsu:7110:2");
    // Its 4 s budget, plus the 1.5 s a release still being read may hold it, plus the test's own
    // overhead under load; never the 6 s the slow search takes.
    expect(answer.ms).toBeLessThan(5800);
    expect(answer.subtitles.map(refOfTrack)).toContain("at000f7101");
    expect(answer.cacheMaxAge).toBe(30);
    const row = stats.activityPage({ kind: "list", limit: 50 }).rows[0];
    expect(row.detail?.late).toContain("Anime Tosho (partly)");
  }, 15000);



  it("doesn't wait past the deadline when no release of the episode is being read", async () => {
    sites((url) => {
      if (url.hostname === "anime-kitsu.strem.fun") return url.pathname.includes("/catalog/") ? json({ metas: [] }) : json({ meta: { imdb_id: "tt0000713", videos: [{ episode: 2, imdbSeason: 2, imdbEpisode: 2 }] } });
      if (url.hostname === "feed.animetosho.net") {
        if (url.pathname === "/api") return new Response("<rss><channel></channel></rss>");
        return later(8000, () => json([]));
      }
      return url.hostname === "v3-cinemeta.strem.io" ? json({ meta: { country: "Japan", genres: ["Animation"], name: "Slow Show" } }) : undefined;
    });
    const answer = await list({ opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "kitsu:7130:2");
    expect(answer.ms).toBeLessThan(4600);
    const row = stats.activityPage({ kind: "list", limit: 50 }).rows[0];
    expect(row.detail?.late).toContain("Anime Tosho");
  }, 15000);

  it("keeps a full list five minutes, as before", async () => {
    sites((url) => subsource(url, { arabic: [sub(9105, "Show S01E05", { language: "arabic" })] }, {}, 105) ?? openSubtitlesArabic(url, 9106));
    const answer = await list({ subsource: "sk_all_fast_key_0005", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000705:1:5");
    expect(answer.subtitles).toHaveLength(1);
    expect(answer.cache).toBe("max-age=300, stale-while-revalidate=900");
    expect(answer.cacheMaxAge).toBe(300);
  });

  it("answers a new anime's first list in time while its id is looked up, and lists it next time", async () => {
    let lookedUp!: () => void;
    const answered = new Promise<void>((resolve) => (lookedUp = resolve));
    sites((url) => {
      if (url.hostname === "anime-kitsu.strem.fun")
        return later(6000, () => {
          lookedUp();
          return json({ meta: { imdb_id: "tt0000706", videos: [{ episode: 5, imdbSeason: 1, imdbEpisode: 5 }] } });
        });
      return openSubtitlesArabic(url, 9107);
    });
    const settings: Settings = { opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" };
    const first = await list(settings, "kitsu:7006:5");
    expect(first.ms).toBeLessThan(5000);
    expect(first.subtitles).toEqual([]);
    expect(first.cacheMaxAge).toBe(30);
    // The next list comes once the id is known, however slowly the host gets there.
    await answered;
    await later(500, () => undefined);
    const next = await list(settings, "kitsu:7006:5");
    expect(next.subtitles.map(refOfTrack)).toEqual(["osar-9107"]);
  }, 20000);
});

describe("a next episode's list, asked while the one before it starts", () => {
  const dubRelease = (id: number, episode: string) => ({
    id,
    title: `[Group] Ahead Show - ${episode} [English Dub] [WEB 1080p]`,
    status: "complete",
    files: [{ filename: `[Group] Ahead Show - ${episode} [English Dub] [WEB 1080p].mkv`, info: { mediainfo: "" }, attachments: [{ type: "subtitle", url: `https://storage.animetosho.net/attachments/000f8/${id - 8000}.xz`, info: { name: "English [CC]", language_code: "eng", format: "ASS" } }] }]
  });
  /** Anime Tosho, answering each request in 150 ms, one release named as the English dub for each episode; `asked` gets each request. */
  const feedFor = (show: string, releases: Record<string, ReturnType<typeof dubRelease>>, asked: string[]) =>
    sites((url) => {
      if (url.hostname === "v3-cinemeta.strem.io") return json({ meta: { country: "Japan", genres: ["Animation"], name: show } });
      if (url.hostname !== "feed.animetosho.net") return undefined;
      if (url.pathname === "/api") {
        const episode = String(url.searchParams.get("ep")).padStart(2, "0");
        asked.push(`ids ${episode}`);
        const r = releases[episode];
        return later(150, () => new Response(`<rss><channel>${r ? `<item><title>${r.title}</title><guid>https://animetosho.net/view/${r.id}</guid><torznab:attr name="files" value="1"/></item>` : ""}</channel></rss>`));
      }
      if (url.searchParams.get("show") === "torrent") {
        const id = Number(url.searchParams.get("id"));
        asked.push(`release ${id}`);
        return later(150, () => json(Object.values(releases).find((r) => r.id === id)));
      }
      asked.push(`search ${url.searchParams.get("q")}`);
      return later(150, () => json([]));
    });

  it("waits for that episode's Anime Tosho look-up before asking anything, and says it was asked ahead", async () => {
    const asked: string[] = [];
    feedFor("Ahead Show", { "05": dubRelease(8701, "05"), "06": dubRelease(8702, "06") }, asked);
    await fileWithoutTrack("Ahead.Show.S01E05.mkv");
    await fileWithoutTrack("Ahead.Show.S01E06.mkv");
    const settings: Settings = { opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    const playingNow = list(settings, "tt0000881:1:5", playing("Ahead.Show.S01E05.mkv"));
    await later(100, () => undefined);
    const askedAhead = list(settings, "tt0000881:1:6", playing("Ahead.Show.S01E06.mkv"));
    const [now, next] = await Promise.all([playingNow, askedAhead]);
    // The episode starting has Anime Tosho to itself until its dub track is in.
    expect(now.subtitles.map(refOfTrack)).toContain("at000f8701");
    const firstOfNext = asked.findIndex((a) => /\b06\b|8702/.test(a));
    expect(firstOfNext).toBeGreaterThan(asked.indexOf("release 8701"));
    expect(next.status).toBe(200);
    const rows = stats.activityPage({ kind: "list", limit: 50 }).rows;
    expect(rows.find((r) => r.detail?.video === "tt0000881:1:6")?.detail?.ahead).toBe(true);
    expect(rows.find((r) => r.detail?.video === "tt0000881:1:5")?.detail?.ahead).toBeUndefined();
  }, 20000);

  it("doesn't ask AIOStreams for its file until that episode's list is out", async () => {
    const order: string[] = [];
    const at: Record<string, number> = {};
    const note = (what: string) => (order.push(what), (at[what] ??= Date.now()));
    sites((url) => {
      if (url.hostname === "aiostreams.example.com" && url.pathname.includes("/stream/")) {
        note(`streams ${decodeURIComponent(url.pathname).match(/:(\d+)\.json$/)?.[1]}`);
        return json({ streams: [] });
      }
      // The episode starting waits on a source for a while: its list is still being made when the next one's is asked.
      if (url.hostname === "opensubtitles.stremio.homes") return later(700, () => json({ subtitles: [{ sub_id: 9883, lang_code: "ar", title: "Show.S01E05.1080p.WEB" }] }));
      return undefined;
    });
    const settings: Settings = { opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" };
    const playingNow = list(settings, "tt0000883:1:5", playing("Held.Show.S01E05.mkv")).then((answer) => (note("list 5 out"), answer));
    await later(100, () => undefined);
    const askedAhead = list(settings, "tt0000883:1:6", playing("Held.Show.S01E06.mkv"));
    await Promise.all([playingNow, askedAhead]);
    await later(300, () => undefined);
    expect(order.indexOf("streams 5")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("streams 5")).toBeLessThan(order.indexOf("list 5 out"));
    // Asked once that list's answer has left the server: the moment this test gets it, give or take the time to read it.
    expect(order).toContain("streams 6");
    expect(at["streams 6"]).toBeGreaterThanOrEqual(at["list 5 out"] - 100);
    expect(at["streams 6"] - at["streams 5"]).toBeGreaterThan(600);
  }, 30000);

  it("isn't held back once its file is being watched", async () => {
    const asked: string[] = [];
    feedFor("Watched Show", { "05": dubRelease(8711, "05"), "06": dubRelease(8712, "06") }, asked);
    await fileWithoutTrack("Watched.Show.S01E05.mkv");
    await fileWithoutTrack("Watched.Show.S01E06.mkv");
    (await import("../src/turns.js")).watching("Watched.Show.S01E06.mkv");
    const settings: Settings = { opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    const first = list(settings, "tt0000882:1:5", playing("Watched.Show.S01E05.mkv"));
    await later(100, () => undefined);
    await Promise.all([first, list(settings, "tt0000882:1:6", playing("Watched.Show.S01E06.mkv"))]);
    const rows = stats.activityPage({ kind: "list", limit: 50 }).rows;
    expect(rows.find((r) => r.detail?.video === "tt0000882:1:6")?.detail?.ahead).toBeUndefined();
  }, 20000);
});

describe("dub caption and CC tracks", () => {
  const dubs = [9201, 9202, 9203, 9204, 9205].map((id) => sub(id, `Show S01E05 [Eng Dubbed Version] ${id}`, { downloads: 100 - id + 9200 }));

  it("lists one subtitle a language unless the configuration asks for more, three at most, within what the server allows", async () => {
    const { config } = await import("../src/config.js");
    const arabic = [9206, 9207, 9208].map((id) => sub(id, `Show S01E05 ${id}`, { language: "arabic", downloads: 9300 - id }));
    sites((url) => subsource(url, { english: dubs, arabic }, {}, 107) ?? cinemeta(url));
    const one: Settings = { subsource: "sk_dub_cap_key_0006", aiostreams: AIO, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" };
    // Not said: one of each, the best.
    expect((await list(one, "tt0000707:1:5")).subtitles.map(refOfTrack)).toEqual(["ss9201", "ss9206"]);
    // Two asked for: two of each, English Dub and the other language alike.
    expect((await list({ ...one, perLanguage: 2 }, "tt0000707:1:5")).subtitles.map(refOfTrack)).toEqual(["ss9201", "ss9202", "ss9206", "ss9207"]);
    // The server allows fewer than the configuration asks for.
    const allowed = config.maxPerLanguage;
    config.maxPerLanguage = 2;
    try {
      expect((await list({ ...one, perLanguage: 3 }, "tt0000707:1:5")).subtitles.map(refOfTrack)).toEqual(["ss9201", "ss9202", "ss9206", "ss9207"]);
    } finally {
      config.maxPerLanguage = allowed;
    }
  });

  it("lists three dub tracks when asked for three; the others stand behind them as fallbacks", async () => {
    sites((url) => subsource(url, { english: dubs }, {}, 107) ?? cinemeta(url));
    const settings: Settings = { subsource: "sk_dub_cap_key_0006", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include", perLanguage: 3 };
    const bare = await list(settings, "tt0000707:1:5");
    expect(bare.subtitles.map(refOfTrack)).toEqual(["ss9201", "ss9202", "ss9203"]);
    // With a file playing, each track's fallbacks are in its link, the unlisted ones too.
    await fileWithoutTrack("Show.S01E05.Cap.mkv");
    const played = await list(settings, "tt0000707:1:5", playing("Show.S01E05.Cap.mkv"));
    expect(played.subtitles.map(refOfTrack)).toEqual(["ss9201", "ss9202", "ss9203"]);
    expect(altsOf(played.subtitles[0])).toEqual(["ss9202", "ss9203", "ss9204", "ss9205"]);
    expect(altsOf(played.subtitles[2])).toEqual(["ss9204", "ss9205"]);
  });

  it("gives English CC the other official CC tracks as fallbacks", async () => {
    const cc = [9211, 9212].map((id) => sub(id, `Show S01E05 ${id}`, { hearingImpaired: true, commentary: "Netflix", downloads: 9300 - id }));
    sites((url) => subsource(url, { english: cc }, {}, 108) ?? cinemeta(url));
    await fileWithoutTrack("Show.S01E05.CC.mkv");
    const answer = await list({ subsource: "sk_cc_alts_key_0007", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "tt0000708:1:5", playing("Show.S01E05.CC.mkv"));
    expect(answer.subtitles).toHaveLength(1);
    expect(answer.subtitles[0].label).toMatch(/^CC · /);
    expect(refOfTrack(answer.subtitles[0])).toBe("ss9211");
    expect(altsOf(answer.subtitles[0])).toEqual(["ss9212"]);
  });
});

describe("a subtitle whose lines run far past the file's end", () => {
  it("is passed over at once for a fallback, with nothing measured for it", async () => {
    const lines = dialogue(59);
    const right = lines.map((c) => ({ start: c.start - 800, end: c.end - 800 }));
    // A special's subtitles: lines for 50 minutes against a 20-minute file.
    const special = dialogue(61, 50 * 60000);
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9541\/download$/.test(url.pathname)) return new Response(srt(special));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9542\/download$/.test(url.pathname)) return new Response(srt(right));
      return undefined;
    });
    await fileWithTrack("Show.S01E05.Outrun.mkv", lines);
    const outrunsBefore = (await stats.statsView("t")).days[0]?.total["downloads.outruns.certain"] ?? 0;
    const token = seal({ subsource: "sk_outrun_download_41", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000741:1:5", type: "series", file: "Show.S01E05.Outrun.mkv", alt: "ss9542@1:5" });
    const res = await realFetch(`${base}/${token}/download/ss9541/subtitle.srt?${query}`);
    const starts = [...(await res.text()).matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
    expect(starts).toHaveLength(right.length);
    expect(starts.filter((s, i) => Math.abs(s - lines[i].start) <= 100).length / starts.length).toBeGreaterThan(0.9);
    // Caught at the download by the file's known length, before any sync starts.
    expect((await stats.statsView("t")).days[0].total["downloads.outruns.certain"]).toBe(outrunsBefore + 1);
  }, 20000);

  it("is timed and sent when its lines inside the file's length are the file's: an episode and the next in one subtitle", async () => {
    const lines = dialogue(63);
    const before = stats.countedToday("sync.outrunsPart");
    // This episode's lines, 600 ms late, then the next episode's for another half hour.
    const both = [...lines.map((c) => ({ start: c.start + 600, end: c.end + 600 })), ...dialogue(64, 30 * 60000).map((c) => ({ start: c.start + 20 * 60000, end: c.end + 20 * 60000 }))];
    sites((url) => (url.hostname === "api.subsource.net" && /\/subtitles\/9545\/download$/.test(url.pathname) ? new Response(srt(both)) : undefined));
    await fileWithTrack("Show.S01E05.Pair.mkv", lines);
    const token = seal({ subsource: "sk_outrun_pair_key_042", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000745:1:5", type: "series", file: "Show.S01E05.Pair.mkv" });
    const res = await realFetch(`${base}/${token}/download/ss9545/subtitle.srt?${query}`);
    const starts = [...(await res.text()).matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
    // Its first lines are this episode's, moved onto the file's.
    expect(starts.length).toBeGreaterThanOrEqual(lines.length);
    expect(lines.filter((c, i) => Math.abs(starts[i] - c.start) <= 100).length / lines.length).toBeGreaterThan(0.9);
    expect(stats.countedToday("sync.outrunsPart")).toBe(before + 1);
  }, 20000);

  it("is never the stand-in on a first play: the episode's runtime from Cinemeta tells before the file is read", async () => {
    const special = dialogue(67, 50 * 60000);
    const fallbackLines = dialogue(71);
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9551\/download$/.test(url.pathname)) return new Response(srt(special));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9552\/download$/.test(url.pathname)) return new Response(srt(fallbackLines));
      if (url.hostname === "v3-cinemeta.strem.io") return json({ meta: { name: "Show", runtime: "20 min", genres: [], country: "" } });
      // Finding the file in AIOStreams hangs: its header (and length) can't be read in time.
      if (url.hostname === "aiostreams.example.com") return never();
      return undefined;
    });
    const token = seal({ subsource: "sk_outrun_first_play_51", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000751:1:5", type: "series", file: "Show.S01E05.FirstPlay.mkv", alt: "ss9552@1:5" });
    const res = await realFetch(`${base}/${token}/download/ss9551/subtitle.srt?${query}`);
    const text = await res.text();
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The fallback as it came, not the special.
    expect(text).toContain(`\n#${fallbackLines.length}\n`);
    expect(text).not.toContain(`\n#${special.length}\n`);
    const row = stats.activityPage({ kind: "download", limit: 50 }).rows[0];
    expect(row.detail?.fallback).toBe("ss9552");
  }, 20000);

  it("reads Cinemeta's runtimes", async () => {
    const { runtimeOf } = await import("../src/cinemeta.js");
    expect(runtimeOf("24 min")).toBe(24 * 60000);
    expect(runtimeOf("1h 49min")).toBe(109 * 60000);
    expect(runtimeOf("2h")).toBe(120 * 60000);
    expect(runtimeOf("N/A")).toBeUndefined();
    expect(runtimeOf(undefined)).toBeUndefined();
  });

  it("tells a special or another cut from the file's own subtitles by how far its lines run", async () => {
    const { outrunsFile } = await import("../src/sync.js");
    const upTo = (minutes: number) => [{ start: 0, end: 1000 }, { start: minutes * 60000 - 2000, end: minutes * 60000 }];
    expect(outrunsFile(upTo(54.8), 24 * 60000)).toBe(true);
    expect(outrunsFile(upTo(24), 24 * 60000)).toBe(false);
    expect(outrunsFile(upTo(22.4), 24 * 60000)).toBe(false);
    // An extended cut runs longer, not one and a half times as long.
    expect(outrunsFile(upTo(150), 125 * 60000)).toBe(false);
    expect(outrunsFile(upTo(54.8), undefined)).toBe(false);
  });
});

describe("a subtitle whose lines end far short of the file", () => {
  /** A file whose length is known but whose readings need the stream (none are stored). */
  async function knownLength(filename: string) {
    await mkdir(path.join(process.cwd(), CACHE, "anchors"), { recursive: true });
    await writeFile(path.join(process.cwd(), CACHE, "anchors", `${cacheKey({ kind: "file-anchors", filename })}.json`), JSON.stringify({ filename, duration: 20 * 60000, windows: [], subtitleLangs: [] }));
  }
  // AIOStreams never answers (never): the sync is still under way at the download's deadline.
  const download = (token: string, ref: string, query: URLSearchParams) => realFetch(`${base}/${token}/download/${ref}/subtitle.srt?${query}`);
  /** The activity row of the download that sent this subtitle (a fallback's own ref when one was sent). */
  const resultOf = (ref: string) => stats.activityPage({ kind: "download", limit: 50 }).rows.find((r) => r.detail?.ref === ref);

  it("never stands in while its sync is under way: with no fallback, the line saying nothing fits goes out; a whole one still stands in", async () => {
    // Lines for 5 minutes of a 20-minute file, and lines for all of it.
    const short = dialogue(83, 5 * 60000);
    const whole = dialogue(89);
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9831\/download$/.test(url.pathname)) return new Response(srt(short));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9832\/download$/.test(url.pathname)) return new Response(srt(whole));
      if (url.hostname === "aiostreams.example.com") return never();
      return undefined;
    });
    await knownLength("Film.Short.mkv");
    const shortBefore = (await stats.statsView("t")).days[0]?.total["downloads.short"] ?? 0;
    const token = seal({ subsource: "sk_short_of_file_key_83", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", sv: "12", vid: "tt0000783", type: "movie", file: "Film.Short.mkv" });
    const [refused, standIn] = await Promise.all([download(token, "ss9831", query), download(token, "ss9832", query)]);
    const text = await refused.text();
    expect(text).toContain("no subtitle found for this track fits this file");
    expect(text.match(/ --> /g)).toHaveLength(1);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(resultOf("ss9831")?.result).toBe("another file's, not sent");
    expect((await stats.statsView("t")).days[0].total["downloads.short"]).toBe(shortBefore + 1);
    // Lines for the whole file stand in as they came, as before.
    expect((await standIn.text()).match(/ --> /g)).toHaveLength(whole.length);
    expect(standIn.headers.get("cache-control")).toBe("no-store");
    expect(resultOf("ss9832")?.result).toBe("unsynced stand-in");
  }, 30000);

  it("gives way to the first fallback that fits the file's length, as it came", async () => {
    const short = dialogue(97, 5 * 60000);
    const shortToo = dialogue(101, 8 * 60000);
    const whole = dialogue(103);
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9841\/download$/.test(url.pathname)) return new Response(srt(short));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9842\/download$/.test(url.pathname)) return new Response(srt(shortToo));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9843\/download$/.test(url.pathname)) return new Response(srt(whole));
      if (url.hostname === "aiostreams.example.com") return never();
      return undefined;
    });
    await knownLength("Film.ShortFallback.mkv");
    const token = seal({ subsource: "sk_short_fallback_key_84", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", sv: "12", vid: "tt0000784", type: "movie", file: "Film.ShortFallback.mkv", alt: "ss9842@:,ss9843@:" });
    const res = await download(token, "ss9841", query);
    const text = await res.text();
    // The second fallback, whole: the first ends far short of the file too.
    expect(text.match(/ --> /g)).toHaveLength(whole.length);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(resultOf("ss9843")?.result).toBe("unsynced stand-in");
    expect(resultOf("ss9843")?.detail?.fallback).toBe("ss9843");
  }, 30000);

  it("doesn't stand in for a subtitle that runs past the file either, when it was fetched to be synced first", async () => {
    // The listed one runs to an hour on a 20-minute file: another title's, so its fallbacks are tried at once.
    const long = dialogue(107, 60 * 60000);
    const short = dialogue(109, 5 * 60000);
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9876\/download$/.test(url.pathname)) return new Response(srt(long));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9877\/download$/.test(url.pathname)) return new Response(srt(short));
      if (url.hostname === "aiostreams.example.com") return never();
      return undefined;
    });
    await knownLength("Film.LongThenShort.mkv");
    const token = seal({ subsource: "sk_long_then_short_key_87", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", sv: "12", vid: "tt0000787", type: "movie", file: "Film.LongThenShort.mkv", alt: "ss9877@:" });
    const res = await download(token, "ss9876", query);
    const text = await res.text();
    // Neither the hour of lines nor the five minutes: the line saying nothing fits.
    expect(text).toContain("no subtitle found for this track fits this file");
    expect(text.match(/ --> /g)).toHaveLength(1);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 30000);

  it("tells another title's or a part's subtitles from the file's own by how far its lines reach", async () => {
    const { fallsShortOfFile } = await import("../src/sync.js");
    const upTo = (minutes: number) => [{ start: 0, end: 1000 }, { start: minutes * 60000 - 2000, end: minutes * 60000 }];
    expect(fallsShortOfFile(upTo(21.7), 172.6 * 60000)).toBe(true);
    // A film's subtitles on a file twice its length.
    expect(fallsShortOfFile(upTo(86), 172.6 * 60000)).toBe(true);
    // The file's own, ending before its credits.
    expect(fallsShortOfFile(upTo(21.8), 24.1 * 60000)).toBe(false);
    expect(fallsShortOfFile(upTo(54.4), 61.6 * 60000)).toBe(false);
    expect(fallsShortOfFile(upTo(24), 24 * 60000)).toBe(false);
    expect(fallsShortOfFile(upTo(5), undefined)).toBe(false);
    expect(fallsShortOfFile([], 24 * 60000)).toBe(false);
  });
});

describe("a subtitle the sync judged another file's", () => {
  it("isn't sent once nothing takes its place: one line saying so goes out, not kept; one merely unsynced goes as it came", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const sync = await import("../src/sync.js");
    const lines = "1\n00:00:05,000 --> 00:00:06,000\nA line of another episode.\n";
    await mkdir(path.join(CACHE, "subtitles"), { recursive: true });
    await mkdir(path.join(CACHE, "synced"), { recursive: true });
    const plant = async (id: number, result: Record<string, unknown>) => {
      const stored = path.resolve(CACHE, "subtitles", `${id}-1-7.srt`);
      await writeFile(stored, lines);
      await writeFile(path.join(CACHE, "synced", `${sync.syncKey(`ss${id}`, 1, 7, "Show.S01E07.Other.mkv")}.json`), JSON.stringify({ file: stored, anchors: [], filename: "Show.S01E07.Other.mkv", ...result }));
    };
    await plant(9811, { noFit: true });
    await plant(9812, {});
    sites(() => undefined);
    const token = seal({ subsource: "sk_not_this_file_key_81", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "7", sv: "12", vid: "tt0000781:1:7", type: "series", file: "Show.S01E07.Other.mkv" });
    const refused = await realFetch(`${base}/${token}/download/ss9811/subtitle.srt?${query}`);
    const text = await refused.text();
    expect(refused.status).toBe(200);
    expect(text).toContain("no subtitle found for this track fits this file");
    expect(text).not.toContain("A line of another episode.");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(stats.activityPage({ kind: "download", limit: 50 }).rows[0].result).toBe("another file's, not sent");
    // As ASS when the link is: a player reads the line either way.
    const asAss = await (await realFetch(`${base}/${token}/download/ss9811/subtitle.ass?${query}`)).text();
    expect(asAss).toContain("[Script Info]");
    expect(asAss).toContain("no subtitle found for this track fits this file");
    // Not timed, but not judged another's either: it goes as it came.
    const unsynced = await (await realFetch(`${base}/${token}/download/ss9812/subtitle.srt?${query}`)).text();
    expect(unsynced).toContain("A line of another episode.");
  }, 20000);
});

describe("sound descriptions taken out", () => {
  it("are left out of what is sent when the track's link asks, and kept otherwise", async () => {
    const text = ["1", "00:00:01,000 --> 00:00:02,000", "[door creaks]", "", "2", "00:00:03,000 --> 00:00:04,000", "JOHN: Hello there.", "", "3", "00:00:05,000 --> 00:00:06,000", "(laughs)", "", "4", "00:00:07,000 --> 00:00:08,000", "Bye.", ""].join("\n");
    sites((url) => (url.hostname === "api.subsource.net" && /\/subtitles\/9701\/download$/.test(url.pathname) ? new Response(text) : undefined));
    const token = seal({ subsource: "sk_sounds_download_012", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include", dropSounds: true });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", type: "series", sounds: "0" });
    const quiet = await (await realFetch(`${base}/${token}/download/ss9701/subtitle.srt?${query}`)).text();
    expect(quiet).toContain("Hello there.");
    expect(quiet).toContain("Bye.");
    for (const gone of ["[door creaks]", "JOHN:", "(laughs)"]) expect(quiet).not.toContain(gone);
    // The same times for what is left: the sync's timing is untouched.
    expect(quiet).toContain("00:00:03,000 --> 00:00:04,000");
    query.delete("sounds");
    const asCame = await (await realFetch(`${base}/${token}/download/ss9701/subtitle.srt?${query}`)).text();
    expect(asCame).toContain("[door creaks]");
    expect(asCame).toContain("JOHN: Hello there.");
  }, 15000);

  it("puts the switch in each track's link, so switching it is a new link to players", async () => {
    sites((url) => (url.hostname === "api.subdl.com" ? json({ status: true, subtitles: [{ url: "/subtitle/9702-1.zip", language: "AR", release_name: "Show S01E05", season: 1, episode: 5 }] }) : undefined));
    const on = await list({ subdl: "subdl_sounds_key_0018", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include", dropSounds: true }, "tt0000792:1:5");
    expect(new URL(on.subtitles[0].url).searchParams.get("sounds")).toBe("0");
    const off = await list({ subdl: "subdl_sounds_key_0019", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000793:1:5");
    expect(new URL(off.subtitles[0].url).searchParams.has("sounds")).toBe(false);
  }, 15000);
});

describe("a SubDL season upload that lacks the episode", () => {
  it("is left out by the files SubDL lists for it, without a download", async () => {
    const season = (id: string, release: string, files: string[]) => ({ url: `/subtitle/${id}.zip`, language: "AR", release_name: release, season: 3, episode: 0, full_season: true, episode_from: 0, episode_end: 0, unpack_files: files.map((name) => ({ name, season: 3, episode: 1 })) });
    const hits = sites((url) => {
      if (url.hostname === "api.subdl.com") {
        return json({
          status: true,
          subtitles: [
            // A "season pack" holding the first episode alone, and a real pack holding this one.
            season("9711-1", "Show.S03.WEB.Arabic", ["Show - S03E01.ar.srt"]),
            season("9712-1", "Show.S03.BD.Arabic", ["Show - S03E04.ar.srt", "Show - S03E05.ar.srt", "Show - S03E06.ar.srt"])
          ]
        });
      }
      return undefined;
    });
    const answer = await list({ subdl: "subdl_unpack_key_0017", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000741:3:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["sd9712-1"]);
    expect(hits.filter((h) => h.includes("dl.subdl.com"))).toHaveLength(0);
    expect(new URL(hits.find((h) => h.includes("api.subdl.com"))!).searchParams.get("unpack")).toBe("1");
  }, 15000);
});

describe("a season pack that numbers its files its own way", () => {
  it("finds the episode under another number by its timing, and sends that file synced", async () => {
    const lines = dialogue(43);
    const right = lines.map((c) => ({ start: c.start + 1500, end: c.end + 1500 }));
    // Its file numbered 5 is another episode; the episode playing is its 7 (a special counted first).
    const pack = new AdmZip();
    pack.addFile("Show.S01E05.Pack.srt", Buffer.from(srt(dialogue(47))));
    pack.addFile("Show.S01E06.Pack.srt", Buffer.from(srt(dialogue(53))));
    pack.addFile("Show.S01E07.Pack.srt", Buffer.from(srt(right)));
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9531\/download$/.test(url.pathname)) return new Response(new Uint8Array(pack.toBuffer()));
      return subsource(url, { arabic: [sub(9531, "Show S01 Complete", { language: "arabic", files: 3 })] }, {}, 131);
    });
    await fileWithTrack("Show.S01E05.PackNumbers.mkv", lines);
    const answer = await list({ subsource: "sk_pack_numbers_key_31", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000731:1:5", playing("Show.S01E05.PackNumbers.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9531"]);
    const link = new URL(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(link.searchParams.get("episode")).toBe("7");
    const download = await realFetch(link);
    expect(download.headers.get("cache-control")).toBe("public, max-age=3600, stale-if-error=2592000");
    const starts = [...(await download.text()).matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
    expect(starts).toHaveLength(right.length);
    expect(starts.filter((s, i) => Math.abs(s - lines[i].start) <= 100).length / starts.length).toBeGreaterThan(0.9);
  }, 20000);
});

describe("a pack's neighbouring files behind four other fallbacks", () => {
  it("are still tried at the download, and the one that fits is sent synced", async () => {
    const lines = dialogue(73);
    const right = lines.map((c) => ({ start: c.start + 1200, end: c.end + 1200 }));
    const pack = new AdmZip();
    pack.addFile("Show.S01E05.Pack.srt", Buffer.from(srt(dialogue(79))));
    pack.addFile("Show.S01E07.Pack.srt", Buffer.from(srt(right)));
    sites((url) => {
      if (url.hostname !== "api.subsource.net") return undefined;
      if (/\/subtitles\/9581\/download$/.test(url.pathname)) return new Response(new Uint8Array(pack.toBuffer()));
      const other = /\/subtitles\/(958[2-5])\/download$/.exec(url.pathname);
      return other ? new Response(srt(dialogue(Number(other[1])))) : undefined;
    });
    await fileWithTrack("Show.S01E05.Behind.mkv", lines);
    const token = seal({ subsource: "sk_pack_behind_key_81", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    // Four other uploads first, as a list puts them, then the pack's files beside its own.
    const alt = ["ss9582@1:5", "ss9583@1:5", "ss9584@1:5", "ss9585@1:5", "ss9581@1:6", "ss9581@1:4", "ss9581@1:7", "ss9581@1:3"].join(",");
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000781:1:5", type: "series", file: "Show.S01E05.Behind.mkv", alt });
    const res = await realFetch(`${base}/${token}/download/ss9581/subtitle.srt?${query}`);
    const starts = [...(await res.text()).matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
    expect(starts).toHaveLength(right.length);
    expect(starts.filter((s, i) => Math.abs(s - lines[i].start) <= 100).length / starts.length).toBeGreaterThan(0.9);
  }, 20000);
});

describe("the playing file's audio language", () => {
  const dubs = [9221, 9222].map((id) => sub(id, `Show S01E05 [Eng Dubbed Version] ${id}`, { downloads: 100 }));
  const regular = sub(9223, "Show S01E05 1080p WEB", { downloads: 50 });

  it("lists no dub captions on a file whose audio is all in another language, and the regular English instead", async () => {
    sites((url) => subsource(url, { english: [...dubs, regular] }, {}, 121) ?? cinemeta(url));
    await fileWithTrack("Show.S01E05.Original.mkv", dialogue(31), { audioLang: "jpn" });
    const answer = await list({ subsource: "sk_not_dubbed_key_21", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "tt0000721:1:5", playing("Show.S01E05.Original.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9223"]);
    expect(answer.subtitles[0].lang).not.toMatch(/dub|cc/i);
  });

  it("lists the dub captions on a file with English voices, as before", async () => {
    sites((url) => subsource(url, { english: [...dubs, regular] }, {}, 122) ?? cinemeta(url));
    await fileWithTrack("Show.S01E05.Dubbed.mkv", dialogue(37), { audioLang: "eng" });
    const answer = await list({ subsource: "sk_dubbed_audio_key_22", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include", perLanguage: 3 }, "tt0000722:1:5", playing("Show.S01E05.Dubbed.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9221", "ss9222"]);
  });

  it("reads the languages of a file's audio tracks: English, another language only, or not tagged", async () => {
    const { englishVoicesIn } = await import("../src/sync.js");
    expect(englishVoicesIn(["jpn"])).toBe(false);
    expect(englishVoicesIn(["jpn", "eng"])).toBe(true);
    expect(englishVoicesIn(["en"])).toBe(true);
    expect(englishVoicesIn(["jpn", "und"])).toBeUndefined();
    expect(englishVoicesIn([])).toBeUndefined();
  });
});

describe("signs & songs and the file's own style", () => {
  const SIGNS = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Sign,Gandhi Sans,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,8,20,20,40,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:03.00,0:00:06.00,Sign,,0,0,0,,{\\pos(960,120)}GUILD HALL",
    ""
  ].join("\n");

  it("puts both in English Dub's link, sent as ASS, and the file's style alone in every other track's", async () => {
    const dub = sub(9851, "Show S01E05 [Eng Dubbed Version]", { downloads: 100 });
    const regular = sub(9852, "Show S01E05 1080p WEB", { downloads: 50 });
    const arabic = sub(9853, "Show S01E05 1080p WEB", { language: "arabic" });
    sites((url) => subsource(url, { english: [dub, regular], arabic: [arabic] }, {}, 151) ?? cinemeta(url));
    await fileWithTrack("Show.S01E05.Signs.mkv", dialogue(51), { audioLang: "eng" });
    const answer = await list({ subsource: "sk_signs_style_key_51", aiostreams: AIO, languages: ["English", "English Subtitles", "Arabic"], allowMachine: false, hearingImpaired: "include", signs: true, ownStyle: true }, "tt0000851:1:5", playing("Show.S01E05.Signs.mkv"));
    const byRef = Object.fromEntries(answer.subtitles.map((t) => [refOfTrack(t), new URL(t.url)]));
    expect(byRef.ss9851.pathname.endsWith("/subtitle.ass")).toBe(true);
    expect([byRef.ss9851.searchParams.get("signs"), byRef.ss9851.searchParams.get("filestyle")]).toEqual(["1", "1"]);
    expect([byRef.ss9852.searchParams.has("signs"), byRef.ss9852.searchParams.get("filestyle")]).toEqual([false, "1"]);
    expect([byRef.ss9853.searchParams.has("signs"), byRef.ss9853.searchParams.get("filestyle"), byRef.ss9853.pathname.endsWith(".ass")]).toEqual([false, "1", true]);
  }, 20000);

  it("labels English Dub \"Signs\" once signs are found for the playing file, and only then", async () => {
    const dub = sub(9861, "Show S01E05 [Eng Dubbed Version]", { downloads: 100 });
    const regular = sub(9862, "Show S01E05 1080p WEB", { downloads: 50 });
    sites((url) => subsource(url, { english: [dub, regular] }, {}, 161) ?? cinemeta(url));
    await fileWithTrack("Show.S01E05.Labelled.mkv", dialogue(61), { audioLang: "eng" });
    const settings: Settings = { subsource: "sk_signs_label_key_61", aiostreams: AIO, languages: ["English", "English Subtitles"], allowMachine: false, hearingImpaired: "include", signs: true };
    const labelOf = (answer: Awaited<ReturnType<typeof list>>, ref: string) => answer.subtitles.find((t) => refOfTrack(t) === ref)?.label ?? "";
    const before = await list(settings, "tt0000861:1:5", playing("Show.S01E05.Labelled.mkv"));
    expect(labelOf(before, "ss9861")).not.toContain("Signs");
    await mkdir(path.join(process.cwd(), CACHE, "signs"), { recursive: true });
    await writeFile(
      path.join(process.cwd(), CACHE, "signs", `${cacheKey({ kind: "signs", videoId: "tt0000861:1:5", filename: "Show.S01E05.Labelled.mkv" })}.json`),
      JSON.stringify({ found: true, at: Date.now(), release: "[Group] Show - 05", signsName: "Signs & Songs", signs: "at1", partner: "at2", events: 1, script: SIGNS, settled: true })
    );
    const after = await list(settings, "tt0000861:1:5", playing("Show.S01E05.Labelled.mkv"));
    expect(labelOf(after, "ss9861")).toContain("Dub · ");
    expect(labelOf(after, "ss9861")).toContain(" · Signs · BttrSubs");
    // Regular English has no signs in its link, so its label doesn't say so.
    expect(labelOf(after, "ss9862")).not.toContain("Signs");
  }, 20000);

  it("leaves both out of a link that hasn't turned them on", async () => {
    const dub = sub(9854, "Show S01E05 [Eng Dubbed Version]", { downloads: 100 });
    sites((url) => subsource(url, { english: [dub] }, {}, 152) ?? cinemeta(url));
    await fileWithTrack("Show.S01E05.NoSigns.mkv", dialogue(52), { audioLang: "eng" });
    const answer = await list({ subsource: "sk_no_signs_key_0052", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "tt0000852:1:5", playing("Show.S01E05.NoSigns.mkv"));
    const url = new URL(answer.subtitles[0].url);
    expect([url.searchParams.has("signs"), url.searchParams.has("filestyle"), url.pathname.endsWith(".srt")]).toEqual([false, false, true]);
  }, 20000);

  it("sends English Dub with the signs found for the file, the dub's own copy of a sign left out", async () => {
    const dubText = ["1", "00:00:01,000 --> 00:00:02,000", "Here we are.", "", "2", "00:00:03,500 --> 00:00:05,000", "{\\an8}GUILD HALL", "", "3", "00:00:07,000 --> 00:00:08,000", "Let's go in.", ""].join("\n");
    sites((url) => (url.hostname === "api.subsource.net" && /\/subtitles\/9855\/download$/.test(url.pathname) ? new Response(dubText) : undefined));
    const file = "Show.S01E05.Merged.mkv/123456";
    const video = "tt0000853:1:5";
    await mkdir(path.join(process.cwd(), CACHE, "signs"), { recursive: true });
    await writeFile(path.join(process.cwd(), CACHE, "signs", `${cacheKey({ kind: "signs", videoId: video, filename: file })}.json`), JSON.stringify({ found: true, at: Date.now(), release: "[Group] Show - 05", signsName: "Signs & Songs", events: 1, script: SIGNS }));
    const token = seal({ subsource: "sk_signs_download_053", languages: ["English"], allowMachine: false, hearingImpaired: "include", signs: true });
    const query = new URLSearchParams({ season: "1", episode: "5", vid: video, type: "series", file, signs: "1" });
    const res = await realFetch(`${base}/${token}/download/ss9855/subtitle.ass?${query}`);
    const text = await res.text();
    expect(res.headers.get("content-type")).toMatch(/x-ssa/);
    expect(text).toContain("{\\pos(960,120)}GUILD HALL");
    expect(text).toContain(",BttrSubs Dub,,0,0,0,,Here we are.");
    expect(text).toContain(",BttrSubs Dub,,0,0,0,,Let's go in.");
    expect(text).not.toContain("{\\an8}GUILD HALL");
    expect(text).toMatch(/PlayResY: 1080/);
  }, 20000);

  it("sends a big script gzipped to a player that takes it, and as it is to one that doesn't", async () => {
    const big = Array.from({ length: 6000 }, (_, i) => `${i + 1}\n00:${String(Math.floor(i / 100) % 60).padStart(2, "0")}:${String(Math.floor(i / 2) % 60).padStart(2, "0")},000 --> 00:59:59,000\nLine ${i} of a long script, written out.\n`).join("\n");
    sites((url) => (url.hostname === "api.subsource.net" && /\/subtitles\/9857\/download$/.test(url.pathname) ? new Response(big) : undefined));
    const token = seal({ subsource: "sk_big_script_key_055", languages: ["English"], allowMachine: false, hearingImpaired: "include" });
    const zipped = await realFetch(`${base}/${token}/download/ss9857/subtitle.srt?season=1&episode=5`, { headers: { "accept-encoding": "gzip" } });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(await zipped.text()).toContain("Line 5999 of a long script");
    const plain = await realFetch(`${base}/${token}/download/ss9857/subtitle.srt?season=1&episode=5`, { headers: { "accept-encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect((await plain.text()).length).toBeGreaterThan(256 * 1024);
    // The activity says what was sent: its format, size, whether gzipped and whether the player may keep it.
    const sent = stats.activityPage({ kind: "download", limit: 5 }).rows.slice(0, 2).map((r) => r.detail?.sent);
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ format: "srt", gzip: true, kept: true }), expect.objectContaining({ format: "srt", kept: true })]));
    expect(sent.every((s) => (s?.bytes ?? 0) > 256 * 1024)).toBe(true);
  }, 20000);

  it("doesn't hold English Dub back more than 2 s for signs still being looked for, and isn't kept then", async () => {
    const { startSigns } = await import("../src/signsjob.js");
    const dubText = ["1", "00:00:01,000 --> 00:00:02,000", "First line.", ""].join("\n");
    sites((url) => {
      if (url.hostname === "feed.animetosho.net") return later(6000, () => json([]));
      return url.hostname === "api.subsource.net" && /\/subtitles\/9858\/download$/.test(url.pathname) ? new Response(dubText) : undefined;
    });
    const file = "Show.S01E05.Pending.mkv/1";
    const video = "tt0000855:1:5";
    startSigns({ request: { type: "series", id: video, imdbId: "tt0000855", season: 1, episode: 5 }, show: "Pending Show", aiostreamsUrl: AIO, videoId: video, type: "series", filename: file });
    const token = seal({ subsource: "sk_signs_pending_k_56", languages: ["English"], allowMachine: false, hearingImpaired: "include", signs: true });
    const started = Date.now();
    const res = await realFetch(`${base}/${token}/download/ss9858/subtitle.ass?${new URLSearchParams({ season: "1", episode: "5", vid: video, type: "series", file, signs: "1" })}`);
    const text = await res.text();
    expect(Date.now() - started).toBeLessThan(3500);
    expect(text).toContain("First line.");
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

  it("gives signs from a full track at once, and replaces them with a signs track found after them, timing no other full track", async () => {
    const { startSigns, readySigns } = await import("../src/signsjob.js");
    const t = (ms: number) => `${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(Math.floor(ms / 10) % 100).padStart(2, "0")}`;
    const script = (lines: Cue[], signs: string[]) =>
      [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,20,20,40,1",
        "Style: Sign,Gandhi Sans,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,8,20,20,40,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ...lines.map((c, i) => `Dialogue: 0,${t(c.start)},${t(c.end)},Default,,0,0,0,,#${i + 1}`),
        ...signs.map((text, i) => `Dialogue: 0,${t(60000 * (i + 2))},${t(60000 * (i + 2) + 3000)},Sign,,0,0,0,,{\\pos(960,120)}${text}`),
        ""
      ].join("\n");
    // The file's lines, and the releases' 2 s earlier.
    const lines = dialogue(87);
    const theirs = lines.map((c) => ({ start: c.start - 2000, end: c.end - 2000 }));
    const stored = path.join(process.cwd(), CACHE, "subtitles");
    await mkdir(stored, { recursive: true });
    const tracks: Record<number, string> = {
      681: script(theirs, ["FULL SIGN ONE", "FULL SIGN TWO"]),
      691: script(theirs, ["OTHER FULL SIGN"]),
      701: script([], ["TYPESET SIGN ONE", "TYPESET SIGN TWO", "TYPESET SIGN THREE"]),
      702: script(theirs, [])
    };
    for (const [n, text] of Object.entries(tracks)) await writeFile(path.join(stored, `at000f8${n}-1-5.ass`), text);
    const track = (n: number, name: string, extra: Record<string, unknown> = {}) => ({ type: "subtitle", url: `https://storage.animetosho.net/attachments/000f8/${n}.xz`, info: { name, language_code: "eng", format: "ASS", ...extra } });
    const rel = (id: number, title: string, attachments: unknown[]) => ({ id, title, status: "complete", files: [{ filename: `${title}.mkv`, info: { mediainfo: "" }, attachments }] });
    const releases = [
      rel(8681, "[Alpha] Upgrade Show - 05 [1080p]", [track(681, "Full Subtitles")]),
      rel(8682, "[Beta] Upgrade Show - 05 [1080p]", [track(691, "Full Subtitles")]),
      rel(8683, "[Gamma] Upgrade Show - 05 [1080p]", [track(701, "Signs & Songs", { forced: true }), track(702, "Dialogue")])
    ];
    sites((url) => {
      if (url.hostname !== "feed.animetosho.net") return undefined;
      if (url.pathname === "/api") return new Response(`<rss><channel>${releases.map((r) => `<item><title>${r.title}</title><guid>https://animetosho.net/view/${r.id}</guid><torznab:attr name="files" value="1"/></item>`).join("")}</channel></rss>`);
      if (url.searchParams.get("show") === "torrent") return json(releases.find((r) => r.id === Number(url.searchParams.get("id"))));
      return json([]);
    });
    const file = "Upgrade.Show.05.mkv";
    const video = "tt0000871:1:5";
    await fileWithTrack(file, lines);
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    try {
      startSigns({ request: { type: "series", id: video, imdbId: "tt0000871", season: 1, episode: 5 }, show: "Upgrade Show", aiostreamsUrl: AIO, videoId: video, type: "series", filename: file });
      const first = await readySigns(video, file, 15000);
      expect(first).toMatchObject({ release: "[Alpha] Upgrade Show - 05 [1080p]", signsName: "Full Subtitles", settled: false });
      let now = first;
      for (let i = 0; i < 150 && !(now && now !== "pending" && now.settled); i++) {
        await later(100, () => undefined);
        now = await readySigns(video, file, 0);
      }
      expect(now).toMatchObject({ release: "[Gamma] Upgrade Show - 05 [1080p]", signsName: "Signs & Songs", settled: true });
      const kept = JSON.parse(await readFile(path.join(process.cwd(), CACHE, "signs", `${cacheKey({ kind: "signs", videoId: video, filename: file })}.json`), "utf8"));
      expect(kept).toMatchObject({ release: "[Gamma] Upgrade Show - 05 [1080p]", events: 3, settled: true });
      // Moved as the dialogue beside it moved: 2 s later (to the centisecond ASS writes).
      expect(kept.script).toMatch(/0:02:02\.0[01],0:02:05\.0[01],Sign,,0,0,0,,\{\\pos\(960,120\)\}TYPESET SIGN ONE/);
      expect(logged.some((l) => l.includes("[Beta]"))).toBe(false);
    } finally {
      log.mockRestore();
    }
  }, 20000);

  it("sends English Dub with signs a signs track may still replace, and isn't kept then", async () => {
    const dubText = ["1", "00:00:01,000 --> 00:00:02,000", "Here we are.", ""].join("\n");
    sites((url) => (url.hostname === "api.subsource.net" && /\/subtitles\/9859\/download$/.test(url.pathname) ? new Response(dubText) : undefined));
    const file = "Show.S01E05.Unsettled.mkv/1";
    const video = "tt0000872:1:5";
    await mkdir(path.join(process.cwd(), CACHE, "signs"), { recursive: true });
    await writeFile(
      path.join(process.cwd(), CACHE, "signs", `${cacheKey({ kind: "signs", videoId: video, filename: file })}.json`),
      JSON.stringify({ found: true, at: Date.now(), release: "[Group] Show - 05", signsName: "Full Subtitles", signs: "at000f8699", partner: "at000f8699", events: 1, script: SIGNS })
    );
    const token = seal({ subsource: "sk_signs_unsettled_k57", languages: ["English"], allowMachine: false, hearingImpaired: "include", signs: true });
    const res = await realFetch(`${base}/${token}/download/ss9859/subtitle.ass?${new URLSearchParams({ season: "1", episode: "5", vid: video, type: "series", file, signs: "1" })}`);
    expect(await res.text()).toContain("{\\pos(960,120)}GUILD HALL");
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

  it("sends English Dub without signs, as ASS, when none were found for the file", async () => {
    const dubText = ["1", "00:00:01,000 --> 00:00:02,000", "Only words.", ""].join("\n");
    sites((url) => (url.hostname === "api.subsource.net" && /\/subtitles\/9856\/download$/.test(url.pathname) ? new Response(dubText) : undefined));
    const token = seal({ subsource: "sk_no_signs_found_054", languages: ["English"], allowMachine: false, hearingImpaired: "include", signs: true });
    const query = new URLSearchParams({ season: "1", episode: "5", vid: "tt0000854:1:5", type: "series", file: "Show.S01E05.None.mkv/1", signs: "1" });
    const text = await (await realFetch(`${base}/${token}/download/ss9856/subtitle.ass?${query}`)).text();
    expect(text).toContain("[Script Info]");
    expect(text).toContain("Only words.");
    expect(text).not.toContain("BttrSubs Dub");
  }, 20000);
});

describe("dub captions in a pack that turned out not to hold the episode", () => {
  it("don't count, so the regular English fallback is listed instead of nothing", async () => {
    const pack = sub(9801, "Show S02 English Dub SDH", { files: 2, hearingImpaired: true });
    const regular = sub(9802, "Show S02E02 1080p WEB");
    sites((url) => subsource(url, { english: [pack, regular] }, {}, 116) ?? cinemeta(url));
    const settings: Settings = { subsource: "sk_missing_pack_k_16", languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    expect((await list(settings, "tt0000716:2:2")).subtitles.map((t) => [refOfTrack(t), t.label])).toEqual([["ss9801", "Dub · BttrSubs"]]);
    // Opened (by a play): it holds episode 1 only.
    await mkdir(path.join(process.cwd(), CACHE, "subtitles"), { recursive: true });
    await writeFile(path.join(process.cwd(), CACHE, "subtitles", "9801-2-2.missing"), "");
    expect((await list(settings, "tt0000716:2:2")).subtitles.map((t) => [t.lang, refOfTrack(t), t.label])).toEqual([["English", "ss9802", "BttrSubs"]]);
  });
});

describe("the first list on a file timed by its own track", () => {
  it("waits for the syncs and lists the fallback that fits in place of the top pick that doesn't", async () => {
    const lines = dialogue(11);
    const right = lines.map((c) => ({ start: c.start - 1500, end: c.end - 1500 }));
    const wrong = dialogue(97);
    sites((url) =>
      subsource(
        url,
        { arabic: [sub(9301, "Show S01E05", { language: "arabic", commentary: "Netflix" }), sub(9302, "Show S01E05", { language: "arabic" })] },
        { "9301": srt(wrong), "9302": srt(right) },
        109
      )
    );
    await fileWithTrack("Show.S01E05.Index.mkv", lines);
    const answer = await list({ subsource: "sk_first_list_key_08", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000709:1:5", playing("Show.S01E05.Index.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9302"]);
    expect(answer.subtitles[0].label).toBe("Synced · BttrSubs");
    expect(answer.ms).toBeLessThan(5600);
    // Settled: kept the usual five minutes.
    expect(answer.cacheMaxAge).toBe(300);
    // The download serves it synced, from what the list already did.
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(download.headers.get("cache-control")).toBe("public, max-age=3600, stale-if-error=2592000");
    expect(await download.text()).toContain(`00:00:${String(Math.floor(lines[0].start / 1000) % 60).padStart(2, "0")}`);
  }, 20000);
});

describe("dub captions on a file whose English audio is still to be heard", () => {
  it("are listed and sent timed by the track, but not for the player to keep: the next request is timed by the voices", async () => {
    const lines = dialogue(12);
    // An upload that follows the track loosely: 1.2 s late at the start, creeping to 0.9 s by the end.
    // Captions that fit the track exactly, at one shift, would be the file's own and never moved onto
    // the voices (fitsOwnTrack), so they would need no audio heard.
    const late = (t: number) => 1200 - Math.round((300 * t) / (20 * 60000));
    const hits = sites((url) => subsource(url, { english: [sub(9311, "Show S01E05 [Eng Dubbed Version]")] }, { "9311": srt(lines.map((c) => ({ start: c.start + late(c.start), end: c.end + late(c.start) }))) }, 117) ?? cinemeta(url));
    // Timed from its index, with audio to hear: dub captions synced to it start the read in the background.
    await fileWithTrack("Show.S01E05.Dub.mkv", lines, { audio: 1 });
    const answer = await list({ subsource: "sk_dub_voices_key_17", aiostreams: AIO, languages: ["English"], allowMachine: false, hearingImpaired: "include" }, "tt0000717:1:5", playing("Show.S01E05.Dub.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9311"]);
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(download.status).toBe(200);
    expect(await download.text()).toContain(`00:00:${String(Math.floor(lines[0].start / 1000) % 60).padStart(2, "0")}`);
    expect(download.headers.get("cache-control")).toBe("no-store");
    // The activity keeps which subtitle went out, from where, and how it was timed.
    const listed = stats.activityPage({ kind: "list", limit: 50 }).rows[0];
    expect(listed.detail?.tracks).toEqual([{ lang: "English Dub", source: "SubSource", ref: "ss9311", release: "Show S01E05 [Eng Dubbed Version]", state: "synced" }]);
    const sent = stats.activityPage({ kind: "download", limit: 50 }).rows[0];
    expect(sent.detail).toMatchObject({ source: "SubSource", ref: "ss9311", timing: expect.stringMatching(/ ms/) });
    expect(sent.detail?.fit).toBeGreaterThan(50);
    expect(sent.detail?.windows).toBeGreaterThan(0);
    // The read looked the file's stream up in AIOStreams (once): it isn't listed here, so nothing was read.
    const { settled } = await import("../src/sync.js");
    await settled();
    expect(hits.filter((h) => h.includes("/stream/series/")).length).toBeGreaterThanOrEqual(1);
  }, 20000);
});

describe("a file whose link serves another listed release, the one under its name having failed", () => {
  it("is timed by that release's readings, and nothing read of it is kept under the played name", async () => {
    const FAILED = "Show - S01E05 - 005 [1080p][JA+EN]-TEAM";
    const NEXT = "Show.S01E05.1080p.BluRay.x265-CREW.mkv";
    const [listedSize, servedSize] = ["1986148202", "1443553666"];
    const lines = dialogue(27);
    const { fileRef, sameFileRef, settled } = await import("../src/sync.js");
    sites(
      (url) =>
        (url.hostname === "aiostreams.example.com" && url.pathname.includes("/stream/series/")
          ? json({ streams: [FAILED, NEXT].map((filename, i) => ({ url: `https://cdn.example.com/link/${i}`, behaviorHints: { filename } })) })
          : url.hostname === "cdn.example.com"
            ? // Whichever link is opened, the host serves the next release, and says so.
              new Response(new Uint8Array(1), { status: 206, headers: { "content-range": `bytes 0-0/${servedSize}`, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(NEXT)}` } })
            : undefined) ?? subsource(url, { arabic: [sub(9321, "Show S01E05 1080p BluRay")] }, { "9321": srt(lines.map((c) => ({ start: c.start + 700, end: c.end + 700 }))) }, 121)
    );
    // The next release's readings are there (it has been read before, or is read now); the played name has none.
    await fileWithTrack(fileRef(NEXT, servedSize), lines);
    const played = fileRef(FAILED, listedSize);
    const settings = { subsource: "sk_stand_in_key_0021", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    const answer = await list(settings, "tt0000721:1:5", `/filename=${encodeURIComponent(FAILED)}&videoSize=${listedSize}`);
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9321"]);
    // The list's own sync opens the link and finds what it serves.
    await settled();
    for (let waited = 0; waited < 5000 && (await sameFileRef(played)) === played; waited += 50) await later(50, () => undefined);
    expect(await sameFileRef(played)).toBe(fileRef(NEXT, servedSize));
    // The download, asked under the played name as the list wrote it, is timed by the served release's readings.
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(download.status).toBe(200);
    expect(await download.text()).toContain(`00:00:${String(Math.floor(lines[0].start / 1000) % 60).padStart(2, "0")}`);
    expect(stats.activityPage({ kind: "download", limit: 50 }).rows[0].result).toMatch(/^synced/);
    // Nothing read of it sits under the played name.
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(process.cwd(), CACHE, "anchors", `${cacheKey({ kind: "file-anchors", filename: played })}.json`))).toBe(false);
  }, 30000);

  it("lists a file AIOStreams doesn't list as one error, however many subtitles are synced to it", async () => {
    const lines = dialogue(29);
    sites(
      (url) =>
        (url.hostname === "aiostreams.example.com" && url.pathname.includes("/stream/series/") ? json({ streams: [] }) : undefined) ??
        subsource(url, { arabic: [sub(9391, "Show S01E05 1080p"), sub(9392, "Show S01E05 720p"), sub(9393, "Show S01E05 WEB")] }, Object.fromEntries(["9391", "9392", "9393"].map((id) => [id, srt(lines)])), 191)
    );
    const { settled } = await import("../src/sync.js");
    const before = stats.countedToday("errors.sync");
    const settings = { subsource: "sk_unlisted_once_key_91", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const, perLanguage: 3 };
    const answer = await list(settings, "tt0000792:1:5", `/filename=${encodeURIComponent("Show.S01E05.Never.Listed-TEAM")}&videoSize=1234567890`);
    expect(answer.subtitles.length).toBe(3);
    for (const track of answer.subtitles) {
      // Asked again on a 500: on Windows the list's sync can hold the subtitle's cached file open.
      let download = await realFetch(track.url.replace("https://sync.example", base));
      for (let again = 0; again < 3 && download.status === 500; again++) {
        await later(400, () => undefined);
        download = await realFetch(track.url.replace("https://sync.example", base));
      }
      expect(download.status).toBe(200);
    }
    await settled();
    expect(stats.countedToday("errors.sync") - before).toBe(1);
  }, 60000);
});

describe("a first list waiting on the file's header", () => {
  it("still takes a source that answers after the deadline, while the header read keeps the list open", async () => {
    sites((url) => {
      // AIOStreams asked for the file (the header read's first step); it never answers here, so the
      // list stays open to its grace.
      if (url.hostname === "aiostreams.example.com") return new Promise<Response>(() => undefined);
      if (url.hostname === "opensubtitles.stremio.homes") return later(4600, () => json({ subtitles: [{ sub_id: 9717, lang_code: "ar", title: "Show.S01E05.1080p.WEB" }] }));
      return undefined;
    });
    const answer = await list({ opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000717:1:5", playing("Show.S01E05.Open.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9717"]);
    expect(answer.ms).toBeGreaterThan(4500);
    expect(answer.ms).toBeLessThan(5800);
  }, 15000);
});

describe("a list whose time a slow source used up", () => {
  it("still times its tracks to the file before it answers, within its grace", async () => {
    const lines = dialogue(11);
    sites((url) => {
      // One source never answers: the list waits its whole time for it.
      if (url.hostname === "opensubtitles.stremio.homes") return new Promise<Response>(() => undefined);
      return subsource(url, { arabic: [sub(9661, "Show S01E05", { language: "arabic" })] }, { "9661": srt(lines.map((c) => ({ start: c.start - 900, end: c.end - 900 }))) }, 119);
    });
    await fileWithTrack("Show.S01E05.SlowSource.mkv", lines);
    const answer = await list({ subsource: "sk_slow_source_key_11", opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000791:1:5", playing("Show.S01E05.SlowSource.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9661"]);
    expect(answer.subtitles[0].label).toBe("Synced · BttrSubs");
    expect(answer.ms).toBeGreaterThan(3900);
    expect(answer.ms).toBeLessThan(5600);
  }, 15000);
});

describe("SubDL's daily downloads", () => {
  const subdlSearch = (id: string) => (url: URL) => {
    if (url.hostname === "api.subdl.com") return json({ status: true, subtitles: [{ url: `/subtitle/${id}.zip`, language: "AR", release_name: "Show S01E05", season: 1, episode: 5 }] });
    if (url.hostname === "dl.subdl.com") return new Response(srt(dialogue(11).map((c) => ({ start: c.start - 700, end: c.end - 700 }))));
    return undefined;
  };

  it("are used by a list's syncs while plenty are left", async () => {
    const hits = sites(subdlSearch("9401-1"));
    await fileWithTrack("Show.S01E05.Quota1.mkv", dialogue(11));
    await list({ subdl: "subdl_plenty_key_0009", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000710:1:5", playing("Show.S01E05.Quota1.mkv"));
    await later(300, () => undefined);
    expect(hits.filter((h) => h.includes("dl.subdl.com"))).toHaveLength(1);
  });

  it("aren't spent by a list once only the last ten are left", async () => {
    const key = "subdl_spent_key_0010";
    for (let i = 0; i < 40; i++) stats.noteKeyCall("subdl", key, undefined, true);
    const hits = sites(subdlSearch("9402-1"));
    await fileWithTrack("Show.S01E05.Quota2.mkv", dialogue(11));
    const answer = await list({ subdl: key, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000711:1:5", playing("Show.S01E05.Quota2.mkv"));
    await later(300, () => undefined);
    expect(answer.subtitles.map(refOfTrack)).toEqual(["sd9402-1"]);
    expect(hits.filter((h) => h.includes("dl.subdl.com"))).toHaveLength(0);
    // A player asking for it still gets it.
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(download.status).toBe(200);
    expect(hits.filter((h) => h.includes("dl.subdl.com"))).toHaveLength(1);
  });
});

describe("the playing file's header", () => {
  it("is read from the start of a list, beside the searches, not after them", async () => {
    const started = Date.now();
    let asked: number | undefined;
    sites((url) => {
      // AIOStreams asked for the file (the header read's first step); it never answers here.
      if (url.hostname === "aiostreams.example.com") {
        asked ??= Date.now() - started;
        return new Promise<Response>(() => undefined);
      }
      if (url.hostname === "opensubtitles.stremio.homes") return later(3000, () => json({ subtitles: [{ sub_id: 9701, lang_code: "ar", title: "Show.S01E05.1080p.WEB" }] }));
      return undefined;
    });
    const answer = await list({ opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000714:1:5", playing("Show.S01E05.Header.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9701"]);
    expect(asked).toBeDefined();
    expect(asked!).toBeLessThan(1000);
  }, 15000);
});

describe("a link that keeps ASS styling", () => {
  const assTime = (ms: number) => `${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 10)).padStart(2, "0")}`;
  // A fansub script whose lines sit raised (MarginV 145), as one over burned-in text does.
  const ass = (cues: Cue[]) =>
    ["[Script Info]", "ScriptType: v4.00+", "PlayResY: 1080", "", "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV", "Style: Raised,Arial,60,&H00FFFFFF,0,0,2,10,10,145", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...cues.map((c, i) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Raised,,0,0,0,,#${i + 1}`)].join("\n");

  it("lists a subtitle stored as ASS under a .ass link and sends it as ASS, styles kept; off, as SRT", async () => {
    const lines = dialogue(41);
    const right = lines.map((c) => ({ start: c.start - 1500, end: c.end - 1500 }));
    sites((url) => subsource(url, { arabic: [sub(9411, "Show S01E05", { language: "arabic" })] }, { "9411": ass(right) }, 141));
    await fileWithTrack("Show.S01E05.Ass.mkv", lines);
    const settings = { subsource: "sk_keep_ass_key_41", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    const on = await list({ ...settings, keepAss: true }, "tt0000741:1:5", playing("Show.S01E05.Ass.mkv"));
    expect(on.subtitles.map(refOfTrack)).toEqual(["ss9411"]);
    expect(new URL(on.subtitles[0].url).pathname).toMatch(/\/subtitle\.ass$/);
    const sent = await realFetch(on.subtitles[0].url.replace("https://sync.example", base));
    expect(sent.headers.get("content-type")).toMatch(/^text\/x-ssa/);
    expect(sent.headers.get("content-disposition")).toMatch(/\.ass"$/);
    const body = await sent.text();
    expect(body).toContain("Style: Raised,Arial,60,&H00FFFFFF,0,0,2,10,10,145");
    // Synced: the first line moved onto the file's.
    expect(body).toContain(`Dialogue: 0,${assTime(lines[0].start)},`);

    // The same subtitle on a link without the switch: an SRT link and SRT, as before.
    const off = await list(settings, "tt0000741:1:5", playing("Show.S01E05.Ass.mkv"));
    expect(new URL(off.subtitles[0].url).pathname).toMatch(/\/subtitle\.srt$/);
    const plain = await realFetch(off.subtitles[0].url.replace("https://sync.example", base));
    expect(plain.headers.get("content-type")).toMatch(/^text\/plain/);
    const srtBody = await plain.text();
    expect(srtBody).not.toContain("[Script Info]");
    expect(srtBody).toMatch(/^1\n\d\d:\d\d:\d\d,\d{3} --> /);
  }, 20000);
});

describe("a raised show", () => {
  it("lists every subtitle of the show under a .ass link with its height, and sends an SRT upload as ASS placed that high; other shows as before", async () => {
    const lines = dialogue(42);
    const right = lines.map((c) => ({ start: c.start - 1500, end: c.end - 1500 }));
    sites((url) => subsource(url, { arabic: [sub(9421, "Show S01E05", { language: "arabic" })] }, { "9421": srt(right) }, 142));
    await fileWithTrack("Show.S01E05.Raised.mkv", lines);
    const settings = { subsource: "sk_raise_show_key_42", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const, raise: [{ id: "tt0000742", name: "Show (2022)", percent: 15 }] };
    const raised = await list(settings, "tt0000742:1:5", playing("Show.S01E05.Raised.mkv"));
    expect(raised.subtitles.map(refOfTrack)).toEqual(["ss9421"]);
    const link = new URL(raised.subtitles[0].url);
    expect(link.pathname).toMatch(/\/subtitle\.ass$/);
    expect(link.searchParams.get("raise")).toBe("15");
    const sent = await realFetch(raised.subtitles[0].url.replace("https://sync.example", base));
    expect(sent.headers.get("content-type")).toMatch(/^text\/x-ssa/);
    const body = await sent.text();
    // 15% of the script's 288: 43.
    expect(body).toMatch(/^Style: Default,.*,2,10,10,43,1$/m);
    expect(body).toContain(`Dialogue: 0,0:00:${String(Math.floor(lines[0].start / 1000) % 60).padStart(2, "0")}.`);

    // Another show on the same link: an SRT link, sent as SRT.
    const other = await list(settings, "tt0000743:1:5", playing("Show.S01E05.Raised.mkv"));
    for (const track of other.subtitles) {
      expect(new URL(track.url).pathname).toMatch(/\/subtitle\.srt$/);
      expect(new URL(track.url).searchParams.get("raise")).toBeNull();
    }
  }, 20000);

  it("sets subtitles per language on the configure page: kept from the form, prefilled when edited, never offered past the server's most", async () => {
    const { saveConfiguration } = await import("../src/configure.js");
    const { setupState } = await import("../src/page.js");
    const { config } = await import("../src/config.js");
    const form = { aiostreams: "", languages: ["Arabic"], opensubtitles: true, allowMachine: false, hearingImpaired: "include" as const };
    const current: Settings = { opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" };
    const settingsOf = (r: Awaited<ReturnType<typeof saveConfiguration>>) => ("settings" in r ? r.settings : r);
    expect(settingsOf(await saveConfiguration({ ...form, perLanguage: 2 }, current))).toMatchObject({ perLanguage: 2 });
    // One is what a configuration without it means, so it isn't kept.
    expect("perLanguage" in settingsOf(await saveConfiguration({ ...form, perLanguage: 1 }, current))).toBe(false);
    expect(settingsOf(await saveConfiguration({ ...form, perLanguage: 4 }, current))).toMatchObject({ error: expect.stringMatching(/Subtitles per language/) });
    // The page starts from the configuration's own, and stops at what this server allows.
    expect(setupState(undefined).current).toBeNull();
    expect(setupState(current).current?.perLanguage).toBe(1);
    expect(setupState({ ...current, perLanguage: 3 }).current?.perLanguage).toBe(3);
    const before = config.maxPerLanguage;
    try {
      for (const most of [1, 2, 3]) {
        config.maxPerLanguage = most;
        expect(setupState(undefined).limits.perLanguageMax).toBe(most);
      }
    } finally {
      config.maxPerLanguage = before;
    }
    // The form sends the configuration's own number, so a server that lists fewer for now doesn't overwrite it; the page
    // shows what the server lists of it, and the review says it when it isn't one.
    const { readFileSync } = await import("node:fs");
    const setup = readFileSync(new URL("../assets/ui/setup.js", import.meta.url), "utf8");
    expect(setup).toContain("perLanguage: Number(st.per) || 1,");
    expect(setup).toContain("per: C?.perLanguage ?? 1,");
    expect(setup).toContain("const perOf = () => Math.min(Number(st.per) || 1, S.limits.perLanguageMax);");
    expect(setup).toContain('perOf() > 1 ? `${perOf()} per language` : ""');
  });

  it("is added on the configure page as a style, by its IMDb id or a link holding one, under Cinemeta's name; the page sends the styles whole", async () => {
    sites((url) => (url.hostname !== "v3-cinemeta.strem.io" ? undefined : url.pathname === "/meta/series/tt0000761.json" ? json({ meta: { name: "Show", year: "2022–" } }) : json({ meta: null })));
    const { checkStep, saveConfiguration } = await import("../src/configure.js");
    // Moved up before styles existed: it reads as a one-show style.
    const current: Settings = { opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include", raise: [{ id: "tt0000762", name: "Film (2020)", percent: 20 }] };
    expect(await checkStep("style", { styles: [{ scope: "show", id: "https://www.imdb.com/title/tt0000761/", up: "18" }] }, current)).toEqual({ ok: true });
    expect(await checkStep("style", { styles: [{ scope: "show", id: "Show", up: "15" }] }, current)).toEqual({ error: "Styles: paste the show's IMDb link, or its id (tt…)" });
    expect(await checkStep("style", { styles: [{ scope: "show", id: "tt0000769", up: "15" }] }, current)).toEqual({ error: "Styles: Cinemeta doesn't know tt0000769. Check the IMDb id" });
    expect(await checkStep("style", { styles: [{ scope: "show", id: "tt0000761", up: "0" }] }, current)).toEqual({ error: "Styles: how far up must be 1 to 80%" });
    expect(await checkStep("style", { styles: [{ scope: "anime", look: "neon" }] }, current)).toEqual({ error: "Styles: that look isn't one this server can draw" });
    expect(await checkStep("style", { styles: [{ scope: "anime", look: "yellow_w9" }] }, current)).toEqual({ error: "Styles: that look isn't one this server can draw" });
    expect(await checkStep("style", { styles: [{ scope: "anime", look: "anime_o0000ff_w2.4" }] }, current)).toEqual({ ok: true });
    expect(await checkStep("style", { styles: [{ scope: "everything", up: "10" }] }, current)).toEqual({ error: "Styles: each is for every subtitle, anime, series, films or one show" });
    const form = { aiostreams: "", languages: ["Arabic"], opensubtitles: true, allowMachine: false, hearingImpaired: "include" as const };
    const settingsOf = (r: Awaited<ReturnType<typeof saveConfiguration>>) => ("settings" in r ? r.settings : r);
    // The show already there keeps its name with nothing looked up; a new one gets Cinemeta's; a style that sets nothing is left out.
    const saved = settingsOf(await saveConfiguration({ ...form, styles: [{ scope: "show", id: "tt0000762", up: "25" }, { scope: "show", id: "stremio:///detail/series/tt0000761", look: "yellow" }, { scope: "anime", look: "bold", up: "" }, { scope: "all", look: "", up: "" }] }, current));
    expect(saved).toMatchObject({
      styles: [
        { scope: "show", id: "tt0000762", name: "Film (2020)", up: 25 },
        { scope: "show", id: "tt0000761", name: "Show (2022)", look: "yellow" },
        { scope: "anime", look: "bold" }
      ]
    });
    expect("raise" in saved).toBe(false);
    // A second style for a place replaces the first.
    expect(settingsOf(await saveConfiguration({ ...form, styles: [{ scope: "anime", look: "bold" }, { scope: "anime", look: "boxed", up: "12" }] }, current))).toMatchObject({ styles: [{ scope: "anime", look: "boxed", up: 12 }] });
    // Without a list the saved ones stay, the show moved up before among them; an empty list keeps none.
    expect(settingsOf(await saveConfiguration(form, current))).toMatchObject({ styles: [{ scope: "show", id: "tt0000762", name: "Film (2020)", up: 20 }] });
    expect("styles" in settingsOf(await saveConfiguration({ ...form, styles: [] }, current))).toBe(false);
  });
});

describe("styles", () => {
  it("give a title the most specific style's look and height: one show, then anime, then series or films, then everything", async () => {
    const { styleFor } = await import("../src/profile.js");
    const rules: Settings["styles"] = [{ scope: "all", look: "white" }, { scope: "series", up: 10 }, { scope: "anime", look: "bold" }, { scope: "show", id: "tt0000801", name: "Show", up: 20 }];
    expect(styleFor(rules!, { imdbId: "tt0000900", type: "movie" })).toEqual({ look: "white", up: undefined });
    expect(styleFor(rules!, { imdbId: "tt0000900", type: "series" })).toEqual({ look: "white", up: 10 });
    expect(styleFor(rules!, { imdbId: "tt0000900", type: "series", anime: true })).toEqual({ look: "bold", up: 10 });
    expect(styleFor(rules!, { imdbId: "tt0000801", type: "series", anime: true })).toEqual({ look: "bold", up: 20 });
    expect(styleFor([], { imdbId: "tt0000801", type: "series" })).toEqual({ look: undefined, up: undefined });
    // A style for the track's language comes before any for every language, then the most specific place.
    const spoken: Settings["styles"] = [{ scope: "anime", look: "bold", up: 10 }, { scope: "all", lang: "Arabic", look: "large" }, { scope: "series", lang: "Arabic", up: 20 }];
    expect(styleFor(spoken!, { imdbId: "tt0000900", type: "series", anime: true }, "Arabic")).toEqual({ look: "large", up: 20 });
    expect(styleFor(spoken!, { imdbId: "tt0000900", type: "series", anime: true }, "arabic")).toEqual({ look: "large", up: 20 });
    expect(styleFor(spoken!, { imdbId: "tt0000900", type: "series", anime: true }, "English")).toEqual({ look: "bold", up: 10 });
    expect(styleFor(spoken!, { imdbId: "tt0000900", type: "movie" }, "Arabic")).toEqual({ look: "large", up: undefined });
    expect(styleFor(spoken!, { imdbId: "tt0000900", type: "series", anime: true })).toEqual({ look: "bold", up: 10 });
  });

  it("draw a plain subtitle in the look, and keep an upload's own styling only when the link says so", async () => {
    const { toAss } = await import("../src/srt.js");
    const plain = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
    // The usual height, which the page starts at, is where unmoved lines sit: 4%, 12 of 288.
    const { USUAL_UP } = await import("../src/srt.js");
    expect(USUAL_UP).toBe(4);
    expect(toAss(plain, ".srt", USUAL_UP)).toBe(toAss(plain, ".srt"));
    // No look: the plain style, as before styles.
    expect(toAss(plain, ".srt")).toMatch(/^Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0\.5,2,10,10,12,1$/m);
    expect(toAss(plain, ".srt", undefined, "yellow")).toMatch(/^Style: Default,Arial,20,&H0000FFFF,/m);
    // Anime streaming: Trebuchet MS 24 on a 360-high script, outline 2, shadow 1, 18 up, scaled to 288; a height moves it.
    expect(toAss(plain, ".srt", undefined, "anime")).toMatch(/^Style: Default,Trebuchet MS,19\.2,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1\.6,0\.8,2,10,10,14,1$/m);
    expect(toAss(plain, ".srt", 4, "anime")).toMatch(/^Style: Default,Trebuchet MS,19\.2,.*,2,10,10,12,1$/m);
    const { LOOKS, usualUpOf } = await import("../src/srt.js");
    expect(usualUpOf(LOOKS.anime)).toBe(5);
    expect(usualUpOf(LOOKS.yellow)).toBe(USUAL_UP);
    // A look with changes: the preset's style with each change on it; a box is half see-through.
    expect(toAss(plain, ".srt", undefined, "yellow_o0000ff_w2.4_h0_ftrebuchet_z120_b1")).toMatch(/^Style: Default,Trebuchet MS,24,&H0000FFFF,&H000000FF,&H00FF0000,&H80000000,-1,0,0,0,100,100,0,0,1,2\.4,0,2,10,10,12,1$/m);
    expect(toAss(plain, ".srt", undefined, "plain_x1_o202020")).toMatch(/^Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H80202020,&H80000000,0,0,0,0,100,100,0,0,3,1,0\.5,2,10,10,12,1$/m);
    expect(toAss(plain, ".srt", undefined, "boxed_x0")).toMatch(/^Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,12,1$/m);
    // Italic, space between the letters, at the top; a box as solid as asked, half when it isn't.
    expect(toAss(plain, ".srt", undefined, "yellow_i1_s1.5_t1")).toMatch(/^Style: Default,Arial,20,&H0000FFFF,&H000000FF,&H00000000,&H80000000,0,-1,0,0,100,100,1.5,0,1,1.6,0.6,8,10,10,12,1$/m);
    expect(toAss(plain, ".srt", undefined, "plain_x1_k100")).toMatch(/^Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,/m);
    expect(toAss(plain, ".srt", undefined, "plain_x1_k20")).toMatch(/^Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&HCC000000,/m);
    expect(toAss(plain, ".srt", undefined, "plain_x1_k50")).toBe(toAss(plain, ".srt", undefined, "plain_x1"));
    // A font named by hand, a + for each space; not beside one from the list, and nothing that would end the style row.
    expect(toAss(plain, ".srt", undefined, "plain_gNoto+Sans")).toMatch(/^Style: Default,Noto Sans,20,/m);
    expect(toAss(plain, ".srt", undefined, "yellow_gDejaVu+Sans+Mono_b1")).toMatch(/^Style: Default,DejaVu Sans Mono,20,&H0000FFFF,.*,-1,0,0,0,100,100,0,0,1,/m);
    for (const bad of ["plain_gA,B", "plain_g", "plain_g+Sans", "plain_gSans!", `plain_g${"a".repeat(41)}`, "plain_farial_gNoto"]) expect(toAss(plain, ".srt", undefined, bad), bad).toBe(toAss(plain, ".srt"));
    // A size is the preset's share, and the preset's own height stays; a change to its own value changes nothing.
    expect(toAss(plain, ".srt", undefined, "anime_z125")).toMatch(/^Style: Default,Trebuchet MS,24,.*,2,10,10,14,1$/m);
    expect(toAss(plain, ".srt", undefined, "anime_cffffff")).toBe(toAss(plain, ".srt", undefined, "anime"));
    // Anything else names no look: no changes on the plain style, an unknown letter or font, a value out of range or
    // written otherwise, a letter twice, too many changes, an unknown preset.
    const { lookOf } = await import("../src/srt.js");
    for (const bad of ["plain", "yellow_q1", "yellow_c12345g", "yellow_cFFFFFF", "yellow_w4.5", "yellow_w1.25", "yellow_fcomic", "yellow_z60", "yellow_z160", "yellow_b2", "yellow_c000000_c111111", "nope_c000000", "yellow_", "yellow_c000000_o000000_w1_h1_ftrebuchet_z100_b1_x1_c1"]) expect(lookOf(bad), bad).toBeUndefined();
    expect(toAss(plain, ".srt", undefined, "yellow_q1")).toBe(toAss(plain, ".srt"));
    const own = [
      "[Script Info]", "PlayResY: 360", "", "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Signs,Placeholder Font,30,&H00FF00FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1", "", "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Signs,,0,0,0,,{\\i1}Hello", ""
    ].join("\n");
    expect(toAss(own, ".ass", undefined, "boxed", true)).toBe(own);
    const flat = toAss(own, ".ass", undefined, "boxed", false);
    expect(flat).toMatch(/^Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,3,2,0,2,10,10,12,1$/m);
    expect(flat).toContain(",Default,,0,0,0,,Hello");
    expect(flat).not.toContain("Placeholder Font");
    // An unknown look is no look: the upload keeps its own.
    expect(toAss(own, ".ass", undefined, "neon", false)).toBe(own);
  });

  it("put a title's look and height in its links, which the download draws", async () => {
    const lines = dialogue(43);
    const right = lines.map((c) => ({ start: c.start - 1500, end: c.end - 1500 }));
    sites((url) => subsource(url, { arabic: [sub(9431, "Show S01E06", { language: "arabic" })] }, { "9431": srt(right) }, 143));
    await fileWithTrack("Show.S01E06.Styled.mkv", lines);
    const plainSettings = { subsource: "sk_style_show_key_43", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    const styled = await list({ ...plainSettings, styles: [{ scope: "series" as const, look: "yellow", up: 12 }] }, "tt0000744:1:6", playing("Show.S01E06.Styled.mkv"));
    const link = new URL(styled.subtitles[0].url);
    expect(link.pathname).toMatch(/\/subtitle\.ass$/);
    expect([link.searchParams.get("look"), link.searchParams.get("raise"), link.searchParams.get("own")]).toEqual(["yellow", "12", null]);
    const body = await (await realFetch(styled.subtitles[0].url.replace("https://sync.example", base))).text();
    // 12% of the script's 288: 35.
    expect(body).toMatch(/^Style: Default,Arial,20,&H0000FFFF,.*,2,10,10,35,1$/m);
    // A look with changes of its own goes through the link and is drawn too: a blue outline, 2.4 wide.
    const changed = await list({ ...plainSettings, styles: [{ scope: "series" as const, look: "yellow_o0000ff_w2.4" }] }, "tt0000744:1:6", playing("Show.S01E06.Styled.mkv"));
    expect(new URL(changed.subtitles[0].url).searchParams.get("look")).toBe("yellow_o0000ff_w2.4");
    const drawn = await (await realFetch(changed.subtitles[0].url.replace("https://sync.example", base))).text();
    expect(drawn).toMatch(/^Style: Default,Arial,20,&H0000FFFF,&H000000FF,&H00FF0000,&H80000000,0,0,0,0,100,100,0,0,1,2\.4,/m);
    // A look that names nothing this server draws is no look: the plain style.
    const unknown = new URL(changed.subtitles[0].url.replace("https://sync.example", base));
    unknown.searchParams.set("look", "yellow_q1");
    expect(await (await realFetch(unknown)).text()).toMatch(/^Style: Default,Arial,20,&H00FFFFFF,/m);
    // A style for films isn't for a series: its links stay SRT.
    const films = await list({ ...plainSettings, styles: [{ scope: "movie" as const, look: "yellow" }] }, "tt0000744:1:6", playing("Show.S01E06.Styled.mkv"));
    for (const track of films.subtitles) expect(new URL(track.url).pathname).toMatch(/\/subtitle\.srt$/);
    // A style for one language is for that language's tracks only.
    const mine = await list({ ...plainSettings, styles: [{ scope: "all" as const, lang: "Arabic", look: "large" }] }, "tt0000744:1:6", playing("Show.S01E06.Styled.mkv"));
    expect(new URL(mine.subtitles[0].url).searchParams.get("look")).toBe("large");
    const others = await list({ ...plainSettings, styles: [{ scope: "all" as const, lang: "Dutch", look: "large" }] }, "tt0000744:1:6", playing("Show.S01E06.Styled.mkv"));
    expect(new URL(others.subtitles[0].url).pathname.endsWith("/subtitle.srt")).toBe(true);
    // With Keep the subtitle's own styling, a look leaves an upload's own styling be.
    const kept = await list({ ...plainSettings, keepAss: true, styles: [{ scope: "all" as const, look: "boxed" }] }, "tt0000744:1:6", playing("Show.S01E06.Styled.mkv"));
    expect(new URL(kept.subtitles[0].url).searchParams.get("own")).toBe("1");
  }, 20000);
});

describe("the playing file's own hash, when the player sends none", () => {
  it("is worked out once from two 64 KB reads, and the lists after it ask OpenSubtitles with it", async () => {
    const size = 500_000;
    const byte = (i: number) => (i * 7 + (i >> 9)) & 0xff;
    const reads: string[] = [];
    const v3plus: string[] = [];
    const { openSubtitlesHash, HASH_CHUNK } = await import("../src/oshash.js");
    const slice = (from: number, to: number) => Uint8Array.from({ length: to - from + 1 }, (_, k) => byte(from + k));
    const hash = openSubtitlesHash(slice(0, HASH_CHUNK - 1), slice(size - HASH_CHUNK, size - 1), size)!;
    const hits = sites((url, init) => {
      if (url.hostname === "aiostreams.example.com" && url.pathname.includes("/stream/series/")) {
        return json({ streams: [{ url: "https://cdn.example.com/f/Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv", behaviorHints: { filename: "Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv" } }] });
      }
      if (url.hostname === "cdn.example.com") {
        const range = new Headers(init?.headers).get("range") ?? "";
        reads.push(range);
        const [from, to] = range.replace("bytes=", "").split("-").map(Number);
        return new Response(slice(from, Math.min(to, size - 1)), { status: 206, headers: { "content-range": `bytes ${from}-${Math.min(to, size - 1)}/${size}` } });
      }
      if (url.hostname === "opensubtitles.stremio.homes") {
        v3plus.push(url.pathname);
        return json({ subtitles: [
          { sub_id: 9811, lang_code: "ar", title: "Show.S01E06.HDTV-OTHER" },
          { sub_id: 9812, lang_code: "ar", title: "Show.S01E06.1080p.AMZN.WEB-DL-TEAM" }
        ] });
      }
      // Stremio's own addon marks the upload it matched by the file's hash.
      if (url.hostname === "opensubtitles-v3.strem.io") {
        const byHash = url.pathname.includes(`videoHash=${hash}`);
        return json({ subtitles: [{ id: 9811, url: "https://subs.example.com/9811", lang: "ara", m: byHash ? "h" : "i", movieReleaseName: "Show.S01E06.HDTV-OTHER" }] });
      }
      return undefined;
    });
    await fileWithTrack("Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv", dialogue(31));
    const settings = { opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    const first = await list(settings, "tt0000731:1:6", playing("Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv"));
    // Before the hash: the upload named for this release ranks first.
    expect(first.subtitles.map(refOfTrack)).toEqual(["osar-9812"]);
    // Worked out in the background: nothing waits on it.
    const { storedFileHash } = await import("../src/sync.js");
    for (let waited = 0; waited < 3000 && !(await storedFileHash("Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv")); waited += 20) await new Promise((r) => setTimeout(r, 20));
    expect(await storedFileHash("Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv")).toEqual({ hash, size });
    // The redirect check, then the start and the end: 64 KB each.
    expect(reads).toEqual(["bytes=0-0", `bytes=0-${HASH_CHUNK - 1}`, `bytes=${size - HASH_CHUNK}-${size - 1}`]);
    const second = await list(settings, "tt0000731:1:6", playing("Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv"));
    // V3+ doesn't match by hash: asked as before. Stremio's own addon is asked with the hash.
    expect(v3plus.every((p) => !p.includes("videoHash"))).toBe(true);
    expect(hits.some((h) => h.startsWith("https://opensubtitles-v3.strem.io/subtitles/series/") && h.includes(`videoHash=${hash}&videoSize=${size}`))).toBe(true);
    // Named for another release, but made for this very file: it ranks first now, as V3+'s own copy
    // of it (the same OpenSubtitles id), so V3+'s flags still apply.
    expect(second.subtitles.map(refOfTrack)).toEqual(["osar-9811"]);
    // Read once: a third list reads nothing more.
    await list(settings, "tt0000731:1:6", playing("Show.S01E06.1080p.AMZN.WEB-DL-TEAM.mkv"));
    await new Promise((r) => setTimeout(r, 100));
    expect(reads).toHaveLength(3);
  }, 20000);
});

describe("a download server that refuses this server", () => {
  it("gets no request while its reads are paused, and the service's other servers are read as usual", async () => {
    const { noteRefusal, resetReads } = await import("../src/reads.js");
    resetReads();
    const size = 500_000;
    const byte = (i: number) => (i * 5 + (i >> 8)) & 0xff;
    const slice = (from: number, to: number) => Uint8Array.from({ length: to - from + 1 }, (_, k) => byte(from + k));
    const reads: Record<string, string[]> = { "node-a.cdn.example.com": [], "node-b.cdn.example.com": [] };
    const asked: string[] = [];
    sites((url, init) => {
      if (url.hostname === "aiostreams.example.com" && url.pathname.includes("/stream/series/")) {
        const episode = decodeURIComponent(url.pathname).includes(":1:7") ? 7 : 8;
        return json({ streams: [{ url: `https://aiostreams.example.com/play/${episode}`, behaviorHints: { filename: `Show.S01E0${episode}.1080p.WEB-DL-TEAM.mkv` } }] });
      }
      // AIOStreams' playback address redirects to the server holding the file: E07 to A, E08 to B.
      if (url.hostname === "aiostreams.example.com" && url.pathname.startsWith("/play/")) {
        asked.push(url.pathname);
        const node = url.pathname.endsWith("/7") ? "node-a" : "node-b";
        return new Response(null, { status: 302, headers: { location: `https://${node}.cdn.example.com/dl${url.pathname}.mkv` } });
      }
      if (url.hostname in reads) {
        const range = new Headers(init?.headers).get("range") ?? "";
        reads[url.hostname].push(range);
        const [from, to] = range.replace("bytes=", "").split("-").map(Number);
        return new Response(slice(from, Math.min(to, size - 1)), { status: 206, headers: { "content-range": `bytes ${from}-${Math.min(to, size - 1)}/${size}` } });
      }
      return undefined;
    });
    // Server A refused this server's connection a moment ago.
    expect(noteRefusal("https://node-a.cdn.example.com/dl/play/other.mkv", "connection")).toBe(5 * 60_000);
    const settings = { opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    const { storedFileHash } = await import("../src/sync.js");
    await fileWithTrack("Show.S01E07.1080p.WEB-DL-TEAM.mkv", dialogue(37));
    await fileWithTrack("Show.S01E08.1080p.WEB-DL-TEAM.mkv", dialogue(38));
    await list(settings, "tt0000744:1:7", playing("Show.S01E07.1080p.WEB-DL-TEAM.mkv"));
    await list(settings, "tt0000744:1:8", playing("Show.S01E08.1080p.WEB-DL-TEAM.mkv"));
    for (let waited = 0; waited < 3000 && !(await storedFileHash("Show.S01E08.1080p.WEB-DL-TEAM.mkv")); waited += 20) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    // B: the redirect check and the hash's two reads. A: named by AIOStreams' redirect, never asked.
    expect(reads["node-b.cdn.example.com"]).toHaveLength(3);
    expect(await storedFileHash("Show.S01E08.1080p.WEB-DL-TEAM.mkv")).toBeTruthy();
    expect(reads["node-a.cdn.example.com"]).toEqual([]);
    expect(await storedFileHash("Show.S01E07.1080p.WEB-DL-TEAM.mkv")).toBeUndefined();
    expect(asked).toContain("/play/7");
    resetReads();
  }, 20000);
});

describe("this server's own AIOStreams", () => {
  it("serves its own streams to the reads the internal way, its redirects to itself included", async () => {
    const { config } = await import("../src/config.js");
    const before = { own: config.ownAiostreams, base: config.aiostreamsBase };
    config.ownAiostreams = "https://aiostreams.example.com";
    config.aiostreamsBase = "http://aio-internal.example:3000";
    try {
      const size = 500_000;
      const byte = (i: number) => (i * 3 + (i >> 7)) & 0xff;
      const slice = (from: number, to: number) => Uint8Array.from({ length: to - from + 1 }, (_, k) => byte(from + k));
      const internal: string[] = [];
      const outside: string[] = [];
      sites((url, init) => {
        if (url.hostname === "aiostreams.example.com") {
          outside.push(url.pathname);
          return undefined;
        }
        if (url.hostname !== "aio-internal.example") return undefined;
        if (url.pathname.includes("/stream/series/")) return json({ streams: [{ url: "https://aiostreams.example.com/play/12", behaviorHints: { filename: "Show.S01E12.1080p.WEB-DL-TEAM.mp4" } }] });
        // Its playback address redirects to where it serves the file, written as its public address.
        if (url.pathname === "/play/12") return new Response(null, { status: 307, headers: { location: "https://aiostreams.example.com/usenet/12.mp4" } });
        if (url.pathname === "/usenet/12.mp4") {
          const range = new Headers(init?.headers).get("range") ?? "";
          internal.push(range);
          const [from, to] = range.replace("bytes=", "").split("-").map(Number);
          return new Response(slice(from, Math.min(to, size - 1)), { status: 206, headers: { "content-range": `bytes ${from}-${Math.min(to, size - 1)}/${size}` } });
        }
        return undefined;
      });
      const settings = { opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" as const };
      await fileWithTrack("Show.S01E12.1080p.WEB-DL-TEAM.mp4", dialogue(41));
      await list(settings, "tt0000745:1:12", playing("Show.S01E12.1080p.WEB-DL-TEAM.mp4"));
      const { storedFileHash } = await import("../src/sync.js");
      for (let waited = 0; waited < 3000 && !(await storedFileHash("Show.S01E12.1080p.WEB-DL-TEAM.mp4")); waited += 20) await new Promise((r) => setTimeout(r, 20));
      expect(await storedFileHash("Show.S01E12.1080p.WEB-DL-TEAM.mp4")).toBeTruthy();
      // The redirect check and the hash's two reads, all the internal way; the public address never asked.
      expect(internal).toHaveLength(3);
      expect(outside).toEqual([]);
    } finally {
      config.ownAiostreams = before.own;
      config.aiostreamsBase = before.base;
    }
  }, 20000);

  it("leaves every other address as it is", async () => {
    const { config } = await import("../src/config.js");
    const { reachedFromHere } = await import("../src/sync.js");
    const before = { own: config.ownAiostreams, base: config.aiostreamsBase };
    config.ownAiostreams = "https://aio.example.org";
    config.aiostreamsBase = "http://aiostreams:3000";
    try {
      expect(reachedFromHere("https://aio.example.org/api/v1/play/x")).toBe("http://aiostreams:3000/api/v1/play/x");
      expect(reachedFromHere("https://aio.example.org.evil.example/x")).toBe("https://aio.example.org.evil.example/x");
      expect(reachedFromHere("https://nexus-1.weur.tb-cdn.st/dl/x.mkv")).toBe("https://nexus-1.weur.tb-cdn.st/dl/x.mkv");
      config.ownAiostreams = undefined;
      expect(reachedFromHere("https://aio.example.org/x")).toBe("https://aio.example.org/x");
    } finally {
      config.ownAiostreams = before.own;
      config.aiostreamsBase = before.base;
    }
  });
});

describe("a download", () => {
  it("stays inside its 8 s budget, the subtitle's own slow fetch included", async () => {
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9501\/download$/.test(url.pathname)) return later(6000, () => new Response(srt(dialogue(5))));
      // Finding the file in AIOStreams hangs, so the sync can't finish.
      if (url.hostname === "aiostreams.example.com") return later(30000, () => json({ streams: [] }));
      return undefined;
    });
    const token = seal({ subsource: "sk_slow_download_011", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000712:1:5", type: "series", file: "Show.S01E05.Slow.mkv" });
    const started = Date.now();
    const res = await realFetch(`${base}/${token}/download/ss9501/subtitle.srt?${query}`);
    const text = await res.text();
    const ms = Date.now() - started;
    expect(res.status).toBe(200);
    expect(text).toContain("\n#1\n");
    expect(ms).toBeGreaterThan(5900);
    expect(ms).toBeLessThan(8800);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 20000);

  it("sends a fallback that fits the file's own track once the listed one is known not to, without waiting on the listed one's speech read", async () => {
    const lines = dialogue(23);
    const right = lines.map((c) => ({ start: c.start + 2000, end: c.end + 2000 }));
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9511\/download$/.test(url.pathname)) return new Response(srt(dialogue(61)));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9512\/download$/.test(url.pathname)) return new Response(srt(right));
      // Finding the file in AIOStreams hangs, so the listed subtitle's speech read can't finish.
      if (url.hostname === "aiostreams.example.com") return later(30000, () => json({ streams: [] }));
      return undefined;
    });
    await fileWithTrack("Show.S01E05.Misfit.mkv", lines, { audio: 1 });
    const token = seal({ subsource: "sk_misfit_download_12", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000713:1:5", type: "series", file: "Show.S01E05.Misfit.mkv", alt: "ss9512@1:5" });
    const started = Date.now();
    const res = await realFetch(`${base}/${token}/download/ss9511/subtitle.srt?${query}`);
    const text = await res.text();
    // Waiting on a speech read takes the 5 s sync wait or longer.
    expect(Date.now() - started).toBeLessThan(4500);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600, stale-if-error=2592000");
    // The fallback, timed onto the file's own lines.
    const starts = [...text.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
    expect(starts).toHaveLength(right.length);
    const onLines = starts.filter((s, i) => Math.abs(s - lines[i].start) <= 100).length;
    expect(onLines / starts.length).toBeGreaterThan(0.9);
  }, 20000);

  it("goes past a fallback that fits the file's track no better, without waiting on its speech read either", async () => {
    const lines = dialogue(29);
    const right = lines.map((c) => ({ start: c.start - 3000, end: c.end - 3000 }));
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9521\/download$/.test(url.pathname)) return new Response(srt(dialogue(67)));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9522\/download$/.test(url.pathname)) return new Response(srt(dialogue(71)));
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9523\/download$/.test(url.pathname)) return new Response(srt(right));
      // Finding the file in AIOStreams hangs, so no speech read can finish.
      if (url.hostname === "aiostreams.example.com") return later(30000, () => json({ streams: [] }));
      return undefined;
    });
    await fileWithTrack("Show.S01E05.Misfits.mkv", lines, { audio: 1 });
    const token = seal({ subsource: "sk_misfit_download_13", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000714:1:5", type: "series", file: "Show.S01E05.Misfits.mkv", alt: "ss9522@1:5,ss9523@1:5" });
    const started = Date.now();
    const res = await realFetch(`${base}/${token}/download/ss9521/subtitle.srt?${query}`);
    const text = await res.text();
    // Waiting on a speech read takes the 5 s sync wait or longer.
    expect(Date.now() - started).toBeLessThan(4500);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600, stale-if-error=2592000");
    const starts = [...text.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
    expect(starts).toHaveLength(right.length);
    expect(starts.filter((s, i) => Math.abs(s - lines[i].start) <= 100).length / starts.length).toBeGreaterThan(0.9);
  }, 20000);

  it("gives SubSource's search and download a time limit", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    sites((url, init) => {
      signals.push(init?.signal);
      return subsource(url, { arabic: [] }, { "9601": srt(dialogue(3)) }, 113);
    });
    const { downloadSubtitleArchive, searchMoviesByImdb } = await import("../src/subsource.js");
    await searchMoviesByImdb("tt0000713", "sk_time_limit_key_12");
    await downloadSubtitleArchive(9601, "sk_time_limit_key_12");
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("an anime season named by its own title", () => {
  const SHOW: Record<string, [string, number, number, number]> = {
    // Anime Kitsu's entries for one show: name, IMDb season, its first IMDb episode, episodes.
    base: ["Show", 1, 1, 12],
    second: ["Show: Second Arc", 2, 1, 11],
    third: ["Show: Third Arc", 3, 1, 11],
    part: ["Show: Third Arc Part 2", 3, 12, 11]
  };
  /** The Anime Kitsu addon for a show with these entries (kitsu ids from `first` on), or failing. */
  const kitsu = (imdbId: string, first: number, names: string[], fail = false) => (url: URL) => {
    if (url.hostname !== "anime-kitsu.strem.fun") return undefined;
    if (fail) return new Response("busy", { status: 503 });
    if (url.pathname.includes("/catalog/")) return json({ metas: names.map((_, i) => ({ id: `kitsu:${first + i}`, type: "series", imdb_id: imdbId })) });
    const index = Number(url.pathname.match(/kitsu:(\d+)\.json$/)?.[1]) - first;
    const entry = SHOW[names[index]];
    if (!entry) return undefined;
    const [name, season, from, count] = entry;
    return json({ meta: { name, aliases: [], imdb_id: imdbId, videos: Array.from({ length: count }, (_, i) => ({ episode: i + 1, imdbSeason: season, imdbEpisode: from + i })) } });
  };
  /** SubSource with one record per season (movieId base + season), these Arabic subtitles in each, and these downloads. */
  const records = (url: URL, base: number, arabic: Record<number, unknown[]>, files: Record<string, Buffer> = {}, hits: number[] = []) => {
    if (url.hostname !== "api.subsource.net") return undefined;
    if (url.pathname.endsWith("/movies/search")) {
      return json({ data: Object.keys(arabic).map((season) => ({ movieId: base + Number(season), title: "Show", type: "tvseries", season: Number(season), subtitleCount: 9 })) });
    }
    if (url.pathname.endsWith("/subtitles")) {
      const season = Number(url.searchParams.get("movieId")) - base;
      hits.push(season);
      return json({ data: url.searchParams.get("language") === "arabic" ? (arabic[season] ?? []) : [], pagination: { pages: 1 } });
    }
    const download = url.pathname.match(/\/subtitles\/(\d+)\/download$/);
    return download && files[download[1]] ? new Response(new Uint8Array(files[download[1]])) : undefined;
  };
  const arabic = (id: number, name: string, extra: Record<string, unknown> = {}) => sub(id, name, { language: "arabic", files: null, ...extra });
  const settings = (key: string): Settings => ({ subsource: key, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });

  it("gives a second season's episode its own subtitle from a third season's record, not the first season's '- 03'", async () => {
    sites((url) =>
      records(url, 98100, {
        1: [arabic(98111, "[Group] Show - 03 [1080p]")],
        2: [],
        3: [arabic(98131, "[Group] Show - 03"), arabic(98132, "[Group] Show: Second Arc - 03"), arabic(98133, "[Group] Show: Third Arc - 03")]
      }) ??
      kitsu("tt0000981", 9001, ["base", "second", "third"])(url) ??
      cinemeta(url)
    );
    const answer = await list(settings("sk_season_title_0981"), "tt0000981:2:3");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss98132"]);
    expect(answer.cacheMaxAge).toBe(300);
    // The same record gives the first and third seasons their own.
    expect((await list(settings("sk_season_title_0981"), "tt0000981:3:3")).subtitles.map(refOfTrack)).toEqual(["ss98133"]);
    expect((await list(settings("sk_season_title_0981"), "tt0000981:1:3")).subtitles.map(refOfTrack)).toEqual(["ss98111"]);
  });

  it("searches every record of the show with a map, and only the first three without one", async () => {
    const lists = { 1: [arabic(98211, "Show - 05")], 2: [], 3: [], 5: [arabic(98251, "Show: Second Arc - 05")] };
    const hits: number[] = [];
    sites((url) => records(url, 98200, lists, {}, hits) ?? kitsu("tt0000982", 9011, ["base", "second", "third"])(url) ?? cinemeta(url));
    const answer = await list(settings("sk_all_records_00982"), "tt0000982:2:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss98251"]);
    expect([...new Set(hits)].sort()).toEqual([1, 2, 3, 5]);

    // The addon failing: no map, so everything goes as before. The fifth record isn't searched, and
    // the first season's "- 05" is listed for any season, as it always was.
    const without: number[] = [];
    sites((url) => records(url, 98300, lists, {}, without) ?? kitsu("tt0000983", 9021, [], true)(url) ?? cinemeta(url));
    const before = await list(settings("sk_no_map_key_000983"), "tt0000983:2:5");
    expect(before.subtitles.map(refOfTrack)).toEqual(["ss98211"]);
    expect([...new Set(without)].sort()).toEqual([1, 2, 3]);
  });

  it("downloads a part's episode from its pack by the part's own number", async () => {
    const pack = new AdmZip();
    for (let n = 1; n <= 11; n++) pack.addFile(`Show - Third Arc Part 2 - ${String(n).padStart(2, "0")}.srt`, Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\npart two, episode ${n}\n`));
    sites((url) =>
      records(url, 98400, { 1: [], 3: [arabic(98431, "[Group] Show: Third Arc Part 2 [1 ~ 11]", { files: 11 })] }, { "98431": pack.toBuffer() }) ??
      kitsu("tt0000984", 9031, ["base", "second", "third", "part"])(url) ??
      cinemeta(url)
    );
    const answer = await list(settings("sk_part_pack_k_00984"), "tt0000984:3:13");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss98431"]);
    const link = new URL(answer.subtitles[0].url);
    expect(link.searchParams.get("pick")).toBe("2");
    const download = await realFetch(answer.subtitles[0].url.replace("https://sync.example", base));
    expect(await download.text()).toContain("part two, episode 2");
  });
});

describe("Wyzie Subs", () => {
  const TOKEN = "tok_wyzie_secret_0001";
  /** Wyzie's search for one episode: an upload and its own translation, in Arabic; its download link carries the token. */
  const wyzie = (hits: string[], file = "") =>
    sites((url) => {
      if (url.hostname !== "sub.wyzie.io") return undefined;
      if (url.pathname === "/search") {
        const id = url.searchParams.get("id") ?? "";
        return json([
          { id: "1705/Show - S01E05.Arabic.srt", url: `https://sub.wyzie.io/c/quebec/id/1705?format=srt&id=${id}&tok=${TOKEN}`, format: "srt", language: "ar-SA", source: "quebec", release: "Show.S01E05.1080p.WEB", releases: ["Show.S01E05.1080p.WEB"], fileName: "Show.S01E05.Arabic.srt", isHearingImpaired: false, downloadCount: 12, ai: false },
          { id: "ai-ar", url: `https://sub.wyzie.io/translate?id=${id}&tk=${TOKEN}&target=Arabic`, format: "srt", language: "ar", source: "ai", release: null, releases: [], ai: true }
        ]);
      }
      if (url.pathname.startsWith("/c/")) return new Response(file, { headers: { "x-wyzie-balance": "990", "x-wyzie-cost": "1" } });
      return undefined;
    }, hits);

  it("lists its uploads for the episode, leaves out its own translations, and keeps the links' tokens on the server", async () => {
    const hits = wyzie([]);
    const answer = await list({ wyzie: "wyzie_list_key_00041", languages: ["Arabic"], allowMachine: true, hearingImpaired: "include" }, "tt0000841:1:5");
    expect(answer.subtitles.map((t) => t.lang)).toEqual(["Arabic"]);
    expect(refOfTrack(answer.subtitles[0])).toMatch(/^wz[0-9a-f]{20}$/);
    for (const secret of [TOKEN, "wyzie_list_key_00041"]) expect(JSON.stringify(answer)).not.toContain(secret);
    const search = new URL(hits.find((h) => h.includes("/search"))!);
    expect(Object.fromEntries(["id", "season", "episode", "language", "source"].map((k) => [k, search.searchParams.get(k)]))).toEqual({ id: "tt0000841", season: "1", episode: "5", language: "ar", source: "all" });
  }, 15000);

  it("downloads through the link its search gave, without the notice a free key's files open with", async () => {
    const file = ["1", "00:00:00,000 --> 00:00:06,000", "You're on the free plan. Unlock every source → sub.wyzie.io", "", "2", "00:00:01,000 --> 00:00:02,000", "Hello there.", "", "3", "00:00:03,000 --> 00:00:04,000", "Bye.", ""].join("\n");
    const hits = wyzie([], file);
    const settings: Settings = { wyzie: "wyzie_down_key_00042", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" };
    const answer = await list(settings, "tt0000842:1:5");
    const track = new URL(answer.subtitles[0].url);
    const text = await (await realFetch(`${base}${track.pathname}${track.search}`)).text();
    expect(text).toContain("Hello there.");
    expect(text).toContain("Bye.");
    expect(text).not.toContain("wyzie.io");
    const downloads = hits.filter((h) => h.includes("/c/"));
    expect(downloads).toHaveLength(1);
    expect(new URL(downloads[0]).searchParams.get("tok")).toBe(TOKEN);
  }, 15000);

  it("asks a key's own searches: another key's kept results and links aren't used for it", async () => {
    const hits = wyzie([]);
    await list({ wyzie: "wyzie_first_key_0043", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000843:1:5");
    await list({ wyzie: "wyzie_other_key_0043", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000843:1:5");
    expect(hits.filter((h) => h.includes("/search")).map((h) => new URL(h).searchParams.get("key"))).toEqual(["wyzie_first_key_0043", "wyzie_other_key_0043"]);
  }, 15000);

  it("takes a new key only once Wyzie's usage page answers for it, which costs no request, and is a source on its own", async () => {
    const hits = sites((url) => (url.hostname === "sub.wyzie.io" && url.pathname === "/usage" ? json({}, url.searchParams.get("key") === "wyzie_good_key_0044" ? 200 : 401) : undefined));
    const { checkStep } = await import("../src/configure.js");
    const input = { opensubtitles: false, thesubtitledb: false, gestdown: false, animetosho: false };
    expect(await checkStep("sources", { ...input, wyzie: "wyzie_good_key_0044" })).toEqual({ ok: true });
    expect(await checkStep("sources", { ...input, wyzie: "wyzie_bad_key_00044" })).toEqual({ error: "Wyzie Subs key: Wyzie didn't accept it" });
    expect(await checkStep("sources", { ...input, wyzie: "short" })).toEqual({ error: "Wyzie Subs key: that doesn't look like a key" });
    // A saved key isn't checked again.
    const current: Settings = { wyzie: "wyzie_kept_key_00044", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" };
    expect(await checkStep("sources", { ...input, wyzie: "" }, current)).toEqual({ ok: true });
    expect(hits.filter((h) => h.includes("/usage"))).toHaveLength(2);
  });
});

describe("OpenSubtitles' own search", () => {
  const KEY = "os_list_test_key_0851";
  /** The server's OpenSubtitles key set for one test. */
  const withKey = async (run: () => Promise<void>) => {
    const { config } = await import("../src/config.js");
    config.openSubtitlesApiKey = KEY;
    try {
      await run();
    } finally {
      config.openSubtitlesApiKey = undefined;
    }
  };
  /** One of its results: a subtitle with a legacy id (or none), its release and file name, and its marks. */
  const item = (legacy: number | null, marks: Record<string, unknown> = {}) => ({
    attributes: { language: "ar", legacy_subtitle_id: legacy, release: `Show.S01E05.${legacy}.WEB`, files: [{ file_name: `Show.S01E05.${legacy}.ar.srt` }], hearing_impaired: false, ...marks }
  });
  const ownSearch = (asked: Array<{ url: URL; key?: string }>, data: unknown[]) => (url: URL, init?: RequestInit) => {
    if (url.hostname !== "api.opensubtitles.com") return undefined;
    asked.push({ url, key: (init?.headers as Record<string, string> | undefined)?.["Api-Key"] });
    return json({ total_pages: 1, data });
  };

  it("lists OpenSubtitles from it with the server's key, by legacy id for V3+ to download, without what it marks machine or AI translated", () =>
    withKey(async () => {
      const asked: Array<{ url: URL; key?: string }> = [];
      const data = [item(9851, { from_trusted: true }), item(9852, { machine_translated: true }), item(9853, { ai_translated: true }), item(null), item(9854, { foreign_parts_only: true })];
      const hits = sites((url, init) => ownSearch(asked, data)(url, init));
      const settings: Settings = { opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include", perLanguage: 3 };
      const answer = await list(settings, "tt0000851:1:5");
      expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9851"]);
      expect(asked[0].key).toBe(KEY);
      // Its parameters sorted and in lower case, the id without "tt" or leading zeros: no redirect.
      expect(asked[0].url.search).toBe("?ai_translated=include&episode_number=5&languages=ar&machine_translated=include&page=1&parent_imdb_id=851&season_number=1");
      expect(hits.some((h) => h.includes("opensubtitles.stremio.homes"))).toBe(false);
      // Allowed, machine and AI translations are listed too, after a person's; one with no legacy id or
      // for the foreign parts only never is.
      const allowed = await list({ ...settings, allowMachine: true }, "tt0000851:1:5");
      expect(allowed.subtitles.map(refOfTrack)[0]).toBe("osar-9851");
      expect(new Set(allowed.subtitles.map(refOfTrack))).toEqual(new Set(["osar-9851", "osar-9852", "osar-9853"]));
      // Asked once: the second list used the kept answer.
      expect(asked).toHaveLength(1);
      // Downloaded through V3+, by the legacy id.
      const { openSubtitlesDownloadUrl } = await import("../src/sources.js");
      expect(openSubtitlesDownloadUrl("osar-9851")).toBe("https://opensubtitles.stremio.homes/sub.vtt/?lang_code=ar&sub_id=9851");
    }), 15000);

  it("leaves the listing to V3+ when it fails, and isn't asked without a key", async () => {
    await withKey(async () => {
      const hits = sites((url) => (url.hostname === "api.opensubtitles.com" ? json({ message: "down" }, 503) : openSubtitlesArabic(url, 9861)));
      const answer = await list({ opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000861:1:5");
      expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9861"]);
      expect(hits.some((h) => h.includes("api.opensubtitles.com"))).toBe(true);
    });
    const hits = sites((url) => openSubtitlesArabic(url, 9862));
    const answer = await list({ opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000862:1:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["osar-9862"]);
    expect(hits.some((h) => h.includes("api.opensubtitles.com"))).toBe(false);
  }, 15000);

  it("takes Wyzie's copies of OpenSubtitles out when it lists OpenSubtitles, and Wyzie's Subtitle Cat machine translations out when they aren't allowed", async () => {
    const { wyzieRef } = await import("../src/wyzie.js");
    const opensubtitles = { id: "1962750001", source: "charlie", name: "Show.S01E05.OS" };
    const upload = { id: "1801/Show.S01E05.BD-TEAM-orig.srt", source: "quebec", name: "Show.S01E05.BD-TEAM" };
    const translation = { id: "1802/Show.S01E05.WEB-TEAM-ar.srt", source: "quebec", name: "Show.S01E05.WEB-TEAM" };
    const wyzieSearch = (url: URL) =>
      url.hostname === "sub.wyzie.io" && url.pathname === "/search"
        ? json([opensubtitles, upload, translation].map((r) => ({ id: r.id, url: `https://sub.wyzie.io/c/${r.source}/id/${encodeURIComponent(r.id)}?format=srt&tok=tok_wyzie_secret_0087`, format: "srt", language: "ar", source: r.source, release: r.name, releases: [r.name], ai: false })))
        : undefined;
    const refs = (t: Track[]) => new Set(t.map(refOfTrack));
    const settings: Settings = { wyzie: "wyzie_split_key_00871", opensubtitles: true, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include", perLanguage: 3 };
    await withKey(async () => {
      sites((url, init) => wyzieSearch(url) ?? ownSearch([], [])(url, init));
      const answer = await list(settings, "tt0000871:1:5");
      expect(refs(answer.subtitles)).toEqual(new Set([wyzieRef("quebec", upload.id)]));
    });
    // Without OpenSubtitles' own search its copies stay; a Subtitle Cat machine translation still only goes where they're allowed.
    sites((url) => wyzieSearch(url) ?? (url.hostname === "opensubtitles.stremio.homes" ? json({ subtitles: [] }) : undefined));
    const plain = await list(settings, "tt0000872:1:5");
    expect(refs(plain.subtitles)).toEqual(new Set([wyzieRef("charlie", opensubtitles.id), wyzieRef("quebec", upload.id)]));
    const allowed = await list({ ...settings, allowMachine: true }, "tt0000872:1:5");
    expect(refs(allowed.subtitles)).toEqual(new Set([wyzieRef("charlie", opensubtitles.id), wyzieRef("quebec", upload.id), wyzieRef("quebec", translation.id)]));
  }, 20000);
});

describe("a show that isn't anime", () => {
  it("isn't looked up in the Anime Kitsu addon, and its list doesn't wait for it", async () => {
    const hits = sites((url) => {
      if (url.hostname === "v3-cinemeta.strem.io") return json({ meta: { country: "United States", genres: ["Drama"], name: "Show" } });
      // Asked, it would answer too late for the list.
      if (url.hostname === "anime-kitsu.strem.fun") return later(6000, () => json({ metas: [] }));
      return subsource(url, { arabic: [sub(9901, "Show S01E05", { language: "arabic" })] }, {}, 118);
    });
    const answer = await list({ subsource: "sk_not_anime_key_018", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0000718:1:5");
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9901"]);
    expect(answer.cacheMaxAge).toBe(300);
    expect(hits.filter((h) => h.includes("anime-kitsu.strem.fun"))).toEqual([]);
  });
});

describe("a first play's list", () => {
  it("leaves out a language the playing file has, known from the quick read of its first part", async () => {
    const filename = "Show.S01E05.Langs.mkv";
    const file = release({ codecPrivate: ASS_HEADER, lines: ASS_LINES, name: "Arabic", language: "ara" });
    const reads: string[] = [];
    sites((url, init) => {
      // AIOStreams lists the file; its host answers range reads. The full header check (ffprobe) can't
      // read it here, so only the quick read of its first part knows its languages.
      if (url.hostname === "aiostreams.example.com") return json({ streams: [{ url: "https://files.example/langs.mkv", behaviorHints: { filename } }] });
      if (url.hostname === "files.example") {
        const range = new Headers(init?.headers).get("range") ?? "";
        reads.push(range);
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        const from = Number(m?.[1] ?? 0);
        const to = Math.min(Number(m?.[2] ?? file.length - 1), file.length - 1);
        const response = new Response(new Uint8Array(file.subarray(from, to + 1)), { status: 206 });
        Object.defineProperty(response, "url", { value: url.href });
        return response;
      }
      return subsource(url, { arabic: [sub(9911, "Show S01E05", { language: "arabic" })], dutch: [sub(9912, "Show S01E05", { language: "dutch" })] }, {}, 119);
    });
    const settings: Settings = { subsource: "sk_file_langs_key_19", aiostreams: AIO, languages: ["Arabic", "Dutch"], allowMachine: false, hearingImpaired: "include" };
    const answer = await list(settings, "tt0000719:1:5", playing(filename));
    expect(reads.some((r) => r.startsWith("bytes=0-") && r !== "bytes=0-0")).toBe(true);
    expect(answer.subtitles.map((t) => [t.lang, refOfTrack(t)])).toEqual([["Dutch", "ss9912"]]);
    // Asked to keep the file's own languages too, the link lists it.
    const kept = await list({ ...settings, keepEmbedded: true }, "tt0000719:1:5", playing(filename));
    expect(kept.subtitles.map((t) => t.lang).sort()).toEqual(["Arabic", "Dutch"]);
  }, 15000);
});

describe("a source that answers after the list has gone out", () => {
  it("gives its subtitles to that list's track as fallbacks, ranked for the episode, machine translations left out as the configuration asks", async () => {
    const { lateAlternates } = await import("../src/lateAlternates.js");
    const config = (await import("../src/config.js")).config;
    const settings: Settings = { opensubtitles: true, wyzie: "wyzie_late_key_000951", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" };
    sites((url) => {
      const listed = openSubtitlesArabic(url, 9951);
      if (listed) return listed;
      if (url.hostname === "sub.wyzie.io" && url.pathname === "/search") {
        // Past the list's time and the wait it keeps for the playing file: the list goes out without it.
        return later(config.listBudgetMs + 3000, () =>
          json([
            { id: "1951/Show - S01E05.Arabic.srt", url: "https://sub.wyzie.io/c/quebec/id/1951?format=srt", format: "srt", language: "ar", source: "quebec", release: "Show.S01E05.1080p.WEB", releases: ["Show.S01E05.1080p.WEB"], fileName: "Show.S01E05.Arabic.srt", isHearingImpaired: false },
            { id: "ai-ar", url: "https://sub.wyzie.io/translate?target=Arabic", format: "srt", language: "ar", source: "ai", release: null, releases: [], ai: true }
          ])
        );
      }
      return undefined;
    });
    const answer = await list(settings, "tt0000951:1:5", `/filename=${encodeURIComponent("Show.S01E05.Late.mkv")}&videoSize=1234567890`);
    expect(answer.subtitles.map((t) => refOfTrack(t))).toEqual(["osar-9951"]);
    expect(altsOf(answer.subtitles[0])).toEqual([]);
    const prefix = `/${seal(settings)}`;
    expect(lateAlternates(prefix, "tt0000951:1:5", "Arabic")).toEqual([]);
    await vi.waitFor(() => expect(lateAlternates(prefix, "tt0000951:1:5", "Arabic")).toHaveLength(1), { timeout: 4000, interval: 100 });
    const [late] = lateAlternates(prefix, "tt0000951:1:5", "Arabic");
    expect(late.ref).toMatch(/^wz[0-9a-f]{20}$/);
    expect([late.season, late.episode]).toEqual([1, 5]);
    // Another title, another track and another configuration have none of it.
    expect(lateAlternates(prefix, "tt0000951:1:6", "Arabic")).toEqual([]);
    expect(lateAlternates(prefix, "tt0000951:1:5", "Dutch")).toEqual([]);
    expect(lateAlternates("/another", "tt0000951:1:5", "Arabic")).toEqual([]);
  }, 20000);

  it("is tried by a download once the listed subtitle is known not to fit, after the fallbacks its link names, and sent when it fits", async () => {
    const { noteLateAlternates } = await import("../src/lateAlternates.js");
    const lines = dialogue(29);
    const right = lines.map((c) => ({ start: c.start + 2000, end: c.end + 2000 }));
    const fetched: string[] = [];
    sites((url) => {
      const download = url.hostname === "api.subsource.net" ? url.pathname.match(/\/subtitles\/(\d+)\/download$/)?.[1] : undefined;
      if (download) fetched.push(download);
      if (download === "9961" || download === "9962") return new Response(srt(dialogue(Number(download))));
      if (download === "9963") return new Response(srt(right));
      if (url.hostname === "aiostreams.example.com") return later(30000, () => json({ streams: [] }));
      return undefined;
    });
    await fileWithTrack("Show.S01E05.LateFit.mkv", lines, { audio: 1 });
    const token = seal({ subsource: "sk_late_download_0961", aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" });
    // The late one, the listed one again and the link's own fallback again: only the new one is added.
    noteLateAlternates(`/${token}`, "tt0000961:1:5", "Arabic", [{ ref: "ss9961", season: 1, episode: 5 }, { ref: "ss9962", season: 1, episode: 5 }, { ref: "ss9963", season: 1, episode: 5 }]);
    const query = new URLSearchParams({ lang: "Arabic", season: "1", episode: "5", sv: "12", vid: "tt0000961:1:5", type: "series", file: "Show.S01E05.LateFit.mkv", alt: "ss9962@1:5" });
    const res = await realFetch(`${base}/${token}/download/ss9961/subtitle.srt?${query}`);
    const text = await res.text();
    const starts = [...text.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
    expect(starts).toHaveLength(right.length);
    expect(starts.filter((s, i) => Math.abs(s - lines[i].start) <= 100).length / starts.length).toBeGreaterThan(0.9);
    expect(fetched).toEqual(["9961", "9962", "9963"]);
    expect(stats.activityPage({ kind: "download", limit: 50 }).rows[0].result).toBe("synced (fallback)");
    // The dub track of the same title has none of the Arabic track's.
    const dub = new URLSearchParams({ season: "1", episode: "5", sv: "12", vid: "tt0000961:1:5", type: "series", file: "Show.S01E05.LateFit.mkv" });
    fetched.length = 0;
    await (await realFetch(`${base}/${token}/download/ss9961/subtitle.srt?${dub}`)).text();
    expect(fetched).not.toContain("9963");
  }, 30000);
});

describe("a track for one kind of Spanish", () => {
  /** A subtitle of plain Spanish lines, with these lines among them. */
  const spanish = (marked: string[]) => {
    const lines = Array.from({ length: 320 }, () => "No sé qué quieres que haga con esto ahora mismo");
    marked.forEach((line, i) => (lines[i * 7] = line));
    return lines.map((line, i) => `${i + 1}\n${stamp(i * 3000)} --> ${stamp(i * 3000 + 2000)}\n${line}\n`).join("\n");
  };
  const ofSpain = spanish(["¿Qué hacéis vosotros aquí?", "Os lo he dicho mil veces", "Sois unos pesados", "¿Tenéis hambre?", "Vuestro coche está fuera"]);
  const ofAmerica = spanish(["¿Qué hacen ustedes aquí?", "Ustedes no entienden nada"]);

  it("is filled from what sites file as Spanish, its own kind first by name, and named in full", async () => {
    const plain = sub(9971, "Show S01E05 1080p WEB", { language: "spanish", downloads: 90 });
    const latino = sub(9972, "Show S01E05 720p Latino", { language: "spanish", downloads: 1 });
    const europeo = sub(9973, "Show S01E05 1080p (Europeo)", { language: "spanish", downloads: 500 });
    const hits = sites((url) => subsource(url, { spanish: [europeo, plain, latino] }, {}, 197));
    const answer = await list({ subsource: "sk_spanish_kinds_key_97", languages: ["Spanish (LA)", "Spanish (EU)"], allowMachine: false, hearingImpaired: "include" }, "tt0000971:1:5");
    expect(answer.subtitles.map((t) => [t.lang, refOfTrack(t)])).toEqual([["Spanish (Latin America)", "ss9972"], ["Spanish (Spain)", "ss9973"]]);
    // SubSource is asked for Spanish, the language both kinds are filed under.
    expect(hits.filter((h) => h.includes("/subtitles?")).map((h) => new URL(h).searchParams.get("language"))).toContain("spanish");
  }, 15000);

  it("passes over a file written in the other kind for the next in line, and leaves Spanish itself as it is", async () => {
    sites((url) => {
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9981\/download$/.test(url.pathname)) return new Response(ofSpain);
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9982\/download$/.test(url.pathname)) return new Response(ofAmerica);
      return undefined;
    });
    const token = seal({ subsource: "sk_spanish_kinds_key_98", languages: ["Spanish", "Spanish (LA)", "Spanish (EU)"], allowMachine: false, hearingImpaired: "include" });
    const get = async (ref: string, lang: string, alt: string) =>
      (await realFetch(`${base}/${token}/download/${ref}/subtitle.srt?${new URLSearchParams({ lang, season: "1", episode: "5", type: "series", alt })}`)).text();
    // Latin America's track listed Spain's file: the next in line, Latin America's, is sent.
    const america = await get("ss9981", "Spanish (LA)", "ss9982@1:5");
    expect(america).toContain("ustedes");
    expect(america).not.toContain("vosotros");
    // Spain's track listed Latin America's file: Spain's is sent.
    const spain = await get("ss9982", "Spanish (EU)", "ss9981@1:5");
    expect(spain).toContain("vosotros");
    expect(spain).not.toContain("ustedes");
    // Spanish itself takes either as it comes.
    expect(await get("ss9981", "Spanish", "ss9982@1:5")).toContain("vosotros");
    expect(await get("ss9982", "Spanish", "ss9981@1:5")).toContain("ustedes");
  }, 20000);

  it("doesn't send SubDL a code it has no language for", async () => {
    const hits = sites((url) => (url.hostname === "api.subdl.com" ? json({ status: true, subtitles: [] }) : undefined));
    await list({ subdl: "subdl_spanish_kinds_key_99", languages: ["Spanish (LA)"], allowMachine: false, hearingImpaired: "include" }, "tt0000973:1:5");
    expect(hits.filter((h) => h.includes("api.subdl.com")).map((h) => new URL(h).searchParams.get("languages"))).toEqual(["ES"]);
  }, 15000);
});

describe("the syncs' head start, on a list one slow source holds to its time", () => {
  it("starts timing the tracks leading then, so a subtitle that takes longer than the grace to fetch still says Synced", async () => {
    const lines = dialogue(11);
    const before = stats.countedToday("lists.headStart");
    sites((url) => {
      // One source never answers: the list waits its whole time for it.
      if (url.hostname === "opensubtitles.stremio.homes") return never();
      // The subtitle's own download takes 2.5 s: more than the list's grace leaves a sync started at its deadline.
      if (url.hostname === "api.subsource.net" && /\/subtitles\/9671\/download$/.test(url.pathname)) return later(2500, () => new Response(srt(lines.map((c) => ({ start: c.start - 900, end: c.end - 900 })))));
      return subsource(url, { arabic: [sub(9671, "Show S01E05", { language: "arabic" })] }, {}, 571);
    });
    await fileWithTrack("Show.S01E05.HeadStart.mkv", lines);
    const answer = await list({ subsource: "sk_head_start_key_012", opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0005792:1:5", playing("Show.S01E05.HeadStart.mkv"));
    expect(answer.subtitles.map(refOfTrack)).toEqual(["ss9671"]);
    expect(answer.subtitles[0].label).toBe("Synced · BttrSubs");
    // The list itself is no later for it.
    expect(answer.ms).toBeLessThan(5600);
    expect(stats.countedToday("lists.headStart")).toBe(before + 1);
  }, 15000);

  it("isn't taken when every source answers early: the list's own pick has the time", async () => {
    const lines = dialogue(11);
    const before = stats.countedToday("lists.headStart");
    sites((url) => {
      if (url.hostname === "opensubtitles.stremio.homes") return json({ subtitles: [] });
      return subsource(url, { arabic: [sub(9672, "Show S01E05", { language: "arabic" })] }, { "9672": srt(lines.map((c) => ({ start: c.start - 900, end: c.end - 900 }))) }, 572);
    });
    await fileWithTrack("Show.S01E05.NoHeadStart.mkv", lines);
    const answer = await list({ subsource: "sk_head_start_key_013", opensubtitles: true, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include" }, "tt0005793:1:5", playing("Show.S01E05.NoHeadStart.mkv"));
    expect(answer.subtitles[0].label).toBe("Synced · BttrSubs");
    expect(answer.ms).toBeLessThan(3000);
    // Its timer runs out after the list has gone: nothing is started by it.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(stats.countedToday("lists.headStart")).toBe(before);
  }, 15000);
});

describe("a link whose AIOStreams instance this server no longer accepts", () => {
  it("opens only its configure page, without that account, and is answered again once saved with an accepted instance", async () => {
    const { routePath, storeSettings, forgetStoredSettings } = await import("../src/profile.js");
    const made: Settings = { subsource: "sk_lapsed_link_key_77", aiostreams: "https://gone.example/stremio/abcd1234-0000-4000-8000-000000000000/pass/manifest.json", aiostreamsPassword: "kept-password", languages: ["Arabic"], allowMachine: false, hearingImpaired: "include", label: "Living room" };
    // Made while the instance was one this server accepts, which it then stops being.
    const { config } = await import("../src/config.js");
    const accepted = config.allowedAiostreams;
    config.allowedAiostreams = [...accepted, "https://gone.example"];
    const token = seal(made);
    config.allowedAiostreams = accepted;
    // Nothing of it is listed or sent.
    expect(routePath(`/${token}/subtitles/series/tt0000795:1:5.json`)).toBeUndefined();
    expect(routePath(`/${token}/download/ss1/subtitle.srt`)).toBeUndefined();
    expect(routePath(`/${token}/manifest.json`)).toBeUndefined();
    // Its configure page opens: everything but the account, under the id the link had.
    const page = routePath(`/${token}/configure`);
    expect(page?.lapsed).toBe(true);
    expect(page?.settings).toMatchObject({ subsource: "sk_lapsed_link_key_77", languages: ["Arabic"], label: "Living room" });
    expect(page?.settings && "aiostreams" in page.settings).toBe(false);
    expect(page?.settings && "aiostreamsPassword" in page.settings).toBe(false);
    expect(page?.profile?.name).toMatch(/^abcd1234\/[0-9a-f]{6}$/);
    expect((await realFetch(`${base}/${token}/configure`)).status).not.toBe(404);
    // Saved with an instance this server accepts, the same link is answered like any other, under the same id.
    storeSettings(token, { ...made, aiostreams: AIO, linkId: page!.profile!.name });
    const again = routePath(`/${token}/subtitles/series/tt0000795:1:5.json`);
    expect(again?.lapsed).toBeUndefined();
    expect(again?.profile?.name).toBe(page!.profile!.name);
    expect(again?.settings?.aiostreams).toBe(AIO);
    // A token that was altered opens nothing.
    expect(routePath(`/${token.slice(0, -4)}AAAA/configure`)).toBeUndefined();
    forgetStoredSettings();
  });
});
