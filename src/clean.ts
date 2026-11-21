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

/** A text line's visible words: tags (SRT's <i>, ASS's {…}) and spaces aside. */
const visible = (line: string) => line.replace(/<[^>]*>|\{[^}]*\}/g, "").trim();

/** One text line without its sound descriptions and speaker name; "" when nothing is left of it. */
export function cleanLine(line: string): string {
  // Tags at the line's start and end stay around what is left ("<i>[music]</i>" leaves nothing).
  const open = /^(?:\s*(?:<[^>]*>|\{[^}]*\}))*/.exec(line)?.[0] ?? "";
  const close = /(?:(?:<[^>]*>|\{[^}]*\})\s*)*$/.exec(line.slice(open.length))?.[0] ?? "";
  const words = line.slice(open.length, line.length - close.length);
  if (SUNG.test(visible(words)) || PARENTHESISED_LINE.test(visible(words))) return "";
  const kept = words.replace(BRACKETED, "").replace(LEADING_CAPITALS, "$1").replace(SPEAKER, "$1");
  if (kept === words) return line;
  // Nothing left but a dash or a mark: the line was the description alone.
  if (!/[\p{L}\p{N}]/u.test(visible(kept))) return "";
  return `${open}${kept.trimEnd()}${close}`;
}

/**
 * A cue's text lines without their sound descriptions. One line left of a two-speaker cue loses its
 * dash ("- [laughs]" / "- Yeah." becomes "Yeah."). Empty when nothing is left.
 */
export function cleanCue(lines: string[]): string[] {
  // A song's cue opens and closes with a music sign; its lines between have none.
  if (lines.length > 1 && SUNG.test(visible(lines[0])) && SUNG.test(visible(lines[lines.length - 1]))) return [];
  const kept = lines.map(cleanLine).filter((l) => visible(l) !== "");
  if (kept.length === 1 && lines.length > 1) kept[0] = kept[0].replace(/^((?:\s*(?:<[^>]*>|\{[^}]*\}))*)\s*-\s*/, "$1");
  return kept;
}

/** An SRT or VTT subtitle without its sound descriptions; a cue left empty is dropped and the rest renumbered (SRT). */
function cleanBlocks(text: string, vtt: boolean): string {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const out: string[] = [];
  let n = 0;
  for (const block of blocks) {
    const rows = block.split("\n");
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at === -1) {
      if (block.trim()) out.push(block); // a VTT header or note, kept as it is
      continue;
    }
    const words = cleanCue(rows.slice(at + 1));
    if (!words.length) continue;
    n++;
    const head = vtt ? rows.slice(0, at + 1) : [String(n), rows[at]];
    out.push([...head, ...words].join("\n"));
  }
  return `${out.join("\n\n")}\n`;
}

/** An ASS or SSA script without its sound descriptions: an event whose text is left empty is dropped. */
function cleanAss(text: string): string {
  return text
    .split(/\r?\n/)
    .flatMap((row) => {
      const m = /^(Dialogue:(?:[^,]*,){9})(.*)$/.exec(row);
      if (!m) return [row];
      const words = cleanCue(m[2].split("\\N"));
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
