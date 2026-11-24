/** Unpacking .xz files whose integrity check the unpacker doesn't read (xz.ts). */
import { describe, expect, it } from "vitest";
import { unxz, withReadableCheck } from "../src/xz.js";

const TEXT = "1\n00:00:01,000 --> 00:00:02,000\nA line.\n\n2\n00:00:03,000 --> 00:00:04,000\nAnother line.\n";
// The same text packed by xz with a SHA-256 check, and with a CRC64 one.
const SHA256 = Buffer.from("/Td6WFoAAArh+wyhAgAhARYAAAB0L+Wj4ABWADFdABiCglwMZizdwI10n2AfLLohpxkLSxax0B5Q8bRvvgy7L4Pegk9VOPt3rWbA1LT3eQAAAAAAVmBf5ilBRhchTcbT+MW74rs1vC2PyJECgLKQgBi/vkMAAWVXnu4DzRibS5oBAAAAAApZWg==", "base64");
const CRC64 = Buffer.from("/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4ABWADFdABiCglwMZizdwI10n2AfLLohpxkLSxax0B5Q8bRvvgy7L4Pegk9VOPt3rWbA1LT3eQAAAAAAc/aAO2D6ZlwAAU1XNEBekB+2830BAAAAAARZWg==", "base64");

describe("an .xz file with a check the unpacker doesn't read", () => {
  it("unpacks to the same text, with a SHA-256 check and with a CRC64 one", async () => {
    expect((await unxz(SHA256, 10_000)).toString("utf8")).toBe(TEXT);
    expect((await unxz(CRC64, 10_000)).toString("utf8")).toBe(TEXT);
  });

  it("is rewritten with no check, shorter by the check's size, and left alone when rewritten once", () => {
    const plain = withReadableCheck(SHA256);
    expect(plain[7]).toBe(0);
    expect(plain.length).toBe(SHA256.length - 32);
    expect(withReadableCheck(plain)).toBe(plain);
  });

  it("refuses what isn't an xz file, a cut one, and one that unpacks past the limit", async () => {
    expect(() => withReadableCheck(Buffer.from(TEXT))).toThrow(/not an xz file/);
    expect(() => withReadableCheck(SHA256.subarray(0, SHA256.length - 3))).toThrow(/xz:/);
    await expect(unxz(SHA256, 10)).rejects.toThrow(/more than a subtitle/);
  });
});
