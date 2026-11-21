import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baseLanguage, filedUnder, forVariant, languageLabel, otherKind, spanishKind } from "../src/variants.js";
import type { SubSourceSubtitle } from "../src/types.js";

const sub = (id: number, language: string, release: string, commentary: string | null = null): SubSourceSubtitle =>
  ({ subtitleId: id, movieId: 1, language, releaseInfo: [release], commentary, files: 1, hearingImpaired: false, downloads: 0, rating: null }) as SubSourceSubtitle;
const ids = (list: SubSourceSubtitle[]) => list.map((s) => s.subtitleId);

/** Dialogue of about `words` words: plain lines, with `forms` of Spain's and `ustedes` of Latin America's among them. */
function dialogue(words: number, forms: number, ustedes: number): string {
  const plain = "No sé qué quieres que haga con esto ahora mismo";
  const lines: string[] = [];
  for (let i = 0; lines.join(" ").split(/\s+/).length < words; i++) lines.push(plain);
  for (let i = 0; i < forms; i++) lines[i * 3] = ["¿Qué hacéis vosotros aquí?", "Os lo he dicho mil veces", "Sois unos pesados, callaos"][i % 3];
  for (let i = 0; i < ustedes; i++) lines[i * 3 + 1] = "¿Qué hacen ustedes aquí?";
  return lines.map((line, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},900\n${line}\n`).join("\n");
}

describe("the two kinds of Spanish", () => {
  it("are filed under Spanish, and shown under their full names", () => {
    expect(baseLanguage("spanish (la)")).toBe("spanish");
    expect(baseLanguage("Spanish (EU)")).toBe("spanish");
    expect(baseLanguage("spanish")).toBeUndefined();
    expect(baseLanguage("portuguese (br)")).toBeUndefined();
    expect(languageLabel("Spanish (LA)")).toBe("Spanish (Latin America)");
    expect(languageLabel("spanish (eu)")).toBe("Spanish (Spain)");
    expect(languageLabel("Dutch")).toBe("Dutch");
    expect(filedUnder({ language: "spanish" }, "spanish (la)")).toBe(true);
    expect(filedUnder({ language: "spanish (la)" }, "spanish (la)")).toBe(true);
    expect(filedUnder({ language: "spanish (eu)" }, "spanish (la)")).toBe(false);
    expect(filedUnder({ language: "spanish (la)" }, "spanish")).toBe(false);
    expect(filedUnder({ language: "french" }, "spanish (la)")).toBe(false);
  });

  it("put a track's own kind first by tag and by name, the unmarked next, and leave the other kind out", () => {
    const list = [
      sub(1, "spanish", "Film.1999.1080p.BluRay-TEAM"),
      sub(2, "spanish", "Film.1999.720p.BRip.XviD.Latino.AC3-TEAM"),
      sub(3, "spanish", "BluRay.1080p.x264.DTS-TEAM - (Europeo)"),
      sub(4, "spanish (la)", "Film 1999 WEBRip"),
      sub(5, "spanish", "Film 1999", "Español (España)"),
      sub(6, "spanish", "[NF][LAT] Show - S01E01"),
      sub(7, "spanish (eu)", "Film 1999 WEBRip"),
      // Both marks in one name say nothing either way.
      sub(8, "spanish", "Film.1999.Castellano.Latino.DUAL")
    ];
    expect(ids(forVariant(list, "spanish (la)"))).toEqual([2, 4, 6, 1, 8]);
    expect(ids(forVariant(list, "spanish (eu)"))).toEqual([3, 5, 7, 1, 8]);
    // One subtitle given twice, under the kind's tag and under Spanish, is one candidate, the tagged one.
    const twice = [{ ...sub(9, "spanish", "720p.TEAM"), ref: "gdabc123", source: "gestdown" as const }, { ...sub(9, "spanish (eu)", "720p.TEAM"), ref: "gdabc123", source: "gestdown" as const }];
    expect(forVariant(twice, "spanish (eu)").map((s) => s.language)).toEqual(["spanish (eu)"]);
    // Spanish itself, and a language with no kinds, keep their lists as ranked.
    expect(ids(forVariant(list, "spanish"))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ids(forVariant(list, "dutch"))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("aren't read out of other words: a plate, a slate, a release's own letters", () => {
    const list = [sub(1, "spanish", "Film.1999.PLATINUM.Edition"), sub(2, "spanish", "Film.1999.ESPN.HDTV"), sub(3, "spanish", "Film.1999.Translated")];
    expect(ids(forVariant(list, "spanish (la)"))).toEqual([1, 2, 3]);
    expect(ids(forVariant(list, "spanish (eu)"))).toEqual([1, 2, 3]);
  });
});

describe("which Spanish a subtitle is written in", () => {
  it("is Spain's with its second person plural forms, Latin America's with ustedes and next to none of them", () => {
    expect(spanishKind(dialogue(6000, 22, 0))).toBe("spain");
    expect(spanishKind(dialogue(3400, 5, 0))).toBe("spain");
    expect(spanishKind(dialogue(6500, 1, 2))).toBe("america");
    expect(spanishKind(dialogue(3100, 0, 1))).toBe("america");
  });

  it("isn't said of too little text, or of text with neither sign", () => {
    expect(spanishKind(dialogue(300, 4, 0))).toBeUndefined();
    expect(spanishKind(dialogue(2400, 0, 0))).toBeUndefined();
    // "ustedes" in a short file isn't enough: Spain uses it too, for formal speech.
    expect(spanishKind(dialogue(1200, 0, 1))).toBeUndefined();
    // One line of Spain's forms in a long file is a quotation, not its Spanish.
    expect(spanishKind(dialogue(6500, 1, 0))).toBeUndefined();
  });

  it("refuses a stored file of the other kind on a kind's track only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bttr-variants-"));
    const spain = path.join(dir, "spain.srt");
    const america = path.join(dir, "america.srt");
    const unknown = path.join(dir, "unknown.srt");
    writeFileSync(spain, dialogue(6000, 22, 0));
    writeFileSync(america, dialogue(6500, 1, 2));
    writeFileSync(unknown, dialogue(2400, 0, 0));
    expect(await otherKind(spain, "spanish (la)")).toBe(true);
    expect(await otherKind(spain, "spanish (eu)")).toBe(false);
    expect(await otherKind(america, "spanish (eu)")).toBe(true);
    expect(await otherKind(america, "spanish (la)")).toBe(false);
    for (const language of ["spanish (la)", "spanish (eu)"]) expect(await otherKind(unknown, language)).toBe(false);
    for (const language of ["spanish", "dutch", undefined]) expect(await otherKind(spain, language)).toBe(false);
    expect(await otherKind(path.join(dir, "missing.srt"), "spanish (la)")).toBe(false);
  });
});
