/**
 * Subtitles timed by another subtitle's lines in place of the file's own track (KeptLines in
 * src/sync.ts): on a file whose track the voices show to be off them, and for a translation that
 * fits nothing in a track another translation fits. Built from the benchmark's made-up episodes
 * (test/synthetic.ts), every subtitle of a play against one stored file.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FileAnchors } from "../src/sync.js";
import { episode, faithful, heard, indexFile, retimedByOthers, runOn, srt, srtStarts, stepped, unrelated, without, type SubLine } from "./synthetic.js";

const CACHE = ".cache-keptlines-test";
const AIOSTREAMS = "https://aiostreams.invalid/stremio/u/p/manifest.json";
let sync: typeof import("../src/sync.js");

beforeAll(async () => {
  // Before anything loads src/config.ts, which reads CACHE_DIR once.
  process.env.CACHE_DIR = CACHE;
  sync = await import("../src/sync.js");
});

afterEach(async () => {
  await sync.settled();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

let files = 0;
/** A file stored as fileAnchors keeps it, with nothing more of it to read, and subtitles synced to it one by one. */
async function play(record: FileAnchors) {
  const filename = `Show.S01E${String(++files).padStart(2, "0")}.mkv`;
  const { cacheKey, cachePath } = await import("../src/cache.js");
  await mkdir(cachePath("anchors"), { recursive: true });
  await writeFile(path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename })}.json`), JSON.stringify({ ...record, filename }));
  await mkdir(cachePath("subs"), { recursive: true });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new TypeError("offline");
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  let subs = 0;
  /** A subtitle of this play: `run` syncs it (again, when asked again), `within` is the share of a served file's lines that near where they belong. */
  const subtitle = async (lines: SubLine[], lang: string) => {
    const sorted = [...lines].sort((a, b) => a.start - b.start);
    const file = path.join(cachePath("subs"), `${filename}.${++subs}.srt`);
    await writeFile(file, srt(sorted));
    const key = sync.syncKey(`ss${files}0${subs}`, 1, files, filename);
    const run = () => sync.syncCaptions(key, async () => ({ file }), AIOSTREAMS, `tt0000001:1:${files}`, "series", filename, lang);
    const within = async (served: string, ms: number) => {
      const starts = srtStarts(await readFile(served, "utf8"));
      return sorted.filter((l, i) => Math.abs(starts[i] - l.truth) <= ms).length / sorted.length;
    };
    return { run, within };
  };
  return { subtitle };
}

describe("a file whose own track is off its voices", () => {
  const ep = episode(131, { minutes: 42 });
  /** The file's subtitles were taken from another cut: off its audio by another amount each minute, split and joined otherwise. */
  const offBy = [-3300, -5500, -4200, -7500, -3600, -6400, -4900, -6900];
  const track = retimedByOthers(faithful(ep.lines), 133, { merge: 0.3, split: 0.3 }).map((c) => {
    const by = offBy[Math.floor(c.start / 60_000) % offBy.length];
    return { start: c.start + by, end: c.end + by };
  });
  const record = () => indexFile(ep.duration, [track], heard(ep.lines, 132));
  /** A translation made for another cut of the title: later after each of two breaks. */
  const otherCut = () => stepped(retimedByOthers(faithful(ep.lines), 134, { jitter: 150 }), [14 * 60_000, 28 * 60_000], [-1300, -3800, -6400]);

  it("times the other subtitles by the one the voices show to be on them", async () => {
    const p = await play(record());
    const onVoices = await p.subtitle(faithful(ep.lines), "English");
    const first = await onVoices.run();
    expect(first?.overTrack).toBe(true);
    const translation = await p.subtitle(otherCut(), "Arabic");
    const timed = await translation.run();
    expect(timed?.reference).toBe("voiced");
    expect(timed?.bySpeech).toBeUndefined();
    expect(await translation.within(timed!.file, 300)).toBeGreaterThan(0.9);
    // The one on the voices stays as the voices timed it.
    expect((await onVoices.run())?.overTrack).toBe(true);
  });

  it("makes again a subtitle that was synced before that one was known", async () => {
    const p = await play(record());
    const translation = await p.subtitle(otherCut(), "Arabic");
    const before = await translation.run();
    expect(before?.reference).not.toBe("voiced");
    expect((await (await p.subtitle(faithful(ep.lines), "English")).run())?.overTrack).toBe(true);
    const after = await translation.run();
    expect(after?.reference).toBe("voiced");
    expect(await translation.within(after!.file, 300)).toBeGreaterThan(0.9);
    // Once made by those lines it is finished: asked again, the same answer.
    expect(await translation.run()).toEqual(after);
  });

  it("still refuses another episode's subtitle", async () => {
    const p = await play(record());
    await (await p.subtitle(faithful(ep.lines), "English")).run();
    const wrong = await (await p.subtitle(unrelated(episode(135, { minutes: 42 }).lines), "Arabic")).run();
    expect(wrong?.anchors.length ?? 0).toBe(0);
  });
});

describe("a translation that fits nothing in the file's own track", () => {
  const ep = episode(151, { minutes: 44 });
  const cuts = [11 * 60_000, 23 * 60_000, 34 * 60_000];
  const shifts = [-4400, -3300, -5600, -6100];
  /** The file's track: its lines start a second or so from where the subtitles' do, joined and split otherwise. */
  const track = retimedByOthers(faithful(ep.lines), 153, { jitter: 1200, merge: 0.3, split: 0.3 });
  const record = () => indexFile(ep.duration, [track]);
  /** A translation the track times, and one with half the lines, most of them run together, that it can't. */
  const full = () => stepped(faithful(ep.lines), cuts, shifts);
  const condensed = () => stepped(runOn(without(retimedByOthers(faithful(ep.lines), 155, { jitter: 150 }), 154, 0.5), 156, { merge: 0.6 }), cuts, shifts);

  it("is refused on its own, and timed by a translation that fits once the file has one", async () => {
    const p = await play(record());
    const short = await p.subtitle(condensed(), "Danish");
    expect((await short.run())?.anchors.length ?? 0).toBe(0);
    const fits = await (await p.subtitle(full(), "English")).run();
    expect(fits?.anchors.length).toBeGreaterThan(0);
    expect(fits?.reference).not.toBe("subtitle");
    const timed = await short.run();
    expect(timed?.reference).toBe("subtitle");
    expect(await short.within(timed!.file, 1000)).toBeGreaterThan(0.95);
    expect(await short.within(timed!.file, 300)).toBeGreaterThan(0.8);
  });

  it("still refuses another episode's subtitle, and doesn't look at it twice", async () => {
    const p = await play(record());
    await (await p.subtitle(full(), "English")).run();
    const wrong = await p.subtitle(unrelated(episode(157, { minutes: 44 }).lines), "Danish");
    const refused = await wrong.run();
    expect(refused?.anchors.length ?? 0).toBe(0);
    expect(refused?.fittingTried).toBe(true);
  });
});

describe("a timing by another subtitle's lines that holds for part of the file only", () => {
  const seeded = (seed: number) => {
    let s = seed;
    return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  };
  /** A line every 2 to 6 s over 40 minutes. */
  const next = seeded(7);
  const kept: number[] = [];
  for (let t = 10_000; t < 40 * 60_000; t += 2000 + Math.round(next() * 4000)) kept.push(t);
  /** Seven in ten of those lines, each within 0.1 s of its line. */
  const jitter = seeded(8);
  const own = kept.filter(() => jitter() < 0.7).map((t) => t + Math.round((jitter() - 0.5) * 200));

  it("holds when every part meets the lines", () => {
    expect(sync.keptLinesMissed(own, kept)).toBeUndefined();
  });

  it("names the part where the lines are met no more often than chance", () => {
    // From minute 30 the subtitle is 11 s from where the timing puts it.
    const missed = sync.keptLinesMissed(own.map((t) => (t < 30 * 60_000 ? t : t - 11_000)), kept);
    expect(missed).toBeDefined();
    expect(missed!.from).toBeGreaterThan(24 * 60_000);
    expect(missed!.met).toBeLessThan(missed!.lines * 0.3);
  });

  it("doesn't judge a part with too few lines", () => {
    const sparse = [...own.filter((t) => t < 30 * 60_000), 35 * 60_000 + 700, 39 * 60_000 + 700];
    expect(sync.keptLinesMissed(sparse, kept)).toBeUndefined();
  });
});
