/**
 * Songs set piece by piece in a font players don't have.
 *
 * A karaoke effect places each piece of a lyric line (a syllable or a letter, an event each, at \pos or
 * \move) where the line laid out in its font puts it, by that font's letter widths. A player without the
 * font draws its own, of other widths, and the pieces overlap or drift apart. Here each such line is laid
 * out again in a font most players have, of the old font's kind (Georgia, Trebuchet MS, else Arial), by
 * that font's own widths (fontwidths.ts): its pieces are moved to their new places with the line's middle
 * kept, and the style takes the font. Shapes anchored beside a piece and the pieces' clips move with them.
 *
 * A line is the pieces of one style at one height on screen together, laid out once from all of them (a
 * line sung in syllable by syllable keeps one layout as it grows). Copies of a piece a pixel or two apart
 * (a jitter, a glow) are one piece and move together. The gaps between pieces, past what their widths
 * take, stay as the line had them, in the new font's measure: a word's break, or a song's space between
 * syllables. A line drawn as letters and then as the syllables they make is laid out from its letters,
 * each syllable over its own. A line whose pieces don't make one row (two lines at one height as one
 * fades into the next), that it can't read (letters the widths
 * don't cover, turned pieces), or that would come out far wider or narrower than it was, is left as it
 * is; so is a script that carries its own fonts. A style none of whose lines is laid out again keeps its
 * font.
 *
 * A row stays whole: pieces shown from one moment to another together, at one height, are one row, and a
 * line whose new layout would set its pieces over others of their row, that they stood clear of, is left
 * as it is too. In a style that takes the new font, every piece left where it stands is drawn as wide as
 * the old font drew it (its width scaled by the old font's share of the new one's), so it fills the
 * place made for it and no more.
 */
import { FACES, type Face } from "./fontwidths.js";
import { at, HEAVY_FONT, parseScript, playRes, SANS_FONT, SERIF_FONT, writeScript, type Script } from "./signs.js";
import { FONTS } from "./srt.js";

type Event = Script["events"][number];

interface Piece {
  ev: Event;
  start: number;
  end: number;
  /** Where the piece stands in its line: \pos, \move's end, or its start for one flying out of a line. */
  x: number;
  y: number;
  /** \move's start. */
  from?: [number, number];
  /** Its anchor's share of its width from the left: 0 (\an1, 4, 7), 0.5 (2, 5, 8) or 1 (3, 6, 9). */
  h: number;
  text: string;
  size: number;
  scaleX: number;
  spacing: number;
  face: Face;
  style: string;
  /** Drawn at its style's own size and width (no \fs or \fscx of its own). */
  usual: boolean;
}

/** A setting of a line: each piece's new anchor, by its place and text, and the map of old middles to new. */
interface Layout {
  moved: Map<Slot, number>;
  map: (x: number) => number;
  /** Where each piece stood, half its width wider each side: a shape anchored there is drawn with it. */
  beside: Array<[number, number]>;
}

/** Pairs of pieces needed in a style to tell how its font's widths compare with the new one's. */
const MIN_PAIRS = 3;
/**
 * How much wider or narrower one font's letters may be than another's at one size: a style whose pieces
 * say otherwise isn't read (pieces drawn on top of each other). Calibration (the songs of 17 subtitles
 * in 9 fonts): from 0.72 to 1.01.
 */
const WIDTH_SHARE = [0.5, 2];
/**
 * The least a style's ratio may be and still be read right. Calibration (as above, 0.72 at the least; a
 * karaoke popping each syllable up larger measured 0.53 from 10 pairs).
 */
const RATIO_MIN = 0.6;
/** Neighbours further apart than this many times their new widths take are a line's ends, not a word's gap. */
const REACH_MAX = 3;
/**
 * Copies of one text closer than this share of its width, or of its size for a text wider than its size,
 * are one piece drawn several times. Calibration (an ending that draws each letter 4 times, 1.6 px apart
 * at most, for a jitter; one word sung twice in two lines on screen together, 96 px apart at size 90):
 * neighbouring pieces stand their widths apart.
 */
const SAME_PLACE = 0.35;
/** How near a copy of a piece stands: SAME_PLACE of its width, or of its size when that is less. */
const nearOf = (p: Pick<Piece, "text" | "size" | "scaleX" | "spacing" | "face">) => SAME_PLACE * Math.min(widthOf(p) ?? 0, p.size);
/**
 * Pieces of a style this near in height are one row. Calibration (the same ending): a letter's copies
 * within 2 px of each other in height; two lines of a song 45 px apart.
 */
const Y_NEAR = 3;
/** A copy shown within this long (ms) of a moved piece's end is its next phase. */
const HOP_MS = 50;
/** A line laid out again more than this many times wider or narrower than it was is left as it is. */
const SPAN_CHANGE = 2;
/**
 * Neighbours closer than this share of what their widths take aren't one line set out (two lines showing
 * at one height as one fades into the next): the setting is left as it is.
 */
const CLOSEST = 0.5;

/**
 * Two pieces stand clear of each other when they share this share of the narrower one's width or less,
 * and one stands over the other from the second share on.
 */
const CLEAR = 0.2;
const COVERED = 0.35;
const COMMON = new Set(Object.values(FONTS).map((f) => f.toLowerCase()));
const ANCHOR = [0, 0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1];
const num = "\\s*(-?\\d+(?:\\.\\d+)?)\\s*";
const POS = new RegExp(`\\\\pos\\(${num},${num}\\)`);
const MOVE = new RegExp(`\\\\move\\(${num},${num},${num},${num}(,[^)]*)?\\)`);
const CLIP = new RegExp(`\\\\(i?clip)\\(${num},${num},${num},${num}\\)`, "g");
const fmt = (v: number) => String(Math.round(v * 100) / 100);
const stamp = (v: string) => {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(v ?? "");
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : 0;
};

/** The face of the old font's kind, bold when the style or the name is. */
function faceFor(font: string, bold: boolean): Face {
  const name = SERIF_FONT.test(font) ? "Georgia" : SANS_FONT.test(font) ? "Trebuchet MS" : "Arial";
  const heavy = bold || HEAVY_FONT.test(font);
  return FACES.find((f) => f.name === name && f.bold === heavy)!;
}

function advance(face: Face, cp: number): number {
  for (const [from, widths] of face.widths) if (cp >= from && cp < from + widths.length) return widths[cp - from];
  return 0;
}

/** A text's width in a face, in script pixels; undefined when the face lacks a letter of it. */
function widthOf(p: Pick<Piece, "text" | "size" | "scaleX" | "spacing" | "face">, text = p.text): number | undefined {
  let units = 0;
  let letters = 0;
  for (const ch of text) {
    const w = advance(p.face, ch.codePointAt(0)!);
    if (!w) return undefined;
    units += w;
    letters++;
  }
  return ((units * p.size) / p.face.height) * (p.scaleX / 100) + p.spacing * letters;
}

/**
 * One piece of a line as laid out: a text at a place, drawn by one event or several (copies a pixel or
 * two apart, as a jitter or a glow draws it, and the piece again for each step of its effect).
 */
interface Slot {
  text: string;
  /** Its place: the middle of its copies' anchors. */
  x: number;
  h: number;
  size: number;
  scaleX: number;
  spacing: number;
  face: Face;
}

/**
 * Each piece's slot in a line: copies of one text nearer than nearOf are one piece, measured as a copy
 * drawn at its style's own size draws it (a syllable popping up larger, or a sparkle shrunk to nothing,
 * is a moment's copy), else as its first.
 */
function slotsOf(line: Piece[]): Map<Piece, Slot> {
  const byText = new Map<string, Array<Slot & { n: number; usual: boolean }>>();
  const of = new Map<Piece, Slot>();
  for (const p of [...line].sort((a, b) => a.x - b.x)) {
    const near = nearOf(p);
    const list = byText.get(p.text) ?? [];
    let slot = list.find((s) => Math.abs(s.x - p.x) <= near);
    if (!slot) {
      slot = { text: p.text, x: p.x, h: p.h, size: p.size, scaleX: p.scaleX, spacing: p.spacing, face: p.face, n: 0, usual: p.usual };
      list.push(slot);
      byText.set(p.text, list);
    }
    if (p.usual && !slot.usual) Object.assign(slot, { size: p.size, scaleX: p.scaleX, spacing: p.spacing, face: p.face, usual: true });
    slot.x = (slot.x * slot.n + p.x) / (slot.n + 1);
    slot.n++;
    of.set(p, slot);
  }
  return of;
}

/** Slots left to right; undefined when two texts share a place. */
function distinct(slots: Iterable<Slot>): Slot[] | undefined {
  const sorted = [...new Set(slots)].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) if (Math.round(sorted[i].x * 10) === Math.round(sorted[i - 1].x * 10)) return undefined;
  return sorted;
}

/** A line's pieces side by side, and the pieces drawn over a run of them (a syllable over its letters). */
interface Row {
  row: Slot[];
  made: Map<Slot, Slot[]>;
}

const bare = (text: string) => text.replace(/\s+/g, "");
/** Where a slot's middle stands, by its new width. */
const middleOf = (s: Slot) => s.x + (0.5 - s.h) * (widthOf(s) ?? 0);

/** The run of `row` (left to right) whose texts make up `s`'s, nearest its middle and within nearOf of it. */
function runOf(s: Slot, row: Slot[]): Slot[] | undefined {
  const text = bare(s.text);
  const width = widthOf(s);
  if (text.length < 2 || !width) return undefined;
  let best: Slot[] | undefined;
  let off = nearOf(s);
  for (let i = 0; i < row.length; i++) {
    let joined = "";
    for (let j = i; j < row.length && joined.length < text.length; j++) {
      joined += bare(row[j].text);
      if (!text.startsWith(joined)) break;
      if (joined === text && j > i) {
        const d = Math.abs((middleOf(row[i]) + middleOf(row[j])) / 2 - middleOf(s));
        if (d <= off) [best, off] = [row.slice(i, j + 1), d];
      }
    }
  }
  return best;
}

/**
 * A line's slots as one row: a slot whose text is a run of shorter neighbours' (letters drawn, then the
 * syllables they make shown over them) is placed over that run, not in the row. Undefined when two
 * texts of the row share a place.
 */
function rowOf(slots: Iterable<Slot>): Row | undefined {
  const row: Slot[] = [];
  const made = new Map<Slot, Slot[]>();
  for (const s of [...new Set(slots)].sort((a, b) => bare(a.text).length - bare(b.text).length || a.x - b.x)) {
    const run = runOf(s, row);
    const after = row.findIndex((r) => r.x > s.x);
    if (run) made.set(s, run);
    else row.splice(after < 0 ? row.length : after, 0, s);
  }
  const sorted = distinct(row);
  return sorted && { row: sorted, made };
}

/**
 * Pieces one after another on screen at one height, split into the lines they are (one line's letters
 * flying out as the next one's fly in). Each piece, in order of appearance (shorter texts first at one
 * moment), joins the line that has a copy of it, else one whose pieces it is made of, else the latest
 * line whose every piece it stands clear of, within (a word shown before its letters, not one already
 * made of its own), or under; else it starts a line.
 */
function apart(chain: Piece[]): Piece[][] {
  type Line = { slots: Slot[]; made: Set<Slot>; of: Map<Slot, Piece[]>; last: number };
  const lines: Line[] = [];
  for (const p of [...chain].sort((a, b) => a.start - b.start || bare(a.text).length - bare(b.text).length)) {
    const near = nearOf(p);
    const copyIn = (l: Line) => l.slots.find((s) => s.text === p.text && Math.abs(s.x - p.x) <= near);
    let line = lines.find((l) => copyIn(l));
    let made = false;
    if (!line) {
      line = lines.find((l) => runOf(p, l.slots.filter((s) => !l.made.has(s)).sort((a, b) => a.x - b.x)));
      made = Boolean(line);
    }
    line ??= lines.filter((l) => fits(p, l)).sort((a, b) => b.last - a.last)[0];
    if (!line) {
      line = { slots: [], made: new Set(), of: new Map(), last: p.start };
      lines.push(line);
    }
    line.last = p.start;
    let slot = copyIn(line);
    if (!slot) {
      slot = { text: p.text, x: p.x, h: p.h, size: p.size, scaleX: p.scaleX, spacing: p.spacing, face: p.face };
      line.slots.push(slot);
      line.of.set(slot, []);
      if (made) line.made.add(slot);
    }
    line.of.get(slot)!.push(p);
  }
  return lines.map((l) => [...l.of.values()].flat());
}

/** A piece fits a line when it stands clear of each of its pieces, within one (a word shown before its letters, not one made of its own), or under one. */
function fits(p: Slot, l: { slots: Slot[]; made: Set<Slot> }): boolean {
  return l.slots.every((s) => s === p || clearOf(p, s) || (within(p, s) && !l.made.has(s)) || within(s, p));
}


/** A piece is within another when that one's text holds its text and its middle stands over that one. */
function within(a: Slot, b: Slot): boolean {
  const wb = widthOf(b);
  return Boolean(wb) && bare(b.text).length > bare(a.text).length && bare(b.text).includes(bare(a.text)) && Math.abs(middleOf(a) - middleOf(b)) <= wb! / 2;
}

/** Two pieces stand clear of each other when their middles are at least CLOSEST of their widths apart. */
function clearOf(a: Slot, b: Slot): boolean {
  const [wa, wb] = [widthOf(a), widthOf(b)];
  if (!wa || !wb) return false;
  return Math.abs(middleOf(a) - middleOf(b)) >= (CLOSEST * (wa + wb)) / 2;
}

/** Each piece drawn over a run stands over that run as laid out again, at its own anchor's share. */
function placeMade(lay: Layout, made: Map<Slot, Slot[]>): void {
  for (const [s, run] of made) {
    const [a, b] = [run[0], run[run.length - 1]];
    const [na, nb] = [lay.moved.get(a), lay.moved.get(b)];
    if (na === undefined || nb === undefined) continue;
    const left = na - a.h * (widthOf(a) ?? 0);
    const right = nb + (1 - b.h) * (widthOf(b) ?? 0);
    lay.moved.set(s, left + s.h * (right - left));
  }
}

/** How far apart two neighbours' anchors stand, for their new widths: the old font's width share is the least of these. */
const reachOf = (a: Slot, b: Slot, wa: number, wb: number) => (b.x - a.x) / ((1 - a.h) * wa + b.h * wb);

/**
 * A setting laid out again in the new face, by `ratio` (old widths over new), kept between `within`'s
 * edges (the style's margins on the picture) or as far out as the line already went.
 */
function layout(slots: Slot[], ratio: number, within: [number, number]): Layout | undefined {
  if (slots.length < 2) return undefined;
  const widths = slots.map((s) => widthOf(s));
  if (widths.some((w) => w === undefined || w <= 0)) return undefined;
  const w = widths as number[];
  const lefts: number[] = [0];
  for (let i = 0; i + 1 < slots.length; i++) {
    const [a, b] = [slots[i], slots[i + 1]];
    if (reachOf(a, b, w[i], w[i + 1]) < CLOSEST * ratio) return undefined;
    // The gap past what their widths take, as the line had it, in the new font's measure.
    const gap = b.x - a.x - ratio * ((1 - a.h) * w[i] + b.h * w[i + 1]);
    lefts.push(lefts[i] + w[i] + Math.max(0, gap / ratio));
  }
  const n = slots.length - 1;
  const oldLeft = slots[0].x - slots[0].h * ratio * w[0];
  const oldRight = slots[n].x + (1 - slots[n].h) * ratio * w[n];
  // The line's middle stays, unless that takes an end past the edges: then it slides back inside. A line
  // wider than the room between them is left as it is (its letters would be cut).
  const [lo, hi] = [Math.min(within[0], oldLeft), Math.max(within[1], oldRight)];
  const span = lefts[n] + w[n];
  if (span > hi - lo) return undefined;
  const shift = Math.min(Math.max((oldLeft + oldRight) / 2 - span / 2, lo), hi - span);
  const moved = new Map<Slot, number>();
  const knots: Array<[number, number]> = [];
  slots.forEach((s, i) => {
    moved.set(s, shift + lefts[i] + s.h * w[i]);
    knots.push([s.x + (0.5 - s.h) * ratio * w[i], shift + lefts[i] + w[i] / 2]);
  });
  // A line that would come out far wider or narrower than it was isn't one line read right.
  const oldSpan = slots[n].x - slots[0].x;
  const newSpan = moved.get(slots[n])! - moved.get(slots[0])!;
  if (oldSpan > 0 && (newSpan > SPAN_CHANGE * oldSpan || newSpan * SPAN_CHANGE < oldSpan)) return undefined;
  const map = (x: number) => {
    if (x <= knots[0][0]) return knots[0][1] + (x - knots[0][0]) / ratio;
    for (let i = 1; i < knots.length; i++) {
      const [[x0, y0], [x1, y1]] = [knots[i - 1], knots[i]];
      if (x <= x1) return x1 === x0 ? y1 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
    }
    const [xl, yl] = knots[knots.length - 1];
    return yl + (x - xl) / ratio;
  };
  const beside = slots.map((slot, i): [number, number] => {
    const left = slot.x - slot.h * ratio * w[i];
    return [left - (ratio * w[i]) / 2, left + 1.5 * ratio * w[i]];
  });
  return { moved, map, beside };
}

/** The script with its songs set piece by piece in a font players lack laid out again; undefined when nothing changes. */
export function respaceSongs(text: string): { text: string; lines: number } | undefined {
  if (!/\\(?:pos|move)\(/.test(text) || /^\[Fonts\]/im.test(text)) return undefined;
  const script = parseScript(text);
  if (!script) return undefined;
  const across = playRes(script).x;
  const sf = (f: string) => at(script.styleFormat, f);
  const styles = new Map(
    script.styles.map((v) => [
      v[sf("Name")] ?? "",
      { font: v[sf("Fontname")] ?? "", size: Number(v[sf("Fontsize")]) || 20, bold: (v[sf("Bold")] ?? "0") !== "0", scaleX: Number(v[sf("ScaleX")]) || 100, spacing: Number(v[sf("Spacing")]) || 0, align: Number(v[sf("Alignment")]) || 2, marginL: Number(v[sf("MarginL")]) || 0, marginR: Number(v[sf("MarginR")]) || 0 }
    ])
  );
  const [s, e, st, tx] = ["Start", "End", "Style", "Text"].map((f) => at(script.eventFormat, f));
  const pieces: Piece[] = [];
  const drawn: Array<{ ev: Event; start: number; y: number; style: string }> = [];
  // Pieces that can't be read into a line: turned, or of two lines.
  const unread: Array<{ ev: Event; style: string; scaleX: number }> = [];
  for (const ev of script.events) {
    if (ev.kind !== "Dialogue") continue;
    const style = styles.get(ev.values[st] ?? "");
    const body = ev.values[tx] ?? "";
    const tags = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join("");
    const font = /\\fn([^\\}]+)/.exec(tags)?.[1] ?? style?.font ?? "";
    if (!style || COMMON.has(font.trim().toLowerCase())) continue;
    const pos = POS.exec(tags);
    const move = MOVE.exec(tags);
    if (!pos && !move) continue;
    const y = Number(pos ? pos[2] : move![4]);
    if (/\\p[1-9]/.test(tags)) {
      drawn.push({ ev, start: stamp(ev.values[s]), y, style: ev.values[st] ?? "" });
      continue;
    }
    const plain = body.replace(/\{[^}]*\}/g, "").replace(/\\h/g, " ");
    if (!plain.trim()) continue;
    if (/\\fr[xyz]?\s*-?(?:[1-9]|0\.\d*[1-9])/.test(tags) || /\\[Nn]/.test(plain)) {
      unread.push({ ev, style: ev.values[st] ?? "", scaleX: style.scaleX });
      continue;
    }
    const an = Number(/\\an([1-9])/.exec(tags)?.[1] ?? style.align);
    pieces.push({
      ev,
      start: stamp(ev.values[s]),
      end: stamp(ev.values[e]),
      x: Number(pos ? pos[1] : move![3]),
      y,
      ...(move && !pos ? { from: [Number(move[1]), Number(move[2])] as [number, number] } : {}),
      h: ANCHOR[an] ?? 0.5,
      text: plain,
      size: Number(/\\fs(\d+(?:\.\d+)?)/.exec(tags)?.[1]) || style.size,
      scaleX: Number(/\\fscx(\d+(?:\.\d+)?)/.exec(tags)?.[1]) || style.scaleX,
      spacing: Number(/\\fsp(-?\d+(?:\.\d+)?)/.exec(tags)?.[1] ?? style.spacing),
      face: faceFor(font, style.bold),
      style: ev.values[st] ?? "",
      usual: !/\\fs(?:\d|cx|c\d)/.test(tags.replace(/\\t\([^)]*\)/g, ""))
    });
  }
  if (!pieces.length) return undefined;

  // A piece flying out of its line (\move from where a copy of it stands, to where none does) stands in
  // that line by where it starts, so it moves with it.
  const placed = new Map<string, Piece[]>();
  for (const p of pieces) {
    const key = `${p.style}\u0000${p.text}`;
    placed.set(key, [...(placed.get(key) ?? []), p]);
  }
  const standsAt = (p: Piece, x: number, y: number) => placed.get(`${p.style}\u0000${p.text}`)!.some((q) => q !== p && Math.abs(q.x - x) <= nearOf(p) && Math.abs(q.y - y) <= Y_NEAR);
  const leaving = pieces.filter((p) => p.from && (Math.abs(p.from[0] - p.x) > nearOf(p) || Math.abs(p.from[1] - p.y) > Y_NEAR) && standsAt(p, ...p.from) && !standsAt(p, p.x, p.y));
  for (const p of leaving) [p.x, p.y] = p.from!;
  // One sliding sideways into its place (a karaoke whose syllables slide in, in hops, with trails) gives
  // its line no fixed places to lay out from: lines shown with it are left as they are.
  const flying = new Set(pieces.filter((p) => p.from && !leaving.includes(p) && Math.abs(p.from[0] - p.x) > nearOf(p)));

  // Lines: a style's pieces at one anchor and one height (within Y_NEAR of the next), together on screen.
  const groups = new Map<string, Piece[]>();
  for (const p of pieces) {
    const key = `${p.style}\u0000${p.h}`;
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  const rows: Piece[][] = [];
  for (const group of groups.values()) {
    let row: Piece[] = [];
    for (const p of group.sort((a, b) => a.y - b.y)) {
      if (row.length && p.y - row[row.length - 1].y > Y_NEAR) {
        rows.push(row);
        row = [];
      }
      row.push(p);
    }
    if (row.length) rows.push(row);
  }
  const lines: Piece[][] = [];
  const split = (chain: Piece[]) => (chain.some((p) => flying.has(p)) ? [] : apart(chain));
  const chains: Piece[][] = [];
  for (const row of rows) {
    let chain: Piece[] = [];
    let until = -Infinity;
    for (const p of row.sort((a, b) => a.start - b.start)) {
      if (chain.length && p.start >= until) {
        chains.push(chain);
        lines.push(...split(chain));
        chain = [];
      }
      chain.push(p);
      until = Math.max(chain.length > 1 ? until : -Infinity, p.end);
    }
    if (chain.length) {
      chains.push(chain);
      lines.push(...split(chain));
    }
  }
  const slotOf = new Map<Piece, Slot>();
  for (const line of lines) for (const [p, slot] of slotsOf(line)) slotOf.set(p, slot);
  const wholes = new Map(lines.map((line) => [line, rowOf(line.map((p) => slotOf.get(p)!))]));

  // How the old font's widths compare with the new one's, a style at a time: the least reach of neighbours
  // (no word between them), among reaches two fonts' widths can stand in. Measured on the pieces on
  // screen together that make one row as they are; a style with none such is measured on its lines.
  const reachesIn = (rowsOf: Array<[string, Slot[] | undefined]>) => {
    const reaches = new Map<string, number[]>();
    for (const [style, set] of rowsOf) {
      const list = reaches.get(style) ?? [];
      for (let i = 0; set && i + 1 < set.length; i++) {
        const [wa, wb] = [widthOf(set[i]), widthOf(set[i + 1])];
        const reach = wa && wb ? reachOf(set[i], set[i + 1], wa, wb) : 0;
        if (reach >= WIDTH_SHARE[0] && reach <= REACH_MAX) list.push(reach);
      }
      reaches.set(style, list);
    }
    return reaches;
  };
  const oneRow = (set: Slot[] | undefined) =>
    set?.every((s, i) => i === 0 || reachOf(set[i - 1], s, widthOf(set[i - 1]) ?? 0, widthOf(s) ?? 0) >= WIDTH_SHARE[0]) ? set : undefined;
  const asTheyAre = reachesIn(chains.map((c) => [c[0].style, oneRow(distinct(slotsOf(c).values()))]));
  const asLines = reachesIn(lines.map((line) => [line[0].style, wholes.get(line)?.row]));
  const ratios = new Map<string, number>();
  for (const style of new Set([...asTheyAre.keys(), ...asLines.keys()])) {
    const list = (asTheyAre.get(style)?.length ?? 0) >= MIN_PAIRS ? asTheyAre.get(style)! : asLines.get(style) ?? [];
    if (list.length < MIN_PAIRS) continue;
    const ratio = list.sort((a, b) => a - b)[Math.floor(list.length / 4)];
    if (ratio >= RATIO_MIN && ratio <= WIDTH_SHARE[1]) ratios.set(style, ratio);
  }

  const done = new Set<string>();
  let count = 0;
  const layouts: Array<{ style: string; y: number; beside: Array<[number, number]>; at: [number, number]; map: (x: number) => number }> = [];
  const shifted = new Map<Piece, { by: number; map: (x: number) => number }>();
  const moveOn = (p: Piece, lay: Layout) => {
    const slot = slotOf.get(p)!;
    const nx = lay.moved.get(slot);
    if (nx === undefined) return false;
    p.ev.values[tx] = moveBy(p.ev.values[tx], nx - slot.x, lay.map);
    shifted.set(p, { by: nx - slot.x, map: lay.map });
    return true;
  };
  const plans = new Map<Piece[], Layout>();
  for (const line of lines) {
    const ratio = ratios.get(line[0].style);
    const all = wholes.get(line);
    const own = styles.get(line[0].style);
    const once = ratio && all && layout(all.row, ratio, [own?.marginL ?? 0, across - (own?.marginR ?? 0)]);
    if (!once) continue;
    placeMade(once, all.made);
    plans.set(line, once);
  }
  // A layout is kept only where it leaves a row as it was set. Pieces shown from one moment to another
  // together, at one height, are one row: a line whose pieces would come to stand over such pieces, of
  // another line or of none, that they stood clear of, is a row read in parts, and is left as it is.
  const lineIx = new Map<Piece, number>();
  lines.forEach((line, n) => line.forEach((p) => lineIx.set(p, n)));
  const planned = lines.map((line) => plans.has(line));
  const over = (p: Piece, q: Piece, px: number, pw: number, qx: number, qw: number) =>
    Math.min(pw, qw) > 0 ? (Math.min(px + (1 - p.h) * pw, qx + (1 - q.h) * qw) - Math.max(px - p.h * pw, qx - q.h * qw)) / Math.min(pw, qw) : 0;
  // Only styles with a layout to keep or leave, each style's pieces in order of appearance.
  for (const style of new Set(lines.filter((line) => plans.has(line)).map((line) => line[0].style))) {
    const row = pieces.filter((p) => p.style === style).sort((a, b) => a.start - b.start);
    const ix = row.map((p) => lineIx.get(p) ?? -1);
    const ratio = ratios.get(style) ?? 1;
    const wide = row.map((p) => widthOf(p) ?? 0);
    // Where a piece comes to stand and how wide: laid out again in the new font, else as it is at the old one's width.
    const stands = (n: number): [number, number] => {
      const nx = ix[n] >= 0 && planned[ix[n]] ? plans.get(lines[ix[n]])!.moved.get(slotOf.get(row[n])!) : undefined;
      return nx === undefined ? [row[n].x, ratio * wide[n]] : [nx, wide[n]];
    };
    for (let again = true; again; ) {
      again = false;
      const wrong = new Set<number>();
      for (let i = 0; i < row.length; i++) {
        const p = row[i];
        for (let j = i + 1; j < row.length && row[j].start - p.start <= HOP_MS; j++) {
          if ((ix[i] === ix[j] && ix[i] >= 0) || !((ix[i] >= 0 && planned[ix[i]]) || (ix[j] >= 0 && planned[ix[j]]))) continue;
          const q = row[j];
          if (Math.abs(q.end - p.end) > HOP_MS || Math.abs(q.y - p.y) > Y_NEAR) continue;
          if (over(p, q, p.x, ratio * wide[i], q.x, ratio * wide[j]) > CLEAR || over(p, q, ...stands(i), ...stands(j)) <= COVERED) continue;
          for (const n of [ix[i], ix[j]]) if (n >= 0 && planned[n]) wrong.add(n);
        }
      }
      for (const n of wrong) {
        planned[n] = false;
        plans.delete(lines[n]);
        again = true;
      }
    }
  }
  for (const line of lines) {
    let changed = false;
    const end = Math.max(...line.map((p) => p.end));
    const once = plans.get(line);
    if (once) {
      layouts.push({ style: line[0].style, y: line[0].y, beside: once.beside, at: [line[0].start, end], map: once.map });
      for (const p of line) changed = moveOn(p, once) || changed;
    }
    if (changed) {
      done.add(line[0].style);
      count++;
    }
  }
  if (!count) return undefined;

  // A copy of a moved piece shown from the moment it ends (its last phase, fading out once its line is
  // gone) moves as it did.
  const after = new Set<Piece>();
  const movedAs = new Map<string, Piece[]>();
  for (const q of shifted.keys()) movedAs.set(`${q.style}\u0000${q.text}`, [...(movedAs.get(`${q.style}\u0000${q.text}`) ?? []), q]);
  for (const p of pieces) {
    if (shifted.has(p)) continue;
    const q = movedAs.get(`${p.style}\u0000${p.text}`)?.find((q) => Math.abs(q.end - p.start) <= HOP_MS && Math.abs(q.x - p.x) <= nearOf(p) && Math.abs(q.y - p.y) <= Y_NEAR);
    if (!q) continue;
    const as = shifted.get(q)!;
    p.ev.values[tx] = moveBy(p.ev.values[tx], as.by, as.map);
    after.add(p);
  }

  // Shapes drawn with a line move as its pieces beside them do.
  for (const d of drawn) {
    if (!done.has(d.style)) continue;
    const near = layouts.filter((l) => l.style === d.style && l.at[0] <= d.start && d.start < l.at[1]).sort((a, b) => Math.abs(a.y - d.y) - Math.abs(b.y - d.y))[0];
    if (!near) continue;
    const body = d.ev.values[tx];
    const x = Number(POS.exec(body)?.[1] ?? MOVE.exec(body)?.[1]);
    if (!near.beside.some(([from, to]) => x >= from && x <= to)) continue;
    d.ev.values[tx] = moveBy(body, undefined, near.map);
  }

  // The styles take the new font; a font named in a moved piece too.
  for (const v of script.styles) {
    const name = v[sf("Name")] ?? "";
    if (!done.has(name)) continue;
    const style = styles.get(name)!;
    const face = faceFor(style.font, style.bold);
    v[sf("Fontname")] = face.name;
    if (face.bold && sf("Bold") >= 0) v[sf("Bold")] = "-1";
  }
  for (const p of pieces) if (done.has(p.style)) p.ev.values[tx] = p.ev.values[tx].replace(/\\fn[^\\}]+/g, `\\fn${p.face.name}`);
  // A piece left where it stands, in a style that takes the new font, is drawn as wide as the old font
  // drew it: its place was made for that width, and the new font's letters at their own would overlap
  // their neighbours or stand apart.
  const left = [...pieces.filter((p) => !shifted.has(p) && !after.has(p)), ...unread];
  for (const p of left) if (done.has(p.style)) p.ev.values[tx] = asWide(p.ev.values[tx], ratios.get(p.style)!, p.scaleX);
  return { text: writeScript(script), lines: count };
}

/**
 * A piece's tags with its width scaled by `ratio`: every \fscx it has (those it changes to over time
 * too), and one at its start when it sets none there, from its style's.
 */
function asWide(body: string, ratio: number, styleScaleX: number): string {
  const scaled = body.replace(/\\fscx(\d+(?:\.\d+)?)/g, (_m, value: string) => `\\fscx${fmt(Number(value) * ratio)}`);
  const first = /\{([^}]*)\}/.exec(scaled);
  if (first && first[1].includes("\\fscx") && /\\fscx\d/.test(first[1].replace(/\\t\([^)]*\)/g, ""))) return scaled;
  const own = `\\fscx${fmt(styleScaleX * ratio)}`;
  return first && first.index === 0 ? `{${own}${scaled.slice(1)}` : `{${own}}${scaled}`;
}

/**
 * The line a script's [Script Info] carries once its songs are laid out (laidOutForPlayers): a key
 * players don't know and skip, kept through the merge with English Dub's lines (parseScript keeps info
 * lines, not comments), so a download sends it as it is.
 */
export const LAID_OUT = "Songs Laid Out: in fonts players have";

/** Whether a script's songs are laid out already. */
export const laidOut = (text: string) => text.includes(LAID_OUT);

/**
 * An ASS or SSA script with its songs laid out again (respaceSongs) and marked LAID_OUT, done as it is
 * saved (synced, or signs kept) so no download waits for it; any other subtitle as it is.
 */
export function laidOutForPlayers(text: string, ext: string): string {
  if (!/^\.(ass|ssa)$/i.test(ext) || laidOut(text)) return text;
  const head = /^\[Script Info\][^\n]*\n/im;
  if (!head.test(text)) return text;
  const out = respaceSongs(text)?.text ?? text;
  return out.replace(head, (line) => `${line}${LAID_OUT}${line.endsWith("\r\n") ? "\r\n" : "\n"}`);
}

/** A piece's tags moved: its anchor by `delta` (or each x through `map` when no delta), its clips' edges through `map`. */
function moveBy(body: string, delta: number | undefined, map: (x: number) => number): string {
  const to = (x: string) => fmt(delta === undefined ? map(Number(x)) : Number(x) + delta);
  return body
    .replace(POS, (_m, x: string, y: string) => `\\pos(${to(x)},${y.trim()})`)
    .replace(MOVE, (_m, x1: string, y1: string, x2: string, y2: string, rest?: string) => `\\move(${to(x1)},${y1.trim()},${to(x2)},${y2.trim()}${rest ?? ""})`)
    .replace(CLIP, (_m, kind: string, x1: string, y1: string, x2: string, y2: string) => `\\${kind}(${fmt(map(Number(x1)))},${y1.trim()},${fmt(map(Number(x2)))},${y2.trim()})`);
}
