/**
 * What a Stremio subtitles request asks for. AIOStreams calls
 * /subtitles/<type>/<id>/<extra>.json, where id is "tt0000001" for a movie or
 * "tt0000001:1:2" for an episode, and extra is a query string with the
 * playing file's name, hash and size.
 */
import type { StremioSubtitleRequest } from "./types.js";

/** An IMDb id, optionally followed by ":season:episode". */
const IMDB_ID = /^(tt\d+)(?::(\d+):(\d+))?$/i;

/** A video id as players send one: an IMDb or Kitsu id, with its season and episode or its episode. */
export const VIDEO_ID = /^(?:tt\d{1,12}|kitsu:\d{1,12})(?::\d{1,6}){0,2}$/i;

/** The kinds of title a subtitle is asked for. */
export const VIDEO_TYPES: readonly string[] = ["movie", "series"];

/**
 * The "extra" path segment as key/value pairs ("filename=…&videoSize=…", with or without ".json").
 * It is given as the client wrote it, still encoded, and decoded here once: a "+" written as "%2B"
 * stays a plus and an "&" written as "%26" stays in its value.
 *
 * A client can also encode the whole segment, its "=" and "&" included. Decoded, such a segment no
 * longer says which "&" parts two values and which is inside a name, so a part that doesn't begin
 * with one of the keys a subtitle request carries is taken as the rest of the value before it.
 */
export function parseExtraArgs(raw = ""): Record<string, string> {
  const segment = raw.replace(/\.json$/, "");
  if (segment.includes("=")) return Object.fromEntries(new URLSearchParams(segment));
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return {};
  }
  const pairs: Array<[string, string]> = [];
  for (const part of decoded.split("&")) {
    const at = part.indexOf("=");
    const key = at < 0 ? "" : part.slice(0, at);
    if (EXTRA_KEYS.includes(key)) pairs.push([key, part.slice(at + 1)]);
    else if (pairs.length) pairs[pairs.length - 1][1] += `&${part}`;
  }
  return Object.fromEntries(pairs);
}

/** The keys a subtitle request's extra segment carries. */
const EXTRA_KEYS: readonly string[] = ["filename", "videoSize", "videoHash", "videoId", "videoID"];

/**
 * A request's extra segment as the client wrote it: the last segment of its path, still encoded. A
 * path parameter reaches a handler already decoded, and decoding that again turns the "+" of a file
 * name into a space and cuts the name at its "&", so the file is no longer known by its name.
 */
export function rawExtraSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The request as BttrSubs uses it. A video id in extra wins over the path's id. */
export function parseStremioSubtitleRequest(type: string, id: string, extra: Record<string, string> = {}): StremioSubtitleRequest {
  // A video id in extra counts only when it is one: the id goes on into requests to other services.
  const given = extra.videoId ?? extra.videoID;
  const videoId = given && VIDEO_ID.test(given) ? given : id;
  const [, imdb, season, episode] = IMDB_ID.exec(videoId) ?? IMDB_ID.exec(id) ?? [];
  return {
    type,
    id: videoId,
    filename: extra.filename,
    videoHash: extra.videoHash || undefined,
    videoSize: extra.videoSize || undefined,
    ...(imdb ? { imdbId: imdb.toLowerCase() } : {}),
    ...(season ? { season: Number(season), episode: Number(episode) } : {})
  };
}
