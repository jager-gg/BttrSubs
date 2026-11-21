import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = mkdtempSync(path.join(os.tmpdir(), "bttrsubs-downloads-"));
let downloads: typeof import("../src/downloads.js");

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral greeting.\n";

beforeAll(async () => {
  process.env.CONFIG_SECRET = "downloads-test-secret-downloads-test-1";
  process.env.CACHE_DIR = CACHE;
  downloads = await import("../src/downloads.js");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

describe("a subtitle asked for by several requests at once", () => {
  it("is downloaded from its source once, and every request gets the same whole file", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(SRT);
    }));
    const keys = { subsource: "sk_a_key_for_the_test_1" };
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => downloads.getCachedSubtitleFile("ss880001", 1, 2, keys)));
    expect(calls).toBe(1);
    expect(new Set(got.map((g) => g.file)).size).toBe(1);
    expect(readFileSync(got[0].file, "utf8")).toBe(SRT);
    // The same download, asked for as another episode's at the same moment: still one.
    const [a, b] = await Promise.all([downloads.getCachedSubtitleFile("ss880002", 1, 1, keys), downloads.getCachedSubtitleFile("ss880002", 1, 2, keys)]);
    expect(calls).toBe(2);
    expect(a.file).not.toBe(b.file);
    // Nothing half-written is left beside them.
    for (const folder of ["downloads", "subtitles"]) expect(readdirSync(path.join(CACHE, folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("is tried again after a download that failed, by the next request", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++calls === 1 ? new Response("no", { status: 500 }) : new Response(SRT))));
    const keys = { subsource: "sk_a_key_for_the_test_1" };
    const both = await Promise.allSettled([downloads.getCachedSubtitleFile("ss880003", 1, 1, keys), downloads.getCachedSubtitleFile("ss880003", 1, 1, keys)]);
    expect(both.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);
    expect(readFileSync((await downloads.getCachedSubtitleFile("ss880003", 1, 1, keys)).file, "utf8")).toBe(SRT);
    expect(calls).toBe(2);
  });
});
