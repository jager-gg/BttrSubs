import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CACHE = ".cache-stats-test";
let base = "";
let close = () => {};
let stats: typeof import("../src/stats.js");
let profile: typeof import("../src/profile.js");
let page: typeof import("../src/statsPage.js");
let board: typeof import("../src/dashboardData.js");
/** The dashboard's data for the stats as they stand (what its page draws). */
const dataNow = async () => board.dashboardData(await stats.statsView("1.3.0"));

beforeAll(async () => {
  process.env.CONFIG_SECRET = "stats-test-secret-stats-test-secret-12";
  process.env.CACHE_DIR = CACHE;
  process.env.PUBLIC_BASE_URL = "https://sync.example";
  [stats, profile, page, board] = await Promise.all([import("../src/stats.js"), import("../src/profile.js"), import("../src/statsPage.js"), import("../src/dashboardData.js")]);
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(async () => {
  close();
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

describe("an activity row's detail", () => {
  it("is kept with the row, trimmed, and sent with the row for the dashboard to open", async () => {
    const stats = await import("../src/stats.js");
    const tracks = Array.from({ length: 12 }, (_, i) => ({ lang: "Arabic", source: "SubDL", ref: `sd${i}`, release: "R".repeat(300), state: "synced" as const }));
    stats.noteActivity({ link: "deta0001/aa", kind: "list", what: "Placeholder Show S1E01", result: "12 tracks, 12 synced", ms: 900, detail: { tracks, late: ["Gestdown"] } });
    const row = stats.activityPage({ link: "deta0001/aa", limit: 50 }).rows[0];
    expect(row.detail?.tracks).toHaveLength(8);
    expect(row.detail?.tracks?.[0].release).toHaveLength(200);
    // A download is told the release its list gave it.
    expect(stats.listedRelease("sd3")).toBe(`${"R".repeat(199)}…`);
    expect(stats.listedRelease("sd99")).toBeUndefined();
    expect(row.detail?.late).toEqual(["Gestdown"]);
    stats.noteLinkLabel("deta0001/aa", "Den <TV>");
    const data = await dataNow();
    expect(data.activity.find((a) => a.link === "deta0001/aa")).toMatchObject({ kind: "list", detail: { late: ["Gestdown"] } });
    expect(data.names["deta0001/aa"]).toBe("Den <TV>");
    // Written into the page as data a script reads: nothing in it can close the script or start markup.
    const html = page.dashboardPage(data, { csrf: "x", signedIn: false });
    const script = html.slice(html.indexOf("<script>window.BTTR = "), html.indexOf("</script>", html.indexOf("<script>window.BTTR = ")));
    expect(script).not.toContain("<TV>");
    expect(script).toContain("Den \\u003cTV\\u003e");
  });
});

describe("links", () => {
  it("are the same for the same settings, and still open", () => {
    const settings = { opensubtitles: true, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" as const };
    const a = profile.sealSettings(settings);
    expect(profile.sealSettings({ ...settings })).toBe(a);
    expect(profile.sealSettings({ ...settings, languages: ["English"] })).not.toBe(a);
    expect(profile.openSettings(a)).toEqual(settings);
  });
});

describe("usage and health", () => {
  it("keeps addresses and tokens out of error notes", () => {
    expect(stats.scrub("ffmpeg failed on https://debrid.example/dl/abc?token=x and key sk_0123456789abcdef0123456789abcdef0")).toBe("ffmpeg failed on <url> and key <token>");
  });

  it("counts per day and per link, and renders", async () => {
    stats.count("lists", 1, "1234abcd/ab12cd");
    stats.count("downloads", 2, "1234abcd/ab12cd");
    stats.count("sync.files");
    stats.count("sync.videoSeconds", 200);
    stats.count("own.cpu.ms", 200_000);
    stats.count("net.rx", 5_000_000);
    stats.count("net.tx", 250_000);
    stats.count("proc.ffmpeg.ms", 8000);
    stats.count("api.subdl", 3);
    stats.noteError("subdl", new Error("HTTP 403 from https://api.subdl.com/api/v1/subtitles?api_key=secret"));
    const view = await stats.statsView("1.3.0");
    expect(view.days).toHaveLength(14);
    expect(view.days[0].total).toMatchObject({ lists: 1, downloads: 2, "sync.files": 1, "api.subdl": 3, "errors.subdl": 1 });
    expect(view.days[0].links["1234abcd/ab12cd"]).toMatchObject({ lists: 1, downloads: 2 });
    expect(view.now.cores).toBeGreaterThan(0);
    const token = profile.sealSettings({ subsource: "sk_dashboard_test_key_1234", opensubtitles: true, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "exclude" });
    profile.noteLinkToken("1234abcd/ab12cd", token);
    const data = await dataNow();
    // Each link it has seen: its settings, without its keys or token (Configure goes through the dashboard).
    expect(data.configs.find((c) => c.id === "1234abcd/ab12cd")).toMatchObject({
      known: true,
      languages: ["English Dub", "Arabic"],
      sources: ["SubSource", "OpenSubtitles", "TheSubtitleDB", "Gestdown", "Anime Tosho"],
      hearingImpaired: "exclude",
      aiostreams: null
    });
    const html = `${page.dashboardPage(data, { csrf: "x", signedIn: false })}`;
    expect(html).not.toContain(token);
    expect(html).not.toContain("sk_dashboard_test_key_1234");
    expect(html).not.toContain("api_key");
    // The container's own figures for today.
    expect(data.days[0]).toMatchObject({ cpuS: 200, rx: 5_000_000, tx: 250_000, files: 1, procS: 8, lists: 1, downloads: 2, apiCalls: 3, errors: 1 });
  });

  it("counts each key by an anonymous id, per link, against its free plan", async () => {
    const ok = new Response("{}", { headers: { "x-ratelimit-remaining": "59", "content-type": "application/json" } });
    await stats.requestContext.run({ link: "9999aaaa/cd34ef" }, async () => {
      stats.count("api.subsource");
      stats.noteKeyCall("subsource", "secret-subsource-key", ok);
      stats.noteKeyCall("subsource", "secret-subsource-key", new Response("", { status: 429 }));
      stats.noteKeyCall("subdl", "secret-subdl-key", ok);
      stats.noteKeyCall("subdl", "secret-subdl-key", ok, true);
    });
    stats.noteActivity({ link: "9999aaaa/cd34ef", kind: "download", what: "Arabic · Show S2 - 01", result: "synced", ms: 1200 });
    const view = await stats.statsView("1.3.0");
    const id = stats.keyId("subsource", "secret-subsource-key");
    expect(id).toMatch(/^subsource:[0-9a-f]{6}$/);
    expect(view.days[0].keys?.[id]).toMatchObject({ calls: 2, refused: 1, busiestMinute: 2, link: "9999aaaa/cd34ef", headers: { "x-ratelimit-remaining": "59" } });
    expect(view.days[0].keys?.[stats.keyId("subdl", "secret-subdl-key")]).toMatchObject({ calls: 2, downloads: 1 });
    expect(view.windows[id]).toEqual({ minute: 2, hour: 2, day: 2 });
    expect(view.days[0].links["9999aaaa/cd34ef"]).toMatchObject({ "api.subsource": 1 });
    const data = board.dashboardData(view);
    expect(JSON.stringify(data)).not.toContain("secret-");
    const subsource = data.keys.find((k) => k.id === id)!;
    expect(subsource).toMatchObject({ service: "subsource", link: "9999aaaa/cd34ef", weekCalls: 2, refused: 1 });
    expect(subsource.lastRefusedAt).toBeGreaterThan(0);
    // SubSource's own count (x-ratelimit-remaining 59 of 60) for this minute, and its day.
    expect(subsource.meters.map((m) => [m.label, m.used, m.max])).toEqual([["This minute", 1, 60], ["This hour", 2, 1800], ["Today", 2, 7200]]);
    const subdl = data.keys.find((k) => k.id === stats.keyId("subdl", "secret-subdl-key"))!;
    expect(subdl.meters.map((m) => [m.label, m.used, m.max])).toEqual([["Requests today", 1, 2000], ["Downloads today", 1, 50]]);
    expect(data.activity.some((a) => a.what === "Arabic · Show S2 - 01")).toBe(true);
  });

  it("shows a free Wyzie key's requests today as Wyzie counts them, from its latest reply's balance", async () => {
    const search = new Response("[]", { headers: { "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "789", "x-wyzie-balance": "789", "x-wyzie-plan": "free", "x-wyzie-cost": "4" } });
    const download = new Response("", { headers: { "x-wyzie-balance": "788", "x-wyzie-plan": "free", "x-wyzie-cost": "1" } });
    stats.noteKeyCall("wyzie", "secret-wyzie-key-0001", search);
    stats.noteKeyCall("wyzie", "secret-wyzie-key-0001", download, true);
    const data = board.dashboardData(await stats.statsView("1.3.0"));
    const wyzie = data.keys.find((k) => k.id === stats.keyId("wyzie", "secret-wyzie-key-0001"))!;
    expect(wyzie.meters).toEqual([{ label: "Requests today", used: 212, max: 1000, note: "Wyzie's own count" }]);
    expect(JSON.stringify(data)).not.toContain("secret-wyzie");
  });

  it("names a link by the name given on the configure page", async () => {
    stats.noteLinkLabel("7777cccc/dd22ee", "Sara's TV");
    const view = await stats.statsView("1.3.0");
    expect(view.names["7777cccc/dd22ee"]).toBe("Sara's TV");
    stats.count("lists", 1, "7777cccc/dd22ee");
    expect((await dataNow()).configs.find((c) => c.id === "7777cccc/dd22ee")?.name).toBe("Sara's TV");
  });

  it("shows a link's keys from its first request, before any call", async () => {
    stats.noteLinkKeys("5555bbbb/aa11bb", [["subsource", "never-called-key"], ["subdl", undefined]]);
    const view = await stats.statsView("1.3.0");
    const id = stats.keyId("subsource", "never-called-key");
    expect(view.days[0].keys?.[id]).toMatchObject({ calls: 0, link: "5555bbbb/aa11bb" });
    expect(Object.keys(view.days[0].keys ?? {}).filter((k) => k.startsWith("subdl:"))).toHaveLength(1); // only the one called earlier
    // A link whose keys made no calls this week: listed with no calls (the page groups it under the busy ones).
    expect(board.dashboardData(view).keys.find((k) => k.id === id)).toMatchObject({ link: "5555bbbb/aa11bb", weekCalls: 0 });
  });
});

describe("the dashboard page", () => {
  it("opens without a password when ADMIN_PASSWORD is unset (a proxy login guards it)", async () => {
    const shown = await fetch(`${base}/dashboard`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(await shown.text()).toContain("<script>window.BTTR = {");
  });

  it("puts the logo and the sources in the manifest", async () => {
    const manifest = (await (await fetch(`${base}/manifest.json`)).json()) as { logo?: string; description: string };
    expect(manifest.logo).toBe("https://sync.example/logo.png");
    expect(manifest.description).toMatch(/SubDL, OpenSubtitles and any subtitle addon/);
    expect((await fetch(`${base}/logo.png`)).headers.get("content-type")).toBe("image/png");
  });
});

describe("an error noted during a request that still answered", () => {
  it("puts that request under Errors in the activity, says in its detail what failed, and links to it from the error", async () => {
    const link = "fail0001/aa";
    stats.requestContext.run({ link, req: "req-one" }, () => {
      stats.noteActivity({ link, req: "req-one", kind: "list", what: "Show S01E05", result: "2 tracks, 2 synced, partial", ms: 900 });
      // A source failing after the list went out: the request's work goes on in its context.
      stats.noteError("opensubtitles", new Error("fetch failed"));
    });
    stats.noteActivity({ link, req: "req-two", kind: "list", what: "Show S01E06", result: "1 track, 1 synced", ms: 400 });
    // An error with no request id (noted before requests had them) has no row to show.
    stats.requestContext.run({ link }, () => stats.noteError("subsource", new Error("The operation was aborted due to timeout")));

    const errorsOnly = stats.activityPage({ link, kind: "error" });
    expect(errorsOnly.rows.map((r) => r.what)).toEqual(["Show S01E05"]);
    expect(errorsOnly.rows[0].failed).toEqual([{ where: "opensubtitles", message: "fetch failed" }]);
    expect((await dataNow()).activity.find((a) => a.what === "Show S01E05")?.failed).toEqual([{ where: "opensubtitles", message: "fetch failed" }]);
    // Every request of the link is still there unfiltered, the other one without a failure.
    expect(stats.activityPage({ link }).rows.find((r) => r.what === "Show S01E06")?.failed).toBeUndefined();

    // The error knows its request still answered (the server's record of it); one without a request doesn't say.
    const errors = (await dataNow()).errors;
    expect(errors.find((e) => e.message === "fetch failed")).toMatchObject({ link, answered: true });
    expect(errors.find((e) => e.message === "The operation was aborted due to timeout")?.answered).toBeUndefined();
  });
});

describe("the sources' week", () => {
  it("counts the tracks each source supplied in lists, and how much of what it served synced, and shows both", async () => {
    const zero = { picked: 0, served: 0, synced: 0 };
    const before = stats.sourceWeek()["TheSubtitleDB"] ?? zero;
    const link = "srcw0001/aa";
    stats.noteActivity({ link, kind: "list", what: "Show S01E01", result: "2 tracks, 2 synced", ms: 500, detail: { tracks: [{ lang: "Arabic", source: "TheSubtitleDB", ref: "tb1", state: "synced" }, { lang: "English", source: "SubSource", ref: "ss1", state: "synced" }] } });
    stats.noteActivity({ link, kind: "download", what: "Arabic · Show S01E01", result: "synced", ms: 20, detail: { source: "TheSubtitleDB", ref: "tb1" } });
    stats.noteActivity({ link, kind: "download", what: "Arabic · Show S01E02", result: "couldn't sync", ms: 20, detail: { source: "TheSubtitleDB", ref: "tb2" } });
    const after = stats.sourceWeek()["TheSubtitleDB"];
    expect({ picked: after.picked - before.picked, served: after.served - before.served, synced: after.synced - before.synced }).toEqual({ picked: 1, served: 2, synced: 1 });

    const sources = (await dataNow()).sources;
    expect(sources.find((x) => x.id === "thesubtitledb")).toMatchObject({ picked: after.picked, served: after.served, synced: after.synced });
    // A source that served nothing says so (the page shows a dash, not 0%).
    expect(sources.find((x) => x.id === "gestdown")?.served).toBe(0);
  });
});

describe("the dashboard's sources", () => {
  it("lists Subtitle Cat once a link has used it, with its errors by name", async () => {
    // Listed only in a week that used it.
    expect((await dataNow()).sources.some((x) => x.id === "subtitlecat")).toBe(false);
    stats.count("api.subtitlecat", 4);
    stats.count("fetch.subtitlecat", 1);
    stats.noteError("subtitlecat", new Error("search failed: HTTP 503"));
    const data = await dataNow();
    expect(data.sources.find((x) => x.id === "subtitlecat")).toMatchObject({ calls: 4, downloads: 1, picked: 0, served: 0, failures: 1 });
    expect(data.errors.find((e) => e.message === "search failed: HTTP 503")?.where).toBe("subtitlecat");
  });

  it("still opens a configuration made with the status in the track name, which is no longer a setting", async () => {
    // A link sealed while the switch existed carries it; it opens as before and the switch is simply gone.
    const old = { opensubtitles: true, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" as const, statusInName: true };
    const token = profile.sealSettings(old);
    expect(profile.openSettings(token)).toMatchObject({ languages: ["English", "Arabic"] });
    profile.noteLinkToken("4444dddd/ee33ff", token);
    stats.count("lists", 1, "4444dddd/ee33ff");
    const config = (await dataNow()).configs.find((c) => c.id === "4444dddd/ee33ff");
    expect(config).toMatchObject({ known: true });
    expect(config).not.toHaveProperty("statusInName");
  });
});
