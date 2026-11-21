/**
 * Log files: every console line also goes to CACHE_DIR/logs, one file per UTC day, so the log outlives the
 * container (an update replaces it, and Docker's own log goes with it) the way the cache volume does. In a
 * file an address keeps only its host, since paths carry install tokens and keys, and long tokens are cut, so
 * a file can go into a bug report. A line written during a request, or during work it started, carries the
 * request's id (req=…), as its activity row and errors do. The newest LOG_DAYS days are kept, at most
 * LOG_MAX_MB in all, the oldest file going first; LOG_DAYS=0 writes none. The console itself is unchanged.
 */
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { config } from "./config.js";
import { requestContext } from "./stats.js";

const NAME = /^bttrsubs-(\d{4}-\d{2}-\d{2})\.log$/;
const fileName = (day: string) => `bttrsubs-${day}.log`;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const LEVELS = ["log", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];
const TAG: Record<Level, string> = { log: "info", info: "info", warn: "warn", error: "error" };

/** A line as a file keeps it: each address cut to its host, and runs of 32+ token characters cut. */
export function scrubLine(line: string): string {
  return line
    .replace(/(https?:\/\/[^\s/?#,;)"'\]<>]+)([/?#][^\s,;)"'\]<>]*)/g, (_, host: string, rest: string) => `${host}/…${rest.match(/[:.]+$/)?.[0] ?? ""}`)
    .replace(/[A-Za-z0-9_-]{32,}/g, "<token>");
}

export interface LogOptions {
  dir: string;
  /** Days kept, today included; 0 writes none. */
  days: number;
  /** Most bytes all the files take together. */
  maxBytes: number;
  now?: () => number;
}

interface Writer {
  opts: Required<LogOptions>;
  day: string;
  stream?: WriteStream;
  /** Bytes in the earlier days' files, and in today's. */
  earlier: number;
  today: number;
  /** Bytes this process wrote to each day's file: a file's size on disk lags its stream. */
  written: Map<string, number>;
  /** Today's file reached the cap: the rest of the day goes to the console only. */
  full: boolean;
  stopped: boolean;
  /** Earlier days' files still taking their last lines. */
  ending: Set<Promise<void>>;
}

let writer: Writer | undefined;
/** What startLogFiles was given, kept for a start after the files were turned off and on again. */
let given: Partial<LogOptions> | undefined;
const original = Object.fromEntries(LEVELS.map((l) => [l, console[l]])) as Record<Level, (...args: unknown[]) => void>;

/** The kept files, oldest first. */
export function logFiles(dir = writer?.opts.dir ?? path.join(config.cacheDir, "logs")): Array<{ day: string; file: string; bytes: number }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const day = name.match(NAME)?.[1];
      if (!day) return [];
      try {
        return [{ day, file: path.join(dir, name), bytes: statSync(path.join(dir, name)).size }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Drops the days past the window, then the oldest earlier days while the files would pass the cap with `adding` more today. */
function prune(w: Writer, adding = 0): void {
  const oldest = dayOf(Date.parse(`${w.day}T00:00:00Z`) - (w.opts.days - 1) * 86_400_000);
  const files = logFiles(w.opts.dir);
  let earlier = 0;
  const size = (f: { day: string; bytes: number }) => Math.max(f.bytes, w.written.get(f.day) ?? 0);
  for (const f of files) {
    if (f.day === w.day) continue;
    if (f.day < oldest) remove(f.file);
    else earlier += size(f);
  }
  for (const f of files) {
    if (f.day === w.day || f.day < oldest || earlier + w.today + adding <= w.opts.maxBytes) continue;
    remove(f.file);
    earlier -= size(f);
  }
  w.earlier = earlier;
}

function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch {}
}

function open(w: Writer, day: string): void {
  const before = w.stream;
  if (before) {
    const done: Promise<void> = finished(before)
      .catch(() => undefined)
      .then(() => void w.ending.delete(done));
    w.ending.add(done);
    before.end();
  }
  if (w.day) w.written.set(w.day, w.today);
  w.day = day;
  w.full = false;
  const file = path.join(w.opts.dir, fileName(day));
  try {
    w.today = statSync(file).size;
  } catch {
    w.today = 0;
  }
  prune(w);
  w.stream = createWriteStream(file, { flags: "a" });
  w.stream.on("error", (error) => {
    w.stopped = true;
    original.error(`logs: writing to ${w.opts.dir} stopped: ${error.message}`);
  });
}

function write(level: Level, args: unknown[]): void {
  const w = writer;
  if (!w || w.stopped) return;
  const t = w.opts.now();
  if (dayOf(t) !== w.day) open(w, dayOf(t));
  if (w.full || !w.stream) return;
  // A line written while a request (or work it started) runs carries its id, as its activity row and errors do.
  const req = requestContext.getStore()?.req;
  const line = `${new Date(t).toISOString()} ${TAG[level]} ${req ? `req=${req} ` : ""}${scrubLine(format(...args))}\n`;
  const size = Buffer.byteLength(line);
  if (w.earlier + w.today + size > w.opts.maxBytes) prune(w, size);
  if (w.earlier + w.today + size > w.opts.maxBytes) {
    w.full = true;
    w.stream.write(`${new Date(t).toISOString()} warn logs: today's file reached the LOG_MAX_MB cap; the rest of the day is on the console only\n`);
    return;
  }
  w.stream.write(line);
  w.today += size;
}

/** Starts writing log files; once only. */
export function startLogFiles(options: Partial<LogOptions> = {}): void {
  const opts: Required<LogOptions> = { dir: path.join(config.cacheDir, "logs"), days: config.logDays, maxBytes: config.logMaxMb * 1e6, now: Date.now, ...options };
  given = options;
  if (writer || opts.days <= 0) return;
  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch (error) {
    original.error(`logs: no log files: ${error instanceof Error ? error.message : error}`);
    return;
  }
  writer = { opts, day: "", earlier: 0, today: 0, written: new Map(), full: false, stopped: false, ending: new Set() };
  for (const level of LEVELS) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      write(level, args);
    };
  }
}

/**
 * The days kept and the most bytes, changed while running (the dashboard's settings). Fewer days or
 * bytes drop the oldest files now; 0 days stops writing and leaves the files there; days again starts
 * it. Nothing happens before startLogFiles was first called.
 */
export function setLogLimits(days: number, maxBytes: number): void {
  if (!given) return;
  const w = writer;
  if (!w) {
    if (days > 0) startLogFiles({ ...given, days, maxBytes });
    return;
  }
  if (days <= 0) {
    void close();
    return;
  }
  w.opts.days = days;
  w.opts.maxBytes = maxBytes;
  w.full = false;
  if (w.day) prune(w);
}

/** Resolves once every line written so far is on disk, earlier days' files included. */
export async function logFilesWritten(): Promise<void> {
  const w = writer;
  if (!w) return;
  await Promise.all([...w.ending]);
  // Lines still buffered are on disk once an empty write after them is.
  const stream = w.stream;
  if (stream && !w.stopped) await new Promise<void>((resolve) => stream.write("", () => resolve()));
}

/** Stops writing and gives the console back (for tests): a change of limits no longer starts it again. */
export async function stopLogFiles(): Promise<void> {
  given = undefined;
  await close();
}

/** Stops writing and gives the console back; the files stay. */
async function close(): Promise<void> {
  const w = writer;
  writer = undefined;
  for (const level of LEVELS) console[level] = original[level];
  if (!w) return;
  await Promise.all([...w.ending]);
  const stream = w.stream;
  if (stream) await finished(stream.end()).catch(() => undefined);
}

/** What the files hold, for the dashboard: null when they're off. */
export function logSummary(): { days: number; bytes: number; keepDays: number } | null {
  if (!writer) return null;
  const files = logFiles();
  return { days: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0), keepDays: writer.opts.days };
}

/** Every kept file, oldest first, one after another into `out`, which is then ended. */
export async function sendLogs(out: Writable): Promise<void> {
  await logFilesWritten();
  for (const f of logFiles()) {
    await new Promise<void>((resolve, reject) => {
      const read = createReadStream(f.file);
      read.on("end", () => resolve());
      read.on("error", reject);
      read.pipe(out, { end: false });
    });
  }
  out.end();
}
