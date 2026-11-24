/**
 * The dashboard's numbers (usage and health), so the owner can see what the addon costs this server. Counts
 * per day go to cache/stats/<date>.json (the cache survives deploys), written
 * every minute and on shutdown. Only numbers and anonymous link ids are kept:
 * never keys, URLs or what anyone watched.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, statfs, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cachePath } from "./cache.js";
import { deletedLinks, knownLinks, linkSummary, pausedLinks, type LinkSummary } from "./profile.js";

type Counters = Record<string, number>;

interface Day {
  date: string;
  total: Counters;
  /** Per link (Profile.name: AIOStreams uuid prefix and key tag), with lastSeen as epoch ms. */
  links: Record<string, Counters>;
  /** Highest memory seen: Node alone (rssMb), and the whole container with any ffmpeg running (memMb). */
  peak: { load1?: number; rssMb?: number; memMb?: number };
  /**
   * Per API key ("subsource:3fa2c1", an anonymous id from a hash of the key): calls, calls the
   * service refused, the busiest minute, and the quota the service reported, if it ever did.
   */
  keys?: Record<string, KeyUsage>;
  /**
   * What was counted while it was tagged as debug (a debug session, or a test configuration): the same
   * counters, kept apart so the dashboard's numbers leave them out. Days saved before it have none.
   */
  debug?: DebugCounts;
}

/** A day's debug-tagged counts (see Day.debug). */
export interface DebugCounts {
  total: Counters;
  links: Record<string, Counters>;
  keys?: Record<string, KeyUsage>;
}

export interface KeyUsage {
  /** Every call made with the key, downloads included. */
  calls: number;
  /** The calls that were downloads (SubDL limits them on their own). */
  downloads?: number;
  refused: number;
  busiestMinute: number;
  /** The link that used it last. */
  link?: string;
  lastAt?: number;
  lastRefusedAt?: number;
  /** The site's own rate-limit headers from the newest call, as sent (numbers and times, never the key). */
  headers?: Record<string, string>;
}

/** Calls made with one key in the last minute, hour and 24 hours, for limits counted that way. */
export interface KeyWindows {
  minute: number;
  hour: number;
  day: number;
}

/** One request, for the recent-activity list: the owner's own view, so the episode is kept. */
export interface Activity {
  at: number;
  link: string;
  kind: "list" | "download";
  what: string;
  result: string;
  ms: number;
  /** Tagged as debug as it was recorded, in an open debug period. Missing (as in older logs) is real. */
  debug?: boolean;
  /** The open period that tagged it: when that period is removed, the tag goes with it. */
  period?: string;
  /** What the dashboard shows when the row is opened. Missing (as in older logs): nothing more. */
  detail?: ActivityDetail;
  /** The request's own id: errors noted during it, even after it answered, carry it (ErrorNote.req). */
  req?: string;
  /** On a page of the log only, never stored: what failed during the request (its errors, by req). */
  failed?: Array<{ where: string; message: string }>;
}

/** The detail of one request, kept small: it's written with the activity log. */
export interface ActivityDetail {
  /** A list: each track sent, best first. */
  tracks?: Array<{ lang: string; source: string; ref: string; release?: string; state: "synced" | "sync pending" | "not synced" | "no file" }>;
  /** Sources that didn't answer within the list's time, so they were left out of it. */
  late?: string[];
  /** A download: the subtitle sent, where from and how it was timed. */
  source?: string;
  ref?: string;
  /** The subtitle the list had named, when another took its place (it couldn't be fetched). */
  listed?: string;
  timing?: string;
  /** How well the timing fits the file: the median share over the windows it was measured in, 0 to 100. */
  fit?: number;
  windows?: number;
  /** A fallback sent instead, because the listed one didn't sync to the file. */
  fallback?: string;
  /** The playing file's whole name and size in bytes, and the video it is ("tt0000001:1:2"). */
  file?: string;
  size?: number;
  video?: string;
  /** A download: the upload's release name, as the list that offered it gave it. */
  release?: string;
  /** What the timing was measured against: a track's language as tagged ("und" untagged), or "speech". */
  reference?: string;
  /** The subtitle's own language, as the link asked for it (none for dub captions). */
  lang?: string;
  /** Lines moved onto the file's line starts, and onto their own line by pairing. */
  snapped?: number;
  moved?: number;
  /** The smallest and largest shift over the windows measured, ms. */
  spread?: [number, number];
  /** English Dub sent with signs & songs: the signs track and its release, and what of each copy was left out (signs.ts). */
  signs?: string;
  signsDropped?: { dubSigns: number; dubSongs: number; songs: number; heavy?: number; plained?: number };
  /** Sent in the playing file's own subtitle style. */
  styled?: "file";
  /** A list: every source it waited on, in the order they settled: how long, how many it gave, in time or not. */
  sources?: Array<{ name: string; ms: number; got?: number; state: "in time" | "late" | "partly" | "failed" }>;
  /** A list a player asked ahead for the next episode while the one before it started: its Anime Tosho work waited behind that one's. */
  ahead?: boolean;
  /** Who asked: the request's User-Agent, cut short (a player, or a server asking for one). */
  client?: string;
  /** A download: what was sent, how big, and whether the player may keep it (or asks again next time). */
  sent?: { format: "srt" | "ass"; bytes: number; kept: boolean; gzip?: boolean };
}

/** An activity detail trimmed to its limits, so a busy log stays small. */
function trimDetail(detail: ActivityDetail | undefined): ActivityDetail | undefined {
  if (!detail) return undefined;
  const cut = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return {
    ...detail,
    ...(detail.tracks ? { tracks: detail.tracks.slice(0, 8).map((t) => ({ ...t, release: cut(t.release, 200) })) } : {}),
    ...(detail.late ? { late: detail.late.slice(0, 8) } : {}),
    ...(detail.sources ? { sources: detail.sources.slice(0, 24).map((s) => ({ ...s, name: cut(s.name, 60) ?? "" })) } : {}),
    ...(detail.client ? { client: cut(detail.client, 80) } : {}),
    ...(detail.timing ? { timing: cut(detail.timing, 120) } : {}),
    ...(detail.file ? { file: cut(detail.file, 300) } : {}),
    ...(detail.release ? { release: cut(detail.release, 200) } : {})
  };
}

/** The release name a recent list gave this subtitle, newest first: downloads don't carry it. */
export function listedRelease(ref: string): string | undefined {
  for (const a of activity) {
    if (a.kind !== "list") continue;
    const release = a.detail?.tracks?.find((t) => t.ref === ref)?.release;
    if (release) return release;
  }
  return undefined;
}

/** Which link a request is for, carried through everything it starts (searches, downloads, syncs). */
export const requestContext = new AsyncLocalStorage<{ link: string; req?: string }>();

export interface ErrorNote {
  at: number;
  where: string;
  message: string;
  /** The link whose request it happened in, and what that request was for, when known. */
  link?: string;
  what?: string;
  /** Tagged as debug, as for Activity. */
  debug?: boolean;
  period?: string;
  /** The request it happened in (Activity.req): a source can fail after the request answered. */
  req?: string;
  /** On the dashboard's copy only: that request's row is in the activity log, so it can be shown. */
  inLog?: boolean;
}

/**
 * A stretch of time whose requests and errors are testing, not use (debug.json): for one configuration
 * (`link`) or all of them. Open while it has no `to`. Applied when the data is read, so a period added
 * or removed afterwards changes every view that has timestamps.
 */
export interface DebugPeriod {
  id: string;
  from: number;
  to?: number;
  link?: string;
  note?: string;
}
/** At most this many periods are kept. */
export const MAX_PERIODS = 300;

const KEEP_DAYS = 60;
const started = Date.now();
let today: Day = emptyDay(dateOf(Date.now()));
/** How many recent errors are kept for the dashboard; a count since a clear can't go past it. */
export const ERRORS_KEPT = 30;
let errors: ErrorNote[] = [];
/** When the owner last cleared the recent errors (errors-cleared.json); 0 for never. */
let errorsClearedAt = 0;
/**
 * What the day of the clear had already counted as errors, failures and refusals when it was cleared:
 * that day's numbers count from there, and days before it count none. Nothing stored is changed.
 */
export interface ClearBase {
  date: string;
  counts: Record<string, number>;
  refused: Record<string, number>;
  /** Each link's own error counts at that moment (a link's clear counts from its own, see linkCleared). */
  links?: Record<string, Record<string, number>>;
}
/** One link's clear: when, what its day had counted then, and the clear before it for Undo. */
export interface LinkClear {
  at: number;
  base?: ClearBase;
  undo?: { at: number; base?: ClearBase };
}
let linkErrors: Record<string, LinkClear> = {};
let linkActivity: Record<string, { at: number; undo?: { at: number } }> = {};
let errorsBase: ClearBase | undefined;
/** The clear before the last one, for Undo (kept in errors-cleared.json, so a restart keeps it). */
let undoClear: { at: number; base?: ClearBase } | undefined;
/** When the owner last cleared the activity log (activity-cleared.json): the log starts after it. */
let activityClearedAt = 0;
let undoActivity: { at: number } | undefined;
let activity: Activity[] = [];
/** The debug periods (debug.json), oldest first, and the last one removed, for Undo. */
let periods: DebugPeriod[] = [];
let loaded = false;
let dirty = false;

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function emptyDay(date: string): Day {
  return { date, total: {}, links: {}, peak: {} };
}

/** The period covering a moment for a configuration (or any, for something with no configuration), if one does. */
function periodAt(at: number, link: string | undefined, list: DebugPeriod[] = periods): DebugPeriod | undefined {
  return list.find((p) => at >= p.from && (p.to === undefined || at < p.to) && (!p.link || p.link === link));
}

/** Whether a request or error is debug: tagged when recorded (by a period that still exists), or inside one. */
export function isDebugEntry(e: { at: number; link?: string; debug?: boolean; period?: string }, list: DebugPeriod[] = periods): boolean {
  if (e.debug && (!e.period || list.some((p) => p.id === e.period))) return true;
  return Boolean(periodAt(e.at, e.link, list));
}

/** Whether what happens now, for this link (or the request's), is tagged as debug: an open period covers it. */
export function isDebug(link: string | undefined = requestContext.getStore()?.link): boolean {
  return Boolean(periodAt(Date.now(), link));
}

/** The open period that tags what happens now for a link, for its `period` field. */
function tagFor(link: string | undefined): { debug: true; period: string } | Record<string, never> {
  const p = periodAt(Date.now(), link);
  return p ? { debug: true, period: p.id } : {};
}

const newId = () => randomBytes(4).toString("hex");
const cleanNote = (note: unknown) => (typeof note === "string" ? note.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80) : "") || undefined;

/** Starts a debug session now, for one configuration or all; one already open for the same scope is kept. */
export async function startDebug(opts: { link?: string; note?: string } = {}): Promise<{ period: DebugPeriod } | { error: string }> {
  const open = periods.find((p) => p.to === undefined && (p.link ?? "") === (opts.link ?? ""));
  if (open) return { period: open };
  if (periods.length >= MAX_PERIODS) return { error: `At most ${MAX_PERIODS} debug periods. Remove an old one first` };
  const period: DebugPeriod = { id: newId(), from: Date.now(), ...(opts.link ? { link: opts.link } : {}), ...(cleanNote(opts.note) ? { note: cleanNote(opts.note) } : {}) };
  periods = [...periods, period];
  dirty = true;
  await flush();
  return { period };
}

/** Ends the open session with this id, or every open one. */
export async function stopDebug(id?: string): Promise<number> {
  let stopped = 0;
  periods = periods.map((p) => (p.to === undefined && (!id || p.id === id) ? (stopped++, { ...p, to: Date.now() }) : p));
  if (stopped) {
    dirty = true;
    await flush();
  }
  return stopped;
}

/** Adds a past period: from before to, neither in the future. */
export async function addDebugPeriod(opts: { from: number; to: number; link?: string; note?: string }): Promise<{ period: DebugPeriod } | { error: string }> {
  const { from, to } = opts;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { error: "From and to: both needed, as a date and time" };
  if (from >= to) return { error: "From: must be before to" };
  if (to > Date.now() + 60_000) return { error: "To: can't be in the future. Start a debug session for what comes next" };
  if (periods.length >= MAX_PERIODS) return { error: `At most ${MAX_PERIODS} debug periods. Remove an old one first` };
  const period: DebugPeriod = { id: newId(), from, to: Math.min(to, Date.now()), ...(opts.link ? { link: opts.link } : {}), ...(cleanNote(opts.note) ? { note: cleanNote(opts.note) } : {}) };
  periods = [...periods, period].sort((a, b) => a.from - b.from);
  dirty = true;
  await flush();
  return { period };
}

/** Removes a period: what it covered counts as real again (Undo brings it back). */
export async function removeDebugPeriod(id: string): Promise<boolean> {
  const gone = periods.find((p) => p.id === id);
  if (!gone) return false;
  periods = periods.filter((p) => p.id !== id);
  dirty = true;
  await flush();
  return true;
}


export function debugPeriods(): { periods: DebugPeriod[] } {
  return { periods };
}

/**
 * Debug marking from outside the server: `node dist/debugMark.js start <configuration>` (see that file)
 * writes stats/debug-command.json; the server applies it within 2 s and answers in
 * debug-command.done.json. No page or route for it: it's a tool for whoever is testing, on the server.
 */
const COMMAND = "debug-command.json";
const ANSWER = "debug-command.done.json";

/** A configuration by its id, the start of its id, or its name (any case). */
function findLink(query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const ids = [...new Set([...Object.keys(labels), ...activity.map((a) => a.link).filter((l): l is string => Boolean(l))])];
  return ids.find((id) => id.toLowerCase() === q) ?? ids.find((id) => (labels[id] ?? "").toLowerCase() === q) ?? ids.find((id) => id.toLowerCase().startsWith(q));
}

const describe = (p: DebugPeriod) => `${p.id}  ${new Date(p.from).toISOString()} → ${p.to === undefined ? "open" : new Date(p.to).toISOString()}  ${p.link ? `${labels[p.link] ?? ""} ${p.link}`.trim() : "all configurations"}${p.note ? `  "${p.note}"` : ""}`;

async function runCommand(cmd: { cmd?: string; config?: string; note?: string; from?: string; to?: string; id?: string }): Promise<{ ok: boolean; message: string }> {
  const link = cmd.config && cmd.config !== "all" ? findLink(cmd.config) : undefined;
  if (cmd.config && cmd.config !== "all" && !link) return { ok: false, message: `No configuration matches "${cmd.config}"` };
  switch (cmd.cmd) {
    case "start": {
      const r = await startDebug({ link, note: cmd.note });
      return "error" in r ? { ok: false, message: r.error } : { ok: true, message: `Marking as debug: ${describe(r.period)}` };
    }
    case "stop": {
      const n = await stopDebug();
      return { ok: true, message: n ? `Stopped ${n} debug marking${n === 1 ? "" : "s"}` : "Nothing was being marked" };
    }
    case "mark": {
      const r = await addDebugPeriod({ from: Date.parse(cmd.from ?? ""), to: Date.parse(cmd.to ?? ""), link, note: cmd.note });
      return "error" in r ? { ok: false, message: r.error } : { ok: true, message: `Marked: ${describe(r.period)}` };
    }
    case "unmark":
      return (await removeDebugPeriod(cmd.id ?? "")) ? { ok: true, message: `Removed ${cmd.id}` } : { ok: false, message: `No period ${cmd.id}` };
    case "status":
      return { ok: true, message: periods.length ? periods.map(describe).join("\n") : "No debug periods" };
    default:
      return { ok: false, message: `Unknown command "${cmd.cmd}"` };
  }
}

/** Applies a waiting command file, if there is one. */
export async function debugCommandTick(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir(), COMMAND), "utf8");
  } catch {
    return;
  }
  await rm(path.join(dir(), COMMAND), { force: true });
  let answer: { ok: boolean; message: string };
  try {
    answer = await runCommand(JSON.parse(raw));
  } catch (e) {
    answer = { ok: false, message: `Couldn't read the command: ${(e as Error).message}` };
  }
  await writeFile(path.join(dir(), ANSWER), JSON.stringify({ ...answer, at: Date.now() }));
}

/** Reads debug.json, leaving out anything malformed in it. */
export function readDebugFile(saved: unknown): { periods: DebugPeriod[] } {
  if (!saved || typeof saved !== "object") return { periods: [] };
  const raw = saved as { periods?: unknown };
  const valid = (p: unknown): p is DebugPeriod => {
    const q = p as DebugPeriod;
    return Boolean(q) && typeof q.id === "string" && Number.isFinite(q.from) && (q.to === undefined || (Number.isFinite(q.to) && q.to > q.from)) && (q.link === undefined || typeof q.link === "string") && (q.note === undefined || typeof q.note === "string");
  };
  const out: DebugPeriod[] = Array.isArray(raw.periods) ? raw.periods.filter(valid) : [];
  return { periods: out.sort((a, b) => a.from - b.from).slice(-MAX_PERIODS) };
}


/** Where a count goes: today's own counters, or its debug ones. */
function bucket(debug: boolean): { total: Counters; links: Record<string, Counters>; keys?: Record<string, KeyUsage> } {
  return debug ? (today.debug ??= { total: {}, links: {} }) : today;
}

function dir(): string {
  return cachePath("stats");
}

function rollover(): void {
  const date = dateOf(Date.now());
  if (today.date === date) return;
  void flush(today);
  today = emptyDay(date);
}

/** Adds n to a counter for today, and to the link's: the one given, or the request's for calls to sites. */
export function count(name: string, n = 1, link: string | undefined = /^(api|fetch)\./.test(name) ? requestContext.getStore()?.link : undefined): void {
  if (!Number.isFinite(n) || n === 0) return;
  rollover();
  const into = bucket(isDebug(link ?? requestContext.getStore()?.link));
  into.total[name] = (into.total[name] ?? 0) + n;
  if (link) {
    const mine = (into.links[link] ??= {});
    mine[name] = (mine[name] ?? 0) + n;
    mine.lastSeen = Date.now();
  }
  dirty = true;
}

/** Downloads made with a key so far today (UTC day, as SubDL counts them). */
export function downloadsToday(service: string, key: string): number {
  rollover();
  const id = keyId(service, key);
  return (today.keys?.[id]?.downloads ?? 0) + (today.debug?.keys?.[id]?.downloads ?? 0);
}

/** Today's total for a counter so far. */
export function countedToday(name: string): number {
  rollover();
  return (today.total[name] ?? 0) + (today.debug?.total[name] ?? 0);
}

/** Busiest minute per key, kept in memory: the minute being counted and its calls so far. */
const minutes = new Map<string, { minute: number; calls: number }>();

/** The anonymous id of a key: the service and a short hash, never the key. */
export function keyId(service: string, key: string): string {
  return `${service}:${createHash("sha256").update(key).digest("hex").slice(0, 6)}`;
}

/**
 * One call made with a key: counted for that key and the request's link, with the busiest minute,
 * a refusal when the service answers 429 (too many requests), and any quota the service reports.
 */
export function noteKeyCall(service: string, key: string | undefined, response: Response | undefined, download = false): void {
  if (!key) return;
  rollover();
  const id = keyId(service, key);
  const usage = ((bucket(isDebug()).keys ??= {})[id] ??= { calls: 0, refused: 0, busiestMinute: 0 });
  usage.calls++;
  if (download) usage.downloads = (usage.downloads ?? 0) + 1;
  usage.lastAt = Date.now();
  const times = (recentCalls[id] ??= []);
  times.push(Date.now());
  // A day of calls at most: enough for a 24-hour window, and capped well above a free plan's day.
  if (times.length > 12000 || Date.now() - times[0] > DAY_MS) recentCalls[id] = times.filter((t) => Date.now() - t < DAY_MS).slice(-12000);
  const link = requestContext.getStore()?.link;
  if (link) usage.link = link;
  const minute = Math.floor(Date.now() / 60000);
  const current = minutes.get(id);
  const now = current && current.minute === minute ? { minute, calls: current.calls + 1 } : { minute, calls: 1 };
  minutes.set(id, now);
  usage.busiestMinute = Math.max(usage.busiestMinute, now.calls);
  if (response) {
    if (response.status === 429) {
      usage.refused++;
      usage.lastRefusedAt = Date.now();
    }
    // SubSource says it sends rate-limit headers but not their names: keep whatever looks like one,
    // and Wyzie's own (x-wyzie-balance, -plan, -cost: what a key has left, on downloads too).
    const rate: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (/rate|limit|quota|retry-after|remaining|usage|^x-wyzie-/i.test(name) && value.length <= 64) rate[name] = value;
    });
    if (Object.keys(rate).length) usage.headers = rate;
  }
  dirty = true;
}

const DAY_MS = 86_400_000;
/** Each key's call times over the last day, kept across restarts (keys-recent.json). */
let recentCalls: Record<string, number[]> = {};

/** Calls in the last minute, hour and 24 hours for each key. */
export function keyWindows(): Record<string, KeyWindows> {
  const now = Date.now();
  const out: Record<string, KeyWindows> = {};
  for (const [id, times] of Object.entries(recentCalls)) {
    let minute = 0;
    let hour = 0;
    let day = 0;
    for (const t of times) {
      const age = now - t;
      if (age < DAY_MS) day++;
      if (age < 3_600_000) hour++;
      if (age < 60_000) minute++;
    }
    if (day) out[id] = { minute, hour, day };
  }
  return out;
}

/**
 * A link's keys, noted on each of its requests even when nothing is fetched (a cached list), so
 * every key shows on the usage page from the link's first use, before its first call.
 */
export function noteLinkKeys(link: string, keys: Array<[service: string, key: string | undefined]>): void {
  rollover();
  for (const [service, key] of keys) {
    if (!key) continue;
    const usage = ((bucket(isDebug(link)).keys ??= {})[keyId(service, key)] ??= { calls: 0, refused: 0, busiestMinute: 0 });
    if (usage.link !== link && !usage.lastAt) {
      usage.link = link;
      dirty = true;
    }
  }
}

/** Names links were given on the configure page, by link id (labels.json). */
let labels: Record<string, string> = {};

/** The name a link carries, noted from its requests so the dashboard can show it. */
export function noteLinkLabel(link: string, label: string | undefined): void {
  if (!label || labels[link] === label) return;
  labels = { ...labels, [link]: label };
  dirty = true;
}

/** A name given on the dashboard, or none: takes the place of the one its requests carried. */
export function setLinkLabel(link: string, label: string | undefined): void {
  if (label) noteLinkLabel(link, label);
  else if (Object.hasOwn(labels, link)) {
    const { [link]: _old, ...rest } = labels;
    labels = rest;
    dirty = true;
  }
}

/** How much activity is kept: the last 7 days, at most this many (about 750 KB on disk). */
const ACTIVITY_DAYS = 7;
const ACTIVITY_MAX = 5000;
export const ACTIVITY_PAGE = 50;
/** The fewest rows on a page a screen can ask for; a phone asks for ACTIVITY_PHONE_MIN, and scrolls. */
export const ACTIVITY_MIN = 5;
export const ACTIVITY_PHONE_MIN = 10;
/** The dashboard's timetable: every request of the last 24 hours, newest first, at most this many. */
const RECENT_MAX = 600;

/** One finished request, for the activity list (see ACTIVITY_DAYS). */
export function noteActivity(entry: Omit<Activity, "at">): void {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  activity = [{ at: Date.now(), ...entry, ...(entry.detail ? { detail: trimDetail(entry.detail) } : {}), ...tagFor(entry.link) }, ...activity.filter((a) => a.at >= since)].slice(0, ACTIVITY_MAX);
  dirty = true;
}

/** The activity log from `since` on, newest first, after the last clear of the log. */
function logged(since: number): Activity[] {
  return activity.filter((a) => a.at >= since && a.at > Math.max(activityClearedAt, linkActivity[a.link]?.at ?? 0));
}

/** When errors start counting for a link: the later of the clear of everything and the link's own. */
export function errorCutoff(link?: string): number {
  return Math.max(errorsClearedAt, link ? (linkErrors[link]?.at ?? 0) : 0);
}

/** A request or error as the dashboard shows it: marked debug when it is one, by its tag or a period. */
function marked<T extends { at: number; link?: string; debug?: boolean; period?: string }>(e: T): T {
  const debug = isDebugEntry(e);
  if (debug === Boolean(e.debug) && !e.period) return e;
  const { period: _p, debug: _d, ...rest } = e;
  return (debug ? { ...rest, debug: true } : rest) as T;
}

/** One page of activity, newest first, of one link and one kind ("list" or "download") when given. */
export function activityPage(query: { offset?: number; link?: string; kind?: string; limit?: number; debug?: boolean } = {}): { rows: Activity[]; total: number; offset: number } {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  const failed = failuresByRequest();
  // "Errors": a request that failed, or one during which something failed (a source, say, while the
  // others answered); both since the errors were last cleared.
  const isError = (a: Activity) => (a.result.startsWith("error") && a.at >= errorCutoff(a.link)) || Boolean(a.req && failed.has(a.req));
  // Debug-tagged requests only when asked for ("Show debug").
  const matching = logged(since).filter((a) => (query.debug || !isDebugEntry(a)) && (!query.link || a.link === query.link) && (!query.kind || (query.kind === "error" ? isError(a) : a.kind === query.kind)));
  // As many as fit the viewer's screen (the page asks), from ACTIVITY_MIN to ACTIVITY_PAGE.
  const size = Math.min(ACTIVITY_PAGE, Math.max(ACTIVITY_MIN, Math.floor(query.limit || ACTIVITY_PAGE)));
  // The page starts where the viewer's last page ended (pages are cut by height, so they aren't a fixed size).
  const offset = Math.min(Math.max(0, Math.floor(query.offset ?? 0)), Math.max(0, matching.length - 1));
  const rows = matching.slice(offset, offset + size).map(marked);
  return { rows: rows.map((a) => (a.req && failed.has(a.req) ? { ...a, failed: failed.get(a.req) } : a)), total: matching.length, offset };
}

/**
 * The week's activity as the dashboard draws it: every request kept since the log's last clears, newest
 * first, marked debug when it is one, each with what failed during it. The page filters and searches it.
 */
export function activityWeek(): Activity[] {
  const failed = failuresByRequest();
  return logged(Date.now() - ACTIVITY_DAYS * 86_400_000)
    .map(marked)
    .map((a) => (a.req && failed.has(a.req) ? { ...a, failed: failed.get(a.req) } : a));
}

/**
 * Whether each kept request answered, by its id (Activity.req): false when it ended in an error. An error
 * noted during a request that answered was a source failing while the others carried it.
 */
export function answeredByRequest(): Map<string, boolean> {
  return new Map(activity.flatMap((a) => (a.req ? [[a.req, !a.result.startsWith("error")] as const] : [])));
}

/** The errors noted during each request, by its id, since the errors were last cleared; each kind once. */
function failuresByRequest(): Map<string, Array<{ where: string; message: string }>> {
  const out = new Map<string, Array<{ where: string; message: string }>>();
  for (const e of errors) {
    if (!e.req || e.at < errorCutoff(e.link)) continue;
    const list = out.get(e.req) ?? [];
    if (!list.some((f) => f.where === e.where && f.message === e.message)) list.push({ where: e.where, message: e.message });
    out.set(e.req, list);
  }
  return out;
}

/** What the subtitles players fetched in the last 7 days came out as. */
export function syncOutcomes(): { served: number; synced: number; byAudio: number; asIs: number; failed: number } {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  const out = { served: 0, synced: 0, byAudio: 0, asIs: 0, failed: 0 };
  for (const a of activity) {
    if (a.at < since || a.kind !== "download" || isDebugEntry(a)) continue;
    out.served++;
    // A failure from before the errors were cleared is still a subtitle served, no longer a failure.
    if (a.result.startsWith("error")) { if (a.at >= errorCutoff(a.link)) out.failed++; }
    else if (a.result.startsWith("synced") || a.result === "first-pass timing") {
      out.synced++;
      if (a.result.includes("audio")) out.byAudio++;
    } else out.asIs++;
  }
  return out;
}

/**
 * Each configuration's week from the activity log, debug left out: lists, subtitles served and when it
 * was last seen. The log's own clears don't touch it (the week's totals stay).
 */
export function linkWeek(): Record<string, { lists: number; served: number; lastSeen: number }> {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  const out: Record<string, { lists: number; served: number; lastSeen: number }> = {};
  for (const a of activity) {
    if (a.at < since || isDebugEntry(a)) continue;
    const mine = (out[a.link] ??= { lists: 0, served: 0, lastSeen: 0 });
    if (a.kind === "list") mine.lists++;
    else mine.served++;
    mine.lastSeen = Math.max(mine.lastSeen, a.at);
  }
  return out;
}

/**
 * Each source's week from the activity log, debug left out, by the name its rows carry ("SubSource"):
 * the tracks it supplied in subtitle lists (picked), and the subtitles players got from it (served)
 * and how many of those synced, counted as syncOutcomes counts them. Per request, as the rest of the
 * week's figures are.
 */
export function sourceWeek(): Record<string, { picked: number; served: number; synced: number }> {
  const since = Date.now() - ACTIVITY_DAYS * 86_400_000;
  const out: Record<string, { picked: number; served: number; synced: number }> = {};
  const of = (source: string) => (out[source] ??= { picked: 0, served: 0, synced: 0 });
  for (const a of activity) {
    if (a.at < since || isDebugEntry(a)) continue;
    if (a.kind === "list") for (const t of a.detail?.tracks ?? []) of(t.source).picked++;
    else if (a.detail?.source) {
      const s = of(a.detail.source);
      s.served++;
      if (a.result.startsWith("synced") || a.result === "first-pass timing") s.synced++;
    }
  }
  return out;
}

/** Every link in the kept activity, for the dashboard's link filter. */
export function activityLinks(): string[] {
  return [...new Set(logged(0).map((a) => a.link))];
}

/** The owner's names for links, as the dashboard shows them (names.json, then configure-page names). */
export async function linkNames(): Promise<Record<string, string>> {
  return { ...(await readNames()), ...labels };
}

/** Text with addresses and long tokens taken out, since upstream messages can quote them. */
export function scrub(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<token>")
    .slice(0, 300);
}

/** A failure worth showing on the stats page (also counted as errors.<where>). */
export function noteError(where: string, error: unknown, what?: string): void {
  // A pack refused for not holding the episode is BttrSubs doing its job, not an error.
  if (error instanceof Error && error.name === "EpisodeNotInPack") {
    count("downloads.notInPack");
    return;
  }
  // So is an upload refused for being in another language than it is listed under.
  if (error instanceof Error && error.name === "WrongLanguage") {
    count("downloads.wrongLanguage");
    console.log(scrub(error.message));
    return;
  }
  const message = scrub(error instanceof Error ? error.message : String(error));
  count(`errors.${where}`);
  const store = requestContext.getStore();
  const link = store?.link;
  errors = [{ at: Date.now(), where, message, ...(link ? { link } : {}), ...(what ? { what } : {}), ...(store?.req ? { req: store.req } : {}), ...tagFor(link) }, ...errors].slice(0, ERRORS_KEPT);
  dirty = true;
}

/** Error and failure counters, and the playing files a list didn't hold (the Errors page counts those too): what a clear starts again from zero. */
const errorish = (key: string) => key.startsWith("errors.") || key.endsWith(".fail") || key === "sync.unlisted" || key === "sync.unlistedRecovered";

/**
 * Clears the errors, everywhere on the dashboard: from now on only errors after this moment count, in
 * the list, the overview, the timetable, the sources' failures and the keys' refusals. Nothing stored
 * is deleted (the day files keep their counts, the list keeps its notes), so Undo puts it all back.
 */
export async function clearErrors(): Promise<void> {
  undoClear = { at: errorsClearedAt, base: errorsBase };
  errorsClearedAt = Date.now();
  errorsBase = {
    date: today.date,
    counts: Object.fromEntries(Object.entries(today.total).filter(([k]) => errorish(k))),
    refused: Object.fromEntries(Object.entries(today.keys ?? {}).map(([id, u]) => [id, u.refused])),
    links: Object.fromEntries(Object.entries(today.links).map(([id, c]) => [id, Object.fromEntries(Object.entries(c).filter(([k]) => errorish(k)))]))
  };
  dirty = true;
  await flush();
}

/**
 * Clears one link's errors, everywhere on the dashboard, the same way: from now on only that link's
 * errors after this moment count. Nothing stored changes, and Undo goes back to its clear before.
 */
export async function clearLinkErrors(link: string): Promise<void> {
  const before = linkErrors[link];
  linkErrors[link] = {
    at: Date.now(),
    base: {
      date: today.date,
      counts: Object.fromEntries(Object.entries(today.links[link] ?? {}).filter(([k]) => errorish(k))),
      refused: Object.fromEntries(Object.entries(today.keys ?? {}).filter(([, u]) => u.link === link).map(([id, u]) => [id, u.refused]))
    },
    undo: { at: before?.at ?? 0, base: before?.base }
  };
  dirty = true;
  await flush();
}

export async function undoClearLinkErrors(link: string): Promise<boolean> {
  const undo = linkErrors[link]?.undo;
  if (!undo) return false;
  if (undo.at) linkErrors[link] = { at: undo.at, base: undo.base };
  else delete linkErrors[link];
  dirty = true;
  await flush();
  return true;
}

/** Clears one link's activity log: the log and the timetable show its requests after this moment. */
export async function clearLinkActivity(link: string): Promise<void> {
  linkActivity[link] = { at: Date.now(), undo: { at: linkActivity[link]?.at ?? 0 } };
  dirty = true;
  await flush();
}

export async function undoClearLinkActivity(link: string): Promise<boolean> {
  const undo = linkActivity[link]?.undo;
  if (!undo) return false;
  if (undo.at) linkActivity[link] = { at: undo.at };
  else delete linkActivity[link];
  dirty = true;
  await flush();
  return true;
}

/**
 * A day as counted after one link's clear, on top of the clear of everything: what that link counted
 * between the two moments is taken off the day's errors, failures and refusals (from the snapshots the
 * clears noted), so the overview, the sources, the keys and the badges agree with the list.
 */
export function afterLinkClears(day: Day, global: number, globalBase: ClearBase | undefined, links: Record<string, LinkClear>): Day {
  let total = day.total;
  let keys = day.keys;
  for (const [link, cut] of Object.entries(links)) {
    if (cut.at <= global) continue;
    // What the link had counted on this day before a moment: all of it before that day, the snapshot on it, none after.
    const pre = (at: number, base: ClearBase | undefined, full: number, snapshot?: (b: ClearBase) => number | undefined) => {
      if (!at) return 0;
      const d = dateOf(at);
      if (day.date < d) return full;
      if (day.date > d) return 0;
      return base && base.date === day.date && snapshot ? (snapshot(base) ?? 0) : 0;
    };
    const mine = day.links[link] ?? {};
    const next: Record<string, number> = { ...total };
    for (const [k, v] of Object.entries(mine)) {
      if (!errorish(k)) continue;
      const removed = pre(cut.at, cut.base, v, (b) => b.counts[k]) - pre(global, globalBase, v, (b) => b.links?.[link]?.[k]);
      if (removed > 0) next[k] = Math.max(0, (next[k] ?? 0) - removed);
    }
    total = next;
    if (keys) {
      keys = Object.fromEntries(
        Object.entries(keys).map(([id, u]) => {
          if (u.link !== link) return [id, u];
          const removed = pre(cut.at, cut.base, u.refused, (b) => b.refused[id]) - pre(global, globalBase, u.refused, (b) => b.refused[id]);
          const lastRefusedAt = u.lastRefusedAt && u.lastRefusedAt >= cut.at ? u.lastRefusedAt : undefined;
          return [id, { ...u, refused: Math.max(0, u.refused - Math.max(0, removed)), lastRefusedAt }];
        })
      );
    }
  }
  return { ...day, total, ...(keys ? { keys } : {}) };
}

/** Goes back to the clear before the last one. */
export async function undoClearErrors(): Promise<boolean> {
  if (!undoClear) return false;
  errorsClearedAt = undoClear.at;
  errorsBase = undoClear.base;
  undoClear = undefined;
  dirty = true;
  await flush();
  return true;
}

/** Whether the last clear of the errors can still be undone. */
export function canUndoClear(): boolean {
  return Boolean(undoClear);
}

/** Clears the activity log: the log and the timetable start after this moment. The week's totals stay. */
export async function clearActivity(): Promise<void> {
  undoActivity = { at: activityClearedAt };
  activityClearedAt = Date.now();
  dirty = true;
  await flush();
}

/** Goes back to the log as it was before the last clear. */
export async function undoClearActivity(): Promise<boolean> {
  if (!undoActivity) return false;
  activityClearedAt = undoActivity.at;
  undoActivity = undefined;
  dirty = true;
  await flush();
  return true;
}

export function canUndoClearActivity(): boolean {
  return Boolean(undoActivity);
}

/**
 * A day as the dashboard counts it after the errors were cleared: days before the clear count no
 * errors, failures or refusals, and the day of the clear counts only what came after it.
 */
export function afterClear(day: Day, clearedAt: number, base: ClearBase | undefined): Day {
  if (!clearedAt) return day;
  const clearDate = dateOf(clearedAt);
  if (day.date > clearDate) return day;
  const before = day.date < clearDate;
  const total: Record<string, number> = {};
  for (const [k, v] of Object.entries(day.total)) {
    if (!errorish(k)) total[k] = v;
    else if (!before) {
      const left = v - (base?.date === day.date ? (base.counts[k] ?? 0) : 0);
      if (left > 0) total[k] = left;
    }
  }
  const keys = day.keys
    ? Object.fromEntries(
        Object.entries(day.keys).map(([id, u]) => {
          const refused = before ? 0 : Math.max(0, u.refused - (base?.date === day.date ? (base.refused[id] ?? 0) : 0));
          const lastRefusedAt = u.lastRefusedAt && u.lastRefusedAt >= clearedAt ? u.lastRefusedAt : undefined;
          return [id, { ...u, refused, lastRefusedAt }];
        })
      )
    : undefined;
  return { ...day, total, ...(keys ? { keys } : {}) };
}

async function flush(day: Day = today): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    await writeFile(path.join(dir(), `${day.date}.json`), JSON.stringify(day));
    await writeFile(path.join(dir(), "errors.json"), JSON.stringify(errors));
    await writeFile(path.join(dir(), "errors-cleared.json"), JSON.stringify({ at: errorsClearedAt, base: errorsBase, undo: undoClear }));
    await writeFile(path.join(dir(), "activity-cleared.json"), JSON.stringify({ at: activityClearedAt, undo: undoActivity }));
    await writeFile(path.join(dir(), "links-cleared.json"), JSON.stringify({ errors: linkErrors, activity: linkActivity }));
    await writeFile(path.join(dir(), "activity.json"), JSON.stringify(activity));
    await writeFile(path.join(dir(), "keys-recent.json"), JSON.stringify(recentCalls));
    await writeFile(path.join(dir(), "labels.json"), JSON.stringify(labels));
    await writeFile(path.join(dir(), "debug.json"), JSON.stringify({ periods }));
    dirty = false;
  } catch (error) {
    console.error(`stats: not saved: ${error instanceof Error ? error.message : error}`);
  }
}

let lastCpu = process.cpuUsage();

/**
 * What this container uses, from its own counters: the cgroup holds
 * BttrSubs and every ffmpeg it starts, and the network namespace sees only its
 * traffic. Nothing else on the machine is in these numbers. Undefined where
 * they can't be read (outside a container, on another OS).
 */
interface Own {
  at: number;
  cpuUsec?: number;
  memBytes?: number;
  memPeakBytes?: number;
  rx?: number;
  tx?: number;
}

async function readNumber(file: string, key?: string): Promise<number | undefined> {
  try {
    const text = await readFile(file, "utf8");
    const raw = key ? text.match(new RegExp(`^${key}\\s+(\\d+)`, "m"))?.[1] : text.trim();
    const value = Number(raw);
    return raw && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readOwn(): Promise<Own> {
  const own: Own = {
    at: Date.now(),
    cpuUsec: await readNumber("/sys/fs/cgroup/cpu.stat", "usage_usec"),
    memBytes: await readNumber("/sys/fs/cgroup/memory.current"),
    memPeakBytes: await readNumber("/sys/fs/cgroup/memory.peak")
  };
  // Memory in use, as `docker stats` counts it: without the file pages the kernel keeps around after a
  // read and gives back when asked. With them, one read of a large file reads as that much memory used.
  const idle = await readNumber("/sys/fs/cgroup/memory.stat", "inactive_file");
  if (own.memBytes !== undefined && idle !== undefined) own.memBytes = Math.max(0, own.memBytes - idle);
  try {
    for (const name of await readdir("/sys/class/net")) {
      if (name === "lo") continue;
      const rx = await readNumber(`/sys/class/net/${name}/statistics/rx_bytes`);
      const tx = await readNumber(`/sys/class/net/${name}/statistics/tx_bytes`);
      if (rx !== undefined) own.rx = (own.rx ?? 0) + rx;
      if (tx !== undefined) own.tx = (own.tx ?? 0) + tx;
    }
  } catch {}
  return own;
}

let lastOwn: Own | undefined;
/** Share of one core the container used over the last minute, percent. */
let cpuPercent: number | undefined;

/** Growth since the last reading; a counter that went back (the container restarted) counts from zero. */
function grew(now?: number, before?: number): number | undefined {
  if (now === undefined || before === undefined) return undefined;
  return now >= before ? now - before : now;
}

/** Once a minute (and on shutdown): the container's CPU time, data in and out, and memory, then save. */
async function sample(): Promise<void> {
  rollover();
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  count("cpu.ms", Math.round((cpu.user + cpu.system) / 1000));
  today.peak.rssMb = Math.max(today.peak.rssMb ?? 0, Math.round(process.memoryUsage().rss / 1048576));
  const own = await readOwn();
  if (lastOwn) {
    const cpuUsec = grew(own.cpuUsec, lastOwn.cpuUsec);
    if (cpuUsec !== undefined) {
      count("own.cpu.ms", Math.round(cpuUsec / 1000));
      cpuPercent = (cpuUsec / 1000 / Math.max(1, own.at - lastOwn.at)) * 100;
    }
    count("net.rx", grew(own.rx, lastOwn.rx) ?? 0);
    count("net.tx", grew(own.tx, lastOwn.tx) ?? 0);
  }
  lastOwn = own;
  if (own.memBytes !== undefined) today.peak.memMb = Math.max(today.peak.memMb ?? 0, Math.round(own.memBytes / 1048576));
  if (dirty) await flush();
}

/** Loads today's counts and recent errors, starts the minute timer, saves on shutdown, prunes old days. */
export async function startStats(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(await readFile(path.join(dir(), `${today.date}.json`), "utf8")) as Day;
    // Counts made before the file was read are added on top.
    for (const [k, v] of Object.entries(today.total)) saved.total[k] = (saved.total[k] ?? 0) + v;
    today = { ...saved, links: { ...saved.links, ...today.links }, peak: saved.peak ?? {}, keys: { ...(saved.keys ?? {}), ...(today.keys ?? {}) } };
  } catch {}
  try {
    // Refused packs were once noted as errors; they aren't (see noteError), so old notes go.
    errors = (JSON.parse(await readFile(path.join(dir(), "errors.json"), "utf8")) as ErrorNote[]).filter((e) => !/is an archive without S\d+E\d+/.test(e.message));
  } catch {}
  try {
    const saved = JSON.parse(await readFile(path.join(dir(), "errors-cleared.json"), "utf8")) as { at?: number; base?: ClearBase; undo?: { at: number; base?: ClearBase } };
    errorsClearedAt = saved.at ?? 0;
    errorsBase = saved.base;
    undoClear = saved.undo;
  } catch {}
  try {
    const saved = JSON.parse(await readFile(path.join(dir(), "activity-cleared.json"), "utf8")) as { at?: number; undo?: { at: number } };
    activityClearedAt = saved.at ?? 0;
    undoActivity = saved.undo;
  } catch {}
  try {
    const saved = JSON.parse(await readFile(path.join(dir(), "links-cleared.json"), "utf8")) as { errors?: Record<string, LinkClear>; activity?: Record<string, { at: number; undo?: { at: number } }> };
    linkErrors = saved.errors ?? {};
    linkActivity = saved.activity ?? {};
  } catch {}
  try {
    activity = JSON.parse(await readFile(path.join(dir(), "activity.json"), "utf8")) as Activity[];
  } catch {}
  try {
    const saved = JSON.parse(await readFile(path.join(dir(), "keys-recent.json"), "utf8")) as Record<string, number[]>;
    for (const [id, times] of Object.entries(saved)) recentCalls[id] = [...times.filter((t) => Date.now() - t < DAY_MS), ...(recentCalls[id] ?? [])];
  } catch {}
  try {
    labels = { ...(JSON.parse(await readFile(path.join(dir(), "labels.json"), "utf8")) as Record<string, string>), ...labels };
  } catch {}
  try {
    const saved = readDebugFile(JSON.parse(await readFile(path.join(dir(), "debug.json"), "utf8")));
    periods = [...saved.periods, ...periods];
  } catch {}
  lastOwn = await readOwn();
  setInterval(() => void sample(), 60_000).unref();
  setInterval(() => void debugCommandTick().catch(() => {}), 2_000).unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      // The last minute's CPU and data are counted before saving.
      void sample()
        .then(() => flush())
        .finally(() => process.exit(0));
    });
  }
  try {
    const cutoff = dateOf(Date.now() - KEEP_DAYS * 86400_000);
    for (const name of await readdir(dir())) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < cutoff) await rm(path.join(dir(), name));
    }
  } catch {}
}

async function dirSize(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files++;
        bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(root);
  return { bytes, files };
}

export interface StatsView {
  version: string;
  uptimeS: number;
  now: {
    cores: number;
    /** Share of one core over the last minute, percent (BttrSubs and its ffmpeg). */
    cpuPercent?: number;
    /** The container's memory now and its highest since it started, MB. */
    memMb?: number;
    memPeakMb?: number;
    rssMb: number;
    cache: { bytes: number; files: number };
    disk?: { freeBytes: number; totalBytes: number };
  };
  /** Newest first, today included. */
  days: Day[];
  errors: ErrorNote[];
  /** When the recent errors were last cleared; 0 for never. The days are already counted from then. */
  errorsClearedAt: number;
  /** When the activity log was last cleared, and whether that can be undone. */
  activityClearedAt?: number;
  canUndoClearActivity?: boolean;
  /** What the day of the last clear had counted when it was cleared (see afterClear). */
  errorsBase?: ClearBase;
  /** Each link's own clears of its errors and its activity (see afterLinkClears and activityPage). */
  linkErrors?: Record<string, LinkClear>;
  linkActivity?: Record<string, { at: number; undo?: { at: number } }>;
  /** The first page of activity (see activityPage), the number kept, and every link in it. */
  activity: Activity[];
  /** Every request of the last 24 hours (at most RECENT_MAX), newest first, for the timetable. */
  recent?: Activity[];
  activityTotal: number;
  activityLinks: string[];
  /** What this week's subtitles came out as (see syncOutcomes), and whether the last clear can be undone. */
  outcomes: ReturnType<typeof syncOutcomes>;
  canUndoClear: boolean;
  /** The owner's names for links (cache/stats/names.json), by link id or its AIOStreams uuid prefix. */
  names: Record<string, string>;
  /**
   * Each link's configure page and settings, for the links whose requests have been seen. The page is
   * reached through /dashboard/links/configure, by the link's id: its token is never on the dashboard.
   */
  configure: Record<string, string>;
  settings: Record<string, LinkSummary>;
  /** Links paused on the dashboard (id to when), and links deleted there that haven't come back. */
  paused: Record<string, number>;
  deleted: string[];
  /** Calls per key in the last minute, hour and 24 hours. */
  windows: Record<string, KeyWindows>;
  /**
   * The debug periods, each with the requests and errors it covers (of those kept), the last one removed
   * (for Undo), and how many debug requests the week's log holds.
   */
  debug?: { periods: Array<DebugPeriod & { requests: number; errors: number }>; activity: number; pastErrors?: number };
  /** Each configuration's week from the activity log, debug left out (see linkWeek). */
  linkWeek?: Record<string, { lists: number; served: number; lastSeen: number }>;
  /** Each source's week from the activity log (sourceWeek). */
  sourceWeek?: Record<string, { picked: number; served: number; synced: number }>;
}

/** The owner's names for links: { "1a2b3c4d": "Sara" }. Missing or broken means none. */
async function readNames(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir(), "names.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => typeof v === "string" && v.length <= 40 && k.length <= 40)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Everything the stats page shows: the last `days` days and the machine right now. */
export async function statsView(version: string, days = 14): Promise<StatsView> {
  rollover();
  // The requests still in the activity log: an error noted during one of them can link to its row.
  const inLog = new Set(logged(Date.now() - ACTIVITY_DAYS * 86_400_000).flatMap((a) => (a.req ? [a.req] : [])));
  // Live numbers: what the container used since the last minute's sample is added to today's
  // view (not saved), and CPU is measured over that same stretch, so nothing waits for a sample.
  const own = await readOwn();
  const live: Day = { ...today, total: { ...today.total } };
  // The container's own use since the last sample goes where it's counted: debug while a period for every configuration is open.
  const liveDebug = isDebug(undefined);
  if (liveDebug) live.debug = { links: {}, ...today.debug, total: { ...today.debug?.total } };
  const liveInto = liveDebug && live.debug ? live.debug.total : live.total;
  let cpuNow = cpuPercent;
  if (lastOwn) {
    const cpuUsec = grew(own.cpuUsec, lastOwn.cpuUsec);
    if (cpuUsec !== undefined) {
      liveInto["own.cpu.ms"] = (liveInto["own.cpu.ms"] ?? 0) + Math.round(cpuUsec / 1000);
      if (own.at - lastOwn.at >= 2000) cpuNow = (cpuUsec / 1000 / (own.at - lastOwn.at)) * 100;
    }
    liveInto["net.rx"] = (liveInto["net.rx"] ?? 0) + (grew(own.rx, lastOwn.rx) ?? 0);
    liveInto["net.tx"] = (liveInto["net.tx"] ?? 0) + (grew(own.tx, lastOwn.tx) ?? 0);
  }
  const list: Day[] = [live];
  for (let i = 1; i < days; i++) {
    const date = dateOf(Date.now() - i * 86400_000);
    try {
      list.push(JSON.parse(await readFile(path.join(dir(), `${date}.json`), "utf8")) as Day);
    } catch {
      list.push(emptyDay(date));
    }
  }
  let disk: StatsView["now"]["disk"];
  try {
    const fs = await statfs(cachePath());
    disk = { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
  } catch {}
  return {
    version,
    uptimeS: Math.round((Date.now() - started) / 1000),
    now: {
      cores: os.availableParallelism(),
      cpuPercent: cpuNow,
      memMb: own.memBytes !== undefined ? Math.round(own.memBytes / 1048576) : undefined,
      memPeakMb: own.memPeakBytes !== undefined ? Math.round(own.memPeakBytes / 1048576) : undefined,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      cache: await dirSize(cachePath()),
      disk
    },
    days: list.map((day) => (day.keys && Object.values(day.keys).some((u) => u.lastRefusedAt && periodAt(u.lastRefusedAt, u.link)) ? { ...day, keys: Object.fromEntries(Object.entries(day.keys).map(([id, u]) => [id, u.lastRefusedAt && periodAt(u.lastRefusedAt, u.link) ? { ...u, lastRefusedAt: undefined } : u])) } : day)),
    activity: activityPage().rows,
    recent: logged(Date.now() - 86_400_000).filter((a) => !isDebugEntry(a)).slice(0, RECENT_MAX).map(marked),
    debug: {
      periods: periods.map((p) => {
        const covers = (e: { at: number; link?: string }) => Boolean(periodAt(e.at, e.link, [p]));
        return { ...p, requests: activity.filter(covers).length, errors: errors.filter(covers).length };
      }),
      activity: logged(Date.now() - ACTIVITY_DAYS * 86_400_000).filter((a) => isDebugEntry(a)).length,
      // Errors a period covers that were counted as real when they happened: the week's error count takes them off.
      pastErrors: errors.filter((e) => !e.debug && e.at >= Date.now() - ACTIVITY_DAYS * 86_400_000 && e.at >= errorCutoff(e.link) && periodAt(e.at, e.link)).length
    },
    linkWeek: linkWeek(),
    sourceWeek: sourceWeek(),
    activityTotal: activityPage().total,
    activityLinks: activityLinks(),
    outcomes: syncOutcomes(),
    canUndoClear: canUndoClear(),
    canUndoClearActivity: canUndoClearActivity(),
    activityClearedAt,
    errorsBase,
    linkErrors,
    linkActivity,
    windows: keyWindows(),
    // Hand-written names first; a name given on the configure page wins for its link.
    names: { ...(await readNames()), ...labels },
    configure: Object.fromEntries(Object.keys(knownLinks()).map((link) => [link, `/dashboard/links/configure?${new URLSearchParams({ link })}`])),
    settings: Object.fromEntries(Object.entries(knownLinks()).flatMap(([link, token]) => {
      const summary = linkSummary(token);
      return summary ? [[link, summary]] : [];
    })),
    paused: pausedLinks(),
    deleted: deletedLinks(),
    // The notes from before a clear stay stored (Undo brings them back), but aren't shown.
    errors: errors.filter((e) => e.at >= errorCutoff(e.link)).map(marked).map((e) => (e.req && inLog.has(e.req) ? { ...e, inLog: true } : e)),
    errorsClearedAt
  };
}
