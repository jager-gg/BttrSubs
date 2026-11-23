/** A pack that lists one file name twice (downloads.ts, withOwnNames): opened, the first of the two kept. */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { selectArchiveEntry, withOwnNames } from "../src/downloads.js";

/** A zip of these files, then the second's name written over with the first's, in both its headers. */
function packWithRepeat(): Buffer {
  const zip = new AdmZip();
  zip.addFile("Show - 01.ass", Buffer.from("first"));
  zip.addFile("Show - 0X.ass", Buffer.from("second"));
  zip.addFile("Show - 02.ass", Buffer.from("third"));
  const bytes = zip.toBuffer();
  for (let at = bytes.indexOf("Show - 0X.ass"); at >= 0; at = bytes.indexOf("Show - 0X.ass")) bytes.write("Show - 01.ass", at, "latin1");
  return bytes;
}

describe("a pack that lists one name twice", () => {
  it("is refused whole by the zip reader as it comes", () => {
    expect(() => new AdmZip(packWithRepeat()).getEntries()).toThrow(/Duplicate entry/);
  });

  it("opens with each name its own, and gives the first of the two", () => {
    const zip = new AdmZip(withOwnNames(packWithRepeat()));
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual(["Show - 01.ass", "Show - 01.a~1", "Show - 02.ass"]);
    expect(selectArchiveEntry(zip, 1, 1)?.getData().toString()).toBe("first");
    expect(selectArchiveEntry(zip, 1, 2)?.getData().toString()).toBe("third");
  });

  it("leaves a pack without repeats, and bytes that aren't a zip, as they are", () => {
    const zip = new AdmZip();
    zip.addFile("Show - 01.ass", Buffer.from("first"));
    const bytes = zip.toBuffer();
    expect(withOwnNames(bytes)).toBe(bytes);
    const text = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nLine\n");
    expect(withOwnNames(text)).toBe(text);
  });
});
