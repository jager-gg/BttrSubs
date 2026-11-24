/**
 * Subtitles go out as SRT, the one format every player reads: download links end in "subtitle.srt"
 * (they're made before the file is fetched), and some players, Jellyfin through AIOMetadata among
 * them, go by that name, so an ASS file sent that way shows nothing at all. ASS styling and
 * positioning are dropped; the words and timing stay. A link that keeps ASS styling ends in
 * "subtitle.ass" for a subtitle stored as ASS, and gets it as ASS (toAss).
 */

interface Line {
  start: number;
  end: number;
  text: string;
}

function srtStamp(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}`;
}

/** "0:01:02.34" (ASS) or "01:02.345" / "00:01:02.345" (VTT) to ms. */
export function stamp(value: string): number {
  const parts = value.trim().replace(",", ".").split(":");
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
}

function fromAss(text: string): Line[] {
  const lines: Line[] = [];
  let fields: string[] = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^format\s*:/i.test(line) && /text\s*$/i.test(line)) {
      fields = line.replace(/^format\s*:/i, "").split(",").map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const values = line.replace(/^dialogue\s*:/i, "").split(",");
    const textAt = fields.indexOf("text");
    const body = values.slice(textAt).join(",");
    // Vector drawings ({\p1}) are shapes, not words.
    if (/\{[^}]*\\p[1-9]/.test(body)) continue;
    const words = body
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    if (!words) continue;
    lines.push({ start: stamp(values[fields.indexOf("start")]), end: stamp(values[fields.indexOf("end")]), text: words });
  }
  return lines;
}

function fromVtt(text: string): Line[] {
  const lines: Line[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at === -1) continue;
    const [a, b] = rows[at].split("-->");
    const words = rows
      .slice(at + 1)
      .map((r) => r.replace(/<(?!\/?[ibu]>)[^>]*>/g, "").trim())
      .filter(Boolean)
      .join("\n");
    if (!words) continue;
    lines.push({ start: stamp(a), end: stamp(b.trim().split(/\s+/)[0]), text: words });
  }
  return lines;
}

/** The subtitle as SRT; text that already is SRT is returned as it is. */
export function toSrt(text: string, ext: string): string {
  const kind = ext.toLowerCase();
  if (kind !== ".ass" && kind !== ".ssa" && kind !== ".vtt") return text;
  const lines = (kind === ".vtt" ? fromVtt(text) : fromAss(text)).filter((l) => l.end > l.start).sort((x, y) => x.start - y.start);
  return lines.map((l, i) => `${i + 1}\n${srtStamp(l.start)} --> ${srtStamp(l.end)}\n${l.text}\n`).join("\n");
}

/** "0:01:02.34": ASS times, in hundredths. */
export function assStamp(ms: number): string {
  const t = Math.max(0, Math.round(ms / 10));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(t / 360000)}:${pad(Math.floor((t % 360000) / 6000))}:${pad(Math.floor((t % 6000) / 100))}.${pad(t % 100)}`;
}

/** A line's text in ASS: italics, bold and underline as override tags, line breaks as \N. Tags like {\an8} pass as they are. */
export function assText(text: string): string {
  return text
    .replace(/<([ibu])>/gi, (_, tag: string) => `{\\${tag.toLowerCase()}1}`)
    .replace(/<\/([ibu])>/gi, (_, tag: string) => `{\\${tag.toLowerCase()}0}`)
    .replace(/<[^>]*>/g, "")
    .split("\n")
    .join("\\N");
}

/** The generated script's height, and its default line margin from the bottom, in script pixels. */
export const PLAIN_HEIGHT = 288;
export const PLAIN_MARGIN = 12;
/** Where a plain subtitle's lines sit unmoved, as a share of the picture's height (12 of 288: 4%). */
export const USUAL_UP = Math.round((100 * PLAIN_MARGIN) / PLAIN_HEIGHT);

/** A look for subtitles with no styling of their own: the one style of the script made for them. */
export interface Look {
  /** As the configure page names it. */
  name: string;
  font: string;
  size: number;
  /** Colours as ASS writes them, &HAABBGGRR. */
  colour: string;
  outlineColour: string;
  backColour: string;
  bold: boolean;
  /** 1: an outline and a shadow; 3: a box behind the text, in the outline colour. */
  border: 1 | 3;
  outline: number;
  shadow: number;
  /** Its lines' height from the bottom in script pixels when no style moves them: the plain 12 when not given. */
  margin?: number;
  italic?: boolean;
  /** Space added between letters, in script pixels. */
  spacing?: number;
  /** The lines sit at the top of the picture, not the bottom. */
  top?: boolean;
}

/** A look's alignment as ASS numbers it: centred along the bottom (2) or along the top (8). */
export function alignmentOf(look: Look): number {
  return look.top ? 8 : 2;
}

/** What a plain subtitle looks like with no look chosen. */
export const PLAIN: Look = { name: "As it comes", font: "Arial", size: 20, colour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H80000000", bold: false, border: 1, outline: 1, shadow: 0.5 };

/**
 * The looks a style can choose, by the id its links carry. Arial in most: players have it or put their own
 * sans in its place. Anime streaming is the look of an anime streaming service's English subtitles.
 * Calibration (that service's published episode scripts): Trebuchet MS 24 on a 640x360 script, white, a
 * black outline of 2 and a shadow of 1, not bold, 18 from the bottom; here scaled to 288. Drawn by libass
 * at 1280x720, both scripts' line is 318 px wide; ASS margins are whole, so 14.4 is 14.
 */
export const LOOKS: Record<string, Look> = {
  anime: { ...PLAIN, name: "Anime streaming", font: "Trebuchet MS", size: 19.2, outline: 1.6, shadow: 0.8, backColour: "&H00000000", margin: 14 },
  white: { ...PLAIN, name: "White outline", outline: 1.6, shadow: 0.6 },
  bold: { ...PLAIN, name: "Bold outline", size: 22, bold: true, outline: 2.4, shadow: 1, backColour: "&H96000000" },
  yellow: { ...PLAIN, name: "Yellow", colour: "&H0000FFFF", outline: 1.6, shadow: 0.6 },
  boxed: { ...PLAIN, name: "Dark box", border: 3, outlineColour: "&H80000000", outline: 2, shadow: 0 },
  large: { ...PLAIN, name: "Large", size: 26, outline: 2, shadow: 0.8 }
};

/** Fonts a changed look can use, by the id its links carry: ones most players have, or put one like it in place of. */
export const FONTS: Record<string, string> = { arial: "Arial", trebuchet: "Trebuchet MS", verdana: "Verdana", tahoma: "Tahoma", georgia: "Georgia", times: "Times New Roman" };

/** How far a change may take a look: outline and shadow in script pixels, size as a share of the preset's. */
export const CHANGE_LIMITS = { outlineMax: 4, shadowMax: 4, sizeMin: 70, sizeMax: 150, spacingMax: 3, boxMin: 20, boxMax: 100, boxUsual: 50 };

/** The letters a look's changes go by (lookOf). */
export const CHANGE_KEYS = ["c", "o", "w", "h", "f", "g", "z", "b", "x", "i", "s", "k", "t"] as const;

/**
 * A font named by hand, as a look carries it: letters, digits and . ' - with a + for each space, 40 at
 * most, starting with a letter or digit. A style row is split at its commas, so a name can hold none,
 * nor anything else that would end the row or the look.
 */
export const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9+.'-]{0,39}$/;

const HEX = /^[0-9a-f]{6}$/;
const TENTHS = /^\d(?:\.\d)?$/;
const FLAG = /^[01]$/;
/** RRGGBB as ASS writes it, &HAABBGGRR. */
const assColour = (rgb: string, alpha: string) => `&H${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toUpperCase();
/** An ASS colour's RRGGBB. */
const rgbOf = (ass: string) => `${ass.slice(-2)}${ass.slice(-4, -2)}${ass.slice(-6, -4)}`.toLowerCase();

/**
 * The look a link's `look` names: a preset's id, or a preset ("plain" for the plain style) and its
 * changes, each a letter and its value, joined by "_" ("yellow_o0000ff_w2.4"): c the text's colour and
 * o the outline's (or the box's) as RRGGBB, w the outline and h the shadow (0 to 4, in tenths), f a font
 * (FONTS) or g one named by hand (FONT_NAME), not both, z the size (70 to 150, percent of the preset's), b bold, i italic and x a box behind the text
 * (0 or 1), s the space between letters (0 to 3, in tenths), k how solid the box is (20 to 100 percent;
 * 50 when not given), t at the top of the picture (0 or 1) and n to the left or right (l, c or r).
 * Anything else, or a letter twice, names no look.
 */
export function lookOf(spec: string): Look | undefined {
  const [base, ...changes] = spec.split("_");
  if (Object.hasOwn(LOOKS, base) && changes.length === 0) return LOOKS[base];
  const preset = base === "plain" ? PLAIN : Object.hasOwn(LOOKS, base) ? LOOKS[base] : undefined;
  if (!preset || changes.length === 0 || changes.length > CHANGE_KEYS.length) return undefined;
  const look: Look = { ...preset };
  let outlineRgb = rgbOf(preset.outlineColour);
  let boxSolid = CHANGE_LIMITS.boxUsual;
  const seen = new Set<string>();
  for (const change of changes) {
    const [key, value] = [change.slice(0, 1), change.slice(1)];
    if (seen.has(key)) return undefined;
    seen.add(key);
    const n = Number(value);
    if (key === "c" && HEX.test(value)) look.colour = assColour(value, "00");
    else if (key === "o" && HEX.test(value)) outlineRgb = value;
    else if (key === "w" && TENTHS.test(value) && n <= CHANGE_LIMITS.outlineMax) look.outline = n;
    else if (key === "h" && TENTHS.test(value) && n <= CHANGE_LIMITS.shadowMax) look.shadow = n;
    else if (key === "f" && Object.hasOwn(FONTS, value)) look.font = FONTS[value];
    else if (key === "g" && FONT_NAME.test(value) && !seen.has("f")) look.font = value.replace(/\+/g, " ");
    else if (key === "z" && /^\d{2,3}$/.test(value) && n >= CHANGE_LIMITS.sizeMin && n <= CHANGE_LIMITS.sizeMax) look.size = Math.round(preset.size * n) / 100;
    else if (key === "b" && FLAG.test(value)) look.bold = value === "1";
    else if (key === "x" && FLAG.test(value)) look.border = value === "1" ? 3 : 1;
    else if (key === "i" && FLAG.test(value)) look.italic = value === "1";
    else if (key === "s" && TENTHS.test(value) && n <= CHANGE_LIMITS.spacingMax) look.spacing = n;
    else if (key === "k" && /^\d{2,3}$/.test(value) && n >= CHANGE_LIMITS.boxMin && n <= CHANGE_LIMITS.boxMax) boxSolid = n;
    else if (key === "t" && FLAG.test(value)) look.top = value === "1";
    else return undefined;
  }
  // A box is half see-through, as Dark box's, unless the look says how solid; an outline is solid.
  const seeThrough = Math.round((255 * (100 - boxSolid)) / 100).toString(16).padStart(2, "0");
  look.outlineColour = assColour(outlineRgb, look.border === 3 ? (boxSolid === CHANGE_LIMITS.boxUsual ? "80" : seeThrough) : "00");
  return look;
}

/** Where a look's lines sit when no style moves them, as a share of the picture's height. */
export function usualUpOf(look: Look | undefined): number {
  return Math.round((100 * (look?.margin ?? PLAIN_MARGIN)) / PLAIN_HEIGHT);
}

/** The look's style row, for the Default style, with its lines `margin` up from the bottom. */
function styleRow(look: Look, margin: number): string {
  return `Style: Default,${look.font},${look.size},${look.colour},&H000000FF,${look.outlineColour},${look.backColour},${look.bold ? -1 : 0},${look.italic ? -1 : 0},0,0,100,100,${look.spacing ?? 0},0,${look.border},${look.outline},${look.shadow},${alignmentOf(look)},10,10,${margin},1`;
}
/** Inline placement other than at the bottom: \pos, \move, or \an4 to \an9 (middle and top). */
const PLACED_ELSEWHERE = /\\(?:pos|move)\(|\\an[4-9]/;
const TOP = /\\an[7-9]/;

/** A comma-separated row's first n-1 fields, then the rest whole (an event's text keeps its commas). */
export function fields(row: string, n: number): string[] {
  const parts = row.split(",");
  return parts.length <= n ? parts : [...parts.slice(0, n - 1), parts.slice(n - 1).join(",")];
}

/**
 * An ASS or SSA script with its bottom-placed lines raised to at least `percent` of its height
 * (PlayResY): the MarginV of every bottom-aligned style (alignment 1 to 3 in both formats), and of a
 * line in such a style that sets its own. A line in such a style placed at the top inline (\an7-9)
 * keeps its style's old margin; lines placed by \pos, \move or in the middle don't use it.
 */
function raiseAss(text: string, percent: number): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const height = Number(/^\s*PlayResY\s*:\s*(\d+)/im.exec(text)?.[1]) || PLAIN_HEIGHT;
  const target = Math.round((height * percent) / 100);
  let section = "";
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];
  /** Bottom-aligned styles by name, with their margin before the raise. */
  const bottom = new Map<string, number>();
  return text
    .split(/\r?\n/)
    .map((row) => {
      const head = /^\s*\[([^\]]+)\]/.exec(row);
      if (head) {
        section = head[1].trim().toLowerCase();
        return row;
      }
      const m = /^(\s*(Format|Style|Dialogue)\s*:\s*)(.*)$/i.exec(row);
      if (!m) return row;
      const key = m[2].toLowerCase();
      const isStyles = section.endsWith("styles");
      if (key === "format") {
        const names = m[3].split(",").map((f) => f.trim().toLowerCase());
        if (isStyles) styleFormat = names;
        else if (section === "events") eventFormat = names;
        return row;
      }
      if (key === "style" && isStyles) {
        const values = m[3].split(",");
        const [name, align, margin] = ["name", "alignment", "marginv"].map((f) => styleFormat.indexOf(f));
        if (name < 0 || align < 0 || margin < 0 || values.length < styleFormat.length || ![1, 2, 3].includes(Number(values[align]))) return row;
        const old = Number(values[margin]) || 0;
        bottom.set(values[name].trim(), old);
        values[margin] = String(Math.max(old, target));
        return m[1] + values.join(",");
      }
      if (key === "dialogue" && section === "events") {
        const [style, margin] = ["style", "marginv"].map((f) => eventFormat.indexOf(f));
        if (style < 0 || margin < 0) return row;
        const values = fields(m[3], eventFormat.length);
        const old = bottom.get(values[style]?.trim() ?? "");
        const line = values[values.length - 1] ?? "";
        if (old === undefined || (PLACED_ELSEWHERE.test(line) && !TOP.test(line))) return row;
        const own = Number(values[margin]) || 0;
        // A top line keeps the style's old margin (0 there means "the style's", so at least 1).
        if (TOP.test(line)) values[margin] = String(own || Math.max(1, old));
        else if (own) values[margin] = String(Math.max(own, target));
        else return row;
        return m[1] + values.join(",");
      }
      return row;
    })
    .join(eol);
}

/**
 * The subtitle as ASS, for a link ending in ".ass" (one that keeps ASS styling, or a style's look or
 * height, Settings.styles). An ASS or SSA script keeps its styles and positions (`own`, true unless a
 * look is to take their place); raised, its bottom-placed lines move up to that share of the
 * picture's height (raiseAss). Anything else (an SRT or VTT, one served in an ASS upload's place, or
 * an ASS script whose styling gives way to a look) becomes a script with one style, the look's or the
 * plain one, placed that high when raised; a line tagged for the top ({\an8}) stays at the default
 * top margin.
 */
export function toAss(text: string, ext: string, raise?: number, look?: string, own = true): string {
  const kind = ext.toLowerCase();
  const styled = kind === ".ass" || kind === ".ssa";
  const chosen = look !== undefined ? lookOf(look) : undefined;
  if (styled && (own || !chosen)) return raise ? raiseAss(text, raise) : text;
  const lines = (styled ? fromAss(text) : fromVtt(text)).filter((l) => l.end > l.start).sort((x, y) => x.start - y.start);
  const margin = raise ? Math.round((PLAIN_HEIGHT * raise) / 100) : (chosen?.margin ?? PLAIN_MARGIN);
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 384",
    `PlayResY: ${PLAIN_HEIGHT}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleRow(chosen ?? PLAIN, margin),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines.map((l) => `Dialogue: 0,${assStamp(l.start)},${assStamp(l.end)},Default,,0,0,${raise && TOP.test(l.text) ? PLAIN_MARGIN : 0},,${assText(l.text)}`),
    ""
  ].join("\n");
}

/** How long a notice stays on screen, from just after the start. */
const NOTICE_FROM_MS = 500;
const NOTICE_TO_MS = 8000;

/**
 * A subtitle as it is sent (SRT, or an ASS script) with one more line at its start: a notice to the
 * viewer, shown for a few seconds, for what the track's name can't say (a player keeps the list it
 * got for the whole play). In an ASS script it takes the first line's style, at the top of the
 * picture, by the script's own Format; a script it can't read that from is sent as it is.
 */
export function withNotice(sent: string, ass: boolean, message: string): string {
  if (!ass) return `0\n00:00:00,${String(NOTICE_FROM_MS).padStart(3, "0")} --> 00:00:0${Math.floor(NOTICE_TO_MS / 1000)},000\n${message}\n\n${sent}`;
  const lines = sent.split(/\r?\n/);
  const events = lines.findIndex((l) => /^\[Events\]/i.test(l.trim()));
  const format = events < 0 ? -1 : lines.findIndex((l, i) => i > events && /^Format:/i.test(l));
  const first = format < 0 ? -1 : lines.findIndex((l, i) => i > format && /^Dialogue:/i.test(l));
  if (first < 0) return sent;
  const fields = lines[format].slice(lines[format].indexOf(":") + 1).split(",").map((f) => f.trim().toLowerCase());
  const values = lines[first].slice(lines[first].indexOf(":") + 1).split(",");
  const stamp = (ms: number) => `0:00:${String(Math.floor(ms / 1000)).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 10)).padStart(2, "0")}`;
  const cells = fields.map((field, i) => {
    if (field === "start") return stamp(NOTICE_FROM_MS);
    if (field === "end") return stamp(NOTICE_TO_MS);
    if (field === "style") return (values[i] ?? "Default").trim();
    if (field === "text") return `{\\an8}${message}`;
    if (field === "name" || field === "actor" || field === "effect") return "";
    return "0";
  });
  if (!fields.includes("text") || !fields.includes("start") || !fields.includes("end")) return sent;
  lines.splice(first, 0, `Dialogue: ${cells.join(",")}`);
  return lines.join("\n");
}
