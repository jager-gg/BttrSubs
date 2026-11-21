import { afterEach, describe, expect, it, vi } from "vitest";
import { accountIn, forgetAccounts, jellyfinToken, linkedInstallUrls, signIn } from "../src/aiostreamsAccount.js";
import { forgetInstallUrls, noteInstallUrls } from "../src/installUrls.js";
import { forgetStreams, streamCandidates } from "../src/sync.js";

const UUID = "1234abcd-0000-4000-8000-000000000001";
const AIO = `http://aiostreams:3000/stremio/${UUID}/pass/manifest.json`;
const PASSWORD = "the pass:word";
const PLAYED = "Show.S01E07.2160p.WEB-DL.DDP5.1.HEVC-TEAM";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const basicOf = (init?: RequestInit) => Buffer.from(String((init?.headers as Record<string, string>).Authorization).replace("Basic ", ""), "base64").toString();

afterEach(() => {
  vi.restoreAllMocks();
  forgetStreams();
  forgetInstallUrls();
  forgetAccounts();
});

describe("signing in to AIOStreams with a configuration's UUID and password", () => {
  it("names the instance and account an install URL holds", () => {
    expect(accountIn(AIO)).toEqual({ origin: "http://aiostreams:3000", uuid: UUID });
    expect(accountIn("https://aiostreams.example.com/stremio/u/alias/manifest.json")).toEqual({ origin: "https://aiostreams.example.com", uuid: "u" });
    expect(accountIn("https://aiostreams.example.com/manifest.json")).toBeUndefined();
  });

  it("answers the password as AIOStreams writes it into an install URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ success: true, data: { userData: {}, encryptedPassword: "E2-new" } }));
    expect(await signIn("http://aiostreams:3000", UUID, PASSWORD, 5000)).toEqual({ encryptedPassword: "E2-new" });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://aiostreams:3000/api/v1/user");
    // The password's own colon stays in it: only the first one parts the UUID from it.
    expect(basicOf(init)).toBe(`${UUID}:${PASSWORD}`);
  });

  it("says refused for a pair AIOStreams turns away, and nothing when it doesn't answer or answers no password", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ success: false }, 401));
    expect(await signIn("http://aiostreams:3000", UUID, "wrong", 5000)).toBe("refused");
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({}, 502));
    expect(await signIn("http://aiostreams:3000", UUID, PASSWORD, 5000)).toBeUndefined();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect refused"));
    expect(await signIn("http://aiostreams:3000", UUID, PASSWORD, 5000)).toBeUndefined();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: { encryptedPassword: "has/slash" } }));
    expect(await signIn("http://aiostreams:3000", UUID, PASSWORD, 5000)).toBeUndefined();
  });
});

describe("the install URLs AIOStreams put into linked apps", () => {
  const linked = (...urls: string[]) => json({ success: true, data: [{ platform: "stremio", config: { manifestUrls: urls } }] });

  it("are this account's only, asked at the address the first one is, and read once for a play's lookups", async () => {
    noteInstallUrls(AIO, [], PASSWORD);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      linked(
        `https://aiostreams.example.com/stremio/${UUID}/E2-in-the-app/manifest.json`,
        // Another account's, the first one itself, an alias and a line that is no URL are left out.
        "https://aiostreams.example.com/stremio/9999ffff-0000-4000-8000-000000000009/E2-other/manifest.json",
        `https://aiostreams.example.com/stremio/${UUID}/pass/manifest.json`,
        "https://aiostreams.example.com/stremio/u/alias/manifest.json",
        "not a url"
      )
    );
    expect(await linkedInstallUrls(AIO, 5000)).toEqual([`http://aiostreams:3000/stremio/${UUID}/E2-in-the-app/manifest.json`]);
    expect(await linkedInstallUrls(AIO, 5000)).toHaveLength(1);
    expect(fetch.mock.calls.length).toBe(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://aiostreams:3000/api/v1/linked-accounts");
    expect(basicOf(init)).toBe(`${UUID}:${PASSWORD}`);
  });

  it("are none without a password, and a refused password is left alone", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({}, 401));
    expect(await linkedInstallUrls(AIO, 5000)).toEqual([]);
    expect(fetch.mock.calls.length).toBe(0);
    noteInstallUrls(AIO, [], PASSWORD);
    expect(await linkedInstallUrls(AIO, 5000)).toEqual([]);
    expect(await linkedInstallUrls(AIO, 5000)).toEqual([]);
    expect(await jellyfinToken(AIO, 5000)).toBeUndefined();
    expect(fetch.mock.calls.length).toBe(1);
    // A new password is tried.
    noteInstallUrls(AIO, [], "another");
    await linkedInstallUrls(AIO, 5000);
    expect(fetch.mock.calls.length).toBe(2);
  });

  it("find the file a linked app is playing when the first install URL's list lacks it", async () => {
    noteInstallUrls(AIO, [], PASSWORD);
    const list = (...names: string[]) => json({ streams: names.map((filename) => ({ url: `https://debrid.example/${filename}`, behaviorHints: { filename } })) });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/linked-accounts")) return linked(`https://aiostreams.example.com/stremio/${UUID}/E2-in-the-app/manifest.json`);
      return url.includes("/E2-in-the-app/") ? list("Show.S01E07.720p-CREW", `${PLAYED}.mkv`) : list("Show.S01E07.720p-CREW");
    });
    const found = await streamCandidates(AIO, "tt0000007:1:7", "series", PLAYED);
    expect(found[0]).toMatchObject({ url: `https://debrid.example/${PLAYED}.mkv`, how: "name" });
    expect(fetch.mock.calls.map((c) => (String(c[0]).includes("linked-accounts") ? "linked accounts" : String(c[0]).includes("/E2-in-the-app/") ? "the app's" : "first"))).toEqual(["first", "linked accounts", "the app's"]);
  });
});

describe("a sign-in to AIOStreams' own Jellyfin server", () => {
  it("is made once with the UUID and password, and reused", async () => {
    noteInstallUrls(AIO, [], PASSWORD);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ AccessToken: "token-1", User: {} }));
    expect(await jellyfinToken(AIO, 5000)).toBe("token-1");
    expect(await jellyfinToken(AIO, 5000)).toBe("token-1");
    expect(fetch.mock.calls.length).toBe(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://aiostreams:3000/jellyfin/Users/AuthenticateByName");
    expect(JSON.parse(String(init.body))).toEqual({ Username: UUID, Pw: PASSWORD });
  });

  it("is none when the server is off, and a failed try isn't kept", async () => {
    noteInstallUrls(AIO, [], PASSWORD);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({}, 404));
    expect(await jellyfinToken(AIO, 5000)).toBeUndefined();
    expect(await jellyfinToken(AIO, 5000)).toBeUndefined();
    expect(fetch.mock.calls.length).toBe(2);
  });
});
