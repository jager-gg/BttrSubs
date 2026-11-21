/**
 * A SubSource record's list read page by page: 100 a page, each page kept as it is read, paging paused
 * at the minute's reserve and after a refusal and read on later, a whole list used as kept and then
 * only its newest pages asked again, and one paging shared by lists asking at the same time.
 */
import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = ".cache-subsource-pages-test";
let subsource: typeof import("../src/subsource.js");
let cache: typeof import("../src/cache.js");
let config: typeof import("../src/config.js")["config"];

beforeAll(async () => {
  process.env.CACHE_DIR = CACHE;
  subsource = await import("../src/subsource.js");
  cache = await import("../src/cache.js");
  config = (await import("../src/config.js")).config;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await rm(CACHE, { recursive: true, force: true });
});

/** A record's subtitles, newest first: ids from `total` down to 1. */
const record = (total: number) => Array.from({ length: total }, (_, i) => ({ subtitleId: total - i, movieId: 1, language: "arabic", releaseInfo: [`Show - ${total - i}`] }));

/**
 * SubSource as a stand-in: the record's pages in order, `remaining` requests left in the minute after
 * each one (counting down from `left`), and a 429 for the pages in `refuse`. Every page asked is noted.
 */
function standIn(subs: ReturnType<typeof record>, { left = 60, refuse = [] as number[] } = {}) {
  const asked: number[] = [];
  let remaining = left;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"));
    const limit = Number(url.searchParams.get("limit"));
    asked.push(page);
    remaining--;
    if (refuse.includes(page)) return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
    const data = subs.slice((page - 1) * limit, page * limit);
    return new Response(JSON.stringify({ data, pagination: { page, pages: Math.max(1, Math.ceil(subs.length / limit)) } }), { headers: { "content-type": "application/json", "x-ratelimit-remaining": String(remaining) } });
  });
  return asked;
}

describe("a language SubSource names its own way", () => {
  it("is asked for under SubSource's name and listed under the name used here", async () => {
    for (const [mine, theirs, id] of [["portuguese (br)", "brazilian_portuguese", 17], ["persian", "farsi_persian", 18], ["sinhalese", "sinhala", 21], ["chinese (simplified)", "chinese_bg_code", 19], ["chinese (traditional)", "big_5_code", 20]] as const) {
      const asked: Array<string | null> = [];
      vi.stubGlobal("fetch", async (input: string | URL) => {
        const url = new URL(String(input));
        asked.push(url.searchParams.get("language"));
        const data = url.searchParams.get("language") === theirs ? [{ subtitleId: id * 10, movieId: id, language: theirs, releaseInfo: ["Film 2001 1080p"] }] : [];
        return new Response(JSON.stringify({ data, pagination: { page: 1, pages: 1 } }), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "50" } });
      });
      expect((await subsource.getSubtitlesIn(id, mine, "key")).map((s) => [s.subtitleId, s.language])).toEqual([[id * 10, mine]]);
      expect(asked).toEqual([theirs]);
      vi.unstubAllGlobals();
    }
  });
});

describe("a SubSource record's list, page by page", () => {
  it("asks 100 a page and keeps the pages read before a refusal, then reads on from there", async () => {
    const subs = record(450);
    const first = standIn(subs, { refuse: [3] });
    const got = await subsource.getSubtitlesIn(11, "arabic", "key");
    expect(first).toEqual([1, 2, 3]);
    expect(got.map((s) => s.subtitleId)).toEqual(subs.slice(0, 200).map((s) => s.subtitleId));
    const later = standIn(subs);
    const all = await subsource.getSubtitlesIn(11, "arabic", "key");
    expect(later).toEqual([3, 4, 5]);
    expect(all).toHaveLength(450);
    // Read whole: used as kept, nothing asked.
    const after = standIn(subs);
    expect(await subsource.getSubtitlesIn(11, "arabic", "key")).toHaveLength(450);
    expect(after).toEqual([]);
  });

  it("stops at the minute's reserve and reads the rest on a later list", async () => {
    const subs = record(2000);
    const tight = standIn(subs, { left: subsource.MINUTE_RESERVE + 3 });
    const some = await subsource.getSubtitlesIn(12, "arabic", "key");
    expect(tight).toEqual([1, 2, 3]);
    expect(some).toHaveLength(300);
    const later = standIn(subs);
    expect(await subsource.getSubtitlesIn(12, "arabic", "key")).toHaveLength(2000);
    expect(later).toEqual(Array.from({ length: 17 }, (_, i) => i + 4));
  });

  it("asks only its newest pages once the result lifetime has passed, and adds what is new at the front", async () => {
    const subs = record(250);
    standIn(subs);
    expect(await subsource.getSubtitlesIn(13, "arabic", "key")).toHaveLength(250);
    // 120 uploads since: the newest page holds no kept subtitle, the next one does.
    const now = record(370);
    const ttl = config.resultCacheTtlSeconds;
    config.resultCacheTtlSeconds = 0;
    try {
      const asked = standIn(now);
      const got = await subsource.getSubtitlesIn(13, "arabic", "key");
      expect(asked).toEqual([1, 2]);
      expect(got.map((s) => s.subtitleId)).toEqual(now.map((s) => s.subtitleId));
    } finally {
      config.resultCacheTtlSeconds = ttl;
    }
  });

  it("takes a whole list kept the way lists were kept before as read, and asks only its newest page", async () => {
    const subs = record(180);
    await cache.writeJsonCache("results", cache.cacheKey({ kind: "subtitles", movieId: 14, language: "arabic" }), subs);
    const asked = standIn(subs);
    expect(await subsource.getSubtitlesIn(14, "arabic", "key")).toHaveLength(180);
    expect(asked).toEqual([1]);
  });

  it("shares one paging between lists that ask at the same time", async () => {
    const subs = record(300);
    const asked = standIn(subs);
    const [a, b] = await Promise.all([subsource.getSubtitlesIn(15, "arabic", "key"), subsource.getSubtitlesIn(15, "arabic", "key")]);
    expect(a).toHaveLength(300);
    expect(b).toBe(a);
    expect(asked).toEqual([1, 2, 3]);
  });

  it("answers with the failure when the first page is refused and nothing is kept", async () => {
    standIn(record(100), { refuse: [1] });
    await expect(subsource.getSubtitlesIn(16, "arabic", "key")).rejects.toThrow(/429/);
  });
});
