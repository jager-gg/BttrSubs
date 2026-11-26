/**
 * Right-to-left signs typed in screen order (rtl.ts): told by the script's own rules, and marked as
 * left-to-right runs so that a renderer ordering the whole line keeps them as typed.
 */
import { describe, expect, it } from "vitest";
import { eventKeptInScreenOrder, eventReadRightToLeft, keptInScreenOrder, readRightToLeft, typedInScreenOrder } from "../src/rtl.js";

const LRM = "\u200e";
const OPEN = "\u202a";
const CLOSE = "\u202c";
const T = "\u0640"; // tatweel, the joining stroke

// Two words in reading order, a run a letter, joining strokes typed where letters meet:
// meem-dal-yeh-noon-teh marbuta, space, sad-ghain-yeh-reh-teh marbuta.
const READING = [`\u0645${T}`, `${T}\u062f`, `\u064a${T}`, `${T}\u0646${T}`, `${T}\u0629`, " ", `\u0635${T}`, `${T}\u063a${T}`, `${T}\u064a${T}`, `${T}\u0631`, "\u0629"];
// As a sign is typed for a renderer that draws its runs from left to right: the leftmost run first.
const SCREEN = [...READING].reverse();
const tagged = (runs: string[], first = "\\pos(640,100)\\fs90") => runs.map((run, n) => `{${n === 0 ? first : ""}\\c&H${(n % 3) + 1}0&}${run}`).join("");
const unmarked = (text: string) => text.replaceAll(LRM, "").replaceAll(OPEN, "").replaceAll(CLOSE, "");

describe("a right-to-left line in several tagged runs", () => {
  it("is told as typed in screen order by words that can't be words as typed and can be, turned round", () => {
    expect(typedInScreenOrder(SCREEN)).toBe(true);
    expect(typedInScreenOrder(READING)).toBe(false);
    // One run, or one right-to-left run among spaces, has no order to tell.
    expect(typedInScreenOrder([SCREEN.join("")])).toBe(false);
    expect(typedInScreenOrder([" ", "\u0629", " "])).toBe(false);
    // Left-to-right text in the line is left alone: its place among the runs isn't this rule's to judge.
    expect(typedInScreenOrder([...SCREEN, "2"])).toBe(false);
    expect(typedInScreenOrder(["A", ...SCREEN])).toBe(false);
    // Runs that read as words either way (no joining strokes, no final-only letter leading) aren't judged.
    expect(typedInScreenOrder(["\u0628", "\u0627", "\u0628"])).toBe(false);
    // Nor are runs that can't be words in either order: turning them round would mend nothing.
    expect(typedInScreenOrder(["\u0629", `${T}\u0628`, "\u0629"])).toBe(false);
  });

  it("keeps its order and says so: wrapped as left-to-right, a mark at the start of every run, nothing else changed", () => {
    const typed = tagged(SCREEN);
    const kept = eventKeptInScreenOrder(typed)!;
    expect(unmarked(kept)).toBe(typed);
    // Every run starts with a mark, straight after its tags; the wrap opens the first and closes the last.
    const runs = kept.split(/\{[^}]*\}/).slice(1);
    expect(runs).toHaveLength(SCREEN.length);
    expect(runs.every((run) => run.replace(OPEN, "").startsWith(LRM))).toBe(true);
    expect(runs[0].startsWith(OPEN + LRM)).toBe(true);
    expect(runs[runs.length - 1].endsWith(CLOSE)).toBe(true);
    expect(kept.split(OPEN)).toHaveLength(2);
    expect(kept.split(CLOSE)).toHaveLength(2);
    expect(kept.split(LRM)).toHaveLength(SCREEN.length + 1);
    // Done once: a marked event is left as it is.
    expect(eventKeptInScreenOrder(kept)).toBeUndefined();
  });

  it("leaves a line typed in reading order, a line in one run, a drawing and text with no tags", () => {
    expect(eventKeptInScreenOrder(tagged(READING))).toBeUndefined();
    expect(eventKeptInScreenOrder(`{\\pos(1,2)}${READING.join("")}`)).toBeUndefined();
    expect(eventKeptInScreenOrder(SCREEN.join(""))).toBeUndefined();
    expect(eventKeptInScreenOrder(`{\\p1}m 0 0 l 10 0{\\p0}${tagged(SCREEN)}`)).toBeUndefined();
    expect(eventKeptInScreenOrder("{\\c&H10&}Sign{\\c&H20&}post")).toBeUndefined();
  });

  it("judges each line of an event on its own", () => {
    const two = `${tagged(SCREEN)}\\N{\\c&H40&}${READING.join("")}`;
    const kept = eventKeptInScreenOrder(two)!;
    const [first, second] = kept.split("\\N");
    expect(first.includes(OPEN) && first.endsWith(CLOSE)).toBe(true);
    expect(second).toBe(`{\\c&H40&}${READING.join("")}`);
    expect(unmarked(kept)).toBe(two);
  });

  it("marks the signs of a whole script, and gives nothing for a script with none", () => {
    const script = (events: string[]) =>
      ["[Script Info]", "ScriptType: v4.00+", "", "[V4+ Styles]", "Format: Name, Fontname, Fontsize", "Style: Signs,Arial,40", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, ""].join("\n");
    const event = (text: string) => `Dialogue: 0,0:00:01.00,0:00:04.00,Signs,,0,0,0,,${text}`;
    const marked = keptInScreenOrder(script([event(tagged(SCREEN)), event(READING.join("")), event(tagged(SCREEN, "\\pos(640,200)")), `Comment: 0,0:00:01.00,0:00:04.00,Signs,,0,0,0,,${tagged(SCREEN)}`]))!;
    expect(marked.lines).toBe(2);
    expect(marked.text.split(OPEN)).toHaveLength(3);
    expect(unmarked(marked.text)).toContain(event(READING.join("")));
    expect(keptInScreenOrder(script([event(tagged(READING)), event("Plain words")]))).toBeUndefined();
    expect(keptInScreenOrder(marked.text)).toBeUndefined();
  });
});

describe("a right-to-left line of dialogue", () => {
  const RTL_OPEN = "‫";
  // Two words and a full stop, and the same after a dash: punctuation with no direction of its own at both ends.
  const SAID = "رائع جدا.";
  const ANSWER = "- لا، مهلا.";

  it("is wrapped as right-to-left text, each line of the event by itself, tags at its ends left outside", () => {
    expect(eventReadRightToLeft(SAID)).toBe(`${RTL_OPEN}${SAID}${CLOSE}`);
    expect(eventReadRightToLeft(`- ${SAID}\\N${ANSWER}`)).toBe(`${RTL_OPEN}- ${SAID}${CLOSE}\\N${RTL_OPEN}${ANSWER}${CLOSE}`);
    expect(eventReadRightToLeft(`{\\i1}${SAID}{\\i0}`)).toBe(`{\\i1}${RTL_OPEN}${SAID}${CLOSE}{\\i0}`);
  });

  it("is left as typed when it reads left to right, has a direction mark already, or is cut by tags inside", () => {
    expect(eventReadRightToLeft("Hello there.")).toBeUndefined();
    // A name first: the line reads left to right, with a right-to-left word inside it.
    expect(eventReadRightToLeft(`Show: ${SAID}`)).toBeUndefined();
    expect(eventReadRightToLeft(`${RTL_OPEN}${SAID}`)).toBeUndefined();
    expect(eventReadRightToLeft(`‏${SAID}`)).toBeUndefined();
    expect(eventReadRightToLeft(`رائع {\\i1}جدا{\\i0}.`)).toBeUndefined();
    expect(eventReadRightToLeft(`{\\p1}m 0 0 l 10 0{\\p0}`)).toBeUndefined();
    // One line of two is right-to-left: only that one is wrapped.
    expect(eventReadRightToLeft(`Hello.\\N${SAID}`)).toBe(`Hello.\\N${RTL_OPEN}${SAID}${CLOSE}`);
  });

  it("is wrapped in a whole script, a sign marked as typed in screen order left as it is", () => {
    const script = (lines: string[]) =>
      ["[Script Info]", "ScriptType: v4.00+", "", "[V4+ Styles]", "Format: Name, Fontname, Fontsize", "Style: Default,Arial,40", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...lines.map((text) => `Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${text}`), ""].join("\n");
    const sign = eventKeptInScreenOrder(tagged(SCREEN))!;
    const out = readRightToLeft(script([SAID, "Hello.", sign]));
    expect(out?.lines).toBe(1);
    expect(out?.text).toContain(`,,${RTL_OPEN}${SAID}${CLOSE}`);
    expect(out?.text).toContain(`,,Hello.`);
    expect(out?.text).toContain(sign);
    expect(readRightToLeft(script(["Hello."]))).toBeUndefined();
  });
});
