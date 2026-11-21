import { afterEach, describe, expect, it, vi } from "vitest";
import { HASH_CHUNK, openSubtitlesHash, readFileHash } from "../src/oshash.js";

const chunk = (fill: (bytes: Uint8Array) => void = () => {}) => {
  const bytes = new Uint8Array(HASH_CHUNK);
  fill(bytes);
  return bytes;
};

describe("the OpenSubtitles hash", () => {
  it("is the size alone for a file of zeros", () => {
    expect(openSubtitlesHash(chunk(), chunk(), 2 * HASH_CHUNK)).toBe("0000000000020000");
  });

  it("reads the words little-endian and wraps at 2^64", () => {
    // The head's first word: bytes 01..08, read as 0x0807060504030201.
    const head = chunk((b) => b.set([1, 2, 3, 4, 5, 6, 7, 8], 0));
    expect(openSubtitlesHash(head, chunk(), 2 * HASH_CHUNK)).toBe("0807060504050201");
    // The tail's last word all ones (2^64 - 1) plus 1 from the head wraps to the size alone.
    const one = chunk((b) => (b[0] = 1));
    const ones = chunk((b) => b.fill(0xff, HASH_CHUNK - 8));
    expect(openSubtitlesHash(one, ones, 2 * HASH_CHUNK)).toBe("0000000000020000");
  });

  it("isn't made for a file under two chunks or from short reads", () => {
    expect(openSubtitlesHash(chunk(), chunk(), 2 * HASH_CHUNK - 1)).toBeUndefined();
    expect(openSubtitlesHash(chunk().subarray(1), chunk(), 10_000_000)).toBeUndefined();
  });
});

describe("reading a file's hash", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes two 64 KB reads: the start, which gives the size, then the end", async () => {
    const size = 200_000;
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      asked.push(range);
      const [from, to] = range.replace("bytes=", "").split("-").map(Number);
      const body = new Uint8Array(to - from + 1);
      body[0] = asked.length; // 1 at the start of the head, 2 at the start of the tail
      return new Response(body, { status: 206, headers: { "content-range": `bytes ${from}-${to}/${size}` } });
    }));
    const found = await readFileHash("https://cdn.example.com/file.mkv");
    expect(asked).toEqual([`bytes=0-${HASH_CHUNK - 1}`, `bytes=${size - HASH_CHUNK}-${size - 1}`]);
    expect(found).toEqual({ size, hash: (BigInt(size) + 1n + 2n).toString(16).padStart(16, "0") });
  });

  it("takes the size from Content-Length when the server ignores the range, and keeps only 64 KB", async () => {
    const size = 3 * HASH_CHUNK;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const range = new Headers(init?.headers).get("range") ?? "";
      if (range === `bytes=0-${HASH_CHUNK - 1}`) return new Response(new Uint8Array(size), { status: 200, headers: { "content-length": String(size) } });
      return new Response(new Uint8Array(HASH_CHUNK), { status: 206, headers: { "content-range": `bytes ${size - HASH_CHUNK}-${size - 1}/${size}` } });
    }));
    expect(await readFileHash("https://cdn.example.com/whole.mkv")).toEqual({ size, hash: size.toString(16).padStart(16, "0") });
    expect(calls).toBe(2);
  });

  it("stops after the first read when the file is too small or its size isn't given", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return new Response(new Uint8Array(HASH_CHUNK), { status: 206 });
    }));
    expect(await readFileHash("https://cdn.example.com/nosize.mkv")).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("gives up on a refused read without trying again", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readFileHash("https://refusing.example.com/file.mkv")).rejects.toThrow(/refused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
