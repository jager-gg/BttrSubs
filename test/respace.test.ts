/**
 * Songs set piece by piece in a font players don't have (respace.ts): each line laid out again in a font
 * they have, by its own letter widths, its middle kept; shapes beside it move with it.
 */
import { describe, expect, it } from "vitest";
import { FACES } from "../src/fontwidths.js";
import { LAID_OUT, laidOut, laidOutForPlayers, respaceSongs } from "../src/respace.js";
import { parseScript } from "../src/signs.js";

const arial = FACES.find((f) => f.name === "Arial" && !f.bold)!;
const width = (text: string, size = 42) =>
  ([...text].reduce((sum, ch) => {
    const cp = ch.codePointAt(0)!;
    const [from, ws] = arial.widths.find(([a, w]) => cp >= a && cp < a + w.length)!;
    return sum + ws[cp - from];
  }, 0) * size) / arial.height;

// A line set for a font a fifth narrower than Arial, centred at 640: syllables centred (\an5), words 12 px apart.
const WORDS = [["Lo", "rav", "mi"], ["ve", "su"], ["pa"]];
const NARROW = 0.8;
const placed: Array<{ text: string; x: number }> = [];
{
  const total = WORDS.flat().reduce((sum, s) => sum + width(s) * NARROW, 0) + 12 * (WORDS.length - 1);
  let left = 640 - total / 2;
  for (const [i, word] of WORDS.entries()) {
    for (const syllable of word) {
      placed.push({ text: syllable, x: left + (width(syllable) * NARROW) / 2 });
      left += width(syllable) * NARROW;
    }
    if (i < WORDS.length - 1) left += 12;
  }
}
const flying = placed[1];
const letters = (() => {
  let left = flying.x - (width(flying.text) * NARROW) / 2;
  return [...flying.text].map((ch) => {
    const x = left + (width(ch) * NARROW) / 2;
    left += width(ch) * NARROW;
    return { text: ch, x };
  });
})();

const script = (styleFont: string, extra = "") =>
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: OP - Romaji,${styleFont},42,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1`,
    "Style: Sign,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...placed.map((p) => `Dialogue: 4,0:00:10.00,0:00:14.00,OP - Romaji,,0,0,0,,{\\an5\\pos(${p.x.toFixed(2)},51)\\blur1}${p.text}`),
    ...letters.map((l) => `Dialogue: 4,0:00:09.80,0:00:10.00,OP - Romaji,,0,0,0,,{\\fad(150,0)\\an5\\move(${l.x.toFixed(2)},69,${l.x.toFixed(2)},51)}${l.text}`),
    `Dialogue: 2,0:00:10.00,0:00:10.30,OP - Romaji,,0,0,0,,{\\an7\\move(${placed[0].x.toFixed(2)},83,${placed[0].x.toFixed(2)},23)\\p1}m 0 0 l 0 -24 l 1 -30{\\p0}`,
    "Dialogue: 0,0:00:10.00,0:00:14.00,Sign,,0,0,0,,{\\pos(300,600)}GUILD HALL",
    "",
    extra
  ].join("\n");

const xOf = (text: string) => Number(/\\(?:pos|move)\((-?[\d.]+)/.exec(text)?.[1]);
const eventsOf = (out: string) => {
  const s = parseScript(out)!;
  return s.events.map((e) => ({ start: e.values[1], style: e.values[3], text: e.values[9], plain: e.values[9].replace(/\{[^}]*\}/g, "") }));
};

describe("a song set piece by piece in a font players lack", () => {
  it("is laid out again in a font they have, by its widths, its word breaks kept in that font's measure and the line's middle kept", () => {
    const out = respaceSongs(script("Flux"))!;
    expect(out.lines).toBeGreaterThan(0);
    const s = parseScript(out.text)!;
    expect(s.styles.find((v) => v[0] === "OP - Romaji")![1]).toBe("Arial");
    const syllables = eventsOf(out.text).filter((e) => e.start === "0:00:10.00" && e.style === "OP - Romaji" && e.plain);
    const xs = WORDS.flat().map((t) => xOf(syllables.find((e) => e.plain === t)!.text));
    const flat = WORDS.flat();
    // The 12 px break, set for a font a fifth narrower, is 15 px in Arial's measure.
    const breaks = new Set([2, 4]);
    for (let i = 0; i + 1 < flat.length; i++) {
      const expected = (width(flat[i]) + width(flat[i + 1])) / 2 + (breaks.has(i) ? 12 / NARROW : 0);
      expect(xs[i + 1] - xs[i]).toBeCloseTo(expected, 1);
    }
    const left = xs[0] - width(flat[0]) / 2;
    const right = xs[xs.length - 1] + width(flat[flat.length - 1]) / 2;
    const oldLeft = placed[0].x - (width(flat[0]) * NARROW) / 2;
    const oldRight = placed[placed.length - 1].x + (width(flat[flat.length - 1]) * NARROW) / 2;
    expect((left + right) / 2).toBeCloseTo((oldLeft + oldRight) / 2, 1);
  });

  it("moves the letters flying in the same way, and a shape drawn beside the line with it", () => {
    const all = eventsOf(respaceSongs(script("Flux"))!.text);
    const chars = [...flying.text];
    const flown = chars.map((ch) => all.find((e) => e.start === "0:00:09.80" && e.plain === ch)!);
    const xs = flown.map((e) => xOf(e.text));
    expect(xs[1] - xs[0]).toBeCloseTo((width(chars[0]) + width(chars[1])) / 2, 1);
    expect(xs[2] - xs[1]).toBeCloseTo((width(chars[1]) + width(chars[2])) / 2, 1);
    expect(flown[0].text).toMatch(/\\move\(([\d.]+),69,\1,51\)/);
    const bar = all.find((e) => /\\p1/.test(e.text))!;
    expect(xOf(bar.text)).not.toBeCloseTo(placed[0].x, 0);
    expect(all.find((e) => e.plain === "GUILD HALL")!.text).toBe("{\\pos(300,600)}GUILD HALL");
  });

  it("is done as a script is saved and marked, so a download sends it as it is; other formats stay as they are", () => {
    const once = laidOutForPlayers(script("Flux"), ".ass");
    expect(laidOut(once)).toBe(true);
    expect(parseScript(once)!.styles.find((v) => v[0] === "OP - Romaji")![1]).toBe("Arial");
    expect(parseScript(once)!.info).toContain(LAID_OUT);
    expect(laidOutForPlayers(once, ".ass")).toBe(once);
    const plain = laidOutForPlayers(script("Arial"), ".ass");
    expect([laidOut(plain), plain.replace(`${LAID_OUT}\n`, "")]).toEqual([true, script("Arial")]);
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHi.\n";
    expect(laidOutForPlayers(srt, ".srt")).toBe(srt);
  });

  it("leaves a song in a font players have, and a script that carries its own fonts", () => {
    expect(respaceSongs(script("Arial"))).toBeUndefined();
    expect(respaceSongs(script("Flux", "[Fonts]\nfontname: flux.ttf\nM2*<DATA\n"))).toBeUndefined();
  });

  it("lays out a line shown as letters and as the syllables they make at once from its letters, each syllable over its own", () => {
    const crossed = script("Flux").replaceAll("0:00:09.80,0:00:10.00", "0:00:10.00,0:00:10.50");
    const all = eventsOf(respaceSongs(crossed)!.text);
    const chars = [...flying.text];
    const xs = chars.map((ch) => xOf(all.find((e) => e.start === "0:00:10.00" && e.plain === ch)!.text));
    expect(xs[1] - xs[0]).toBeCloseTo((width(chars[0]) + width(chars[1])) / 2, 1);
    expect(xs[2] - xs[1]).toBeCloseTo((width(chars[1]) + width(chars[2])) / 2, 1);
    const syllable = xOf(all.find((e) => e.plain === flying.text)!.text);
    expect(syllable).toBeCloseTo((xs[0] - width(chars[0]) / 2 + xs[2] + width(chars[2]) / 2) / 2, 1);
  });

  it("lays out two lines at one height, the next fading in over the last, each on its own", () => {
    // The next line set as the first is, a fifth narrower than Arial with 12 px breaks, its middle 9 px right.
    const words = [["ko", "ne"], ["da", "ri"], ["to", "ma"]];
    let left = 649 - (words.flat().reduce((sum, s) => sum + width(s) * NARROW, 0) + 12 * (words.length - 1)) / 2;
    const at: number[] = [];
    for (const [i, word] of words.entries()) {
      for (const s of word) {
        at.push(left + (width(s) * NARROW) / 2);
        left += width(s) * NARROW;
      }
      if (i < words.length - 1) left += 12;
    }
    const next = words.flat().map((t, i) => `Dialogue: 4,0:00:13.50,0:00:15.00,OP - Romaji,,0,0,0,,{\\an5\\pos(${at[i].toFixed(2)},51)}${t}`).join("\n");
    const both = eventsOf(respaceSongs(script("Flux", next))!.text);
    const flat = WORDS.flat();
    const firsts = flat.map((t) => xOf(both.find((e) => e.start === "0:00:10.00" && e.plain === t)!.text));
    // Syllables of one word stand their widths apart (the word breaks scale with the style's ratio).
    for (const i of [0, 1, 3]) expect(firsts[i + 1] - firsts[i]).toBeCloseTo((width(flat[i]) + width(flat[i + 1])) / 2, 1);
    const seconds = ["ko", "ne", "da", "ri", "to", "ma"].map((t) => xOf(both.find((e) => e.start === "0:00:13.50" && e.plain === t)!.text));
    expect(seconds[1] - seconds[0]).toBeCloseTo((width("ko") + width("ne")) / 2, 1);
  });

  it("draws a piece it leaves where it stands as wide as the old font drew it", () => {
    // Turned pieces can't be read into a line: they keep their places, made for a font a fifth narrower.
    const turned = [
      "Dialogue: 4,0:00:10.00,0:00:14.00,OP - Romaji,,0,0,0,,{\\an5\\pos(200,300)\\frz20}la",
      "Dialogue: 4,0:00:10.00,0:00:14.00,OP - Romaji,,0,0,0,,{\\an5\\frz20\\fscx120\\pos(260,300)\\t(0,200,\\fscx150)}la",
      "Dialogue: 4,0:00:10.00,0:00:14.00,OP - Romaji,,0,0,0,,\\frz is in no tag here{\\frz20\\an5\\pos(320,300)}la"
    ].join("\n");
    const out = eventsOf(respaceSongs(script("Flux", turned))!.text).filter((e) => e.text.includes("\\frz20"));
    expect(out.map((e) => xOf(e.text))).toEqual([200, 260, 320]);
    const scales = out.map((e) => [...e.text.matchAll(/\\fscx([\d.]+)/g)].map((m) => Number(m[1])));
    expect(scales[0]).toHaveLength(1);
    expect(scales[0][0]).toBeCloseTo(100 * NARROW, 0);
    // Its own widths, the one it changes to over time too, scale alike.
    expect(scales[1][0] / scales[0][0]).toBeCloseTo(1.2, 2);
    expect(scales[1][1] / scales[0][0]).toBeCloseTo(1.5, 2);
    // Text before the first tags: the width goes in tags of its own, ahead of it.
    expect(out[2].text.startsWith(`{\\fscx${scales[0][0]}}`)).toBe(true);
    // A sign in a font players have, and a line laid out again, take no width.
    const all = eventsOf(respaceSongs(script("Flux", turned))!.text);
    expect(all.filter((e) => e.style === "Sign" || (e.start === "0:00:10.00" && WORDS.flat().includes(e.plain) && !e.text.includes("\\frz"))).some((e) => e.text.includes("\\fscx"))).toBe(false);
  });

  it("keeps a row whole: a line whose layout would set its pieces over others of their row is left as it is", () => {
    // One more syllable ends the row, set from its left edge (\an4) 2 px past the last one: read on its own,
    // it stays, and the line laid out again without it would spread over it.
    const last = placed[placed.length - 1];
    const edge = last.x + (width(last.text) * NARROW) / 2 + 2;
    const ends = `Dialogue: 4,0:00:10.00,0:00:14.00,OP - Romaji,,0,0,0,,{\\an4\\pos(${edge.toFixed(2)},51)}zu`;
    const out = eventsOf(respaceSongs(script("Flux", ends))!.text).filter((e) => e.start === "0:00:10.00" && e.style === "OP - Romaji");
    const scale = (e: { text: string }) => Number(/\\fscx([\d.]+)/.exec(e.text)?.[1] ?? 100) / 100;
    const before = out.find((e) => e.plain === last.text)!;
    const after = out.find((e) => e.plain === "zu")!;
    expect(xOf(after.text)).toBeCloseTo(edge, 1);
    expect(xOf(before.text) + (width(last.text) * scale(before)) / 2).toBeLessThanOrEqual(edge + 1);
    // The row's pieces all stay where they were set, at the old font's width.
    for (const p of placed) expect(xOf(out.find((e) => e.plain === p.text)!.text)).toBeCloseTo(p.x, 1);
    expect(scale(before)).toBeCloseTo(NARROW, 1);
  });

  it("moves a letter flying out of its line with that line", () => {
    const leave = letters.map((l) => `Dialogue: 4,0:00:14.00,0:00:14.15,OP - Romaji,,0,0,0,,{\\an5\\move(${l.x.toFixed(2)},51,${l.x.toFixed(2)},95)}${l.text}`).join("\n");
    const all = eventsOf(respaceSongs(script("Flux", leave))!.text);
    for (const l of letters) {
      const arrived = xOf(all.find((e) => e.start === "0:00:09.80" && e.plain === l.text)!.text);
      const left = all.find((e) => e.start === "0:00:14.00" && e.plain === l.text)!.text;
      expect(xOf(left)).toBeCloseTo(arrived, 1);
      expect(left).toMatch(/\\move\(([\d.]+),51,\1,95\)/);
    }
  });

  it("slides a line that would pass the picture's edge back inside the style's margin", () => {
    const right = placed[placed.length - 1].x + (width(placed[placed.length - 1].text) * NARROW) / 2;
    const dx = 1266 - right;
    const near = script("Flux").replace(/\\(pos|move)\(([\d.]+),([\d.]+)(?:,([\d.]+),([\d.]+))?/g, (_, k, x1, y1, x2, y2) => (x2 === undefined ? `\\${k}(${(Number(x1) + dx).toFixed(2)},${y1}` : `\\${k}(${(Number(x1) + dx).toFixed(2)},${y1},${(Number(x2) + dx).toFixed(2)},${y2}`));
    const all = eventsOf(respaceSongs(near)!.text).filter((e) => e.start === "0:00:10.00" && e.style === "OP - Romaji" && e.plain && !/\\p1/.test(e.text));
    const flat = WORDS.flat();
    const xs = flat.map((t) => xOf(all.find((e) => e.plain === t)!.text));
    expect(xs[xs.length - 1] + width(flat[flat.length - 1]) / 2).toBeCloseTo(1280 - 10, 1);
    expect(xs[1] - xs[0]).toBeCloseTo((width(flat[0]) + width(flat[1])) / 2, 1);
  });
});
