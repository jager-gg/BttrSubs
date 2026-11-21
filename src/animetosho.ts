/**
 * Anime Tosho (animetosho.net): a free mirror of anime releases that extracts every subtitle track of
 * every file it mirrors, with an open JSON API and no key. A dub's own release (an English dub's web
 * release, a dual-audio one) carries the streaming service's English captions of the dub as a track,
 * often the only place they exist: those tracks are this source's subtitles, as dub captions.
 *
 * Releases are found two ways at once: the episode by its ids (its Kitsu entry and that entry's
 * episode, else IMDb's season and episode), one request to its Torznab search; and the show's name or
 * its season's own title with a dub mark, a few pages of its JSON search. The ids go through its own
 * mapping, which files some later seasons' releases under the first season, so every release's name
 * is still checked. Then their files: the episode's file by its name (the same matching as every
 * subtitle name), and in it the English track named as captions ("English [CC]", "SDH", "Dub"), or
 * the one English track of a file whose every voice is English (from the file's mediainfo). Searches
 * are kept 12 hours, releases 30 days; a release still being mirrored, or mirrored without subtitle
 * tracks, only an hour (its tracks may come yet).
 */
import xz from "xz-decompress";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { parseKitsuId } from "./ids.js";
import { extractEpisodeMarkers, extractSeasonMarkers, filterAndRankDubtitles, namesOnlyAnotherSeason } from "./matching.js";
import { count, noteError } from "./stats.js";
import type { SeasonMap, StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

const { XzReadableStream } = xz;

export const ANIMETOSHO_FEED = "https://feed.animetosho.net/json";
/** Its Torznab search: the one that finds an episode by the show's ids. */
export const ANIMETOSHO_API = "https://feed.animetosho.net/api";
export const ANIMETOSHO_STORAGE = "https://storage.animetosho.net/attachments";
const HEADERS = { accept: "application/json", "user-agent": "BttrSubs" };
const SEARCH_TTL_S = 12 * 60 * 60;
/** A show-wide search kept this long: a show's release list only grows, and its newest page is asked again after SEARCH_TTL_S. */
const SHOW_KEPT_S = 30 * 24 * 60 * 60;
const RELEASE_TTL_S = 30 * 24 * 60 * 60;
/** A release not yet mirrored whole, and a search listing one: asked again within the hour, once its tracks are there. */
const UNSETTLED_TTL_S = 60 * 60;
/**
 * How requests to its feed are paced. It blocks an address for about 11 s (HTTP 429) that keeps up
 * more than about one request every 2.5 s, so up to `burst` go out in a row, then one every
 * `everyMs`; after a 429, none for `blockedMs`. It answers an address one request at a time (three
 * sent at once end about 2 s apart), so `inFlight` is 1: more would only queue there, out of order.
 * An episode's own look-up goes first and always has `keptForFirst` of the burst.
 *
 * A look-up often asks one request after another, each once the one before is read (a release, then
 * the next). Between two of them the line holds only the requests behind it, so for `followUpMs`
 * after a request ends, the tiers behind its own hold back: the look-up has that long to ask its
 * next and isn't made to take turns with them. The feed answers about 2 s after its last answer
 * anyway, so the hold costs the others nothing.
 */
export const feedPace = { burst: 8, everyMs: 2500, blockedMs: 15_000, inFlight: 1, keptForFirst: 3, followUpMs: 300 };
/** Releases opened per episode at most (each a request for its files), best first. */
const MAX_RELEASES = 6;
/** Of those, opened as soon as the episode's own search answers: its likeliest. */
const FIRST_RELEASES = 3;
/** Opened as soon as each of the episode's own name searches answers (and from each show search kept): its likeliest not yet open. */
const PER_SEARCH = 2;
/** Releases an episode's own search lists at most: an episode has a few dozen at the very most. */
const EPISODE_LIMIT = 100;
/**
 * A subtitle track runs to a few hundred KB unpacked; anything far bigger isn't one. Calibration (a fan
 * release's full subtitles, its signs motion-tracked frame by frame): 17.0 MB unpacked, 9,143 events.
 */
const MAX_TRACK_BYTES = 32_000_000;

/** One release in a search's answer. */
export interface Listed {
  id: number;
  title: string;
  num_files?: number;
  status?: string;
  timestamp?: number;
}

/** A release's files, with their subtitle tracks, as kept. */
interface Release {
  id: number;
  title: string;
  timestamp?: number;
  /** `name` is the file's own name; `folder` the folders it is in within the release ("Season 2"), when any. */
  files: Array<{ name: string; folder?: string; englishVoicesOnly: boolean; tracks: Track[] }>;
}

/**
 * A release whose tracks are all there: "complete", or "unknown" on older rows (mirrored before the
 * feed kept a status). One still "processing" has no tracks yet, and a failed one never will.
 */
const settled = (status: string | undefined) => status === undefined || /^(?:complete|unknown)$/i.test(status);
/** Not settled yet, but may be soon: neither failed nor skipped. */
const coming = (status: string | undefined) => !settled(status) && !/fail|skip|broken|error/i.test(status ?? "");

interface Track {
  /** The track's storage place, 8 hex characters: "00157ad3" for attachments/00157/ad3.xz. */
  place: string;
  name: string;
  language: string;
  format: string;
  forced: boolean;
}

/**
 * How likely a release is to carry the dub's captions, by its name: an English dub's own release
 * ("English Dub", "ENG UNCUT", "Dubbed") 2, dual audio 1, one more for a streaming service's release
 * (web, or a service named), whose files keep the service's own tracks. A TV capture has none.
 */
/** A release named as an English dub ("[English Dub]", "Dubbed", "ENG UNCUT"), not only as dual audio. */
const NAMED_DUB = /(?:^|[^a-z])(?:eng(?:lish)?[ ._-]*(?:dub(?:bed)?|uncut)|dub(?:bed)?)(?:$|[^a-z])/i;

export function dubRelease(name: string): number {
  if (/(?:^|[^a-z])hdtv(?:$|[^a-z])/i.test(name)) return 0;
  const dub = NAMED_DUB.test(name)
    ? 2
    : /(?:^|[^a-z])dual[ ._-]*(?:audio)?(?:$|[^a-z])/i.test(name)
      ? 1
      : 0;
  if (!dub) return 0;
  const web = /(?:^|[^a-z])(?:web(?:[ ._-]?(?:dl|rip))?|funi(?:dub|mation)?|crunchyroll|cr|amzn|nf|hidive|dsnp|hulu)(?:$|[^a-z])/i.test(name);
  return dub + (web ? 1 : 0);
}

const ENGLISH = /^(en|eng|english)$/i;
const NOT_DIALOGUE = /sign|song|forced|karaoke|lyric/i;
const CAPTIONS = /(?:^|[^a-z])(?:cc|sdh|closed[ ._-]?captions?|captions|dub(?:bed)?|dubtitles?|hearing[ ._-]?impaired)(?:$|[^a-z])/i;
const TEXT_FORMAT = /^(ass|ssa|srt|subrip|utf-?8|webvtt|vtt|text)$/i;

/**
 * A file's track of English captions of English voices: an English text track named as captions or
 * dub captions, or the one English text track of a file whose every voice is English. Signs, songs
 * and forced tracks never. (A dual-audio file's plain "English" track is the translation.)
 */
export function captionsTrack(file: { englishVoicesOnly: boolean; tracks: Track[] }): Track | undefined {
  const text = file.tracks.filter((t) => ENGLISH.test(t.language) && TEXT_FORMAT.test(t.format) && !t.forced && !NOT_DIALOGUE.test(t.name));
  return text.find((t) => CAPTIONS.test(t.name)) ?? (file.englishVoicesOnly && text.length === 1 ? text[0] : undefined);
}

/** Whether a file's mediainfo lists audio tracks, every one of them in English. */
export function englishVoicesOnly(mediainfo: string): boolean {
  const audio = mediainfo.split(/\n\s*\n/).filter((section) => /^Audio\b/.test(section.trim()));
  if (audio.length === 0) return false;
  return audio.every((section) => /^Language\s*:\s*English\b/im.test(section));
}

/** A name with only its letters and digits, lower case: "The SHOW" and "The Show" alike. */
const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Tags in front of a release's name: "[Group] ", "(Batch) ". */
const LEADING_TAGS = /^\s*(?:[[({【][^\])}】]*[\])}】]\s*)+/u;
/** Where a name's own words end: " - ", a bracket, a pipe. */
const SEPARATOR = /^[\s._]*[-–—|~/[({【]/u;
/**
 * A word that may follow the show's name in a release's own name without making it another title:
 * an episode or season marker, a number or year, a season word, a release tag.
 */
const AFTER_NAME =
  /^(?:\d{1,4}(?:v\d)?|s\d{1,2}(?:e\d{1,4})?(?:v\d)?|ep?\d{1,4}(?:v\d)?|\d{1,2}x\d{1,4}|eps?|episodes?|seasons?|part|cour|pt\d*|\d{1,2}(?:st|nd|rd|th)|ii|iii|iv|vi{0,3}|ix|final|tv|dub|dubbed|eng|english|uncut|dual|multi|web|webrip|webdl|bd|bdrip|bluray|batch|complete|\d{3,4}p|hevc|avc|[xh]26[45]|uncensored)$/i;
const ORDINAL = /^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i;
const LETTER = /[\p{L}\p{N}]/u;

/**
 * Whether a release's own name is this name: after its leading tags, the release's name starts with
 * it (letters and digits compared, so "The SHOW!" and "the show" alike), followed by nothing, a
 * separator, an episode or season marker, or a release tag; not by more words of a title. Its search
 * matches words anywhere, so a search for "Show" also finds "Show Next Generation", another show.
 */
export function namesTitle(title: string, name: string): boolean {
  const own = squash(name);
  if (!own) return false;
  const text = title.replace(LEADING_TAGS, "");
  // Walk the release's letters and digits until the name's are used up: there the name ends in it.
  let matched = 0;
  let cut = -1;
  for (let i = 0; i < text.length && cut < 0; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    i += ch.length;
    if (!LETTER.test(ch)) continue;
    const lower = ch.toLowerCase();
    if (!own.startsWith(lower, matched)) return false;
    matched += lower.length;
    if (matched >= own.length) cut = i;
  }
  if (cut < 0) return false;
  const rest = text.slice(cut);
  if (!LETTER.test(rest) || SEPARATOR.test(rest)) return true;
  const [next = "", after = ""] = rest.match(/[\p{L}\p{N}]+/gu) ?? [];
  // "Show Second Season" is the show's; "Show Second Arc" is a title of its own (a season map's, when it is one).
  if (ORDINAL.test(next)) return /^(?:season|part|cour)$/i.test(after);
  return AFTER_NAME.test(next);
}

/** The words of a title to search by: what its search matches on (punctuation dropped). */
function words(title: string): string {
  return title.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * A search and how many of its pages (75 releases each, newest first) to go through. `own`: the
 * episode's own (one page, for the list being made); else the show's, the same for all its episodes.
 */
export interface Search {
  q: string;
  pages: number;
  own?: boolean;
}

/**
 * What to search for an episode. Its search matches words, and an episode number as a word or inside
 * a marker ("07" finds "S03E07" and "- 07"; "S02E04" doesn't find "S2 - 04"), newest releases first.
 * The episode's own, asked first: the show's name, "English Dub" and the episode's number (or its
 * number counted across the show, when that differs: "(09|44)" is either), and its dual-audio
 * releases naming it. Then the
 * show's own, its dub releases listed whole, a few pages deep: the name with each dub mark ("English
 * Dub", the web dubs' "UNCUT", "Dubbed") and each title the season goes by (later seasons are often
 * released under their own title, "Show: Second Arc - 03"). Phrases in quotes match as written.
 * Calibration (four episodes, each search one request): `"English Dub" 07` listed the episode's dub
 * releases where the show's first page of 75 didn't, and `S03E07` missed a season named "S2 - 11".
 */
export function searchesFor(request: StremioSubtitleRequest, show: string, seasonTitles: string[]): Search[] {
  const out: Search[] = [];
  const name = words(show);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (name && request.type === "series" && request.episode) {
    // Its number counted across the show too, when that differs, in the same search: "(09|44)" is either.
    const counted = request.absoluteEpisode !== undefined && request.absoluteEpisode !== request.episode ? request.absoluteEpisode : undefined;
    out.push({ q: `${name} "English Dub" ${counted === undefined ? pad(request.episode) : `(${pad(request.episode)}|${pad(counted)})`}`, pages: 1, own: true });
    if (request.season) out.push({ q: `${name} "Dual Audio" S${pad(request.season)}E${pad(request.episode)}`, pages: 1, own: true });
  }
  if (name) out.push({ q: `${name} "English Dub"`, pages: DUB_PAGES }, { q: `${name} UNCUT`, pages: 2 }, { q: `${name} Dubbed`, pages: 2 });
  for (const title of seasonTitles) {
    const t = words(title);
    if (t && t.toLowerCase() !== name.toLowerCase()) out.push({ q: `${t} "English Dub"`, pages: 2 });
  }
  return out.filter((a, i) => out.findIndex((b) => b.q === a.q) === i);
}

/** Pages of a show's "English Dub" releases gone through at most: a long show's run in two resolutions fills several. */
const DUB_PAGES = 10;
/** Releases a page holds; a shorter page is the last. */
const PAGE_SIZE = 75;

/** The titles a show's season map gives the requested season, its own name first (at most two). */
export function seasonTitles(request: StremioSubtitleRequest, map: SeasonMap | undefined): string[] {
  if (!map || request.season === undefined) return [];
  const titles: string[] = [];
  for (const entry of map.entries) {
    if (!Object.values(entry.episodes).some(([season]) => season === request.season)) continue;
    const own = entry.titles.find((t) => /[a-z]/i.test(t) && t.toLowerCase() !== map.show.toLowerCase());
    if (own) titles.push(own);
  }
  return [...new Set(titles)].slice(0, 2);
}

/**
 * A request's place in the line: "first" for what the list being made waits on (the episode's own
 * search, its own name searches and its likeliest releases), "signs" for the playing file's signs
 * (signsjob.ts: the dub's captions go before them), "later" for the rest (the show's wide searches,
 * the releases they add, the next episode looked at ahead).
 */
export type Tier = "first" | "signs" | "later";

/** Requests waiting for their turn, by tier. */
const waiting: Record<Tier, Array<() => void>> = { first: [], signs: [], later: [] };
let inFlight = 0;
/** Requests that may go out now, and when the last one was gained. */
let allowance = feedPace.burst;
let gainedAt = Date.now();
let blockedUntil = 0;
let wake: ReturnType<typeof setTimeout> | undefined;
/** When a request of each tier before the last one ended (see feedPace.followUpMs). */
const endedAt: Record<Exclude<Tier, "later">, number> = { first: 0, signs: 0 };

/** The line right now, for diagnostics: requests waiting in each tier, in flight, allowed at once, and how long the feed refuses for. */
export function feedNow(): { waiting: Record<Tier, number>; inFlight: number; allowance: number; refusedForMs: number } {
  return { waiting: { first: waiting.first.length, signs: waiting.signs.length, later: waiting.later.length }, inFlight, allowance, refusedForMs: Math.max(0, blockedUntil - Date.now()) };
}

/** Lets waiting requests go as far as the pace allows, and sets a timer for when the next one may. */
function letThrough(): void {
  const now = Date.now();
  if (feedPace.everyMs <= 0 || allowance >= feedPace.burst) {
    allowance = feedPace.burst;
    gainedAt = now;
  } else {
    const gained = Math.floor((now - gainedAt) / feedPace.everyMs);
    if (gained > 0) {
      allowance = Math.min(feedPace.burst, allowance + gained);
      gainedAt += gained * feedPace.everyMs;
    }
  }
  const kept = Math.min(feedPace.keptForFirst, feedPace.burst - 1);
  // The pace off (everyMs 0) is the hold off too: both are for the feed's sake.
  const heldSince = (since: number) => feedPace.everyMs > 0 && now - since < feedPace.followUpMs;
  const signsHeld = heldSince(endedAt.first);
  const laterHeld = signsHeld || heldSince(endedAt.signs);
  const laterMay = () => allowance > kept && !laterHeld;
  while (now >= blockedUntil && allowance > 0 && inFlight < feedPace.inFlight) {
    // The playing file's signs may use what is kept for an episode's own look-up, after it: they are
    // for the episode being played too. Calibration (an episode cold, its dub look-up done in 0.9 s):
    // kept from them, its signs came at 10.1 s, at the pace of one request every 2.5 s.
    const next = waiting.first.length ? waiting.first.shift() : waiting.signs.length && !signsHeld ? waiting.signs.shift() : laterMay() ? waiting.later.shift() : undefined;
    if (!next) break;
    allowance--;
    inFlight++;
    next();
  }
  // A timer only when the wait is for time: a request that ends lets the next one through itself.
  const forPace = waiting.first.length + waiting.signs.length > 0 ? allowance === 0 : waiting.later.length > 0 && allowance <= kept;
  const forHold = (signsHeld && waiting.signs.length > 0) || (laterHeld && waiting.later.length > 0);
  const blockedByTime = now < blockedUntil || forPace || forHold;
  if (wake || !blockedByTime) return;
  const at = Math.max(blockedUntil, forPace ? gainedAt + feedPace.everyMs : 0, forHold ? Math.max(endedAt.first, endedAt.signs) + feedPace.followUpMs : 0);
  wake = setTimeout(() => {
    wake = undefined;
    letThrough();
  }, Math.max(1, at - now));
}

/** Runs work in its turn (shared by every list being made), by its tier. */
export async function politely<T>(tier: Tier, work: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    waiting[tier].push(resolve);
    letThrough();
  });
  try {
    return await work();
  } finally {
    inFlight--;
    if (tier !== "later") endedAt[tier] = Date.now();
    letThrough();
  }
}

/** Look-ups under way, by what they ask: two lists asking for the same page or release at once share one request. */
const pending = new Map<string, Promise<unknown>>();
function shared<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = pending.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = work().finally(() => pending.delete(key));
  pending.set(key, started);
  return started;
}

/**
 * One request to its feed, in its turn. Its answers slow down when many are asked at once (a show's
 * first look): a release's files can take 10 s. A 429 pauses every request and is noted as an error,
 * so a block never passes for "nothing found".
 */
function feed(url: string, tier: Tier, accept = HEADERS.accept): Promise<Response> {
  const queuedAt = Date.now();
  return politely(tier, async () => {
    count("api.animetosho");
    const startedAt = Date.now();
    // Where a look-up's time goes: each request's wait for its turn (the pace above) and its answer.
    const timed = (outcome: string) => {
      count("api.animetosho.waitMs", startedAt - queuedAt);
      count("api.animetosho.answerMs", Date.now() - startedAt);
      console.log(`animetosho: ${asked(url)} (${tier}) waited ${startedAt - queuedAt} ms for its turn, answered in ${Date.now() - startedAt} ms: ${outcome}`);
    };
    let response: Response;
    try {
      response = await fetch(url, { headers: { ...HEADERS, accept }, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      timed(error instanceof Error ? error.name : "failed");
      throw error;
    }
    timed(`HTTP ${response.status}`);
    if (response.status === 429) {
      if (Date.now() >= blockedUntil) noteError("animetosho", new Error(`HTTP 429: asked too often, paused for ${feedPace.blockedMs / 1000} s`));
      blockedUntil = Date.now() + feedPace.blockedMs;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  });
}

/** A request in a few words, for the log: its path's end and what it asks. */
function asked(url: string): string {
  try {
    const at = new URL(url);
    return `${at.pathname.split("/").filter(Boolean).slice(-2).join("/")}${decodeURIComponent(at.search)}`.slice(0, 90);
  } catch {
    return "a request";
  }
}

async function getJson<T>(url: string, tier: Tier): Promise<T> {
  return (await (await feed(url, tier)).json()) as T;
}

/** One page of a search, as asked now. */
async function askPage(q: string, page: number, tier: Tier): Promise<Listed[]> {
  const rows = await getJson<Listed[]>(`${ANIMETOSHO_FEED}?${new URLSearchParams({ q, ...(page > 1 ? { page: String(page) } : {}) })}`, tier);
  return (Array.isArray(rows) ? rows : []).map((r) => ({ id: r.id, title: r.title, num_files: r.num_files, status: r.status, timestamp: r.timestamp }));
}

/**
 * An episode's own search (one page), kept 12 hours; an hour when it lists a release still being
 * mirrored, which is left out until it is complete.
 */
function episodeNameSearch(q: string, tier: Tier): Promise<Listed[]> {
  const key = cacheKey({ kind: "animetosho-search", q, page: 1 });
  return shared(key, async () => {
    const cached = await readJsonCache<Listed[]>("results", key);
    if (cached) return cached;
    const kept = await askPage(q, 1, tier);
    await writeJsonCache("results", key, kept, kept.some((r) => coming(r.status)) ? UNSETTLED_TTL_S : SEARCH_TTL_S);
    return kept;
  });
}

/** A show-wide search kept, whatever its age: what it lists at no cost. */
interface ShowSearch {
  rows: Listed[];
  checkedAt: number;
}
const showKey = (q: string) => cacheKey({ kind: "animetosho-show", q });
async function keptShowSearch(q: string): Promise<Listed[]> {
  return (await readJsonCache<ShowSearch>("results", showKey(q)).catch(() => undefined))?.rows ?? [];
}

/**
 * A show-wide search (the same for every episode of the show), kept SHOW_KEPT_S: once its pages are
 * read (newest first, until one comes back short), only its newest are asked again after
 * SEARCH_TTL_S, page by page while every release on a page is new, their releases put in front and
 * the statuses of those already known brought up to date.
 */
function showSearch({ q, pages }: Search, tier: Tier): Promise<Listed[]> {
  const key = showKey(q);
  return shared(key, async () => {
    const kept = await readJsonCache<ShowSearch>("results", key).catch(() => undefined);
    if (kept && Date.now() - kept.checkedAt < SEARCH_TTL_S * 1000) return kept.rows;
    const known = new Map((kept?.rows ?? []).map((r) => [r.id, r]));
    const fresh: Listed[] = [];
    for (let page = 1; page <= pages; page++) {
      const rows = await askPage(q, page, tier);
      fresh.push(...rows);
      if (rows.length < PAGE_SIZE || (kept && rows.some((r) => known.has(r.id)))) break;
    }
    const seen = new Set(fresh.map((r) => r.id));
    const all = [...fresh, ...(kept?.rows ?? []).filter((r) => !seen.has(r.id))];
    await writeJsonCache("results", key, { rows: all, checkedAt: Date.now() } satisfies ShowSearch, SHOW_KEPT_S);
    return all;
  });
}

/** Where its Torznab search finds an episode: the show's Kitsu entry and that entry's own episode, else TVDB's or IMDb's season and episode. */
export type EpisodeIds =
  | { kitsuId: string; episode: number }
  | { tvdbId: number; season: number; episode: number }
  | { imdbId: string; season: number; episode: number };

/**
 * An episode's ids for its Torznab search: a Kitsu request's own; for an IMDb one, the season map's
 * entry that holds the episode, by that entry's own number (a later season's episode 2 is its
 * entry's 2, as Anime Tosho counts). Else TVDB's season and episode (`tvdbId`, from Cinemeta), which
 * its releases are tagged with; IMDb's last, as its mapping of a later season can land on a special.
 */
export function episodeIds(request: StremioSubtitleRequest, map: SeasonMap | undefined, tvdbId?: number): EpisodeIds | undefined {
  if (request.type !== "series") return undefined;
  const kitsu = parseKitsuId(request.id);
  if (kitsu) return kitsu.episode !== undefined ? { kitsuId: kitsu.kitsuId, episode: kitsu.episode } : undefined;
  if (request.season === undefined || request.episode === undefined) return undefined;
  for (const entry of map?.entries ?? []) {
    const own = Object.entries(entry.episodes).find(([, [season, episode]]) => season === request.season && episode === request.episode)?.[0];
    if (entry.kitsuId && own) return { kitsuId: entry.kitsuId, episode: Number(own) };
  }
  if (tvdbId) return { tvdbId, season: request.season, episode: request.episode };
  return request.imdbId ? { imdbId: request.imdbId, season: request.season, episode: request.episode } : undefined;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** An XML element's text: a CDATA section as written, anything else with its entities read. */
function xmlText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1];
  return raw.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (whole, dec: string, hex: string, name: string) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (XML_ENTITIES[name] ?? whole)
  );
}

/**
 * The releases a Torznab answer lists, as its JSON search gives them: the id from the release's page
 * ("…/view/1000"), its name, files and date. It gives no status: a release not yet mirrored whole
 * is opened and found without tracks, which is kept only an hour.
 */
export function torznabReleases(xml: string): Listed[] {
  const out: Listed[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const id = Number(/<guid[^>]*>[^<]*\/view\/(\d+)/.exec(item)?.[1]);
    const title = xmlText(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? "").trim();
    if (!id || !title) continue;
    const files = Number(/<torznab:attr name="files" value="(\d+)"/.exec(item)?.[1]);
    const date = Date.parse(/<pubDate>([^<]+)<\/pubDate>/.exec(item)?.[1] ?? "");
    out.push({ id, title, ...(files ? { num_files: files } : {}), ...(date ? { timestamp: Math.floor(date / 1000) } : {}) });
  }
  return out;
}

/**
 * The releases filed under the episode, by its ids: one request, kept 12 hours; an hour when there are
 * none yet (the episode may be about to come out).
 */
function episodeSearch(ids: EpisodeIds, tier: Tier = "first"): Promise<Listed[]> {
  const key = cacheKey({ kind: "animetosho-episode", ...ids });
  return shared(key, async () => {
    const cached = await readJsonCache<Listed[]>("results", key);
    if (cached) return cached;
    const by: Record<string, string> =
      "kitsuId" in ids ? { kitsuid: ids.kitsuId } : "tvdbId" in ids ? { tvdbid: String(ids.tvdbId), season: String(ids.season) } : { imdbid: ids.imdbId, season: String(ids.season) };
    const response = await feed(`${ANIMETOSHO_API}?${new URLSearchParams({ t: "tvsearch", ...by, ep: String(ids.episode), limit: String(EPISODE_LIMIT) })}`, tier, "application/rss+xml");
    const rows = torznabReleases(await response.text());
    await writeJsonCache("results", key, rows, rows.length ? SEARCH_TTL_S : UNSETTLED_TTL_S);
    return rows;
  });
}

type ApiAttachment = { type?: string; url?: string; info?: { name?: string; language_code?: string; format?: string; forced?: boolean } };

interface ApiRelease {
  id: number;
  title: string;
  status?: string;
  timestamp?: number;
  files?: Array<{
    filename?: string;
    info?: { mediainfo?: string };
    attachments?: ApiAttachment[];
  }>;
  /** Newer releases list their tracks here, at the release's top, rather than under each file. */
  attachments?: ApiAttachment[];
}

/** The file a track's link names (its `filename`: "<file>_track3.eng.ass.xz"), without the file's extension. */
function fileOfTrack(url: string | undefined): string | undefined {
  try {
    return new URL(url ?? "").searchParams.get("filename")?.replace(/_track\d+\.[^/]*$/i, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A release's files and their subtitle tracks, kept 30 days (a mirrored release doesn't change).
 * One not yet complete, or with no subtitle track at all, is kept an hour: its tracks may come yet.
 */
function release(id: number, tier: Tier): Promise<Release> {
  const key = cacheKey({ kind: "animetosho-release", id });
  return shared(key, async () => {
    const cached = await readJsonCache<Release>("results", key);
    if (cached) return cached;
    const body = await getJson<ApiRelease>(`${ANIMETOSHO_FEED}?${new URLSearchParams({ show: "torrent", id: String(id) })}`, tier);
    const files = body.files ?? [];
    // A track listed at the release's top belongs to the file its link names, or to the only file there is.
    const topFor = (name: string) => (body.attachments ?? []).filter((a) => files.length === 1 || fileOfTrack(a.url) === name.replace(/\.[^.]+$/, ""));
    const kept: Release = {
      id: body.id,
      title: body.title,
      ...(body.timestamp ? { timestamp: body.timestamp } : {}),
      files: files.map((f) => {
        const folders = (f.filename ?? "").split("/");
        const name = folders.pop() ?? "";
        return {
          name,
          ...(folders.length ? { folder: folders.join("/") } : {}),
          englishVoicesOnly: englishVoicesOnly(f.info?.mediainfo ?? ""),
          tracks: [...(f.attachments ?? []), ...topFor(name)].flatMap((a): Track[] => {
            // Its storage path: five hex digits, then three or more ("00298/b54", "1000c/44a0"); the ref joins them.
            const place = /\/attachments\/([0-9a-f]{5})\/([0-9a-f]{3,8})\.xz/.exec(a.url ?? "");
            if (a.type !== "subtitle" || !place) return [];
            return [{ place: place[1] + place[2], name: a.info?.name ?? "", language: a.info?.language_code ?? "", format: a.info?.format ?? "", forced: a.info?.forced === true }];
          })
        };
      })
    };
    // An older release's "unknown" is as final as "complete": it was mirrored long ago.
    const final = settled(body.status) && kept.files.some((f) => f.tracks.length > 0);
    await writeJsonCache("results", key, kept, final ? RELEASE_TTL_S : UNSETTLED_TTL_S);
    return kept;
  });
}

/** Whether names may hold the episode, by the same matching every subtitle name goes through. */
function holds(names: string[], files: number, request: StremioSubtitleRequest, map: SeasonMap | undefined): boolean {
  const probe: SubSourceSubtitle = { subtitleId: 0, movieId: 0, language: "english", releaseInfo: names, files };
  return filterAndRankDubtitles([probe], request, { requireDub: false, allowMachine: true, seasonMap: map }).length > 0;
}

/** Seasons a name gives, alone ("Season 2", "S2") or with an episode ("S02E01-12"). */
const seasonsIn = (name: string) => new Set([...extractSeasonMarkers(name), ...extractEpisodeMarkers(name).map((m) => m.season)]);

/**
 * The season a batch's file is in when its own name gives none ("Season 2/Show - 03.mkv"): the one
 * season its nearest folder that names any gives, else the release's name. A folder or name giving
 * several ("S1-S2") gives none.
 */
export function seasonAround(file: { name: string; folder?: string }, title: string): number | undefined {
  if (seasonsIn(file.name).size > 0) return undefined;
  for (const around of [...(file.folder ?? "").split("/").reverse(), title]) {
    const seasons = seasonsIn(around);
    if (seasons.size === 1) return [...seasons][0];
    if (seasons.size > 1) return undefined;
  }
  return undefined;
}

/**
 * The releases likeliest to hold the episode's dub captions, best first, one of each release's
 * resolutions. `namesShow` says whether a release's own name is the show's or a season's.
 */
function likeliest(rows: Listed[], request: StremioSubtitleRequest, map: SeasonMap | undefined, namesShow: (title: string) => boolean): Listed[] {
  const batch = (row: Listed) => (row.num_files ?? 1) > 1;
  // One of a group's releases of an episode: its 1080p and 720p carry the same track.
  const sameRelease = (title: string) => title.toLowerCase().replace(/\b\d{3,4}p\b|\[[0-9a-f]{8}\]|x26[45]|hevc|avc/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const candidates = rows
    .map((row) => ({ row, rank: dubRelease(row.title), named: holds([row.title], row.num_files ?? 1, request, map) }))
    // A batch's name may give a range the matching doesn't read ("S02E03-11"): its files are matched one by one below,
    // so a batch is opened unless its name gives only other seasons.
    .filter(({ row, rank, named }) => rank > 0 && row.num_files !== 0 && namesShow(row.title) && (named || (batch(row) && !namesOnlyAnotherSeason(row.title, request))))
    // The likelier release first, then one whose name holds the episode, then a single episode's, then the newest.
    .sort((a, b) => b.rank - a.rank || Number(b.named) - Number(a.named) || Number(batch(a.row)) - Number(batch(b.row)) || (b.row.timestamp ?? 0) - (a.row.timestamp ?? 0));
  // Of one release's resolutions, the first in that order, unless a later one is known complete and it isn't.
  const byRelease = new Map<string, Listed>();
  for (const { row } of candidates) {
    const key = sameRelease(row.title);
    const had = byRelease.get(key);
    if (!had || (had.status !== "complete" && row.status === "complete")) byRelease.set(key, row);
  }
  return [...byRelease.values()];
}

/** The episode's dub captions in one release: each file that holds the episode, by its captions track. */
function tracksOf(rel: Release | undefined, request: StremioSubtitleRequest, map: SeasonMap | undefined): SubSourceSubtitle[] {
  if (!rel) return [];
  // The release's name goes beside a file's only when it doesn't place the episode elsewhere (a batch's "S02E01-12" would).
  const titleFits = holds([rel.title], rel.files.length, request, map);
  const out: SubSourceSubtitle[] = [];
  for (const file of rel.files) {
    // A batch's file named only by its number goes by the season its folder or the release gives.
    const season = seasonAround(file, rel.title);
    const names = [file.name.replace(/\.(mkv|mp4)$/i, ""), ...(season !== undefined ? [`Season ${season}`] : [])];
    if (!holds(names, 1, request, map)) continue;
    const track = captionsTrack(file);
    if (!track) continue;
    out.push({
      subtitleId: 0,
      ref: `at${track.place}`,
      source: "animetosho",
      movieId: 0,
      language: "english",
      releaseInfo: [...names, ...(titleFits ? [rel.title] : [])],
      // What it is, in the words the ranking reads: the dub's captions, made by the service.
      commentary: `English Dub captions: the release's own "${track.name || "English"}" track`,
      productionType: "official",
      files: 1,
      hearingImpaired: /cc|sdh|closed|hearing/i.test(track.name),
      downloads: 0,
      rating: null,
      ...(rel.timestamp ? { createdAt: new Date(rel.timestamp * 1000).toISOString() } : {})
    });
  }
  return out;
}

/**
 * A release's signs for the episode: its signs track (on-screen text and songs, typeset) and the
 * English dialogue track of the same file that times it to the playing file, as "at" refs. A file
 * with no signs track gives its full track instead (`full`), its signs taken from among its lines.
 */
export interface SignsSource {
  signs: string;
  partner: string;
  full: boolean;
  /** The track names and the release, as the activity log shows them. */
  signsName: string;
  release: string;
}

const ASS_FORMAT = /^(ass|ssa)$/i;

/** The episode's signs in one release: per file that holds it, a signs track and its dialogue track, else a full track. */
export function signsOf(rel: Release | undefined, request: StremioSubtitleRequest, map: SeasonMap | undefined): SignsSource[] {
  if (!rel) return [];
  const out: SignsSource[] = [];
  for (const file of rel.files) {
    const season = seasonAround(file, rel.title);
    const names = [file.name.replace(/\.(mkv|mp4)$/i, ""), ...(season !== undefined ? [`Season ${season}`] : [])];
    if (!holds(names, 1, request, map)) continue;
    const english = file.tracks.filter((t) => ENGLISH.test(t.language) && ASS_FORMAT.test(t.format));
    const signs = english.find((t) => t.forced || NOT_DIALOGUE.test(t.name));
    // The dialogue of the original audio: the dub's own captions follow other voices.
    const dialogue = english.find((t) => !t.forced && !NOT_DIALOGUE.test(t.name) && !CAPTIONS.test(t.name));
    if (!dialogue) continue;
    out.push(
      signs
        ? { signs: `at${signs.place}`, partner: `at${dialogue.place}`, full: false, signsName: signs.name || "Signs", release: rel.title }
        : { signs: `at${dialogue.place}`, partner: `at${dialogue.place}`, full: true, signsName: dialogue.name || "English", release: rel.title }
    );
  }
  return out;
}

/** Where a release's video comes from, by its name: a disc, a web service or a TV capture. */
export function videoSource(name: string): "bd" | "web" | "tv" | undefined {
  if (/(?:^|[^a-z])(?:bd|blu-?ray|bdrip|bdremux)(?:$|[^a-z])/i.test(name)) return "bd";
  if (/(?:^|[^a-z])(?:web(?:[ ._-]?(?:dl|rip))?|cr|amzn|nf|funi(?:mation)?|hidive|b-global|crunchyroll|dsnp)(?:$|[^a-z])/i.test(name)) return "web";
  if (/(?:^|[^a-z])(?:hdtv|tv(?:rip)?)(?:$|[^a-z])/i.test(name)) return "tv";
  return undefined;
}

/**
 * The dub captions' look-ups under way for an episode (by its request id), until their own searches and
 * the releases those found are read: the signs search for the same episode waits for that, so the dub
 * goes first and the signs ask nothing it asks.
 */
const dubFirstPhases = new Map<string, Promise<void>>();

/** Releases opened for an episode's signs at most, all told (each a request for its files, unless kept). */
const SIGNS_RELEASES = 6;
/**
 * Releases asked for, none of them with a signs track, before a full track found meanwhile is given:
 * a signs track is worth one more request or two, as its signs need no telling from dialogue.
 */
const SIGNS_TRACK_LOOK = 2;
/** Releases from the episode's own search read before its name searches are asked. */
const SIGNS_EARLY = 1;
/** A release named as holding more than one audio: a dub beside the original, so signs to show with the dub. */
const MORE_AUDIO = /(?:^|[^a-z])(?:dual|multi)[ ._-]*audio/i;

/**
 * The episode's signs sources, best first, each given as soon as it is found, so the first can be
 * timed while nothing more is asked: Anime Tosho answers in a fraction of a second but takes one
 * request every 2.5 s past a short burst, so what costs time is how many are asked. Calibration (an
 * episode looked up cold, every release opened before any was tried): 13 requests, 22.6 s waiting
 * for their turn, 1.0 s of work after.
 *
 * First, one release with a dub that the episode's own search lists (SIGNS_EARLY, MORE_AUDIO): that
 * search is the dub captions' look-up's too and in hand within a second, so its signs can be timed
 * to the file while the name searches are still to be asked. Calibration (an episode cold, its
 * signs in a web release the episode's search listed): asked for after a name search and two discs'
 * releases, they were read 19.0 s in; the release was known 0.9 s in.
 *
 * Then, in order: the releases the episode's own search files it under (that search shared with the dub
 * captions' look-up), with the show's name searches already kept; of those, the ones whose files are
 * kept before any to be asked for; then a release whose video comes from where the playing file's
 * does (a disc's cut and timing are a disc's), then a dual-audio one (its signs are meant to be shown
 * with the dub). A full track waits until SIGNS_TRACK_LOOK releases asked for gave no signs track.
 * Only when all of those are tried does the show's name searches' answer add more. Its requests go in
 * `lane`'s tier, the signs' unless the caller moves it: after the dub captions' look-up for the list
 * being made, which it waits for, and ahead of everything else. A caller that has signs already moves
 * the rest of its look to "later".
 */
export async function* animeToshoSigns(
  request: StremioSubtitleRequest,
  show: string | undefined,
  map: SeasonMap | undefined,
  {
    tvdbId,
    filename,
    opened,
    lane = { tier: "signs" }
  }: { tvdbId?: number; filename?: string; opened?: Array<{ title: string; gave: number; kept: boolean }>; lane?: { tier: Tier } } = {}
): AsyncGenerator<SignsSource> {
  if (!show) return;
  const titles = seasonTitles(request, map);
  const names = [...new Set([show, ...titles, ...(map?.entries.flatMap((e) => e.titles) ?? [])])].filter((n) => squash(n).length >= 2);
  const namesShow = (title: string) => names.some((n) => namesTitle(title, n));
  const source = filename ? videoSource(filename) : undefined;
  const rank = (title: string) => (source && videoSource(title) === source ? 2 : 0) + (/(?:^|[^a-z])(?:dual|multi)[ ._-]*(?:audio|sub)?/i.test(title) ? 1 : 0);
  const fits = (row: Listed) =>
    settled(row.status) && row.num_files !== 0 && namesShow(row.title) && (holds([row.title], row.num_files ?? 1, request, map) || ((row.num_files ?? 1) > 1 && !namesOnlyAnotherSeason(row.title, request)));
  const seen = new Set<number>();
  /** Full tracks found, held back while a signs track may still turn up. */
  const held: SignsSource[] = [];
  let opens = 0;
  let asked = 0;
  async function* from(rows: Listed[], most = SIGNS_RELEASES): AsyncGenerator<SignsSource> {
    let here = 0;
    const ranked = [...new Map(rows.filter((row) => !seen.has(row.id) && fits(row)).map((row) => [row.id, row])).values()].sort(
      (a, b) => rank(b.title) - rank(a.title) || (a.num_files ?? 1) - (b.num_files ?? 1) || (b.timestamp ?? 0) - (a.timestamp ?? 0)
    );
    const kept = await Promise.all(ranked.map((row) => readJsonCache<Release>("results", cacheKey({ kind: "animetosho-release", id: row.id })).then(Boolean, () => false)));
    for (const [row, isKept] of [...ranked.map((row, i) => [row, kept[i]] as const).filter(([, k]) => k), ...ranked.map((row, i) => [row, kept[i]] as const).filter(([, k]) => !k)]) {
      if (opens >= SIGNS_RELEASES || here >= most) return;
      seen.add(row.id);
      opens++;
      here++;
      const gave = signsOf(await release(row.id, lane.tier).catch(() => undefined), request, map);
      opened?.push({ title: row.title, gave: gave.length, kept: isKept });
      if (!isKept) asked++;
      for (const s of gave) if (!s.full) yield s;
      held.push(...gave.filter((s) => s.full));
      if (asked >= SIGNS_TRACK_LOOK) yield* held.splice(0);
    }
  }
  try {
    const ids = episodeIds(request, map, tvdbId);
    const queries = searchesFor(request, show, titles);
    // The search by ids is one request shared with the dub captions' look-up, whichever asks first.
    const byIds = ids ? await episodeSearch(ids, lane.tier).catch(() => [] as Listed[]) : [];
    yield* from(byIds.filter((row) => MORE_AUDIO.test(row.title)), SIGNS_EARLY);
    // The episode's own name searches are the dub captions' look-up's too: once that look-up has asked
    // them and read what they found, they are kept, and nothing of the dub's waits behind them.
    await dubFirstPhases.get(request.id)?.catch(() => undefined);
    const own: Listed[] = (await Promise.all(queries.filter((q) => !q.own).map((query) => keptShowSearch(query.q)))).flat();
    own.push(...byIds);
    for (const query of queries.filter((q) => q.own)) own.push(...(await episodeNameSearch(query.q, lane.tier).catch(() => [] as Listed[])));
    yield* from(own);
    yield* held.splice(0);
    yield* from((await Promise.all(queries.filter((q) => !q.own).map((query) => showSearch(query, "later").catch(() => [] as Listed[])))).flat());
    yield* held.splice(0);
  } catch (error) {
    noteError("animetosho", error);
    console.error(`animetosho: signs search failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Starts the episode's search by the ids it has before its season map is known (a Kitsu request's
 * own, else TVDB's or IMDb's season and episode), so the search is under way while the map is looked
 * up. When the map leaves the ids as they were, animeToshoSubtitles takes this same search (in flight
 * or kept); when it gives a Kitsu entry's ids, that search is made as well.
 *
 * With the show's name, the release that search names as the episode's English dub is read as soon as
 * the search answers, without waiting for the map either: animeToshoSubtitles opens that one first, and
 * finds it read (or being read). Reading it takes about 2 s, and a map's first look-up can take longer
 * than a list has left once it is back. Calibration (an episode looked up cold): its first dub track
 * came 3.4 s in with a map back in 0.7 s; on a play whose map took 3.7 s, a list of 5.2 s had none.
 */
export function startEpisodeSearch(request: StremioSubtitleRequest, tvdbId?: number, tier: Tier = "first", show?: string): void {
  const ids = episodeIds(request, undefined, tvdbId);
  if (!ids) return;
  void episodeSearch(ids, tier)
    .then((rows) => {
      if (!show || squash(show).length < 2) return;
      const first = likeliest(rows.filter((row) => settled(row.status)), request, undefined, (title) => namesTitle(title, show)).find((row) => NAMED_DUB.test(row.title));
      if (first) void release(first.id, tier).catch(() => undefined);
    })
    .catch(() => undefined);
}

/** The dub captions' look-up for a list still under way for this request id (see dubFirstPhases), if any. */
export function dubPhaseOf(requestId: string): Promise<void> | undefined {
  return dubFirstPhases.get(requestId);
}

/**
 * Dub captions for the episode from Anime Tosho: each a release's own English captions track, for
 * the file of the release that holds this episode. `show` is the show's name; `map` its seasons;
 * `tvdbId` the show's TVDB id, when known. `found`, when given, gets each track as soon as its
 * release is read, so a list that can't wait for the rest still has those. `opening`, when given,
 * holds the reads of the releases the episode's own searches found, while they're under way: a dub
 * track for the episode is on its way while it isn't empty. `ahead`: for an episode looked at before
 * it is played, every request at the back of the line. `listWaitMs`: how long the list being made can
 * still take a track; past it, what is left goes behind the playing file's signs.
 */
export async function animeToshoSubtitles(
  request: StremioSubtitleRequest,
  show: string | undefined,
  map: SeasonMap | undefined,
  { found, tvdbId, opening, ahead, listWaitMs }: { found?: SubSourceSubtitle[]; tvdbId?: number; opening?: Set<Promise<unknown>>; ahead?: boolean; listWaitMs?: number } = {}
): Promise<SubSourceSubtitle[]> {
  if (!show) return [];
  // Its own phase, for the signs search of the same episode to wait for (ended whatever happens, and
  // once the list being made can no longer take a track: then only the signs can still reach this play).
  let phaseDone = () => {};
  let listGone: ReturnType<typeof setTimeout> | undefined;
  if (!ahead) {
    const phase = new Promise<void>((resolve) => (phaseDone = resolve));
    dubFirstPhases.set(request.id, phase);
    void phase.then(() => dubFirstPhases.get(request.id) === phase && dubFirstPhases.delete(request.id));
    if (listWaitMs !== undefined) listGone = setTimeout(() => phaseDone(), listWaitMs).unref();
  }
  try {
    const titles = seasonTitles(request, map);
    // Its search matches words anywhere (a batch's file names, another show's longer title): a release's own name must be the show's or a season's.
    const names = [...new Set([show, ...titles, ...(map?.entries.flatMap((e) => e.titles) ?? [])])].filter((n) => squash(n).length >= 2);
    const namesShow = (title: string) => names.some((n) => namesTitle(title, n));
    const ids = episodeIds(request, map, tvdbId);
    const rows = new Map<number, Listed>();
    const opened = new Map<number, Promise<Release | undefined>>();
    /**
     * Adds what a search found, and opens up to `count` more of the likeliest releases known
     * (MAX_RELEASES in all); `named`: only releases named as an English dub.
     */
    const open = (more: Listed[], count: number, tier: Tier, named = false) => {
      // Only releases mirrored whole: one still processing has no tracks yet (it is found again once complete).
      for (const row of more) if (settled(row.status) && !rows.has(row.id)) rows.set(row.id, row);
      let added = 0;
      for (const row of likeliest([...rows.values()], request, map, namesShow)) {
        if (opened.size >= MAX_RELEASES || added >= count) break;
        if (opened.has(row.id) || (named && !NAMED_DUB.test(row.title))) continue;
        added++;
        const reading = release(row.id, tier).catch(() => undefined);
        opened.set(row.id, reading);
        if (found) void reading.then((rel) => found.push(...tracksOf(rel, request, map).filter((s) => !found.some((f) => f.ref === s.ref))));
        // Its tracks reach `found` (above) before it leaves `opening`: the then above runs first.
        if (tier === "first" && opening) {
          opening.add(reading);
          void reading.finally(() => opening.delete(reading));
        }
      }
    };
    const queries = searchesFor(request, show, titles);
    const own = queries.filter((q) => q.own);
    const wide = queries.filter((q) => !q.own);
    const tier: Tier = ahead ? "later" : "first";
    // The episode's own first, for the list being made, and in turn, as the feed answers one request
    // at a time: the show's wide searches already kept (they cost nothing), its search by ids (the
    // quicker to answer: 0.4-0.9 s where a search by name took 1.7-2.3 s), then its own name searches,
    // its dub search first. After each, the releases it found named as an English dub are read before the
    // next search is asked (their track is the likeliest); the others, only dual-audio or from a web
    // service, once the episode's own searches are done. Calibration (episodes looked up cold): with the
    // wide searches asked before any release they found was read, 14 requests and the first dub track at
    // 22.6 s, where a list answers within 5.5 s; in this order, 6.6-6.9 s at 2 s a request.
    for (const query of wide) open(await keptShowSearch(query.q), PER_SEARCH, tier, true);
    let lane = tier;
    /**
     * Once a dub track is in, the rest only adds alternates: it goes behind the playing file's signs,
     * which stop waiting. (Waiting for the reads under way costs no time: the feed answers them before
     * the next search.)
     */
    let listOpen = true;
    if (listGone) void dubFirstPhases.get(request.id)?.then(() => (listOpen = false));
    const trackIn = async () => {
      if (lane === "first" && !listOpen) lane = "later";
      if (lane === "first" && (await Promise.all(opened.values())).some((rel) => tracksOf(rel, request, map).length > 0)) {
        lane = "later";
        phaseDone();
      }
    };
    open(ids ? await episodeSearch(ids, lane).catch(() => [] as Listed[]) : [], FIRST_RELEASES, lane, true);
    for (const query of own) {
      await trackIn();
      open(await episodeNameSearch(query.q, lane).catch(() => [] as Listed[]), PER_SEARCH, lane, true);
    }
    await trackIn();
    open([], FIRST_RELEASES, lane);
    await Promise.all(opened.values());
    phaseDone();
    // Then the show's wide searches (kept for days, their newest page asked again after 12 hours), which
    // find what those miss, at the back of the line: behind the playing file's signs.
    const byNames = await Promise.all(wide.map((query) => showSearch(query, "later").catch(() => [] as Listed[])));
    open(byNames.flat(), MAX_RELEASES, "later");
    // Best first, as the releases rank with everything both searches found.
    const order = likeliest([...rows.values()], request, map, namesShow).map((row) => row.id).filter((id) => opened.has(id));
    for (const id of opened.keys()) if (!order.includes(id)) order.push(id);
    const out: SubSourceSubtitle[] = [];
    for (const id of order) {
      for (const subtitle of tracksOf(await opened.get(id), request, map)) if (!out.some((s) => s.ref === subtitle.ref)) out.push(subtitle);
    }
    return out;
  } catch (error) {
    noteError("animetosho", error);
    console.error(`animetosho: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  } finally {
    clearTimeout(listGone);
    phaseDone();
  }
}

/** The words of an "at" subtitle: its track from Anime Tosho's storage, unpacked. */
export async function downloadAnimeTosho(ref: string): Promise<Buffer> {
  const place = /^at([0-9a-f]{8,13})$/.exec(ref)?.[1];
  if (!place) throw new Error(`unknown subtitle ${ref}`);
  count("api.animetosho");
  const response = await fetch(`${ANIMETOSHO_STORAGE}/${place.slice(0, 5)}/${place.slice(5)}.xz`, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
  const reader = new XzReadableStream(response.body).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_TRACK_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`subtitle ${ref} unpacks to more than a subtitle ever is`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
