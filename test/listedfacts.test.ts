/**
 * AIOStreams' record of the playing file (its streamData, src/sync.ts listedFacts): read only when
 * measured from the file, only from the stream that is surely the playing file, and used only where
 * the file's own header read hasn't answered in time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddedLanguages, factsOfListed, fileDuration, forgetListedFacts, hasEnglishVoices, streamCandidates } from "../src/sync.js";

afterEach(() => {
  vi.restoreAllMocks();
  forgetListedFacts();
});

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";

/** A record as AIOStreams sends it: language names, ffprobe's codec names. */
const record = (source: string, over: Record<string, unknown> = {}) => ({
  duration: 1_422_700,
  parsedFile: {
    mediaInfoSource: source,
    audioTracks: [{ lang: "English", codec: "eac3" }, { lang: "Japanese", codec: "eac3" }],
    subtitleTracks: [
      { lang: "English", codec: "subrip", title: "English" },
      { lang: "English", codec: "ass", title: "Signs & Songs" },
      { lang: "Spanish", codec: "subrip", forced: true },
      { lang: "Arabic", codec: "hdmv_pgs_subtitle" },
      { lang: "Portuguese (BR)", codec: "webvtt" }
    ],
    ...over
  }
});

describe("AIOStreams' record of a file", () => {
  it("gives full text subtitle languages, audio languages and length, from a record measured from the file", () => {
    expect(factsOfListed(record("local"))).toEqual({ textLangs: ["en", "pt-br"], audioLangs: ["en", "ja"], duration: 1_422_700 });
    expect(factsOfListed(record("stremthru"))?.textLangs).toEqual(["en", "pt-br"]);
  });

  it("is nothing from a record matched by name or from nowhere, or no record at all", () => {
    for (const source of ["remuxdb", "remote", "stremthru-addon", ""]) expect(factsOfListed(record(source)), source).toBeUndefined();
    expect(factsOfListed(undefined)).toBeUndefined();
    expect(factsOfListed({ duration: 5 })).toBeUndefined();
  });

  it("leaves a subtitle language it doesn't know out, and counts such an audio one as unknown", () => {
    const facts = factsOfListed(record("local", { audioTracks: [{ lang: "Klingon" }], subtitleTracks: [{ lang: "Klingon", codec: "subrip" }] }));
    expect(facts).toMatchObject({ textLangs: [], audioLangs: ["und"] });
  });
});

describe("a lookup's record of the playing file", () => {
  const listing = (streams: unknown[]) => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ streams }), { headers: { "content-type": "application/json" } }));
  const stream = (filename: string, videoSize: number, streamData?: unknown) => ({ url: `https://debrid.example/${videoSize}`, behaviorHints: { filename, videoSize }, ...(streamData ? { streamData } : {}) });

  it("asks as an AIOStreams client, and answers for the file until its own header read does", async () => {
    const file = "Show.S01E07.Listed.mkv/1000";
    const fetch = listing([stream("Show.S01E07.Listed.mkv", 1000, record("local")), stream("Show.S01E07.Other.mkv", 2000, record("local", { audioTracks: [{ lang: "Japanese" }] }))]);
    await streamCandidates(AIO, "tt0000006:1:7", "series", file);
    expect(new Headers((fetch.mock.calls[0][1] as RequestInit).headers).get("User-Agent")).toMatch(/^AIOStreams\//);
    expect(await embeddedLanguages(file, 0)).toEqual(["en", "pt-br"]);
    expect(await hasEnglishVoices(file, 0)).toBe(true);
    expect(await fileDuration(file)).toBe(1_422_700);
  });

  it("takes no record from a stream that may be another file, or one matched by name only", async () => {
    // Two streams under the playing file's name and no size from the player: which one it is isn't known.
    listing([stream("Show.S01E08.Twice.mkv", 1000, record("local")), stream("Show.S01E08.Twice.mkv", 2000, record("local"))]);
    await streamCandidates(AIO, "tt0000006:1:8", "series", "Show.S01E08.Twice.mkv");
    expect(await embeddedLanguages("Show.S01E08.Twice.mkv", 0)).toBeUndefined();
    // The name at another size than the player's.
    listing([stream("Show.S01E09.Sized.mkv", 1001, record("local"))]);
    await streamCandidates(AIO, "tt0000006:1:9", "series", "Show.S01E09.Sized.mkv/1000");
    expect(await embeddedLanguages("Show.S01E09.Sized.mkv/1000", 0)).toBeUndefined();
    // A record matched by the release's name.
    listing([stream("Show.S01E10.Remux.mkv", 1000, record("remuxdb"))]);
    await streamCandidates(AIO, "tt0000006:1:10", "series", "Show.S01E10.Remux.mkv/1000");
    expect(await hasEnglishVoices("Show.S01E10.Remux.mkv/1000", 0)).toBeUndefined();
  });

  it("tells a file with no English voices by its record", async () => {
    listing([stream("Show.S01E11.Original.mkv", 1000, record("local", { audioTracks: [{ lang: "Japanese", codec: "aac" }] }))]);
    await streamCandidates(AIO, "tt0000006:1:11", "series", "Show.S01E11.Original.mkv/1000");
    expect(await hasEnglishVoices("Show.S01E11.Original.mkv/1000", 0)).toBe(false);
  });
});
