/**
 * The OpenSubtitles hash of a video file: its size plus its first and last 64 KB read as
 * little-endian 64-bit words, all summed modulo 2^64. Subtitle sites index uploads by it, so it
 * finds the subtitles made for that very file. Players send it as videoHash; for a file played
 * without one it's worked out here, from two small reads.
 */
import { range, sharedHead } from "./mkv.js";

/** Bytes hashed at each end of the file. */
export const HASH_CHUNK = 64 * 1024;
const MASK = (1n << 64n) - 1n;

/** The hash as 16 lower-case hex digits, from the file's first and last HASH_CHUNK bytes and its size. */
export function openSubtitlesHash(head: Uint8Array, tail: Uint8Array, size: number): string | undefined {
  // A file under two chunks has its ends overlap; no video is that small.
  if (head.length < HASH_CHUNK || tail.length < HASH_CHUNK || !Number.isSafeInteger(size) || size < 2 * HASH_CHUNK) return undefined;
  let sum = BigInt(size);
  for (const chunk of [head, tail]) {
    const words = new DataView(chunk.buffer, chunk.byteOffset, HASH_CHUNK);
    for (let at = 0; at < HASH_CHUNK; at += 8) sum = (sum + words.getBigUint64(at, true)) & MASK;
  }
  return sum.toString(16).padStart(16, "0");
}

/**
 * The hash of the file at url: its start (which also gives its size), taken from the header read when
 * there was one (mkv.ts sharedHead), else read here, then its end. HASH_CHUNK each.
 */
export async function readFileHash(url: string, timeoutMs = 15000): Promise<{ hash: string; size: number } | undefined> {
  let head: Uint8Array | undefined;
  let size: number | undefined;
  const shared = await sharedHead(url)?.catch(() => undefined);
  if (shared && shared.bytes.length >= HASH_CHUNK && shared.size) [head, size] = [shared.bytes.subarray(0, HASH_CHUNK), shared.size];
  else {
    const info: { size?: number } = {};
    head = await range(url, 0, HASH_CHUNK, timeoutMs, info);
    size = info.size;
  }
  if (!size || size < 2 * HASH_CHUNK) return undefined;
  const tail = await range(url, size - HASH_CHUNK, HASH_CHUNK, timeoutMs);
  const hash = openSubtitlesHash(head, tail, size);
  return hash ? { hash, size } : undefined;
}
