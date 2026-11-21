/**
 * Limits on reading the playing file from wherever it is hosted (a debrid service, a usenet proxy).
 * The reads use the viewer's own account there, so the addon holds back in two cases:
 *
 * - The host refuses. HTTP 429 (too many requests) pauses reads from that host at once, and so
 *   does a refused connection (TCP, before any HTTP), the way a host turns one address away: only
 *   on a public host, since a refused connection on the Docker network means a container is down.
 *   HTTP 403 pauses them only after REFUSALS_BEFORE_PAUSE in a row, since one 403 is usually a
 *   link that expired, not an account being limited. A pause lasts PAUSE_MS, doubling each time
 *   the host refuses again straight after one, up to MAX_PAUSE_MS. A read that works clears it.
 *   The host is the one that serves the bytes (a debrid service's download server, reached by
 *   redirect), so one server turning reads away leaves the service's other servers read as usual.
 * - The day's limit is spent (DAILY_READ_GB, counted over everyone, UTC days as the dashboard's).
 *
 * While paused, nothing new is read: subtitles are listed unsynced and syncing picks up afterwards.
 *
 * Where a file may be read from is limited too (checkReadable): its address comes from a stream list,
 * which an addon someone added to their AIOStreams can fill with anything, so an address on this
 * server's own networks is never read.
 */
import { config } from "./config.js";
import { leadsPublic, publicHttpsUrl } from "./net.js";
import { count, countedToday } from "./stats.js";

/** Reading the file is paused (see above). Not a failure to list on the dashboard each time. */
export class ReadsPaused extends Error {
  override name = "ReadsPaused";
}

const REFUSALS_BEFORE_PAUSE = 3;
const PAUSE_MS = 5 * 60 * 1000;
const MAX_PAUSE_MS = 60 * 60 * 1000;

interface HostState {
  /** 403s in a row with no read working in between. */
  refusals: number;
  /** Pauses in a row with no read working in between. */
  pauses: number;
  pausedUntil: number;
  status?: Refusal;
}

/** How a host refused: an HTTP status, or "connection" for a refused connection. */
export type Refusal = 403 | 429 | "connection";

const hosts = new Map<string, HostState>();

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The refusal (403, 429 or a refused connection) an error from ffmpeg, ffprobe or a range read reports, if it is one. */
export function refusalStatus(message: string): Refusal | undefined {
  const m = /(?:Server returned|HTTP error|HTTP)\s+(403|429)\b/.exec(message);
  if (m) return Number(m[1]) as 403 | 429;
  return /\bConnection refused\b|\bECONNREFUSED\b/.test(message) ? "connection" : undefined;
}

/** Whether a fetch() error is a refused connection (its cause, as Node reports it). */
export function connectionRefused(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === "ECONNREFUSED") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The file's address leads to this server's own networks (checkReadable). Not a failure of the host's. */
export class PrivateHost extends Error {
  override name = "PrivateHost";
}

const originOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Throws PrivateHost unless the playing file's address may be read: http or https, on the public
 * internet (by its name and by every address the name leads to), on this server's own AIOStreams
 * (OWN_AIOSTREAMS, or where it is reached, AIOSTREAMS_BASE), or on a host PRIVATE_STREAM_HOSTS names.
 * A stream list is whatever the addons in someone's AIOStreams answer, so without this a listed
 * address could point reads at this machine, its Docker network or the LAN.
 */
export async function checkReadable(url: string): Promise<void> {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    throw new PrivateHost("the file's address isn't a URL; not read");
  }
  if (at.protocol !== "http:" && at.protocol !== "https:") throw new PrivateHost(`the file's address is ${at.protocol.replace(":", "")}, not http or https; not read`);
  if (at.origin === originOf(config.ownAiostreams) || at.origin === originOf(config.aiostreamsBase)) return;
  // A host named with its port is that port alone, the scheme's own one included (a URL leaves that one out).
  const allowed = config.privateStreamHosts;
  const withPort = `${at.hostname}:${at.port || (at.protocol === "https:" ? 443 : 80)}`.toLowerCase();
  if (allowed.includes(at.hostname.toLowerCase()) || allowed.includes(withPort)) return;
  if (await leadsPublic(at.hostname)) return;
  count("sync.privateHost");
  throw new PrivateHost(`the file's address (${at.host}) leads to a private network or nowhere; not read (PRIVATE_STREAM_HOSTS can allow a host)`);
}

/** Redirects followed from one read of the file, each checked like the first address. */
const MAX_READ_REDIRECTS = 5;

/**
 * fetch() of the playing file. Every address asked, the redirects a host answers with included, must
 * be one that may be read (checkReadable). A refused connection is noted against the URL's host
 * (noteRefusal) and the error passed on as it came. With `redirect: "manual"` the caller follows the
 * redirects itself, one fetchFile a hop.
 */
export async function fetchFile(url: string, init: RequestInit): Promise<Response> {
  let at = url;
  for (let hop = 0; ; hop++) {
    await checkReadable(at);
    let response: Response;
    try {
      response = await fetch(at, { ...init, redirect: "manual" });
    } catch (error) {
      if (connectionRefused(error)) noteRefusal(at, "connection");
      throw error;
    }
    const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (init.redirect === "manual" || !next) return response;
    await response.body?.cancel();
    if (hop >= MAX_READ_REDIRECTS) throw new Error("the file's host redirects too many times");
    at = new URL(next, at).toString();
  }
}

function refusedWhy(status: Refusal | undefined): string {
  return status === "connection" ? "refused the connection" : `refused reads (HTTP ${status})`;
}

/** Bytes read from playing files today, by the day's limit. */
const READ_COUNTER = "sync.readBytes";

/** Throws ReadsPaused when nothing more may be read today, or (given the file's URL) from its host for now. */
export function checkReads(url?: string, now = Date.now()): void {
  const limit = config.dailyReadBytes;
  if (limit > 0 && countedToday(READ_COUNTER) >= limit) throw new ReadsPaused(`the day's read limit (${config.dailyReadGb} GB) is spent; syncing new files resumes tomorrow (UTC)`);
  if (url) checkHost(url, now);
}

/** Throws ReadsPaused while reads from this URL's host are paused; the day's limit isn't checked. */
export function checkHost(url: string, now = Date.now()): void {
  const host = hostOf(url);
  const state = host ? hosts.get(host) : undefined;
  if (state && state.pausedUntil > now) {
    throw new ReadsPaused(`the file's host ${refusedWhy(state.status)}; paused for another ${Math.ceil((state.pausedUntil - now) / 60000)} min`);
  }
}

/**
 * Whether a read nobody waits for (the English audio heard in the background for dub captions, see
 * sync.ts) of about `bytes` still fits in today's limit with BACKGROUND_SHARE of it at most: the rest
 * is kept for syncs a viewer is waiting on. Always true when there is no limit.
 */
export function backgroundReadFits(bytes: number): boolean {
  const limit = config.dailyReadBytes;
  return limit <= 0 || countedToday(READ_COUNTER) + bytes <= limit * BACKGROUND_SHARE;
}

const BACKGROUND_SHARE = 0.8;

/** Bytes read from a playing file (measured, or estimated for ffmpeg's windows). */
export function noteRead(bytes: number): void {
  count(READ_COUNTER, Math.round(bytes));
}

/** A read from this URL's host worked: it isn't refusing. */
export function noteReadOk(url: string): void {
  const host = hostOf(url);
  if (host) hosts.delete(host);
}

/** The host refused a read. Returns how long reads from it are now paused for, in ms (0: not paused). */
export function noteRefusal(url: string, status: Refusal, now = Date.now()): number {
  const host = hostOf(url);
  if (!host) return 0;
  if (status === "connection" && !publicHttpsUrl(url)) return 0;
  const state = hosts.get(host) ?? { refusals: 0, pauses: 0, pausedUntil: 0 };
  hosts.set(host, state);
  state.status = status;
  state.refusals++;
  count("sync.refused");
  if (status === 403 && state.refusals < REFUSALS_BEFORE_PAUSE) return 0;
  const pause = Math.min(PAUSE_MS * 2 ** state.pauses, MAX_PAUSE_MS);
  state.pauses++;
  state.refusals = 0;
  state.pausedUntil = now + pause;
  count("sync.paused");
  console.error(`sync: the file's host ${host} ${refusedWhy(status)}; no reads from it for ${Math.round(pause / 60000)} min`);
  return pause;
}

/** For diagnostics: what was read today against the day's limit, and each host that refused, paused or not. */
export function readsNow(now = Date.now()): { todayBytes: number; limitBytes: number; hosts: Array<{ host: string; status?: Refusal; refusals: number; pausedForMs: number }> } {
  return {
    todayBytes: countedToday(READ_COUNTER),
    limitBytes: config.dailyReadBytes,
    hosts: [...hosts].map(([host, s]) => ({ host, ...(s.status ? { status: s.status } : {}), refusals: s.refusals, pausedForMs: Math.max(0, s.pausedUntil - now) }))
  };
}

/** For tests: forget every host. */
export function resetReads(): void {
  hosts.clear();
}
