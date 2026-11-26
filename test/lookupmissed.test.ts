/**
 * The wait for the playing file's header (fileHasSubtitles) on a file that is in none of AIOStreams'
 * lists: the longer wait a slow-opening file is given isn't spent on it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetInstallUrls } from "../src/installUrls.js";
import { fileHasSubtitles, forgetStreams, lookupMissed } from "../src/sync.js";

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
const PLAYED = "Show.S01E07.2160p.WEB-DL.HEVC-TEAM";
const list = (...names: string[]) => new Response(JSON.stringify({ streams: names.map((filename) => ({ url: `https://debrid.example/${filename}`, behaviorHints: { filename } })) }), { headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  forgetStreams();
  forgetInstallUrls();
});

describe("a file in none of AIOStreams' lists", () => {
  it("is waited for the short time only, from the moment its first lookup has missed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (String(input).includes("/stream/") ? list("Show.S01E07.720p.WEB.h264-CREW.mkv") : new Response("{}", { status: 404 })));
    const began = Date.now();
    expect(lookupMissed(PLAYED)).toBe(false);
    expect(await fileHasSubtitles(AIO, "tt0000007:1:7", "series", PLAYED, 6000, 300)).toBeUndefined();
    expect(lookupMissed(PLAYED)).toBe(true);
    expect(Date.now() - began).toBeLessThan(3000);
  }, 15000);

  it("is waited for the whole time while its list is still being searched for", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (!String(input).includes("/stream/")) return new Response("{}", { status: 404 });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return list("Show.S01E07.720p.WEB.h264-CREW.mkv");
    });
    const began = Date.now();
    expect(await fileHasSubtitles(AIO, "tt0000008:1:7", "series", `${PLAYED}.2`, 1200, 100)).toBeUndefined();
    expect(Date.now() - began).toBeGreaterThanOrEqual(1150);
    expect(lookupMissed(`${PLAYED}.2`)).toBe(false);
  }, 15000);
});
