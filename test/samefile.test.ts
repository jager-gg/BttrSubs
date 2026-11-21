import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CACHE = mkdtempSync(path.join(os.tmpdir(), "bttrsubs-samefile-"));
let sync: typeof import("../src/sync.js");
let cacheKey: (what: unknown) => string;

/** Readings kept for a file, as a first play leaves them. */
const read = (ref: string) => {
  mkdirSync(path.join(CACHE, "anchors"), { recursive: true });
  writeFileSync(path.join(CACHE, "anchors", `${cacheKey({ kind: "file-anchors", filename: ref })}.json`), JSON.stringify({ filename: ref, duration: 1, windows: [] }));
};

beforeAll(async () => {
  process.env.CONFIG_SECRET = "samefile-test-secret-samefile-test-123";
  process.env.CACHE_DIR = CACHE;
  sync = await import("../src/sync.js");
  cacheKey = (await import("../src/cache.js")).cacheKey;
});
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

describe("one file played under two sizes", () => {
  it("keeps one set of readings: the size its host serves stands for the listed size it was first read at", async () => {
    const listed = "Show.S01E02.mkv/4821100790";
    const served = "Show.S01E02.mkv/4817912734";
    expect(await sync.sameFileRef(served)).toBe(served);
    read(listed);
    await sync.noteServedSize(listed, "4817912734");
    // The replay, which comes with the served size, is the file already read.
    expect(await sync.sameFileRef(served)).toBe(listed);
    expect(await sync.sameFileRef(listed)).toBe(listed);
    expect(sync.syncKey("ss1", 1, 2, await sync.sameFileRef(served))).toBe(sync.syncKey("ss1", 1, 2, listed));
  });

  it("goes the other way when the served size was read first", async () => {
    const listed = "Show.S01E03.mkv/5068061409";
    const served = "Show.S01E03.mkv/5068641376";
    read(served);
    await sync.noteServedSize(listed, "5068641376");
    expect(await sync.sameFileRef(listed)).toBe(served);
    expect(await sync.sameFileRef(served)).toBe(served);
  });

  it("ties nothing when the host serves the size asked for, or no size worth the name", async () => {
    const ref = "Show.S01E04.mkv/1000";
    await sync.noteServedSize(ref, "1000");
    await sync.noteServedSize(ref, "0");
    await sync.noteServedSize(ref, "abc");
    expect(await sync.sameFileRef(ref)).toBe(ref);
    expect(await sync.sameFileRef("Show.S01E04.mkv/0")).toBe("Show.S01E04.mkv/0");
  });

  it("stays inside an account's own readings, and ties a file named without a size", async () => {
    const theirs = "@0123456789|Show.S01E05.mkv/2000";
    await sync.noteServedSize(theirs, "1990");
    expect(await sync.sameFileRef("@0123456789|Show.S01E05.mkv/1990")).toBe(theirs);
    expect(await sync.sameFileRef("Show.S01E05.mkv/1990")).toBe("Show.S01E05.mkv/1990");
    await sync.noteServedSize("Show.S01E06.mkv", "3000");
    expect(await sync.sameFileRef("Show.S01E06.mkv/3000")).toBe("Show.S01E06.mkv");
  });
});
