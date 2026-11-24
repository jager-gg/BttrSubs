/**
 * Signs & songs with English Dub, and English in the playing file's own subtitle style.
 *
 * Dub captions carry the dub's words, not the on-screen text a fansub typesets for the original
 * (signs, captions, song lines). A release's signs track has those: timed to the playing file
 * (signsjob.ts), it is merged here with the dub's lines into one ASS script, the signs as typeset
 * and the dub's lines in a style of their own: the file's own subtitle style (read from its header)
 * when that is asked for and the file has one, else the plain or chosen look. Where both carry the
 * same thing, one copy goes: the dub's written-out signs and song placeholders, or the release's
 * song lines where the dub sings the song itself.
 */
import { alignmentOf, assStamp, assText, fields, FONTS, PLAIN, PLAIN_HEIGHT, PLAIN_MARGIN, stamp, type Look } from "./srt.js";
import { styleWords } from "./sync.js";

const SONG_WORDS = ["song", "op", "ed", "opening", "ending", "kara", "karaoke", "lyric", "insert", "romaji", "kanji"];
const SIGN_WORDS = new Set([...SONG_WORDS, "sign", "title", "note", "logo", "screen", "text", "credit", "staff", "caption"]);
/**
 * A style named for signs or songs, by its words (sync.ts styleWords): "Sign", "sign_0042", "Ep Title",
 * "OP-Romaji", "ED1", "Credits"; not dialogue in a style such as "top" (overlapping speech placed at the
 * top), "Default" or "Speed".
 */
const SIGN_STYLE = { test: (name: string) => styleWords(name).some((w) => SIGN_WORDS.has(w)) };

/** An ASS (v4+) script by section: [Script Info], [V4+ Styles] and [Events]; any other section is left out. */
export interface Script {
  /** The info lines as written ("PlayResY: 1080"), comments left out. */
  info: string[];
  styleFormat: string[];
  /** Each style's values in styleFormat's order. */
  styles: string[][];
  eventFormat: string[];
  /** Each event's values in eventFormat's order, its text whole. */
  events: Array<{ kind: "Dialogue" | "Comment"; values: string[] }>;
}

export const STYLE_FORMAT = ["Name", "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour", "OutlineColour", "BackColour", "Bold", "Italic", "Underline", "StrikeOut", "ScaleX", "ScaleY", "Spacing", "Angle", "BorderStyle", "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV", "Encoding"];
export const EVENT_FORMAT = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];

/** The style the dub's lines are in, named so no release's own style is taken for it. */
export const DUB_STYLE = "BttrSubs Dub";

/** A script's sections; undefined for one with no [V4+ Styles] (an SSA v4 script's styles and alignments differ). */
export function parseScript(text: string): Script | undefined {
  const script: Script = { info: [], styleFormat: [], styles: [], eventFormat: [], events: [] };
  let section = "";
  let v4plus = false;
  // A leading byte order mark is whitespace to \s.
  for (const raw of text.replace(/^\s+/, "").split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      if (section === "v4+ styles") v4plus = true;
      continue;
    }
    if (!line || line.startsWith(";")) continue;
    if (section === "script info") script.info.push(line);
    else if (section === "v4+ styles") {
      const m = /^(format|style)\s*:\s*(.*)$/i.exec(line);
      if (!m) continue;
      if (m[1].toLowerCase() === "format") script.styleFormat = m[2].split(",").map((f) => f.trim());
      else script.styles.push(fields(m[2], (script.styleFormat.length ? script.styleFormat : STYLE_FORMAT).length).map((v) => v.trim()));
    } else if (section === "events") {
      const m = /^(format|dialogue|comment)\s*:\s?(.*)$/i.exec(raw.replace(/^\s+/, ""));
      if (!m) continue;
      const kind = m[1].toLowerCase();
      if (kind === "format") script.eventFormat = m[2].split(",").map((f) => f.trim());
      else script.events.push({ kind: kind === "comment" ? "Comment" : "Dialogue", values: fields(m[2], (script.eventFormat.length ? script.eventFormat : EVENT_FORMAT).length) });
    }
  }
  if (!v4plus) return undefined;
  if (!script.styleFormat.length) script.styleFormat = [...STYLE_FORMAT];
  if (!script.eventFormat.length) script.eventFormat = [...EVENT_FORMAT];
  return script;
}

export function writeScript(script: Script): string {
  return [
    "[Script Info]",
    ...script.info,
    "",
    "[V4+ Styles]",
    `Format: ${script.styleFormat.join(", ")}`,
    ...script.styles.map((values) => `Style: ${values.join(",")}`),
    "",
    "[Events]",
    `Format: ${script.eventFormat.join(", ")}`,
    ...script.events.map((e) => `${e.kind}: ${e.values.join(",")}`),
    ""
  ].join("\n");
}

const at = (format: string[], name: string) => format.findIndex((f) => f.toLowerCase() === name.toLowerCase());

/** An info line's value ("PlayResY" -> "1080"). */
export function infoValue(script: Script, key: string): string | undefined {
  for (const line of script.info) {
    const i = line.indexOf(":");
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === key.toLowerCase()) return line.slice(i + 1).trim();
  }
  return undefined;
}

function setInfo(script: Script, key: string, value: string): void {
  const i = script.info.findIndex((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase() === key.toLowerCase());
  if (i >= 0) script.info[i] = `${key}: ${value}`;
  else script.info.push(`${key}: ${value}`);
}

/**
 * The script's canvas, as players read it: either size from the other when one is missing (4:3), both
 * missing VSFilter's 384x288. Every size and position in the script is in these units.
 */
export function playRes(script: Script): { x: number; y: number } {
  const x = Number(infoValue(script, "PlayResX")) || 0;
  const y = Number(infoValue(script, "PlayResY")) || 0;
  if (x && y) return { x, y };
  if (y) return { x: y === 1024 ? 1280 : Math.round((y * 4) / 3), y };
  if (x) return { x, y: x === 1280 ? 1024 : Math.round((x * 3) / 4) };
  return { x: 384, y: PLAIN_HEIGHT };
}

// ---------- the file's own style ----------

/** The dialogue style of a subtitle track inside the playing file, and the canvas it is drawn on. */
export interface OwnStyle {
  playResX: number;
  playResY: number;
  /** Its values by field name, lower case ("fontname" -> "Gandhi Sans"). */
  style: Record<string, string>;
}

const NOT_DIALOGUE = /sign|song|forced|karaoke|lyric/i;
const CAPTIONS = /(?:^|[^a-z])(?:cc|sdh|closed[ ._-]?captions?|captions)(?:$|[^a-z])/i;
const DIALOGUE_STYLES = ["default", "main", "dialogue", "dialog"];

/**
 * The style of the file's English dialogue subtitles, from a track's ASS header: the default track
 * first, then one named as full subtitles or dialogue, a captions track last; in it the style named as
 * dialogue ("Default", "Main", "Dialogue"), else the first bottom-centred one that isn't a sign's.
 */
export function ownStyleOf(tracks: Array<{ type: string; language: string; name: string; forced: boolean; default: boolean; assHeader?: string }>): OwnStyle | undefined {
  const order = (t: (typeof tracks)[number]) => (CAPTIONS.test(t.name) ? 4 : 0) + (t.default ? 0 : 2) + (/full|dialog/i.test(t.name) ? 0 : 1);
  const candidates = tracks
    .filter((t) => t.type === "subtitle" && t.assHeader && /^(en|eng|und|)$/i.test(t.language) && !t.forced && !NOT_DIALOGUE.test(t.name))
    .sort((a, b) => order(a) - order(b));
  for (const track of candidates) {
    const script = parseScript(track.assHeader!);
    if (!script || !script.styles.length) continue;
    const name = at(script.styleFormat, "Name");
    const alignment = at(script.styleFormat, "Alignment");
    const nameOf = (values: string[]) => (values[name] ?? "").toLowerCase();
    const row =
      DIALOGUE_STYLES.map((n) => script.styles.find((v) => nameOf(v) === n)).find(Boolean) ??
      script.styles.find((v) => /^(default|main|dialog)/.test(nameOf(v))) ??
      script.styles.find((v) => v[alignment] === "2" && !SIGN_STYLE.test(nameOf(v))) ??
      script.styles[0];
    const { x, y } = playRes(script);
    return { playResX: x, playResY: y, style: Object.fromEntries(script.styleFormat.map((f, i) => [f.toLowerCase(), row[i] ?? ""])) };
  }
  return undefined;
}

// ---------- the dub's style ----------

const tenth = (n: number) => String(Math.round(n * 10) / 10);
const DEFAULTS: Record<string, string> = { secondarycolour: "&H000000FF", italic: "0", underline: "0", strikeout: "0", scalex: "100", scaley: "100", spacing: "0", angle: "0", alignment: "2", encoding: "1" };

/**
 * The dub's style row for a script `height` high, in its style format: the file's own style scaled
 * from its canvas, else the look (made for PLAIN_HEIGHT) scaled; raised, its lines at least that share
 * of the height from the bottom.
 */
export function dubStyle(format: string[], height: number, { own, look, raise }: { own?: OwnStyle; look?: Look; raise?: number }): string[] {
  const values: Record<string, string> = {};
  if (own) {
    const k = height / own.playResY;
    Object.assign(values, own.style);
    for (const f of ["fontsize", "outline", "shadow", "spacing"]) if (values[f] !== undefined && values[f] !== "") values[f] = tenth(Number(values[f]) * k);
    for (const f of ["marginl", "marginr", "marginv"]) if (values[f] !== undefined && values[f] !== "") values[f] = String(Math.round(Number(values[f]) * k));
  } else {
    const l = look ?? PLAIN;
    const k = height / PLAIN_HEIGHT;
    Object.assign(values, {
      fontname: l.font, fontsize: tenth(l.size * k), primarycolour: l.colour, outlinecolour: l.outlineColour, backcolour: l.backColour, bold: l.bold ? "-1" : "0",
      italic: l.italic ? "-1" : "0", spacing: tenth((l.spacing ?? 0) * k),
      borderstyle: String(l.border), outline: tenth(l.outline * k), shadow: tenth(l.shadow * k), alignment: String(alignmentOf(l)),
      marginl: String(Math.round(10 * k)), marginr: String(Math.round(10 * k)), marginv: String(Math.round((l.margin ?? PLAIN_MARGIN) * k))
    });
  }
  if (raise) values.marginv = String(Math.max(Number(values.marginv) || 0, Math.round((height * raise) / 100)));
  values.name = DUB_STYLE;
  return format.map((f) => values[f.toLowerCase()] ?? DEFAULTS[f.toLowerCase()] ?? "0");
}

// ---------- the dub's lines ----------

export interface DubLine {
  start: number;
  end: number;
  /** As ASS text: line breaks as \N, italics as tags, a placement (\an8) kept, other tags left out. */
  text: string;
  plain: string;
  /** Placed off the bottom (\an4 to \an9): how captions show on-screen text. */
  placed: boolean;
  /** An event of the dub script's own signs (by its style or its tags). */
  sign: boolean;
}

const KEPT_TAG = /\\an[1-9]/;
const SIGN_TAGS = /\\(?:pos|move)\(|\\p[1-9]|\\[kK][fo]?\d|\\i?clip\(/;

/** Override blocks reduced to a placement and italics, which is what a dub line keeps of its tags. */
function keptTags(text: string): string {
  return text.replace(/\{([^}]*)\}/g, (_all, inner: string) => {
    const kept = [inner.match(KEPT_TAG)?.[0], ...(inner.match(/\\i[01]/g) ?? [])].filter(Boolean).join("");
    return kept ? `{${kept}}` : "";
  });
}

const plainOf = (text: string) => text.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, " ").replace(/\\h/g, " ").replace(/\s+/g, " ").trim();

/** The dub captions' lines, from ASS, SRT or VTT. */
export function dubLines(text: string, ext: string): DubLine[] {
  const out: DubLine[] = [];
  if (/^\.(ass|ssa)$/i.test(ext)) {
    const script = parseScript(text);
    if (!script) return out;
    const [s, e, st, tx] = ["Start", "End", "Style", "Text"].map((f) => at(script.eventFormat, f));
    for (const ev of script.events) {
      if (ev.kind !== "Dialogue") continue;
      const raw = ev.values[tx] ?? "";
      const lineText = keptTags(raw).replace(/\\h/g, " ").trim();
      const plain = plainOf(raw);
      if (!plain) continue;
      out.push({ start: stamp(ev.values[s]), end: stamp(ev.values[e]), text: lineText, plain, placed: /\\an[4-9]/.test(raw), sign: SIGN_STYLE.test(ev.values[st] ?? "") || SIGN_TAGS.test(raw) });
    }
    return out;
  }
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const time = rows.findIndex((r) => r.includes("-->"));
    if (time === -1) continue;
    const [a, b] = rows[time].split("-->");
    const words = rows.slice(time + 1).map((r) => r.trim()).filter(Boolean).join("\n");
    const plain = plainOf(words.replace(/<[^>]*>/g, "").replace(/\n/g, " "));
    if (!plain) continue;
    out.push({ start: stamp(a), end: stamp(b.trim().split(/\s+/)[0]), text: assText(keptTags(words)), plain, placed: /\\an[4-9]/.test(words), sign: false });
  }
  return out;
}

// ---------- the merge ----------

/** A song's lines, by style or karaoke: an opening, ending or insert song, its lyrics or translation. */
const SONG_STYLE = { test: (name: string) => styleWords(name).some((w) => SONG_WORDS.includes(w)) };
const KARAOKE = /\\[kK][fo]?\d/;
/** Song lines this close together are one song. */
const SONG_GAP_MS = 2000;
/** A dub line overlapping a sign by this share of its own length is about that sign. */
const OVERLAP_SHARE = 0.3;
/**
 * A ♪ line with this many words besides its bracketed descriptions is sung. Calibration (an episode's
 * dub captions whose dub sings its songs in English): 54 sung lines, 3 to 10 words each; a placeholder
 * ("♪ ♪", "[♪ upbeat music]") has none.
 */
const SUNG_WORDS = 3;

const words = (plain: string) => (plain.toLowerCase().match(/[a-z][a-z']+/g) ?? []);
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
/** Written in capitals only: how captions spell out a sign ("GUILD HALL, EAST WING"). */
const capitals = (plain: string) => /[A-Z]{3}/.test(plain) && !/[a-z]/.test(plain);
/** Sung words of a line, its ♪ and bracketed descriptions left out. */
const sungWords = (plain: string) => words(plain.replace(/[[(][^\])]*[\])]/g, " ").replace(/♪/g, " ")).length;

export interface MergeResult {
  text: string;
  /** The dub's lines left out as the signs' own copies, its song placeholders, and the release's song lines the dub sings itself. */
  dropped: { dubSigns: number; dubSongs: number; songs: number; heavy?: number; plained?: number };
}

/** A lyric line's copies no further apart than this are one showing of it; further, the line is sung again. */
const LYRIC_GAP_MS = 250;
/** A whole lyric line is at least this long; a letter or a syllable set on its own is shorter. */
const LYRIC_MIN_CHARS = 4;
/** A song with fewer whole lines than this has none to go by: it is set letter by letter only. */
const LYRIC_MIN_LINES = 2;
/** A word alone is a line of its own from this length, in a song that has whole lines; a syllable set on its own is shorter. */
const LYRIC_WORD_CHARS = 6;
/** The outline a plain lyric line gets, in 1080ths of the canvas's height, when its style has none: the effect drew it. */
const LYRIC_OUTLINE = 3;
/** How soft that outline is when the effect's own edge is a coloured glow. */
const LYRIC_GLOW_BLUR = 2;
/** A line that shares this much of its time with a longer line holding its words is that line being written out. */
const LYRIC_PART_SHARE = 0.5;

/**
 * A placement by a line's middle, near the picture's top or bottom, turned into one by the edge it is
 * near: a line too long for the picture then wraps towards the middle, not off the picture. A player
 * without the song's font draws a wider one, and a line that fitted as typeset wraps.
 */
function edgeAnchored(place: string, size: number, height: number): string {
  const m = /^\\an([456])\\pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(place);
  if (!m) return place;
  const y = Number(m[3]);
  if (y > (height * 2) / 3) return `\\an${Number(m[1]) - 3}\\pos(${m[2]},${Math.round(y + size / 2)})`;
  if (y < height / 3) return `\\an${Number(m[1]) + 3}\\pos(${m[2]},${Math.round(y - size / 2)})`;
  return place;
}

const SERIF_FONT = /mincho|(?<!sans[ -]?)serif|roman|times|georgia|garamond|baskerville|caslon|bodoni|didot|minion|palatino|cambria|antiqua|slab/i;
const SANS_FONT = /sans|gothic|grotesk|grotesque|helvet|futura|roboto|lato|montserrat|open ?sans|noto|inter\b|avenir|franklin|myriad|segoe|calibri/i;
const HEAVY_FONT = /bold|black|heavy|ultra/i;

/**
 * The tags that put a plain lyric line in a font most players have, of the kind its song's font is by
 * its name (with or without serifs), bold when the name says a heavy weight. A player without the
 * song's font draws its own default for every line; a font it has keeps a song's lines apart from the
 * dialogue. Nothing for a font most players have already, or a name that tells neither kind.
 */
function commonFont(name: string): string {
  if (Object.values(FONTS).some((f) => f.toLowerCase() === name.trim().toLowerCase())) return "";
  const font = SERIF_FONT.test(name) ? FONTS.georgia : SANS_FONT.test(name) ? FONTS.trebuchet : undefined;
  return font ? `\\fn${font}${HEAVY_FONT.test(name) ? "\\b1" : ""}` : "";
}

interface Shown {
  ev: { kind: "Dialogue" | "Comment"; values: string[] };
  start: number;
  end: number;
  song: boolean;
  plain: string;
}

/**
 * A song's lyric lines without their effects: one event a line for the time the line is on screen, in
 * the song's style and where most of its copies are placed (else where its style puts it; by the
 * picture's edge when near one, edgeAnchored), in a font most players have of the song's kind
 * (commonFont), outlined in the effect's own edge colour
 * when the style leaves the outline to the effect. A karaoke effect sets a line many times over (a
 * copy a frame, a letter an event, shapes drawn around them), and the words are a small part of its
 * weight. Whole lines are the texts with a space in them, or in a script that writes without spaces,
 * and beside those a long word alone; undefined when the song has too few whole lines to stand for it.
 */
function plainLyrics(events: Shown[], format: string[], { outline, size, height, font }: { outline: number; size: number; height: number; font: string }): Shown[] | undefined {
  const [s, e, tx, layer, effect] = ["Start", "End", "Text", "Layer", "Effect"].map((f) => at(format, f));
  const byText = new Map<string, Shown[]>();
  for (const x of events) {
    if (/\\p[1-9]/.test(x.ev.values[tx] ?? "")) continue;
    if ([...x.plain].length < LYRIC_MIN_CHARS) continue;
    byText.set(x.plain, [...(byText.get(x.plain) ?? []), x]);
  }
  const whole = (plain: string) => plain.includes(" ") || /[^\x00-\x7f]/.test(plain);
  if ([...byText.keys()].filter(whole).length < LYRIC_MIN_LINES) return undefined;
  let lines: Shown[] = [];
  for (const [plain, copies] of byText) {
    if (!whole(plain) && [...plain].length < LYRIC_WORD_CHARS) continue;
    // Where the line sits: the placement most of its copies share. A line that moves keeps its alignment
    // alone, unless that is the middle of the picture, where only a placement makes sense.
    const places = new Map<string, number>();
    // The colour around the letters: the outline or shadow colour most of the copies start with (an
    // effect often leaves the style's outline off and draws a glow in a colour of its own).
    const edges = new Map<string, number>();
    for (const x of copies) {
      const text = x.ev.values[tx] ?? "";
      const edge = /\\[34]c&H([0-9A-Fa-f]{6})&?/.exec(text.split("\\t(")[0])?.[1].toUpperCase();
      if (edge) edges.set(edge, (edges.get(edge) ?? 0) + 1);
      const pos = /\\move\(/.test(text) ? undefined : /\\pos\([^)]*\)/.exec(text)?.[0];
      const an = /\\an[1-9]/.exec(text)?.[0] ?? "";
      const place = pos ? an + pos : /\\an[1-37-9]/.test(an) ? an : "";
      places.set(place, (places.get(place) ?? 0) + 1);
    }
    const [place, shared] = [...places].sort((a, b) => b[1] - a[1])[0];
    const edge = [...edges].sort((a, b) => b[1] - a[1])[0]?.[0];
    const drawn = outline ? `${edge ? `\\3c&H${edge}&` : ""}\\bord${outline}${edge ? `\\blur${LYRIC_GLOW_BLUR}` : ""}` : "";
    const tags = `${shared * 2 > copies.length ? edgeAnchored(place, size, height) : (/\\an[1-37-9]/.exec(place)?.[0] ?? "")}${commonFont(font)}${drawn}`;
    let last: Shown | undefined;
    for (const x of copies.sort((a, b) => a.start - b.start)) {
      if (last && x.start <= last.end + LYRIC_GAP_MS) {
        last.end = Math.max(last.end, x.end);
        continue;
      }
      const values = [...x.ev.values];
      values[tx] = `${tags ? `{${tags}}` : ""}${plain}`;
      if (layer >= 0) values[layer] = "0";
      if (effect >= 0) values[effect] = "";
      last = { ev: { kind: "Dialogue", values }, start: x.start, end: x.end, song: true, plain };
      lines.push(last);
    }
  }
  lines = lines.filter((l) => !lines.some((o) => o !== l && o.plain.length > l.plain.length && o.plain.includes(l.plain) && overlap(l, o) >= LYRIC_PART_SHARE * Math.max(1, l.end - l.start)));
  for (const l of lines) {
    l.ev.values[s] = assStamp(l.start);
    l.ev.values[e] = assStamp(l.end);
  }
  return lines.sort((a, b) => a.start - b.start);
}

/**
 * The most a merged script may weigh. A server that hands subtitles on to a player can refuse a big
 * one outright, and the dub's lines go with it. Calibration (a signs track typeset frame by frame,
 * 9,906 events): the script came to 18.4 MB, 447 of its lines the dub's, and a relay with a 5 MB
 * limit answered the player 502 for it three times.
 */
export const MAX_MERGED_BYTES = 4_500_000;

/**
 * The dub's lines and the signs in one script (or the dub's lines alone, in its style, when there are
 * no signs): the signs script's canvas and styles, the dub's lines in DUB_STYLE after them. With
 * signs, the dub script's own sign events go (the release's take their place); a dub line placed off
 * the bottom, or in capitals sharing a word with a sign, during that sign goes as its copy; in a song
 * (the signs' song lines, near ones joined), the dub's ♪ placeholders go, or the release's song lines
 * where the dub sings words of its own. With `maxBytes`, a script too heavy to send is lightened by
 * whole styles, the songs' first and the heaviest first, until it fits: a song keeps its lyric lines
 * without their effects (plainLyrics), or goes when it has no whole lines; a sign style goes. The
 * dub's lines always stay, and a sign style is all there or all gone, never half a sign.
 */
export function mergeWithSigns({ dub, ext, signs, own, look, raise, maxBytes }: { dub: string; ext: string; signs?: Script; own?: OwnStyle; look?: Look; raise?: number; maxBytes?: number }): MergeResult {
  const base: Script = signs
    ? { info: [...signs.info], styleFormat: [...signs.styleFormat], styles: signs.styles.map((v) => [...v]), eventFormat: [...signs.eventFormat], events: signs.events.map((e) => ({ kind: e.kind, values: [...e.values] })) }
    : { info: [`PlayResX: ${own?.playResX ?? 384}`, `PlayResY: ${own?.playResY ?? PLAIN_HEIGHT}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes"], styleFormat: [...STYLE_FORMAT], styles: [], eventFormat: [...EVENT_FORMAT], events: [] };
  setInfo(base, "ScriptType", "v4.00+");
  // The canvas written out: a script without one is drawn on 384x288, and the dub's style is sized for what it is drawn on.
  const canvas = playRes(base);
  setInfo(base, "PlayResX", String(canvas.x));
  setInfo(base, "PlayResY", String(canvas.y));

  const [s, e, st, tx] = ["Start", "End", "Style", "Text"].map((f) => at(base.eventFormat, f));
  base.events = base.events.filter((ev) => ev.kind === "Dialogue" && !/warning/i.test(ev.values[st] ?? "") && (plainOf(ev.values[tx] ?? "") || /\\p[1-9]/.test(ev.values[tx] ?? "")));
  let shown: Shown[] = base.events.map((ev) => ({ ev, start: stamp(ev.values[s]), end: stamp(ev.values[e]), song: SONG_STYLE.test(ev.values[st] ?? "") || KARAOKE.test(ev.values[tx] ?? ""), plain: plainOf(ev.values[tx] ?? "") }));

  let lines = dubLines(dub, ext);
  const dropped: MergeResult["dropped"] = { dubSigns: 0, dubSongs: 0, songs: 0 };
  if (signs) {
    lines = lines.filter((l) => !l.sign);
    if (maxBytes) {
      // Before the songs are weighed against the dub's: a song that goes leaves the dub's own line for it.
      const weight = (ev: { values: string[] }) => Buffer.byteLength(ev.values.join(","), "utf8") + 12;
      let total = shown.reduce((sum, x) => sum + weight(x.ev), 0) + lines.reduce((sum, l) => sum + Buffer.byteLength(l.text, "utf8") + 64, 0) + 8192;
      if (total > maxBytes) {
        const styles = new Map<string, { bytes: number; song: boolean }>();
        for (const x of shown) {
          const style = styles.get(x.ev.values[st] ?? "") ?? { bytes: 0, song: false };
          style.bytes += weight(x.ev);
          style.song ||= x.song;
          styles.set(x.ev.values[st] ?? "", style);
        }
        const gone = new Set<string>();
        const lyrics: Shown[] = [];
        for (const [name, style] of [...styles].sort((a, b) => Number(b[1].song) - Number(a[1].song) || b[1].bytes - a[1].bytes)) {
          if (total <= maxBytes) break;
          gone.add(name);
          total -= style.bytes;
          const of = shown.filter((x) => (x.ev.values[st] ?? "") === name);
          const styled = base.styles.find((v) => (v[at(base.styleFormat, "Name")] ?? "") === name);
          const drawn = Number(styled?.[at(base.styleFormat, "Outline")] ?? 0) > 0;
          const size = Number(styled?.[at(base.styleFormat, "Fontsize")]) || 0;
          const plain = style.song ? plainLyrics(of, base.eventFormat, { outline: drawn ? 0 : Math.max(1, Math.round((LYRIC_OUTLINE * canvas.y) / 1080)), size, height: canvas.y, font: styled?.[at(base.styleFormat, "Fontname")] ?? "" }) : undefined;
          if (plain) {
            lyrics.push(...plain);
            total += plain.reduce((sum, x) => sum + weight(x.ev), 0);
            dropped.plained = (dropped.plained ?? 0) + of.length;
          } else dropped.heavy = (dropped.heavy ?? 0) + of.length;
        }
        shown = [...shown.filter((x) => !gone.has(x.ev.values[st] ?? "")), ...lyrics];
      }
    }
    const spans: Array<{ start: number; end: number }> = [];
    for (const x of shown.filter((x) => x.song).sort((a, b) => a.start - b.start)) {
      const last = spans[spans.length - 1];
      if (last && x.start <= last.end + SONG_GAP_MS) last.end = Math.max(last.end, x.end);
      else spans.push({ start: x.start, end: x.end });
    }
    const gone = new Set<(typeof shown)[number]>();
    for (const span of spans) {
      const inside = lines.filter((l) => overlap(l, span) > 0);
      if (inside.some((l) => /♪/.test(l.plain) && sungWords(l.plain) >= SUNG_WORDS)) {
        for (const x of shown) if (x.song && overlap(x, span) > 0) gone.add(x);
      } else {
        const placeholders = new Set(inside.filter((l) => (/♪/.test(l.plain) || /^[[(].*(music|sing|song).*[\])]$/i.test(l.plain)) && sungWords(l.plain) < SUNG_WORDS));
        dropped.dubSongs += placeholders.size;
        lines = lines.filter((l) => !placeholders.has(l));
      }
    }
    dropped.songs = gone.size;
    base.events = shown.filter((x) => !gone.has(x)).map((x) => x.ev);
    const signsShown = shown.filter((x) => !x.song && !gone.has(x));
    lines = lines.filter((l) => {
      const during = signsShown.filter((x) => overlap(l, x) >= OVERLAP_SHARE * Math.max(1, l.end - l.start));
      if (!during.length) return true;
      const own = new Set(words(l.plain).filter((w) => w.length >= 4));
      const copy = l.placed || (capitals(l.plain) && during.some((x) => words(x.plain).some((w) => own.has(w))));
      if (copy) dropped.dubSigns++;
      return !copy;
    });
  }

  base.styles = base.styles.filter((v) => (v[at(base.styleFormat, "Name")] ?? "") !== DUB_STYLE);
  base.styles.push(dubStyle(base.styleFormat, canvas.y, { own, look, raise }));
  // A raised script keeps a line placed at the top where it was (as toAss does).
  const topMargin = String(Math.round((PLAIN_MARGIN * canvas.y) / PLAIN_HEIGHT));
  for (const l of lines.sort((a, b) => a.start - b.start)) {
    const values = base.eventFormat.map((f) => {
      switch (f.toLowerCase()) {
        case "layer": return "0";
        case "marked": return "Marked=0";
        case "start": return assStamp(l.start);
        case "end": return assStamp(l.end);
        case "style": return DUB_STYLE;
        case "marginv": return raise && /\\an[7-9]/.test(l.text) ? topMargin : "0";
        case "text": return l.text;
        case "marginl": case "marginr": return "0";
        default: return "";
      }
    });
    base.events.push({ kind: "Dialogue", values });
  }
  return { text: writeScript(base), dropped };
}

/**
 * The sign and song events of a full track (dialogue and signs in one): those in a sign or song style,
 * or placed, drawn, clipped or sung by their tags. Its dialogue lines go, the dub's take their place.
 */
export function signsOnly(script: Script): Script {
  const [st, tx] = ["Style", "Text"].map((f) => at(script.eventFormat, f));
  return { ...script, events: script.events.filter((ev) => ev.kind === "Dialogue" && (SIGN_STYLE.test(ev.values[st] ?? "") || SIGN_TAGS.test(ev.values[tx] ?? ""))) };
}

/** Events in a script, by kind. */
export function eventCount(script: Script): number {
  return script.events.filter((e) => e.kind === "Dialogue").length;
}
