/**
 * aninzb (aninzb.moe): an index of anime releases on usenet that extracts the subtitle tracks of the
 * releases it has processed itself, behind an open API with no key. Releases from before it began
 * carry no tracks there.
 *
 * One request finds an episode's releases: by the show's AniDB id (from the anime lists this server
 * keeps) and the episode's number in that entry, else by the show's name with its season and
 * episode. Each release lists its tracks as files named "<release>.<track number>.<language>.<ass or
 * srt>": a language and no title. So a release gives a language's subtitle only when it has exactly
 * one track in it; with two or more there is no telling the full one from the signs', and none is
 * taken. A release named as the English dub alone, with one English track, gives the dub's captions.
 *
 * Its documentation: "there are no rate limits at the moment, but please be reasonable with request
 * volume". Every request goes through the gate in pace.ts at a pace set here.
 */
import { createHash } from "node:crypto";
import { animeEpisode } from "./animelists.js";
import { cacheKey, readJsonCache, writeJsonCache } from "./cache.js";
import { extractEpisodeMarkers } from "./matching.js";
import { readCapped } from "./net.js";
import { paced, type Pace } from "./pace.js";
import { sealUrl } from "./profile.js";
import { addonLanguage } from "./sources.js";
import { count, noteError } from "./stats.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

export const ANINZB_API = "https://api.aninzb.moe";
const HEADERS = { accept: "application/json", "user-agent": "BttrSubs" };

/**
 * Its pace here. It states no limit and asks for reasonable volume: an episode costs one request and
 * each track fetched one more, so half a request a second is ample, and little enough for a test API.
 */
export const aninzbPace: Pace = { perMinute: 30, inFlight: 2, pausedMs: 5 * 60_000, maxWaitMs: 5000 };

const EPISODE_TTL_S = 12 * 60 * 60;
/** Releases an episode's tracks are taken from at most, the playing one first. */
const MAX_RELEASES = 6;
const MAX_TRACK_BYTES = 8_000_000;

interface Item {
  source?: string;
  filename?: string;
  season?: number | null;
  episode?: number | null;
  size?: number | null;
  subtitles?: string[] | null;
}

/** A release that is the English dub alone, by its name: "(Dub)", "[Dub]", "Dub Only", "English Dub", and not a dual-audio one. */
const DUB_ONLY = /(?:\bdub only\b|\benglish dub\b|[([]\s*dub\s*[)\]])/i;
const DUAL = /\b(?:dual|multi)[\s._-]*audio\b|\bdual\b/i;

const bare = (name: string) => name.toLowerCase().replace(/\.(mkv|mp4|avi)$/, "");

/** A track file's language, by the code before its extension ("….3.eng.ass"); undefined when it has none. */
export function trackLanguage(url: string): string | undefined {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return undefined;
  }
  const code = /\.\d+\.([a-z]{2,3}(?:-[a-z]{2,4})?)\.(?:ass|ssa|srt|vtt)$/i.exec(name)?.[1];
  return code ? addonLanguage(code) : undefined;
}

/** The episode's releases, as one answer kept for a while; none when the service refuses, fails or isn't asked (pace.ts). */
async function episodeItems(request: StremioSubtitleRequest, showName: string | undefined): Promise<Item[]> {
  const placed = request.imdbId && request.season !== undefined && request.episode ? await animeEpisode(request.imdbId, request.season, request.episode).catch(() => undefined) : undefined;
  const query = placed
    ? `anidb=${placed.anidbId}&episode=${placed.episode}`
    : showName && request.season !== undefined && request.episode
      ? `name=${encodeURIComponent(showName)}&season=${request.season}&episode=${request.episode}`
      : undefined;
  if (!query) return [];
  const key = cacheKey({ kind: "aninzb", query });
  const kept = await readJsonCache<Item[]>("results", key);
  if (kept) return kept;
  try {
    const response = await paced("aninzb", aninzbPace, () => {
      count("api.aninzb");
      return fetch(`${ANINZB_API}/?${query}&source=release`, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { items?: Item[] };
    const items = (body.items ?? []).filter((item) => item.subtitles?.length);
    await writeJsonCache("results", key, items, EPISODE_TTL_S);
    return items;
  } catch (error) {
    if ((error as Error).name !== "HeldBack") {
      count("api.aninzb.fail");
      noteError("aninzb", error);
    }
    return [];
  }
}

/** Whether a release's name is this episode's, where it gives a season and episode at all: its own numbering there is sometimes wrong. */
function isEpisode(name: string, request: StremioSubtitleRequest): boolean {
  const markers = extractEpisodeMarkers(name);
  return markers.length === 0 || markers.some((m) => m.episode === request.episode || (request.absoluteEpisode !== undefined && m.episode === request.absoluteEpisode));
}

/** The subtitles aninzb holds for an episode in the languages asked, by their names here: one a language a release, where the release has just one. */
export async function aninzbSubtitles(request: StremioSubtitleRequest, showName: string | undefined, languages: string[]): Promise<SubSourceSubtitle[]> {
  if (request.type !== "series") return [];
  const playing = request.filename ? bare(request.filename) : undefined;
  const items = (await episodeItems(request, showName))
    .filter((item) => item.filename && isEpisode(item.filename, request))
    .sort((a, b) => Number(bare(b.filename as string) === playing) - Number(bare(a.filename as string) === playing))
    .slice(0, MAX_RELEASES);
  const out: SubSourceSubtitle[] = [];
  for (const item of items) {
    const name = item.filename as string;
    const byLanguage = new Map<string, string[]>();
    for (const url of item.subtitles ?? []) {
      const language = trackLanguage(url);
      if (language) byLanguage.set(language, [...(byLanguage.get(language) ?? []), url]);
    }
    for (const language of languages) {
      const tracks = byLanguage.get(language) ?? [];
      // Two tracks in one language are the full subtitles and the signs', with nothing to tell them by.
      if (tracks.length !== 1) continue;
      const url = tracks[0];
      const captions = language === "english" && DUB_ONLY.test(name) && !DUAL.test(name);
      out.push({
        subtitleId: 0,
        ref: `az${createHash("sha256").update(url).digest("hex").slice(0, 20)}`,
        source: "aninzb",
        // The track's address carries a long key of its own, so it travels sealed, as an added addon's does.
        sealedUrl: sealUrl(url),
        movieId: 0,
        language,
        releaseInfo: [name.replace(/\.(mkv|mp4)$/i, "")],
        commentary: captions ? "English Dub captions: the dub release's own subtitle track" : "The release's own subtitle track",
        ...(captions ? { productionType: "official" } : {}),
        hearingImpaired: false,
        episodeTrusted: true,
        files: 1
      });
    }
  }
  return out;
}

/** The words of an "az" subtitle, from the address its link carries sealed: only aninzb's own files, and only the one the ref names. */
export async function downloadAninzb(ref: string, url: string | undefined): Promise<Buffer> {
  if (!url || `az${createHash("sha256").update(url).digest("hex").slice(0, 20)}` !== ref) throw new Error(`no address for subtitle ${ref}`);
  if (!url.startsWith(`${ANINZB_API}/files/`)) throw new Error(`subtitle ${ref} isn't one of aninzb's files`);
  const response = await paced("aninzb", aninzbPace, () => {
    count("api.aninzb");
    return fetch(url, { headers: { "user-agent": HEADERS["user-agent"] }, signal: AbortSignal.timeout(15_000) });
  });
  if (!response.ok) throw new Error(`download of ${ref} failed: HTTP ${response.status}`);
  return readCapped(response, MAX_TRACK_BYTES);
}
