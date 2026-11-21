/**
 * The player's address on AIOStreams lookups (src/viewers.ts): worked out the way AIOStreams works it
 * out, kept per configuration and episode, and sent as X-AIOStreams-User-IP.
 */
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCandidates } from "../src/sync.js";
import { noteViewer, resetViewers, viewerAddress, viewerOf } from "../src/viewers.js";

const app = express();
app.set("trust proxy", "loopback, linklocal, uniquelocal");
/** A request reaching the app from `peer` with these headers. */
const request = (peer: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: peer }, app, get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

const AIO = "http://aiostreams:3000/stremio/uuid/pass/manifest.json";
const OTHER = "http://aiostreams:3000/stremio/other/pass/manifest.json";

beforeEach(() => resetViewers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the player's address", () => {
  it("is the first X-Forwarded-For address from a proxy on a private network", () => {
    expect(viewerAddress(request("172.18.0.5", { "x-forwarded-for": "203.0.113.7, 10.0.0.2" }))).toBe("203.0.113.7");
  });

  it("is the connection's own address when a request doesn't come through a trusted proxy", () => {
    expect(viewerAddress(request("198.51.100.9", { "x-forwarded-for": "203.0.113.7" }))).toBe("198.51.100.9");
  });

  it("reads the headers in AIOStreams' order, its own header first", () => {
    const headers = { "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2", "x-aiostreams-user-ip": "198.51.100.3" };
    expect(viewerAddress(request("127.0.0.1", headers))).toBe("198.51.100.3");
    expect(viewerAddress(request("127.0.0.1", { "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(viewerAddress(request("127.0.0.1", { "cf-connecting-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("is none for a player on a private network, or a header that isn't an address", () => {
    expect(viewerAddress(request("172.18.0.5", { "x-forwarded-for": "192.168.1.20" }))).toBeUndefined();
    expect(viewerAddress(request("192.168.1.20"))).toBeUndefined();
    expect(viewerAddress(request("172.18.0.5", { "x-forwarded-for": "unknown" }))).toBeUndefined();
  });

  it("reads an IPv4 connection seen as IPv6 as IPv4", () => {
    expect(viewerAddress(request("::ffff:203.0.113.7"))).toBe("203.0.113.7");
  });
});

describe("the address a lookup is sent for", () => {
  it("is the one the episode's player asked from, else the configuration's latest", () => {
    noteViewer(AIO, "tt0000005:1:7", "203.0.113.7");
    noteViewer(AIO, "tt0000005:1:8", "198.51.100.2");
    expect(viewerOf(AIO, "tt0000005:1:7")).toBe("203.0.113.7");
    expect(viewerOf(AIO, "tt0000005:1:9")).toBe("198.51.100.2");
    expect(viewerOf(OTHER, "tt0000005:1:7")).toBeUndefined();
  });

  it("keeps an address for six hours", () => {
    vi.useFakeTimers();
    noteViewer(AIO, "tt0000005:1:7", "203.0.113.7");
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 1);
    expect(viewerOf(AIO, "tt0000005:1:7")).toBe("203.0.113.7");
    vi.advanceTimersByTime(1);
    expect(viewerOf(AIO, "tt0000005:1:7")).toBeUndefined();
  });

  it("keeps the last address when a request has none", () => {
    noteViewer(AIO, "tt0000005:1:7", "203.0.113.7");
    noteViewer(AIO, "tt0000005:1:7", undefined);
    expect(viewerOf(AIO, "tt0000005:1:7")).toBe("203.0.113.7");
  });
});

describe("the stream lookup", () => {
  const empty = () => new Response(JSON.stringify({ streams: [] }), { headers: { "content-type": "application/json" } });
  const sent = (fetch: { mock: { calls: unknown[][] } }) => new Headers((fetch.mock.calls[0][1] as RequestInit | undefined)?.headers).get("X-AIOStreams-User-IP");

  it("sends the player's address as X-AIOStreams-User-IP", async () => {
    noteViewer(AIO, "tt0000005:1:7", "203.0.113.7");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => empty());
    await streamCandidates(AIO, "tt0000005:1:7", "series", "Show.S01E07.mkv");
    expect(sent(fetch)).toBe("203.0.113.7");
  });

  it("sends no address when no player has asked with the configuration", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => empty());
    await streamCandidates(AIO, "tt0000005:1:7", "series", "Show.S01E07.mkv");
    expect(sent(fetch)).toBeNull();
  });
});
