/**
 * The playing file looked for in AIOStreams' lists by the title's two ids (streamCandidates): the list
 * by the id asked with, and the one by the title's other id asked beside it when the first is slow.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetInstallUrls } from "../src/installUrls.js";
import { forgetAccounts } from "../src/aiostreamsAccount.js";
import { forgetStreams, holdFileLookup, streamCandidates } from "../src/sync.js";

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
const PLAYED = "Show.E590.1080p.WEB-DL.DUAL-TEAM";
const IMDB = "tt0000590:16:12";
const KITSU = "kitsu:12:590";

afterEach(() => {
  vi.restoreAllMocks();
  forgetStreams();
  forgetInstallUrls();
  forgetAccounts();
});

const list = (...names: string[]) => new Response(JSON.stringify({ streams: names.map((filename) => ({ url: `https://debrid.example/${filename}`, behaviorHints: { filename } })) }), { headers: { "content-type": "application/json" } });
const after = (ms: number, answer: () => Response) => new Promise<Response>((resolve) => setTimeout(() => resolve(answer()), ms));

/** AIOStreams with a list per id, each answering after its own time; `asked` gets the ids in the order asked. */
const server = (lists: Record<string, { ms: number; names: string[] }>, asked: string[]) => async (input: string | URL | Request) => {
  const id = decodeURIComponent(String(input).match(/\/stream\/series\/([^/]+)\.json$/)?.[1] ?? "");
  if (!lists[id]) return new Response("{}", { status: 404 });
  asked.push(id);
  return after(lists[id].ms, () => list(...lists[id].names));
};

describe("a file listed under the title's other id", () => {
  it("is taken from that list when the list by the id asked with is still being searched for", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(server({ [IMDB]: { ms: 4000, names: ["Show.S16E12.720p-CREW"] }, [KITSU]: { ms: 100, names: [`${PLAYED}.mkv`] } }, asked));
    const began = Date.now();
    const found = await streamCandidates(AIO, IMDB, "series", PLAYED, KITSU);
    expect(found[0]).toMatchObject({ url: `https://debrid.example/${PLAYED}.mkv`, how: "name", byAlias: true });
    // A second's head start for the first list, then the other id's answer: not the first list's four seconds.
    expect(Date.now() - began).toBeLessThan(2500);
    expect(asked).toEqual([IMDB, KITSU]);
  }, 15000);

  it("isn't asked for when the list by the id asked with comes at once and has the file", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(server({ [IMDB]: { ms: 50, names: [`${PLAYED}.mkv`] }, [KITSU]: { ms: 50, names: [`${PLAYED}.mkv`] } }, asked));
    const found = await streamCandidates(AIO, IMDB, "series", PLAYED, KITSU);
    expect(found[0]).toMatchObject({ how: "name" });
    expect(found[0].byAlias).toBeUndefined();
    expect(asked).toEqual([IMDB]);
  });

  it("is asked for once, after a quick list by the id asked with that lacks the file", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(server({ [IMDB]: { ms: 50, names: ["Show.S16E12.720p-CREW"] }, [KITSU]: { ms: 50, names: [`${PLAYED}.mkv`] } }, asked));
    const found = await streamCandidates(AIO, IMDB, "series", PLAYED, KITSU);
    expect(found[0]).toMatchObject({ how: "name", byAlias: true });
    expect(asked).toEqual([IMDB, KITSU]);
  });

  it("waits for the slow list by the id asked with when the other id's lacks the file, and asks that one no second time", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(server({ [IMDB]: { ms: 1800, names: [`${PLAYED}.mkv`] }, [KITSU]: { ms: 100, names: ["Show.E590.720p-CREW"] } }, asked));
    const found = await streamCandidates(AIO, IMDB, "series", PLAYED, KITSU);
    expect(found[0]).toMatchObject({ how: "name" });
    expect(found[0].byAlias).toBeUndefined();
    expect(asked).toEqual([IMDB, KITSU]);
  }, 15000);
});

describe("AIOStreams' limit on stream lists", () => {
  const limited = (remaining: number, resetSeconds: number, body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "ratelimit-limit": "10", "ratelimit-remaining": String(remaining), "ratelimit-reset": String(resetSeconds) } });
  const streams = (...names: string[]) => ({ streams: names.map((filename) => ({ url: `https://debrid.example/${filename}`, behaviorHints: { filename } })) });

  it("asks again after the window when a list is refused, where a refusal read as an empty list", async () => {
    const times: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      times.push(Date.now());
      // Refused the way AIOStreams puts it to a player: an entry that is no stream, the window's count used up.
      return times.length === 1 ? limited(0, 1, { streams: [{ name: "AIOStreams", description: "Too many requests, please try again later." }] }) : limited(9, 15, streams(`${PLAYED}.mkv`));
    });
    const found = await streamCandidates(AIO, "tt0000591:1:1", "series", PLAYED);
    expect(found[0]).toMatchObject({ how: "name" });
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
  }, 15000);

  it("holds an ask back until the window ends once the limiter says it takes no more", async () => {
    const times: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      times.push(Date.now());
      return String(input).includes("tt0000592%3A1%3A1") ? limited(0, 1, streams("Show.S01E01.720p-CREW.mkv")) : limited(9, 15, streams(`${PLAYED}.mkv`));
    });
    // The first list takes the window's last place; the next one is another list, so it isn't shared, and waits.
    await streamCandidates(AIO, "tt0000592:1:1", "movie", "Show.S01E01.720p-CREW");
    const found = await streamCandidates(AIO, "tt0000592:1:2", "movie", PLAYED);
    expect(found[0]).toMatchObject({ how: "name" });
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(1000);
  }, 15000);

  it("leaves the second half of a window to the file being played: one asked ahead waits for the next window", async () => {
    const times: Array<{ id: string; at: number }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const id = decodeURIComponent(String(input).match(/\/stream\/series\/([^/]+)\.json$/)?.[1] ?? "");
      times.push({ id, at: Date.now() });
      // Ten a window, five left after this answer, the window ending in a second.
      return limited(5, 1, streams(`Show.${id.endsWith(":2") ? "Next" : "Playing"}.1080p-TEAM.mkv`));
    });
    await streamCandidates(AIO, "tt0000594:1:1", "series", "Show.Playing.1080p-TEAM");
    holdFileLookup("Show.Next.1080p-TEAM", Promise.resolve());
    // The file being played goes at once; the one asked ahead, after the window.
    await streamCandidates(AIO, "tt0000594:1:1", "series", "Show.Playing.1080p-TEAM");
    expect(times[1].at - times[0].at).toBeLessThan(500);
    const next = await streamCandidates(AIO, "tt0000594:1:2", "series", "Show.Next.1080p-TEAM");
    expect(next[0]).toMatchObject({ how: "name" });
    expect(times[2].at - times[0].at).toBeGreaterThanOrEqual(1000);
  }, 15000);

  it("shares one ask between lookups of the same list made side by side", async () => {
    let asked = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      asked++;
      return after(100, () => limited(8, 15, streams(`${PLAYED}.mkv`)));
    });
    const both = await Promise.all([streamCandidates(AIO, "tt0000593:1:1", "series", PLAYED), streamCandidates(AIO, "tt0000593:1:1", "series", PLAYED)]);
    expect(both.map((found) => found[0]?.how)).toEqual(["name", "name"]);
    expect(asked).toBe(1);
  });
});
