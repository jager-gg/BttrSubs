/**
 * Signs & songs with English Dub (signs.ts, signsjob.ts, animetosho.ts signsOf): a release's signs
 * moved onto the file by its dialogue's sync, merged with the dub's lines with one copy of each sign
 * and song, and the dub's lines in the playing file's own subtitle style.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMkvTracks } from "../src/mkv.js";
import { dialogueStyleOf, DUB_STYLE, dubLines, dubStyle, MAYBE_SONG, mergeWithSigns, ownStyleOf, parseScript, playRes, signsOfFull, signsOnly, STYLE_FORMAT, writeScript } from "../src/signs.js";
import { movesBy, startsInOrder } from "../src/signsjob.js";
import { signsOf, videoSource } from "../src/animetosho.js";
import { ASS_HEADER, release } from "./mkvfile.js";

const signsTrack = (events: string[], info = ["PlayResX: 1920", "PlayResY: 1080"]) =>
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    ...info,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Sign,Gandhi Sans,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,8,20,20,40,1",
    "Style: OP-Romaji,Gandhi Sans,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,20,20,30,1",
    "Style: Warning,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,20,20,30,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
    "[Fonts]",
    "fontname: gandhi.ttf",
    "M2*<SOMEDATA",
    ""
  ].join("\r\n");

const srt = (cues: Array<[string, string, string]>) => cues.map(([a, b, text], i) => `${i + 1}\n${a} --> ${b}\n${text}\n`).join("\n");

describe("signs too heavy to send", () => {
  it("go by whole styles, the songs' first, until the script fits; the dub's lines always stay", async () => {
    const { mergeWithSigns, parseScript } = await import("../src/signs.js");
    const event = (style: string, at: number, text: string) => `Dialogue: 0,0:00:${String(at % 60).padStart(2, "0")}.00,0:00:${String((at % 60) + 1).padStart(2, "0")}.00,${style},,0,0,0,,${text}`;
    const heavy = "{\\pos(100,100)}" + "x".repeat(400);
    const script = [
      "[Script Info]", "PlayResX: 1920", "PlayResY: 1080", "",
      "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      ...["Signs", "OP", "ED"].map((name) => `Style: ${name},Arial,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1`), "",
      "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...Array.from({ length: 20 }, (_, i) => event("Signs", i, `{\\pos(100,100)}SIGN ${i}`)),
      ...Array.from({ length: 300 }, (_, i) => event("OP", i, heavy)),
      ...Array.from({ length: 100 }, (_, i) => event("ED", i, heavy))
    ].join("\n");
    const dub = "1\n00:00:01,000 --> 00:00:02,000\nA line the dub speaks.\n\n2\n00:00:03,000 --> 00:00:04,000\nAnother one.\n";
    const signs = parseScript(script)!;
    const whole = mergeWithSigns({ dub, ext: ".srt", signs });
    expect(whole.dropped.heavy).toBeUndefined();
    expect(Buffer.byteLength(whole.text)).toBeGreaterThan(150_000);
    // Room for the signs and one of the two songs: the heavier song goes, whole.
    const fitted = mergeWithSigns({ dub, ext: ".srt", signs, maxBytes: 80_000 });
    expect(Buffer.byteLength(fitted.text)).toBeLessThan(80_000);
    expect(fitted.dropped.heavy).toBe(300);
    const styles = fitted.text.split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => l.split(",")[3]);
    expect(styles.filter((s) => s === "OP")).toHaveLength(0);
    expect(styles.filter((s) => s === "ED")).toHaveLength(100);
    expect(styles.filter((s) => s === "Signs")).toHaveLength(20);
    expect(fitted.text).toContain("A line the dub speaks.");
    // No room for any of it: every style goes, and the dub's two lines are still there.
    const bare = mergeWithSigns({ dub, ext: ".srt", signs, maxBytes: 9_000 });
    expect(bare.dropped.heavy).toBe(420);
    expect(bare.text).toContain("Another one.");
  });
});

describe("a song too heavy to send", () => {
  const head = (styles: string[]) => [
    "[Script Info]", "PlayResX: 1920", "PlayResY: 1080", "",
    "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles.map((name) => `Style: ${name},Arial,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1`), "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const at = (cs: number) => `0:00:${String(Math.floor(cs / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
  const event = (style: string, from: number, to: number, text: string, layer = 0) => `Dialogue: ${layer},${at(from)},${at(to)},${style},,0,0,0,fx,${text}`;
  const dub = "1\n00:00:50,000 --> 00:00:51,000\nA line the dub speaks.\n";
  // A line set a copy a frame, each of its letters an event of its own, and shapes drawn around them.
  const effect = (style: string, from: number, line: string) => [
    ...Array.from({ length: 40 }, (_, i) => event(style, from + i * 5, from + i * 5 + 5, `{\\an8\\pos(960,${60 + i})\\blur3\\t(0,200,\\fscx120)}${line}`, 1)),
    ...[...line.replace(/ /g, "")].map((letter, i) => event(style, from, from + 200, `{\\pos(${400 + i * 30},60)\\blur2}${letter}`, 2)),
    ...Array.from({ length: 30 }, (_, i) => event(style, from + i * 6, from + i * 6 + 20, `{\\pos(900,80)\\p1}m 0 0 l ${"10 10 20 0 ".repeat(40)}{\\p0}`, 3))
  ];

  it("keeps its lyric lines, one event a line for the time it is on screen, without the effects", async () => {
    const { mergeWithSigns, parseScript } = await import("../src/signs.js");
    const script = [
      ...head(["Signs", "OP"]),
      ...Array.from({ length: 10 }, (_, i) => event("Signs", 3000 + i * 100, 3100 + i * 100, `{\\pos(100,100)}SIGN ${i}`)),
      ...effect("OP", 100, "The first line of a song"),
      ...effect("OP", 400, "And then a second line"),
      // Sung again later: the line shows a second time.
      ...effect("OP", 1500, "The first line of a song")
    ].join("\n");
    const signs = parseScript(script)!;
    expect(mergeWithSigns({ dub, ext: ".srt", signs }).dropped.plained).toBeUndefined();
    const fitted = mergeWithSigns({ dub, ext: ".srt", signs, maxBytes: 12_000 });
    expect(Buffer.byteLength(fitted.text)).toBeLessThan(12_000);
    expect(fitted.dropped.heavy).toBeUndefined();
    expect(fitted.dropped.plained).toBe(2 * (40 + 19 + 30) + (40 + 18 + 30));
    const song = fitted.text.split("\n").filter((l) => l.startsWith("Dialogue:") && l.split(",")[3] === "OP");
    expect(song).toEqual([
      "Dialogue: 0,0:00:01.00,0:00:03.00,OP,,0,0,0,,{\\an8}The first line of a song",
      "Dialogue: 0,0:00:04.00,0:00:06.00,OP,,0,0,0,,{\\an8}And then a second line",
      "Dialogue: 0,0:00:15.00,0:00:17.00,OP,,0,0,0,,{\\an8}The first line of a song"
    ]);
    expect(fitted.text.split("\n").filter((l) => l.split(",")[3] === "Signs")).toHaveLength(10);
    expect(fitted.text).toContain("A line the dub speaks.");
  });

  it("sits where most of a line's copies sit, outlined when its style has no outline, and keeps a long word sung alone", async () => {
    const { mergeWithSigns, parseScript } = await import("../src/signs.js");
    const copies = (from: number, line: string) => Array.from({ length: 40 }, (_, i) => event("OP", from + i * 5, from + i * 5 + 5, `{\\an5\\pos(960,1005)\\blur3\\t(0,200,\\fscx120)${"\\be1".repeat(20)}}${line}`, 1));
    const script = [
      ...head(["OP"]).map((l) => (l.startsWith("Style: OP,") ? l.replace(",1,2,1,2,10,10,10,1", ",1,0,0,2,10,10,10,1") : l)),
      ...copies(100, "The first line of a song"),
      ...copies(400, "Everlasting"),
      ...copies(700, "And then a third line"),
      // Short words set on their own are part of an effect, not lines.
      ...Array.from({ length: 40 }, (_, i) => event("OP", 100 + i * 5, 105 + i * 5, `{\\pos(${i},9)${"\\be1".repeat(20)}}song`, 2))
    ].join("\n");
    const fitted = mergeWithSigns({ dub, ext: ".srt", signs: parseScript(script)!, maxBytes: 9_500 });
    const song = fitted.text.split("\n").filter((l) => l.startsWith("Dialogue:") && l.split(",")[3] === "OP").map((l) => l.split(",").slice(9).join(","));
    // Placed by its middle near the bottom: anchored by its bottom edge, half its 50 height lower, so a wrapped line grows upwards.
    expect(song).toEqual(["{\\an2\\pos(960,1030)\\bord3}The first line of a song", "{\\an2\\pos(960,1030)\\bord3}Everlasting", "{\\an2\\pos(960,1030)\\bord3}And then a third line"]);
    const top = mergeWithSigns({ dub, ext: ".srt", signs: parseScript(script.replace(/pos\(960,1005\)/g, "pos(960,65)"))!, maxBytes: 9_500 });
    expect(top.text).toContain("{\\an8\\pos(960,40)\\bord3}Everlasting");
    const middle = mergeWithSigns({ dub, ext: ".srt", signs: parseScript(script.replace(/pos\(960,1005\)/g, "pos(960,540)"))!, maxBytes: 9_500 });
    expect(middle.text).toContain("{\\an5\\pos(960,540)\\bord3}Everlasting");
  });

  it("takes the colour of the effect's glow for its outline, softened", async () => {
    const { mergeWithSigns, parseScript } = await import("../src/signs.js");
    const copies = (from: number, line: string) => Array.from({ length: 40 }, (_, i) => event("OP", from + i * 5, from + i * 5 + 5, `{\\an5\\c&HFFFFFF&\\bord0\\pos(960,540)\\4c&H${i < 30 ? "8b7b5b" : "FFFFFF"}&\\bord10\\blur10\\t(0,80,\\4c&H000000&${"\\be1".repeat(20)}}${line}`, 1));
    const script = [...head(["OP"]).map((l) => (l.startsWith("Style: OP,") ? l.replace(",1,2,1,2,10,10,10,1", ",1,0,0,2,10,10,10,1") : l)), ...copies(100, "The first line of a song"), ...copies(400, "And then a second line")].join("\n");
    const fitted = mergeWithSigns({ dub, ext: ".srt", signs: parseScript(script)!, maxBytes: 9_500 });
    expect(fitted.text).toContain("{\\an5\\pos(960,540)\\3c&H8B7B5B&\\bord3\\blur2}The first line of a song");
  });

  it("goes in a font most players have, of the kind the song's font is by its name", async () => {
    const { mergeWithSigns, parseScript } = await import("../src/signs.js");
    const copies = (from: number, line: string) => Array.from({ length: 40 }, (_, i) => event("OP", from + i * 5, from + i * 5 + 5, `{\\pos(960,540)${"\\be1".repeat(25)}}${line}`, 1));
    const made = (font: string) => {
      const script = [...head(["OP"]).map((l) => l.replace("Style: OP,Arial,", `Style: OP,${font},`)), ...copies(100, "The first line of a song"), ...copies(400, "And then a second line")].join("\n");
      const text = mergeWithSigns({ dub, ext: ".srt", signs: parseScript(script)!, maxBytes: 9_500 }).text;
      return text.split("\n").find((l) => l.endsWith("The first line of a song"))?.split(",").slice(9).join(",");
    };
    expect(made("Some Mincho ExtraBold")).toBe("{\\pos(960,540)\\fnGeorgia\\b1}The first line of a song");
    expect(made("Another Sans")).toBe("{\\pos(960,540)\\fnTrebuchet MS}The first line of a song");
    // A font most players have stays, and so does a name that tells neither kind.
    expect(made("Verdana")).toBe("{\\pos(960,540)}The first line of a song");
    expect(made("Qwertyish")).toBe("{\\pos(960,540)}The first line of a song");
  });

  it("goes whole when it is set letter by letter only, with no whole line to keep", async () => {
    const { mergeWithSigns, parseScript } = await import("../src/signs.js");
    const letters = Array.from({ length: 200 }, (_, i) => event("OP", 100 + i, 300 + i, `{\\pos(${i * 9},60)\\blur2\\t(0,200,\\fscx120)}${"abcdefgh"[i % 8]}`));
    const signs = parseScript([...head(["OP"]), ...letters].join("\n"))!;
    const fitted = mergeWithSigns({ dub, ext: ".srt", signs, maxBytes: 10_000 });
    expect(fitted.dropped).toMatchObject({ heavy: 200 });
    expect(fitted.dropped.plained).toBeUndefined();
    expect(fitted.text).toContain("A line the dub speaks.");
  });

  it("keeps a line written in a script without spaces, and one line where a longer one holds a shorter one's words", async () => {
    const { mergeWithSigns, parseScript } = await import("../src/signs.js");
    const pad = `{\\pos(1,1)\\t(0,200,\\fscx120)${"\\blur2".repeat(30)}}`;
    const script = [
      ...head(["ED"]),
      ...Array.from({ length: 30 }, (_, i) => event("ED", 100 + i * 5, 105 + i * 5, `${pad}\u6b4c\u306e\u6700\u521d\u306e\u884c`)),
      ...Array.from({ length: 30 }, (_, i) => event("ED", 400 + i * 5, 405 + i * 5, `${pad}A line being`)),
      ...Array.from({ length: 30 }, (_, i) => event("ED", 400 + i * 5, 405 + i * 5, `${pad}A line being written out`))
    ].join("\n");
    const fitted = mergeWithSigns({ dub, ext: ".srt", signs: parseScript(script)!, maxBytes: 10_000 });
    const song = fitted.text.split("\n").filter((l) => l.startsWith("Dialogue:") && l.split(",")[3] === "ED").map((l) => l.split(",").slice(9).join(","));
    expect(song).toEqual(["{\\pos(1,1)}\u6b4c\u306e\u6700\u521d\u306e\u884c", "{\\pos(1,1)}A line being written out"]);
  });
});

describe("an ASS script by section", () => {
  it("keeps its info, styles and events, leaves its fonts out, and writes back what it read", () => {
    const script = parseScript(signsTrack(["Dialogue: 0,0:00:05.00,0:00:07.00,Sign,,0,0,0,,{\\pos(960,200)}SHOP, OPEN"]))!;
    expect(script.styles.map((s) => s[0])).toEqual(["Sign", "OP-Romaji", "Warning"]);
    expect(script.events[0].values.at(-1)).toBe("{\\pos(960,200)}SHOP, OPEN");
    const again = writeScript(script);
    expect(again).not.toContain("[Fonts]");
    expect(parseScript(again)).toEqual(script);
  });

  it("isn't read from an SSA v4 script, whose styles and alignments differ", () => {
    expect(parseScript("[Script Info]\nScriptType: v4.00\n\n[V4 Styles]\nFormat: Name\nStyle: Default\n\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")).toBeUndefined();
  });

  it("is drawn on its canvas, or 384x288 when it names none", () => {
    expect(playRes(parseScript(signsTrack([]))!)).toEqual({ x: 1920, y: 1080 });
    expect(playRes(parseScript(signsTrack([], ["PlayResY: 720"]))!)).toEqual({ x: 960, y: 720 });
    expect(playRes(parseScript(signsTrack([], []))!)).toEqual({ x: 384, y: 288 });
  });
});

describe("the dub's lines", () => {
  it("keep their placement and italics and lose every other tag, from SRT and ASS", () => {
    const lines = dubLines(srt([["00:00:01,000", "00:00:02,500", "{\\an8}<i>Hello</i> there."], ["00:00:03,000", "00:00:04,000", "Bye."]]), ".srt");
    expect(lines.map((l) => [l.start, l.end, l.text, l.placed])).toEqual([[1000, 2500, "{\\an8}{\\i1}Hello{\\i0} there.", true], [3000, 4000, "Bye.", false]]);
    const ass = dubLines(signsTrack(["Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\fad(100,100)\\an8}Up here", "Dialogue: 0,0:00:03.00,0:00:04.00,Sign,,0,0,0,,{\\pos(10,10)}A SIGN"]), ".ass");
    expect(ass.map((l) => [l.text, l.placed, l.sign])).toEqual([["{\\an8}Up here", true, false], ["A SIGN", false, true]]);
  });
});

describe("signs merged with English Dub", () => {
  const signs = parseScript(
    signsTrack([
      "Dialogue: 0,0:00:10.00,0:00:13.00,Sign,,0,0,0,,{\\pos(960,120)}GUILD HALL EAST WING",
      "Dialogue: 0,0:01:00.00,0:01:04.00,OP-Romaji,,0,0,0,,{\\k20}Ha{\\k30}ru",
      "Dialogue: 0,0:01:05.00,0:01:08.00,OP-Romaji,,0,0,0,,{\\k20}Na{\\k30}tsu",
      "Dialogue: 0,0:00:20.00,0:00:22.00,Warning,,0,0,0,,Your player can't show this",
      "Comment: 0,0:00:30.00,0:00:31.00,Sign,,0,0,0,,a note"
    ])
  )!;

  it("keeps the signs as typeset and adds the dub's lines in a style of their own, sized for the signs' canvas", () => {
    const dub = srt([["00:00:15,000", "00:00:17,000", "We're home."]]);
    const { text } = mergeWithSigns({ dub, ext: ".srt", signs });
    const out = parseScript(text)!;
    expect(out.events.map((e) => e.values[3])).toEqual(["Sign", "OP-Romaji", "OP-Romaji", DUB_STYLE]);
    const style = out.styles.find((s) => s[0] === DUB_STYLE)!;
    // The plain look (Arial 20 on a 288 canvas), on 1080: 75.
    expect(style[STYLE_FORMAT.indexOf("Fontsize")]).toBe("75");
    expect(style[STYLE_FORMAT.indexOf("Alignment")]).toBe("2");
    expect(out.events.at(-1)!.values.slice(1, 3)).toEqual(["0:00:15.00", "0:00:17.00"]);
  });

  it("leaves out the dub's own written-out sign, placed or in capitals, and keeps its dialogue over the sign", () => {
    const dub = srt([
      ["00:00:10,500", "00:00:12,500", "{\\an8}GUILD HALL'S EAST WING"],
      ["00:00:11,000", "00:00:12,000", "GUILD HALL EAST WING"],
      ["00:00:11,000", "00:00:12,800", "So this is the place."],
      ["00:00:12,000", "00:00:12,900", "STOP!"]
    ]);
    const { text, dropped } = mergeWithSigns({ dub, ext: ".srt", signs });
    const kept = parseScript(text)!.events.filter((e) => e.values[3] === DUB_STYLE).map((e) => e.values.at(-1));
    expect(kept).toEqual(["So this is the place.", "STOP!"]);
    expect(dropped.dubSigns).toBe(2);
  });

  it("keeps the release's song lines and drops the dub's placeholders where the dub doesn't sing words of its own", () => {
    const dub = srt([["00:01:00,500", "00:01:07,000", "♪ ♪"], ["00:01:09,000", "00:01:10,000", "Let's go."]]);
    const { text, dropped } = mergeWithSigns({ dub, ext: ".srt", signs });
    const events = parseScript(text)!.events;
    expect(events.filter((e) => e.values[3] === "OP-Romaji")).toHaveLength(2);
    expect(events.filter((e) => e.values[3] === DUB_STYLE).map((e) => e.values.at(-1))).toEqual(["Let's go."]);
    expect(dropped).toMatchObject({ dubSongs: 1, songs: 0 });
  });

  it("drops the release's song lines where the dub sings the song itself", () => {
    const dub = srt([["00:01:00,500", "00:01:04,000", "♪ Running through the rain tonight ♪"], ["00:01:05,000", "00:01:08,000", "♪ Under a silver moon again ♪"]]);
    const { text, dropped } = mergeWithSigns({ dub, ext: ".srt", signs });
    const events = parseScript(text)!.events;
    expect(events.filter((e) => e.values[3] === "OP-Romaji")).toHaveLength(0);
    expect(events.filter((e) => e.values[3] === DUB_STYLE)).toHaveLength(2);
    expect(dropped.songs).toBe(2);
  });

  it("leaves out the dub script's own sign events: the release's take their place", () => {
    const dub = signsTrack(["Dialogue: 0,0:00:40.00,0:00:42.00,Sign,,0,0,0,,{\\pos(5,5)}DUB SIGN", "Dialogue: 0,0:00:43.00,0:00:44.00,Default,,0,0,0,,Words."]);
    const kept = parseScript(mergeWithSigns({ dub, ext: ".ass", signs }).text)!.events.filter((e) => e.values[3] === DUB_STYLE).map((e) => e.values.at(-1));
    expect(kept).toEqual(["Words."]);
  });

  it("raises the dub's lines with a style's height and keeps a line placed at the top where it was", () => {
    const dub = srt([["00:00:01,000", "00:00:02,000", "Low."], ["00:00:03,000", "00:00:04,000", "{\\an8}High."]]);
    const out = parseScript(mergeWithSigns({ dub, ext: ".srt", signs, raise: 20 }).text)!;
    expect(out.styles.find((s) => s[0] === DUB_STYLE)![STYLE_FORMAT.indexOf("MarginV")]).toBe("216");
    const marginV = out.eventFormat.indexOf("MarginV");
    expect(out.events.filter((e) => e.values[3] === DUB_STYLE).map((e) => e.values[marginV])).toEqual(["0", "45"]);
  });
});

describe("the playing file's own subtitle style", () => {
  const header = (name: string, styles: string[], playRes = ["PlayResX: 1280", "PlayResY: 720"]) => ({
    type: "subtitle",
    language: "eng",
    name,
    forced: false,
    default: true,
    assHeader: ["[Script Info]", ...playRes, "", "[V4+ Styles]", `Format: ${STYLE_FORMAT.join(", ")}`, ...styles, "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"].join("\n")
  });
  const row = (name: string, font: string, size: number, alignment = 2) => `Style: ${name},${font},${size},&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,2.5,1,${alignment},60,60,36,1`;

  it("is its dialogue track's dialogue style, not a sign's, and not the signs track's", () => {
    const own = ownStyleOf([
      { ...header("Signs & Songs", [row("Default", "Sign Font", 70)]), forced: true },
      header("Full Subtitles", [row("Sign-Title", "Fancy", 90, 8), row("Main", "Gandhi Sans", 48)])
    ])!;
    expect(own).toMatchObject({ playResX: 1280, playResY: 720 });
    expect(own.style).toMatchObject({ name: "Main", fontname: "Gandhi Sans", fontsize: "48", bold: "-1" });
  });

  it("styles the dub's lines scaled to the script they are in", () => {
    const own = ownStyleOf([header("English", [row("Default", "Gandhi Sans", 48)])])!;
    const values = dubStyle(STYLE_FORMAT, 1080, { own });
    const v = (f: string) => values[STYLE_FORMAT.indexOf(f)];
    expect([v("Name"), v("Fontname"), v("Fontsize"), v("Outline"), v("MarginV"), v("Bold")]).toEqual([DUB_STYLE, "Gandhi Sans", "72", "3.8", "54", "-1"]);
  });

  it("is none for a file whose subtitles have no ASS header", () => {
    expect(ownStyleOf([{ type: "subtitle", language: "eng", name: "English", forced: false, default: true }])).toBeUndefined();
  });

  it("styles the dub's lines alone, with no signs, on the file's own canvas", () => {
    const own = ownStyleOf([header("English", [row("Default", "Gandhi Sans", 48)])])!;
    const out = parseScript(mergeWithSigns({ dub: srt([["00:00:01,000", "00:00:02,000", "Hi."]]), ext: ".srt", own }).text)!;
    expect(playRes(out)).toEqual({ x: 1280, y: 720 });
    expect(out.styles.find((s) => s[0] === DUB_STYLE)![STYLE_FORMAT.indexOf("Fontsize")]).toBe("48");
  });

  // A typeset subtitle: dialogue, a sign, a line placed at the top over it, a song's syllable and a drawing.
  const typeset = signsTrack([
    "Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello.",
    "Dialogue: 0,0:00:03.00,0:00:06.00,Sign,,0,0,0,,{\\pos(960,120)}GUILD HALL",
    "Dialogue: 0,0:00:03.50,0:00:05.00,Default,,0,0,0,,{\\an8}Over there!",
    "Dialogue: 0,0:01:00.00,0:01:04.00,OP-Romaji,,0,0,0,,{\\an5\\pos(746,51)\\k20}ta",
    "Dialogue: 1,0:01:00.00,0:01:04.00,OP-Romaji,,0,0,0,,{\\an7\\pos(10,10)\\p1}m 0 0 l 0 -24 l 1 -30{\\p0}"
  ]);
  const texts = (script: NonNullable<ReturnType<typeof parseScript>>, style?: string) => script.events.filter((e) => style === undefined || e.values[3] === style).map((e) => e.values[9]);

  it("sends every line of a subtitle in the file's style, and leaves its drawings out, never as text", () => {
    const own = ownStyleOf([header("English", [row("Default", "Gandhi Sans", 48)])])!;
    const out = parseScript(mergeWithSigns({ dub: typeset, ext: ".ass", own }).text)!;
    expect(playRes(out)).toEqual({ x: 1280, y: 720 });
    expect(texts(out)).toEqual(["Hello.", "GUILD HALL", "{\\an8}Over there!", "{\\an5}ta"]);
    expect(texts(out, DUB_STYLE)).toHaveLength(4);
  });

  it("of a downloaded subtitle is its own dialogue style, picked as the file's is, read from its styles alone", () => {
    const upload = ["[Script Info]", "PlayResX: 1920", "PlayResY: 1080", "", "[V4+ Styles]", `Format: ${STYLE_FORMAT.join(", ")}`, row("Sign-Title", "Fancy", 90, 8), row("Default", "Gandhi Sans", 64), "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi."].join("\n");
    expect(dialogueStyleOf(upload)).toMatchObject({ playResX: 1920, playResY: 1080, style: { name: "Default", fontname: "Gandhi Sans", fontsize: "64" } });
    expect(dialogueStyleOf("1\n00:00:01,000 --> 00:00:02,000\nHi.\n")).toBeUndefined();
  });
});

describe("a full track's lyrics set like dialogue", () => {
  const texts = (script: NonNullable<ReturnType<typeof parseScript>>, style: string) => script.events.filter((e) => e.values[3] === style).map((e) => e.values[9]);
  const at =(s: number) => `0:${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
  const run = (from: number, style: string, words: string) => Array.from({ length: 12 }, (_, i) => `Dialogue: 0,${at(from + i * 3.6)},${at(from + i * 3.6 + 3.4)},${style},,0,0,0,,${words} ${i + 1}`);
  const full = signsTrack([
    "Dialogue: 0,0:00:05.00,0:00:08.00,Sign,,0,0,0,,{\\pos(960,120)}GUILD HALL",
    "Dialogue: 0,0:00:10.00,0:00:12.00,main,,0,0,0,,Where are we?",
    "Dialogue: 0,0:00:13.00,0:00:15.00,main,,0,0,0,,The guild.",
    ...run(60, "italics", "Song line"),
    ...run(300, "italics", "Inner thought")
  ]);
  const dub = [
    { start: 10, text: "Where is this?" },
    { start: 70, text: "♪ ♪" },
    ...Array.from({ length: 15 }, (_, i) => ({ start: 300 + i * 3, text: `Dub line ${i + 1}` }))
  ]
    .map(({ start, text }, i) => `${i + 1}\n00:${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")},000 --> 00:${String(Math.floor((start + 2) / 60)).padStart(2, "0")}:${String((start + 2) % 60).padStart(2, "0")},000\n${text}\n`)
    .join("\n");

  it("are kept from the track as maybe a song: a long run of lines in one style, beside its signs; short runs go", () => {
    const signs = signsOfFull(parseScript(full)!);
    expect(texts(signs, "Sign")).toEqual(["{\\pos(960,120)}GUILD HALL"]);
    expect(texts(signs, "main")).toEqual([]);
    expect(signs.events.filter((e) => e.values[3] === "italics").map((e) => e.values[8])).toEqual(Array(24).fill(MAYBE_SONG));
  });

  it("show as a song where the dub is quiet over them, its placeholder left out, and go where the dub speaks", () => {
    const stored = parseScript(writeScript(signsOfFull(parseScript(full)!)))!;
    const merged = mergeWithSigns({ dub, ext: ".srt", signs: stored });
    const out = parseScript(merged.text)!;
    expect(texts(out, "italics")).toEqual(Array.from({ length: 12 }, (_, i) => `Song line ${i + 1}`));
    expect(out.events.every((e) => e.values[8] === "")).toBe(true);
    expect(merged.lyrics).toBe(12);
    expect(merged.dropped.dubSongs).toBe(1);
    expect(texts(out, DUB_STYLE)).toEqual(["Where is this?", ...Array.from({ length: 15 }, (_, i) => `Dub line ${i + 1}`)]);
  });
});

describe("signs moved onto the file", () => {
  it("move as the dialogue's neighbouring lines moved, in proportion between lines that moved alike", () => {
    const before = [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000];
    const move = movesBy(before, before.map((t) => t + 1200 + (t - 10000) / 100))!;
    expect(move(15000)).toBe(1250);
    expect(move(5000)).toBe(1200);
  });

  it("move as the nearer line did across a step (a cut one release has and the other hasn't)", () => {
    const before = Array.from({ length: 20 }, (_, i) => 10000 + i * 5000);
    const move = movesBy(before, before.map((t) => t + (t < 60000 ? 500 : 3500)))!;
    expect(move(51000)).toBe(500);
    expect(move(64000)).toBe(3500);
  });

  it("don't follow one line snapped onto the file's own line", () => {
    const before = Array.from({ length: 15 }, (_, i) => 10000 + i * 4000);
    const after = before.map((t, i) => t + (i === 7 ? 1300 : 400));
    expect(movesBy(before, after)!(before[7])).toBe(400);
  });

  it("aren't moved by a dialogue track whose lines don't pair", () => {
    expect(movesBy([1, 2, 3], [1, 2])).toBeUndefined();
  });

  it("read each line's start in the order written, from ASS and SRT", () => {
    expect(startsInOrder("Dialogue: 0,0:00:05.00,0:00:06.00,A,,0,0,0,,x\nDialogue: 0,0:00:01.50,0:00:02.00,A,,0,0,0,,y")).toEqual([5000, 1500]);
    expect(startsInOrder(srt([["00:00:03,000", "00:00:04,000", "a"], ["00:00:01,000", "00:00:02,000", "b"]]))).toEqual([3000, 1000]);
  });
});

describe("a full track's signs", () => {
  it("are its events in a sign or song style, or placed, drawn or sung by their tags; its dialogue goes", () => {
    const full = parseScript(
      signsTrack([
        "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello.",
        "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an8}Up top, still dialogue.",
        "Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\pos(100,100)}A SIGN",
        "Dialogue: 0,0:00:07.00,0:00:08.00,Sign,,0,0,0,,Another sign",
        "Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 0 10 10",
        // Overlapping speech set at the top in a style named "top" is dialogue, not an opening song.
        "Dialogue: 0,0:00:11.00,0:00:12.00,top,,0,0,0,,Good day.",
        "Dialogue: 0,0:00:13.00,0:00:14.00,Ep Title,,0,0,0,,The Episode",
        "Dialogue: 0,0:00:15.00,0:00:16.00,sign_0042_07_Member,,0,0,0,,Member of the Guild",
        "Dialogue: 0,0:00:17.00,0:00:18.00,Speed,,0,0,0,,Faster."
      ])
    )!;
    expect(signsOnly(full).events.map((e) => e.values.at(-1))).toEqual(["{\\pos(100,100)}A SIGN", "Another sign", "{\\p1}m 0 0 l 10 0 10 10", "The Episode", "Member of the Guild"]);
  });
});

describe("a release's signs on Anime Tosho", () => {
  const request = { type: "series" as const, id: "tt0000851:1:5", imdbId: "tt0000851", season: 1, episode: 5 };
  const track = (place: string, name: string, extra: Record<string, unknown> = {}) => ({ place, name, language: "eng", format: "ass", forced: false, ...extra });

  it("is the episode's file's signs track with its dialogue track, else its full track, never the dub's captions", () => {
    const rel = {
      id: 1,
      title: "[Group] Show S01 [BD 1080p] [Dual Audio]",
      files: [
        { name: "[Group] Show - S01E04.mkv", englishVoicesOnly: false, tracks: [track("00001aaa", "Signs & Songs"), track("00001aab", "Dialogue")] },
        { name: "[Group] Show - S01E05.mkv", englishVoicesOnly: false, tracks: [track("00002aaa", "English [CC]"), track("00002aab", "Signs & Songs", { forced: true }), track("00002aac", "Dialogue")] }
      ]
    };
    expect(signsOf(rel, request, undefined)).toEqual([{ signs: "at00002aab", partner: "at00002aac", full: false, signsName: "Signs & Songs", release: rel.title }]);
    const fullOnly = { ...rel, files: [{ name: "[Group] Show - S01E05.mkv", englishVoicesOnly: false, tracks: [track("00003aaa", "English [CC]"), track("00003aab", "Full Subtitles")] }] };
    expect(signsOf(fullOnly, request, undefined)).toMatchObject([{ signs: "at00003aab", partner: "at00003aab", full: true }]);
    const captionsOnly = { ...rel, files: [{ name: "[Group] Show - S01E05.mkv", englishVoicesOnly: false, tracks: [track("00004aaa", "English [CC]")] }] };
    expect(signsOf(captionsOnly, request, undefined)).toEqual([]);
  });

  it("goes first from a release whose video comes from where the file's does", () => {
    expect(["[Group] Show 05 (BD 1080p HEVC Opus) [Dual Audio]", "Show.S01E05.1080p.CR.WEB-DL.AAC2.0.H.264-TEAM", "Show.S01.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD", "[TV] Show 05 (HDTV 720p)", "Show 05"].map(videoSource)).toEqual(["bd", "web", "bd", "tv", undefined]);
  });
});

describe("a Matroska file's ASS track", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const file = release({ codecPrivate: ASS_HEADER, lines: [{ start: 1000, duration: 1000, text: "Dialogue: 0,0,Default,,0,0,0,,Hi" }] });
    server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      const from = Number(m?.[1] ?? 0);
      const to = Math.min(m?.[2] ? Number(m[2]) : file.length - 1, file.length - 1);
      res.writeHead(206, { "content-range": `bytes ${from}-${to}/${file.length}`, "content-length": to - from + 1 });
      res.end(file.subarray(from, to + 1));
    }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("keeps its own script header from the file's header: its styles, for the file's own style", async () => {
    const got = await readMkvTracks(`${base}/a.mkv`);
    const sub = got!.tracks.find((t) => t.type === "subtitle")!;
    expect(sub.assHeader).toBe(ASS_HEADER);
    expect(ownStyleOf(got!.tracks)?.style).toMatchObject({ name: "Default", fontname: "Arial", fontsize: "60" });
  });
});
