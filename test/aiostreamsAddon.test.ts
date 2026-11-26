import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/profile.js";

const UUID = "1234abcd-0000-4000-8000-000000000001";
const ADDRESS = "https://aiostreams.example.com";
const BASE = "https://sync.example";
const MINE = `${BASE}/v2.token-of-this-configuration/manifest.json`;
const settings: Settings = { opensubtitles: true, aiostreams: `${ADDRESS}/stremio/${UUID}/E2-minted/manifest.json`, aiostreamsPassword: "secret", languages: ["English"], allowMachine: false, hearingImpaired: "include" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const other = { type: "torznab", instanceId: "a08", enabled: true, options: { name: "Indexer", timeout: 6500 } };
const entry = (manifestUrl: string, more: Record<string, unknown> = {}, enabled = true) => ({ type: "custom", instanceId: "e2f", enabled, options: { name: "My subtitles", manifestUrl, timeout: 11000, resources: ["subtitles"], mediaTypes: [], ...more } });

let add: typeof import("../src/aiostreamsAddon.js").addToAiostreams;

beforeAll(async () => {
  process.env.CONFIG_SECRET = "addon-test-secret-addon-test-secret-12345";
  process.env.ALLOWED_AIOSTREAMS = ADDRESS;
  process.env.PUBLIC_BASE_URL = BASE;
  ({ addToAiostreams: add } = await import("../src/aiostreamsAddon.js"));
});

afterEach(() => vi.restoreAllMocks());

/** An AIOStreams holding `presets` for the account: it gives them to the right password, and keeps what is saved. */
function aiostreams(presets: unknown[], save: () => Response = () => json({ success: true })) {
  const saved: Array<Record<string, any>> = [];
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const sent = Buffer.from(String((init?.headers as Record<string, string>).Authorization).replace("Basic ", ""), "base64").toString();
    if (sent !== `${UUID}:secret`) return json({ success: false }, 401);
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (init?.method === "PUT") {
      saved.push(JSON.parse(String(init.body)).config);
      return save();
    }
    return json({ success: true, data: { userData: { uuid: UUID, addonName: "Mine", presets }, encryptedPassword: "E2-minted" } });
  });
  return { saved, calls };
}

describe("adding a configuration to its AIOStreams account", () => {
  it("adds it as a subtitle addon with a timeout the list's time fits in, and leaves the rest of the configuration as it was", async () => {
    const { saved, calls } = aiostreams([other]);
    expect(await add(settings, MINE)).toEqual({ state: "added", name: "BttrSubs" });
    expect(calls).toEqual([`GET ${ADDRESS}/api/v1/user?raw=true`, `PUT ${ADDRESS}/api/v1/user`]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ uuid: UUID, addonName: "Mine" });
    expect(saved[0].presets[0]).toEqual(other);
    expect(saved[0].presets[1]).toMatchObject({ type: "custom", enabled: true, options: { name: "BttrSubs", manifestUrl: MINE, timeout: 11000, resources: ["subtitles"] } });
    expect(saved[0].presets[1].instanceId).toMatch(/^[0-9a-f]{3,8}$/);
    expect(saved[0].presets[1].instanceId).not.toBe("a08");
  });

  it("saves nothing when the entry is already there and right", async () => {
    const { saved } = aiostreams([other, entry(MINE)]);
    expect(await add(settings, MINE)).toEqual({ state: "present", name: "My subtitles" });
    expect(saved).toHaveLength(0);
  });

  it("puts its entry right: switched on, subtitles among its resources, its timeout raised and never lowered", async () => {
    const off = aiostreams([entry(MINE, { timeout: 5000, resources: ["stream"] }, false)]);
    expect(await add(settings, MINE)).toEqual({ state: "updated", name: "My subtitles" });
    expect(off.saved[0].presets[0]).toMatchObject({ enabled: true, instanceId: "e2f", options: { name: "My subtitles", manifestUrl: MINE, timeout: 11000, resources: ["stream", "subtitles"] } });
    vi.restoreAllMocks();
    const long = aiostreams([entry(`${BASE}/v2.an-earlier-token/manifest.json`, { timeout: 15000 })]);
    expect(await add(settings, MINE)).toEqual({ state: "updated", name: "My subtitles" });
    expect(long.saved[0].presets).toHaveLength(1);
    expect(long.saved[0].presets[0].options).toMatchObject({ manifestUrl: MINE, timeout: 15000 });
  });

  it("takes over the account's one entry from this server, and adds beside several", async () => {
    const two = aiostreams([entry(`${BASE}/v2.first/manifest.json`), { ...entry(`${BASE}/v2.second/manifest.json`), instanceId: "e30" }, { ...entry("https://elsewhere.example/x/manifest.json"), instanceId: "e31" }]);
    expect(await add(settings, MINE)).toEqual({ state: "added", name: "BttrSubs" });
    expect(two.saved[0].presets.map((p: any) => p.options.manifestUrl)).toEqual([`${BASE}/v2.first/manifest.json`, `${BASE}/v2.second/manifest.json`, "https://elsewhere.example/x/manifest.json", MINE]);
    expect(new Set(two.saved[0].presets.map((p: any) => p.instanceId)).size).toBe(4);
  });

  it("says why it couldn't: no saved password, a refused one, a refused save in AIOStreams' words, no answer", async () => {
    const error = async (s: Settings | undefined, url = MINE) => ((await add(s, url)) as { error?: string }).error;
    const none = aiostreams([other]);
    expect(await error({ ...settings, aiostreamsPassword: undefined })).toMatch(/no AIOStreams password saved/);
    expect(await error(undefined)).toMatch(/no AIOStreams password saved/);
    expect(await error(settings, "https://elsewhere.example/x/manifest.json")).toMatch(/PUBLIC_BASE_URL/);
    expect(none.calls).toHaveLength(0);
    expect(await error({ ...settings, aiostreamsPassword: "changed since" })).toMatch(/didn't accept the saved password/);
    vi.restoreAllMocks();
    const refused = aiostreams([other], () => json({ success: false, error: { code: "USER_INVALID_CONFIG", message: "Invalid   timeout\nfor BttrSubs" } }, 400));
    expect(await error(settings)).toBe("AIOStreams didn't save it (Invalid timeout for BttrSubs). Add the install URL there yourself");
    expect(refused.saved).toHaveLength(1);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect refused"));
    expect(await error(settings)).toMatch(/^AIOStreams didn't answer\./);
  });
});

describe("the timeout this addon's entry needs", () => {
  it("is the list's time, its grace and a second and a half over them", async () => {
    const { config } = await import("../src/config.js");
    const { entryTimeoutMs } = await import("../src/aiostreamsAddon.js");
    const before = { budget: config.listBudgetMs, grace: config.fileWaitMs };
    try {
      config.listBudgetMs = 8000;
      config.fileWaitMs = 1500;
      expect(entryTimeoutMs()).toBe(11000);
      config.fileWaitMs = 6000;
      expect(entryTimeoutMs()).toBe(15500);
    } finally {
      config.listBudgetMs = before.budget;
      config.fileWaitMs = before.grace;
    }
  });
});

describe("the grace a configuration's lists may use", () => {
  it("is the one set only as far as its entry's timeout in AIOStreams allows, read in the background", async () => {
    const { config } = await import("../src/config.js");
    const { forgetEntryTimeouts, graceWithin, fileWaitFor } = await import("../src/aiostreamsAddon.js");
    const before = { budget: config.listBudgetMs, grace: config.fileWaitMs, base: config.publicBaseUrl };
    const url = settings.aiostreams!;
    let reads = 0;
    const answering = (timeout: number) =>
      vi.stubGlobal("fetch", async () => {
        reads++;
        return json({ data: { userData: { presets: [other, entry(MINE, { timeout })] } } });
      });
    try {
      config.publicBaseUrl = BASE;
      config.listBudgetMs = 8000;
      // At the default nothing is read.
      config.fileWaitMs = 1500;
      answering(15500);
      expect(fileWaitFor(url, "secret")).toBe(1500);
      expect(reads).toBe(0);
      // Set longer: the default until the entry has been read, then what its timeout leaves room for.
      config.fileWaitMs = 6000;
      expect(fileWaitFor(url, "secret")).toBe(1500);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reads).toBe(1);
      expect(fileWaitFor(url, "secret")).toBe(6000);
      expect(reads).toBe(1);
      // An entry still at its old timeout keeps the default; one in between gets what fits.
      expect(graceWithin(11000)).toBe(2000);
      expect(graceWithin(10000)).toBe(1500);
      expect(graceWithin(13000)).toBe(4000);
      expect(graceWithin(undefined)).toBe(1500);
      // No password saved: its entry can't be read.
      forgetEntryTimeouts();
      expect(fileWaitFor(url, undefined)).toBe(1500);
      expect(reads).toBe(1);
    } finally {
      forgetEntryTimeouts();
      config.listBudgetMs = before.budget;
      config.fileWaitMs = before.grace;
      config.publicBaseUrl = before.base;
      vi.unstubAllGlobals();
    }
  });
});
