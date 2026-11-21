/** Wyzie Subs' pieces on their own: a result's language among the wanted ones, and its notice taken out of a file. */
import { describe, expect, it } from "vitest";
import { subtitleCatTranslation, wantedLanguageOf, withoutWyzieNotice, wyzieRef } from "../src/wyzie.js";

describe("a Wyzie result's language", () => {
  it("is the wanted language its code or its two letters stand for", () => {
    expect(wantedLanguageOf("en-AU", ["english", "arabic"])).toBe("english");
    expect(wantedLanguageOf("ar-SA", ["english", "arabic"])).toBe("arabic");
    expect(wantedLanguageOf("nl", ["dutch"])).toBe("dutch");
    expect(wantedLanguageOf("fr", ["english"])).toBeUndefined();
  });

  it("goes to the language of its own code when two wanted ones share its letters, else the plain one", () => {
    const both = ["portuguese", "portuguese (br)"];
    expect(wantedLanguageOf("pt-BR", both)).toBe("portuguese (br)");
    expect(wantedLanguageOf("pt", both)).toBe("portuguese");
    expect(wantedLanguageOf("pt", ["portuguese (br)"])).toBe("portuguese (br)");
    // A code that is another wanted-or-not language's own isn't taken for its sibling.
    expect(wantedLanguageOf("pt-PT", ["portuguese (br)"])).toBeUndefined();
    expect(wantedLanguageOf("pt-BR", ["portuguese"])).toBeUndefined();
  });

  it("reads a code spelled another way as its own language, never by its first two letters", () => {
    const chinese = ["chinese (simplified)", "chinese (traditional)"];
    expect(wantedLanguageOf("zh-Hant", chinese)).toBe("chinese (traditional)");
    expect(wantedLanguageOf("zh-HK", chinese)).toBe("chinese (traditional)");
    expect(wantedLanguageOf("zh-Hans", chinese)).toBe("chinese (simplified)");
    expect(wantedLanguageOf("zh", chinese)).toBe("chinese (simplified)");
    expect(wantedLanguageOf("zh-Hant", ["chinese (simplified)"])).toBeUndefined();
    expect(wantedLanguageOf("zh", ["chinese (traditional)"])).toBe("chinese (traditional)");
    expect(wantedLanguageOf("fil", ["finnish", "tagalog"])).toBe("tagalog");
    expect(wantedLanguageOf("fil", ["finnish"])).toBeUndefined();
    expect(wantedLanguageOf("nb", ["norwegian"])).toBe("norwegian");
    expect(wantedLanguageOf("ckb", ["kurdish"])).toBeUndefined();
    expect(wantedLanguageOf("es-419", ["spanish"])).toBe("spanish");
    expect(wantedLanguageOf("bs-Cyrl", ["bosnian"])).toBe("bosnian");
  });
});

describe("a Wyzie result's ref", () => {
  it("is short and safe in a link, whatever its id holds, and differs by source", () => {
    const ref = wyzieRef("quebec", "1705/Show - S01E05.English[CC].srt");
    expect(ref).toMatch(/^wz[0-9a-f]{20}$/);
    expect(wyzieRef("xray", "1705/Show - S01E05.English[CC].srt")).not.toBe(ref);
  });
});

describe("Wyzie's notice in a downloaded file", () => {
  const notice = "You're on the free plan. Unlock every source, AI translation & ad-free subs → sub.wyzie.io";

  it("is taken out of an SRT, the cues after it unchanged", () => {
    const srt = ["1", "00:00:00,000 --> 00:00:06,000", notice, "", "2", "00:00:01,000 --> 00:00:02,000", "Hello.", "", "3", "00:00:03,000 --> 00:00:04,000", "Bye.", ""].join("\r\n");
    const out = withoutWyzieNotice(Buffer.from(srt, "utf8")).toString("utf8");
    expect(out).toBe(["2", "00:00:01,000 --> 00:00:02,000", "Hello.", "", "3", "00:00:03,000 --> 00:00:04,000", "Bye.", ""].join("\r\n"));
  });

  it("is taken out of a VTT, its header kept", () => {
    const vtt = ["WEBVTT", "", "00:00:00.000 --> 00:00:06.000", notice.replace("&", "&amp;"), "", "00:00:01.000 --> 00:00:02.000", "Hello.", ""].join("\n");
    expect(withoutWyzieNotice(Buffer.from(vtt, "utf8")).toString("utf8")).toBe(["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "Hello.", ""].join("\n"));
  });

  it("is taken out of an ASS script as its event, every other line kept", () => {
    const ass = ["[Script Info]", "ScriptType: v4.00+", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", `Dialogue: 0,0:00:00.00,0:00:06.00,Default,,0,0,0,,${notice}`, "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello.", ""].join("\n");
    const out = withoutWyzieNotice(Buffer.from(ass, "utf8")).toString("utf8");
    expect(out).not.toContain("wyzie.io");
    expect(out).toContain("Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello.");
    expect(out.split("\n")).toHaveLength(ass.split("\n").length - 1);
  });

  it("leaves a file without it as it came, byte for byte, in any encoding", () => {
    const latin = Buffer.from([0x31, 0x0a, 0x30, 0x30, 0x3a, 0x30, 0x30, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]);
    expect(withoutWyzieNotice(latin)).toBe(latin);
    const arabic = Buffer.from(["1", "00:00:01,000 --> 00:00:02,000", "مرحبا.", "", "2", "00:00:00,000 --> 00:00:06,000", notice, ""].join("\n"), "utf8");
    expect(withoutWyzieNotice(arabic).toString("utf8")).toBe(["1", "00:00:01,000 --> 00:00:02,000", "مرحبا.", "", ""].join("\n"));
  });
});

describe("a Subtitle Cat file Wyzie relays", () => {
  it("is a machine translation when its language isn't its upload's, by the codes its name ends with", () => {
    const cases: Array<[string, boolean]> = [
      ["1786/Film.2026.IMAX.1080p.BluRay.DTS5.1.ESub.HEVC-TEAM-ar.srt", true],
      // One code: an upload in English, so its English file is the upload.
      ["1786/Film.2026.IMAX.1080p.BluRay.DTS5.1.ESub.HEVC-TEAM-en.srt", false],
      ["1786/Film.2026.IMAX.1080p.BluRay.DTS5.1.ESub.HEVC-TEAM-orig.srt", false],
      // Two codes: the upload's language, then the file's.
      ["1744/Film (2026) The Making Of (1080p-720p) WEBRip (TEAM)-nl-ar.srt", true],
      ["9/Film-por-ar.srt", true],
      ["9/Film-nl-en.srt", true],
      ["886/Show - S01E10 - Name.sd-en-en.srt", false],
      ["831/Show.S01E05.Name.1080p.AMZN.WEB-DL.DDP5.1.H.264-TEAM.sdh.eng-en.srt", false],
      ["847/Show.S01E07.Name.1080p.AMZN.WEB-DL.DDP5.1.H.264-TEAM.sdh.eng-nl.srt", true],
      // "DL" of "WEB-DL" is no language.
      ["9/Film.2026.WEB-DL-en.srt", false],
      ["9/Film.2026.WEB-DL-ar.srt", true],
      ["1429/Show.S01E03.WEB.x264-TEAMGALAXY-en.srt", false],
      // Not Subtitle Cat's form: another source's id.
      ["1705/Show - S01E05.Arabic.srt", false],
      ["1962752273", false],
      ["tv/86031/3/4/English2.vtt", false]
    ];
    for (const [id, machine] of cases) expect(subtitleCatTranslation(id), id).toBe(machine);
  });
});
