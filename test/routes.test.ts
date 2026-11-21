import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings } from "../src/profile.js";

let base = "";
let close = () => {};
let seal: (s: Settings) => string;
let open: (t: string) => Settings | undefined;
let problem: (s: Settings) => string | undefined;

const KEY = "sk_friends_own_key_1234";
const AIO = "https://aiostreams.example.com/stremio/1234abcd-uuid/E2-encpass/manifest.json";
const settings: Settings = { subsource: KEY, aiostreams: AIO, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include" };

beforeAll(async () => {
  process.env.CONFIG_SECRET = "routes-test-secret-routes-test-secret-1";
  process.env.ALLOWED_AIOSTREAMS = "https://aiostreams.example.com";
  process.env.PUBLIC_BASE_URL = "https://sync.example";
  const profile = await import("../src/profile.js");
  seal = profile.sealSettings;
  open = profile.openSettings;
  problem = profile.settingsProblem;
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(() => close());

describe("settings in the manifest URL", () => {
  it("round-trips and hides the keys", () => {
    const token = seal(settings);
    expect(token).toMatch(/^2[A-Za-z0-9_-]+$/);
    expect(open(token)).toEqual(settings);
    expect(Buffer.from(token.slice(1), "base64url").toString("latin1")).not.toContain("sk_friends");
  });

  it("refuses altered tokens", () => {
    const token = seal(settings);
    const flipped = token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21);
    expect(open(flipped)).toBeUndefined();
    expect(open("2garbage")).toBeUndefined();
  });

  it("accepts AIOStreams URLs only from the allowed instance", () => {
    expect(problem(settings)).toBeUndefined();
    expect(problem({ ...settings, aiostreams: "https://evil.example/stremio/a/b/manifest.json" })).toMatch(/AIOStreams/);
    expect(problem({ ...settings, aiostreams: "https://aiostreams.example.com/stremio/a/b" })).toMatch(/AIOStreams/);
    expect(problem({ ...settings, aiostreams: undefined })).toBeUndefined();
    expect(problem({ ...settings, languages: [] })).toMatch(/Languages/);
    expect(problem({ ...settings, subsource: "", thesubtitledb: false, gestdown: false })).toMatch(/SubSource/);
  });

  it("holds other install URLs only of the first one's configuration, three at most", async () => {
    const copy = (n: number) => `https://aiostreams.example.com/stremio/1234abcd-uuid/E2-copy${n}/manifest.json`;
    const withCopies = { ...settings, aiostreamsAlso: [copy(1), copy(2)] };
    expect(problem(withCopies)).toBeUndefined();
    expect(open(seal(withCopies))).toEqual(withCopies);
    expect(problem({ ...settings, aiostreamsAlso: [copy(1), copy(2), copy(3), copy(4)] })).toMatch(/^Another install URL: up to 3/);
    // Another account, another instance, no first URL: none is a copy of this configuration.
    expect(problem({ ...settings, aiostreamsAlso: ["https://aiostreams.example.com/stremio/9999ffff-uuid/E2-other/manifest.json"] })).toMatch(/^Another install URL/);
    expect(problem({ ...settings, aiostreamsAlso: ["https://evil.example/stremio/1234abcd-uuid/E2-copy1/manifest.json"] })).toMatch(/^Another install URL/);
    expect(problem({ ...settings, aiostreams: undefined, aiostreamsAlso: [copy(1)] })).toMatch(/^Another install URL/);
    const { profileFromSettings } = await import("../src/profile.js");
    const { otherInstallUrls } = await import("../src/installUrls.js");
    const profile = profileFromSettings({ ...settings, aiostreamsAlso: [copy(1), AIO, copy(2)] }, seal(settings));
    expect(profile.aiostreamsAlso).toEqual([copy(1), copy(2)]);
    expect(otherInstallUrls(profile.aiostreamsUrl!)).toEqual([copy(1), copy(2)]);
    // The account's password: any characters, only with an install URL, sealed with the rest.
    const password = "a pass:word/1";
    expect(problem({ ...settings, aiostreamsPassword: password })).toBeUndefined();
    expect(open(seal({ ...settings, aiostreamsPassword: password }))?.aiostreamsPassword).toBe(password);
    expect(Buffer.from(seal({ ...settings, aiostreamsPassword: password }).slice(1), "base64url").toString("latin1")).not.toContain("pass:word");
    expect(problem({ ...settings, aiostreamsPassword: "" })).toMatch(/^AIOStreams password/);
    expect(problem({ ...settings, aiostreamsPassword: "x".repeat(257) })).toMatch(/^AIOStreams password/);
    expect(problem({ ...settings, aiostreams: undefined, aiostreamsPassword: password })).toMatch(/^AIOStreams password/);
    const { passwordOf } = await import("../src/installUrls.js");
    profileFromSettings({ ...settings, aiostreamsPassword: password }, seal(settings));
    expect(passwordOf(profile.aiostreamsUrl!)).toBe(password);
    expect(JSON.stringify(profileFromSettings({ ...settings, aiostreamsPassword: password }, seal(settings)))).not.toContain("pass:word");
    // Settings without them forget the ones noted before.
    profileFromSettings(settings, seal(settings));
    expect(otherInstallUrls(profile.aiostreamsUrl!)).toEqual([]);
    expect(passwordOf(profile.aiostreamsUrl!)).toBeUndefined();
  });
});

describe("routes", () => {
  it("serves a configurable manifest, bare and with settings", async () => {
    const bare = (await (await fetch(`${base}/manifest.json`)).json()) as { behaviorHints: Record<string, boolean> };
    expect(bare.behaviorHints).toEqual({ configurable: true, configurationRequired: true });
    const token = seal(settings);
    const mine = (await (await fetch(`${base}/${token}/manifest.json`)).json()) as { id: string; behaviorHints: Record<string, boolean> };
    expect(mine.id).toBe("bttr.subs");
    expect(mine.behaviorHints).toEqual({ configurable: true, configurationRequired: false });
  });

  it("serves the configure page, prefilled from the link without sending the keys", async () => {
    const blank = await (await fetch(`${base}/configure`)).text();
    expect(blank).toContain('"editing":false');
    expect(blank).toMatch(/<script src="\/ui\/setup\.js\?v=[0-9a-f]{10}"><\/script>/);
    const token = seal(settings);
    const page = await (await fetch(`${base}/${token}/configure`)).text();
    expect(page).toContain('"editing":true');
    // Saved keys and the AIOStreams URL: only that they're set.
    expect(page).toContain('"saved":{"aio":true,"aioAlso":0,"aioPw":false,"subsource":true,"subdl":false,"wyzie":false},"account":{"origin":"https://aiostreams.example.com","uuid":"1234abcd-uuid"}');
    expect(page).toContain('"languages":["English","Arabic"]');
    expect(page).not.toContain(KEY);
    expect(page).not.toContain("E2-encpass");
  });

  it("rejects bad settings before calling anyone", async () => {
    const response = await fetch(`${base}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subsource: KEY, aiostreams: "https://evil.example/stremio/a/b/manifest.json", languages: ["Arabic"] })
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/AIOStreams/);
  });

  it("needs sync to save, and checks each step where it is", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const noSync = await post("/configure", { opensubtitles: true, languages: ["English"] });
    expect(noSync.status).toBe(400);
    expect(((await noSync.json()) as { error: string }).error).toMatch(/^AIOStreams address: needed/);
    const sync = await post("/configure/check", { step: "sync", aiostreams: "" });
    expect(((await sync.json()) as { error: string }).error).toMatch(/^AIOStreams/);
    // The Sync step's test answers part by part, and asks AIOStreams nothing while a part is missing.
    const tested = await post("/configure/test", { aiostreamsAddress: "https://aiostreams.example.com" });
    expect([tested.status, await tested.json()]).toEqual([200, { signIn: "incomplete" }]);
    // Adding to AIOStreams is a saved configuration's own: there is none to add at the bare address.
    const unsaved = await post("/configure/add", {});
    expect(unsaved.status).toBe(404);
    const otherAccount = await post("/configure", { subsource: KEY, aiostreams: AIO, aiostreamsAlso: "https://aiostreams.example.com/stremio/9999ffff-uuid/E2-other/manifest.json", languages: ["Arabic"] });
    expect(otherAccount.status).toBe(400);
    expect(((await otherAccount.json()) as { error: string }).error).toMatch(/^Another install URL: it must be an install URL of the same AIOStreams configuration/);
    const checked = await post("/configure/check", { step: "sync", aiostreams: AIO, aiostreamsAlso: "https://aiostreams.example.com/stremio/9999ffff-uuid/E2-other/manifest.json" });
    expect(((await checked.json()) as { error: string }).error).toMatch(/^(Another install URL: it is for another AIOStreams account|AIOStreams address: that instance)/);
    const sources = await post("/configure/check", { step: "sources", opensubtitles: false, thesubtitledb: false, gestdown: false });
    expect(((await sources.json()) as { error: string }).error).toMatch(/^Sources:/);
    expect((await post("/configure/check", { step: "sources", opensubtitles: true })).status).toBe(200);
    // The free sources are on unless turned off: they alone are enough.
    expect((await post("/configure/check", { step: "sources", opensubtitles: false })).status).toBe(200);
    expect((await post("/configure/check", { step: "languages", languages: [] })).status).toBe(400);
    expect((await post("/configure/check", { step: "name", label: "Sara's TV" })).status).toBe(200);
    expect((await post("/configure/check", { step: "name", label: "<script>" })).status).toBe(400);
  });

  it("takes one to three subtitles a language, and refuses anything else", () => {
    expect(problem({ ...settings, perLanguage: 3 })).toBeUndefined();
    expect(open(seal({ ...settings, perLanguage: 2 }))?.perLanguage).toBe(2);
    for (const bad of [0, 4, 1.5, "2"]) expect(problem({ ...settings, perLanguage: bad as number }), String(bad)).toMatch(/Subtitles per language/);
  });

  it("carries a link's name, and refuses odd ones", () => {
    expect(problem({ ...settings, label: "Sara's TV" })).toBeUndefined();
    expect(problem({ ...settings, label: "a".repeat(41) })).toMatch(/^Configuration name/);
    expect(problem({ ...settings, label: "<b>" })).toMatch(/^Configuration name/);
  });

  it("gives unknown links and unconfigured subtitle requests nothing", async () => {
    expect((await fetch(`${base}/2notarealtoken/manifest.json`)).status).toBe(404);
    expect((await fetch(`${base}/subtitles/series/tt0000004:1:1.json`)).status).toBe(404);
    expect((await fetch(`${base}/not-a-thing`)).status).toBe(404);
  });
});

describe("what other sites may do with this server's answers", () => {
  it("lets any site read the manifest and the lists, and none read a page or draw one in a frame", async () => {
    const manifest = await fetch(`${base}/${seal(settings)}/manifest.json`, { headers: { origin: "https://player.example" } });
    expect(manifest.headers.get("access-control-allow-origin")).toBe("*");
    const page = await fetch(`${base}/configure`, { headers: { origin: "https://other.example" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    for (const response of [manifest, page]) {
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("what a request may name as the playing file", () => {
  it("refuses a download link whose video id, kind, file name or episode isn't one", async () => {
    const link = (query: string) => fetch(`${base}/${seal(settings)}/download/ss1/subtitle.srt?${query}`);
    for (const query of [
      "vid=tt0000004:1:1&type=..%2F..%2Fapi%2Fv1%2Fstatus%3F&file=Show.S01E01.mkv",
      "vid=tt0000004:1:1&type=channel&file=Show.S01E01.mkv",
      "vid=..%2F..%2Fx&type=series&file=Show.S01E01.mkv",
      "vid=tt0000004:1:1&type=series&file=Show%0AS01E01.mkv",
      `vid=tt0000004:1:1&type=series&file=${"a".repeat(1100)}`,
      "season=1e3&episode=1"
    ]) {
      const response = await link(query);
      expect(response.status, query).toBe(400);
    }
  });

  it("lists nothing for a kind that is neither a film nor a series, and ignores a video id in extra that isn't one", async () => {
    const other = await fetch(`${base}/${seal(settings)}/subtitles/..%2Fx/tt0000004:1:1.json`);
    expect(await other.json()).toMatchObject({ subtitles: [] });
    const { parseStremioSubtitleRequest } = await import("../src/stremio.js");
    expect(parseStremioSubtitleRequest("series", "tt0000004:1:1", { videoId: "../../x" }).id).toBe("tt0000004:1:1");
    expect(parseStremioSubtitleRequest("series", "tt0000004:1:1", { videoId: "kitsu:123:4" }).id).toBe("kitsu:123:4");
  });

  it("reads the extra segment however a client encoded it, keeping a name's plus, ampersand and percent sign", async () => {
    const { parseExtraArgs, rawExtraSegment } = await import("../src/stremio.js");
    const name = "Show - S01E07 [JA+EN] Tom & Co 100%-TEAM";
    const want = { filename: name, videoSize: "123", videoHash: "abc" };
    // Each value encoded, as players send it.
    expect(parseExtraArgs(`filename=${encodeURIComponent(name)}&videoSize=123&videoHash=abc.json`)).toEqual(want);
    // The whole segment encoded: an "&" that begins no key is part of the name.
    expect(parseExtraArgs(`${encodeURIComponent(`filename=${name}&videoSize=123&videoHash=abc`)}.json`)).toEqual(want);
    // A space written as a plus is a space; a segment that can't be decoded gives nothing.
    expect(parseExtraArgs("filename=Show+-+07.mkv")).toEqual({ filename: "Show - 07.mkv" });
    expect(parseExtraArgs("%E0%A4%A")).toEqual({});
    expect(parseExtraArgs("")).toEqual({});
    expect(rawExtraSegment("/subtitles/series/tt1%3A1%3A2/filename=a%2Bb.json")).toBe("filename=a%2Bb.json");
  });
});

describe("sources and instances in the settings", () => {
  it("needs at least one source, and SubSource is optional", () => {
    expect(problem({ ...settings, subsource: undefined, opensubtitles: true })).toBeUndefined();
    expect(problem({ ...settings, subsource: undefined, subdl: "subdl_key_123456" })).toBeUndefined();
    expect(problem({ ...settings, subsource: undefined, thesubtitledb: false, gestdown: false })).toMatch(/Sources/);
    // TheSubtitleDB or Gestdown alone is enough; Anime Tosho (anime dub captions) alone isn't.
    expect(problem({ ...settings, subsource: undefined })).toBeUndefined();
    expect(problem({ ...settings, subsource: undefined, thesubtitledb: false })).toBeUndefined();
  });
});

describe("editing a link from its configure page", () => {
  it("keeps the saved keys and AIOStreams URL when their fields are left empty", async () => {
    process.env.PUBLIC_BASE_URL = "https://sync.example";
    const { saveConfiguration } = await import("../src/configure.js");
    const { openSettings } = await import("../src/profile.js");
    const current: Settings = { subsource: KEY, subdl: "subdl_friend_key_1234", aiostreams: AIO, languages: ["English", "Arabic"], allowMachine: false, hearingImpaired: "include", label: "Den TV" };
    // The form as the page sends it: key and URL fields empty, one option switched.
    const saved = await saveConfiguration({ subsource: "", subdl: "", aiostreams: "", languages: ["English", "Arabic"], allowMachine: true, hearingImpaired: "include", label: "Den TV" }, current);
    expect("manifestUrl" in saved).toBe(true);
    const token = (saved as { manifestUrl: string }).manifestUrl.split("/").at(-2)!;
    const next = openSettings(token)!;
    expect(next.subsource).toBe(KEY);
    expect(next.subdl).toBe("subdl_friend_key_1234");
    expect(next.aiostreams).toBe(AIO);
    expect(next.allowMachine).toBe(true);
    expect(next.label).toBe("Den TV");
  });
});

describe("editing a link in place", () => {
  it("keeps the link's URL and serves the new settings from it", async () => {
    const token = seal({ ...settings, label: `Before ${Date.now()}` });
    const response = await fetch(`${base}/${token}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subsource: "", aiostreams: "", languages: ["English", "Arabic"], allowMachine: true, hearingImpaired: "include", label: "Edited" })
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { manifestUrl: string; inPlace?: boolean };
    expect(answer.inPlace).toBe(true);
    expect(answer.manifestUrl).toBe(`https://sync.example/${token}/manifest.json`);
    // The same URL now carries the edit; the keys it was made with are still there.
    const page = await (await fetch(`${base}/${token}/configure`)).text();
    expect(page).toContain('"allowMachine":true');
    expect(page).toContain('"label":"Edited"');
    expect(page).toContain('"saved":{"aio":true,"aioAlso":0,"aioPw":false,"subsource":true,"subdl":false,"wyzie":false},"account":{"origin":"https://aiostreams.example.com","uuid":"1234abcd-uuid"}');
    expect(page).not.toContain(KEY);
    expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
  });
});

describe("a link's id", () => {
  it("stays the one it was made with when an edit moves it to another AIOStreams account, edit after edit", async () => {
    const { keptLinkSettings, profileFromSettings } = await import("../src/profile.js");
    const before: Settings = { subsource: KEY, aiostreams: AIO, languages: ["Arabic"], allowMachine: false, hearingImpaired: "include", label: "Friend" };
    const moved: Settings = { ...before, aiostreams: "https://aiostreams.example.com/stremio/9876fedc-uuid/E2-other/manifest.json" };
    const id = profileFromSettings(before, "t").name;
    // Worked out afresh, the edit would give the link another id.
    expect(profileFromSettings(moved, "t").name).not.toBe(id);
    const kept = keptLinkSettings(moved, before, "t");
    expect(kept.aiostreams).toBe(moved.aiostreams);
    expect(profileFromSettings(kept, "t").name).toBe(id);
    expect(profileFromSettings(keptLinkSettings({ ...kept, label: "Friend's TV" }, kept, "t"), "t").name).toBe(id);
    // A new link is worked out as before.
    expect(profileFromSettings(moved, "u").name).toMatch(/^9876fedc\/[0-9a-f]{6}$/);
  });
});

describe("clearing the dashboard's errors", () => {
  it("refuses a form another site posts, and clears from the dashboard itself", async () => {
    const { noteError, statsView } = await import("../src/stats.js");
    noteError("sync", new Error("ffmpeg failed"));
    const { csrfOf } = await import("./dashboard-helpers.js");
    const csrf = await csrfOf(base);
    const clear = (site: string, token = csrf) =>
      fetch(`${base}/dashboard/errors/clear`, { method: "POST", headers: { "Sec-Fetch-Site": site, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: token }), redirect: "manual" });
    expect((await clear("cross-site")).status).toBe(403);
    // From the dashboard, but without the page's token (an old page, or a forged form): refused too.
    expect((await clear("same-origin", "not-the-token")).status).toBe(403);
    expect((await statsView("t")).errors.length).toBeGreaterThan(0);
    const mine = await clear("same-origin");
    expect(mine.status).toBe(303);
    expect(mine.headers.get("location")).toBe("/dashboard#errors");
    const view = await statsView("t");
    expect(view.errors).toEqual([]);
    expect(view.errorsClearedAt).toBeGreaterThan(0);
    // The day's count is history and stays.
    expect(view.days[0].total["errors.sync"]).toBeGreaterThan(0);
  });
});

describe("the dashboard's activity pages", () => {
  it("pages a week of activity 50 at a time, filtered across all of it", async () => {
    const { noteActivity, activityPage } = await import("../src/stats.js");
    for (let i = 0; i < 120; i++) noteActivity({ kind: i % 3 ? "list" : "download", what: `Item ${i}`, result: "synced", link: i % 2 ? "aaaa1111/one" : "bbbb2222/two", ms: 5 });
    const first = activityPage();
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0].what).toBe("Item 119"); // newest first
    expect(activityPage({ offset: 100 }).rows.length).toBeGreaterThan(0);
    // Past the end lands on the last page, never an empty one.
    // Past the end it shows the last row; a page starts exactly where the last one ended (pages are cut
    // by height in the browser, so 11 must stay 11, not snap back to 0).
    expect(activityPage({ offset: 10_000 }).offset).toBe(first.total - 1);
    expect(activityPage({ offset: 11 }).offset).toBe(11);
    expect(activityPage({ offset: 11 }).rows[0].what).toBe(first.rows[11].what);
    const one = activityPage({ link: "aaaa1111/one", kind: "download" });
    expect(one.rows.every((a) => a.link === "aaaa1111/one" && a.kind === "download")).toBe(true);
    expect(one.total).toBe(20);
    // The dashboard gets the whole week at once, and pages and filters it in the browser.
    const data = (await (await fetch(`${base}/dashboard/data`)).json()) as { activity: Array<{ link: string; what: string }> };
    expect(data.activity.filter((a) => a.what.startsWith("Item ")).length).toBe(120);
    expect(data.activity.filter((a) => a.link === "aaaa1111/one" && a.what.startsWith("Item ")).length).toBe(60);
  });
});

describe("errors the owner can trace and undo", () => {
  it("keep the link and title they happened on, and a clear can be undone", async () => {
    const stats = await import("../src/stats.js");
    stats.requestContext.run({ link: "cccc3333/three" }, () => stats.noteError("request", new Error("SubSource 503 for /subtitles"), "English Dub · Show S2 - 01"));
    const noted = (await stats.statsView("t")).errors.find((e) => e.message.startsWith("SubSource 503"));
    expect(noted).toMatchObject({ link: "cccc3333/three", what: "English Dub · Show S2 - 01" });
    await stats.clearErrors();
    expect((await stats.statsView("t")).errors).toEqual([]);
    expect(stats.canUndoClear()).toBe(true);
    const { csrfOf } = await import("./dashboard-helpers.js");
    const undo = await fetch(`${base}/dashboard/errors/clear?undo=1`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": await csrfOf(base) }, redirect: "manual" });
    expect(undo.status).toBe(303);
    expect((await stats.statsView("t")).errors.some((e) => e.message.startsWith("SubSource 503"))).toBe(true);
    expect(stats.canUndoClear()).toBe(false);
  });

  it("filter activity to errors, and count how this week's subtitles came out", async () => {
    const stats = await import("../src/stats.js");
    stats.noteActivity({ kind: "download", what: "A", result: "synced", link: "dddd4444/four", ms: 1 });
    stats.noteActivity({ kind: "download", what: "B", result: "synced (audio)", link: "dddd4444/four", ms: 1 });
    stats.noteActivity({ kind: "download", what: "C", result: "couldn't sync", link: "dddd4444/four", ms: 1 });
    stats.noteActivity({ kind: "download", what: "D", result: "error 500", link: "dddd4444/four", ms: 1 });
    const errorsOnly = stats.activityPage({ link: "dddd4444/four", kind: "error" });
    expect(errorsOnly.rows.map((a) => a.what)).toEqual(["D"]);
    const out = stats.syncOutcomes();
    expect(out.synced).toBeGreaterThanOrEqual(2);
    expect(out.byAudio).toBeGreaterThanOrEqual(1);
    expect(out.failed).toBeGreaterThanOrEqual(1);
  });
});

describe("signing in (ADDON_PASSWORD, ADMIN_PASSWORD)", () => {
  const login = (password: string, next: string, ip = "10.0.0.1") =>
    fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip }, body: new URLSearchParams({ password, next }) });
  const session = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
  const html = { Accept: "text/html" };

  async function withPasswords(run: () => Promise<void>) {
    const { config } = await import("../src/config.js");
    config.addonPassword = "addon-pass";
    config.adminPassword = "admin-pass";
    try {
      await run();
    } finally {
      config.addonPassword = undefined;
      config.adminPassword = undefined;
    }
  }

  it("sends pages to the login page and back, never the addon paths", () =>
    withPasswords(async () => {
      const token = seal(settings);
      const page = await fetch(`${base}/${token}/configure`, { redirect: "manual", headers: html });
      expect(page.status).toBe(303);
      expect(page.headers.get("location")).toBe(`/login?${new URLSearchParams({ next: `/${token}/configure` })}`);
      expect((await fetch(`${base}/dashboard`, { redirect: "manual", headers: html })).headers.get("location")).toMatch(/^\/login\?next=%2Fdashboard&for=admin$/);
      // A page's own script gets 401 instead of a redirect.
      expect((await fetch(`${base}/configure/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
      expect((await fetch(`${base}/manifest.json`)).status).toBe(200);
      expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
      const form = await fetch(`${base}/login?next=/configure`);
      expect(await form.text()).toContain('name="password"');
    }));

  it("opens link setup with the addon password, and everything with the admin password", () =>
    withPasswords(async () => {
      const addon = await login("addon-pass", "/configure");
      expect(addon.status).toBe(303);
      expect(addon.headers.get("location")).toBe("/configure");
      expect(addon.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
      expect((await fetch(`${base}/configure`, { headers: { Cookie: session(addon) } })).status).toBe(200);
      expect((await fetch(`${base}/dashboard`, { redirect: "manual", headers: { ...html, Cookie: session(addon) } })).status).toBe(303);
      expect((await login("addon-pass", "/dashboard")).status).toBe(403);
      const admin = await login("admin-pass", "/dashboard");
      expect(admin.headers.get("location")).toBe("/dashboard");
      expect((await fetch(`${base}/dashboard`, { headers: { Cookie: session(admin) } })).status).toBe(200);
      expect((await fetch(`${base}/configure`, { headers: { Cookie: session(admin) } })).status).toBe(200);
    }));

  it("refuses forged or altered sessions, and goes back only to this site", () =>
    withPasswords(async () => {
      const { sessionValue } = await import("../src/access.js");
      const real = sessionValue(["addon"]);
      const [body, mac] = real.split(".");
      const forged = `${Buffer.from(JSON.stringify({ r: ["admin"], e: Date.now() + 1e9 })).toString("base64url")}.${mac}`;
      expect((await fetch(`${base}/configure`, { redirect: "manual", headers: { ...html, Cookie: `bttr_session=${forged}` } })).status).toBe(303);
      expect((await fetch(`${base}/configure`, { headers: { Cookie: `bttr_session=${body}.${mac}` } })).status).toBe(200);
      expect((await login("addon-pass", "https://evil.example/")).headers.get("location")).toBe("/configure");
      expect((await login("addon-pass", "//evil.example/")).headers.get("location")).toBe("/configure");
    }));

  it("slows down wrong passwords and stops them after five", () =>
    withPasswords(async () => {
      for (let i = 0; i < 5; i++) expect((await login("wrong", "/configure", "10.9.9.9")).status).toBe(401);
      // Even the right one is refused from that address for now; another address is fine.
      expect((await login("addon-pass", "/configure", "10.9.9.9")).status).toBe(429);
      expect((await login("addon-pass", "/configure", "10.8.8.8")).status).toBe(303);
    }), 20000);

  it("logs out, and shows the button only to someone signed in", async () => {
    const out = await fetch(`${base}/logout`, { method: "POST", redirect: "manual" });
    expect(out.headers.get("set-cookie")).toMatch(/^bttr_session=; Path=\/; Max-Age=0/);
    const { config } = await import("../src/config.js");
    config.adminPassword = "admin-pass";
    try {
      // Setup stays open with only the admin password set, and a friend there sees no Log out.
      const open = await fetch(`${base}/configure`);
      expect(open.status).toBe(200);
      expect(await open.text()).not.toContain('action="/logout"');
      const admin = await login("admin-pass", "/configure", "10.7.7.7");
      expect(await (await fetch(`${base}/configure`, { headers: { Cookie: session(admin) } })).text()).toContain('action="/logout"');
      expect(await (await fetch(`${base}/dashboard`, { headers: { Cookie: session(admin) } })).text()).toContain('action="/logout"');
    } finally {
      config.adminPassword = undefined;
    }
  });
});

describe("the link the dashboard's Edit opens", () => {
  it("isn't changed by opening a link's configure page or manifest", async () => {
    const { knownLinks } = await import("../src/profile.js");
    const copy = seal({ ...settings, languages: ["English"] });
    const before = JSON.stringify(knownLinks());
    expect((await fetch(`${base}/${copy}/configure`)).status).toBe(200);
    expect((await fetch(`${base}/${copy}/manifest.json`)).status).toBe(200);
    expect(JSON.stringify(knownLinks())).toBe(before);
  });
});

describe("the configure page's words", () => {
  it("name every source, show the labels players get, and say Subtitle Cat needs company", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../assets/ui/setup.js", import.meta.url), "utf8");
    // Every source by name, each with its own icon from this server.
    for (const name of ["OpenSubtitles", "TheSubtitleDB", "Gestdown", "Anime Tosho", "Subtitle Cat", "SubSource API key", "SubDL API key", "Other subtitle addons"]) expect(html).toContain(name);
    expect(html).toContain("English<small>Dub · Synced · BttrSubs</small>");
    expect(html).not.toContain("English Dub<small>");
    expect(html).toContain("works beside at least one other source");
    // The track keeps the language alone, so players pick it by language: no switch to put the status in the name.
    expect(html).not.toContain("Status in the track name");
    // Named as AIOStreams names them: a configuration, its install URL; the mark goes to the intro.
    expect(html).toContain("Create configuration");
    expect(html).toContain("Copy install URL");
    expect(html).not.toMatch(/Create my link|Copy link|Set up your link/);
    expect(await (await fetch(`${base}/configure`)).text()).toContain('<a class="brand" href="#" aria-label="BttrSubs, what it does">');
    expect(problem({ ...settings, subsource: undefined, subtitlecat: true, thesubtitledb: false, gestdown: false })).toBe("Sources: Subtitle Cat and Anime Tosho need another source beside them. Add a SubSource, SubDL or Wyzie Subs key, turn on OpenSubtitles, TheSubtitleDB or Gestdown, or add an addon");
    expect(problem({ ...settings, subsource: undefined, thesubtitledb: false, gestdown: false, animetosho: false })).toBe("Sources: Add a SubSource, SubDL or Wyzie Subs key, turn on OpenSubtitles, TheSubtitleDB or Gestdown, or add an addon");
  });
});

describe("the sources' icons", () => {
  it("are served from this server, cached, and only the known ones", async () => {
    const icon = await fetch(`${base}/sources/subdl.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/sources/nope.png`)).status).toBe(404);
    expect((await fetch(`${base}/sources/..%2Fbttr-subs-logo-512.png`)).status).toBe(404);
    // The pages point at them here, never at the sources' own sites.
    const { readFileSync } = await import("node:fs");
    for (const script of ["setup.js", "dashboard.js"]) {
      const text = readFileSync(new URL(`../assets/ui/${script}`, import.meta.url), "utf8");
      expect(text).toContain('src="/sources/${id}.png?v=2"');
      expect(text).not.toMatch(/<img[^>]+src="https?:/);
    }
  });
});
