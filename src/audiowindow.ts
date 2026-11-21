/**
 * A stretch of the playing file's audio, read here and piped into ffmpeg, in place of ffmpeg opening
 * the file's address itself. Opening an address, ffmpeg reads the file's start, its index and its
 * start again before every stretch, each read dropped after a few KB with what was in flight landing
 * anyway: four or five requests a stretch where one does. Here the file's index, read once per file
 * and kept, gives each stretch's byte range; one range request reads it, and its bytes go to ffmpeg as
 * they arrive, so decoding keeps pace with the download.
 *
 * - MP4 with AAC, MP3, AC-3 or E-AC-3 audio: the index is the moov box (read through the same shared
 *   first bytes as the header and the hash). The sample table says where each audio frame lies, so
 *   the one request asks for those bytes alone, as many ranges (a multipart/byteranges reply), where
 *   the host takes that; else for the stretch's whole span. The frames are handed over as the codec's
 *   own stream (AAC with an ADTS header per frame), so ffmpeg never sees the video between them.
 * - Matroska: the index is the header and the Cues. The clusters around the stretch follow the file's
 *   own EBML header, Info and Tracks, behind a Segment of unknown size.
 * - Anything else (another codec, no index, samples out of order): undefined, and the caller reads the
 *   usual way.
 *
 * Each stretch starts at least PREROLL_MS early, so the decoder has the frames before it, and ffmpeg
 * trims to the stretch exactly.
 */
import { rm } from "node:fs/promises";
import { cacheKey, cachePath, readJsonCache, writeJsonCache } from "./cache.js";
import { checkHost, fetchFile, noteReadOk, noteRefusal, ReadsPaused } from "./reads.js";
import { children, ID, readCues, readHead, sharedHead, uint, type Element } from "./mkv.js";
import { boxes, child, editOf, fourcc, path, readMoov, sampleSizes, sampleTimes, u32, u64, type Box } from "./mp4.js";

/** A stretch ready to pipe into ffmpeg. */
export interface AudioWindow {
  /** ffmpeg's input: format and pipe ("-f", "aac", "-i", "pipe:0"). */
  input: string[];
  /** After the input: the stream to take and the trim to the stretch. */
  output: string[];
  /** The bytes to pipe in, as they arrive. */
  bytes: AsyncIterable<Uint8Array>;
  /** Ends the read: ffmpeg has what it needs. */
  stop(): void;
  /** Bytes received from the host so far. */
  received(): number;
  /** The time (ms) of the first byte piped in, on the file's own clock. */
  startMs: number;
  /** Byte ranges the read asked for in its one request. */
  ranges: number;
}

/** Decoder lead before a stretch: a few frames (AAC's are 21-23 ms, AC-3's 32 ms). */
const PREROLL_MS = 200;

/**
 * The trim to the stretch, as a filter on the decoded audio at its own rate, before ffmpeg converts it
 * to the output's: so it falls on the same sample as ffmpeg's own seek in the file, which an output
 * -ss (a trim after the conversion) misses by a fraction of an output sample.
 */
const cut = (startMs: number, length: number) => `atrim=start=${(startMs / 1000).toFixed(6)}:duration=${(length / 1000).toFixed(6)}`;
/** A file's audio index is kept this long: as long as its resolved address (PLAYBACK_KEPT_MS in sync.ts). */
const INDEX_KEPT_MS = 20 * 60 * 1000;
const INDEX_TIMEOUT_MS = 20000;
const WINDOW_TIMEOUT_MS = 60000;

interface Mp4Audio {
  kind: "mp4";
  format: "aac" | "mp3" | "ac3" | "eac3";
  /** ADTS fields for AAC: profile (object type - 1), sampling frequency index, channel configuration. */
  adts?: { profile: number; rate: number; channels: number };
  /** Per sample, in decode order: its presentation time (ms), file offset and size. */
  times: Float64Array;
  offsets: Float64Array;
  sizes: Uint32Array;
  /** A frame's length (ms): the commonest sample duration, the one a stream without timestamps gives every frame. */
  frameMs: number;
}

interface MkvAudio {
  kind: "mkv";
  /** EBML header, a Segment of unknown size, Info and Tracks: what ffmpeg needs before any cluster. */
  header: Uint8Array;
  segmentStart: number;
  /** Index entries: a time (ms) and the file offset of the cluster holding it, sorted by time. */
  points: Array<{ ms: number; at: number }>;
}

type AudioIndex = Mp4Audio | MkvAudio;

const indexes = new Map<string, { at: number; read: Promise<AudioIndex | undefined> }>();

/** The file's audio index for this stream (ffmpeg's index), read once and kept; undefined when this module can't read it. */
function audioIndex(url: string, audio: number): Promise<AudioIndex | undefined> {
  const key = `${audio} ${url}`;
  const now = Date.now();
  const kept = indexes.get(key);
  if (kept && now - kept.at < INDEX_KEPT_MS) return kept.read;
  for (const [k, v] of indexes) if (now - v.at >= INDEX_KEPT_MS) indexes.delete(k);
  const read = (async () => (await mp4Audio(url, audio)) ?? (await mkvAudio(url, audio)))();
  indexes.set(key, { at: now, read });
  // A failed read isn't kept: the next stretch tries again.
  read.catch(() => indexes.get(key)?.read === read && indexes.delete(key));
  return read;
}

/**
 * The stretch [from, from + length) ms of audio stream `audio` (ffmpeg's index) of the file at url,
 * its read already answering; undefined when the file's layout isn't one read here. A refusal or a
 * pause of the file's host is thrown, as any read of the file throws it.
 */
export async function openAudioWindow(url: string, audio: number, from: number, length: number): Promise<AudioWindow | undefined> {
  let index: AudioIndex | undefined;
  try {
    index = await audioIndex(url, audio);
  } catch (error) {
    if (error instanceof ReadsPaused || /refused/i.test(error instanceof Error ? error.message : "")) throw error;
    return undefined;
  }
  if (!index) return undefined;
  return index.kind === "mp4" ? mp4Window(url, index, from, length) : mkvWindow(url, index, audio, from, length);
}

// ---------- reading a range as it arrives ----------

/** Bytes of the file and where they start in it. */
interface Piece {
  at: number;
  data: Uint8Array;
}

interface RangeRead {
  /** The bytes as they arrive, each piece at its place in the file; pieces of one range follow on. */
  pieces: AsyncIterable<Piece>;
  stop(): void;
  received(): number;
}

/** Ranges a run of samples is split at, at most: their Range header stays under about 5 KB, below the common 8 KB limit on a header. */
const MAX_RANGES = 200;
/** Ranges this close are read as one: a few KB more, one part fewer to frame and seek. */
const MERGE_GAP = 4096;
/**
 * What a service does with a request of many ranges, by its domain (a debrid service's download
 * servers run the same software: what one does, all do), kept RANGES_KNOWN_SECONDS across restarts.
 */
const singleRangeHosts = new Set<string>();
const manyRangeHosts = new Set<string>();
const RANGES_KNOWN_SECONDS = 7 * 24 * 3600;
/** A first request of many ranges on its way to a service not known yet: the stretches beside it wait for its answer. */
const learning = new Map<string, Promise<boolean>>();
/** Answers being written to disk (see learnt): a reset waits for them, as a restart finds them written. */
const keeping = new Set<Promise<void>>();

/** A host's domain: its last two labels (nexus-291.weur.tb-cdn.st: tb-cdn.st). */
const serviceOf = (host: string) => host.replace(/:\d+$/, "").split(".").slice(-2).join(".");

/** What's kept on disk of the service's answer, put back in memory; undefined when nothing is. */
async function keptAnswer(service: string): Promise<boolean | undefined> {
  const kept = await readJsonCache<{ many: boolean }>("ranges", cacheKey({ service })).catch(() => undefined);
  if (kept) (kept.many ? manyRangeHosts : singleRangeHosts).add(service);
  return kept?.many;
}

/** What a request found out about the service: remembered, kept, logged once (the host, never an address: they hold keys). */
function learnt(host: string, many: boolean, why: string): void {
  const service = serviceOf(host);
  const known = many ? manyRangeHosts : singleRangeHosts;
  if (!known.has(service)) {
    console.log(many ? `sync: ${host} answers many ranges (${why}): ${service} asked that way` : `sync: ${host} doesn't answer many ranges (${why}): one range a stretch from ${service}`);
    const kept = writeJsonCache("ranges", cacheKey({ service }), { many }, RANGES_KNOWN_SECONDS).catch(() => {});
    keeping.add(kept);
    void kept.finally(() => keeping.delete(kept));
  }
  known.add(service);
}

/** A reply's status as a range read: refused (thrown, and noted on 403 and 429), or fine. */
async function refuseUnless(ok: boolean, url: string, response: Response, timer: NodeJS.Timeout): Promise<void> {
  if (ok) return;
  clearTimeout(timer);
  await response.body?.cancel();
  if (response.status === 403 || response.status === 429) noteRefusal(url, response.status);
  throw new Error(`range read refused (HTTP ${response.status})`);
}

/** The bytes [from, to) of the file (to the end when `to` is undefined), as they arrive. */
async function streamRange(url: string, from: number, to: number | undefined): Promise<RangeRead> {
  checkHost(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WINDOW_TIMEOUT_MS);
  const response = await fetchFile(url, { headers: { Range: `bytes=${from}-${to === undefined ? "" : to - 1}` }, signal: controller.signal });
  await refuseUnless(response.status === 206 || (response.status === 200 && from === 0), url, response, timer);
  noteReadOk(url);
  let got = 0;
  const limit = to === undefined ? Infinity : to - from;
  const reader = response.body?.getReader();
  async function* pieces(): AsyncGenerator<Piece> {
    try {
      while (reader && got < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        // A host that ignores Range sends from the start: only the part asked for goes on.
        const data = value.subarray(0, Math.min(value.length, limit - got));
        yield { at: from + got, data };
        got += data.length;
      }
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
    }
  }
  return {
    pieces: pieces(),
    stop: () => {
      clearTimeout(timer);
      controller.abort();
    },
    received: () => got
  };
}

/**
 * The byte ranges [from, to) of the file in one request, as they arrive (a multipart/byteranges
 * reply, or one range when the host joined them); undefined when the host doesn't answer requests of
 * many ranges (the whole file, the first range alone, or the request turned down), which is then
 * remembered: the caller reads one range instead.
 */
async function streamRanges(url: string, ranges: Array<[number, number]>): Promise<RangeRead | undefined> {
  const host = new URL(url).host;
  const service = serviceOf(host);
  if (singleRangeHosts.has(service)) return undefined;
  if (manyRangeHosts.has(service)) return askRanges(url, host, ranges);
  // Another stretch is asking: its answer.
  const pending = learning.get(service);
  if (pending) return (await pending) ? askRanges(url, host, ranges) : undefined;
  // This stretch asks; the ones beside it wait (set before any wait, so they see it).
  let answer = (_many: boolean) => {};
  learning.set(service, new Promise<boolean>((resolve) => (answer = resolve)));
  try {
    const kept = await keptAnswer(service);
    if (kept !== undefined) {
      answer(kept);
      return kept ? await askRanges(url, host, ranges) : undefined;
    }
    const read = await askRanges(url, host, ranges);
    answer(read !== undefined);
    return read;
  } catch (error) {
    // A failed read says nothing about the ranges: the waiting stretches read one range.
    answer(false);
    throw error;
  } finally {
    learning.delete(service);
  }
}

async function askRanges(url: string, host: string, ranges: Array<[number, number]>): Promise<RangeRead | undefined> {
  checkHost(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WINDOW_TIMEOUT_MS);
  const response = await fetchFile(url, { headers: { Range: `bytes=${ranges.map(([a, b]) => `${a}-${b - 1}`).join(",")}` }, signal: controller.signal });
  // Anything but a refusal or the ranges: the whole file (200), or the request turned down (400 or 431
  // for its long header, 416).
  if (response.status !== 206 && response.status !== 403 && response.status !== 429) {
    clearTimeout(timer);
    controller.abort();
    learnt(host, false, `HTTP ${response.status}, ${response.headers.get("content-type") ?? "no type"}, ${ranges.length} ranges`);
    return undefined;
  }
  await refuseUnless(response.status === 206, url, response, timer);
  noteReadOk(url);
  const boundary = /multipart\/byteranges;.*boundary="?([^";]+)"?/i.exec(response.headers.get("content-type") ?? "")?.[1];
  const single = /bytes (\d+)-(\d+)\//.exec(response.headers.get("content-range") ?? "");
  // One range back: fine when the host joined them all into it; one that answers the first range only
  // doesn't answer many.
  if (!boundary && !(single && Number(single[1]) <= ranges[0][0] && Number(single[2]) >= ranges[ranges.length - 1][1] - 1)) {
    clearTimeout(timer);
    controller.abort();
    learnt(host, false, `HTTP 206, ${response.headers.get("content-type") ?? "no type"}, ${single ? "one range back" : "no range back"}, ${ranges.length} ranges`);
    return undefined;
  }
  learnt(host, true, `${ranges.length} in one request`);
  let got = 0;
  const reader = response.body!.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        yield value;
      }
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
    }
  }
  async function* whole(start: number): AsyncGenerator<Piece> {
    let at = start;
    for await (const data of chunks()) {
      yield { at, data };
      at += data.length;
    }
  }
  return {
    pieces: boundary ? byteranges(chunks(), boundary) : whole(Number(single![1])),
    stop: () => {
      clearTimeout(timer);
      controller.abort();
    },
    received: () => got
  };
}

const CRLF2 = Buffer.from("\r\n\r\n");

/**
 * The parts of a multipart/byteranges body, as they arrive: each part's headers name its range
 * (Content-Range), and exactly that many bytes follow them.
 */
export async function* byteranges(chunks: AsyncIterable<Uint8Array>, boundary: string): AsyncGenerator<Piece> {
  const delimiter = Buffer.from(`--${boundary}`);
  let buffered: Buffer = Buffer.alloc(0);
  // In a part's data: where the next byte goes in the file, and how many are left.
  let at = 0;
  let left = 0;
  for await (const chunk of chunks) {
    let data: Buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    while (data.length) {
      if (left > 0) {
        const n = Math.min(left, data.length);
        yield { at, data: data.subarray(0, n) };
        at += n;
        left -= n;
        data = data.subarray(n);
        continue;
      }
      // Between parts: the delimiter, the part's headers, then its data.
      buffered = buffered.length ? Buffer.concat([buffered, data]) : data;
      data = Buffer.alloc(0);
      const d = buffered.indexOf(delimiter);
      if (d < 0) break;
      if (buffered.length >= d + delimiter.length + 2 && buffered.subarray(d + delimiter.length, d + delimiter.length + 2).toString() === "--") return;
      const end = buffered.indexOf(CRLF2, d);
      if (end < 0) break;
      const range = /content-range:\s*bytes (\d+)-(\d+)\//i.exec(buffered.subarray(d, end).toString("latin1"));
      if (!range) throw new Error("a part without its range");
      at = Number(range[1]);
      left = Number(range[2]) - at + 1;
      data = buffered.subarray(end + CRLF2.length);
      buffered = Buffer.alloc(0);
    }
  }
}

// ---------- MP4 ----------

/** An MPEG-4 descriptor's tag, its length and where its data starts. */
function descriptor(b: Uint8Array, at: number, end: number): { tag: number; start: number; end: number } | undefined {
  if (at + 2 > end) return undefined;
  const tag = b[at];
  let length = 0;
  let p = at + 1;
  for (let i = 0; i < 4 && p < end; i++) {
    const byte = b[p++];
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { tag, start: p, end: Math.min(p + length, end) };
}

/** From an esds box: the stream's object type and its decoder config (AudioSpecificConfig for AAC). */
function esdsConfig(b: Uint8Array, esds: Box): { objectType: number; config: Uint8Array } | undefined {
  const es = descriptor(b, esds.start + 4, esds.end);
  if (!es || es.tag !== 3) return undefined;
  const flags = b[es.start + 2];
  let p = es.start + 3;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + b[p];
  if (flags & 0x20) p += 2;
  const dc = descriptor(b, p, es.end);
  if (!dc || dc.tag !== 4) return undefined;
  const objectType = b[dc.start];
  const dsi = descriptor(b, dc.start + 13, dc.end);
  return { objectType, config: dsi && dsi.tag === 5 ? b.subarray(dsi.start, dsi.end) : new Uint8Array() };
}

/** ADTS fields from an AudioSpecificConfig, or undefined when ADTS can't carry it. */
export function adtsFields(config: Uint8Array): { profile: number; rate: number; channels: number } | undefined {
  if (config.length < 2) return undefined;
  let bit = 0;
  const bits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((config[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  let objectType = bits(5);
  if (objectType === 31) objectType = 32 + bits(6);
  const rate = bits(4);
  if (rate === 15) return undefined; // an explicit rate: ADTS has only the table's
  const channels = bits(4);
  // HE-AAC (SBR, and PS on top): the core stream is AAC-LC at this rate, and the decoder finds the rest.
  const core = objectType === 5 || objectType === 29 ? 2 : objectType;
  if (core < 1 || core > 4 || channels < 1 || channels > 7) return undefined;
  return { profile: core - 1, rate, channels };
}

/** The 7-byte ADTS header (no CRC) of an AAC frame of `payload` bytes. */
export function adtsHeader(f: { profile: number; rate: number; channels: number }, payload: number): Uint8Array {
  const length = payload + 7;
  return Uint8Array.of(0xff, 0xf1, (f.profile << 6) | (f.rate << 2) | (f.channels >> 2), ((f.channels & 3) << 6) | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc);
}

/** Each sample's file offset, from the sample-to-chunk table and the chunk offsets. */
function sampleOffsets(b: Uint8Array, stbl: Box, sizes: number[]): Float64Array | undefined {
  const stsc = child(b, stbl, "stsc");
  const stco = child(b, stbl, "stco");
  const co64 = child(b, stbl, "co64");
  if (!stsc || (!stco && !co64)) return undefined;
  const table = (stco ?? co64)!;
  const chunks: number[] = [];
  const count = u32(b, table.start + 4);
  for (let i = 0; i < count; i++) {
    const p = table.start + 8 + i * (stco ? 4 : 8);
    if (p + (stco ? 4 : 8) > table.end) break;
    chunks.push(stco ? u32(b, p) : u64(b, p));
  }
  const runs: Array<{ first: number; perChunk: number }> = [];
  const entries = u32(b, stsc.start + 4);
  for (let i = 0; i < entries; i++) {
    const p = stsc.start + 8 + i * 12;
    if (p + 12 > stsc.end) break;
    runs.push({ first: u32(b, p) - 1, perChunk: u32(b, p + 4) });
  }
  if (!runs.length) return undefined;
  const out = new Float64Array(sizes.length);
  let sample = 0;
  for (let c = 0, r = 0; c < chunks.length && sample < sizes.length; c++) {
    while (r + 1 < runs.length && runs[r + 1].first <= c) r++;
    let at = chunks[c];
    for (let k = 0; k < runs[r].perChunk && sample < sizes.length; k++, sample++) {
      out[sample] = at;
      at += sizes[sample];
    }
  }
  return sample === sizes.length ? out : undefined;
}

/** Audio stream `audio` of an MP4's moov: its codec and sample table, or undefined when it isn't one read here. */
async function mp4Audio(url: string, audio: number): Promise<Mp4Audio | undefined> {
  const read = await readMoov(url, INDEX_TIMEOUT_MS);
  if (!read) return undefined;
  const b = read.moov;
  const top = boxes(b, 0, b.length);
  const mvhd = top.find((x) => x.type === "mvhd");
  const trak = top.filter((x) => x.type === "trak")[audio];
  if (!mvhd || !trak) return undefined;
  const movieScale = u32(b, mvhd.start + (b[mvhd.start] === 1 ? 20 : 12)) || 1000;
  const mdia = child(b, trak, "mdia");
  const mdhd = child(b, mdia, "mdhd");
  const hdlr = child(b, mdia, "hdlr");
  const stbl = path(b, mdia, "minf", "stbl");
  if (!mdhd || !hdlr || !stbl || fourcc(b, hdlr.start + 8) !== "soun") return undefined;
  const mediaScale = u32(b, mdhd.start + (b[mdhd.start] === 1 ? 20 : 12)) || 1000;
  const stsd = child(b, stbl, "stsd");
  if (!stsd || stsd.start + 16 > stsd.end) return undefined;
  const entryAt = stsd.start + 8;
  const entryEnd = Math.min(stsd.end, entryAt + u32(b, entryAt));
  const codec = fourcc(b, entryAt + 4);
  let format: Mp4Audio["format"];
  let adts: Mp4Audio["adts"];
  if (codec === "ac-3" || codec === "ec-3") format = codec === "ac-3" ? "ac3" : "eac3";
  else if (codec === "mp4a") {
    // The sound sample entry's fields run 28 bytes (QuickTime's version 1 adds 16, version 2 adds 36).
    const version = (b[entryAt + 16] << 8) | b[entryAt + 17];
    const inner = boxes(b, entryAt + 36 + (version === 1 ? 16 : version === 2 ? 36 : 0), entryEnd);
    const esds = inner.find((x) => x.type === "esds") ?? child(b, inner.find((x) => x.type === "wave"), "esds");
    const found = esds && esdsConfig(b, esds);
    if (!found) return undefined;
    // 0x40: MPEG-4 audio; 0x66-0x68: MPEG-2 AAC; 0x69 and 0x6B: MPEG audio (MP3).
    if (found.objectType === 0x69 || found.objectType === 0x6b) format = "mp3";
    else if (found.objectType === 0x40 || (found.objectType >= 0x66 && found.objectType <= 0x68)) {
      adts = adtsFields(found.config);
      if (!adts) return undefined;
      format = "aac";
    } else return undefined;
  } else return undefined;
  const stts = child(b, stbl, "stts");
  const sizes = sampleSizes(b, stbl);
  if (!stts || !sizes || !sizes.length) return undefined;
  const offsets = sampleOffsets(b, stbl, sizes);
  if (!offsets) return undefined;
  const { delayMs, startTicks } = editOf(b, trak, movieScale);
  const ticks = sampleTimes(b, stts);
  if (ticks.length < sizes.length) return undefined;
  const times = new Float64Array(sizes.length);
  const lengths = new Map<number, number>();
  for (let i = 0; i < sizes.length; i++) {
    times[i] = ((ticks[i].at - startTicks) / mediaScale) * 1000 + delayMs;
    lengths.set(ticks[i].length, (lengths.get(ticks[i].length) ?? 0) + 1);
    // Stored out of order: not cut here.
    if (i > 0 && offsets[i] < offsets[i - 1]) return undefined;
  }
  const commonest = [...lengths].reduce((x, y) => (y[1] > x[1] ? y : x))[0];
  return { kind: "mp4", format, adts, times, offsets, sizes: Uint32Array.from(sizes), frameMs: (commonest / mediaScale) * 1000 };
}

/** The first sample index whose time is at or after t (times sorted). */
function firstAtOrAfter(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The audio samples first..last as byte ranges [from, to): runs of adjacent samples, gaps under MERGE_GAP joined, at most MAX_RANGES. */
export function audioRanges(offsets: ArrayLike<number>, sizes: ArrayLike<number>, first: number, last: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = first; k <= last; k++) {
    const from = offsets[k];
    const to = from + sizes[k];
    const run = out[out.length - 1];
    if (run && from >= run[1] && from - run[1] <= MERGE_GAP) run[1] = Math.max(run[1], to);
    else out.push([from, to]);
  }
  // Too many for one request: join across the smallest gaps.
  while (out.length > MAX_RANGES) {
    let smallest = 0;
    for (let i = 1; i + 1 < out.length; i++) if (out[i + 1][0] - out[i][1] < out[smallest + 1][0] - out[smallest][1]) smallest = i;
    out.splice(smallest, 2, [out[smallest][0], out[smallest + 1][1]]);
  }
  return out;
}

async function mp4Window(url: string, a: Mp4Audio, from: number, length: number): Promise<AudioWindow | undefined> {
  const first = Math.max(0, firstAtOrAfter(a.times, from - PREROLL_MS) - 1);
  const last = Math.min(a.times.length - 1, firstAtOrAfter(a.times, from + length));
  if (first > last) return undefined;
  const start = a.offsets[first];
  const end = a.offsets[last] + a.sizes[last];
  // Only the audio's bytes, in one request of many ranges, where the host takes those; else the
  // stretch's whole span (video between the samples included) in one range.
  const ranges = audioRanges(a.offsets, a.sizes, first, last);
  const many = ranges.length > 1 ? await streamRanges(url, ranges) : undefined;
  const read = many ?? (await streamRange(url, start, end));
  async function* frames(): AsyncGenerator<Uint8Array> {
    // What has arrived and isn't handed on yet, from file offset `base`.
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let base = start;
    let next = first;
    const take = (at: number, size: number): Uint8Array => {
      // Drop what lies before the sample (the video between audio samples).
      let skip = at - base;
      while (pending.length && skip >= pending[0].length) {
        skip -= pending[0].length;
        base += pending[0].length;
        pendingBytes -= pending[0].length;
        pending.shift();
      }
      const out = new Uint8Array(size);
      let filled = 0;
      let i = 0;
      let offset = skip;
      while (filled < size) {
        const part = pending[i++];
        const n = Math.min(size - filled, part.length - offset);
        out.set(part.subarray(offset, offset + n), filled);
        filled += n;
        offset = 0;
      }
      return out;
    };
    for await (const piece of read.pieces) {
      if (piece.at < base + pendingBytes) throw new Error("ranges answered out of order");
      // A new range: what's pending (the end of the last one) holds no more samples.
      if (piece.at > base + pendingBytes) {
        pending = [];
        pendingBytes = 0;
        base = piece.at;
      }
      pending.push(piece.data);
      pendingBytes += piece.data.length;
      const out: Uint8Array[] = [];
      while (next <= last && a.offsets[next] + a.sizes[next] <= base + pendingBytes) {
        const sample = take(a.offsets[next], a.sizes[next]);
        if (a.adts) out.push(adtsHeader(a.adts, sample.length));
        out.push(sample);
        next++;
      }
      if (out.length) yield Buffer.concat(out);
      if (next > last) break;
    }
    pending = [];
  }
  // The trim on the piped stream's own clock, where every frame lasts frameMs: whole frames up to the
  // one the stretch starts in, then the way into that frame on the file's clock. A file whose sample
  // durations vary (a remux from whole-millisecond timestamps) is trimmed where ffmpeg would trim it.
  const at = Math.max(first, firstAtOrAfter(a.times, from + 1e-6) - 1);
  const trim = (at - first) * a.frameMs + Math.min(a.frameMs, Math.max(0, from - a.times[at]));
  const startMs = a.times[first];
  return {
    input: ["-f", a.format, "-i", "pipe:0"],
    output: ["-map", "0:a:0", "-af", cut(trim, length)],
    bytes: frames(),
    stop: read.stop,
    received: read.received,
    startMs,
    ranges: many ? ranges.length : 1
  };
}

// ---------- Matroska ----------

/** A Segment of unknown size: its ID, then a size of all ones. */
const OPEN_SEGMENT = Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

async function mkvAudio(url: string, audio: number): Promise<MkvAudio | undefined> {
  const head = await readHead(url, INDEX_TIMEOUT_MS);
  if (!head || head.cuesAt === undefined || head.tracks[audio]?.type !== "audio") return undefined;
  const bytes = (await sharedHead(url))?.bytes;
  if (!bytes) return undefined;
  const top = children(bytes, 0, bytes.length);
  const segment = top.find((e) => e.id === ID.Segment);
  if (top[0]?.id !== ID.EBML || top[0].cut || !segment) return undefined;
  const level1 = children(bytes, segment.start, segment.end);
  const info = level1.find((e) => e.id === ID.Info && !e.cut);
  const tracks = level1.find((e) => e.id === ID.Tracks && !e.cut);
  if (!info || !tracks) return undefined;
  const cues = await readCues(url, head.cuesAt, INDEX_TIMEOUT_MS, head.cuesEnd);
  if (!cues) return undefined;
  const points: Array<{ ms: number; at: number }> = [];
  for (const point of children(cues.cues, 0, cues.cues.length)) {
    if (point.id !== ID.CuePoint) continue;
    const fields = children(cues.cues, point.start, point.end);
    const time = fields.find((f) => f.id === ID.CueTime);
    if (!time) continue;
    const ms = (uint(cues.cues, time) * head.scaleNs) / 1e6;
    for (const positions of fields.filter((f) => f.id === ID.CueTrackPositions)) {
      const cluster = children(cues.cues, positions.start, positions.end).find((f) => f.id === ID.CueClusterPosition);
      if (cluster) points.push({ ms, at: head.segmentStart + uint(cues.cues, cluster) });
    }
  }
  if (!points.length) return undefined;
  points.sort((x, y) => x.ms - y.ms || x.at - y.at);
  const raw = (e: Element) => bytes.subarray(e.at, e.end);
  const header = Buffer.concat([raw(top[0]), OPEN_SEGMENT, raw(info), raw(tracks)]);
  return { kind: "mkv", header, segmentStart: head.segmentStart, points };
}

async function mkvWindow(url: string, m: MkvAudio, audio: number, from: number, length: number): Promise<AudioWindow | undefined> {
  // The last cluster starting before the lead-in, and the first one starting after the stretch.
  let start = m.points[0].at;
  let startAt = m.points[0].ms;
  for (const p of m.points) {
    if (p.ms > from - PREROLL_MS) break;
    start = p.at;
    startAt = p.ms;
  }
  const after = m.points.find((p) => p.ms > from + length && p.at > start);
  const read = await streamRange(url, start, after?.at);
  async function* withHeader(): AsyncGenerator<Uint8Array> {
    yield m.header;
    for await (const piece of read.pieces) yield piece.data;
  }
  return {
    // Cluster times are the file's own: kept (-copyts), so the trim is to the stretch's own times.
    input: ["-copyts", "-f", "matroska", "-i", "pipe:0"],
    output: ["-map", `0:${audio}`, "-af", cut(from, length)],
    bytes: withHeader(),
    stop: read.stop,
    received: read.received,
    startMs: startAt,
    ranges: 1
  };
}

/** For tests: forget every kept index, what services do with many ranges, and (forgetKept) what's kept of that on disk. */
export async function resetAudioIndexes(forgetKept = false): Promise<void> {
  await Promise.all(keeping);
  indexes.clear();
  singleRangeHosts.clear();
  manyRangeHosts.clear();
  learning.clear();
  if (forgetKept) await rm(cachePath("ranges"), { recursive: true, force: true });
}
