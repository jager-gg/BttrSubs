/**
 * Sound descriptions and speaker names taken out of a subtitle's text, for viewers who don't want them
 * (Settings.dropSounds): what hearing-impaired subtitles and dub captions add beside the dialogue.
 * Only the text changes: a line that is left empty is dropped, and every other line keeps its times.
 *
 * What is taken out:
 * - [bracketed] text, anywhere in a line: "[door creaks]", "[in Japanese]";
 * - a line that is a (parenthesised) description alone, in lower case or capitals: "(laughs)", "(BUZZES)";
 * - a description in capitals in parentheses opening a line: "(SIGHS) Fine.";
 * - a speaker's name in capitals before a colon opening a line: "JOHN: Wait.", "MAN 2: Over here.";
 * - a sung line, marked by a music sign at its start or end ("♪ la la ♪"), and a song's whole cue.
 * Parentheses inside a line ("I (think) so"), a parenthesised line in normal case or without letter
 * case, and names in mixed case ("Mom: …") stay: in translations they are as often part of what is
 * said or shown.
 *
 * A subtitle that labels its speakers in normal case throughout (labelsSpeakers: captions written for
 * hearing them) is read by its own style: there a label in normal case opening a turn goes ("Aldo: …",
 * "porter: …", "Aldo and Bree: …"), and so does a parenthesised part opening a turn in a script with
 * letter case ("( Kettle whistles )", "(Yawns) Fine.").
 */

/*
 * What may come before a line's words, in the patterns below: a speaker's dash (any dash), spaces and
 * direction marks (subtitles in right-to-left scripts open their lines with them).
 */
/** A line sung, by a music sign at either end. */
const SUNG = /^[-‐–—\s\u200e\u200f\u202a-\u202e\u2066-\u2069]*[♪♫♬]|[♪♫♬][\s\u200e\u200f\u202a-\u202e\u2066-\u2069]*$/u;
/** Bracketed text of two characters or more, with the spaces after it. */
const BRACKETED = /\[[^[\]]{2,}\]\s*/gu;
/**
 * A line of a parenthesised description alone, written in lower case ("(grunts)", "(engine revving)")
 * or in capitals ("(BUZZES)"). In normal case it is as often a name on screen or a thought ("(Kate)",
 * "(He's late again.)"), and a script without case (Arabic) can't tell: those stay.
 */
const PARENTHESISED_LINE = /^[-‐–—\s\u200e\u200f\u202a-\u202e\u2066-\u2069]*\((?:(?=\P{Lu}*\)[\s.!?]*$)\p{Ll}[^()]*|(?=[^()\p{Ll}]*\p{Lu})[^()\p{Ll}]{2,})\)[\s.!?]*$/u;
/** A description in capitals in parentheses at a line's start: no lower-case letter inside. */
const LEADING_CAPITALS = /^([-‐–—\s\u200e\u200f\u202a-\u202e\u2066-\u2069]*)\((?=[^()]*\p{Lu})[^()\p{Ll}]{2,}\)\s*/u;
/**
 * A speaker's name in capitals before a colon at a line's start ("JOHN:", "DR. SMITH:", "MAN 2:"),
 * never a time ("10:30"). Taken only when spoken words in normal case follow, or nothing: a line in
 * capitals after it is text on screen ("UNLOCKED: FABRIC").
 */
const SPEAKER = /^([-‐–—\s\u200e\u200f\u202a-\u202e\u2066-\u2069]*)(?=\p{Lu}[\p{Lu}\d .'&-]*\p{Lu})\p{Lu}[\p{Lu}\d .'&-]{1,30}:(?!\d)(?=\s*$|.*\p{Ll})\s*/u;

/**
 * A label opening a line, in normal case: one to three words, one of them with a lower-case letter, and
 * a number when it names one of several ("Guard #2", "Man 2"), before a colon and a space.
 */
const NORMAL_LABEL = /^(?:[-‐–—\s‎‏‪-‮⁦-⁩]|\\h)*((?=[^:]*\p{Ll})\p{L}[\p{L}\p{M}'’.&-]*(?: \p{L}[\p{L}\p{M}'’.&-]*){0,2}(?: ?#?\d{1,2})?):(?=\s|$)/u;
/** What opens a turn before its words: a speaker's dash, spaces (an ASS script's hard space, \h, too), direction marks. */
const TURN_HEAD = /^(?:[-‐–—\s‎‏‪-‮⁦-⁩]|\\h)*/u;
/** A parenthesised part opening a turn, in a script with letter case ("( Kettle whistles )", "(Yawns)"). */
const OPENING_PARENTHESISED = /^\(\s*(?=[\p{Lu}\p{Ll}])[^()]{2,}\)\s*/u;
/**
 * A parenthesised part closing a turn ("Hmm? ( Gasps )"). Calibration (the 43 subtitles below): every
 * one of the 101 lines that hold one once their labels and opening parts are taken closes on a sound
 * (30 different ones).
 */
const CLOSING_PARENTHESISED = /\s*\(\s*(?=[\p{Lu}\p{Ll}])[^()]{2,}\)\s*$/u;
/**
 * A label in normal case opening a turn, whatever follows it ("Aldo: WHAT?!"): only a label in
 * capitals can be text on screen ("UNLOCKED: FABRIC"), and those are SPEAKER's.
 */
const OPENING_LABEL = /^(?=[^:]*\p{Ll})\p{L}[\p{L}\p{M}'’.&-]*(?: \p{L}[\p{L}\p{M}'’.&-]*){0,2}(?: ?#?\d{1,2})?:(?=\s|$)\s*/u;

/**
 * Lines labelled in normal case, and such labels used three times or more, at or past which a
 * subtitle labels its speakers. Calibration (991 cached subtitles of 50 lines or more): the 43 that
 * label their speakers in normal case held 76 to 188 such lines and 3 to 14 labels used three times
 * or more; in every other one, words before a colon opened at most 14 lines (phrases said before
 * what they announce, the names of spells), with at most 2 such labels used three times. In those
 * 43, each of the 37 labels used less often and not written as a name ("narrator:", two speakers at
 * once, a name in lower case) is a speaker's, so every label opening a turn there is taken.
 */
const LABELLED_LINES = 20;
const LABELS_USED = 3;

/**
 * Whether a subtitle's lines label their speakers in normal case throughout, as captions written for
 * hearing them may ("Aldo: …"). Labels in capitals ("JOHN:") are taken in any subtitle (SPEAKER); a
 * subtitle labelled in capitals isn't one of these, so a phrase before a colon in it ("Here's the
 * thing: …") stays.
 */
export function labelsSpeakers(lines: string[]): boolean {
  const uses = new Map<string, number>();
  let labelled = 0;
  for (const line of lines) {
    const label = NORMAL_LABEL.exec(visible(line))?.[1]?.toLowerCase();
    if (!label) continue;
    labelled++;
    uses.set(label, (uses.get(label) ?? 0) + 1);
  }
  return labelled >= LABELLED_LINES && [...uses.values()].filter((n) => n >= 3).length >= LABELS_USED;
}

/**
 * A line of a subtitle that labels its speakers, without the labels opening its turns and the
 * parenthesised parts opening or closing them. A line holds one turn, or more each opened by a
 * speaker's dash after a space; a turn left with no words goes with its dash. Dashes inside what is
 * said ("Wait -", "I -- no") stay.
 */
function withoutTurnLabels(words: string): string {
  const opening = (rest: string): string => {
    const sound = OPENING_PARENTHESISED.exec(rest);
    if (sound) return rest.slice(sound[0].length);
    const label = OPENING_LABEL.exec(rest);
    return label ? rest.slice(label[0].length) : rest;
  };
  const turns = words.split(/(?<=\s)(?=[-‐–—]\s)/u).map((turn) => {
    const head = TURN_HEAD.exec(turn)?.[0] ?? "";
    let rest = turn.slice(head.length);
    // A turn can open with both ("( Bree gasps ) Aldo: …").
    for (let i = 0; i < 3; i++) {
      const next = opening(rest);
      if (next === rest) break;
      rest = next;
    }
    // The spaces before the next turn's dash stay.
    const closed = rest.replace(CLOSING_PARENTHESISED, "");
    if (closed !== rest) rest = closed + (/\s+$/u.exec(rest)?.[0] ?? "");
    return head + rest;
  });
  const said = turns.filter((turn) => /[\p{L}\p{N}]/u.test(visible(turn)));
  return said.length === turns.length ? turns.join("") : said.join("").trimEnd();
}

/** A text line's visible words: tags (SRT's <i>, ASS's {…}) and spaces aside. */
const visible = (line: string) => line.replace(/<[^>]*>|\{[^}]*\}/g, "").trim();

/**
 * One text line without its sound descriptions and speaker name; "" when nothing is left of it.
 * `labelled`: the subtitle the line is from labels its speakers in normal case (labelsSpeakers).
 */
export function cleanLine(line: string, labelled = false): string {
  // Tags at the line's start and end stay around what is left ("<i>[music]</i>" leaves nothing).
  const open = /^(?:\s*(?:<[^>]*>|\{[^}]*\}))*/.exec(line)?.[0] ?? "";
  const close = /(?:(?:<[^>]*>|\{[^}]*\})\s*)*$/.exec(line.slice(open.length))?.[0] ?? "";
  const words = line.slice(open.length, line.length - close.length);
  if (SUNG.test(visible(words)) || PARENTHESISED_LINE.test(visible(words))) return "";
  const plain = words.replace(BRACKETED, "").replace(LEADING_CAPITALS, "$1").replace(SPEAKER, "$1");
  const kept = labelled ? withoutTurnLabels(plain) : plain;
  if (kept === words) return line;
  // Nothing left but a dash or a mark: the line was the description alone.
  if (!/[\p{L}\p{N}]/u.test(visible(kept))) return "";
  return `${open}${kept.trimEnd()}${close}`;
}

/**
 * A cue's text lines without their sound descriptions. One line left of a two-speaker cue loses its
 * dash ("- [laughs]" / "- Yeah." becomes "Yeah."). Empty when nothing is left.
 */
export function cleanCue(lines: string[], labelled = false): string[] {
  // A song's cue opens and closes with a music sign; its lines between have none.
  if (lines.length > 1 && SUNG.test(visible(lines[0])) && SUNG.test(visible(lines[lines.length - 1]))) return [];
  const kept = lines.map((line) => cleanLine(line, labelled)).filter((l) => visible(l) !== "");
  if (kept.length === 1 && lines.length > 1) kept[0] = kept[0].replace(/^((?:\s*(?:<[^>]*>|\{[^}]*\}))*)\s*-\s*/, "$1");
  return kept;
}

/** An SRT or VTT subtitle without its sound descriptions; a cue left empty is dropped and the rest renumbered (SRT). */
function cleanBlocks(text: string, vtt: boolean): string {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  // A cue's text lines; an empty one (the file's last newline) isn't one of them.
  const cueText = (rows: string[]) => {
    const at = rows.findIndex((r) => r.includes("-->"));
    return at === -1 ? [] : rows.slice(at + 1).filter((r) => r.trim() !== "");
  };
  const labelled = labelsSpeakers(blocks.flatMap((block) => cueText(block.split("\n"))));
  const out: string[] = [];
  let n = 0;
  for (const block of blocks) {
    const rows = block.split("\n");
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at === -1) {
      if (block.trim()) out.push(block); // a VTT header or note, kept as it is
      continue;
    }
    const words = cleanCue(cueText(rows), labelled);
    if (!words.length) continue;
    n++;
    const head = vtt ? rows.slice(0, at + 1) : [String(n), rows[at]];
    out.push([...head, ...words].join("\n"));
  }
  return `${out.join("\n\n")}\n`;
}

/** An ASS or SSA script without its sound descriptions: an event whose text is left empty is dropped. */
function cleanAss(text: string): string {
  const rows = text.split(/\r?\n/);
  const event = (row: string) => /^(Dialogue:(?:[^,]*,){9})(.*)$/.exec(row);
  const labelled = labelsSpeakers(rows.flatMap((row) => event(row)?.[2].split("\\N") ?? []));
  return rows
    .flatMap((row) => {
      const m = event(row);
      if (!m) return [row];
      const words = cleanCue(m[2].split("\\N"), labelled);
      return words.length ? [`${m[1]}${words.join("\\N")}`] : [];
    })
    .join("\n");
}

/** The subtitle without sound descriptions and speaker names, in its own format (by extension). */
export function withoutSounds(text: string, ext: string): string {
  const kind = ext.toLowerCase();
  if (kind === ".ass" || kind === ".ssa") return cleanAss(text);
  return cleanBlocks(text, kind === ".vtt");
}
