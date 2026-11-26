/**
 * A reading of the playing file kept with its text tracks' languages only is completed by one read
 * of the file's first part (completeLanguages), so a language the file has as a picture track is
 * left out of the list too.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKey, cachePath } from "../src/cache.js";
import { forgetInstallUrls } from "../src/installUrls.js";
import { completeLanguages, embeddedLanguages, forgetStreams } from "../src/sync.js";
import { release } from "./mkvfile.js";

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";

afterEach(() => {
  vi.restoreAllMocks();
  forgetStreams();
  forgetInstallUrls();
});

const record = (filename: string) => path.join(cachePath("anchors"), `${cacheKey({ kind: "file-anchors", filename })}.json`);
async function keep(filename: string, more: Record<string, unknown>) {
  await mkdir(cachePath("anchors"), { recursive: true });
  await writeFile(record(filename), JSON.stringify({ filename, duration: 1_200_000, windows: [{ from: 0, to: 60000, cues: [] }], track: 2, source: "index", rounds: 2, ...more }));
}

/** AIOStreams listing the file, and the file itself: `asked` counts the reads of it. */
function serve(filename: string, file: Buffer, asked: string[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/stream/")) return new Response(JSON.stringify({ streams: [{ url: "https://files.example/film.mkv", behaviorHints: { filename } }] }), { headers: { "content-type": "application/json" } });
    if (!url.startsWith("https://files.example/")) return new Response("{}", { status: 404 });
    asked.push(url);
    const m = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get("range") ?? "");
    const from = Number(m?.[1] ?? 0);
    const to = Math.min(m?.[2] ? Number(m[2]) : file.length - 1, file.length - 1);
    return new Response(new Uint8Array(file.subarray(from, to + 1)), { status: 206, headers: { "content-range": `bytes ${from}-${to}/${file.length}` } });
  });
}

const picture = () => release({ codec: "S_HDMV/PGS", language: "ara", name: "Arabic", lines: [{ start: 1000, duration: 2000, text: "x" }, { start: 5000, duration: 2000, text: "y" }] });

describe("a kept reading with its text tracks' languages only", () => {
  it("gets the file's picture tracks' languages from one read, and is marked", async () => {
    const filename = "Film.2008.2160p.UHD.BluRay.REMUX-TEAM.mkv";
    await keep(filename, { subtitleLangs: ["may"] });
    const asked: string[] = [];
    serve(filename, picture(), asked);
    expect(await embeddedLanguages(filename, 0)).toEqual(["may"]);
    completeLanguages(AIO, "tt0000468", "movie", filename);
    expect(await embeddedLanguages(filename, 5000)).toEqual(["may", "ara"]);
    const kept = JSON.parse(await readFile(record(filename), "utf8"));
    expect(kept).toMatchObject({ subtitleLangs: ["may", "ara"], pictureLangs: true, track: 2 });
    // Marked: asked for again, nothing is read.
    const reads = asked.length;
    forgetStreams();
    completeLanguages(AIO, "tt0000468", "movie", filename);
    expect(await embeddedLanguages(filename, 1000)).toEqual(["may", "ara"]);
    expect(asked.length).toBe(reads);
  }, 20000);

  it("is left as it is when the file isn't in AIOStreams' lists", async () => {
    const filename = "Film.2009.2160p.UHD.BluRay.REMUX-TEAM.mkv";
    await keep(filename, { subtitleLangs: ["eng"] });
    serve("Film.2009.1080p.WEB-CREW.mkv", picture(), []);
    completeLanguages(AIO, "tt0000469", "movie", filename);
    expect(await embeddedLanguages(filename, 5000)).toEqual(["eng"]);
    expect(JSON.parse(await readFile(record(filename), "utf8")).pictureLangs).toBeUndefined();
  }, 20000);
});
