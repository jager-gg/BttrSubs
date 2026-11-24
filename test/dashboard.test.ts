/**
 * The dashboard at /dashboard, its server settings (settings.ts) and
 * managing links from it (profile.ts): who may change what, from where, and what each change does.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DashboardData } from "../src/dashboardData.js";
import type { Settings } from "../src/profile.js";

const CACHE = ".cache-dashboard-test";
const ENV = { CONFIG_SECRET: "dashboard-test-secret-dashboard-test-1", CACHE_DIR: CACHE, PUBLIC_BASE_URL: "https://sync.example", ALLOWED_AIOSTREAMS: "https://aiostreams.example.com", TIME_ZONE: "Europe/London", DAILY_READ_GB: "20", LIST_BUDGET_MS: "5000", PRIVATE_STREAM_HOSTS: "proxy.lan:8080" };
const ADMIN = "admin-pass-for-tests";

let base = "";
let close = () => {};
let profile: typeof import("../src/profile.js");
let settings: typeof import("../src/settings.js");
let stats: typeof import("../src/stats.js");
let access: typeof import("../src/access.js");
let config: (typeof import("../src/config.js"))["config"];
/** The app's own log files module (a test further down resets the module registry). */
let logs: typeof import("../src/logs.js");
let reads: typeof import("../src/reads.js");

/** A link made by the code's own functions, with placeholder keys and names. */
function makeLink(uuid: string, extra: Partial<Settings> = {}): { token: string; id: string } {
  const token = profile.sealSettings({
    subsource: `sk_placeholder_${uuid}_key`,
    aiostreams: `https://aiostreams.example.com/stremio/${uuid}-0000-placeholder/E2-placeholder/manifest.json`,
    languages: ["English", "Arabic"],
    allowMachine: false,
    hearingImpaired: "include",
    ...extra
  });
  const id = profile.profileFromSettings(profile.openSettings(token)!, token).name;
  // What a player's request does: the dashboard learns the link's token by its id.
  profile.noteLinkToken(id, token);
  return { token, id };
}

/** Each test's own address, so the per-address limits of one never touch another. */
let lastIp = 10;
const nextIp = () => `10.20.0.${++lastIp}`;

/** A change as the dashboard's own script makes it: same origin, the page's CSRF token, JSON. */
async function change(url: string, body: unknown, opts: { cookie?: string; csrf?: string; site?: string; ip?: string } = {}) {
  const csrf = opts.csrf ?? (await csrfOf(opts.cookie));
  return fetch(`${base}${url}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "Sec-Fetch-Site": opts.site ?? "same-origin",
      "X-CSRF-Token": csrf,
      "X-Forwarded-For": opts.ip ?? nextIp(),
      ...(opts.cookie ? { Cookie: opts.cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

async function csrfOf(cookie?: string): Promise<string> {
  const html = await (await fetch(`${base}/dashboard`, { headers: cookie ? { Cookie: cookie } : {} })).text();
  return html.match(/<meta name="csrf" content="([^"]*)">/)?.[1] ?? "";
}

/** The dashboard's data, as its page draws it and fetches it again after a change. */
async function dataOf(cookie?: string): Promise<DashboardData> {
  return (await (await fetch(`${base}/dashboard/data`, { headers: cookie ? { Cookie: cookie } : {} })).json()) as DashboardData;
}

beforeAll(async () => {
  Object.assign(process.env, ENV);
  [profile, settings, stats, access] = await Promise.all([import("../src/profile.js"), import("../src/settings.js"), import("../src/stats.js"), import("../src/access.js")]);
  config = (await import("../src/config.js")).config;
  logs = await import("../src/logs.js");
  reads = await import("../src/reads.js");
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(async () => {
  close();
  for (const name of Object.keys(ENV)) delete process.env[name];
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

describe("the dashboard's address", () => {
  it("is /dashboard, a page its script draws from the data written into it", async () => {
    const shown = await fetch(`${base}/dashboard`);
    expect(shown.status).toBe(200);
    const html = await shown.text();
    expect(html).toContain("<title>BttrSubs · Dashboard</title>");
    expect(html).toContain("<script>window.BTTR = {");
    for (const section of ["overview", "keys", "activity", "configs", "errors", "settings"]) expect(html).toContain(`id="p-${section}"`);
    expect(html).toMatch(/<script src="\/ui\/dashboard\.js\?v=[0-9a-f]{10}"><\/script>/);
  });

  it("links to it from the configure page, signed in or not (a home-screen app has no address bar)", async () => {
    const owner = `bttr_session=${access.sessionValue(["admin", "addon"])}`;
    expect(await (await fetch(`${base}/configure`, { headers: { Cookie: owner } })).text()).toContain('href="/dashboard"');
    expect(await (await fetch(`${base}/configure`)).text()).toContain('href="/dashboard"');
  });
});

describe("settings", () => {
  const view = (key: string) => settings.settingsView().find((s) => s.key === key)!;

  it("say where each value comes from: .env, else the default", () => {
    expect(view("timeZone")).toMatchObject({ source: ".env", value: "Europe/London", resetTo: ".env" });
    expect(view("dailyReadGb")).toMatchObject({ source: ".env", value: 20 });
    expect(view("resultCacheTtlSeconds")).toMatchObject({ source: "default", value: 21600, resetTo: "default" });
    expect(view("allowedAiostreams")).toMatchObject({ source: ".env", value: "https://aiostreams.example.com" });
    expect(view("addonPassword")).toMatchObject({ source: "default", value: false });
  });

  it("save over .env, apply at once, and are written whole to the cache volume", async () => {
    const response = await change("/dashboard/settings", { set: { timeZone: "Asia/Tokyo", dailyReadGb: "7.5" } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: string[]; settings: DashboardData["settings"] };
    expect(body.changed.sort()).toEqual(["dailyReadGb", "timeZone"]);
    expect(body.settings.find((x) => x.key === "timeZone")).toMatchObject({ value: "Asia/Tokyo", source: "dashboard" });
    expect(config.timeZone).toBe("Asia/Tokyo");
    expect(config.dailyReadBytes).toBe(7.5e9);
    expect(view("timeZone")).toMatchObject({ source: "dashboard", resetValue: "Europe/London" });
    const file = path.join(process.cwd(), CACHE, "settings.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ timeZone: "Asia/Tokyo", dailyReadGb: 7.5 });
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("are checked as config.ts reads them, and one bad value saves nothing", async () => {
    const before = readFileSync(path.join(process.cwd(), CACHE, "settings.json"), "utf8");
    const bad = async (set: Record<string, unknown>, field: string) => {
      const response = await change("/dashboard/settings", { set });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { field: string }).field).toBe(field);
    };
    await bad({ timeZone: "Mars/Olympus_Mons" }, "timeZone");
    await bad({ resultCacheTtlSeconds: "3600", timeZone: "Nowhere/Land" }, "timeZone");
    await bad({ dailyReadGb: "-1" }, "dailyReadGb");
    await bad({ dailyReadGb: "lots" }, "dailyReadGb");
    await bad({ resultCacheTtlSeconds: "10" }, "resultCacheTtlSeconds");
    await bad({ resultCacheTtlSeconds: "90.5" }, "resultCacheTtlSeconds");
    await bad({ allowedAiostreams: "https://aiostreams.example.com/stremio" }, "allowedAiostreams");
    await bad({ allowedAiostreams: "ftp://files.example" }, "allowedAiostreams");
    await bad({ ownAiostreams: "https://a.example\nhttps://b.example" }, "ownAiostreams");
    await bad({ aiostreamsBase: "http://user:pass@aiostreams:3000" }, "aiostreamsBase");
    expect((await change("/dashboard/settings", { set: { port: "8000" } })).status).toBe(400);
    expect((await change("/dashboard/settings", { set: { configSecret: "x".repeat(40) } })).status).toBe(400);
    expect(readFileSync(path.join(process.cwd(), CACHE, "settings.json"), "utf8")).toBe(before);
    expect(config.resultCacheTtlSeconds).toBe(21600);
  });

  it("keep following .env where nothing was changed, and reset back to it", async () => {
    // The value already in force isn't saved, so the field keeps following .env.
    const same = await change("/dashboard/settings", { set: { resultCacheTtlSeconds: "21600", allowedAiostreams: "HTTPS://AIOStreams.example.com/" } });
    expect(((await same.json()) as { changed: string[] }).changed).toEqual([]);
    expect(view("resultCacheTtlSeconds").source).toBe("default");
    expect(view("allowedAiostreams").source).toBe(".env");
    const reset = await change("/dashboard/settings", { reset: ["timeZone", "dailyReadGb"] });
    expect(((await reset.json()) as { changed: string[] }).changed.sort()).toEqual(["dailyReadGb", "timeZone"]);
    expect(config.timeZone).toBe("Europe/London");
    expect(config.dailyReadGb).toBe(20);
    expect(view("timeZone").source).toBe(".env");
    expect((await change("/dashboard/settings", { reset: ["nope"] })).status).toBe(400);
  });

  it("read settings.json at start, leaving out a value that doesn't pass", async () => {
    const file = path.join(process.cwd(), CACHE, "settings.json");
    writeFileSync(file, JSON.stringify({ timeZone: "America/New_York", dailyReadGb: -5, resultCacheTtlSeconds: 600 }));
    vi.resetModules();
    const fresh = await import("../src/settings.js");
    const freshConfig = (await import("../src/config.js")).config;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fresh.loadSettings();
    warn.mockRestore();
    expect(freshConfig.timeZone).toBe("America/New_York");
    expect(freshConfig.resultCacheTtlSeconds).toBe(600);
    expect(freshConfig.dailyReadGb).toBe(20); // the bad value is left out: .env's applies
    expect(fresh.settingsView().find((s) => s.key === "dailyReadGb")?.source).toBe(".env");
    writeFileSync(file, "{}");
  });

  it("change which AIOStreams instances are accepted, live, for links already made", async () => {
    const { token } = makeLink("aaaa0001");
    expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
    expect((await change("/dashboard/settings", { set: { allowedAiostreams: "https://other.example\nhttps://another.example" } })).status).toBe(200);
    expect(config.allowedAiostreams).toEqual(["https://other.example", "https://another.example"]);
    expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(404);
    // This server's own counts as accepted too.
    expect((await change("/dashboard/settings", { set: { ownAiostreams: "https://aiostreams.example.com" } })).status).toBe(200);
    expect(config.aiostreamsBase).toBe("https://aiostreams.example.com");
    expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
    await change("/dashboard/settings", { reset: ["allowedAiostreams", "ownAiostreams"] });
    expect(config.allowedAiostreams).toEqual(["https://aiostreams.example.com"]);
    expect(config.ownAiostreams).toBeUndefined();
    expect(config.aiostreamsBase).toBe("http://aiostreams:3000");
  });

  it("set the configure page's password as a hash, never shown or logged, and turn it off", async () => {
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.join(" ")));
    try {
      expect((await change("/dashboard/settings", { set: { addonPassword: { password: "short" } } })).status).toBe(400);
      const set = await change("/dashboard/settings", { set: { addonPassword: { password: "friends-pass-123" } } });
      expect(set.status).toBe(200);
      expect(await set.text()).not.toContain("friends-pass-123");
    } finally {
      log.mockRestore();
    }
    expect(logged.join("\n")).toContain("settings changed (addonPassword)");
    expect(logged.join("\n")).not.toContain("friends-pass-123");
    const stored = readFileSync(path.join(process.cwd(), CACHE, "settings.json"), "utf8");
    expect(stored).not.toContain("friends-pass-123");
    expect(JSON.parse(stored).addonPassword.scrypt).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    expect(view("addonPassword")).toMatchObject({ source: "dashboard", value: true });
    // The configure page now asks for it, and it signs in there.
    expect((await fetch(`${base}/configure`, { redirect: "manual", headers: { Accept: "text/html" } })).status).toBe(303);
    const login = (password: string) =>
      fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": nextIp() }, body: new URLSearchParams({ password, next: "/configure" }) });
    const ok = await login("friends-pass-123");
    expect(ok.status).toBe(303);
    expect((await fetch(`${base}/configure`, { headers: { Cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0] } })).status).toBe(200);
    expect((await login("friends-pass-124")).status).toBe(401);
    // Off: open again.
    expect((await change("/dashboard/settings", { set: { addonPassword: { off: true } } })).status).toBe(200);
    expect((await fetch(`${base}/configure`, { redirect: "manual" })).status).toBe(200);
    // Reset: back to .env, which sets none here.
    await change("/dashboard/settings", { reset: ["addonPassword"] });
    expect(view("addonPassword").source).toBe("default");
  }, 20000);

  it("count a day's API calls as calls: not the milliseconds Anime Tosho's requests took, nor failures or a share counted twice", async () => {
    const { apiCallsIn } = await import("../src/dashboardData.js");
    expect(apiCallsIn({ "api.animetosho": 55, "api.animetosho.waitMs": 165_380, "api.animetosho.answerMs": 101_208, "api.subsource": 53, "api.subsource.fail": 2, "api.aiostreams": 29, "api.aiostreams.forViewer": 29, "api.aiostreams.jellyfin": 3, "api.opensubtitles.own": 11, "api.anidb": 4, "api.anidb.heldBack": 1, "api.anidb.stopped": 1, lists: 29 })).toBe(55 + 53 + 29 + 3 + 11 + 4);
  });

  it("show the .env-only settings as set or not, never their values", async () => {
    const data = await dataOf();
    expect(data.envOnly).toEqual([
      { env: "CONFIG_SECRET", set: true },
      { env: "ADMIN_PASSWORD", set: false },
      { env: "PUBLIC_BASE_URL", set: true },
      { env: "CACHE_DIR", set: true },
      { env: "CAPTIONS_DIR", set: false },
      { env: "PORT", set: false }
    ]);
    const page = `${await (await fetch(`${base}/dashboard`)).text()}${JSON.stringify(data)}`;
    expect(page).not.toContain(ENV.CONFIG_SECRET);
    expect(page).not.toContain("sync.example");
    expect(page).not.toContain(CACHE);
    // None of them is a setting the page can change.
    expect(data.settings.map((x) => x.key)).not.toEqual(expect.arrayContaining(["configSecret", "adminPassword", "publicBaseUrl", "cacheDir", "port"]));
  });
});

describe("the settings that were only in .env", () => {
  const view = (key: string) => settings.settingsView().find((s) => s.key === key)!;
  const set = (values: Record<string, unknown>) => change("/dashboard/settings", { set: values });
  const reset = (...keys: string[]) => change("/dashboard/settings", { reset: keys });
  const refused = async (values: Record<string, unknown>, field: string) => {
    const response = await set(values);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe(field);
  };
  const settingsFile = () => path.join(process.cwd(), CACHE, "settings.json");

  it("start from .env or their defaults", () => {
    expect(view("listBudgetMs")).toMatchObject({ env: "LIST_BUDGET_MS", source: ".env", value: 5000, resetTo: ".env" });
    expect(view("privateStreamHosts")).toMatchObject({ env: "PRIVATE_STREAM_HOSTS", source: ".env", value: "proxy.lan:8080" });
    expect(view("anidbClient")).toMatchObject({ env: "ANIDB_CLIENT", source: "default", value: "" });
    expect(view("anidbClientVer")).toMatchObject({ env: "ANIDB_CLIENT_VER", source: "default", value: 0 });
    expect(view("animeTitlesDataset")).toMatchObject({ env: "ANIME_TITLES_DATASET", source: "default", value: true });
    expect(view("logDays")).toMatchObject({ env: "LOG_DAYS", source: "default", value: 7 });
    expect(view("logMaxMb")).toMatchObject({ env: "LOG_MAX_MB", source: "default", value: 50 });
  });

  it("take OpenSubtitles' API key, use it at once, and never show or log it", async () => {
    const KEY = "TestKeyAbc0123456789defTESTKEY99";
    expect(view("openSubtitlesApiKey")).toMatchObject({ env: "OPENSUBTITLES_API_KEY", source: "default", value: false, resetValue: "off" });
    for (const bad of ["short", "has a space in it", "x".repeat(129)]) await refused({ openSubtitlesApiKey: bad }, "openSubtitlesApiKey");
    // None set and none given: nothing to save.
    expect(((await (await set({ openSubtitlesApiKey: "" })).json()) as { changed?: string[] }).changed ?? []).not.toContain("openSubtitlesApiKey");
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.join(" ")));
    let answer = "";
    try {
      const saved = await set({ openSubtitlesApiKey: ` ${KEY} ` });
      expect(saved.status).toBe(200);
      answer = await saved.text();
    } finally {
      log.mockRestore();
    }
    expect(config.openSubtitlesApiKey).toBe(KEY);
    expect(view("openSubtitlesApiKey")).toMatchObject({ source: "dashboard", value: true });
    const data = await dataOf();
    expect(data.settings.find((s) => s.key === "openSubtitlesApiKey")).toMatchObject({ kind: "key", group: "Subtitle sources", value: "", set: true });
    const page = await (await fetch(`${base}/dashboard`)).text();
    for (const shown of [answer, JSON.stringify(data), page, logged.join("\n")]) expect(shown).not.toContain(KEY);
    expect(logged.join("\n")).toContain("openSubtitlesApiKey");
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).openSubtitlesApiKey).toBe(KEY);
    await reset("openSubtitlesApiKey");
    expect(config.openSubtitlesApiKey).toBeUndefined();
    expect(view("openSubtitlesApiKey")).toMatchObject({ source: "default", value: false });
  });

  it("set how long a list may take, in whole milliseconds from 2,000 to 20,000", async () => {
    for (const bad of ["1999", "20001", "4000.5", "soon", ""]) await refused({ listBudgetMs: bad }, "listBudgetMs");
    expect(config.listBudgetMs).toBe(5000);
    expect((await set({ listBudgetMs: "6000" })).status).toBe(200);
    expect(config.listBudgetMs).toBe(6000);
    expect(view("listBudgetMs")).toMatchObject({ source: "dashboard", resetValue: "5000" });
    for (const edge of ["2000", "20000"]) expect((await set({ listBudgetMs: edge })).status).toBe(200);
    expect(config.listBudgetMs).toBe(20_000);
    await reset("listBudgetMs");
    expect(config.listBudgetMs).toBe(5000);
    expect(view("listBudgetMs").source).toBe(".env");
  });

  it("name the private hosts a file may be read from: names and addresses with or without a port, nothing else", async () => {
    const file = "http://192.168.1.9:8080/file.mkv";
    await expect(reads.checkReadable(file)).rejects.toThrow(reads.PrivateHost);
    const bad = ["http://proxy.lan", "proxy.lan/path", "*.lan", "proxy.lan:0", "proxy.lan:70000", "user@proxy.lan", "0x7f.1", "8080", "[::1", "[0:0:0:0:0:0:0:1]", "-proxy.lan", "proxy..lan", "proxy.lan?x=1", "proxy.lan#x"];
    for (const host of bad) await refused({ privateStreamHosts: `proxy.lan\n${host}` }, "privateStreamHosts");
    await refused({ privateStreamHosts: Array.from({ length: 21 }, (_, i) => `host${i}.lan`).join("\n") }, "privateStreamHosts");
    await refused({ privateStreamHosts: 7 }, "privateStreamHosts");
    // A link-local address is a cloud host's own metadata, never a stream.
    for (const host of ["169.254.169.254", "169.254.169.254:80", "[fe80::1]"]) await refused({ privateStreamHosts: host }, "privateStreamHosts");
    expect(config.privateStreamHosts).toEqual(["proxy.lan:8080"]);
    expect((await set({ privateStreamHosts: "Proxy.LAN\n192.168.1.9:8080, [fd00::1]:8080 stream_proxy proxy.lan" })).status).toBe(200);
    expect(config.privateStreamHosts).toEqual(["proxy.lan", "192.168.1.9:8080", "[fd00::1]:8080", "stream_proxy"]);
    await expect(reads.checkReadable(file)).resolves.toBeUndefined();
    await expect(reads.checkReadable("http://[fd00::1]:8080/file.mkv")).resolves.toBeUndefined();
    await expect(reads.checkReadable("http://192.168.1.9:9090/file.mkv")).rejects.toThrow(reads.PrivateHost);
    // None at all, though .env names one.
    expect((await set({ privateStreamHosts: "" })).status).toBe(200);
    expect(config.privateStreamHosts).toEqual([]);
    expect(view("privateStreamHosts")).toMatchObject({ source: "dashboard", value: "", resetValue: "proxy.lan:8080" });
    await reset("privateStreamHosts");
    expect(config.privateStreamHosts).toEqual(["proxy.lan:8080"]);
    await expect(reads.checkReadable(file)).rejects.toThrow(reads.PrivateHost);
  });

  it("set AniDB's client as a name and a version, both or neither", async () => {
    for (const bad of ["MyClient", "my-client", "my client", "a".repeat(33), 5]) await refused({ anidbClient: bad, anidbClientVer: "1" }, "anidbClient");
    for (const bad of ["1.5", "0x1", "-1", "1000000", "one"]) await refused({ anidbClient: "myclient", anidbClientVer: bad }, "anidbClientVer");
    // One without the other saves nothing, and says which is missing.
    await refused({ anidbClient: "myclient" }, "anidbClientVer");
    await refused({ anidbClientVer: "2" }, "anidbClient");
    expect(config.anidbClient).toBeUndefined();
    expect(config.anidbClientVer).toBeUndefined();
    const saved = await set({ anidbClient: "myclient", anidbClientVer: "2" });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { changed: string[]; settingsStatus: DashboardData["settingsStatus"] };
    expect(body.changed.sort()).toEqual(["anidbClient", "anidbClientVer"]);
    expect(body.settingsStatus.anidb).toMatchObject({ configured: true, dailyMax: 100, stoppedForMs: 0 });
    expect(config.anidbClient).toBe("myclient");
    expect(config.anidbClientVer).toBe(2);
    // The version alone can change while a name is set; the name can't go while the version stays.
    expect((await set({ anidbClientVer: "3" })).status).toBe(200);
    expect(config.anidbClientVer).toBe(3);
    await refused({ anidbClient: "" }, "anidbClient");
    expect((await set({ anidbClient: "", anidbClientVer: "" })).status).toBe(200);
    expect(config.anidbClient).toBeUndefined();
    expect(config.anidbClientVer).toBeUndefined();
    // Resetting one resets both.
    await set({ anidbClient: "other", anidbClientVer: "1" });
    expect(((await (await reset("anidbClientVer")).json()) as { changed: string[] }).changed.sort()).toEqual(["anidbClient", "anidbClientVer"]);
    expect(view("anidbClient")).toMatchObject({ source: "default", value: "" });
    expect((await dataOf()).settingsStatus.anidb.configured).toBe(false);
  });

  it("turn the anime titles dataset off and on", async () => {
    await refused({ animeTitlesDataset: "maybe" }, "animeTitlesDataset");
    expect((await set({ animeTitlesDataset: "off" })).status).toBe(200);
    expect(config.animeTitlesDataset).toBe(false);
    expect(view("animeTitlesDataset")).toMatchObject({ source: "dashboard", value: false, resetValue: "on" });
    expect((await set({ animeTitlesDataset: true })).status).toBe(200);
    expect(config.animeTitlesDataset).toBe(true);
    await reset("animeTitlesDataset");
    expect(view("animeTitlesDataset").source).toBe("default");
  });

  it("set the log files' days and size, and the files follow without a restart", async () => {
    for (const bad of ["91", "-1", "2.5", "many"]) await refused({ logDays: bad }, "logDays");
    for (const bad of ["0", "0.5", "10001", "big"]) await refused({ logMaxMb: bad }, "logMaxMb");
    const dir = path.join(process.cwd(), CACHE, "logs-live");
    const day = (ago: number) => path.join(dir, `bttrsubs-${new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10)}.log`);
    logs.startLogFiles({ dir, days: 7, maxBytes: 1e6 });
    try {
      writeFileSync(day(5), "an older day\n");
      writeFileSync(day(1), "yesterday\n");
      console.log("settings test: today's first line");
      await logs.logFilesWritten();
      expect((await dataOf()).logs).toMatchObject({ days: 3, keepDays: 7 });
      // Fewer days: the older file goes now.
      expect((await set({ logDays: "2", logMaxMb: "12.5" })).status).toBe(200);
      expect(config.logDays).toBe(2);
      expect(config.logMaxMb).toBe(12.5);
      expect(existsSync(day(5))).toBe(false);
      expect(existsSync(day(1))).toBe(true);
      expect((await dataOf()).logs).toMatchObject({ days: 2, keepDays: 2 });
      // None: writing stops, the files stay. Days again: it starts.
      expect((await set({ logDays: "0" })).status).toBe(200);
      expect((await dataOf()).logs).toBeNull();
      expect(existsSync(day(1))).toBe(true);
      expect((await set({ logDays: "5" })).status).toBe(200);
      console.log("settings test: written again");
      await logs.logFilesWritten();
      expect((await dataOf()).logs).toMatchObject({ keepDays: 5 });
      expect(readFileSync(day(0), "utf8")).toContain("settings test: written again");
    } finally {
      await logs.stopLogFiles();
      await reset("logDays", "logMaxMb");
    }
    expect(config.logDays).toBe(7);
    expect(config.logMaxMb).toBe(50);
  });

  it("are read from settings.json at start, each checked again", async () => {
    writeFileSync(settingsFile(), JSON.stringify({ listBudgetMs: 99_999, privateStreamHosts: ["ok.lan", "bad/host"], anidbClient: "kept", anidbClientVer: 4, animeTitlesDataset: false, logDays: 3, logMaxMb: 0 }));
    vi.resetModules();
    const fresh = await import("../src/settings.js");
    const freshConfig = (await import("../src/config.js")).config;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fresh.loadSettings();
    warn.mockRestore();
    expect(freshConfig.listBudgetMs).toBe(5000);
    expect(freshConfig.privateStreamHosts).toEqual(["proxy.lan:8080"]);
    expect(freshConfig.anidbClient).toBe("kept");
    expect(freshConfig.anidbClientVer).toBe(4);
    expect(freshConfig.animeTitlesDataset).toBe(false);
    expect(freshConfig.logDays).toBe(3);
    expect(freshConfig.logMaxMb).toBe(50);
    writeFileSync(settingsFile(), "{}");
  });

  it("show on the dashboard in named groups, each with its words, and the state beside them", async () => {
    const data = await dataOf();
    expect(data.settingGroups).toEqual(["Access", "AIOStreams", "Subtitle sources", "Reading files", "Anime", "Lists and timing", "Logs and updates"]);
    expect(data.settings.map((x) => x.key)).toEqual([...settings.SETTING_KEYS]);
    for (const x of data.settings) {
      expect(data.settingGroups).toContain(x.group);
      expect(x.label.length).toBeGreaterThan(3);
      expect(x.help.length).toBeGreaterThan(30);
      expect(x.env).toMatch(/^[A-Z_]+$/);
    }
    const of = (key: string) => data.settings.find((x) => x.key === key);
    expect(of("listBudgetMs")).toMatchObject({ group: "Lists and timing", kind: "number", unit: "ms", min: 2000, max: 20_000, whole: true, value: 5000 });
    expect(of("listBudgetMs")?.help).toContain("at least this plus 3,000 ms");
    expect(of("privateStreamHosts")).toMatchObject({ group: "Reading files", kind: "hosts", value: "proxy.lan:8080" });
    expect(of("anidbClientVer")).toMatchObject({ group: "Anime", kind: "number", optional: true, value: "" });
    expect(of("animeTitlesDataset")).toMatchObject({ kind: "toggle", value: "on" });
    expect(data.settingsStatus.reads).toMatchObject({ limitBytes: config.dailyReadBytes, paused: [] });
    expect(data.settingsStatus.reads.todayBytes).toBeGreaterThanOrEqual(0);
    expect(data.settingsStatus.anidb).toMatchObject({ configured: false, dailyMax: 100 });
  });

  it("come with a guide to setting up an AniDB client, its steps in order, each link opening apart", async () => {
    const html = await (await fetch(`${base}/dashboard`)).text();
    const guide = html.match(/<dialog class="help-dialog guide-dialog" id="anidb-help"[\s\S]*?<\/dialog>/)?.[0] ?? "";
    expect(guide).toContain('aria-labelledby="anidb-title"');
    expect(guide).toContain("data-close-guide");
    const links = [...guide.matchAll(/<a class="out-link" href="([^"]+)" target="_blank" rel="noopener noreferrer">/g)].map((m) => m[1]);
    expect(links).toEqual(["https://anidb.net", "https://anidb.net/software/add", "https://wiki.anidb.net/HTTP_API_Definition"]);
    const text = guide.replace(/<[^>]+>/g, "");
    const order = ["Sign in at anidb.net", "Register A New Project", "no, private only", "Add Project", "Register A New Client", "HTTP API, not UDP API", "Version: 1", "Add Client", "can't be changed", "can't be deleted", "Back here"];
    const at = order.map((words) => text.indexOf(words));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(text).toContain("one request every 4 s and 100 a day");
    expect(text).toContain("anime-offline-database");
    // Short enough to read on a phone without scrolling far.
    expect(text.replace(/\s+/g, " ").length).toBeLessThan(750);
    expect(guide).toContain('class="guide-warn" role="note"');
  });

  it("change only for the admin, from the dashboard itself", async () => {
    const before = config.privateStreamHosts;
    expect((await change("/dashboard/settings", { set: { privateStreamHosts: "evil.lan" } }, { site: "cross-site" })).status).toBe(403);
    expect((await change("/dashboard/settings", { set: { privateStreamHosts: "evil.lan" } }, { csrf: "wrong" })).status).toBe(403);
    expect(config.privateStreamHosts).toEqual(before);
  });
});

describe("who can change things", () => {
  async function withPasswords(run: () => Promise<void>) {
    config.adminPassword = ADMIN;
    config.addonPassword = "addon-pass-for-tests";
    try {
      await run();
    } finally {
      config.adminPassword = undefined;
      config.addonPassword = undefined;
    }
  }
  const session = (roles: Array<"admin" | "addon">) => `bttr_session=${access.sessionValue(roles)}`;

  it("only the admin downloads the log files, as one text file", () =>
    withPasswords(async () => {
      expect((await fetch(`${base}/dashboard/logs`, { redirect: "manual" })).status).not.toBe(200);
      expect((await fetch(`${base}/dashboard/logs`, { redirect: "manual", headers: { Cookie: session(["addon"]) } })).status).not.toBe(200);
      const got = await fetch(`${base}/dashboard/logs`, { headers: { Cookie: session(["admin", "addon"]) } });
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toContain("text/plain");
      expect(got.headers.get("content-disposition")).toMatch(/^attachment; filename="?bttrsubs-logs-\d{4}-\d{2}-\d{2}\.txt"?$/);
      expect(got.headers.get("cache-control")).toBe("no-store");
    }));

  it("gives only the admin a request's diagnostics: its record, its own log lines and errors, its configuration, and nothing secret", () =>
    withPasswords(async () => {
      const { id, token } = makeLink("diag0001", { signs: true, label: "Diag Label Name" });
      stats.noteLinkKeys(id, [["subsource", "sk_placeholder_diag0001_key"]]);
      stats.noteLinkLabel(id, "Diag Label Name");
      logs.startLogFiles({ dir: path.join(process.cwd(), CACHE, "logs-diag"), days: 7, maxBytes: 1e6 });
      try {
        stats.requestContext.run({ link: id, req: "reqDiag01" }, () => {
          console.log("diag test: reading Show.S01E05.Diag.mkv");
          stats.noteError("sync", new Error("a source timed out"), "Show S1E05");
        });
        console.log("diag test: a line of another request");
        stats.noteActivity({
          link: id,
          req: "reqDiag01",
          kind: "download",
          what: "English · Show S1E05",
          result: "synced",
          ms: 1200,
          detail: { file: "Show.S01E05.Diag.mkv", size: 123456, video: "tt0000999:1:5", client: "TestPlayer/1.0", sent: { format: "srt", bytes: 2048, kept: true } }
        });
        const row = stats.activityWeek().find((a) => a.req === "reqDiag01")!;
        const url = `${base}/dashboard/diagnostics?${new URLSearchParams({ at: String(row.at), link: id })}`;
        expect((await fetch(url, { redirect: "manual" })).status).not.toBe(200);
        expect((await fetch(url, { redirect: "manual", headers: { Cookie: session(["addon"]) } })).status).not.toBe(200);
        const got = await fetch(url, { headers: { Cookie: session(["admin", "addon"]) } });
        expect(got.status).toBe(200);
        expect(got.headers.get("content-type")).toContain("text/plain");
        expect(got.headers.get("cache-control")).toBe("no-store");
        const text = await got.text();
        expect(text).toContain("English · Show S1E05 → synced");
        expect(text).toContain("client: TestPlayer/1.0");
        expect(text).toMatch(/ req=reqDiag01 diag test: reading Show\.S01E05\.Diag\.mkv/);
        expect(text).not.toContain("a line of another request");
        expect(text).toContain("sync (" + id + ") on Show S1E05: a source timed out");
        expect(text).toContain(`Configuration ${id}`);
        expect(text).toContain("AIOStreams aiostreams.example.com");
        // No key, password, secret, token, address past its host, or configuration name.
        for (const secret of ["sk_placeholder_diag0001_key", "diag0001-0000-placeholder", token, ADMIN, ENV.CONFIG_SECRET, "Diag Label Name"]) expect(text).not.toContain(secret);
        // Without a request: the server and its newest requests, with the newest log lines.
        const all = await (await fetch(`${base}/dashboard/diagnostics`, { headers: { Cookie: session(["admin", "addon"]) } })).text();
        expect(all).toContain("English · Show S1E05 → synced");
        expect(all).toContain("diag test: a line of another request");
        expect(all).toContain("Daily read limit");
        expect(all).not.toContain("Diag Label Name");
      } finally {
        await logs.stopLogFiles();
      }
    }));

  it("only the admin, from the dashboard itself, with its token", () =>
    withPasswords(async () => {
      const admin = session(["admin", "addon"]);
      const addon = session(["addon"]);
      const body = { set: { timeZone: "Asia/Tokyo" } };
      // Not signed in, or signed in for link setup only: refused, and nothing changes.
      expect((await change("/dashboard/settings", body, { csrf: "x" })).status).toBe(401);
      expect((await change("/dashboard/settings", body, { cookie: addon, csrf: "x" })).status).toBe(403);
      expect((await change("/dashboard/links/pause", { link: "x", paused: true }, { cookie: addon, csrf: "x" })).status).toBe(403);
      expect(config.timeZone).toBe("Europe/London");
      // The admin, but from another site, or without the page's token, or another session's.
      const token = await csrfOf(admin);
      expect(token).toMatch(/^[\w-]{43}$/);
      expect((await change("/dashboard/settings", body, { cookie: admin, csrf: token, site: "cross-site" })).status).toBe(403);
      expect((await change("/dashboard/settings", body, { cookie: admin, csrf: "" })).status).toBe(403);
      expect((await change("/dashboard/settings", body, { cookie: admin, csrf: await csrfOf(session(["admin"])) })).status).toBe(403);
      expect(config.timeZone).toBe("Europe/London");
      // No Sec-Fetch-Site: the Origin header has to name this host.
      const byOrigin = (origin: string) =>
        fetch(`${base}/dashboard/settings`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: admin, "X-CSRF-Token": token, "X-Forwarded-For": nextIp() }, body: JSON.stringify({ reset: ["timeZone"] }) });
      expect((await byOrigin("https://evil.example")).status).toBe(403);
      expect((await byOrigin(base)).status).toBe(200);
      const ok = await change("/dashboard/settings", body, { cookie: admin, csrf: token });
      expect(ok.status).toBe(200);
      expect(config.timeZone).toBe("Asia/Tokyo");
      await change("/dashboard/settings", { reset: ["timeZone"] }, { cookie: admin, csrf: token });
    }));

  it("refuses an address after five forged changes, as sign-in does after five wrong passwords", () =>
    withPasswords(async () => {
      const admin = session(["admin", "addon"]);
      const token = await csrfOf(admin);
      const ip = nextIp();
      for (let i = 0; i < 5; i++) expect((await change("/dashboard/settings", { reset: [] }, { cookie: admin, csrf: "forged", ip })).status).toBe(403);
      expect((await change("/dashboard/settings", { reset: [] }, { cookie: admin, csrf: token, ip })).status).toBe(429);
      expect((await change("/dashboard/settings", { reset: [] }, { cookie: admin, csrf: token })).status).toBe(200);
    }));

  it("allows 30 changes a minute from one address", () =>
    withPasswords(async () => {
      const admin = session(["admin", "addon"]);
      const token = await csrfOf(admin);
      const ip = nextIp();
      for (let i = 0; i < 30; i++) expect((await change("/dashboard/settings", { reset: [] }, { cookie: admin, csrf: token, ip })).status).toBe(200);
      const over = await change("/dashboard/settings", { reset: [] }, { cookie: admin, csrf: token, ip });
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBe("60");
    }));

  it("keeps the owner signed in when the configure page's password changes, and signs out the rest", () =>
    withPasswords(async () => {
      const admin = session(["admin", "addon"]);
      const friend = session(["addon"]);
      expect((await fetch(`${base}/configure`, { headers: { Cookie: friend } })).status).toBe(200);
      const response = await change("/dashboard/settings", { set: { addonPassword: { password: "a-new-friends-pass" } } }, { cookie: admin });
      expect(response.status).toBe(200);
      const renewed = (response.headers.get("set-cookie") ?? "").split(";")[0];
      expect(renewed).toMatch(/^bttr_session=/);
      const { csrf } = (await response.json()) as { csrf: string };
      // The friend's old session and the owner's old cookie no longer open anything; the renewed one does.
      expect((await fetch(`${base}/configure`, { redirect: "manual", headers: { Cookie: friend, Accept: "text/html" } })).status).toBe(303);
      expect((await fetch(`${base}/dashboard`, { redirect: "manual", headers: { Cookie: admin, Accept: "text/html" } })).status).toBe(303);
      expect((await fetch(`${base}/dashboard`, { headers: { Cookie: renewed } })).status).toBe(200);
      // The token sent back is the renewed session's.
      expect(csrf).toBe(await csrfOf(renewed));
      expect((await change("/dashboard/settings", { reset: ["addonPassword"] }, { cookie: renewed, csrf })).status).toBe(200);
    }), 20000);

  it("can't be reached by the addon paths, and the dashboard asks the admin to sign in", () =>
    withPasswords(async () => {
      const page = await fetch(`${base}/dashboard`, { redirect: "manual", headers: { Accept: "text/html", Cookie: session(["addon"]) } });
      expect(page.status).toBe(303);
      expect(page.headers.get("location")).toBe("/login?next=%2Fdashboard&for=admin");
      expect((await fetch(`${base}/dashboard/links/configure?link=x`, { redirect: "manual", headers: { Accept: "text/html" } })).status).toBe(303);
    }));
});

describe("managing links", () => {
  it("renames a link: its name shows at once, and its URL keeps working", async () => {
    const { token, id } = makeLink("bbbb0002");
    const renamed = await change("/dashboard/links/rename", { link: id, name: "Living room" });
    expect(renamed.status).toBe(200);
    expect(profile.storedSettings(token)?.label).toBe("Living room");
    expect((await stats.statsView("t")).names[id]).toBe("Living room");
    stats.count("lists", 1, id);
    const data = await dataOf();
    expect(data.names[id]).toBe("Living room");
    expect(data.configs.find((c) => c.id === id)?.name).toBe("Living room");
    expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
    const configure = await (await fetch(`${base}/${token}/configure`)).text();
    expect(configure).toContain('"label":"Living room"');
    // A name that isn't one is refused; an empty one goes back to the id.
    expect((await change("/dashboard/links/rename", { link: id, name: "<b>bold</b>" })).status).toBe(400);
    expect((await change("/dashboard/links/rename", { link: id, name: "" })).status).toBe(200);
    expect(profile.storedSettings(token)?.label).toBeUndefined();
    expect((await stats.statsView("t")).names[id]).toBeUndefined();
    expect((await change("/dashboard/links/rename", { link: "ffff9999/000000", name: "Nobody" })).status).toBe(404);
  });

  it("pauses a link: its manifest answers, its lists are empty, its downloads refused, until resumed", async () => {
    const { token, id } = makeLink("cccc0003");
    expect((await change("/dashboard/links/pause", { link: id, paused: "yes" })).status).toBe(400);
    expect((await change("/dashboard/links/pause", { link: id, paused: true })).status).toBe(200);
    expect(profile.isPaused(id)).toBe(true);
    expect((await fetch(`${base}/${token}/manifest.json`)).status).toBe(200);
    const list = await fetch(`${base}/${token}/subtitles/movie/tt0.json`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ subtitles: [], cacheMaxAge: 60 });
    const download = await fetch(`${base}/${token}/download/ss1/a.srt`);
    expect(download.status).toBe(404);
    expect(await download.text()).toBe("This configuration is paused");
    expect(stats.activityPage({ link: id }).rows[0]).toMatchObject({ kind: "list", result: "paused" });
    stats.count("lists", 1, id);
    const data = await dataOf();
    expect(data.paused).toHaveProperty([id]);
    expect(data.configs.some((c) => c.id === id)).toBe(true);
    // Kept across restarts.
    expect(JSON.parse(readFileSync(path.join(process.cwd(), CACHE, "links", "paused.json"), "utf8"))).toHaveProperty([id]);
    expect((await change("/dashboard/links/pause", { link: id, paused: false })).status).toBe(200);
    expect(profile.isPaused(id)).toBe(false);
  });

  it("opens a link's configure page by its id, and the dashboard never holds a token or key", async () => {
    const { token, id } = makeLink("dddd0004");
    stats.count("lists", 1, id);
    const open = await fetch(`${base}/dashboard/links/configure?${new URLSearchParams({ link: id })}`, { redirect: "manual" });
    expect(open.status).toBe(303);
    expect(open.headers.get("location")).toBe(`/${token}/configure`);
    expect((await fetch(`${base}/dashboard/links/configure?link=nobody`, { redirect: "manual" })).status).toBe(404);
    const data = await dataOf();
    // Known by its settings, so the page offers Configure (to /dashboard/links/configure) and Copy install URL.
    expect(data.configs.find((c) => c.id === id)).toMatchObject({ known: true, aiostreams: "aiostreams.example.com" });
    const page = `${await (await fetch(`${base}/dashboard`)).text()}${JSON.stringify(data)}`;
    for (const known of Object.values(profile.knownLinks())) expect(page).not.toContain(known);
    expect(page).not.toContain("sk_placeholder");
    expect(page).not.toContain("E2-placeholder");
  });

  it("deletes one link, after naming it, and leaves every other link and the history alone", async () => {
    const gone = makeLink("eeee0005");
    const kept = makeLink("ffff0006");
    await change("/dashboard/links/rename", { link: gone.id, name: "Upstairs" });
    await change("/dashboard/links/rename", { link: kept.id, name: "Kitchen" });
    await change("/dashboard/links/pause", { link: gone.id, paused: true });
    stats.count("lists", 3, gone.id);
    stats.count("lists", 2, kept.id);
    const linksDir = path.join(process.cwd(), CACHE, "links");
    const filesBefore = readdirSync(linksDir).length;
    // The request has to name the link it deletes.
    expect((await change("/dashboard/links/delete", { link: gone.id })).status).toBe(400);
    expect((await change("/dashboard/links/delete", { link: gone.id, confirm: kept.id })).status).toBe(400);
    expect((await fetch(`${base}/${gone.token}/manifest.json`)).status).toBe(200);
    const deleted = await change("/dashboard/links/delete", { link: gone.id, confirm: gone.id });
    expect(deleted.status).toBe(200);
    // Its URL stops working, everywhere it's used; its own stored data goes.
    expect((await fetch(`${base}/${gone.token}/manifest.json`)).status).toBe(404);
    expect((await fetch(`${base}/${gone.token}/configure`)).status).toBe(404);
    expect(profile.knownLinks()[gone.id]).toBeUndefined();
    expect(profile.isPaused(gone.id)).toBe(false);
    expect(profile.storedSettings(gone.token)).toBeUndefined();
    expect(readdirSync(linksDir).length).toBe(filesBefore); // its settings file out, deleted.json in
    expect(existsSync(path.join(linksDir, "deleted.json"))).toBe(true);
    expect(readFileSync(path.join(linksDir, "deleted.json"), "utf8")).not.toContain(gone.token);
    // The other link and the history are untouched.
    expect((await fetch(`${base}/${kept.token}/manifest.json`)).status).toBe(200);
    expect(profile.storedSettings(kept.token)?.label).toBe("Kitchen");
    const view = await stats.statsView("t");
    expect(view.days[0].links[gone.id]).toMatchObject({ lists: 3 });
    expect(view.days[0].links[kept.id]).toMatchObject({ lists: 2 });
    expect(view.deleted).toContain(gone.id);
    const data = await dataOf();
    expect(data.configs.some((c) => c.id === gone.id)).toBe(false);
    expect(data.configs.some((c) => c.id === kept.id)).toBe(true);
    // Gone is gone: nothing more can be done to it.
    expect((await change("/dashboard/links/delete", { link: gone.id, confirm: gone.id })).status).toBe(404);
  });
});

describe("clearing errors and activity", () => {
  it("clears errors everywhere on the page, keeps what's stored, and can be undone", async () => {
    const link = makeLink("abab0007").id;
    await stats.requestContext.run({ link }, async () => {
      stats.noteError("subsource", new Error("HTTP 503 from upstream"), "English · Placeholder Show S1E01");
      stats.count("api.subsource.fail");
      stats.noteKeyCall("subsource", "placeholder-clear-key", new Response("", { status: 429 }));
    });
    stats.noteActivity({ link, kind: "download", what: "English · Placeholder Show S1E01", result: "error: HTTP 503", ms: 900 });
    let data = await dataOf();
    expect(data.errors.some((e) => e.message === "HTTP 503 from upstream")).toBe(true);
    expect(data.keys.some((k) => k.refused > 0 && k.lastRefusedAt > 0)).toBe(true); // the verdict's "a key was refused"
    expect(data.days[0].errors).toBeGreaterThan(0);
    expect(data.sources.find((x) => x.id === "subsource")?.failures).toBeGreaterThan(0);
    const daysBefore = (await stats.statsView("t")).days[0].total["errors.subsource"];

    // Without the page's token, refused; with it, cleared (JSON for the page's script).
    expect((await change("/dashboard/errors/clear", {}, { csrf: "forged" })).status).toBe(403);
    expect((await change("/dashboard/errors/clear", {})).status).toBe(200);
    data = await dataOf();
    expect(data.errors).toEqual([]);
    expect(data.keys.some((k) => k.refused > 0 || k.lastRefusedAt > 0)).toBe(false);
    expect(data.days[0].errors).toBe(0);
    expect(data.sources.find((x) => x.id === "subsource")?.failures).toBe(0);
    expect(data.canUndoClear).toBe(true);
    // The request that failed stays in the log, from before the clear: the page draws it as past.
    expect(data.activity.find((a) => a.what === "English · Placeholder Show S1E01")!.at).toBeLessThan(data.errorsClearedAt);
    // The activity list's errors filter starts at the clear too.
    expect(stats.activityPage({ kind: "error" }).total).toBe(0);
    // Nothing stored was deleted.
    expect((await stats.statsView("t")).days[0].total["errors.subsource"]).toBe(daysBefore);
    // A plain form gets the dashboard back.
    expect((await fetch(`${base}/dashboard/errors/clear?undo=1`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": nextIp() }, body: new URLSearchParams({ csrf: await csrfOf() }) })).status).toBe(303);
    data = await dataOf();
    expect(data.errors.some((e) => e.message === "HTTP 503 from upstream")).toBe(true);
    expect(data.days[0].errors).toBeGreaterThan(0);
  });

  it("clears the activity log after a confirm, keeps the week's totals, and can be undone", async () => {
    const link = makeLink("abab0008").id;
    stats.noteActivity({ link, kind: "download", what: "English · Placeholder Film (2020)", result: "synced", ms: 700 });
    const shown = async () => (await dataOf()).activity.some((a) => a.what.includes("Placeholder Film (2020)"));
    expect(await shown()).toBe(true);
    const outcomes = (await stats.statsView("t")).outcomes;
    expect((await change("/dashboard/activity/clear", {})).status).toBe(200);
    expect(await shown()).toBe(false);
    expect((await dataOf()).canUndoClearActivity).toBe(true);
    const view = await stats.statsView("t");
    expect(view.activity).toEqual([]);
    expect(view.recent).toEqual([]);
    expect(view.outcomes).toEqual(outcomes); // synced %, counted over the whole week, stays
    expect((await change("/dashboard/activity/clear?undo=1", {})).status).toBe(200);
    expect(await shown()).toBe(true);
  });
});

describe("clearing one link", () => {
  it("clears one link's errors in every view, leaves the others, and can be undone", async () => {
    // Earlier tests' errors out of the way first, so only this test's count.
    await change("/dashboard/errors/clear", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mine = makeLink("acac0009").id;
    const other = makeLink("adad0010").id;
    await stats.requestContext.run({ link: mine }, async () => {
      stats.noteError("subsource", new Error("HTTP 503 mine"), "English · Placeholder Show S1E02");
      stats.noteKeyCall("subsource", "placeholder-link-clear-key", new Response("", { status: 429 }));
    });
    await stats.requestContext.run({ link: other }, async () => stats.noteError("subdl", new Error("HTTP 502 theirs"), "Arabic · Placeholder Show S1E03"));
    stats.noteActivity({ link: mine, kind: "download", what: "English · Placeholder Show S1E02", result: "error: HTTP 503", ms: 700 });
    stats.noteActivity({ link: other, kind: "download", what: "Arabic · Placeholder Show S1E03", result: "error: HTTP 502", ms: 700 });
    const before = await dataOf();
    expect(before.errors.some((e) => e.message === "HTTP 503 mine")).toBe(true);
    expect(before.keys.some((k) => k.link === mine && k.lastRefusedAt > 0)).toBe(true);

    expect((await change(`/dashboard/errors/clear?link=${encodeURIComponent(mine)}`, {})).status).toBe(200);
    const view = await stats.statsView("t");
    // The list: its errors gone, the other link's kept.
    expect(view.errors.some((e) => e.message === "HTTP 503 mine")).toBe(false);
    expect(view.errors.some((e) => e.message === "HTTP 502 theirs")).toBe(true);
    const data = await dataOf();
    expect(data.errors.some((e) => e.message === "HTTP 503 mine")).toBe(false);
    expect(data.errors.some((e) => e.message === "HTTP 502 theirs")).toBe(true);
    // The verdict: its refusal no longer counts; the other link's error still does.
    expect(data.keys.some((k) => k.link === mine && k.lastRefusedAt > 0)).toBe(false);
    // The activity list's error filter and the counts.
    expect(stats.activityPage({ kind: "error", link: mine }).total).toBe(0);
    expect(stats.activityPage({ kind: "error", link: other }).total).toBeGreaterThan(0);

    expect((await change(`/dashboard/errors/clear?undo=1&link=${encodeURIComponent(mine)}`, {})).status).toBe(200);
    expect((await dataOf()).errors.some((e) => e.message === "HTTP 503 mine")).toBe(true);
    await change("/dashboard/errors/clear", {});
  });

  it("clears one link's activity, leaves the others and the week's totals, and can be undone", async () => {
    const mine = makeLink("aeae0011").id;
    const other = makeLink("afaf0012").id;
    stats.noteActivity({ link: mine, kind: "download", what: "English · Placeholder Film (2019)", result: "synced", ms: 600 });
    stats.noteActivity({ link: other, kind: "download", what: "English · Placeholder Film (2018)", result: "synced", ms: 600 });
    const outcomes = (await stats.statsView("t")).outcomes;
    expect((await change(`/dashboard/activity/clear?link=${encodeURIComponent(mine)}`, {})).status).toBe(200);
    const view = await stats.statsView("t");
    expect(view.recent?.some((a) => a.link === mine)).toBe(false);
    expect(view.recent?.some((a) => a.link === other)).toBe(true);
    expect(stats.activityPage({ link: mine }).total).toBe(0);
    expect(view.outcomes).toEqual(outcomes);
    const data = await dataOf();
    expect(data.activity.some((a) => a.what.includes("Placeholder Film (2019)"))).toBe(false);
    expect(data.activity.some((a) => a.what.includes("Placeholder Film (2018)"))).toBe(true);
    expect((await change(`/dashboard/activity/clear?undo=1&link=${encodeURIComponent(mine)}`, {})).status).toBe(200);
    expect(stats.activityPage({ link: mine }).total).toBeGreaterThan(0);
  });

  it("clears both for one configuration, tells the page what each can undo, and undoes each on its own", async () => {
    const mine = makeLink("bebe0015").id;
    const other = makeLink("bfbf0016").id;
    await stats.requestContext.run({ link: mine }, async () => stats.noteError("gestdown", new Error("HTTP 500 both mine"), "English · Placeholder Show S4E01"));
    await stats.requestContext.run({ link: other }, async () => stats.noteError("gestdown", new Error("HTTP 500 both theirs"), "English · Placeholder Show S4E02"));
    stats.noteActivity({ link: mine, kind: "download", what: "English · Placeholder Film (2017)", result: "synced", ms: 500 });
    stats.noteActivity({ link: other, kind: "download", what: "English · Placeholder Film (2016)", result: "synced", ms: 500 });
    expect((await change(`/dashboard/clear?link=${encodeURIComponent(mine)}`, {})).status).toBe(200);
    let data = await dataOf();
    expect(data.errors.some((e) => e.message === "HTTP 500 both mine")).toBe(false);
    expect(data.errors.some((e) => e.message === "HTTP 500 both theirs")).toBe(true);
    expect(data.activity.some((a) => a.what.includes("(2017)"))).toBe(false);
    expect(data.activity.some((a) => a.what.includes("(2016)"))).toBe(true);
    expect(data.linkClears[mine]).toMatchObject({ canUndoErrors: true, canUndoActivity: true });
    expect(data.linkClears[mine].errorsAt).toBeGreaterThan(0);
    expect(data.linkClears[other]).toBeUndefined();
    expect((await change(`/dashboard/errors/clear?undo=1&link=${encodeURIComponent(mine)}`, {})).status).toBe(200);
    data = await dataOf();
    expect(data.errors.some((e) => e.message === "HTTP 500 both mine")).toBe(true);
    expect(data.activity.some((a) => a.what.includes("(2017)"))).toBe(false); // its activity stays cleared until undone itself
    expect((await change(`/dashboard/activity/clear?undo=1&link=${encodeURIComponent(mine)}`, {})).status).toBe(200);
    expect((await dataOf()).activity.some((a) => a.what.includes("(2017)"))).toBe(true);
    // For everything: a plain form still gets the dashboard back.
    const form = await fetch(`${base}/dashboard/clear`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": nextIp() }, body: new URLSearchParams({ csrf: await csrfOf() }) });
    expect(form.status).toBe(303);
    data = await dataOf();
    expect([data.errors.length, data.activity.length, data.canUndoClear, data.canUndoClearActivity]).toEqual([0, 0, true, true]);
    await change("/dashboard/errors/clear?undo=1", {});
    await change("/dashboard/activity/clear?undo=1", {});
  });

  it("takes only a link id", async () => {
    // Anything that isn't one clears nothing for a link: it falls back to the plain route's meaning.
    expect((await change("/dashboard/activity/clear?link=%3Cscript%3E&undo=1", {})).status).toBe(200);
  });
});

describe("settings in one save", () => {
  it("takes several changes in one request, as the page's one Save sends them", async () => {
    const response = await change("/dashboard/settings", { set: { timeZone: "Asia/Tokyo", dailyReadGb: "0", resultCacheTtlSeconds: "7200" } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: string[]; settings: DashboardData["settings"] };
    expect(body.changed.sort()).toEqual(["dailyReadGb", "resultCacheTtlSeconds", "timeZone"]);
    // The settings come back as they now are, each in its own units.
    const of = (key: string) => body.settings.find((x) => x.key === key);
    expect(of("dailyReadGb")).toMatchObject({ value: 0, unit: "GB a day", source: "dashboard" });
    expect(of("resultCacheTtlSeconds")).toMatchObject({ value: 2, unit: "hours", resetValue: 6, resetUnit: "hours" });
    expect(of("allowedAiostreams")).toMatchObject({ kind: "list", value: "https://aiostreams.example.com" });
    // Reset says where it goes back to: .env where the setting is there, else the default.
    expect(of("dailyReadGb")).toMatchObject({ resetTo: ".env", resetValue: 20 });
    expect(of("timeZone")).toMatchObject({ resetTo: ".env", resetValue: "Europe/London" });
    expect(of("resultCacheTtlSeconds")).toMatchObject({ resetTo: "default" });
    expect((await change("/dashboard/settings", { reset: ["timeZone", "dailyReadGb", "resultCacheTtlSeconds"] })).status).toBe(200);
  });
});

describe("the pages' own scripts", () => {
  it("parse, on the dashboard, the configure page and sign-in", async () => {
    for (const url of ["/dashboard", "/configure"]) {
      const html = await (await fetch(`${base}${url}`)).text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(() => new Function(script)).not.toThrow();
    }
  });
});

describe("the errors filter", () => {
  it("counts the week's playing files AIOStreams' list didn't hold: the ones found again and the ones not", async () => {
    const before = (await dataOf()).unlisted;
    stats.count("sync.unlisted");
    stats.count("sync.unlistedRecovered", 2);
    expect((await dataOf()).unlisted).toEqual({ lost: before.lost + 1, recovered: before.recovered + 2 });
    // Clearing the errors starts these again too, and Undo brings them back.
    await stats.clearErrors();
    expect((await dataOf()).unlisted).toEqual({ lost: 0, recovered: 0 });
    await stats.undoClearErrors();
    expect((await dataOf()).unlisted).toEqual({ lost: before.lost + 1, recovered: before.recovered + 2 });
  });

  it("gives each error its configuration and what it happened on, so repeats group and Show in activity can open its requests", async () => {
    const link = makeLink("baba0013").id;
    const before = (await dataOf()).errorsWeek;
    await stats.requestContext.run({ link }, async () => {
      stats.noteError("gestdown", new Error("HTTP 500 filter"), "English · Placeholder Show S2E01");
      stats.noteError("gestdown", new Error("HTTP 500 filter"), "English · Placeholder Show S2E01");
    });
    const data = await dataOf();
    const errors = data.errors.filter((e) => e.message === "HTTP 500 filter");
    expect(errors.length).toBe(2);
    expect(errors.every((e) => e.link === link && e.where === "gestdown" && e.what === "English · Placeholder Show S2E01" && !e.debug)).toBe(true);
    expect(data.errorsWeek).toBe(before + 2);
  });

  it("lists a test play's error marked, for the page's switch, and counts it nowhere", async () => {
    const link = makeLink("baba0015").id;
    const before = (await dataOf()).errorsWeek;
    await stats.startDebug({ link });
    await stats.requestContext.run({ link }, async () => stats.noteError("gestdown", new Error("HTTP 500 test play"), "English · Placeholder Show S2E02"));
    await stats.stopDebug();
    const data = await dataOf();
    expect(data.errors.find((e) => e.message === "HTTP 500 test play")).toMatchObject({ link, debug: true, what: "English · Placeholder Show S2E02" });
    expect(data.errorsWeek).toBe(before);
    for (const p of stats.debugPeriods().periods) await stats.removeDebugPeriod(p.id);
  });

  it("changes the most subtitles a language may list, one to three", async () => {
    const { changeSettings, resetSettings } = await import("../src/settings.js");
    const { config } = await import("../src/config.js");
    for (const bad of [0, 4, 2.5, "many"]) expect(await changeSettings({ maxPerLanguage: bad })).toMatchObject({ field: "maxPerLanguage" });
    expect(await changeSettings({ maxPerLanguage: "2" })).toMatchObject({ ok: true, changed: ["maxPerLanguage"] });
    expect(config.maxPerLanguage).toBe(2);
    expect(resetSettings(["maxPerLanguage"])).toMatchObject({ ok: true });
    expect(config.maxPerLanguage).toBe(3);
  });

  it("keeps a key used only in test plays under its configuration, with those calls counted apart", async () => {
    const link = makeLink("baba0016").id;
    await stats.startDebug({ link });
    await stats.requestContext.run({ link }, async () => {
      stats.noteKeyCall("wyzie", "placeholder-test-play-key", new Response("", { status: 200 }));
      stats.noteKeyCall("wyzie", "placeholder-test-play-key", new Response("", { status: 200 }));
    });
    await stats.stopDebug();
    const key = (await dataOf()).keys.find((k) => k.service === "wyzie" && k.testCalls === 2);
    // No call of the week is counted for it, and it is still its configuration's, not a key of nobody.
    expect(key).toMatchObject({ link, weekCalls: 0, testCalls: 2 });
    for (const p of stats.debugPeriods().periods) await stats.removeDebugPeriod(p.id);
  });
});

describe("errors in plain words", () => {
  it("keeps the error's own words for the page to explain, and leaves an unnamed link without a name", async () => {
    const link = makeLink("caca0014").id;
    await stats.requestContext.run({ link }, async () => stats.noteError("subdl", new Error("HTTP 429 from upstream"), "English · Placeholder Show S3E01"));
    stats.count("lists", 1, link);
    const data = await dataOf();
    expect(data.errors.find((e) => e.link === link)).toMatchObject({ where: "subdl", message: "HTTP 429 from upstream" });
    expect(data.configs.find((c) => c.id === link)?.name).toBeNull();
    // The page says what an error means from its kind (429: too many calls).
    expect(readFileSync(path.join(process.cwd(), "assets/ui/dashboard.js"), "utf8")).toContain("status === 429");
  });
});

describe("debug periods, applied when the data is read", () => {
  const page = async () => (await fetch(`${base}/dashboard`)).text();
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A configuration's requests and one error, all now, with a placeholder episode of its own. */
  const record = async (link: string, tag: string) => {
    stats.noteActivity({ link, kind: "list", what: `Placeholder Show ${tag}`, result: "4 tracks", ms: 80 });
    stats.noteActivity({ link, kind: "download", what: `English · Placeholder Show ${tag}`, result: "synced", ms: 900 });
    await stats.requestContext.run({ link }, async () => stats.noteError("gestdown", new Error(`HTTP 500 for ${tag}`), `English · Placeholder Show ${tag}`));
  };
  const shown = (what: string) => stats.activityPage({ limit: 50 }).rows.some((a) => a.what.includes(what));
  const clearAll = async () => { for (const p of stats.debugPeriods().periods) await stats.removeDebugPeriod(p.id); };

  it("hides a past period's requests and errors from every view, and brings them back when it's removed", async () => {
    const a = makeLink("dada0021").id;
    const b = makeLink("dada0022").id;
    await pause(3);
    const from = Date.now();
    await pause(3);
    await record(a, "S7E01");
    await record(b, "S7E02");
    const before = await stats.statsView("t");
    expect(before.linkWeek?.[a]).toEqual({ lists: 1, served: 1, lastSeen: expect.any(Number) });
    await pause(5);
    const added = await stats.addDebugPeriod({ from, to: Date.now(), note: "Placeholder test" });
    expect("period" in added).toBe(true);
    const after = await stats.statsView("t");
    // The activity list and its filters, the timetable, the synced share, the errors, each configuration's week.
    expect(shown("S7E01") || shown("S7E02")).toBe(false);
    expect(stats.activityPage({ link: a }).total).toBe(0);
    expect(stats.activityPage({ debug: true, limit: 50 }).rows.find((x) => x.what.includes("S7E01"))?.debug).toBe(true);
    expect(after.recent?.some((x) => x.what.includes("S7E0"))).toBe(false);
    expect(after.outcomes.served).toBe(before.outcomes.served - 2);
    expect(after.outcomes.synced).toBe(before.outcomes.synced - 2);
    expect(after.errors.filter((e) => e.message.includes("S7E0")).every((e) => e.debug)).toBe(true);
    expect(after.linkWeek?.[a]).toBeUndefined();
    expect(after.debug?.periods.at(-1)).toMatchObject({ requests: 4, errors: 2, note: "Placeholder test" });
    expect(after.debug?.activity).toBeGreaterThanOrEqual(4);
    // The page: its errors and requests kept as test plays, counted nowhere and shown only with their switches.
    const data = await (await fetch(`${base}/dashboard/data`)).json() as DashboardData;
    const tested = data.errors.filter((e) => e.message.includes("S7E01"));
    expect(tested.length).toBe(1);
    expect(tested.every((e) => e.debug)).toBe(true);
    expect(data.activity.find((x) => x.what.includes("S7E01"))?.debug).toBe(true);
    // Removed: everything is back.
    expect(await stats.removeDebugPeriod(after.debug!.periods.at(-1)!.id)).toBe(true);
    expect(shown("S7E01") && shown("S7E02")).toBe(true);
    expect((await stats.statsView("t")).outcomes).toEqual(before.outcomes);
    await clearAll();
  });

  it("hides only its own configuration when a period is scoped to one", async () => {
    const a = makeLink("dada0023").id;
    const b = makeLink("dada0024").id;
    await pause(3);
    const from = Date.now();
    await pause(3);
    await record(a, "S8E01");
    await record(b, "S8E02");
    await pause(5);
    await stats.addDebugPeriod({ from, to: Date.now(), link: a });
    expect(shown("S8E01")).toBe(false);
    expect(shown("S8E02")).toBe(true);
    const view = await stats.statsView("t");
    expect(view.linkWeek?.[a]).toBeUndefined();
    expect(view.linkWeek?.[b]?.served).toBe(1);
    expect(view.errors.find((e) => e.message.includes("S8E01"))?.debug).toBe(true);
    expect(view.errors.find((e) => e.message.includes("S8E02"))?.debug).toBeUndefined();
    expect(view.debug?.periods.at(-1)).toMatchObject({ link: a, requests: 2, errors: 1 });
    await clearAll();
  });

  it("tags what an open session records, and stops; a removed session counts as real again", async () => {
    const a = makeLink("dada0025").id;
    const b = makeLink("dada0026").id;
    expect("period" in (await stats.startDebug({ note: "Placeholder session" }))).toBe(true);
    expect(stats.isDebug(a)).toBe(true);
    const lists = (await stats.statsView("t")).days[0].total.lists ?? 0;
    stats.count("lists", 1, a);
    stats.noteActivity({ link: a, kind: "download", what: "English · Placeholder Film (2003)", result: "synced", ms: 400 });
    const view = await stats.statsView("t");
    expect(view.days[0].total.lists ?? 0).toBe(lists); // the live counters go to the debug bucket
    expect(view.days[0].debug?.total.lists).toBeGreaterThan(0);
    expect(shown("(2003)")).toBe(false);
    // No debug controls on the page: marking is a command on the server (src/debugMark.ts).
    expect(await page()).not.toMatch(/dbg-pill|set-debug|data-debug-start|\/dashboard\/debug\//);
    expect(await stats.stopDebug()).toBe(1);
    expect(stats.isDebug(a)).toBe(false);
    stats.noteActivity({ link: a, kind: "download", what: "English · Placeholder Film (2004)", result: "synced", ms: 400 });
    expect(shown("(2004)")).toBe(true);
    // Removing the session's period: what it tagged counts as real again.
    const session = stats.debugPeriods().periods.find((p) => p.note === "Placeholder session")!;
    expect(session.to).toBeGreaterThanOrEqual(session.from);
    await stats.removeDebugPeriod(session.id);
    expect(shown("(2003)")).toBe(true);
    // One configuration's session: only it is tagged.
    await stats.startDebug({ link: a });
    expect(stats.isDebug(a)).toBe(true);
    expect(stats.isDebug(b)).toBe(false);
    await stats.stopDebug();
    await clearAll();
  });

  it("takes marking commands from the command file: start by name, stop, mark a past stretch, status", async () => {
    const dir = path.join(process.env.CACHE_DIR!, "stats");
    const run = async (command: Record<string, unknown>) => {
      await writeFile(path.join(dir, "debug-command.json"), JSON.stringify(command));
      await stats.debugCommandTick();
      return JSON.parse(await readFile(path.join(dir, "debug-command.done.json"), "utf8")) as { ok: boolean; message: string };
    };
    await stats.stopDebug(); // nothing left open by an earlier test
    const a = makeLink("dada0031").id;
    stats.setLinkLabel(a, "Placeholder Den");
    stats.noteActivity({ link: a, kind: "list", what: "Placeholder Show S9E01", result: "2 tracks", ms: 50 });
    // By its name, any case; then by the start of its id.
    expect(await run({ cmd: "start", config: "placeholder den", note: "Placeholder AI test" })).toMatchObject({ ok: true });
    expect(stats.isDebug(a)).toBe(true);
    expect((await run({ cmd: "stop" })).message).toBe("Stopped 1 debug marking");
    expect(stats.isDebug(a)).toBe(false);
    expect(await run({ cmd: "start", config: a.slice(0, 6) })).toMatchObject({ ok: true });
    await run({ cmd: "stop" });
    expect(await run({ cmd: "start", config: "nobody here" })).toEqual({ ok: false, message: 'No configuration matches "nobody here"', at: expect.any(Number) });
    // A past stretch, in ISO times; it hides what it covers.
    const marked = await run({ cmd: "mark", from: new Date(Date.now() - 60_000).toISOString(), to: new Date().toISOString(), config: "Placeholder Den" });
    expect(marked.ok).toBe(true);
    expect(stats.activityPage({ limit: 50 }).rows.some((r) => r.what === "Placeholder Show S9E01")).toBe(false);
    expect((await run({ cmd: "mark", from: "2026-07-01T13:00Z", to: "2026-07-01T12:00Z", config: "all" })).message).toMatch(/^From: must be before to/);
    expect((await run({ cmd: "status" })).message).toContain("Placeholder Den");
    expect((await run({ cmd: "nonsense" })).ok).toBe(false);
    await clearAll();
  });

  it("reads debug.json as written, leaving out anything malformed", () => {
    const { periods } = stats.readDebugFile({ periods: [{ id: "a1", from: 0, link: "abcd1234/ef56" }, { id: "a2", from: 9, to: 5 }, { from: 1 }] });
    expect(periods).toEqual([{ id: "a1", from: 0, link: "abcd1234/ef56" }]);
    expect(stats.readDebugFile(null).periods).toEqual([]);
    // A period from the start of time covers its configuration's whole past, and only it.
    expect(stats.isDebugEntry({ at: 1, link: "abcd1234/ef56" }, periods)).toBe(true);
    expect(stats.isDebugEntry({ at: 1, link: "other" }, periods)).toBe(false);
  });

  it("keeps New configuration in the sidebar, and Sign out only for a signed-in session", async () => {
    const html = await page();
    const side = html.slice(html.indexOf('<aside class="side">'), html.indexOf("</aside>"));
    expect(side).toContain('href="/configure"');
    expect(side).toContain("New configuration");
    expect(side).not.toContain("signout");
    const signedIn = await (await fetch(`${base}/dashboard`, { headers: { Cookie: `bttr_session=${access.sessionValue(["admin", "addon"])}` } })).text();
    expect(signedIn).toContain('class="text-btn signout"');
    expect(signedIn).toContain('<form id="signout-form" method="post" action="/logout" hidden></form>');
  });
});
