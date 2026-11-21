import { describe, expect, it } from "vitest";
import { nameFits, notWrittenIn, parsePage, parseSearch, releaseForm, searches, writtenIn } from "../src/subtitlecat.js";
import type { StremioSubtitleRequest } from "../src/types.js";

const episode = (season: number, ep: number, absoluteEpisode?: number): StremioSubtitleRequest => ({ type: "series", id: `tt1:${season}:${ep}`, imdbId: "tt1", season, episode: ep, absoluteEpisode });
const film: StremioSubtitleRequest = { type: "movie", id: "tt2", imdbId: "tt2" };

const SEARCH = `<tbody> <tr> <td><a href="subs/101/Show_S2_17%2833%29.html">Show_S2_17(33)</a> (translated from English)</td>
<td class="sub-table__stars">&nbsp;</td></tr>
<tr> <td><a href="subs/101/Show_S2_01%2817%29.html">Show_S2_01(17)</a> (translated from English)</td><td></td></tr>
<tr> <td><a href="subs/12/Tom%20%26%20Jerry.html">Tom &amp; Jerry</a></td><td></td></tr></tbody>`;

const PAGE = `<div class="sub-single"> <span>Afrikaans</span> <span><button id="af" onclick="translate_from_server_folder('af', 'Show_S2_17(33)-orig.srt', '/subs/101/')" class="yellow-link">Translate</button></span> </div>
<div class="sub-single"> <span><img src="/assets/flags/ae.png" alt="ar" class="flag"></span> <span>Arabic</span> <span><a id="download_ar" onclick="log_download(1000001); show_voting('ar');" href="/subs/101/Show_S2_17(33)-ar.srt" class="green-link">Download</a></span></div>
<div class="sub-single"> <span>English</span> <span><a id="download_en" onclick="log_download(1000002);" href="/subs/102/Show_S2_17(33)-en.srt" class="green-link">Download</a></span></div>
<div class="sub-single"> <span>Chinese</span> <span><a id="download_zh-CN" href="/subs/103/Show_S2_17(33)-zh-CN.srt" class="green-link">Download</a></span></div>`;

describe("Subtitle Cat's pages", () => {
  it("reads the uploads off a search page, with the language each was uploaded in", () => {
    expect(parseSearch(SEARCH)).toEqual([
      { page: "subs/101/Show_S2_17%2833%29.html", name: "Show_S2_17(33)", from: "english" },
      { page: "subs/101/Show_S2_01%2817%29.html", name: "Show_S2_01(17)", from: "english" },
      { page: "subs/12/Tom%20%26%20Jerry.html", name: "Tom & Jerry" }
    ]);
    expect(parseSearch("<html>nothing here</html>")).toEqual([]);
  });

  it("reads the upload and its translations off an upload's page", () => {
    expect(parsePage(PAGE)).toEqual({
      original: "/subs/101/Show_S2_17(33)-orig.srt",
      files: [
        { code: "ar", path: "/subs/101/Show_S2_17(33)-ar.srt" },
        { code: "en", path: "/subs/102/Show_S2_17(33)-en.srt" },
        { code: "zh-CN", path: "/subs/103/Show_S2_17(33)-zh-CN.srt" }
      ]
    });
    expect(parsePage("<html></html>")).toEqual({ files: [] });
  });

  it("asks for the title with the episode number, the number across the show, and SxxEyy", () => {
    expect(searches("The Show", episode(2, 17, 33))).toEqual(["show 17", "show 33", "show S02E17"]);
    expect(searches("Two Words", episode(1, 141, 141))).toEqual(["two words 141", "two words S01E141"]);
    expect(searches("Film of the Day", film, 2026)).toEqual(["film of the day 2026", "film of the day"]);
  });
});

describe("whether a file is in the language it is listed under", () => {
  const srt = (lines: string[]) => lines.map((l, i) => `${i + 1}
00:0${i % 6}:${String(10 + (i % 40))},000 --> 00:0${i % 6}:${String(12 + (i % 40))},000
${l}
`).join("\n");
  const many = (lines: string[]) => srt(Array.from({ length: 60 }, (_, i) => lines[i % lines.length]));
  const english = many(["If you pull out the sword", "I'll be free", "What are you doing here?", "We have to go now, it is not safe", "Do you think this is a game?", "He was my friend"]);
  const dutch = many(["Jij weet het niet?", "Ik wist wie er in Langley bij de debriefing was.", "Nou, het zal niet de president zijn.", "Wat doe je hier?", "We moeten nu gaan, het is niet veilig", "Hij was mijn vriend"]);
  const chinese = many(["你在这里做什么", "我们现在必须走", "这不是游戏", "他是我的朋友", "如果你拔出剑", "我就自由了"]);
  const arabic = many(["إذا أخرجت السيف", "سأكون حرا", "ماذا تفعل هنا؟", "علينا أن نذهب الآن", "هل تظن أن هذه لعبة؟", "كان صديقي"]);
  const indonesian = many(["Apa yang kamu lakukan di sini?", "Kita harus pergi sekarang", "Ini bukan permainan", "Dia adalah temanku", "Jika kamu mencabut pedang itu", "Aku akan bebas"]);

  it("knows each by its writing and its commonest words", () => {
    expect(writtenIn(english, "english")).toBe(true);
    expect(writtenIn(dutch, "dutch")).toBe(true);
    expect(writtenIn(arabic, "arabic")).toBe(true);
    expect(writtenIn(chinese, "chinese")).toBe(true);
    expect(writtenIn(indonesian, "indonesian")).toBe(true);
  });

  it("refuses a file listed under another language", () => {
    expect(writtenIn(chinese, "english")).toBe(false);
    expect(writtenIn(arabic, "english")).toBe(false);
    expect(writtenIn(english, "arabic")).toBe(false);
    expect(writtenIn(dutch, "english")).toBe(false);
    expect(writtenIn(english, "dutch")).toBe(false);
    expect(writtenIn(indonesian, "english")).toBe(false);
    expect(writtenIn(srt(["Hello there"]), "english")).toBe(false);
  });

  const german = many(["Was machst du hier?", "Wir müssen jetzt gehen, es ist nicht sicher", "Das ist kein Spiel", "Er war mein Freund", "Wenn du das Schwert ziehst", "Ich bin dann frei"]);
  const serbianLatin = many(["Šta radiš ovde?", "Moramo da idemo sada", "Ovo nije igra", "Bio je moj prijatelj", "Ako izvučeš mač", "Biću slobodan"]);

  it("for any source, refuses only a file surely in another language", () => {
    expect(notWrittenIn(german, "dutch")).toBe(true);
    expect(notWrittenIn(chinese, "english")).toBe(true);
    expect(notWrittenIn(english, "arabic")).toBe(true);
    expect(notWrittenIn(german, "english")).toBe(true);
    for (const [text, language] of [[english, "english"], [dutch, "dutch"], [arabic, "arabic"], [german, "german"], [indonesian, "indonesian"]] as const) {
      expect(notWrittenIn(text, language)).toBe(false);
    }
  });

  it("judges an ASS script by its spoken lines, not its drawn, placed or sung signs", () => {
    const spoken = ["If you pull out the sword", "I'll be free", "What are you doing here?", "We have to go now, it is not safe", "Do you think this is a game?", "He was my friend"];
    const events = Array.from({ length: 60 }, (_, i) => `Dialogue: 0,0:00:${String(i % 60).padStart(2, "0")}.00,0:00:${String(i % 60).padStart(2, "0")}.50,Default,,0,0,0,,${spoken[i % spoken.length]}`);
    const signs = Array.from({ length: 900 }, (_, i) => [`Dialogue: 0,0:01:00.00,0:01:00.04,Sign,,0,0,0,,{\\pos(${i},200)\\p1}m 0 0 l 188 0 l 188 70 l 0 70`, `Dialogue: 0,0:01:00.00,0:01:00.04,Sign,,0,0,0,,{\\move(1,2,3,4)}看板`, `Dialogue: 0,0:01:30.00,0:01:31.00,OP,,0,0,0,,{\\k20}ha{\\k30}ru`][i % 3]);
    const script = ["[Script Info]", "ScriptType: v4.00+", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, ...signs].join("\n");
    expect(notWrittenIn(script, "english")).toBe(false);
  });

  it("lets through what it can't be sure of: little text, two-script languages, languages it can't judge", () => {
    expect(notWrittenIn(srt(["你好"]), "english")).toBe(false);
    expect(notWrittenIn(serbianLatin, "serbian")).toBe(false);
    expect(notWrittenIn(english, "tamil")).toBe(false);
    expect(notWrittenIn(german, "English Dub")).toBe(true);
  });

  it("keeps a subtitle with some lines in another language: a song, a phone call, a second language spoken", () => {
    const mixed = (own: string[], other: string[], everyNth: number) => srt(Array.from({ length: 60 }, (_, i) => (i % everyNth === 0 ? other[i % other.length] : own[i % own.length])));
    const englishLines = ["If you pull out the sword", "I'll be free", "What are you doing here?", "We have to go now, it is not safe", "Do you think this is a game?", "He was my friend"];
    const germanLines = ["Was machst du hier?", "Wir müssen jetzt gehen", "Das ist kein Spiel"];
    const arabicLines = ["إذا أخرجت السيف", "سأكون حرا", "ماذا تفعل هنا؟", "علينا أن نذهب الآن"];
    // A third of the lines in German, or every other line in English beside the Arabic: kept.
    expect(notWrittenIn(mixed(englishLines, germanLines, 3), "english")).toBe(false);
    expect(notWrittenIn(mixed(arabicLines, englishLines, 2), "arabic")).toBe(false);
    expect(notWrittenIn(mixed(englishLines, arabicLines, 2), "english")).toBe(false);
  });

  it("reads an ASS file's dialogue, not its styles", () => {
    const lines = ["إذا أخرجت السيف", "سأكون حرا", "ماذا تفعل هنا؟", "علينا أن نذهب الآن"];
    const ass = [
      "[Script Info]", "Title: Default Aegisub file", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "",
      "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV",
      ...Array.from({ length: 12 }, (_, i) => `Style: Default${i},Arial Bold Condensed Narrow,60,&H00FFFFFF,0,0,2,10,10,10`), "",
      "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...Array.from({ length: 30 }, (_, i) => `Dialogue: 0,0:00:${String(10 + i).padStart(2, "0")}.00,0:00:${String(11 + i).padStart(2, "0")}.00,Default0,,0,0,0,,{\\i1}${lines[i % 4]}{\\i0}`)
    ].join("\n");
    expect(notWrittenIn(ass, "arabic")).toBe(false);
    expect(writtenIn(ass, "arabic")).toBe(true);
  });
});

describe("whether an upload's name is the title and episode asked for", () => {
  it("spells the season-then-number forms as SxxEyy", () => {
    expect(releaseForm("Show_S2_17(33)")).toBe("Show S2E17 33");
    expect(releaseForm("S01 EP02 - The Long Name of a Show [720p] @uploader")).toBe("S01E2 - The Long Name of a Show");
    expect(releaseForm("[SubtitleTools.com] climb across  the mountains S02 E002-en")).toBe("climb across the mountains S02E2-en");
    expect(releaseForm("subsite.com. Another Long Show EP 9 Eng Sub 1080p.eng")).toBe("Another Long Show EP 9 Eng Sub 1080p eng");
  });

  it("takes the episode, by its season and number or by its number across the show", () => {
    expect(nameFits("Show_S2_17(33)", "The Show", episode(2, 17, 33))).toBe(true);
    expect(nameFits("[Group] Show_S4_12(70)_4K", "The Show", episode(4, 12, 70))).toBe(true);
    expect(nameFits("Two Words 141", "Two Words", episode(1, 141, 141))).toBe(true);
    expect(nameFits("S01 EP02 - The Long Name of a Show [720p] @uploader", "The Long Name of a Show", episode(1, 2))).toBe(true);
    expect(nameFits("[SubtitleTools.com] climb across  the mountains S02 E002-en", "Climb Across the Mountains", episode(2, 2, 14))).toBe(true);
    expect(nameFits("subsite.com. Another Long Show EP 9 Eng Sub 1080p.eng", "Another Long Show", episode(1, 9))).toBe(true);
  });

  it("refuses another episode, however its numbers read", () => {
    // Season 2's first episode, the show's 17th: not season 2's 17th.
    expect(nameFits("Show_S2_01(17)", "The Show", episode(2, 17, 33))).toBe(false);
    expect(nameFits("Show_S3_17(55)", "The Show", episode(2, 17, 33))).toBe(false);
    expect(nameFits("Two Words 141", "Two Words", episode(1, 14, 14))).toBe(false);
    // "Episode 9" decides, not the 2 at the end.
    expect(nameFits("The Long Name of a Show Episode 9 No Sub 2", "The Long Name of a Show", episode(1, 2))).toBe(false);
    expect(nameFits("The Long Name of a Show Episode 9 No Sub 2", "The Long Name of a Show", episode(1, 9))).toBe(true);
    expect(nameFits("Show Season 4 Episode 12", "The Show", episode(4, 12, 70))).toBe(true);
    expect(nameFits("Show Season 4 Episode 12", "The Show", episode(2, 12, 28))).toBe(false);
    expect(nameFits("Show Episode 70", "The Show", episode(4, 12, 70))).toBe(true);
  });

  it("refuses another title that shares the words", () => {
    expect(nameFits("Show Girl S02E17", "Show", episode(2, 17))).toBe(false);
    expect(nameFits("Show the Women.1951.DVDRip.x264-GRP", "The Show", episode(2, 17, 33))).toBe(false);
    expect(nameFits("Show Ho the Wagons! (1956)", "The Show", episode(2, 17, 33))).toBe(false);
    expect(nameFits("Some Author - Endless Sky Side Story.zh", "Endless Sky", episode(1, 1))).toBe(false);
    expect(nameFits("The New Endless Sky 01", "Endless Sky", episode(1, 1))).toBe(false);
    expect(nameFits("Something Else S02E17", "The Show", episode(2, 17))).toBe(false);
    // A number after the title is part of another title.
    expect(nameFits("Show 2- The Next Chapter Episode 100", "Show", episode(1, 100, 100))).toBe(false);
    expect(nameFits("Show 2 The Next Clan EP163 Streaming Guide", "Show", episode(1, 163, 163))).toBe(false);
  });

  it("takes a film by its title, and its year when the name gives one", () => {
    expect(nameFits("Film.of.the.Day.2026.1080p.WEB-DL", "Film of the Day", film, 2026)).toBe(true);
    expect(nameFits("Film of the Day", "Film of the Day", film, 2026)).toBe(true);
    expect(nameFits("Film of the Day (1998) DVDRip", "Film of the Day", film, 2026)).toBe(false);
    expect(nameFits("Film of the Day Within 2026", "Film of the Day", film, 2026)).toBe(false);
    expect(nameFits("Show the Women.1951.DVDRip.x264-GRP", "Show", film, 2020)).toBe(false);
  });
});
