import { afterEach, describe, expect, it, vi } from "vitest";
import { countedToday } from "../src/stats.js";
import { forgetInstallUrls, noteInstallUrls } from "../src/installUrls.js";
import { fileName, fileRef, forgetStandIns, forgetStreams, LINK_OPEN_TIMEOUT_MS, lookUpStream, lookUpStreamAgain, sameFileRef, servedName, streamCandidates } from "../src/sync.js";

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
const PLAYED = "Show.S01E07.2160p.ATVP.WEB-DL.DDPA5.1.HDR.HEVC-TEAM";
const stream = (filename: string) => ({ url: `https://debrid.example/${encodeURIComponent(filename)}`, behaviorHints: { filename } });
const list = (...names: string[]) => new Response(JSON.stringify({ streams: names.map(stream) }), { headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  forgetStreams();
  forgetInstallUrls();
  forgetStandIns();
});

describe("a link that serves another release than the one it is listed under", () => {
  const FAILED = "Show - S01E09 - 009 [1080p][JA+EN]-TEAM";
  const NEXT = "Show.S01E09.1080p.BluRay.x265-CREW";
  const OTHER = "Show.S01E09.720p.WEB.h264-CLAN";
  /** A list of these names; every link answers one byte of a file of \`size\`, named \`as\` in its Content-Disposition. */
  const site = (names: string[], as: string | undefined, size = 1_443_553_666) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/stream/")
        ? list(...names)
        : new Response(new Uint8Array(1), { status: 206, headers: { "content-range": `bytes 0-0/${size}`, ...(as ? { "content-disposition": `inline; filename="x.mkv"; filename*=UTF-8''${encodeURIComponent(as)}` } : {}) } })
    );

  it("is read and kept as the release it serves, when that one is listed too", async () => {
    const played = fileRef(FAILED, "1986148202");
    const before = countedToday("sync.standInFile");
    site([FAILED, NEXT, OTHER], `${NEXT}.mkv`);
    expect(await lookUpStreamAgain(AIO, "tt0000008:1:9", "series", played, [])).toBe(stream(FAILED).url);
    expect(countedToday("sync.standInFile")).toBe(before + 1);
    // What is read of it is kept under the release that was served, at the size served.
    expect(await sameFileRef(played)).toBe(`${NEXT}.mkv/1443553666`);
    // Only for a while: after that the played name stands for itself again, and its link is asked afresh.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 60 * 1000 + 1000);
    expect(await sameFileRef(played)).toBe(played);
    // Also once the record is all that is left of it (a server that has restarted since).
    vi.spyOn(Date, "now").mockReturnValue(now);
    forgetStandIns();
    expect(await sameFileRef(played)).toBe(`${NEXT}.mkv/1443553666`);
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 60 * 1000 + 1000);
    forgetStandIns();
    expect(await sameFileRef(played)).toBe(played);
  });

  it("is the file itself when the answer names it, names nothing, or names something the list doesn't hold", async () => {
    for (const [i, as] of [`${FAILED}.mkv`, undefined, "a1b2c3d4e5f6.mkv"].entries()) {
      const played = fileRef(FAILED, String(1_986_148_300 + i));
      const before = countedToday("sync.standInFile");
      site([FAILED, NEXT], as);
      expect(await lookUpStreamAgain(AIO, `tt0000008:1:${10 + i}`, "series", played, []), String(as)).toBe(stream(FAILED).url);
      expect(countedToday("sync.standInFile"), String(as)).toBe(before);
      expect(fileName(await sameFileRef(played)), String(as)).toBe(FAILED);
      vi.restoreAllMocks();
      forgetStreams();
    }
  });

  it("reads the file name a host gives: encoded, quoted or bare", () => {
    expect(servedName(`inline; filename="Show.mkv"; filename*=UTF-8''Sh%C3%B6w%20%5BJA%2BEN%5D.mkv`)).toBe("Shöw [JA+EN].mkv");
    expect(servedName('attachment; filename="[Group] Show 020 (BD) \\"x\\".mkv"')).toBe('[Group] Show 020 (BD) "x".mkv');
    expect(servedName("attachment; filename=Show.S01E09.mkv")).toBe("Show.S01E09.mkv");
    expect(servedName("attachment; filename*=UTF-8''%E0%A4%A; filename=\"fallback.mkv\"")).toBe("fallback.mkv");
    expect(servedName("inline")).toBeUndefined();
    expect(servedName(null)).toBeUndefined();
  });
});

/** The stream-list requests a fetch spy saw (each candidate's 1-byte read is left out). */
const lists = (fetch: { mock: { calls: unknown[][] } }) => fetch.mock.calls.filter((c) => String(c[0]).includes("/stream/")).length;

describe("a file in the list another of the configuration's install URLs gets", () => {
  const COPY = "http://aiostreams:3000/stremio/uuid/pass-copy/manifest.json";
  const OTHER = "Show.S01E07.720p.WEB.h264-CREW";
  /** The first URL's list lacks the played file unless `inFirst`; the copy's list has it. */
  const site = (inFirst = false) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (String(input).includes("/pass-copy/") || inFirst ? list(OTHER, `${PLAYED}.mkv`) : list(OTHER)));

  it("is found by asking with that URL, once the first one's list lacks it", async () => {
    noteInstallUrls(AIO, [COPY]);
    const fetch = site();
    const found = await streamCandidates(AIO, "tt0000006:1:7", "series", PLAYED);
    expect(found.map((c) => [c.url, c.how, c.remembered])).toEqual([[stream(`${PLAYED}.mkv`).url, "name", undefined]]);
    expect(fetch.mock.calls.map((c) => String(c[0]).includes("/pass-copy/"))).toEqual([false, true]);
  });

  it("asks only the first URL when its list has the file, or when the configuration has no other", async () => {
    noteInstallUrls(AIO, [COPY]);
    let fetch = site(true);
    expect((await streamCandidates(AIO, "tt0000006:1:7", "series", PLAYED))[0]?.how).toBe("name");
    expect(lists(fetch)).toBe(1);
    vi.restoreAllMocks();
    forgetInstallUrls();
    fetch = site();
    expect(await streamCandidates(AIO, "tt0000006:1:8", "series", PLAYED)).toEqual([]);
    expect(lists(fetch)).toBe(1);
  });

  it("goes on to the next URL when one fails or lacks the file too", async () => {
    const DEAD = "http://aiostreams:3000/stremio/uuid/pass-dead/manifest.json";
    noteInstallUrls(AIO, [DEAD, COPY]);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pass-dead/")) throw new Error("connect refused");
      return String(input).includes("/pass-copy/") ? list(OTHER, `${PLAYED}.mkv`) : list(OTHER);
    });
    expect((await streamCandidates(AIO, "tt0000006:1:9", "series", PLAYED))[0]?.url).toBe(stream(`${PLAYED}.mkv`).url);
    expect(lists(fetch)).toBe(3);
  });
});

describe("a file AIOStreams listed a while ago and no longer does", () => {
  const OTHERS = ["Show.S01E07.720p.WEB.h264-CREW", "Show.S01E07.XviD-CLAN"];
  /** A list for a list request; for a link's 1-byte read, what `link` answers. */
  const site = (names: () => string[], link: () => Response = () => new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1000" } })) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (String(input).includes("/stream/") ? list(...names()) : link()));

  it("is read through the link the earlier list gave: the release was dropped, and that link still leads to what plays", async () => {
    let names = [...OTHERS, `${PLAYED}.mkv`];
    site(() => names);
    expect(await lookUpStream(AIO, "tt0000005:1:7", "series", PLAYED)).toBe(stream(`${PLAYED}.mkv`).url);
    names = OTHERS;
    const found = await streamCandidates(AIO, "tt0000005:1:7", "series", PLAYED);
    expect(found.map((c) => [c.url, c.how, c.remembered !== undefined])).toEqual([[stream(`${PLAYED}.mkv`).url, "name", true]]);
    const recovered = countedToday("sync.unlistedRecovered");
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [])).toBe(stream(`${PLAYED}.mkv`).url);
    expect(countedToday("sync.unlistedRecovered")).toBe(recovered + 1);
  });

  it("stays unfound when the remembered link no longer opens", async () => {
    let names = [...OTHERS, `${PLAYED}.mkv`];
    let gone = false;
    site(() => names, () => (gone ? new Response("gone", { status: 404 }) : new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1000" } })));
    expect(await lookUpStream(AIO, "tt0000005:1:7", "series", PLAYED)).toBeDefined();
    names = OTHERS;
    gone = true;
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [])).toBeUndefined();
  });

  it("is remembered for the configuration and the title that listed it, and no other", async () => {
    let names = [...OTHERS, `${PLAYED}.mkv`];
    site(() => names);
    await lookUpStream(AIO, "tt0000005:1:7", "series", PLAYED);
    names = OTHERS;
    expect(await streamCandidates(AIO.replace("uuid", "other"), "tt0000005:1:7", "series", PLAYED)).toEqual([]);
    expect(await streamCandidates(AIO, "tt0000005:1:8", "series", PLAYED)).toEqual([]);
    // A file the list still names goes by the list, not by what was remembered.
    names = [`${PLAYED}.mkv`];
    expect((await streamCandidates(AIO, "tt0000005:1:7", "series", PLAYED))[0].remembered).toBeUndefined();
  });
});

describe("a link that takes its time", () => {
  it("is waited on for as long as AIOStreams' failover may take to settle on a file", async () => {
    // AIOStreams answers a clicked link within its failover's wait, 60 s unless set otherwise.
    expect(LINK_OPEN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    let asked: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("/stream/")) return list(`${PLAYED}.mkv`);
      asked = init?.signal ?? undefined;
      return new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1000" } });
    });
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [])).toBeDefined();
    // The link's own request carries a limit, and it hasn't run out the moment it answers.
    expect(asked).toBeDefined();
    expect(asked!.aborted).toBe(false);
  });
});

describe("finding the playing file in AIOStreams", () => {
  it("finds it by name, extension or not, with one search", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(list("Show.S01E07.720p.WEB.h264-CREW", `${PLAYED}.mkv`));
    expect(await lookUpStream(AIO, "tt0000005:1:7", "series", PLAYED)).toBe(stream(`${PLAYED}.mkv`).url);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe("http://aiostreams:3000/stremio/uuid/pass/stream/series/tt0000005%3A1%3A7.json");
  });

  it("finds nothing when failover played another file (the named one is dropped from the list)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(list("Show (2023) S01E07 (2160p ATVP WEB-DL Hybrid H265 DV HDR10+ DDP Atmos 5.1 English - SQUAD)", "Show.S01E07.XviD-CLAN"));
    expect(await lookUpStream(AIO, "tt0000005:1:7", "series", PLAYED)).toBeUndefined();
  });

  it("asks again when the file isn't in the first list, and stops once it is found", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => list("Show.S01E07.720p.WEB.h264-CREW"))
      .mockImplementationOnce(async () => list("Show.S01E07.720p.WEB.h264-CREW", `${PLAYED}.mkv`))
      .mockImplementation(async () => list());
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [1, 1])).toBe(stream(`${PLAYED}.mkv`).url);
    expect(lists(fetch)).toBe(2);
  });

  it("asks no other list for a file its name places by season and episode, or for a film", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => list());
    expect(await lookUpStreamAgain(AIO, "tt1:2:12", "series", "Show.S02E12.1080p.WEB-TEAM.mkv", [1, 1])).toBeUndefined();
    expect(await lookUpStreamAgain(AIO, "tt1", "movie", "Film 2020.mkv", [1, 1])).toBeUndefined();
    expect(lists(fetch)).toBe(6);
  });

  it("gives up after the last wait when the file is in none of the lists", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => list("Show.S01E07.XviD-CLAN"));
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [1, 1])).toBeUndefined();
    expect(lists(fetch)).toBe(3);
    // Found at once: no second look.
    fetch.mockClear();
    fetch.mockImplementation(async () => list(`${PLAYED}.mkv`));
    expect(await lookUpStreamAgain(AIO, "tt0000005:1:7", "series", PLAYED, [1, 1])).toBeDefined();
    expect(lists(fetch)).toBe(1);
  });

  it("picks the same-sized file when two listed files share a name, and keeps working without a size", async () => {
    const sized = (filename: string, videoSize: number, at: string) => ({ url: `https://debrid.example/${at}`, behaviorHints: { filename, videoSize } });
    const body = { streams: [sized("S01E06.mkv", 1000, "other-show"), sized("S01E06.mkv", 2000, "this-show")] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body)));
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("S01E06.mkv", "2000"))).toBe("https://debrid.example/this-show");
    expect(await lookUpStream(AIO, "tt1:1:6", "series", "S01E06.mkv")).toBe("https://debrid.example/other-show");
    // A size listed a little off (rounded) still picks the nearer of the two named alike.
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("S01E06.mkv", "2003"))).toBe("https://debrid.example/this-show");
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("S01E06.mkv", "1100"))).toBe("https://debrid.example/other-show");
    // A renamed file is still found by its exact size.
    expect(await lookUpStream(AIO, "tt1:1:6", "series", fileRef("Show.S01E06.mkv", "2000"))).toBe("https://debrid.example/this-show");
  });

  describe("which listed stream is the playing file, by the size its host serves", () => {
    /** A list of these streams, and each stream's host serving the given size (a 1-byte range answer). */
    function hosts(rows: Array<{ name: string; listed?: number; serves: number; at: string }>) {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/stream/")) return new Response(JSON.stringify({ streams: rows.map((r) => ({ url: `https://debrid.example/${r.at}`, behaviorHints: { filename: r.name, ...(r.listed ? { videoSize: r.listed } : {}) } })) }));
        const row = rows.find((r) => url.endsWith(`/${r.at}`))!;
        return new Response(new Uint8Array(1), { status: 206, headers: { "content-range": `bytes 0-0/${row.serves}` } });
      });
    }
    const V2 = "[Group] Show S3 - 02v2 (720p) [39DCE9CA].mkv";

    it("doesn't take another version of the release when its host serves another size", async () => {
      const fetch = hosts([{ name: "[Group] Show S3 - 02 (720p) [AE2DA9AB]", listed: 748_700_000, serves: 748_712_345, at: "v1" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:2", "series", fileRef(V2, "749008323"), [1, 1])).toBeUndefined();
      // Asked three times, and the other version opened each time, never read further.
      expect(lists(fetch)).toBe(3);
    });

    it("takes a stream listed as another version when its host serves the played file's exact size", async () => {
      hosts([{ name: "[Group] Show S3 - 02 (720p) [AE2DA9AB]", listed: 748_700_000, serves: 749_008_323, at: "same-file" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:2", "series", fileRef(V2, "749008323"), [])).toBe("https://debrid.example/same-file");
    });

    it("takes a stream under the file's own name whatever size its host serves: a player sends the listed size", async () => {
      // A debrid addon's figure a few hundred bytes off, and a usenet release listed at its whole NZB.
      hosts([{ name: V2, listed: 389_021_696, serves: 389_021_204, at: "debrid" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:2", "series", fileRef(V2, "389021696"), [])).toBe("https://debrid.example/debrid");
      hosts([{ name: V2, listed: 503_747_903, serves: 408_174_337, at: "usenet" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:2", "series", fileRef(V2, "503747903"), [])).toBe("https://debrid.example/usenet");
    });

    it("doesn't take a stream under the file's own name that serves a sliver of its size: a clip standing in for a failed release", async () => {
      const before = countedToday("sync.standIn");
      hosts([{ name: V2, listed: 14_153_922_115, serves: 21_982, at: "clip" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:2", "series", fileRef(V2, "14153922115"), [])).toBeUndefined();
      expect(countedToday("sync.standIn")).toBe(before + 1);
      // With no size from the player there is nothing to judge it against: the name stands, as before.
      hosts([{ name: V2, listed: 14_153_922_115, serves: 21_982, at: "clip" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:3", "series", V2, [])).toBe("https://debrid.example/clip");
    });

    it("without the played file's size, takes only a stream under its own name", async () => {
      hosts([{ name: "[Group] Show S3 - 02 (720p) [AE2DA9AB]", serves: 1, at: "v1" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:2", "series", V2, [])).toBeUndefined();
      hosts([{ name: V2, serves: 1, at: "v2" }]);
      expect(await lookUpStreamAgain(AIO, "tt1:3:2", "series", V2, [])).toBe("https://debrid.example/v2");
    });

    it("lists the candidates by name, then other versions, then the exact size under another name", async () => {
      hosts([
        { name: "Renamed.mkv", listed: 749_008_323, serves: 0, at: "renamed" },
        { name: "[Group] Show S3 - 02 (720p) [AE2DA9AB]", serves: 0, at: "v1" },
        { name: V2, serves: 0, at: "v2" }
      ]);
      const found = await streamCandidates(AIO, "tt1:3:2", "series", fileRef(V2, "749008323"));
      expect(found.map((c) => [c.how, c.url.split("/").at(-1)])).toEqual([["name", "v2"], ["loose", "v1"], ["size", "renamed"]]);
    });
  });

  it("keys a file by name and size, and reads the name back", () => {
    expect(fileRef("A.mkv", "123")).toBe("A.mkv/123");
    expect(fileRef("A.mkv", undefined)).toBe("A.mkv");
    expect(fileRef("A.mkv", "12x")).toBe("A.mkv");
    expect(fileName(fileRef("A.mkv", "123"))).toBe("A.mkv");
    expect(fileName("A.mkv")).toBe("A.mkv");
  });
});

describe("a usenet release listed under the name of the file inside it", () => {
  const NZB = "Show.S03E02.Episode.Title.1080p.BluRay.10bit.EAC3.2.0.x265-TEAM";
  const INNER = "k3Qm8ZxT1vB7nR5wYc2LdF9pHs6JgA4e.mkv";
  type Row = { name: string; listed: number; binge?: string; serves: number; at: string };
  const site = (rows: Row[]) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/stream/"))
        return new Response(JSON.stringify({ streams: rows.map((r) => ({ url: `https://usenet.example/${r.at}`, behaviorHints: { filename: r.name, videoSize: r.listed, ...(r.binge ? { bingeGroup: r.binge } : {}) } })) }), { headers: { "content-type": "application/json" } });
      const row = rows.find((r) => url.endsWith(`/${r.at}`))!;
      return new Response(new Uint8Array(1), { status: 206, headers: { "content-range": `bytes 0-0/${row.serves}` } });
    });
  const OTHER = { name: "Show.S03E02.Episode.Title.EAC3.2.0.1080p.Bluray.x265-TEAM", listed: 700_000_000, binge: "addon|1080p|BluRay|TEAM", serves: 616_000_000, at: "other" };

  it("is read as the playing file when it is the one stream that fits the played name and size", async () => {
    const before = countedToday("sync.innerName");
    site([{ name: INNER, listed: 880_000_123, binge: "addon|1080p|BluRay|TEAM", serves: 880_000_123, at: "inner" }, OTHER]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:2", "series", fileRef(NZB, "1000000000"), [])).toBe("https://usenet.example/inner");
    expect(countedToday("sync.innerName")).toBe(before + 1);
  });

  it("isn't, when its release marks aren't the played name's, it has none, or two such streams fit", async () => {
    site([{ name: INNER, listed: 880_000_123, binge: "addon|2160p|WEB-DL|CREW", serves: 880_000_123, at: "inner" }, OTHER]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:3", "series", fileRef(NZB, "1000000000"), [])).toBeUndefined();
    site([{ name: INNER, listed: 880_000_123, serves: 880_000_123, at: "inner" }, OTHER]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:4", "series", fileRef(NZB, "1000000000"), [])).toBeUndefined();
    site([
      { name: INNER, listed: 880_000_123, binge: "addon|1080p|BluRay|TEAM", serves: 880_000_123, at: "inner" },
      { name: "Qq7wLmN2pRs9TuVx3YzAb4CdEf5GhJk6.mkv", listed: 900_000_000, binge: "addon|1080p|BluRay|TEAM", serves: 900_000_000, at: "second" }
    ]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:5", "series", fileRef(NZB, "1000000000"), [])).toBeUndefined();
  });

  it("isn't, when its size is no share of the played one, listed or served, or the played size is unknown", async () => {
    site([{ name: INNER, listed: 500_000_000, binge: "addon|1080p|BluRay|TEAM", serves: 500_000_000, at: "small" }]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:6", "series", fileRef(NZB, "1000000000"), [])).toBeUndefined();
    site([{ name: INNER, listed: 880_000_123, binge: "addon|1080p|BluRay|TEAM", serves: 21_982, at: "clip" }]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:7", "series", fileRef(NZB, "1000000000"), [])).toBeUndefined();
    site([{ name: INNER, listed: 880_000_123, binge: "addon|1080p|BluRay|TEAM", serves: 880_000_123, at: "inner" }]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:8", "series", NZB, [])).toBeUndefined();
  });

  it("gives way to a stream under the played name", async () => {
    site([{ name: INNER, listed: 880_000_123, binge: "addon|1080p|BluRay|TEAM", serves: 880_000_123, at: "inner" }, { name: NZB, listed: 1_000_000_000, binge: "addon|1080p|BluRay|TEAM", serves: 880_000_000, at: "named" }]);
    expect(await lookUpStreamAgain(AIO, "tt2:3:9", "series", fileRef(NZB, "1000000000"), [])).toBe("https://usenet.example/named");
  });
});
