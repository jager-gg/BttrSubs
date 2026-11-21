import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Settings } from "../src/profile.js";

const UUID = "1234abcd-0000-4000-8000-000000000001";
const ADDRESS = "https://aiostreams.example.com";
const URL_OF = (encrypted: string) => `${ADDRESS}/stremio/${UUID}/${encrypted}/manifest.json`;
const form = { opensubtitles: true, languages: ["English"], hearingImpaired: "include" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let save: typeof import("../src/configure.js").saveConfiguration;
let check: typeof import("../src/configure.js").checkStep;

beforeAll(async () => {
  process.env.CONFIG_SECRET = "account-test-secret-account-test-secret-1";
  process.env.ALLOWED_AIOSTREAMS = ADDRESS;
  process.env.PUBLIC_BASE_URL = "https://sync.example";
  ({ saveConfiguration: save, checkStep: check } = await import("../src/configure.js"));
});

afterEach(() => vi.restoreAllMocks());

/** An AIOStreams that signs `password` in, writing `encrypted` into the install URL, and knows the manifests named. */
function aiostreams(password: string, encrypted: string, known: string[] = [encrypted]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `${ADDRESS}/api/v1/user`) {
      const sent = Buffer.from(String((init?.headers as Record<string, string>).Authorization).replace("Basic ", ""), "base64").toString();
      return sent === `${UUID}:${password}` ? json({ success: true, data: { userData: {}, encryptedPassword: encrypted } }) : json({ success: false }, 401);
    }
    return known.some((k) => url === URL_OF(k)) ? json({ id: "aiostreams" }) : json({}, 404);
  });
}

describe("setting up a configuration's AIOStreams account", () => {
  it("signs in with the address, UUID and password, and keeps the install URL AIOStreams writes and the password", async () => {
    aiostreams("secret", "E2-minted");
    const saved = await save({ ...form, aiostreamsAddress: `${ADDRESS}/`, aiostreamsId: UUID.toUpperCase(), aiostreamsPassword: "secret" });
    expect("error" in saved ? saved.error : (saved.settings as Settings)).toMatchObject({ aiostreams: URL_OF("E2-minted"), aiostreamsPassword: "secret" });
    expect(await check("sync", { aiostreamsAddress: ADDRESS, aiostreamsId: UUID, aiostreamsPassword: "secret" })).toEqual({ ok: true });
  });

  it("says which part is wrong: no password, no UUID, a UUID that isn't one, another instance, a refused pair, no answer", async () => {
    aiostreams("secret", "E2-minted");
    const error = async (input: Record<string, unknown>) => ((await check("sync", input)) as { error?: string }).error;
    expect(await error({ aiostreamsAddress: ADDRESS, aiostreamsId: UUID })).toMatch(/^AIOStreams password: needed/);
    expect(await error({ aiostreamsAddress: ADDRESS, aiostreamsPassword: "secret" })).toMatch(/^AIOStreams UUID: needed/);
    expect(await error({ aiostreamsId: UUID, aiostreamsPassword: "secret" })).toMatch(/^AIOStreams address: needed/);
    expect(await error({ aiostreamsAddress: ADDRESS, aiostreamsId: "1234", aiostreamsPassword: "secret" })).toMatch(/^AIOStreams UUID: that doesn't look like one/);
    expect(await error({ aiostreamsAddress: "https://elsewhere.example", aiostreamsId: UUID, aiostreamsPassword: "secret" })).toMatch(/^AIOStreams address: must be a supported/);
    expect(await error({ aiostreamsAddress: ADDRESS, aiostreamsId: UUID, aiostreamsPassword: "wrong" })).toMatch(/^AIOStreams password: that AIOStreams didn't accept/);
    expect(await error({})).toMatch(/^AIOStreams address: needed/);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect refused"));
    expect(await error({ aiostreamsAddress: ADDRESS, aiostreamsId: UUID, aiostreamsPassword: "secret" })).toMatch(/^AIOStreams address: it didn't answer/);
  });

  it("keeps a saved account as it is when nothing is typed, and its install URL when only the password is new", async () => {
    const current: Settings = { opensubtitles: true, aiostreams: URL_OF("E2-first"), aiostreamsPassword: "secret", languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    const fetch = aiostreams("changed", "E2-second", ["E2-first", "E2-second"]);
    const untouched = await save({ ...form, aiostreamsAddress: ADDRESS, aiostreamsId: UUID }, current);
    expect("error" in untouched ? untouched.error : untouched.settings).toMatchObject({ aiostreams: URL_OF("E2-first"), aiostreamsPassword: "secret" });
    expect(fetch.mock.calls.length).toBe(0);
    // A new password for the same account: signed in, and the URL its readings are kept under stays while it works.
    const repassworded = await save({ ...form, aiostreamsAddress: ADDRESS, aiostreamsId: UUID, aiostreamsPassword: "changed" }, current);
    expect("error" in repassworded ? repassworded.error : repassworded.settings).toMatchObject({ aiostreams: URL_OF("E2-first"), aiostreamsPassword: "changed" });
    // Once AIOStreams no longer knows the saved URL, the one it writes now takes its place.
    vi.restoreAllMocks();
    aiostreams("changed", "E2-second", ["E2-second"]);
    const replaced = await save({ ...form, aiostreamsPassword: "changed" }, current);
    expect("error" in replaced ? replaced.error : replaced.settings).toMatchObject({ aiostreams: URL_OF("E2-second"), aiostreamsPassword: "changed" });
  });

  it("forgets the password on \"remove\" and keeps the account, and a saved install URL needs no password", async () => {
    const current: Settings = { opensubtitles: true, aiostreams: URL_OF("E2-first"), aiostreamsPassword: "secret", languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    aiostreams("secret", "E2-first");
    const forgotten = await save({ ...form, aiostreamsPassword: "remove" }, current);
    expect("error" in forgotten ? forgotten.error : forgotten.settings).toMatchObject({ aiostreams: URL_OF("E2-first") });
    expect("error" in forgotten ? undefined : forgotten.settings.aiostreamsPassword).toBeUndefined();
    const { aiostreamsPassword: _p, ...older } = current;
    const kept = await save({ ...form, aiostreamsAddress: ADDRESS, aiostreamsId: UUID }, older);
    expect("error" in kept ? kept.error : kept.settings).toMatchObject({ aiostreams: URL_OF("E2-first") });
    // Another UUID without a password is a new account, which only a sign-in gives.
    const moved = await save({ ...form, aiostreamsAddress: ADDRESS, aiostreamsId: "9999ffff-0000-4000-8000-000000000009" }, current);
    expect("error" in moved ? moved.error : "").toMatch(/^AIOStreams password: needed/);
  });
});

describe("testing the account on the Sync step", () => {
  let test: typeof import("../src/configure.js").testAccount;
  beforeAll(async () => {
    ({ testAccount: test } = await import("../src/configure.js"));
  });
  const typed = { aiostreamsAddress: ADDRESS, aiostreamsId: UUID, aiostreamsPassword: "secret" };

  /** An AIOStreams that signs `password` in, lists `linked` (none: an instance without linked accounts), and answers its Jellyfin sign-in with `jellyfin`. */
  function instance(password: string, linked?: unknown[], jellyfin = 200) {
    const basicOk = (init?: RequestInit) => String((init?.headers as Record<string, string>)?.Authorization) === `Basic ${Buffer.from(`${UUID}:${password}`).toString("base64")}`;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${ADDRESS}/api/v1/user`) return basicOk(init) ? json({ success: true, data: { encryptedPassword: "E2-minted" } }) : json({ success: false }, 401);
      if (url === `${ADDRESS}/api/v1/linked-accounts`) return !basicOk(init) ? json({}, 401) : linked ? json({ success: true, data: linked }) : json({}, 404);
      if (url === `${ADDRESS}/jellyfin/Users/AuthenticateByName`) return jellyfin === 200 ? json({ AccessToken: "token" }) : json({}, jellyfin);
      return url.startsWith(`${ADDRESS}/stremio/${UUID}/`) ? json({ id: "aiostreams" }) : json({}, 404);
    });
  }
  const stremio = (lastStatus?: string) => ({ platform: "stremio", ...(lastStatus ? { lastStatus } : {}), config: { manifestUrls: [URL_OF("E2-pushed")] } });

  it("signs in once with what is typed, and says what each kind of app has", async () => {
    const fetch = instance("secret", [stremio("ok")]);
    expect(await test({ ...typed, aiostreamsAlso: URL_OF("E2-aiometadata") })).toEqual({ signIn: "ok", jellyfin: "ready", stremio: "linked", also: "matches" });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/user")).length).toBe(1);
  });

  it("tells a Stremio not linked, not pushed, failed and expired apart, and an instance without linked accounts", async () => {
    for (const [linked, state] of [[[], "unlinked"], [[stremio()], "unpushed"], [[stremio("error")], "failed"], [[stremio("expired")], "expired"], [[{ platform: "aiomanager", lastStatus: "ok", config: { manifestUrls: [] } }], "unlinked"], [undefined, "unavailable"]] as const) {
      vi.restoreAllMocks();
      instance("secret", linked as unknown[] | undefined);
      expect((await test(typed)).stremio, state).toBe(state);
    }
  });

  it("says when AIOStreams' Jellyfin server is off, and when AIOMetadata's URL is another account's", async () => {
    instance("secret", [], 404);
    const found = await test({ ...typed, aiostreamsAlso: `${ADDRESS}/stremio/9999ffff-0000-4000-8000-000000000009/E2-other/manifest.json` });
    expect(found).toMatchObject({ signIn: "ok", jellyfin: "off", stremio: "unlinked" });
    expect(found.also).toEqual({ error: expect.stringMatching(/^Another install URL: it is for another AIOStreams account/) });
  });

  it("uses the saved password for the saved account, signs in with nothing missing only, and doesn't fall back after Forget it", async () => {
    const current: Settings = { opensubtitles: true, aiostreams: URL_OF("E2-first"), aiostreamsPassword: "secret", languages: ["English"], allowMachine: false, hearingImpaired: "include" };
    const fetch = instance("secret", []);
    expect((await test({ aiostreamsAddress: ADDRESS, aiostreamsId: UUID }, current)).signIn).toBe("ok");
    fetch.mockClear();
    expect(await test({ aiostreamsAddress: ADDRESS, aiostreamsId: UUID, aiostreamsPassword: "remove" }, current)).toEqual({ signIn: "incomplete" });
    expect(await test({ aiostreamsAddress: ADDRESS, aiostreamsId: "9999ffff-0000-4000-8000-000000000009" }, current)).toEqual({ signIn: "incomplete" });
    expect(await test({ aiostreamsAddress: ADDRESS, aiostreamsPassword: "secret" })).toEqual({ signIn: "incomplete" });
    expect(await test({ ...typed, aiostreamsId: "1234" })).toEqual({ signIn: { error: expect.stringMatching(/^AIOStreams UUID: that doesn't look like one/) } });
    expect(await test({ ...typed, aiostreamsAddress: "https://elsewhere.example" })).toEqual({ signIn: { error: expect.stringMatching(/^AIOStreams address: must be a supported/) } });
    expect(fetch.mock.calls.length).toBe(0);
  });

  it("stops at a refused pair or an AIOStreams that doesn't answer, asking nothing more", async () => {
    const fetch = instance("secret", []);
    expect(await test({ ...typed, aiostreamsPassword: "wrong" })).toEqual({ signIn: "refused" });
    expect(fetch.mock.calls.length).toBe(1);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect refused"));
    expect(await test(typed)).toEqual({ signIn: "unanswered" });
  });
});
