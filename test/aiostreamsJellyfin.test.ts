import { afterEach, describe, expect, it, vi } from "vitest";
import { jellyfinBase, jellyfinHeaders, jellyfinItemIds, jellyfinVersions } from "../src/aiostreamsJellyfin.js";
import { forgetInstallUrls, noteInstallUrls, otherInstallUrls, passwordOf } from "../src/installUrls.js";
import { forgetAccounts } from "../src/aiostreamsAccount.js";
import { forgetStreams, streamCandidates } from "../src/sync.js";

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
const KEY = "k".repeat(60);
const PASSWORD = "the password";
const PLAYED = "Show.S01E07.2160p.WEB-DL.DDP5.1.HEVC-TEAM";

afterEach(() => {
  vi.restoreAllMocks();
  forgetStreams();
  forgetInstallUrls();
  forgetAccounts();
});

describe("a title's item id on AIOStreams' Jellyfin server", () => {
  it("packs an IMDb episode as the server does: mark, kind and id type, media type, number, season, episode", () => {
    expect(jellyfinItemIds("tt7654321:1:1", "series")[0]).toBe("a14102000000" + (7654321).toString(16).padStart(6, "0") + "00010001000000");
    expect(jellyfinItemIds("tt7654321:12:345", "series")[0].slice(18, 26)).toBe("000c0159");
  });

  it("packs a film with no season or episode, and tries anime after the title's own media type", () => {
    const [film, anime] = jellyfinItemIds("tt0000042", "movie");
    expect(film).toBe("a1110100000000002affffffff000000");
    expect(anime).toBe("a1110300000000002affffffff000000");
    expect(jellyfinItemIds("tt7654321:1:1", "series").map((id) => id.slice(4, 6))).toEqual(["02", "03"]);
  });

  it("packs an anime's Kitsu id as the server does: anime first, season 1 for an episode, none for a film", () => {
    expect(jellyfinItemIds("kitsu:123456:3", "series")).toEqual(["a1440300000001e24000010003000000", "a1440200000001e24000010003000000"]);
    expect(jellyfinItemIds("kitsu:123456", "movie")).toEqual(["a1140300000001e240ffffffff000000", "a1140100000001e240ffffffff000000"]);
  });

  it("packs nothing for another kind of id, or an id that isn't what its type says", () => {
    for (const [id, type] of [["tmdb:123:1:4", "series"], ["kitsu:123", "series"], ["kitsu:123:4", "movie"], ["kitsu:123:1:4", "series"], ["tt7654321", "series"], ["tt7654321:1:1", "movie"], ["tt7654321:1:1", "channel"], ["7654321:1:1", "series"]]) {
      expect(jellyfinItemIds(id, type), `${id} ${type}`).toEqual([]);
    }
  });
});

describe("the versions the server holds", () => {
  const answer = (sources: unknown[]) => new Response(JSON.stringify({ MediaSources: sources, PlaySessionId: "s" }), { headers: { "content-type": "application/json" } });

  it("are asked for with the sign-in's token, without subtitles, and read as file, size and link", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      answer([
        { Path: "https://aiostreams.example.com/api/v1/x/1", Size: 123456, Protocol: "Http", aiostreams: { filename: `${PLAYED}.mkv` } },
        // A notice, a version with no file name, and one that isn't a link are left out.
        { Path: "https://aiostreams.example.com/notice", Size: 0, aiostreams: {} },
        { Size: 5, aiostreams: { filename: "no.path.mkv" } },
        { Path: "file:///x", aiostreams: { filename: "local.mkv" } },
        { Path: "https://aiostreams.example.com/api/v1/x/2", aiostreams: { filename: "Show.S01E07.720p-CREW" } },
      ])
    );
    const versions = await jellyfinVersions(AIO, KEY, "a1" + "0".repeat(30), 5000, "203.0.113.9");
    expect(versions).toEqual([
      { url: "https://aiostreams.example.com/api/v1/x/1", filename: `${PLAYED}.mkv`, size: 123456 },
      { url: "https://aiostreams.example.com/api/v1/x/2", filename: "Show.S01E07.720p-CREW", size: undefined },
    ]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://aiostreams:3000/jellyfin/Items/a1${"0".repeat(30)}/PlaybackInfo`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ SkipSubtitles: true });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toContain(`Token="${KEY}"`);
    expect(headers["X-AIOStreams-User-IP"]).toBe("203.0.113.9");
  });

  it("are undefined when the server refuses, and a token can't break out of its header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
    expect(await jellyfinVersions(AIO, KEY, "a1", 5000)).toBeUndefined();
    expect(jellyfinHeaders('ab"c d\\e').Authorization).toContain('Token="abcde"');
    expect(jellyfinBase("https://aiostreams.example.com/stremio/u/p/manifest.json")).toBe("https://aiostreams.example.com/jellyfin");
  });
});

describe("a file only a player signed in to AIOStreams' Jellyfin server was shown", () => {
  const list = (...names: string[]) => new Response(JSON.stringify({ streams: names.map((filename) => ({ url: `https://debrid.example/${filename}`, behaviorHints: { filename } })) }), { headers: { "content-type": "application/json" } });
  const versions = (...names: string[]) => new Response(JSON.stringify({ MediaSources: names.map((filename) => ({ Path: `https://aiostreams.example.com/api/v1/play/${filename}`, Size: 1000, aiostreams: { filename } })) }), { headers: { "content-type": "application/json" } });

  // An AIOStreams with no linked apps, whose Jellyfin server signs the account in and answers `held` for a title.
  const server = (held: () => Response, listed: () => Response = () => list("Show.S01E07.720p-CREW")) => async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/linked-accounts")) return new Response(JSON.stringify({ success: true, data: [] }), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/jellyfin/Users/AuthenticateByName")) return new Response(JSON.stringify({ AccessToken: KEY }), { headers: { "content-type": "application/json" } });
    if (url.includes("/jellyfin/")) return String((init?.headers as Record<string, string>).Authorization).includes(`Token="${KEY}"`) ? held() : new Response("{}", { status: 401 });
    return listed();
  };
  const asked = (fetch: { mock: { calls: unknown[][] } }) =>
    fetch.mock.calls.map((c) => String(c[0])).map((url) => (url.includes("linked-accounts") ? "linked accounts" : url.includes("AuthenticateByName") ? "sign-in" : url.includes("/jellyfin/") ? "jellyfin" : url.includes("/pass-copy/") ? "copy" : "first"));

  it("is found among the server's versions once no install URL lists it", async () => {
    const COPY = "http://aiostreams:3000/stremio/uuid/pass-copy/manifest.json";
    noteInstallUrls(AIO, [COPY], PASSWORD);
    expect(otherInstallUrls(AIO)).toEqual([COPY]);
    expect(passwordOf(AIO)).toBe(PASSWORD);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(server(() => versions("Show.S01E07.720p-CREW", `${PLAYED}.mkv`)));
    const found = await streamCandidates(AIO, "tt0000007:1:7", "series", PLAYED);
    expect(found[0]).toMatchObject({ url: `https://aiostreams.example.com/api/v1/play/${PLAYED}.mkv`, how: "name" });
    // The first URL, the linked apps' (none), its copy, then a sign-in and the server once: the first item id had the file.
    expect(asked(fetch)).toEqual(["first", "linked accounts", "copy", "sign-in", "jellyfin"]);
  });

  it("isn't asked for when a list has the file, without a password, or for a title it can't name", async () => {
    noteInstallUrls(AIO, [], PASSWORD);
    let fetch = vi.spyOn(globalThis, "fetch").mockImplementation(server(() => versions(), () => list(`${PLAYED}.mkv`)));
    expect((await streamCandidates(AIO, "tt0000007:1:7", "series", PLAYED))[0]?.how).toBe("name");
    expect(asked(fetch)).toEqual(["first"]);
    vi.restoreAllMocks();
    fetch = vi.spyOn(globalThis, "fetch").mockImplementation(server(() => versions(`${PLAYED}.mkv`)));
    expect(await streamCandidates(AIO, "tt0000007", "series", PLAYED)).toEqual([]);
    // No sign-in for a title the server can't be asked about.
    expect(asked(fetch)).toEqual(["first", "linked accounts"]);
    vi.restoreAllMocks();
    forgetInstallUrls();
    fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => list("Show.S01E07.720p-CREW"));
    expect(await streamCandidates(AIO, "tt0000007:1:8", "series", PLAYED)).toEqual([]);
    expect(fetch.mock.calls.length).toBe(1);
  });

  it("is looked for under the title's second item id when the first doesn't have it, and a failing server is passed over", async () => {
    noteInstallUrls(AIO, [], PASSWORD);
    const tried: string[] = [];
    const answering = server(() => versions(`${PLAYED}.mkv`));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes("/Items/")) return answering(input, init);
      tried.push(url.split("/Items/")[1].slice(4, 6));
      if (tried.length === 1) throw new Error("connect refused");
      return answering(input, init);
    });
    expect((await streamCandidates(AIO, "tt0000007:1:9", "series", PLAYED))[0]?.how).toBe("name");
    expect(tried).toEqual(["02", "03"]);
    // One sign-in serves both.
    expect(asked(fetch).filter((what) => what === "sign-in")).toHaveLength(1);
  });
});
