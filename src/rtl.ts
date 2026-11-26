/**
 * Right-to-left signs typed in screen order.
 *
 * A sign coloured letter by letter is one line cut into runs by tags. Renderers disagree on how such a
 * line is ordered. libass draws the runs one after another from left to right, each run right-to-left
 * within itself; a renderer that hands the whole line to a text layout orders all of it as right-to-left
 * text, the last run leftmost. Signs are typed for the first kind: the run that stands leftmost is typed
 * first, so the text reads backwards run by run, with joining strokes (tatweel) typed in by hand where
 * letters should meet, and the second kind draws it turned round.
 *
 * Such a line is told by the script's own rules, in the reading as typed: a word that begins with a
 * letter that only ends words (teh marbuta, alef maksura) or with a joining stroke, or has a joining
 * stroke after a letter that joins nothing after it. Where the reading as typed has such words and the
 * reading with the runs turned round has none, the line is typed in screen order.
 *
 * It keeps its order, and says so: the line is wrapped as left-to-right text (U+202A, U+202C) with a
 * left-to-right mark (U+200E) at the start of every run. The marks have no width and draw nothing. A
 * renderer that orders the whole line then keeps the runs from left to right, as libass does without
 * them; within a run nothing changes.
 * Calibration (272 right-to-left lines in several runs, over 153 subtitles): 252 are typed in screen
 * order by these rules, and every one of the 252 reads, turned round, as words of its own subtitle's
 * dialogue; the other 20 read right as typed, and none is undecided.
 */
import { at, parseScript, writeScript } from "./signs.js";

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const MARKS = /[\u064b-\u065f\u0670\u06d6-\u06ed]/g;
const TATWEEL = /\u0640/g;
/** A letter that joins nothing after it, with a joining stroke after it. */
const NO_JOIN_AFTER = /[\u0621-\u0625\u0627\u0629\u062f-\u0632\u0648\u0649]\u0640/;
/** A word's first character that no word begins with: teh marbuta, alef maksura, a joining stroke. */
const NEVER_FIRST = /^[\u0629\u0649\u0640]/;
/** Left-to-right mark, and the pair that wraps text as left-to-right. */
const LRM = "\u200e";
const LTR_OPEN = "\u202a";
const LTR_CLOSE = "\u202c";

/** How many words of a reading can't be words, by the script's rules. */
function impossible(text: string): number {
  return text
    .split(/[^\u0600-\u06ff\ufb50-\ufefc]+/u)
    .map((word) => word.replace(MARKS, ""))
    .filter((word) => word.replace(TATWEEL, "").length > 1 && (NEVER_FIRST.test(word) || NO_JOIN_AFTER.test(word))).length;
}

/** A run with the spaces at its edges apart: they stand where they are typed, taking the line's direction, not the run's. */
const unitsOf = (run: string): string[] => {
  const core = run.trim();
  return [/^\s+/.exec(run)?.[0] ?? "", core, core ? (/\s+$/.exec(run)?.[0] ?? "") : ""].filter((unit) => unit.length > 0);
};

/** Whether a line's runs (its text between tags, in order) are right-to-left text typed in screen order. */
export function typedInScreenOrder(runs: string[]): boolean {
  if (runs.filter((run) => RTL.test(run)).length < 2 || runs.some((run) => /[A-Za-z0-9]/.test(run))) return false;
  const units = runs.flatMap(unitsOf);
  return impossible(units.join("")) > 0 && impossible([...units].reverse().join("")) === 0;
}

/**
 * An event's text with the lines of it typed in screen order marked as left-to-right runs; undefined
 * when no line of it is, or it is marked already.
 */
export function eventKeptInScreenOrder(text: string): string | undefined {
  if (!RTL.test(text) || !text.includes("{") || text.includes(LTR_OPEN)) return undefined;
  // Each line (the text between line breaks) as its pieces in order: a tag block, or a run of text.
  const lines: Array<Array<{ tags?: string; run?: string }>> = [[]];
  let rest = text;
  while (rest.length) {
    const open = rest.indexOf("{");
    const plain = open < 0 ? rest : rest.slice(0, open);
    plain.split(/(\\[Nn])/).forEach((part) => {
      if (/^\\[Nn]$/.test(part)) lines.push([{ tags: part }]);
      else if (part) lines[lines.length - 1].push({ run: part });
    });
    if (open < 0) break;
    const close = rest.indexOf("}", open);
    if (close < 0) return undefined;
    const tags = rest.slice(open, close + 1);
    // A drawing's "text" is its outline, not words.
    if (/\\p[1-9]/.test(tags)) return undefined;
    lines[lines.length - 1].push({ tags });
    rest = rest.slice(close + 1);
  }
  let marked = false;
  const out = lines.map((pieces) => {
    const runs = pieces.filter((piece) => piece.run !== undefined);
    if (!typedInScreenOrder(runs.map((piece) => piece.run!))) return pieces.map((piece) => piece.tags ?? piece.run).join("");
    marked = true;
    const [first, last] = [runs[0], runs[runs.length - 1]];
    return pieces.map((piece) => (piece.run === undefined ? piece.tags : `${piece === first ? LTR_OPEN : ""}${LRM}${piece.run}${piece === last ? LTR_CLOSE : ""}`)).join("");
  });
  return marked ? out.join("") : undefined;
}

/** A script with its right-to-left signs typed in screen order marked so (eventKeptInScreenOrder); undefined when it has none to mark. */
export function keptInScreenOrder(script: string): { text: string; lines: number } | undefined {
  if (!RTL.test(script)) return undefined;
  const parsed = parseScript(script);
  if (!parsed) return undefined;
  const tx = at(parsed.eventFormat, "Text");
  let lines = 0;
  for (const event of parsed.events) {
    if (event.kind !== "Dialogue") continue;
    const better = eventKeptInScreenOrder(event.values[tx] ?? "");
    if (better === undefined) continue;
    event.values[tx] = better;
    lines++;
  }
  return lines ? { text: writeScript(parsed), lines } : undefined;
}

/** The mark that opens text wrapped as right-to-left (LTR_CLOSE ends it). */
const RTL_OPEN = "\u202b";
/** Every mark that sets a direction: a line that has one already is left as typed. */
const DIRECTION_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** Whether a line's first letter is a right-to-left one: the direction the line reads in. */
const startsRightToLeft = (line: string): boolean => {
  const first = /\p{L}/u.exec(line)?.[0];
  return first !== undefined && RTL.test(first);
};

/**
 * An event's text with its right-to-left lines wrapped as right-to-left text (U+202B, U+202C);
 * undefined when it has none to wrap.
 *
 * A renderer lays a line out left to right unless told otherwise, and then a right-to-left line's
 * punctuation at its ends, which has no direction of its own, stands on the wrong side: the full stop
 * that ends the sentence at its start, the dash that opens it at its end. Wrapped, the whole line reads
 * right to left, as it does in a player that takes a line's direction from its first letter. Only a
 * line of one run of text is wrapped (tags before it and after it, none inside): renderers order the
 * runs of a line cut by tags differently (see above). A line with a direction mark of its own, or a
 * drawing, is left as it is.
 */
export function eventReadRightToLeft(text: string): string | undefined {
  if (!RTL.test(text) || DIRECTION_MARKS.test(text) || /\\p[1-9]/.test(text)) return undefined;
  let wrapped = false;
  const out = text.split(/(\\[Nn])/).map((line) => {
    if (/^\\[Nn]$/.test(line)) return line;
    const parts = /^((?:\{[^}]*\})*)([^{}]*)((?:\{[^}]*\})*)$/.exec(line);
    if (!parts || !parts[2].trim() || !startsRightToLeft(parts[2])) return line;
    wrapped = true;
    return `${parts[1]}${RTL_OPEN}${parts[2]}${LTR_CLOSE}${parts[3]}`;
  });
  return wrapped ? out.join("") : undefined;
}

/** A script with its right-to-left lines wrapped as right-to-left text (eventReadRightToLeft); undefined when it has none to wrap. */
export function readRightToLeft(script: string): { text: string; lines: number } | undefined {
  if (!RTL.test(script)) return undefined;
  const parsed = parseScript(script);
  if (!parsed) return undefined;
  const tx = at(parsed.eventFormat, "Text");
  let lines = 0;
  for (const event of parsed.events) {
    if (event.kind !== "Dialogue") continue;
    const better = eventReadRightToLeft(event.values[tx] ?? "");
    if (better === undefined) continue;
    event.values[tx] = better;
    lines++;
  }
  return lines ? { text: writeScript(parsed), lines } : undefined;
}
