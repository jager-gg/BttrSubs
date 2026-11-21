import { describe, expect, it } from "vitest";
import { type Cue, type FileAnchors, captionCues, judge, languageTracks, parseCues, sparseTrack, trackChoice, tracksToTry } from "../src/sync.js";
import { sameLanguage } from "../src/langcodes.js";

/** Lines of uneven length and spacing, the way dialogue comes (deterministic, no randomness). */
function lines(from: number, to: number, seed: number): Cue[] {
  const cues: Cue[] = [];
  let at = from;
  let n = seed;
  while (at < to) {
    n = (n * 1103515245 + 12345) % 2147483648;
    const length = 900 + (n % 2600);
    const gap = 300 + ((n >> 8) % 2200);
    cues.push({ start: at, end: at + length });
    at += length + gap;
  }
  return cues;
}

const DURATION = 1_420_000;
const SPOTS = [0.15, 0.32, 0.5, 0.68, 0.85];
const captions = lines(0, 1_360_000, 7);
const shifted = (cues: Cue[], by: number) => cues.map((c) => ({ start: c.start + by, end: c.end + by }));
const inside = (cues: Cue[], from: number) => cues.filter((c) => c.start >= from && c.end <= from + 40000);

/** A file read at the usual spots: its first track's lines, and other text tracks' by index. */
function file(first: Cue[], others: Record<number, Cue[]> = {}): FileAnchors {
  const ids = Object.keys(others).map(Number);
  return {
    duration: DURATION,
    ...(ids.length ? { others: ids } : {}),
    windows: SPOTS.map((spot) => {
      const from = Math.round(DURATION * spot);
      return { from, to: from + 40000, cues: inside(first, from), others: Object.fromEntries(ids.map((id) => [String(id), inside(others[id], from)])) };
    })
  };
}

describe("which of the file's subtitle tracks to time by", () => {
  it("keeps the first track when it fits", () => {
    const found = file(shifted(captions, 600), { 5: shifted(captions, -3000) });
    expect(trackChoice(found, captions)).toBe("first");
    const verdict = judge(found, captions);
    expect(verdict.verdict).toBe("synced");
    for (const a of verdict.anchors) expect(Math.abs(a.offset - 600)).toBeLessThanOrEqual(60);
  });

  it("skips a first track with under half as many lines (an unlabelled signs track)", () => {
    const signs = shifted(captions, 600).filter((_, i) => i % 4 === 0);
    const found = file(signs, { 5: shifted(captions, 800) });
    expect(sparseTrack(file(signs), captions)).toBe(true);
    expect(trackChoice(found, captions)).toBe(5);
    const verdict = judge(found, captions);
    expect(verdict.verdict).toBe("synced");
    expect(verdict.track).toBe(5);
    for (const a of verdict.anchors) expect(Math.abs(a.offset - 800)).toBeLessThanOrEqual(60);
  });

  it("tries the next track when the first doesn't fit", () => {
    const found = file(lines(0, 1_400_000, 4242), { 6: shifted(captions, -1500) });
    expect(trackChoice(found, captions)).toBe(6);
    expect(judge(found, captions)).toMatchObject({ verdict: "synced", track: 6 });
  });

  it("keeps the first track that isn't sparse when none fits yet, and none when all are sparse", () => {
    const other = lines(0, 1_400_000, 4242);
    expect(trackChoice(file(other, { 6: lines(0, 1_400_000, 99) }), captions)).toBe("first");
    const sparse = shifted(captions, 600).filter((_, i) => i % 4 === 0);
    expect(trackChoice(file(sparse, { 6: sparse }), captions)).toBeUndefined();
    expect(judge(file(sparse, { 6: sparse }), captions).verdict).not.toBe("synced");
  });

  it("counts a full track as full, whatever its shift", () => {
    expect(sparseTrack(file(shifted(captions, 15000)), captions)).toBe(false);
    // Two lines of it for three of the captions is still full.
    expect(sparseTrack(file(captions.filter((_, i) => i % 3 !== 0)), captions)).toBe(false);
  });
});

describe("an ASS subtitle's spoken lines", () => {
  const stamp = (ms: number) => {
    const cs = Math.round(ms / 10);
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
  };
  const event = (c: Cue, style: string, text: string) => `Dialogue: 0,${stamp(c.start)},${stamp(c.end)},${style},,0,0,0,,${text}`;
  /** A Blu-ray release's subtitle: the dialogue, an opening and an ending sung syllable by syllable, and signs drawn frame by frame. */
  function release(dialogue: Cue[]): string {
    const out = ["[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"];
    for (const c of dialogue) out.push(event(c, "Default", "A line of dialogue."));
    for (const from of [0, 1_270_000]) {
      for (let t = from; t < from + 90_000; t += 40) out.push(event({ start: t, end: t + 400 }, "OP2 - Romaji", `{\\k40}la`));
    }
    for (let t = 200_000; t < 1_200_000; t += 50_000) {
      for (let f = 0; f < 60; f++) out.push(event({ start: t + f * 42, end: t + f * 42 + 42 }, "Signs", `{\\pos(320,${40 + f})}A sign`));
    }
    return out.join("\n");
  }

  it("times a subtitle full of karaoke and signs by its dialogue, so the file's own track isn't too sparse", () => {
    const ass = release(captions);
    expect(parseCues(ass, ".ass").length).toBeGreaterThan(captions.length * 10);
    expect(captionCues(ass, ".ass")).toEqual(captions.map((c) => ({ start: Math.round(c.start / 10) * 10, end: Math.round(c.end / 10) * 10 })));
    const found = file(shifted(captions, 600));
    // Every event counted, the file's track has a tenth as many lines and is set aside for speech.
    expect(sparseTrack(found, parseCues(ass, ".ass"))).toBe(true);
    expect(trackChoice(found, captionCues(ass, ".ass"))).toBe("first");
    const verdict = judge(found, captionCues(ass, ".ass"));
    expect(verdict.verdict).toBe("synced");
    for (const a of verdict.anchors) expect(Math.abs(a.offset - 600)).toBeLessThanOrEqual(60);
  });

  it("reads a style by its words: dialogue placed at the top is spoken, a sign or song style isn't", () => {
    const lines = captions.slice(0, 8);
    const styles = ["top", "Main - Top", "Flashback - Top", "italicstop", "Speed", "TitleCard", "OP1-Romaji", "Signs/Songs"];
    const ass = ["[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...lines.map((c, i) => event(c, styles[i], "Words."))].join("\n");
    expect(captionCues(ass, ".ass")).toEqual(lines.slice(0, 5).map((c) => ({ start: Math.round(c.start / 10) * 10, end: Math.round(c.end / 10) * 10 })));
  });

  it("keeps every line of an ASS subtitle with none that reads as spoken, and of any other format", () => {
    const placed = ["[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...captions.slice(0, 5).map((c) => event(c, "Default", "{\\pos(320,40)}Placed"))].join("\n");
    expect(captionCues(placed, ".ass")).toEqual(parseCues(placed, ".ass"));
    expect(captionCues(placed, ".ass")).toHaveLength(5);
    const srt = "1\n00:00:01,460 --> 00:00:02,920\n{\\an8}hi\n";
    expect(captionCues(srt, ".srt")).toEqual(parseCues(srt, ".srt"));
  });
});

describe("the file's own track in the captions' language", () => {
  // English ranks first; the file's Italian track starts its lines 120 ms after the English one.
  const italian = shifted(captions, 720);
  const base = file(shifted(captions, 600));
  const found: FileAnchors = {
    ...base,
    track: 3,
    langTracks: [7],
    trackLangs: { "3": "eng", "7": "ita" },
    windows: base.windows.map((w) => ({ ...w, langs: { "7": inside(italian, w.from) } }))
  };

  it("is tried first, by code or by name", () => {
    expect(tracksToTry(found, "ita")).toEqual([7, "first"]);
    expect(tracksToTry(found, "italian")).toEqual([7, "first"]);
    expect(trackChoice(found, captions, "ita")).toBe(7);
    const verdict = judge(found, captions, "ita");
    expect(verdict).toMatchObject({ verdict: "synced", track: 7 });
    for (const a of verdict.anchors) expect(Math.abs(a.offset - 720)).toBeLessThanOrEqual(60);
  });

  it("leaves other languages, dub captions and older records on the usual order", () => {
    expect(tracksToTry(found, "spa")).toEqual(["first"]);
    expect(tracksToTry(found)).toEqual(["first"]);
    expect(tracksToTry({ ...found, trackLangs: undefined }, "ita")).toEqual(["first"]);
    expect(trackChoice(found, captions)).toBe("first");
    for (const a of judge(found, captions).anchors) expect(Math.abs(a.offset - 600)).toBeLessThanOrEqual(60);
  });

  it("keeps the usual order when the first track is already in that language", () => {
    expect(tracksToTry(found, "eng")).toEqual(["first"]);
    expect(tracksToTry({ ...found, others: [5], trackLangs: { "3": "eng", "5": "ita" }, langTracks: undefined }, "ita")).toEqual([5, "first"]);
  });

  it("falls back on the usual order when its own track doesn't fit", () => {
    const astray = { ...found, windows: found.windows.map((w) => ({ ...w, langs: { "7": inside(lines(0, 1_400_000, 4242), w.from) } })) };
    expect(trackChoice(astray, captions, "ita")).toBe("first");
  });

  it("keeps one text track for each language the kept tracks don't cover", () => {
    const sub = (index: number, language: string, codec = "subrip") => ({ index, codec_type: "subtitle", codec_name: codec, tags: { language } });
    const ranked = [sub(3, "eng"), sub(4, "fre"), sub(5, "ger"), sub(6, "ita", "ass"), sub(7, "ita"), sub(8, "fre"), sub(9, "und"), sub(10, "spa", "hdmv_pgs_subtitle"), sub(11, "por")];
    expect(languageTracks(ranked, [3, 4, 5])).toEqual([6, 11]);
  });

  it("matches a language by code or name, regional variants aside", () => {
    expect(sameLanguage("ita", "italian")).toBe(true);
    expect(sameLanguage("fre", "fra")).toBe(true);
    expect(sameLanguage("pt-BR", "por")).toBe(true);
    expect(sameLanguage("portuguese (br)", "Portuguese")).toBe(true);
    expect(sameLanguage("spa", "por")).toBe(false);
  });
});
