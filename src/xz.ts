/**
 * Unpacking an .xz file: the format subtitle tracks are kept in by the sites that extract them.
 *
 * The unpacker used here reads streams whose integrity check is a CRC32 or none. Some sites pack
 * with a SHA-256 or CRC64 check, which it refuses as an option it doesn't have. The check is a field
 * after each block and a number in the stream's header, footer and index: it isn't part of the
 * packed data. So a stream with another check is rewritten as the same stream with no check (the
 * check fields left out, the sizes and the three CRC32s around them put right), and then unpacked.
 * What the check would have caught, a damaged file, shows as text that doesn't read as a subtitle.
 */
import { crc32 } from "node:zlib";
import xz from "xz-decompress";

const { XzReadableStream } = xz;

const MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
/** A check's size in bytes, by its id in the stream's flags. */
const CHECK_SIZE = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

/** A number as xz writes sizes: seven bits a byte, the lowest first, the high bit set on all but the last. */
function readNumber(bytes: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 9; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) break;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new Error("xz: a size that doesn't end");
}
function writeNumber(value: number): Buffer {
  const out: number[] = [];
  let left = value;
  do {
    const low = left % 128;
    left = Math.floor(left / 128);
    out.push(left > 0 ? low | 0x80 : low);
  } while (left > 0);
  return Buffer.from(out);
}
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const padTo4 = (length: number) => Buffer.alloc((4 - (length % 4)) % 4);

/**
 * The same one-stream .xz with no integrity check, when its check is one the unpacker doesn't read
 * (anything but none and CRC32); the bytes as they are otherwise.
 */
export function withReadableCheck(file: Buffer): Buffer {
  if (file.length < 32 || !file.subarray(0, 6).equals(MAGIC)) throw new Error("xz: not an xz file");
  const check = file[7] & 0x0f;
  if (file[6] !== 0 || check <= 1) return file;
  const checkSize = CHECK_SIZE[check];
  const end = file.length;
  if (file[end - 2] !== 0x59 || file[end - 1] !== 0x5a) throw new Error("xz: more than one stream, or a cut file");
  const indexSize = (file.readUInt32LE(end - 8) + 1) * 4;
  const indexAt = end - 12 - indexSize;
  if (indexAt < 12 || file[indexAt] !== 0) throw new Error("xz: no index where the footer says");
  let at = indexAt + 1;
  const count = readNumber(file, at);
  at = count.next;
  const records: Array<{ unpadded: number; unpacked: number }> = [];
  for (let i = 0; i < count.value; i++) {
    const unpadded = readNumber(file, at);
    const unpacked = readNumber(file, unpadded.next);
    at = unpacked.next;
    records.push({ unpadded: unpadded.value, unpacked: unpacked.value });
  }
  // Each block without its check field, padded to four bytes as blocks are.
  const blocks: Buffer[] = [];
  let blockAt = 12;
  for (const record of records) {
    const kept = file.subarray(blockAt, blockAt + record.unpadded - checkSize);
    blocks.push(kept, padTo4(kept.length));
    blockAt += record.unpadded + ((4 - (record.unpadded % 4)) % 4);
  }
  if (blockAt !== indexAt) throw new Error("xz: its blocks don't end where its index begins");
  const flags = Buffer.from([0x00, 0x00]);
  const listed = Buffer.concat([Buffer.from([0x00]), writeNumber(records.length), ...records.flatMap((r) => [writeNumber(r.unpadded - checkSize), writeNumber(r.unpacked)])]);
  const index = Buffer.concat([listed, padTo4(listed.length)]);
  const backward = le32((index.length + 4) / 4 - 1);
  return Buffer.concat([MAGIC, flags, le32(crc32(flags)), ...blocks, index, le32(crc32(index)), le32(crc32(Buffer.concat([backward, flags]))), backward, flags, Buffer.from([0x59, 0x5a])]);
}

/** An .xz file unpacked, refused past `maxBytes` (a subtitle track is a few hundred KB). */
export async function unxz(file: Buffer, maxBytes: number): Promise<Buffer> {
  const readable = withReadableCheck(file);
  const reader = new XzReadableStream(new Response(new Uint8Array(readable)).body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("xz: unpacks to more than a subtitle ever is");
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
