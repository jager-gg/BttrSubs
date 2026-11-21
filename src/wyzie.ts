/**
 * Wyzie Subs (sub.wyzie.io): one search across its own sources by IMDb id, season and episode, with
 * the person's own key (free: 1,000 requests a day). A search costs one request per source it asks
 * (four on a free key) and a download one more, billed to the key that searched: each result's
 * download link carries a token for that key. So the links are kept here, per key, and never handed
 * out or logged; a download link of BttrSubs' own names only the result's ref.
 */
import { createHash } from "node:crypto";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { readCapped } from "./net.js";
import { count, noteError, noteKeyCall } from "./stats.js";
import { languageCode, languageName, languageTitle, sameLanguage } from "./langcodes.js";
import { addonCodeAlias, addonLanguage } from "./sources.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

export const WYZIE_API = "https://sub.wyzie.io";
/** A result's download token lasts 60 days from its search; its link is kept a day less. */
const LINK_KEPT_S = 59 * 86_400;

interface WyzieItem {
  id?: string | number | null;
  url?: string | null;
  format?: string | null;
  language?: string | null;
  isHearingImpaired?: boolean | null;
  source?: string | null;
  release?: string | null;
  releases?: string[] | null;
  fileName?: string | null;
  downloadCount?: number | null;
  /** A translation Wyzie makes when asked (its /translate), not an upload. */
  ai?: boolean | null;
  /** Wyzie's own mark for an upload that is a machine translation. */
  machine?: boolean | null;
}

/** A key's own tag in cache names: its searches, and the links they gave, stay its own. */
const keyTag = (apiKey: string) => createHash("sha256").update(`wyzie:${apiKey}`).digest("hex").slice(0, 16);

/** A result's ref: "wz" and a hash of its source and id (Wyzie's ids can hold slashes and spaces). */
export function wyzieRef(source: string, id: string): string {
  return `wz${createHash("sha256").update(`${source}\0${id}`).digest("hex").slice(0, 20)}`;
}

const linkKey = (apiKey: string, ref: string) => cacheKey({ kind: "wyzie-link", key: keyTag(apiKey), ref });

/** Keys with no requests left, by tag, until Wyzie's reset: a search sent then is only refused. */
const spentUntil = new Map<string, number>();

/** Notes a key that has run out, from a reply's balance (x-wyzie-balance) or a refusal. */
function noteBalance(apiKey: string, response: Response): void {
  const left = Number(response.headers.get("x-wyzie-balance") ?? Number.NaN);
  if (response.status !== 429 && response.status !== 402 && left !== 0) return;
  // Its reset (seconds since 1970; midnight UTC for a free key), else an hour.
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  spentUntil.set(keyTag(apiKey), reset > Date.now() ? reset : Date.now() + 3_600_000);
}

const NAMES = new Intl.DisplayNames(["en"], { type: "language" });
/** A two-letter ISO 639-1 code a language name stands for ("portuguese (br)" -> "pt"), or none. */
function isoCode(name: string): string | undefined {
  const code = languageCode(name)?.slice(0, 2);
  if (!code || !/^[a-z]{2}$/.test(code)) return undefined;
  try {
    return NAMES.of(code) !== code ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which of the wanted languages a result's code is ("en-AU" -> "english"): its own code when one
 * wanted language has it ("pt-br"), else the one wanted language of its two letters, else among
 * several (Portuguese and Brazilian Portuguese for "pt") the one whose code is just those letters.
 * A code that is another language's own ("pt-PT" with only Brazilian Portuguese wanted) is none of them,
 * and so is one spelled another way for a language that isn't wanted ("zh-Hant" with only simplified
 * Chinese wanted, "fil" with Finnish wanted).
 */
export function wantedLanguageOf(code: string, wanted: string[]): string | undefined {
  const c = code.trim().toLowerCase();
  const exact = wanted.find((n) => languageCode(n) === c);
  if (exact) return exact;
  if (languageName(c)) return undefined;
  const named = (name: string | undefined) => (name ? wanted.find((n) => n.trim().toLowerCase() === name) : undefined);
  const letters = c.split("-")[0];
  // A code with a script or region, or of three letters: the language it is spelled another way for,
  // or, with three letters, the one it stands for. Never by its first two letters ("fil" isn't "fi").
  const alias = addonCodeAlias(c);
  if (alias && (c !== letters || letters.length !== 2)) return named(languageName(alias));
  if (letters.length !== 2) return named(addonLanguage(letters));
  // Two letters, with or without a region the table doesn't keep ("en-AU", "es-419").
  const twoAlias = addonCodeAlias(letters);
  const base = twoAlias?.length === 2 ? twoAlias : letters;
  const same = wanted.filter((n) => languageCode(n)?.slice(0, 2) === base);
  if (same.length === 1) return same[0];
  return named(addonLanguage(base));
}

/**
 * Wyzie's key for its OpenSubtitles source (its /sources list names each source by a key; this one's
 * ids are OpenSubtitles' legacy file ids). Its `machine` mark is on few of the machine translations
 * OpenSubtitles' own search marks.
 */
const OPENSUBTITLES_SOURCE = "charlie";

/**
 * A Subtitle Cat file as Wyzie names it: "<id>/<name>-<codes>.srt". "-orig" is the upload; two codes
 * ("-eng-nl") are the upload's language and the file's, one ("-ar") the file's, of an upload in English,
 * Subtitle Cat's usual one. A file in another language than its upload is Subtitle Cat's machine
 * translation of it (subtitlecat.ts marks them so), whether or not Wyzie's own `machine` mark is on it; one in the
 * upload's own language is the upload. Calibration (2026-11-20 UTC): an English upload's "-en" file was it line
 * for line (1,909 of 1,909), its "-ar" file a machine translation.
 */
const SUBTITLE_CAT_FILE = /^\d+\/.+?-((?:[a-z]{2,4}-)*[a-z]{2,4})\.srt$/i;

/** A language code Intl knows ("dl" of a "WEB-DL" in the name isn't one). */
const isLanguage = (code: string) => languageTitle(code).toLowerCase() !== code;

/** Whether Wyzie's result is one of Subtitle Cat's machine translations (SUBTITLE_CAT_FILE). */
export function subtitleCatTranslation(id: string): boolean {
  const tail = id.match(SUBTITLE_CAT_FILE)?.[1].toLowerCase().split("-");
  if (!tail || tail.at(-1) === "orig") return false;
  // The run of language codes the name ends with.
  let start = tail.length;
  while (start > 0 && isLanguage(tail[start - 1])) start--;
  const codes = tail.slice(start);
  if (codes.length === 0) return false;
  const [from, to] = codes.length > 1 ? [codes.at(-2)!, codes.at(-1)!] : ["en", codes[0]];
  return !sameLanguage(from, to);
}

/**
 * Wyzie's results for the episode (or film) in the wanted languages (SubSource-style names). With
 * `ownOpenSubtitles`, OpenSubtitles is listed from its own search, which holds the same files with
 * their marks, so Wyzie's copies of them are left out.
 */
export async function wyzieSubtitles(apiKey: string, request: StremioSubtitleRequest, languages: string[], ownOpenSubtitles = false): Promise<SubSourceSubtitle[]> {
  const codes = [...new Set(languages.map(isoCode).filter((c): c is string => Boolean(c)))];
  if (!apiKey || !request.imdbId || codes.length === 0) return [];
  const series = request.type === "series";
  if (series && (request.season === undefined || !request.episode)) return [];
  // Kept under each result's own code, and named for the wanted languages when read (named): which
  // of them a code stands for depends on what is wanted, and searches for the same codes share what
  // is kept. v3: ones kept from before carry a wanted language's name instead.
  const named = (kept: SubSourceSubtitle[]) =>
    kept.flatMap((subtitle) => {
      const language = wantedLanguageOf(subtitle.language ?? "", languages);
      return language ? [{ ...subtitle, language }] : [];
    });
  // v4: results kept from before don't carry Wyzie's own mark for machine translations.
  const key = cacheKey({ kind: "wyzie", v: 4, key: keyTag(apiKey), imdb: request.imdbId, season: request.season, episode: request.episode, codes, ownOpenSubtitles });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return named(cached);
  if ((spentUntil.get(keyTag(apiKey)) ?? 0) > Date.now()) return [];

  const query = new URLSearchParams({ id: request.imdbId, language: codes.join(","), source: "all", key: apiKey });
  if (series) {
    query.set("season", String(request.season));
    query.set("episode", String(request.episode));
  }
  let items: WyzieItem[] = [];
  count("api.wyzie");
  try {
    const response = await fetch(`${WYZIE_API}/search?${query}`, { signal: AbortSignal.timeout(10000) });
    noteKeyCall("wyzie", apiKey, response);
    noteBalance(apiKey, response);
    // 404 is its answer when none of its sources has anything.
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as unknown;
      items = Array.isArray(body) ? (body as WyzieItem[]) : [];
    }
  } catch (error) {
    // Never log the request URL: it carries the key.
    noteError("wyzie", error);
    console.error(`wyzie: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }

  const links: Array<[string, string]> = [];
  const out = items.flatMap((item): SubSourceSubtitle[] => {
    if (item.ai || item.id === undefined || item.id === null || !item.source || !item.url || !item.language) return [];
    if (ownOpenSubtitles && item.source === OPENSUBTITLES_SOURCE) return [];
    // Only its own download links: the token in them is what bills the key.
    if (!item.url.startsWith(`${WYZIE_API}/c/`)) return [];
    const language = item.language;
    const ref = wyzieRef(item.source, String(item.id));
    links.push([ref, item.url]);
    const names = [...new Set([item.release, item.fileName, ...(item.releases ?? [])].map((n) => n?.trim()).filter((n): n is string => Boolean(n)))];
    return [{
      subtitleId: 0,
      ref,
      source: "wyzie",
      movieId: 0,
      language,
      releaseInfo: names,
      commentary: null,
      files: 1,
      hearingImpaired: item.isHearingImpaired ?? null,
      // Either says so: Wyzie's own mark, or the file's name (subtitleCatTranslation).
      productionType: item.machine || subtitleCatTranslation(String(item.id)) ? "machine translated" : null,
      downloads: item.downloadCount ?? 0,
      rating: null,
      // Wyzie asked its sources for this episode; the matching still turns away a name giving another one.
      episodeTrusted: true
    }];
  });
  await Promise.all(links.map(([ref, url]) => writeJsonCache("wyzie-links", linkKey(apiKey, ref), url, LINK_KEPT_S)));
  await writeJsonCache("results", key, out);
  return named(out);
}

/** The notice a free key's downloads open with, naming Wyzie's site: never part of the subtitle. */
const NOTICE = /\bwyzie\.io\b/i;

/**
 * A downloaded file without Wyzie's own notice: an SRT or VTT cue, or an ASS event, that names its
 * site. Read byte for byte (latin1), so a file in any single-byte or UTF-8 encoding comes back as it was.
 */
export function withoutWyzieNotice(body: Buffer): Buffer {
  const text = body.toString("latin1");
  if (!NOTICE.test(text)) return body;
  if (/^\[Script Info\]/im.test(text)) {
    return Buffer.from(text.split(/(?<=\n)/).filter((line) => !(/^Dialogue\s*:/i.test(line) && NOTICE.test(line))).join(""), "latin1");
  }
  const parts = text.split(/(\r?\n[ \t]*\r?\n)/);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const block = parts[i];
    if (block.includes("-->") && NOTICE.test(block)) continue;
    kept.push(block, parts[i + 1] ?? "");
  }
  return Buffer.from(kept.join(""), "latin1");
}

/** One download of a result this key found, through the link its search gave. */
export async function downloadWyzie(ref: string, apiKey: string | undefined): Promise<Buffer> {
  if (!apiKey) throw new Error("no Wyzie key for this subtitle");
  const url = await readJsonCache<string>("wyzie-links", linkKey(apiKey, ref));
  if (!url) throw new Error(`no Wyzie link for subtitle ${ref}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  noteKeyCall("wyzie", apiKey, response, true);
  noteBalance(apiKey, response);
  // Never put the URL in the message: its token bills the key.
  if (!response.ok) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
  return withoutWyzieNotice(await readCapped(response, 10_000_000));
}

/** Whether Wyzie takes the key: its usage page answers for a working one and costs nothing. */
export async function wyzieAccepts(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${WYZIE_API}/usage?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15000) });
    return response.ok;
  } catch {
    return false;
  }
}
