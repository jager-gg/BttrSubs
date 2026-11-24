import { describe, expect, it } from "vitest";
import { cleanCue, cleanLine, labelsSpeakers, withoutSounds } from "../src/clean.js";

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

  it("keeps the dash of the last cue's one line: the file's last newline isn't a second line", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\n[door opens]\n\n2\n00:00:03,000 --> 00:00:04,000\n- Hi. - Bye.\n";
    expect(withoutSounds(srt, ".srt")).toBe("1\n00:00:03,000 --> 00:00:04,000\n- Hi. - Bye.\n");
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

describe("a subtitle that labels its speakers in normal case", () => {
  /** Captions written for hearing them: each line opens with who speaks, sounds in parentheses. */
  const captions = (extra: string[] = []): string[] => {
    const said = ["Where were you?", "At the station.", "We should go.", "Not yet!"];
    const names = ["Aldo", "Bree", "Cass", "Dov"];
    return [...Array.from({ length: 24 }, (_, i) => `${names[i % 4]}: ${said[i % 4]}`), "( Bree gasps )", "( Kettle whistles )", ...extra];
  };
  const srt = (lines: string[]) => lines.map((line, i) => `${i + 1}\n00:00:${String(i + 10).padStart(2, "0")},000 --> 00:00:${String(i + 10).padStart(2, "0")},900\n${line}`).join("\n\n") + "\n";
  const textOf = (out: string) => out.trimEnd().split("\n\n").map((block) => block.split("\n").slice(2).join("\n"));
  const cleaned = (extra: string[]) => textOf(withoutSounds(srt(captions(extra)), ".srt"));

  it("is told by its labels: twenty lines labelled in normal case or more, three such labels used three times or more", () => {
    expect(labelsSpeakers(captions())).toBe(true);
    // A few labels in a translation, or phrases before a colon, don't make it one; nor do labels in capitals.
    expect(labelsSpeakers(["Mom: dinner's ready", "he said: no", ...Array.from({ length: 40 }, (_, i) => `Line ${i}.`)])).toBe(false);
    expect(labelsSpeakers(Array.from({ length: 30 }, (_, i) => `Speaker${i}: hello`))).toBe(false);
    expect(labelsSpeakers(Array.from({ length: 30 }, (_, i) => `${["ALDO", "BREE", "CASS"][i % 3]}: Hello.`))).toBe(false);
  });

  it("loses the labels in normal case and parenthesised sounds opening each turn, whatever follows", () => {
    const out = cleaned(["Porter: Ahoy there!", "( Cass groaning ) Not now, I...", "- aldo: Ready? - Bree: Go on, then!", "- ( Dov yawns ) - ( Aldo gasps )", "(Yawns) Fine.", "Dr. Vance: Sit down.", "narrator: Years passed.", "Aldo and bree: What?!", "Cass: WHAT?!", "Dov: 500?!", "Hmm? ( Gasps )", "- Run--( Gags ) - Now!", "Guard #2: Halt!", "- Man 2: Here. - girl #1: There!", "\\h\\h- Cass: WHO?"]);
    expect(out.slice(0, 4)).toEqual(["Where were you?", "At the station.", "We should go.", "Not yet!"]);
    expect(out).not.toContain("( Bree gasps )");
    expect(out).not.toContain("( Kettle whistles )");
    for (const line of ["Ahoy there!", "Not now, I...", "- Ready? - Go on, then!", "Fine.", "Sit down.", "Years passed.", "What?!", "WHAT?!", "500?!", "Hmm?", "- Run-- - Now!", "Halt!", "- Here. - There!", "\\h\\h- WHO?"]) expect(out, line).toContain(line);
    expect(out.some((line) => /yawns|gasps|Aldo:|Bree:|:\s/.test(line))).toBe(false);
  });

  it("keeps the dashes inside what is said", () => {
    const said = ["Wait, I left it -", "I -- no, never mind.", "Yes - I mean, no."];
    const out = cleaned(said);
    for (const line of said) expect(out, line).toContain(line);
  });

  it("keeps phrases before a colon in a subtitle labelled in capitals: only its capitals are labels", () => {
    const sdh = [...Array.from({ length: 24 }, (_, i) => `${["ALDO", "BREE", "CASS"][i % 3]}: Hello there.`), "Here's the thing: we wait.", "Listen to me:", "Translation: not today."];
    const out = textOf(withoutSounds(srt(sdh), ".srt"));
    expect(out[0]).toBe("Hello there.");
    for (const line of sdh.slice(24)) expect(out, line).toContain(line);
  });

  it("keeps the same lines where a subtitle doesn't label its speakers, and in a script without letter case", () => {
    const note = ["(Meet me at noon)", "(Bring the map)", "Mom: dinner's ready", "(Kate)"];
    expect(withoutSounds(srt(note), ".srt")).toBe(srt(note));
    // Labelled, but its parenthesised name is in a script without case: it stays.
    expect(cleaned(["(ليلى)"])).toContain("(ليلى)");
    // Text on screen in capitals after a label stays, as in any subtitle.
    expect(cleaned(["NEXT EPISODE: FIRST CONTACT"])).toContain("NEXT EPISODE: FIRST CONTACT");
  });

  it("reads an ASS script's events by the same style", () => {
    const head = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
    const events = captions().map((line) => `Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${line}`);
    const out = withoutSounds(head + events.join("\n"), ".ass");
    expect(out).toContain(",,Where were you?");
    expect(out).not.toMatch(/Aldo:|Kettle whistles/);
  });
});

