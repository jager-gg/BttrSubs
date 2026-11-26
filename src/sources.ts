/**
 * Subtitle sources besides SubSource. Their results are converted to the
 * same shape as SubSource's, so dub/CC detection, quality ranking and sync
 * treat every source alike. Keys only ever go to their own API, from here,
 * never into URLs handed out or into logs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { config } from "./config.js";
import { fetchPublic, publicHttpsUrl, readCapped } from "./net.js";
import { sealUrl, type Addon } from "./profile.js";
import { count, noteError, noteKeyCall } from "./stats.js";
import { languageCode, languageName } from "./langcodes.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

const SUBDL_API = "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DOWNLOAD = "https://dl.subdl.com/subtitle";
const OPENSUBTITLES_V3_PLUS = "https://opensubtitles.stremio.homes";

/** A short id per source, used in download URLs: "ss123", "sd3734901-8656630", "osar-11816405". */
export function refOf(subtitle: SubSourceSubtitle): string {
  return subtitle.ref ?? `ss${subtitle.subtitleId}`;
}

// ---------- SubDL ----------

interface SubdlItem {
  release_name?: string;
  name?: string;
  lang?: string;
  language?: string;
  author?: string;
  url?: string;
  season?: number | null;
  episode?: number | null;
  hi?: boolean;
  comment?: string | null;
  releases?: string[];
  episode_from?: number | null;
  episode_end?: number | null;
  full_season?: boolean;
  /** With unpack=1: the files a pack holds, each by name (its season and episode as SubDL reads them aren't used). */
  unpack_files?: Array<{ name?: string | null }> | null;
}

/**
 * SubDL's own codes for the languages it keeps by region or script, as the codes used here. Its other
 * codes are a language's two letters (addonLanguage reads those, "PT" and "ZH" among them); one naming
 * two languages ("BG_EN") goes by its first.
 */
const SUBDL_CODES: Record<string, string> = { BR_PT: "pt-br", ZH_BG: "zh-tw" };

/** SubDL subtitles for the episode (or film) in the given languages (SubSource-style names). */
const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

export async function subdlSubtitles(apiKey: string, request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  // A two-letter code that names no language (OpenSubtitles' own, for a regional kind) isn't one SubDL
  // knows: sent, it answers every language of other titles.
  const known = (code: string) => code.length !== 2 || LANGUAGE_NAMES.of(code) !== code;
  const codes = [...new Set(languages.map((l) => languageCode(l)).filter((c): c is string => Boolean(c) && known(c as string)).map((c) => c.toUpperCase()))];
  if (!apiKey || !request.imdbId || codes.length === 0) return [];
  // v2: lists kept from before hold only the subtitles SubDL marks as for the hearing impaired.
  const key = cacheKey({ kind: "subdl", v: 2, imdb: request.imdbId, season: request.season, episode: request.episode, codes, unpack: true });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;

  const query = new URLSearchParams({
    api_key: apiKey,
    imdb_id: request.imdbId,
    type: request.type === "series" ? "tv" : "movie",
    languages: codes.join(","),
    subs_per_page: "30",
    // No `hi`: with it SubDL lists only the subtitles marked as for the hearing impaired. Every row
    // carries that mark either way.
    releases: "1",
    comment: "1",
    // Each pack's files by name, so one that lacks the episode is known before it is downloaded.
    unpack: "1"
  });
  if (request.type === "series" && request.season) query.set("season_number", String(request.season));
  if (request.type === "series" && request.episode) query.set("episode_number", String(request.episode));

  let items: SubdlItem[] = [];
  count("api.subdl");
  try {
    const response = await fetch(`${SUBDL_API}?${query}`, { signal: AbortSignal.timeout(10000) });
    noteKeyCall("subdl", apiKey, response);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { status?: boolean; subtitles?: SubdlItem[] };
    items = body.status ? body.subtitles ?? [] : [];
  } catch (error) {
    // Never log the request URL: it carries the key.
    noteError("subdl", error);
    console.error(`subdl: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }

  const out = items.flatMap((item): SubSourceSubtitle[] => {
    const id = item.url?.match(/\/subtitle\/([\w-]+)\.zip/)?.[1];
    const code = (item.language ?? item.lang ?? "").toUpperCase();
    const lang = addonLanguage(SUBDL_CODES[code] ?? code);
    if (!id || !lang) return [];
    const span = item.episode_from && item.episode_end ? item.episode_end - item.episode_from + 1 : undefined;
    return [{
      subtitleId: 0,
      ref: `sd${id}`,
      source: "subdl",
      movieId: 0,
      language: lang,
      releaseInfo: [item.release_name ?? item.name ?? "", ...(item.releases ?? [])].filter(Boolean),
      commentary: item.comment ?? null,
      // A season pack has more than one file; the matching uses that to look inside it.
      files: item.full_season ? Math.max(2, span ?? 2) : 1,
      ...(item.full_season && item.unpack_files?.length ? { packFiles: item.unpack_files.map((f) => f.name ?? "").filter(Boolean) } : {}),
      hearingImpaired: item.hi ?? null,
      downloads: 0,
      rating: null,
      contributors: item.author ? [{ displayname: item.author }] : null,
      // SubDL asked for this episode already: a single file it returns is for it.
      episodeTrusted: !item.full_season && (request.type !== "series" || item.episode === request.episode || item.episode == null)
    }];
  });
  await writeJsonCache("results", key, out);
  return out;
}

export function subdlDownloadUrl(ref: string, apiKey: string): string {
  return `${SUBDL_DOWNLOAD}/${ref.slice(2)}.zip?api_key=${encodeURIComponent(apiKey)}`;
}

// ---------- OpenSubtitles V3+ ----------

interface OpenSubtitlesItem {
  sub_id?: number;
  ai_translated?: boolean;
  from_trusted?: boolean;
  lang_code?: string;
  title?: string;
}

/** Whether a source's hash for a subtitle is the playing file's own. */
function sameHash(request: StremioSubtitleRequest, hash: unknown): boolean {
  return Boolean(request.videoHash) && typeof hash === "string" && hash.toLowerCase() === request.videoHash?.toLowerCase();
}

const HEARING_IMPAIRED = /\[cc\]|\bsdh\b|\bcc\b|\[hi\]|\bhi\b|closed.?caption/i;

/**
 * OpenSubtitles V3+ (no key): already per episode, with release names and an AI-translated flag. It
 * matches nothing by the file's hash, so it isn't asked with one: Stremio's own addon is
 * (openSubtitlesByHash). Calibration (a file whose hash OpenSubtitles holds 6 uploads for): the
 * official addon marked those 6, V3+ none, asked in two of their languages.
 */
async function openSubtitlesV3Plus(request: StremioSubtitleRequest, languages: string[], allowMachine: boolean): Promise<SubSourceSubtitle[]> {
  const codes = [...new Set(languages.map((l) => languageCode(l)).filter((c): c is string => Boolean(c)))].slice(0, 10);
  if (!request.imdbId || codes.length === 0) return [];
  const id = request.type === "series" && request.season && request.episode ? `${request.imdbId}:${request.season}:${request.episode}` : request.imdbId;
  const key = cacheKey({ kind: "opensubtitles-v3plus", id, codes, allowMachine });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;

  const config = `${encodeURIComponent(codes.join("|"))}/${encodeURIComponent(`ai-translated=${allowMachine}|from=all|auto-adjustment=false`)}`;
  let items: OpenSubtitlesItem[] = [];
  count("api.opensubtitles");
  try {
    const response = await fetch(`${OPENSUBTITLES_V3_PLUS}/${config}/subtitles/${request.type === "series" ? "series" : "movie"}/${id}.json`, {
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    items = ((await response.json()) as { subtitles?: OpenSubtitlesItem[] }).subtitles ?? [];
  } catch (error) {
    noteError("opensubtitles", error);
    console.error(`opensubtitles: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }

  const out = items.flatMap((item): SubSourceSubtitle[] => {
    const lang = item.lang_code ? languageName(item.lang_code) : undefined;
    if (!item.sub_id || !item.lang_code || !lang) return [];
    const title = item.title ?? "";
    return [{
      subtitleId: 0,
      ref: `os${item.lang_code}-${item.sub_id}`,
      source: "opensubtitles",
      movieId: 0,
      language: lang,
      releaseInfo: [title],
      commentary: null,
      files: 1,
      hearingImpaired: HEARING_IMPAIRED.test(title),
      // Only the AI flag and the trusted-uploader flag say anything about the translation.
      productionType: item.ai_translated ? "machine translated" : item.from_trusted ? "translated" : null,
      downloads: 0,
      rating: null,
      episodeTrusted: true
    }];
  });
  await writeJsonCache("results", key, out);
  return out;
}

// ---------- OpenSubtitles' own search ----------

const OPENSUBTITLES_API = "https://api.opensubtitles.com/api/v1";
/** Who asks, as OpenSubtitles requires of every request: the app's name and version. */
const OPENSUBTITLES_AGENT = `BttrSubs v${(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version}`;
/** Pages of one search read at most: well past what one episode holds in a few languages. */
const OPENSUBTITLES_API_PAGES = 3;

interface OpenSubtitlesApiItem {
  attributes?: {
    language?: string | null;
    legacy_subtitle_id?: number | null;
    release?: string | null;
    comments?: string | null;
    hearing_impaired?: boolean | null;
    foreign_parts_only?: boolean | null;
    ai_translated?: boolean | null;
    machine_translated?: boolean | null;
    from_trusted?: boolean | null;
    files?: Array<{ file_name?: string | null }> | null;
  };
}

/**
 * OpenSubtitles' own search (OPENSUBTITLES_API_KEY, one for the server): every subtitle it holds for the
 * episode in the wanted languages, with its marks for machine and AI translations, which V3+ doesn't
 * carry. Searching has no daily limit. Each subtitle is downloaded through V3+ by its legacy id, as V3+'s
 * own results are, so the API's download quota is never used; one with no legacy id (uploaded to the
 * new site only) can't be, and is left out, as are subtitles for the foreign parts only. Undefined when
 * there is no key or the search fails, so V3+ lists instead.
 */
async function openSubtitlesOwnSearch(request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[] | undefined> {
  const apiKey = config.openSubtitlesApiKey;
  const codes = [...new Set(languages.map((l) => languageCode(l)).filter((c): c is string => Boolean(c)))].sort();
  const imdb = request.imdbId?.match(/^tt(\d+)$/)?.[1];
  if (!apiKey || !imdb || codes.length === 0) return undefined;
  const episode = request.type === "series" && request.season !== undefined && request.episode ? { season: request.season, episode: request.episode } : undefined;
  const key = cacheKey({ kind: "opensubtitles-api", imdb, episode, codes });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached;

  // Its parameters in alphabetical order, lower case, ids without "tt" or leading zeros: the form it
  // answers without a redirect. Machine and AI translations are asked for and marked, so the filters
  // decide (allowMachine), not the search.
  const query = (page: number) => {
    const params: Record<string, string | number> = { ai_translated: "include", languages: codes.join(","), machine_translated: "include", page };
    if (episode) Object.assign(params, { parent_imdb_id: Number(imdb), season_number: episode.season, episode_number: episode.episode });
    else params.imdb_id = Number(imdb);
    return Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
  };
  const items: OpenSubtitlesApiItem[] = [];
  try {
    for (let page = 1, pages = 1; page <= Math.min(pages, OPENSUBTITLES_API_PAGES); page++) {
      count("api.opensubtitles.own");
      const response = await fetch(`${OPENSUBTITLES_API}/subtitles?${query(page)}`, {
        headers: { "Api-Key": apiKey, "User-Agent": OPENSUBTITLES_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { data?: OpenSubtitlesApiItem[]; total_pages?: number };
      items.push(...(body.data ?? []));
      pages = body.total_pages ?? 1;
    }
  } catch (error) {
    // The key is in a header, never in the message.
    noteError("opensubtitles", error);
    console.error(`opensubtitles: its own search failed, V3+ lists instead: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }

  const out = items.flatMap((item): SubSourceSubtitle[] => {
    const a = item.attributes ?? {};
    const code = a.language?.toLowerCase();
    const lang = code ? languageName(code) : undefined;
    if (!a.legacy_subtitle_id || !code || !lang || a.foreign_parts_only) return [];
    const names = [...new Set([a.release, ...(a.files ?? []).map((f) => f.file_name)].map((n) => n?.trim()).filter((n): n is string => Boolean(n)))];
    return [{
      subtitleId: 0,
      ref: `os${code}-${a.legacy_subtitle_id}`,
      source: "opensubtitles",
      movieId: 0,
      language: lang,
      releaseInfo: names,
      commentary: a.comments?.trim() || null,
      files: 1,
      hearingImpaired: a.hearing_impaired ?? HEARING_IMPAIRED.test(names.join(" ")),
      productionType: a.machine_translated || a.ai_translated ? "machine translated" : a.from_trusted ? "translated" : null,
      downloads: 0,
      rating: null,
      episodeTrusted: true
    }];
  });
  await writeJsonCache("results", key, out);
  return out;
}

/** Whether OpenSubtitles is listed from its own search here (a key is set): its results then hold every subtitle V3+ and Wyzie relay from it. */
export function openSubtitlesOwnSearchOn(): boolean {
  return Boolean(config.openSubtitlesApiKey);
}

/** OpenSubtitles for the episode: from its own search when a key is set and it answers, else from V3+. */
export async function openSubtitles(request: StremioSubtitleRequest, languages: string[], allowMachine: boolean): Promise<SubSourceSubtitle[]> {
  return (await openSubtitlesOwnSearch(request, languages)) ?? openSubtitlesV3Plus(request, languages, allowMachine);
}

/**
 * A list without the uploads it holds twice. TheSubtitleDB carries OpenSubtitles' uploads under
 * OpenSubtitles' own ids, so a row of its with the id and language of an OpenSubtitles row in the
 * list is that same upload: the OpenSubtitles row stays, with its flags, and the copy is left out, so
 * it takes no place among a track's fallbacks.
 * Calibration (2,412 kept answers): 1,671 of 3,062 OpenSubtitles ids are also TheSubtitleDB's, every
 * one in the same language; the release names are equal in 1,619, and in the rest one is empty or a
 * part of the other.
 */
export function withoutCopies(subtitles: SubSourceSubtitle[]): SubSourceSubtitle[] {
  const listed = new Set<string>();
  for (const sub of subtitles) {
    const id = sub.source === "thesubtitledb" ? undefined : sub.ref?.match(/^os[a-z-]+-(\d+)$/)?.[1];
    if (id) listed.add(`${id}|${sub.language.toLowerCase()}`);
  }
  if (listed.size === 0) return subtitles;
  return subtitles.filter((sub) => {
    const id = sub.source === "thesubtitledb" ? sub.ref?.match(/^tb(\d+)$/)?.[1] : undefined;
    return !id || !listed.has(`${id}|${sub.language.toLowerCase()}`);
  });
}

export function openSubtitlesDownloadUrl(ref: string): string | undefined {
  const match = ref.match(/^os([a-z-]+)-(\d+)$/);
  return match ? `${OPENSUBTITLES_V3_PLUS}/sub.vtt/?lang_code=${match[1]}&sub_id=${match[2]}` : undefined;
}

/**
 * OpenSubtitles V3+ serves every subtitle as VTT with a promo cue first and a
 * second "WEBVTT" line after it. When the original SRT starts with a byte
 * order mark, its converter also turns every line into a NOTE comment, which
 * players hide. This puts the file back the way it was uploaded.
 */
export function repairOpenSubtitlesVtt(text: string): string {
  let lines = text.replace(/\r\n?/g, "\n").replace(/﻿/g, "").split("\n");
  // Lines commented out by the broken conversion: the timings themselves are inside NOTE lines.
  if (lines.some((l) => /^NOTE .*-->/.test(l))) lines = lines.map((l) => l.replace(/^NOTE ?/, ""));
  const blocks = lines
    .join("\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b && !/^WEBVTT\b/.test(b) && !/OpenSubtitles v3\+/i.test(b));
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

// ---------- other Stremio subtitle addons ----------

interface AddonItem {
  id?: string | number;
  url?: string;
  lang?: string;
  label?: string;
  title?: string;
  /** The release the subtitle was made for, where an OpenSubtitles-backed addon gives it instead of a label. */
  movieReleaseName?: string;
  /** The uploaded file's name, which often names the release too. */
  subtitleFileName?: string;
  /** How Stremio's OpenSubtitles addon matched it: "h" by the request's file hash, "i" by the IMDb id. */
  m?: string;
  /** The hash of the video it was matched to, where an OpenSubtitles-backed addon gives one. */
  moviehash?: string;
}

/** Stremio's own OpenSubtitles addon, which marks the subtitles it matched to the file's hash. */
export const OFFICIAL_OPENSUBTITLES: Addon = { name: "OpenSubtitles v3", url: "https://opensubtitles-v3.strem.io/manifest.json" };

/**
 * Codes addons use for a language the table (langcodes.ts) keeps only by region or script: plain and
 * ISO 639-2 Portuguese and Chinese, OpenSubtitles' own Brazilian Portuguese ("pob") and Chinese
 * ("zht" traditional, "zhe" bilingual), the "chs"/"cht" and Hans/Hant spellings, Filipino, which
 * the table keeps as Tagalog, and Norwegian Bokmal, which it keeps as Norwegian. Chinese with no script given is simplified, as OpenSubtitles' "chi" is.
 */
const ADDON_CODES: Record<string, string> = {
  pt: "pt-pt",
  por: "pt-pt",
  pob: "pt-br",
  pb: "pt-br",
  zh: "zh-cn",
  chi: "zh-cn",
  zho: "zh-cn",
  chs: "zh-cn",
  "zh-hans": "zh-cn",
  cht: "zh-tw",
  zht: "zh-tw",
  "zh-hant": "zh-tw",
  "zh-hk": "zh-tw",
  zhe: "ze",
  fil: "tl",
  nb: "no"
};

/** The code used here for one an addon spells another way ("zh-Hant" -> "zh-tw", "nb" -> "no"), or none. */
export function addonCodeAlias(code: string): string | undefined {
  return ADDON_CODES[code.trim().toLowerCase().replace(/_/g, "-")];
}

/** "spa", "es", "Spanish", "pt-br", "pob", "chi" -> the language name used here ("spanish"), or undefined. */
export function addonLanguage(code: string): string | undefined {
  const written = code.trim().toLowerCase().replace(/_/g, "-");
  const c = ADDON_CODES[written] ?? written;
  if (!c) return undefined;
  const direct = languageName(c) ?? (languageCode(c) ? c : undefined);
  if (direct) return direct;
  try {
    // Three-letter codes ("ara", "eng") canonicalise to the two-letter ones the table uses.
    const short = Intl.getCanonicalLocales(c)[0]?.toLowerCase();
    return short ? languageName(short) ?? languageName(short.split("-")[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** Its base URL (no /manifest.json), for /subtitles requests. */
function addonBase(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json$/, "");
}

/**
 * Subtitles from an added addon, in the wanted languages. It's asked the way
 * a player would ask it, with the filename (and hash, when the player sent
 * one) so it can match the file. Its subtitle URLs are sealed before they're
 * kept anywhere: an addon's links can carry its keys.
 */
export async function addonSubtitles(addon: Addon, request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (!request.imdbId) return [];
  const wanted = new Set(languages.map((l) => l.toLowerCase()));
  const id = request.type === "series" && request.season && request.episode ? `${request.imdbId}:${request.season}:${request.episode}` : request.imdbId;
  const extra = new URLSearchParams();
  if (request.filename) extra.set("filename", request.filename);
  if (request.videoHash) extra.set("videoHash", request.videoHash);
  if (request.videoSize) extra.set("videoSize", request.videoSize);
  const key = cacheKey({ kind: "addon", url: addon.url, id, extra: extra.toString() });
  const cached = await readJsonCache<SubSourceSubtitle[]>("results", key);
  if (cached) return cached.filter((s) => wanted.has(s.language));

  const type = request.type === "series" ? "series" : "movie";
  const path = `/subtitles/${type}/${encodeURIComponent(id)}${extra.size ? `/${extra.toString()}` : ""}.json`;
  let items: AddonItem[] = [];
  count("api.addons");
  try {
    const response = await fetchPublic(`${addonBase(addon.url)}${path}`, 10000, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = JSON.parse((await readCapped(response, 2_000_000)).toString("utf8")) as { subtitles?: AddonItem[] };
    items = Array.isArray(body.subtitles) ? body.subtitles : [];
  } catch (error) {
    // Never log the URL: it can carry the addon's keys.
    noteError("addons", error);
    console.error(`addon ${addon.name}: search failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }

  const out = items.slice(0, 200).flatMap((item): SubSourceSubtitle[] => {
    const lang = item.lang ? addonLanguage(item.lang) : undefined;
    if (!item.url || !lang || !publicHttpsUrl(item.url)) return [];
    const text = (t: unknown): t is string => typeof t === "string" && t.trim() !== "";
    const title = [item.label, item.title].filter(text).join(" ");
    // Without its release names, a row would rank above named ones that fit the file worse.
    const names = [...new Set([title, item.movieReleaseName, item.subtitleFileName].filter(text).map((t) => t.trim()))];
    return [{
      subtitleId: 0,
      ref: `cx${createHash("sha256").update(item.url).digest("hex").slice(0, 20)}`,
      source: "addon",
      sealedUrl: sealUrl(item.url),
      movieId: 0,
      language: lang,
      releaseInfo: names,
      commentary: null,
      files: 1,
      hearingImpaired: HEARING_IMPAIRED.test(names.join(" ")),
      downloads: 0,
      rating: null,
      // No addon name in here: the dub check reads every name, and an addon called "… Dub …" isn't a tag.
      // The addon was asked for this episode.
      episodeTrusted: true,
      ...(item.id !== undefined && item.id !== null && String(item.id) !== "" ? { addonId: String(item.id) } : {}),
      ...(request.videoHash && (item.m === "h" || sameHash(request, item.moviehash)) ? { hashMatch: true } : {})
    }];
  });
  await writeJsonCache("results", key, out);
  return out.filter((s) => wanted.has(s.language));
}

/**
 * The subtitles Stremio's own OpenSubtitles addon matched to the playing file's hash, when the player
 * sent one: only those, since every other row it gives is OpenSubtitles V3+'s too.
 */
export async function openSubtitlesByHash(request: StremioSubtitleRequest, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (!request.videoHash) return [];
  return (await addonSubtitles(OFFICIAL_OPENSUBTITLES, request, languages)).filter((s) => s.hashMatch);
}

/**
 * OpenSubtitles V3+'s list with the hash matches folded in. A match V3+ lists too (the same
 * OpenSubtitles id) is V3+'s row, marked: V3+ says whether it's a machine translation and whether its
 * uploader is trusted, which Stremio's addon doesn't. A match V3+ doesn't list is added as it is.
 * Calibration (Stremio's addon against V3+, the same episode): all 6 of a file's hash matches were in
 * V3+ with their flags; of 4 subtitles only the official addon listed, 3 were a person's translation.
 */
export function withHashMatches(listed: SubSourceSubtitle[], byHash: SubSourceSubtitle[]): SubSourceSubtitle[] {
  const matched = new Set(byHash.map((s) => s.addonId).filter((id): id is string => Boolean(id)));
  const idOf = (s: SubSourceSubtitle) => /^os[a-z-]+-(\d+)$/.exec(s.ref ?? "")?.[1];
  const twinned = new Set<string>();
  const marked = listed.map((s) => {
    const id = idOf(s);
    if (!id || !matched.has(id)) return s;
    twinned.add(id);
    return { ...s, hashMatch: true };
  });
  return [...marked, ...byHash.filter((s) => !s.addonId || !twinned.has(s.addonId))];
}
