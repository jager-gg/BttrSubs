/**
 * A stretch of audio read here and piped into ffmpeg (src/audiowindow.ts): the MP4 and Matroska files
 * are built here byte by byte and served by a stand-in host that answers range requests and keeps
 * every range asked for. What goes into the pipe is checked byte for byte; decoding it is ffmpeg's.
 */
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// What a service does with many ranges is kept on disk: here, in a folder of this test's own.
vi.hoisted(() => {
  process.env.CACHE_DIR = ".cache-audiowindow-test";
});
import { adtsFields, adtsHeader, audioRanges, byteranges, openAudioWindow, resetAudioIndexes, type AudioWindow } from "../src/audiowindow.js";
import { resetReads } from "../src/reads.js";

// ---------- a stand-in host ----------
let server: Server;
let base = "";
const files = new Map<string, Uint8Array>();
const asked: string[] = [];
beforeAll(async () => {
  // Many ranges are answered as multipart/byteranges, unless the file's name says otherwise: "one-"
  // answers the first range alone, "whole-" the whole file, "long-" turns the long header down (431).
  server = createServer((req, res) => {
    const name = req.url ?? "";
    const file = files.get(name);
    asked.push(`${name} ${req.headers.range ?? "-"}`);
    if (!file) return res.writeHead(404).end();
    const ranges = [...(req.headers.range ?? "").matchAll(/(\d+)-(\d*)/g)].map((m) => [Number(m[1]), m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1]);
    if (!ranges.length || (ranges.length > 1 && name.startsWith("/whole-"))) return res.writeHead(200).end(Buffer.from(file));
    if (ranges.length > 1 && name.startsWith("/long-")) return res.writeHead(431).end();
    if (ranges.length === 1 || name.startsWith("/one-")) {
      const [from, to] = ranges[0];
      return res.writeHead(206, { "Content-Range": `bytes ${from}-${to}/${file.length}` }).end(Buffer.from(file.subarray(from, to + 1)));
    }
    const boundary = "THIS_STRING_SEPARATES";
    const body = Buffer.concat([
      ...ranges.map(([from, to]) => Buffer.concat([Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/mp4\r\nContent-Range: bytes ${from}-${to}/${file.length}\r\n\r\n`), Buffer.from(file.subarray(from, to + 1))])),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    res.writeHead(206, { "Content-Type": `multipart/byteranges; boundary=${boundary}` });
    // Sent in small pieces, so parts and headers split across reads as they do over a network.
    for (let at = 0; at < body.length; at += 97) res.write(body.subarray(at, at + 97));
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(".cache-audiowindow-test", { recursive: true, force: true });
});
beforeEach(async () => {
  await resetAudioIndexes(true);
  resetReads();
  asked.length = 0;
});

const bytes = (...parts: Array<Uint8Array | number[]>) => {
  const all = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) out.set(p, (at += p.length) - p.length);
  return out;
};
async function drain(w: AudioWindow): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of w.bytes) parts.push(part);
  return bytes(...parts);
}
const rangesOf = (name: string) => asked.filter((a) => a.startsWith(`/${name} `)).map((a) => a.split(" ")[1]);

// ---------- MP4, box by box ----------
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, ...parts: Array<Uint8Array | number[]>) => {
  const body = bytes(...parts);
  return bytes(u32(8 + body.length), ascii(type), body);
};
const full = (type: string, ...parts: Array<Uint8Array | number[]>) => box(type, [0, 0, 0, 0], ...parts);
/** An MPEG-4 descriptor with its length in four bytes, as muxers write it. */
const descriptor = (tag: number, ...parts: Array<Uint8Array | number[]>) => {
  const body = bytes(...parts);
  return bytes([tag, 0x80 | ((body.length >> 21) & 0x7f), 0x80 | ((body.length >> 14) & 0x7f), 0x80 | ((body.length >> 7) & 0x7f), body.length & 0x7f], body);
};
/** AAC-LC, 48 kHz, stereo: object type 2, frequency index 3, channels 2. */
const AAC_LC_48K_STEREO = [0x11, 0x90];
const mp4a = (config: number[], objectType = 0x40) =>
  box("mp4a", new Array(6).fill(0), u16(1), new Array(8).fill(0), u16(2), u16(16), u16(0), u16(0), u32(48000 << 16),
    full("esds", descriptor(3, u16(1), [0], descriptor(4, [objectType, 0x15], [0, 0, 0], u32(0), u32(0), descriptor(5, config)))));

/**
 * A file whose audio frames (1024 samples at 48 kHz, 21.333 ms) sit in chunks of 4 between chunks of
 * video, moov at the end. Frame k's bytes are k's low byte repeated; video bytes are 0xEE.
 */
function mp4File(frames: number, opts: { durations?: (k: number) => number; entry?: Uint8Array; video?: number } = {}) {
  const frameSize = (k: number) => 20 + (k % 7);
  const video = new Uint8Array(opts.video ?? 500).fill(0xee);
  const chunks: number[] = [];
  const parts: Uint8Array[] = [];
  const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isomiso2mp41"));
  let at = ftyp.length + 8;
  for (let k = 0; k < frames; k += 4) {
    parts.push(video);
    at += video.length;
    chunks.push(at);
    for (let j = k; j < Math.min(frames, k + 4); j++) {
      const frame = new Uint8Array(frameSize(j)).fill(j & 0xff);
      parts.push(frame);
      at += frame.length;
    }
  }
  const mdat = box("mdat", ...parts);
  const durations = Array.from({ length: frames }, (_, k) => opts.durations?.(k) ?? 1024);
  const stbl = box("stbl",
    full("stsd", u32(1), opts.entry ?? mp4a(AAC_LC_48K_STEREO)),
    full("stts", u32(frames), ...durations.map((d) => [...u32(1), ...u32(d)])),
    full("stsc", u32(1), u32(1), u32(4), u32(1)),
    full("stsz", u32(0), u32(frames), ...Array.from({ length: frames }, (_, k) => u32(frameSize(k)))),
    full("stco", u32(chunks.length), ...chunks.map(u32)));
  const videoTrak = box("trak", full("tkhd", u32(0), u32(0), u32(1), new Array(68).fill(0)), box("mdia", full("mdhd", u32(0), u32(0), u32(24000), u32(0), [0x55, 0xc4], u16(0)), full("hdlr", u32(0), ascii("vide"), new Array(13).fill(0)), box("minf", box("stbl", full("stsd", u32(0))))));
  const audioTrak = box("trak", full("tkhd", u32(0), u32(0), u32(2), new Array(68).fill(0)), box("mdia", full("mdhd", u32(0), u32(0), u32(48000), u32(frames * 1024), [0x55, 0xc4], u16(0)), full("hdlr", u32(0), ascii("soun"), new Array(13).fill(0)), box("minf", stbl)));
  const moov = box("moov", full("mvhd", u32(0), u32(0), u32(1000), u32(0), new Array(80).fill(0)), videoTrak, audioTrak);
  return { file: bytes(ftyp, mdat, moov), frameSize, chunks };
}

describe("ADTS framing for AAC", () => {
  it("reads the fields from an AudioSpecificConfig, the core of HE-AAC included, and refuses what ADTS can't carry", () => {
    expect(adtsFields(Uint8Array.from(AAC_LC_48K_STEREO))).toEqual({ profile: 1, rate: 3, channels: 2 });
    // HE-AAC (object type 5) at 24 kHz core: carried as AAC-LC, the decoder finds the SBR.
    expect(adtsFields(Uint8Array.from([0x2b, 0x12, 0x08, 0x00]))).toEqual({ profile: 1, rate: 6, channels: 2 });
    // Channels from a program config element (configuration 0), or an explicit rate (index 15).
    expect(adtsFields(Uint8Array.from([0x11, 0x80]))).toBeUndefined();
    expect(adtsFields(Uint8Array.from([0x17, 0x80, 0xbb, 0x80, 0x10]))).toBeUndefined();
  });

  it("writes a 7-byte header holding the frame's whole length", () => {
    expect([...adtsHeader({ profile: 1, rate: 3, channels: 2 }, 100)]).toEqual([0xff, 0xf1, 0x4c, 0x80, 0x0d, 0x7f, 0xfc]);
  });
});

describe("a stretch of an MP4's audio", () => {
  it("is one range read past the index, and only the stretch's audio frames go into the pipe, each behind its ADTS header", async () => {
    const { file, frameSize } = mp4File(600);
    files.set("/a.mp4", file);
    // 12.8 s of 21.333 ms frames; the stretch 5000-7000 ms.
    const w = await openAudioWindow(`${base}/a.mp4`, 1, 5000, 2000);
    expect(w?.input).toEqual(["-f", "aac", "-i", "pipe:0"]);
    const piped = await drain(w!);
    // The lead-in starts at 4800 ms, frame 225's start: from the frame before it (224), through the
    // first frame at or after the stretch's end (329, at 7018.7 ms).
    const first = 224;
    const expected: Uint8Array[] = [];
    for (let k = first; k <= 329; k++) expected.push(adtsHeader({ profile: 1, rate: 3, channels: 2 }, frameSize(k)), new Uint8Array(frameSize(k)).fill(k & 0xff));
    // Exactly those frames: none of the video between them.
    expect(Buffer.from(piped).equals(Buffer.from(bytes(...expected)))).toBe(true);
    // The start (64 KB), the rest past the media in one read (the moov), then the stretch.
    const ranges = rangesOf("a.mp4");
    expect(ranges).toHaveLength(3);
    expect(ranges[1]).toMatch(new RegExp(`-${file.length - 1}$`));
    // Trimmed on the decoded audio to the stretch: 5000 ms less the first piped frame's start.
    const trim = /atrim=start=([\d.]+):duration=([\d.]+)/.exec(w!.output.join(" "));
    expect(Number(trim![1]) * 1000).toBeCloseTo(5000 - first * (1024 / 48), 3);
    expect(Number(trim![2])).toBe(2);
  });

  it("reads the index once per file: a second stretch is one read", async () => {
    const { file } = mp4File(600);
    files.set("/b.mp4", file);
    await drain((await openAudioWindow(`${base}/b.mp4`, 1, 3000, 1000))!);
    const before = rangesOf("b.mp4").length;
    await drain((await openAudioWindow(`${base}/b.mp4`, 1, 9000, 1000))!);
    expect(rangesOf("b.mp4").length - before).toBe(1);
  });

  it("trims on the pipe's own clock where the file's frame lengths vary, as ffmpeg's seek in the file does", async () => {
    // One frame 48 samples (1 ms) longer before the stretch: the file's clock runs 1 ms ahead of the
    // pipe's (every frame 1024) from there on.
    const { file } = mp4File(600, { durations: (k) => (k === 230 ? 1072 : 1024) });
    files.set("/c.mp4", file);
    const w = await openAudioWindow(`${base}/c.mp4`, 1, 5000, 2000);
    await drain(w!);
    const first = 224;
    const frameMs = 1024 / 48;
    // Frame 234 starts at 234 frames + 1 ms on the file's clock; the stretch starts inside it.
    const at = 234;
    const fileStart = at * frameMs + 1;
    const trim = Number(/atrim=start=([\d.]+)/.exec(w!.output.join(" "))![1]) * 1000;
    expect(trim).toBeCloseTo((at - first) * frameMs + (5000 - fileStart), 3);
  });

  it("is nothing for audio it can't frame, so the caller reads the usual way", async () => {
    const opus = box("Opus", new Array(6).fill(0), u16(1), new Array(20).fill(0));
    files.set("/d.mp4", mp4File(100, { entry: opus }).file);
    expect(await openAudioWindow(`${base}/d.mp4`, 1, 500, 500)).toBeUndefined();
    // The video track asked for as audio, and an AAC whose channels come from a program config element.
    files.set("/e.mp4", mp4File(100).file);
    expect(await openAudioWindow(`${base}/e.mp4`, 0, 500, 500)).toBeUndefined();
    files.set("/f.mp4", mp4File(100, { entry: mp4a([0x11, 0x80]) }).file);
    expect(await openAudioWindow(`${base}/f.mp4`, 1, 500, 500)).toBeUndefined();
  });

  it("frames MP3 and AC-3 as they are", async () => {
    files.set("/g.mp4", mp4File(100, { entry: mp4a([], 0x6b) }).file);
    const mp3 = await openAudioWindow(`${base}/g.mp4`, 1, 500, 500);
    expect(mp3?.input).toEqual(["-f", "mp3", "-i", "pipe:0"]);
    const piped = await drain(mp3!);
    expect(piped.includes(0xee)).toBe(false);
    expect(piped.includes(0xff)).toBe(false);
    const ac3 = box("ac-3", new Array(6).fill(0), u16(1), new Array(20).fill(0));
    files.set("/h.mp4", mp4File(100, { entry: ac3 }).file);
    expect((await openAudioWindow(`${base}/h.mp4`, 1, 500, 500))?.input).toEqual(["-f", "ac3", "-i", "pipe:0"]);
  });
});

// ---------- Matroska, element by element ----------
const idBytes = (id: number) => { const out: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return out; };
const size8 = (n: number) => [0x01, ...Array.from({ length: 7 }, (_, i) => Math.floor(n / 256 ** (6 - i)) % 256)];
const el = (id: number, ...body: Array<Uint8Array | number[]>) => { const data = bytes(...body); return bytes(idBytes(id), size8(data.length), data); };
const uint = (id: number, v: number) => el(id, Array.from({ length: 4 }, (_, i) => Math.floor(v / 256 ** (3 - i)) % 256));
const str = (id: number, s: string) => el(id, [...Buffer.from(s)]);

/** Clusters of 1 s (k's bytes are 0x10 + k), indexed every second, Cues at the end. */
function mkvFile(clusters: number) {
  const ebml = el(0x1a45dfa3, str(0x4282, "matroska"));
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000));
  const track = (n: number, type: number, codec: string) => el(0xae, uint(0xd7, n), uint(0x83, type), str(0x86, codec));
  const tracks = el(0x1654ae6b, track(1, 1, "V_MPEG4/ISO/AVC"), track(2, 2, "A_AAC"));
  const cluster = (k: number) => el(0x1f43b675, uint(0xe7, k * 1000), new Uint8Array(300).fill(0x10 + k));
  const seekHead = (cuesAt: number) => el(0x114d9b74, el(0x4dbb, el(0x53ab, idBytes(0x1c53bb6b)), uint(0x53ac, cuesAt)));
  const head = (cuesAt: number) => bytes(seekHead(cuesAt), info, tracks);
  const lead = head(0).length;
  const clusterAt: number[] = [];
  let at = lead;
  const all: Uint8Array[] = [];
  for (let k = 0; k < clusters; k++) {
    clusterAt.push(at);
    const c = cluster(k);
    all.push(c);
    at += c.length;
  }
  const cues = el(0x1c53bb6b, ...clusterAt.map((p, k) => el(0xbb, uint(0xb3, k * 1000), el(0xb7, uint(0xf7, 1), uint(0xf1, p)))));
  const body = bytes(head(at), ...all, cues);
  const segment = bytes(idBytes(0x18538067), size8(body.length), body);
  const segmentStart = ebml.length + segment.length - body.length;
  return { file: bytes(ebml, segment), ebml, info, tracks, clusterAt: clusterAt.map((p) => segmentStart + p), cluster };
}

describe("only the audio's bytes, in one request of many ranges", () => {
  /** The ADTS stream of frames first..last of an mp4File. */
  const framesOf = (frameSize: (k: number) => number, first: number, last: number) =>
    bytes(...Array.from({ length: last - first + 1 }, (_, i) => first + i).flatMap((k) => [adtsHeader({ profile: 1, rate: 3, channels: 2 }, frameSize(k)), new Uint8Array(frameSize(k)).fill(k & 0xff)]));

  it("splits a multipart/byteranges reply into its ranges, wherever the reads break it", async () => {
    const body = Buffer.from("\r\n--B0\r\nContent-Type: video/mp4\r\nContent-Range: bytes 10-14/100\r\n\r\nabcde\r\n--B0\r\nContent-Range: bytes 50-52/100\r\n\r\nxyz\r\n--B0--\r\n");
    for (const step of [1, 3, 7, body.length]) {
      async function* reads() {
        for (let at = 0; at < body.length; at += step) yield new Uint8Array(body.subarray(at, at + step));
      }
      const got: Array<[number, string]> = [];
      for await (const p of byteranges(reads(), "B0")) got.push([p.at, Buffer.from(p.data).toString()]);
      // Joined back per range: 10-14 "abcde", 50-52 "xyz".
      const joined = new Map<number, string>();
      let start = -1;
      let next = -1;
      for (const [at, text] of got) {
        if (at !== next) start = at;
        joined.set(start, (joined.get(start) ?? "") + text);
        next = at + text.length;
      }
      expect([...joined]).toEqual([[10, "abcde"], [50, "xyz"]]);
    }
  });

  it("joins adjacent samples and small gaps, and keeps a request under 200 ranges", () => {
    const offsets = [0, 10, 20, 10_000, 10_010, 30_000];
    const sizes = [10, 10, 10, 10, 10, 10];
    expect(audioRanges(offsets, sizes, 0, 5)).toEqual([[0, 30], [10_000, 10_020], [30_000, 30_010]]);
    const many = Array.from({ length: 500 }, (_, k) => k * 10_000 + (k % 5) * 100);
    const ranges = audioRanges(many, many.map(() => 10), 0, 499);
    expect(ranges.length).toBe(200);
    // Every sample still inside a range.
    for (const o of many) expect(ranges.some(([a, b]) => a <= o && o + 10 <= b)).toBe(true);
  });

  it("reads only the audio, in one request, and pipes the same frames as a read of the whole stretch", async () => {
    const { file, frameSize } = mp4File(600, { video: 20_000 });
    files.set("/m.mp4", file);
    files.set("/one-m.mp4", file);
    const w = await openAudioWindow(`${base}/m.mp4`, 1, 5000, 2000);
    const piped = await drain(w!);
    expect(Buffer.from(piped).equals(Buffer.from(framesOf(frameSize, 224, 329)))).toBe(true);
    const stretch = rangesOf("m.mp4").at(-1)!;
    // One range per chunk of 4 frames it touches: chunks 56 (frames 224-227) to 82 (328-331).
    expect(stretch.split(",").length).toBe(82 - 56 + 1);
    // The audio and the parts' framing: a few KB, where the stretch's whole span is over 500 KB.
    expect(w!.received()).toBeLessThan(20_000);
  });

  it("asks one range at a time from a host that answers the first range alone, the whole file, or turns the request down, and remembers it", async () => {
    for (const name of ["one-n.mp4", "whole-n.mp4", "long-n.mp4"]) {
      // The behaviours on one stand-in host: what it learnt from one is forgotten for the next.
      await resetAudioIndexes(true);
      const { file, frameSize } = mp4File(600, { video: 20_000 });
      files.set(`/${name}`, file);
      const w = await openAudioWindow(`${base}/${name}`, 1, 5000, 2000);
      expect(Buffer.from(await drain(w!)).equals(Buffer.from(framesOf(frameSize, 224, 329)))).toBe(true);
      const asks = rangesOf(name);
      // The many-range try, then the stretch's span as one range.
      expect(asks.at(-2)!.includes(",")).toBe(true);
      expect(asks.at(-1)!.includes(",")).toBe(false);
      // The next stretch goes straight to one range.
      await drain((await openAudioWindow(`${base}/${name}`, 1, 9000, 1000))!);
      expect(rangesOf(name).at(-1)!.includes(",")).toBe(false);
      expect(rangesOf(name).length).toBe(asks.length + 1);
    }
  });
});

describe("what a service does with many ranges, learnt once", () => {
  const spots = [2000, 4000, 6000, 8000, 10_000];

  it("asks once while it isn't known: the stretches beside the first wait for its answer", async () => {
    files.set("/whole-p.mp4", mp4File(600, { video: 20_000 }).file);
    await Promise.all(spots.map(async (from) => drain((await openAudioWindow(`${base}/whole-p.mp4`, 1, from, 1000))!)));
    const asks = rangesOf("whole-p.mp4").filter((r) => r.includes(","));
    expect(asks).toHaveLength(1);
    // Every stretch then read as one range.
    expect(rangesOf("whole-p.mp4").filter((r) => !r.includes(",") && !r.startsWith("bytes=0-"))).toHaveLength(spots.length + 1);
  });

  it("keeps the answer across a restart", async () => {
    files.set("/whole-q.mp4", mp4File(600, { video: 20_000 }).file);
    await drain((await openAudioWindow(`${base}/whole-q.mp4`, 1, 5000, 1000))!);
    // A restart: nothing in memory, the kept answer on disk.
    await resetAudioIndexes();
    asked.length = 0;
    await drain((await openAudioWindow(`${base}/whole-q.mp4`, 1, 9000, 1000))!);
    expect(rangesOf("whole-q.mp4").some((r) => r.includes(","))).toBe(false);
  });

  it("doesn't hold back the stretches of a service known to take many", async () => {
    files.set("/r.mp4", mp4File(600, { video: 20_000 }).file);
    await drain((await openAudioWindow(`${base}/r.mp4`, 1, 1000, 1000))!);
    asked.length = 0;
    await Promise.all(spots.map(async (from) => drain((await openAudioWindow(`${base}/r.mp4`, 1, from, 1000))!)));
    expect(rangesOf("r.mp4").filter((r) => r.includes(","))).toHaveLength(spots.length);
  });
});

describe("a stretch of a Matroska file's audio", () => {
  it("pipes the file's own header (as a Segment of unknown size), then the clusters around the stretch, read in one range", async () => {
    const m = mkvFile(30);
    files.set("/a.mkv", m.file);
    const w = await openAudioWindow(`${base}/a.mkv`, 1, 10_500, 3000);
    expect(w?.input).toEqual(["-copyts", "-f", "matroska", "-i", "pipe:0"]);
    expect(w?.output).toEqual(["-map", "0:1", "-af", "atrim=start=10.500000:duration=3.000000"]);
    const piped = await drain(w!);
    const header = bytes(m.ebml, [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], m.info, m.tracks);
    // The cluster starting at 10 s (the last one before the 200 ms lead-in) through the one at 13 s; not 14 s.
    const clusters = bytes(...[10, 11, 12, 13].map(m.cluster));
    expect(Buffer.from(piped).equals(Buffer.from(bytes(header, clusters)))).toBe(true);
    const ranges = rangesOf("a.mkv");
    // The start, the index in one read (it runs to the file's end), the stretch.
    expect(ranges).toHaveLength(3);
    expect(ranges[2]).toBe(`bytes=${m.clusterAt[10]}-${m.clusterAt[14] - 1}`);
  });

  it("reads to the file's end for a stretch past the last index entry", async () => {
    const m = mkvFile(12);
    files.set("/b.mkv", m.file);
    const w = await openAudioWindow(`${base}/b.mkv`, 1, 10_500, 3000);
    await drain(w!);
    expect(rangesOf("b.mkv").at(-1)).toBe(`bytes=${m.clusterAt[10]}-`);
  });
});
