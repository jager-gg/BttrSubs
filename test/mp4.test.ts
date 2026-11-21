/**
 * An MP4's text track timed from its sample tables (src/mp4.ts): built here box by box, served by a
 * stand-in host that answers range requests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMp4Timing } from "../src/mp4.js";

const bytes = (...parts: Array<Uint8Array | number[]>) => {
  const all = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) out.set(p, (at += p.length) - p.length);
  return out;
};
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, ...parts: Array<Uint8Array | number[]>) => {
  const body = bytes(...parts);
  return bytes(u32(8 + body.length), ascii(type), body);
};
const full = (type: string, ...parts: Array<Uint8Array | number[]>) => box(type, [0, 0, 0, 0], ...parts);
/** mdhd's language: three letters, five bits each. */
const lang = (code: string) => u16([...code].reduce((v, c) => (v << 5) | (c.charCodeAt(0) - 0x60), 0));

/** A track whose samples alternate gaps (empty, 2 bytes) and lines (10 bytes), timescale 1000. */
function textTrack(id: number, lines: Array<[number, number]>, language = "eng", delayMs = 0) {
  const samples: Array<{ length: number; size: number }> = [];
  let t = 0;
  for (const [start, end] of lines) {
    if (start > t) samples.push({ length: start - t, size: 2 });
    samples.push({ length: end - start, size: 10 });
    t = end;
  }
  const stts = full("stts", u32(samples.length), ...samples.map((s) => [...u32(1), ...u32(s.length)]));
  const stsz = full("stsz", u32(0), u32(samples.length), ...samples.map((s) => u32(s.size)));
  const stsd = full("stsd", u32(1), box("tx3g", new Array(30).fill(0)));
  const edts = delayMs ? [box("edts", full("elst", u32(2), u32(delayMs), u32(0xffffffff), u32(0x10000), u32(t), u32(0), u32(0x10000)))] : [];
  return box(
    "trak",
    full("tkhd", u32(0), u32(0), u32(id), new Array(68).fill(0)),
    ...edts,
    box("mdia", full("mdhd", u32(0), u32(0), u32(1000), u32(t), lang(language), u16(0)), full("hdlr", u32(0), ascii("sbtl"), new Array(13).fill(0)), box("minf", box("stbl", stsd, stts, stsz)))
  );
}
const videoTrack = (id: number) =>
  box("trak", full("tkhd", u32(0), u32(0), u32(id), new Array(68).fill(0)), box("mdia", full("mdhd", u32(0), u32(0), u32(24000), u32(0), lang("und"), u16(0)), full("hdlr", u32(0), ascii("vide"), new Array(13).fill(0)), box("minf", box("stbl", full("stsd", u32(0))))));
const moov = (...traks: Uint8Array[]) => box("moov", full("mvhd", u32(0), u32(0), u32(1000), u32(1_400_000), new Array(80).fill(0)), ...traks);
const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isomiso2mp41"));
const mdat = (n: number) => box("mdat", new Array(n).fill(7));

function host(file: Uint8Array) {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get("range") ?? "");
    const from = Number(m?.[1] ?? 0);
    const to = Math.min(Number(m?.[2] ?? file.length - 1), file.length - 1);
    return new Response(new Uint8Array(file.subarray(from, to + 1)), { status: 206 });
  });
}
afterEach(() => vi.unstubAllGlobals());

const LINES: Array<[number, number]> = [[1000, 3000], [4000, 6500], [10000, 12000], [12000, 13500]];

describe("an MP4's text track timed from its sample tables", () => {
  it("gives every line's start and end, gaps left out, with the track's place and language", async () => {
    host(bytes(ftyp, moov(videoTrack(1), textTrack(2, LINES, "ara")), mdat(4096)));
    const timing = await readMp4Timing("https://files.example/a.mp4");
    expect(timing?.lines.get(2)).toEqual(LINES.map(([start, end]) => ({ start, end })));
    expect(timing?.tracks.map((t) => [t.number, t.index, t.type, t.codec, t.language])).toEqual([[1, 0, "video", "", "und"], [2, 1, "subtitle", "tx3g", "ara"]]);
    expect(timing?.duration).toBe(1_400_000);
  });

  it("finds the moov box after the media, and applies an edit list's delay", async () => {
    host(bytes(ftyp, mdat(200_000), moov(textTrack(1, LINES, "eng", 500))));
    const timing = await readMp4Timing("https://files.example/b.mp4");
    expect(timing?.lines.get(1)).toEqual(LINES.map(([start, end]) => ({ start: start + 500, end: end + 500 })));
    // The header, the mdat's 16 bytes and the moov: not the media.
    expect(timing!.bytesRead).toBeLessThan(80_000);
  });

  it("is nothing for a file that isn't an MP4, or has no text track", async () => {
    host(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(64).fill(0)]));
    expect(await readMp4Timing("https://files.example/c.mkv")).toBeUndefined();
    host(bytes(ftyp, moov(videoTrack(1)), mdat(64)));
    expect(await readMp4Timing("https://files.example/d.mp4")).toBeUndefined();
  });
});
