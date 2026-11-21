/**
 * AniDB's HTTP API, for an anime's own titles and its number of episodes: an option, off unless
 * ANIDB_CLIENT and ANIDB_CLIENT_VER name a client registered there (anidb.net, Add Project, an HTTP
 * client). Used for a show's season map when the Anime Kitsu addon gives none (ids.ts).
 *
 * AniDB bans an address that asks too much, for about a day, and longer when it keeps asking while
 * banned. Its rules: no more than one request every two seconds, never the same anime twice in a
 * day, and everything kept locally. So every request here goes through one line (anidbPace):
 * - one at a time, `everyMs` apart at least, counted from the start of this process too;
 * - `dailyMax` a UTC day at most, counted on disk, so a restart doesn't start the count again;
 * - an anime's answer is kept `keptDays` and never asked for again before that; an anime AniDB
 *   doesn't have, or an answer that couldn't be read, `failedDays`;
 * - a ban, or a client AniDB doesn't accept, stops every request for `stoppedMs`, kept on disk;
 * - nothing waits on it: a list is never held for AniDB, and a show whose entries aren't all kept
 *   yet gets them over the next requests, or days.
 * Every request is logged with its count for the day. What is kept is never pruned with the caches
 * that rebuild themselves: asking again is the one thing to avoid.
 */
import { mkdir, readFile } from "node:fs/promises";
import { cachePath, writeFileAtomic } from "./cache.js";
import { config } from "./config.js";
import { count } from "./stats.js";

const ANIDB_API = "http://api.anidb.net:9001/httpapi";
const DAY_MS = 24 * 60 * 60 * 1000;

/** How AniDB is asked (see above). Tests shorten the gap. */
export const anidbPace = { everyMs: 4000, dailyMax: 100, keptDays: 90, failedDays: 7, stoppedMs: 36 * 60 * 60 * 1000, timeoutMs: 20_000 };

export interface AnidbAnime {
  /** Its main title, its official ones and its synonyms, in romaji, English and Japanese. */
  titles: string[];
  /** How many regular episodes it has, as AniDB counts them. */
  episodes: number;
}

/** What is kept of one anime: its answer, or that it had none. */
interface Kept {
  at: number;
  anime?: AnidbAnime;
}

/** What is kept of the line itself: the day's count, and until when nothing is asked. */
interface State {
  day: string;
  asked: number;
  stoppedUntil: number;
  why?: string;
}

/** Whether a client is set: both its name and its version. */
export function anidbConfigured(): boolean {
  return Boolean(config.anidbClient && config.anidbClientVer);
}

const keptFile = (aid: number) => cachePath("anidb", `${aid}.json`);
const stateFile = () => cachePath("anidb", "state.json");
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

let state: State | undefined;
async function lineState(now = Date.now()): Promise<State> {
  if (!state) {
    try {
      const read = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<State>;
      state = { day: String(read.day ?? ""), asked: Number(read.asked) || 0, stoppedUntil: Number(read.stoppedUntil) || 0, ...(read.why ? { why: String(read.why) } : {}) };
    } catch {
      state = { day: today(now), asked: 0, stoppedUntil: 0 };
    }
  }
  if (state.day !== today(now)) state = { ...state, day: today(now), asked: 0 };
  return state;
}

async function saveState(): Promise<void> {
  await mkdir(cachePath("anidb"), { recursive: true });
  if (state) writeFileAtomic(stateFile(), JSON.stringify(state));
}

/** For diagnostics and tests: the day's count, the most a day allows, and how long requests are stopped for. */
export async function anidbNow(now = Date.now()): Promise<{ configured: boolean; askedToday: number; dailyMax: number; stoppedForMs: number; why?: string }> {
  const s = await lineState(now);
  return { configured: anidbConfigured(), askedToday: s.asked, dailyMax: anidbPace.dailyMax, stoppedForMs: Math.max(0, s.stoppedUntil - now), ...(s.why && s.stoppedUntil > now ? { why: s.why } : {}) };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
    name[0] === "#" ? String.fromCodePoint(name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? whole)
  );

/** AniDB's own word for why it refused, when the answer is an error ("banned", "client version missing or invalid"). */
export function anidbError(xml: string): string | undefined {
  return /<error\b[^>]*>([^<]*)<\/error>/i.exec(xml)?.[1]?.trim().toLowerCase();
}

/**
 * An anime's titles and episode count from its answer: the main title, the official ones and the
 * synonyms, in romaji, English and Japanese. Short titles are left out (an abbreviation is found in
 * other shows' names), and so are the episodes' own titles.
 */
export function readAnime(xml: string): AnidbAnime | undefined {
  const block = /<titles>([\s\S]*?)<\/titles>/i.exec(xml)?.[1];
  if (block === undefined) return undefined;
  const titles: string[] = [];
  for (const [, attributes, text] of block.matchAll(/<title\b([^>]*)>([^<]*)<\/title>/gi)) {
    const type = /\btype="([^"]*)"/i.exec(attributes)?.[1]?.toLowerCase();
    const lang = /\bxml:lang="([^"]*)"/i.exec(attributes)?.[1]?.toLowerCase();
    const wanted = type === "main" || ((type === "official" || type === "synonym") && (lang === "x-jat" || lang === "en" || lang === "ja"));
    const title = unescape(text).trim();
    if (wanted && title && !titles.includes(title)) titles.push(title);
  }
  const episodes = Number(/<episodecount>(\d+)<\/episodecount>/i.exec(xml)?.[1] ?? 0);
  return titles.length ? { titles, episodes } : undefined;
}

/** One request at a time, in order. */
let line: Promise<unknown> = Promise.resolve();
/** When the last request went out; this process's start counts as one, so a restart never asks at once. */
let lastAt = Date.now();
const asking = new Map<number, Promise<AnidbAnime | undefined>>();

async function kept(aid: number, now = Date.now()): Promise<Kept | undefined> {
  try {
    const read = JSON.parse(await readFile(keptFile(aid), "utf8")) as Kept;
    const days = read.anime ? anidbPace.keptDays : anidbPace.failedDays;
    return typeof read.at === "number" && now - read.at < days * DAY_MS ? read : undefined;
  } catch {
    return undefined;
  }
}

/** What is kept of an anime, without asking: undefined when nothing is, or when it had no answer. */
export async function keptAnime(aid: number): Promise<AnidbAnime | undefined> {
  return (await kept(aid))?.anime;
}

/**
 * An anime by its AniDB id: what is kept of it, else asked for in its turn (see anidbPace). Undefined
 * when no client is set, AniDB doesn't have it, requests are stopped, or the day's count is spent:
 * never an error, and never asked for twice while one request for it is under way.
 */
export function anidbAnime(aid: number): Promise<AnidbAnime | undefined> {
  if (!anidbConfigured() || !Number.isInteger(aid) || aid <= 0) return Promise.resolve(undefined);
  const running = asking.get(aid);
  if (running) return running;
  const job = (async () => {
    const had = await kept(aid);
    if (had) return had.anime;
    const turn = line.then(() => ask(aid));
    line = turn.catch(() => undefined);
    return turn;
  })()
    .catch((error) => {
      console.error(`anidb: anime ${aid}: ${error instanceof Error ? error.message : error}`);
      return undefined;
    })
    .finally(() => asking.delete(aid));
  asking.set(aid, job);
  return job;
}

async function ask(aid: number): Promise<AnidbAnime | undefined> {
  // Kept meanwhile by a request ahead in the line.
  const had = await kept(aid);
  if (had) return had.anime;
  const s = await lineState();
  if (s.stoppedUntil > Date.now()) return undefined;
  if (s.asked >= anidbPace.dailyMax) {
    console.log(`anidb: anime ${aid} not asked for: ${s.asked} asked today, the most a day (${anidbPace.dailyMax})`);
    count("api.anidb.heldBack");
    return undefined;
  }
  const wait = lastAt + anidbPace.everyMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastAt = Date.now();
  s.asked++;
  await saveState();
  count("api.anidb");
  const query = new URLSearchParams({ request: "anime", client: String(config.anidbClient), clientver: String(config.anidbClientVer), protover: "1", aid: String(aid) });
  let xml: string;
  try {
    const response = await fetch(`${ANIDB_API}?${query}`, { headers: { "user-agent": "BttrSubs" }, signal: AbortSignal.timeout(anidbPace.timeoutMs) });
    xml = await response.text();
    if (!response.ok && !anidbError(xml)) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // Not kept: AniDB wasn't reached, which says nothing about the anime. The request still counts.
    console.error(`anidb: anime ${aid} asked (${s.asked} today): no answer (${error instanceof Error ? error.message : error})`);
    count("api.anidb.fail");
    return undefined;
  }
  const refused = anidbError(xml);
  // A ban, or a client it doesn't accept: every further request would make it worse.
  if (refused && /banned|client|version|protover/.test(refused)) {
    s.stoppedUntil = Date.now() + anidbPace.stoppedMs;
    s.why = refused;
    await saveState();
    count("api.anidb.stopped");
    console.error(`anidb: anime ${aid} asked (${s.asked} today): refused ("${refused}"); nothing more is asked for ${Math.round(anidbPace.stoppedMs / 3_600_000)} h`);
    return undefined;
  }
  const anime = refused ? undefined : readAnime(xml);
  await mkdir(cachePath("anidb"), { recursive: true });
  writeFileAtomic(keptFile(aid), JSON.stringify({ at: Date.now(), ...(anime ? { anime } : {}) } satisfies Kept));
  console.log(`anidb: anime ${aid} asked (${s.asked} today of ${anidbPace.dailyMax} at most): ${anime ? `${anime.titles.length} titles, ${anime.episodes} episodes` : refused ? `"${refused}"` : "an answer with no titles"}; kept ${anime ? anidbPace.keptDays : anidbPace.failedDays} days`);
  return anime;
}

/**
 * The client or its version was changed: a stop that came from AniDB refusing the client ends, since
 * the one it refused is gone, and the next request tries the new one. A ban stays: it is on the
 * address, whatever the client, and asking again would lengthen it.
 */
export async function anidbClientChanged(): Promise<void> {
  const s = await lineState();
  if (s.stoppedUntil <= Date.now() || !s.why || /banned/.test(s.why)) return;
  console.log(`anidb: the client was changed; the stop after "${s.why}" is lifted`);
  s.stoppedUntil = 0;
  delete s.why;
  await saveState();
}

/** For tests: forget the line's state in memory (what is on disk stays). */
export function resetAnidb(): void {
  state = undefined;
  line = Promise.resolve();
  lastAt = 0;
  asking.clear();
}
