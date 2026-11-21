import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { fetchPublic, privateAddress, resetPublicHosts } from "../src/net.js";
import { checkHost, checkReadable, checkReads, connectionRefused, fetchFile, PrivateHost, noteRead, noteReadOk, noteRefusal, ReadsPaused, refusalStatus, resetReads } from "../src/reads.js";

const FILE = "https://cdn.debrid.example/dl/abc/Show.S01E01.mkv";
const MIN = 60_000;

describe("pausing reads when the file's host refuses", () => {
  beforeEach(() => resetReads());

  it("reads the refusal out of ffmpeg's and a range read's errors", () => {
    expect(refusalStatus("Command failed: ffmpeg -i <url>\n[https @ 0x55] Server returned 403 Forbidden (access denied)")).toBe(403);
    expect(refusalStatus("[https @ 0x55] HTTP error 429 Too Many Requests")).toBe(429);
    expect(refusalStatus("range read refused (HTTP 429)")).toBe(429);
    expect(refusalStatus("Server returned 404 Not Found")).toBeUndefined();
    // A number in the address is not a status.
    expect(refusalStatus("Command failed: ffprobe https://host.example/403/file.mkv\nInvalid data found")).toBeUndefined();
  });

  it("pauses at once on 429, for that host only", () => {
    expect(noteRefusal(FILE, 429, 0)).toBe(5 * MIN);
    expect(() => checkReads(FILE, 4 * MIN)).toThrow(ReadsPaused);
    expect(() => checkReads("https://other.example/file.mkv", 4 * MIN)).not.toThrow();
    expect(() => checkReads(FILE, 5 * MIN + 1)).not.toThrow();
  });

  it("takes three 403s in a row to pause: one is usually an expired link", () => {
    expect(noteRefusal(FILE, 403, 0)).toBe(0);
    expect(noteRefusal(FILE, 403, 0)).toBe(0);
    expect(() => checkReads(FILE, 1)).not.toThrow();
    expect(noteRefusal(FILE, 403, 0)).toBe(5 * MIN);
    expect(() => checkReads(FILE, 1)).toThrow(/HTTP 403/);
  });

  it("starts over after a read that works", () => {
    noteRefusal(FILE, 403, 0);
    noteRefusal(FILE, 403, 0);
    noteReadOk(FILE);
    expect(noteRefusal(FILE, 403, 0)).toBe(0);
  });

  it("reads a refused connection out of ffmpeg's, ffprobe's and fetch's errors", () => {
    expect(refusalStatus("[tcp @ 0xf3] Connection to tcp://cdn.debrid.example:443 failed: Connection refused\n[in#0 @ 0xf3] Error opening input: Connection refused")).toBe("connection");
    expect(refusalStatus("https://cdn.debrid.example/f.mkv: Connection refused")).toBe("connection");
    expect(connectionRefused(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.7:443"), { code: "ECONNREFUSED" }) }))).toBe(true);
    expect(connectionRefused(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }))).toBe(false);
    expect(connectionRefused(new Error("The operation was aborted due to timeout"))).toBe(false);
  });

  it("pauses at once on a refused connection to a public host, never to one on the Docker network", () => {
    expect(noteRefusal(FILE, "connection", 0)).toBe(5 * MIN);
    expect(() => checkReads(FILE, 1)).toThrow(/refused the connection/);
    expect(() => checkHost("https://other.example/file.mkv", 1)).not.toThrow();
    // A container that's down (AIOStreams restarting, a usenet proxy): not a host turning this server away.
    expect(noteRefusal("http://aiostreams:3000/stremio/play/abc", "connection", 0)).toBe(0);
    expect(() => checkReads("http://aiostreams:3000/stremio/play/abc", 1)).not.toThrow();
    expect(noteRefusal("http://10.0.0.5:8080/file.mkv", "connection", 0)).toBe(0);
  });

  it("notes a fetch whose connection is refused against its host, and passes the error on", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.7:443"), { code: "ECONNREFUSED" }) });
    });
    try {
      await expect(fetchFile(FILE, {})).rejects.toThrow("fetch failed");
      expect(() => checkHost(FILE)).toThrow(ReadsPaused);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("doubles the pause while the host keeps refusing, up to an hour", () => {
    const pauses = [0, 1, 2, 3, 4, 5].map(() => noteRefusal(FILE, 429, 0));
    expect(pauses).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 40 * MIN, 60 * MIN, 60 * MIN]);
    noteReadOk(FILE);
    expect(noteRefusal(FILE, 429, 0)).toBe(5 * MIN);
  });
});

describe("the daily read limit", () => {
  const before = config.dailyReadGb;
  afterEach(() => {
    config.dailyReadGb = before;
  });

  it("stops new reads once the day's bytes are spent, and 0 means no limit", () => {
    config.dailyReadGb = 1000;
    expect(() => checkReads()).not.toThrow();
    noteRead(3_000_000);
    config.dailyReadGb = 0.002; // 2 MB
    expect(() => checkReads()).toThrow(/read limit/);
    config.dailyReadGb = 0;
    expect(() => checkReads()).not.toThrow();
  });
});

describe("a public name that leads to a private address", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(lookup).mockClear();
  });

  it("knows private addresses, IPv4 written as IPv6 included", () => {
    for (const a of ["10.0.0.5", "172.18.0.5", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.5", "::ffff:192.168.1.1"]) expect(privateAddress(a), a).toBe(true);
    for (const a of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) expect(privateAddress(a), a).toBe(false);
  });

  it("is refused before anything is fetched", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "172.18.0.5", family: 4 }] as never);
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/private/);
    // One private address among public ones is enough.
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }] as never);
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/private/);
    // A name that doesn't resolve isn't fetched either.
    vi.mocked(lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/public https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is refused as a redirect target too, and a public name is fetched", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://inside.example.com/x" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never).mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }] as never);
    await expect(fetchPublic("https://subs.example.com/manifest.json", 1000)).rejects.toThrow(/private/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const ok = vi.fn(async () => new Response("fine"));
    vi.stubGlobal("fetch", ok);
    expect(await (await fetchPublic("https://subs.example.com/manifest.json", 1000)).text()).toBe("fine");
  });
});

describe("a playing file is never read from this server's own networks", () => {
  const kept = { own: config.ownAiostreams, base: config.aiostreamsBase, hosts: config.privateStreamHosts };
  beforeEach(() => {
    resetReads();
    resetPublicHosts();
    config.privateStreamHosts = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    config.ownAiostreams = kept.own;
    config.aiostreamsBase = kept.base;
    config.privateStreamHosts = kept.hosts;
  });

  it("refuses private addresses, bare names and anything but http and https, before any request", async () => {
    const fetchMock = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchMock);
    config.ownAiostreams = undefined;
    config.aiostreamsBase = "http://aiostreams:3000";
    for (const url of ["http://10.0.0.5/file.mkv", "http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080/file.mkv", "http://[::1]/file.mkv", "http://other-container:3000/file.mkv", "http://nas.local/file.mkv", "file:///etc/passwd", "not a url"]) {
      await expect(fetchFile(url, {})).rejects.toThrow(PrivateHost);
      await expect(checkReadable(url)).rejects.toThrow(PrivateHost);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a public-looking name that leads to a private address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x")));
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "192.168.1.20", family: 4 }] as never);
    await expect(fetchFile("https://cdn.rebind.example/file.mkv", {})).rejects.toThrow(PrivateHost);
  });

  it("reads public hosts over http and https, this server's own AIOStreams, and hosts named in PRIVATE_STREAM_HOSTS", async () => {
    const fetchMock = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchMock);
    config.ownAiostreams = "https://aiostreams.example.com";
    config.aiostreamsBase = "http://aiostreams:3000";
    config.privateStreamHosts = ["proxy.lan", "192.168.1.9:8080"];
    for (const url of ["https://cdn.debrid.example/file.mkv", "http://cdn.debrid.example/file.mkv", "http://aiostreams:3000/api/v1/proxy/x", "https://aiostreams.example.com/api/v1/proxy/x", "http://proxy.lan:9000/file.mkv", "http://192.168.1.9:8080/file.mkv"]) {
      await expect(fetchFile(url, {})).resolves.toBeInstanceOf(Response);
    }
    // A host allowed with the scheme's own port is read at an address that leaves the port out.
    config.privateStreamHosts = ["10.0.0.7:80", "10.0.0.8:443"];
    await expect(fetchFile("http://10.0.0.7/file.mkv", {})).resolves.toBeInstanceOf(Response);
    await expect(fetchFile("https://10.0.0.8/file.mkv", {})).resolves.toBeInstanceOf(Response);
    await expect(fetchFile("http://10.0.0.7:8080/file.mkv", {})).rejects.toThrow(PrivateHost);
    config.privateStreamHosts = ["proxy.lan", "192.168.1.9:8080"];
    // Another port of a host allowed with its port isn't that host.
    await expect(fetchFile("http://192.168.1.9:22/file.mkv", {})).rejects.toThrow(PrivateHost);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("checks every redirect: one that leads inside is not followed", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFile("https://cdn.debrid.example/file.mkv", { headers: { Range: "bytes=0-0" } })).rejects.toThrow(PrivateHost);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A redirect to another public host is followed, the request's headers kept.
    const hops = vi.fn(async (url: string | URL) => (String(url).includes("first") ? new Response(null, { status: 302, headers: { location: "https://second.example/file.mkv" } }) : new Response("bytes", { status: 206 })));
    vi.stubGlobal("fetch", hops);
    const response = await fetchFile("https://first.example/file.mkv", { headers: { Range: "bytes=0-4" } });
    expect(response.status).toBe(206);
    expect(hops.mock.calls.map((c) => String(c[0]))).toEqual(["https://first.example/file.mkv", "https://second.example/file.mkv"]);
    expect((hops.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toEqual({ Range: "bytes=0-4" });
  });

  it("hands a caller that follows redirects itself each answer as it came", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } })));
    const response = await fetchFile("https://cdn.debrid.example/file.mkv", { redirect: "manual" });
    expect(response.status).toBe(302);
  });
});
