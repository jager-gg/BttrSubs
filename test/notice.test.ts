import { describe, expect, it } from "vitest";
import { withNotice } from "../src/srt.js";

const MESSAGE = "BttrSubs: a notice.";

describe("a notice as a subtitle's first line", () => {
  it("opens an SRT file, ahead of its own lines, which stay as they are", () => {
    const srt = "1\n00:00:02,000 --> 00:00:04,000\nFirst line.\n\n2\n00:00:05,000 --> 00:00:06,000\nSecond line.\n";
    const sent = withNotice(srt, false, MESSAGE);
    expect(sent.startsWith(`0\n00:00:00,500 --> 00:00:08,000\n${MESSAGE}\n\n1\n00:00:02,000`)).toBe(true);
    expect(sent.endsWith(srt)).toBe(true);
  });

  it("goes into an ASS script as a line of its own, in the first line's style, at the top, by the script's Format", () => {
    const ass = ["[Script Info]", "ScriptType: v4.00+", "", "[V4+ Styles]", "Format: Name, Fontname, Fontsize", "Style: Main,Arial,20", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", "Comment: 0,0:00:00.00,0:00:01.00,Main,,0,0,0,,a note", "Dialogue: 0,0:00:02.00,0:00:04.00,Main,,0,0,0,,First, with a comma."].join("\n");
    const lines = withNotice(ass, true, MESSAGE).split("\n");
    const at = lines.indexOf("Dialogue: 0,0:00:02.00,0:00:04.00,Main,,0,0,0,,First, with a comma.");
    expect(lines[at - 1]).toBe(`Dialogue: 0,0:00:00.50,0:00:08.00,Main,,0,0,0,,{\\an8}${MESSAGE}`);
    expect(lines.length).toBe(ass.split("\n").length + 1);
  });

  it("follows a Format that orders its fields otherwise", () => {
    const ass = ["[Events]", "Format: Start, End, Style, Text", "Dialogue: 0:00:02.00,0:00:04.00,Sub,Line."].join("\n");
    expect(withNotice(ass, true, MESSAGE).split("\n")[2]).toBe(`Dialogue: 0:00:00.50,0:00:08.00,Sub,{\\an8}${MESSAGE}`);
  });

  it("leaves a script it can't place a line in as it is", () => {
    expect(withNotice("[Script Info]\nTitle: none", true, MESSAGE)).toBe("[Script Info]\nTitle: none");
    expect(withNotice("[Events]\nFormat: Layer, Style\nDialogue: 0,Main", true, MESSAGE)).toBe("[Events]\nFormat: Layer, Style\nDialogue: 0,Main");
  });
});
