import { describe, expect, it } from "vitest";
import { cleanCue, cleanLine, withoutSounds } from "../src/clean.js";

describe("sound descriptions taken out of a subtitle", () => {
  it("takes out bracketed sounds and speakers, sung lines, and descriptions in lower case or capitals", () => {
    expect(cleanLine("[door creaks]")).toBe("");
    expect(cleanLine("[NAME] Where is everyone?")).toBe("Where is everyone?");
    expect(cleanLine("Fine. [laughs]")).toBe("Fine.");
    expect(cleanLine("‐‐[NAME pants]")).toBe("");
    expect(cleanLine("(engine revving)")).toBe("");
    expect(cleanLine("- (grunts)")).toBe("");
    expect(cleanLine("(BUZZES)")).toBe("");
    expect(cleanLine("- (WHISPERING) Over here?")).toBe("- Over here?");
    expect(cleanLine("JOHN: No, look at my hands,")).toBe("No, look at my hands,");
    expect(cleanLine("MAN 2:")).toBe("");
    expect(cleanLine("♪ la la la ♪")).toBe("");
    expect(cleanLine("in a quiet town ♪")).toBe("");
    expect(cleanLine("<i>[music playing]</i>")).toBe("");
    expect(cleanLine("<i>[NAME] Run!</i>")).toBe("<i>Run!</i>");
  });

  it("keeps what is said or shown: names and thoughts in normal case, text on screen, times, a script without case", () => {
    for (const line of ["(Kate)", "(He's late again.)", "I (think) so.", "UNLOCKED: FABRIC", "NEXT EPISODE: FIRST CONTACT", "10:30 tomorrow", "Mom: dinner's ready", "!", "‫(لا نُقهر، لا ننحني)"]) {
      expect(cleanLine(line), line).toBe(line);
    }
    // Right-to-left lines open with a direction mark; their bracketed sounds go all the same.
    expect(cleanLine("‫- [يضحك] لا، مهلاً.")).toBe("‫- لا، مهلاً.");
  });

  it("drops a song's whole cue, and the dash of the one line left of two speakers", () => {
    expect(cleanCue(["♪ The wind that blows", "Fills the air", "With peace ♪"])).toEqual([]);
    expect(cleanCue(["- [laughs]", "- Yeah."])).toEqual(["Yeah."]);
    expect(cleanCue(["- Hey!", "- (gasps)", "- What?"])).toEqual(["- Hey!", "- What?"]);
  });

  it("keeps each line's times, drops emptied cues and numbers SRT again; ASS events and VTT cues alike", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\n[door opens]\n\n2\n00:00:03,000 --> 00:00:04,500\nJOHN: Hello.\n\n3\n00:00:05,000 --> 00:00:06,000\nBye.\n";
    expect(withoutSounds(srt, ".srt")).toBe("1\n00:00:03,000 --> 00:00:04,500\nHello.\n\n2\n00:00:05,000 --> 00:00:06,000\nBye.\n");
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n(sighs)\n\n00:00:03.000 --> 00:00:04.000\n[NAME] Hi.\n";
    expect(withoutSounds(vtt, ".vtt")).toBe("WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nHi.\n");
    const ass = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,[thunder]\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\i1}[NAME] Run!{\\i0}\\N- (gasps)";
    expect(withoutSounds(ass, ".ass")).toBe("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\i1}Run!{\\i0}");
  });
});
