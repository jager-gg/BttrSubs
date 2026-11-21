import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { keptSubtitles, readKept, resetKept } from "../src/kept.js";
import { filterAndRankDubtitles } from "../src/matching.js";
import type { StremioSubtitleRequest } from "../src/types.js";

const root = mkdtempSync(path.join(os.tmpdir(), "kept-"));
const before = config.captionsDir;
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nA line the dub speaks.\n";
const put = (relative: string, text = SRT) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), text);
};
const episode = (season: number, n: number): StremioSubtitleRequest => ({ type: "series", id: `tt0000001:${season}:${n}`, imdbId: "tt0000001", season, episode: n });

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  config.captionsDir = root;
  resetKept();
});
afterAll(() => {
  config.captionsDir = before;
  rmSync(root, { recursive: true, force: true });
});

describe("subtitles kept on this server", () => {
  it("are listed for the episode they are named for, in the language asked for", async () => {
    put("tt0000001/S03E02.en.dub.srt");
    put("tt0000001/S03E02.ar.ass", "[Script Info]\n");
    put("tt0000001/S03E03.en.dub.srt");
    put("tt0000001/notes.txt", "not a subtitle");
    const english = await keptSubtitles(episode(3, 2), ["english"]);
    expect(english).toHaveLength(1);
    expect(english[0]).toMatchObject({ source: "kept", language: "english", episodeTrusted: true, hearingImpaired: true, files: 1 });
    expect(english[0].ref).toMatch(/^kc[0-9a-f]{16}$/);
    expect((await keptSubtitles(episode(3, 2), ["english", "arabic"])).map((s) => s.language).sort()).toEqual(["arabic", "english"]);
    expect(await keptSubtitles(episode(3, 4), ["english"])).toEqual([]);
    expect(await keptSubtitles(episode(2, 2), ["english"])).toEqual([]);
    expect(await keptSubtitles({ ...episode(3, 2), imdbId: "tt0000009" }, ["english"])).toEqual([]);
  });

  it("marked as the dub's captions are what a dub list takes; another kept subtitle isn't", async () => {
    put("tt0000001/S03E02.en.dub.srt");
    put("tt0000001/S03E02.en.srt");
    const kept = await keptSubtitles(episode(3, 2), ["english"]);
    expect(kept).toHaveLength(2);
    const dub = filterAndRankDubtitles(kept, { ...episode(3, 2), absoluteEpisode: 60 }, { requireDub: true });
    expect(dub).toHaveLength(1);
    expect(dub[0].hearingImpaired).toBe(true);
    expect(filterAndRankDubtitles(kept, { ...episode(3, 2), absoluteEpisode: 60 }, { requireDub: false })).toHaveLength(2);
  });

  it("are read by their ref, a film's too, and a changed file gets a new ref", async () => {
    put("tt0000002/film.srt");
    const film = await keptSubtitles({ type: "movie", id: "tt0000002", imdbId: "tt0000002" }, ["english"]);
    expect(film).toHaveLength(1);
    expect((await readKept(film[0].ref!)).toString()).toBe(SRT);
    // Found again on disk by a process that hasn't listed it.
    resetKept();
    expect((await readKept(film[0].ref!)).toString()).toBe(SRT);
    put("tt0000002/film.srt", SRT + "\n2\n00:00:03,000 --> 00:00:04,000\nAnother.\n");
    utimesSync(path.join(root, "tt0000002/film.srt"), new Date(), new Date(Date.now() + 5000));
    const again = await keptSubtitles({ type: "movie", id: "tt0000002", imdbId: "tt0000002" }, ["english"]);
    expect(again[0].ref).not.toBe(film[0].ref);
    await expect(readKept("kc0000000000000000")).rejects.toThrow("unknown subtitle");
  });

  it("are none when there is no folder, or the id isn't an IMDb one", async () => {
    config.captionsDir = path.join(root, "missing");
    expect(await keptSubtitles(episode(3, 2), ["english"])).toEqual([]);
    expect(await keptSubtitles({ ...episode(3, 2), imdbId: "../tt0000001" }, ["english"])).toEqual([]);
  });
});
