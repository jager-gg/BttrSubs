import { describe, expect, it } from "vitest";
import { cutLines, joinCuts, lineNudges, nearerClaims, OWN_SNAP, parseCues, retime } from "../src/sync.js";

const cue = (start: number, end = start + 1500) => ({ start, end });
const none = () => 0;

describe("snapping lines onto the file's own line starts", () => {
  it("moves a line a beat off onto the file's line", () => {
    const nudges = lineNudges([cue(10_000), cue(14_000)], none, [cue(10_180), cue(13_900)]);
    expect(nudges.get(10_000)).toBe(180);
    expect(nudges.get(14_000)).toBe(-100);
  });

  it("measures after the shift", () => {
    // Shifted by +2 s, the caption at 8 s lands at 10 s, 150 ms before the file's line.
    expect(lineNudges([cue(8_000)], () => 2000, [cue(10_150)]).get(8_000)).toBe(150);
  });

  it("leaves lines that are on time, or too far off to be the same line", () => {
    const nudges = lineNudges([cue(10_000), cue(20_000)], none, [cue(10_020), cue(20_450)]);
    expect(nudges.size).toBe(0);
  });

  it("leaves a line between two of the file's lines alone", () => {
    // 10.15 s and 10.5 s both start near it: which one it is isn't clear.
    expect(lineNudges([cue(10_000)], none, [cue(10_150, 10_400), cue(10_500)]).size).toBe(0);
  });

  it("moves only the nearer of two caption lines onto one line of the file", () => {
    const nudges = lineNudges([cue(10_000, 10_100), cue(10_250)], none, [cue(10_200)]);
    expect(nudges.get(10_250)).toBe(-50);
    expect(nudges.has(10_000)).toBe(false);
  });

  it("carries the move into the written file, end and all", () => {
    const nudges = lineNudges([cue(10_000, 12_000)], () => 1000, [cue(11_200)]);
    const srt = "1\n00:00:10,000 --> 00:00:12,000\nhi\n";
    expect(retime(srt, ".srt", (start) => 1000 + (nudges.get(start) ?? 0))).toBe("1\n00:00:11,200 --> 00:00:13,200\nhi\n");
  });

  it("writes the end it is given, when lines are kept apart one by one", () => {
    // Given the line's start and end as written (after any frame rate), the end function decides where it ends.
    const ends: Array<[number, number]> = [];
    const end = (start: number, last: number) => (ends.push([start, last]), last + 500);
    const srt = "1\n00:00:10,000 --> 00:00:12,000\nhi\n";
    expect(retime(srt, ".srt", () => 1000, 1, end)).toBe("1\n00:00:11,000 --> 00:00:12,500\nhi\n");
    const ass = "Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Hi\n";
    expect(retime(ass, ".ass", () => 1000, 1, end)).toBe("Dialogue: 0,0:00:11.00,0:00:12.50,Default,,0,0,0,,Hi\n");
    expect(ends).toEqual([[10_000, 12_000], [10_000, 12_000]]);
    // Made for another frame rate: start and end are scaled first.
    expect(retime(srt, ".srt", () => 0, 2, (_start, last) => last)).toBe("1\n00:00:20,000 --> 00:00:24,000\nhi\n");
  });
});

describe("snapping on the file's own track in the captions' language", () => {
  it("moves a line another release timed up to 0.9 s apart", () => {
    expect(lineNudges([cue(10_000)], none, [cue(10_700), cue(13_000)]).size).toBe(0);
    expect(lineNudges([cue(10_000)], none, [cue(10_700), cue(13_000)], OWN_SNAP).get(10_000)).toBe(700);
    expect(lineNudges([cue(10_000)], none, [cue(11_000), cue(14_000)], OWN_SNAP).size).toBe(0);
  });

  it("leaves a line when the next line start is under 0.3 s farther", () => {
    expect(lineNudges([cue(10_000)], none, [cue(9_300), cue(10_500)], OWN_SNAP).size).toBe(0);
    expect(lineNudges([cue(10_000)], none, [cue(9_100), cue(10_500)], OWN_SNAP).get(10_000)).toBe(500);
  });
});

describe("a pairing by rhythm against nearer lines", () => {
  const none = () => 0;
  it("drops a move onto a line start another unpaired line is nearer to", () => {
    // An extra line at 9,540 paired a line off onto 10,000; the line at 9,820 is the one that belongs there.
    const captions = [cue(9_540, 9_740), cue(9_820), cue(14_000)];
    const kept = nearerClaims(captions, none, new Map([[9_540, 460], [14_000, 100]]));
    expect(kept.has(9_540)).toBe(false);
    expect(kept.get(14_000)).toBe(100);
  });

  it("keeps it when the nearer line was paired elsewhere", () => {
    const captions = [cue(9_540, 9_740), cue(9_820)];
    expect(nearerClaims(captions, none, new Map([[9_540, 460], [9_820, 2_000]])).get(9_540)).toBe(460);
  });
});

describe("a line the subtitle cuts in two", () => {
  const srt = (rows: Array<[string, string, string]>) => rows.map(([a, b, words], i) => `${i + 1}\n${a} --> ${b}\n${words}\n`).join("\n");

  it("finds back-to-back cues with the same text and leads each later piece to the first", () => {
    const text = srt([
      ["00:00:10,000", "00:00:10,350", "Why are we\nwatching this?"],
      ["00:00:10,350", "00:00:12,400", "<i>Why are we</i>\nwatching this?"],
      ["00:00:12,400", "00:00:13,000", "Why are we watching this?"],
      ["00:00:13,500", "00:00:15,000", "Something else."]
    ]);
    expect([...cutLines(text, ".srt")]).toEqual([[10_350, 10_000], [12_400, 10_000]]);
  });

  it("keeps the same words said twice as two lines: apart, said otherwise, or back to back in a subtitle that doesn't cut lines", () => {
    const text = srt([
      ["00:00:10,000", "00:00:10,600", "No."],
      ["00:00:10,800", "00:00:11,400", "No."],
      ["00:00:11,400", "00:00:12,000", "No!"],
      ["00:00:12,000", "00:00:12,600", "Yes."]
    ]);
    expect(cutLines(text, ".srt").size).toBe(0);
    // One line said twice back to back among 30 lines (under 1 in 20): two lines.
    const rows: Array<[string, string, string]> = Array.from({ length: 30 }, (_, k) => [`00:01:${String(k * 2).padStart(2, "0")},000`, `00:01:${String(k * 2 + 1).padStart(2, "0")},000`, `Line ${k}`]);
    rows.push(["00:02:00,000", "00:02:01,500", "Over."], ["00:02:01,500", "00:02:03,000", "Over."]);
    expect(cutLines(srt(rows), ".srt").size).toBe(0);
  });

  it("reads ASS pieces without their tags, and in the time a frame rate scales them to", () => {
    const ass = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:10.00,0:00:10.40,Default,,0,0,0,,{\\i1}Wait\\Nhere{\\i0}\nDialogue: 0,0:00:10.40,0:00:12.00,Default,,0,0,0,,Wait here\n";
    expect([...cutLines(ass, ".ass")]).toEqual([[10_400, 10_000]]);
    expect([...cutLines(ass, ".ass", 2)]).toEqual([[20_800, 20_000]]);
  });

  it("joins the pieces into one line from the first start to the last end", () => {
    const captions = [cue(10_000, 10_350), cue(10_350, 12_400), cue(13_000, 14_000)];
    expect(joinCuts(captions, new Map([[10_350, 10_000]]))).toEqual([cue(10_000, 12_400), cue(13_000, 14_000)]);
  });

  it("snaps the whole line onto the file's line and moves every piece with it", () => {
    // Written 650 ms early, cut 350 ms in: the second piece is nearer the file's line than the first.
    const text = srt([
      ["00:00:10,000", "00:00:10,350", "Why are we watching this?"],
      ["00:00:10,350", "00:00:12,400", "Why are we watching this?"]
    ]);
    const captions = parseCues(text, ".srt");
    const file = [cue(10_650, 13_050), cue(15_000)];
    const apart = lineNudges(captions, none, file, OWN_SNAP);
    expect(apart.has(10_000)).toBe(false);
    expect(apart.get(10_350)).toBe(300);
    const cuts = cutLines(text, ".srt");
    const nudges = lineNudges(joinCuts(captions, cuts), none, file, OWN_SNAP);
    expect(nudges.get(10_000)).toBe(650);
    const lead = (start: number) => cuts.get(start) ?? start;
    expect(retime(text, ".srt", (start) => nudges.get(lead(start)) ?? 0)).toBe(
      srt([
        ["00:00:10,650", "00:00:11,000", "Why are we watching this?"],
        ["00:00:11,000", "00:00:13,050", "Why are we watching this?"]
      ])
    );
  });
});
