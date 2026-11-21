/**
 * The timing of an MP4 file's text subtitle tracks, from its sample tables alone (ISO base media file
 * format). An MP4 keeps, in its movie box (moov), every track's sample durations (stts) and sizes
 * (stsz). In a text track (mov_text, as muxers write subtitles into MP4) each sample is one line, or an
 * empty sample for the gap between two lines: two bytes, the length of no text (an 8-byte box in
 * WebVTT-in-MP4). So every line's start and length is in the moov box, a few hundred KB at the start
 * or the end of the file, where reading the lines themselves means reading stretches of the video.
 * Edit lists (edts) that delay or trim a track are applied, as players do. Files that aren't MP4, or
 * have no text track, return undefined and are read the usual way.
 */
import { fileHead, range, type MkvTiming, type MkvTrack } from "./mkv.js";

/** Read first: an MP4 that starts with its moov holds it here, and the boxes before mdat fit. */
const HEAD_BYTES = 64 * 1024;
/** A moov box bigger than this isn't read (a long film's runs to a few MB). */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** Top-level boxes stepped over looking for moov, at most. */
const MAX_TOP_BOXES = 16;

export interface Box {
  type: string;
  /** Where its content starts and ends, in the buffer it was read from. */
  start: number;
  end: number;
}

export const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
export const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4);
const i32 = (b: Uint8Array, at: number) => u32(b, at) | 0;
export const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** The boxes in b between from and to; a box that runs past `to` is cut there. */
export function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = u64(b, at + 8);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header) break;
    out.push({ type: fourcc(b, at + 4), start: at + header, end: Math.min(at + size, to) });
    at += size;
  }
  return out;
}

export const child = (b: Uint8Array, box: Box | undefined, type: string) => (box ? boxes(b, box.start, box.end).find((c) => c.type === type) : undefined);
export const path = (b: Uint8Array, box: Box | undefined, ...types: string[]) => types.reduce<Box | undefined>((at, t) => child(b, at, t), box);

/** mdhd's packed language: three letters of five bits each, "und" when unset. */
export function language(b: Uint8Array, at: number): string {
  const v = (b[at] << 8) | b[at + 1];
  const letters = [(v >> 10) & 31, (v >> 5) & 31, v & 31].map((c) => String.fromCharCode(c + 0x60));
  return /^[a-z]{3}$/.test(letters.join("")) ? letters.join("") : "und";
}

/**
 * What's left of a file past its start, when a box lies there, read in one go up to this: the moov at
 * the file's end (and any small boxes after it), without first reading its header. Calibration: a
 * 24-minute web episode's moov is about 0.9 MB.
 */
const TAIL_AT_ONCE = 8 * 1024 * 1024;

/** The moov box of the MP4 at url, read whole, or undefined when there's none (not an MP4). */
export async function readMoov(url: string, timeoutMs: number): Promise<{ moov: Uint8Array; bytesRead: number } | undefined> {
  // Shared with the Matroska read and the hash, which start with the same bytes.
  const { bytes: head, readHere, size: fileSize } = await fileHead(url, timeoutMs, HEAD_BYTES);
  if (head.length < 8 || !["ftyp", "styp", "moov", "free", "wide"].includes(fourcc(head, 4))) return undefined;
  let bytesRead = readHere;
  let at = 0;
  for (let hops = 0; hops < MAX_TOP_BOXES; hops++) {
    let header: Uint8Array;
    if (at + 16 <= head.length) header = head.subarray(at, at + 16);
    else if (fileSize !== undefined && fileSize > at && fileSize - at <= TAIL_AT_ONCE) {
      const tail = await range(url, at, fileSize - at, timeoutMs);
      bytesRead += tail.length;
      for (let p = 0; p + 8 <= tail.length; ) {
        const big = u32(tail, p) === 1;
        const size = big ? (p + 16 <= tail.length ? u64(tail, p + 8) : 0) : u32(tail, p);
        const skip = big ? 16 : 8;
        if (size < skip) return undefined;
        if (fourcc(tail, p + 4) === "moov") return p + size <= tail.length ? { moov: tail.subarray(p + skip, p + size), bytesRead } : undefined;
        p += size;
      }
      return undefined;
    } else {
      header = await range(url, at, 16, timeoutMs);
      bytesRead += header.length;
    }
    if (header.length < 8) return undefined;
    let size = u32(header, 0);
    let skip = 8;
    if (size === 1) {
      size = u64(header, 8);
      skip = 16;
    }
    const type = fourcc(header, 4);
    if (size < skip) return undefined;
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) return undefined;
      if (at + size <= head.length) return { moov: head.subarray(at + skip, at + size), bytesRead };
      const moov = await range(url, at + skip, size - skip, timeoutMs);
      bytesRead += moov.length;
      return moov.length === size - skip ? { moov, bytesRead } : undefined;
    }
    at += size;
  }
  return undefined;
}

/** A track's sample start times and lengths in its own timescale, from stts. */
export function sampleTimes(b: Uint8Array, stts: Box): Array<{ at: number; length: number }> {
  const out: Array<{ at: number; length: number }> = [];
  const entries = u32(b, stts.start + 4);
  let t = 0;
  for (let i = 0; i < entries; i++) {
    const p = stts.start + 8 + i * 8;
    if (p + 8 > stts.end) break;
    const count = u32(b, p);
    const delta = u32(b, p + 4);
    for (let k = 0; k < count; k++, t += delta) out.push({ at: t, length: delta });
  }
  return out;
}

/** Each sample's size in bytes, from stsz (or the compact stz2). */
export function sampleSizes(b: Uint8Array, stbl: Box): number[] | undefined {
  const stsz = child(b, stbl, "stsz");
  if (stsz) {
    const fixed = u32(b, stsz.start + 4);
    const count = u32(b, stsz.start + 8);
    if (fixed) return new Array<number>(count).fill(fixed);
    const out: number[] = [];
    for (let i = 0; i < count && stsz.start + 12 + i * 4 + 4 <= stsz.end; i++) out.push(u32(b, stsz.start + 12 + i * 4));
    return out;
  }
  const stz2 = child(b, stbl, "stz2");
  if (!stz2) return undefined;
  const bits = b[stz2.start + 7];
  const count = u32(b, stz2.start + 8);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = stz2.start + 12;
    if (bits === 8) out.push(b[p + i]);
    else if (bits === 16) out.push((b[p + i * 2] << 8) | b[p + i * 2 + 1]);
    else out.push(i % 2 === 0 ? b[p + (i >> 1)] >> 4 : b[p + (i >> 1)] & 15);
  }
  return out;
}

/**
 * How a track's media time maps to the movie's, from its edit list: a delay (an empty edit first)
 * and the media time it starts at. Only the common shape is read: one empty edit at most, then one.
 */
export function editOf(b: Uint8Array, trak: Box, movieScale: number): { delayMs: number; startTicks: number } {
  const elst = path(b, trak, "edts", "elst");
  if (!elst) return { delayMs: 0, startTicks: 0 };
  const version = b[elst.start];
  const entries = u32(b, elst.start + 4);
  let delayMs = 0;
  let at = elst.start + 8;
  for (let i = 0; i < entries && at < elst.end; i++) {
    const segment = version === 1 ? u64(b, at) : u32(b, at);
    // A negative media time (-1) is an empty edit: the track starts that much later.
    const mediaTime = version === 1 ? (b[at + 8] & 0x80 ? -1 : u64(b, at + 8)) : i32(b, at + 4);
    at += version === 1 ? 20 : 12;
    if (mediaTime < 0) delayMs += (segment / movieScale) * 1000;
    else return { delayMs, startTicks: mediaTime };
  }
  return { delayMs, startTicks: 0 };
}

/** Text samples' codes: 3GPP timed text (mov_text) and WebVTT in MP4. A sample this size or smaller holds no text. */
const TEXT_CODECS: Record<string, number> = { tx3g: 2, text: 2, wvtt: 8 };

/**
 * The subtitle tracks' timing of the MP4 file at url, from its moov box, in the shape of a Matroska
 * file's (readMkvTiming): or undefined when it isn't an MP4 or has no text track with lines.
 */
export async function readMp4Timing(url: string, timeoutMs = 20000): Promise<MkvTiming | undefined> {
  const read = await readMoov(url, timeoutMs);
  if (!read) return undefined;
  const b = read.moov;
  const top = boxes(b, 0, b.length);
  const mvhd = top.find((x) => x.type === "mvhd");
  if (!mvhd) return undefined;
  const v = b[mvhd.start];
  const movieScale = u32(b, mvhd.start + (v === 1 ? 20 : 12)) || 1000;
  const movieDuration = v === 1 ? u64(b, mvhd.start + 24) : u32(b, mvhd.start + 16);
  const tracks: MkvTrack[] = [];
  const lines = new Map<number, Array<{ start: number; end: number }>>();
  let index = 0;
  for (const trak of top.filter((x) => x.type === "trak")) {
    const tkhd = child(b, trak, "tkhd");
    const mdia = child(b, trak, "mdia");
    const mdhd = child(b, mdia, "mdhd");
    const hdlr = child(b, mdia, "hdlr");
    const stbl = path(b, mdia, "minf", "stbl");
    if (!tkhd || !mdhd || !hdlr || !stbl) continue;
    const number = u32(b, tkhd.start + (b[tkhd.start] === 1 ? 20 : 12));
    const mv = b[mdhd.start];
    const mediaScale = u32(b, mdhd.start + (mv === 1 ? 20 : 12)) || 1000;
    const lang = language(b, mdhd.start + (mv === 1 ? 32 : 20));
    const handler = fourcc(b, hdlr.start + 8);
    const stsd = child(b, stbl, "stsd");
    const codec = stsd && stsd.start + 16 <= stsd.end ? fourcc(b, stsd.start + 12) : "";
    const type: MkvTrack["type"] = handler === "vide" ? "video" : handler === "soun" ? "audio" : ["sbtl", "text", "subt"].includes(handler) ? "subtitle" : "other";
    tracks.push({ number, index: index++, type, codec, language: lang, name: "", forced: false, default: false });
    const empty = TEXT_CODECS[codec];
    if (type !== "subtitle" || empty === undefined) continue;
    const stts = child(b, stbl, "stts");
    const sizes = sampleSizes(b, stbl);
    if (!stts || !sizes) continue;
    const { delayMs, startTicks } = editOf(b, trak, movieScale);
    const ms = (ticks: number) => Math.round(((ticks - startTicks) / mediaScale) * 1000 + delayMs);
    const times = sampleTimes(b, stts);
    const out: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < times.length && i < sizes.length; i++) {
      if (sizes[i] <= empty) continue;
      const start = ms(times[i].at);
      if (start >= 0) out.push({ start, end: ms(times[i].at + times[i].length) });
    }
    lines.set(number, out);
  }
  if (![...lines.values()].some((l) => l.length > 0)) return undefined;
  return { duration: Math.round((movieDuration / movieScale) * 1000), tracks, lines, bytesRead: read.bytesRead };
}
