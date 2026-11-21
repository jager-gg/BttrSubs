/**
 * A title's versions as AIOStreams' own Jellyfin server holds them. A player signed in to that
 * server has no install URL: it is shown the versions the server resolved for the title, kept under
 * the account and the title for a few minutes (its stream cache), whichever of the account's devices
 * asks. Asked with a sign-in of the account (aiostreamsAccount.ts), the server answers those same
 * versions, each with its file name, size and link, so the file such a player is playing is found
 * the way a listed stream is.
 *
 * The title is named by the server's own packed item id, which needs nothing stored: a mark, the
 * kind and id type, the media type, the id's number, the season and the episode. IMDb ids and Kitsu
 * ids are packed here, the two a subtitle request carries; a title under another id is left to the
 * install URLs.
 *
 * The server keeps a title's versions under the item id it was asked with, so the id has to be the
 * one the player's app used. An app files a title under one of two media types, so both are asked,
 * the likelier first.
 */
export interface JellyfinVersion {
  url: string;
  filename: string;
  size?: number;
}

const MARK_PACKED = 0xa1;
const KIND_MOVIE = 1;
const KIND_EPISODE = 4;
const ID_TYPE_IMDB = 1;
const ID_TYPE_KITSU = 4;
/** The server's media types a film or an episode can be filed as: its own, then anime. */
const MEDIA_TYPES: Record<string, number[]> = { movie: [1, 3], series: [2, 3] };
/** For a title known by its Kitsu id: anime first, then its own. */
const KITSU_MEDIA_TYPES: Record<string, number[]> = { movie: [3, 1], series: [3, 2] };
/** A Kitsu id names an episode by its number alone; the server files every such episode under season 1. */
const KITSU_SEASON = 1;
const NONE16 = 0xffff;

function packed(kindEpisode: boolean, idType: number, mediaType: number, id: number, season: number, episode: number): string {
  const buf = Buffer.alloc(16);
  buf[0] = MARK_PACKED;
  buf[1] = ((kindEpisode ? KIND_EPISODE : KIND_MOVIE) << 4) | idType;
  buf[2] = mediaType;
  buf.writeUIntBE(id, 3, 6);
  buf.writeUInt16BE(season, 9);
  buf.writeUInt16BE(episode, 11);
  return buf.toString("hex");
}

/** The item ids the server may know this title by, likeliest first; none for a title it can't be packed for. */
export function jellyfinItemIds(videoId: string, type: string): string[] {
  if (!MEDIA_TYPES[type]) return [];
  const imdb = /^tt(\d{1,14})(?::(\d{1,4}):(\d{1,4}))?$/.exec(videoId);
  if (imdb) {
    const episode = imdb[2] !== undefined;
    if (episode !== (type === "series")) return [];
    return MEDIA_TYPES[type].map((mediaType) => packed(episode, ID_TYPE_IMDB, mediaType, Number(imdb[1]), episode ? Number(imdb[2]) : NONE16, episode ? Number(imdb[3]) : NONE16));
  }
  const kitsu = /^kitsu:(\d{1,9})(?::(\d{1,4}))?$/.exec(videoId);
  if (kitsu) {
    const episode = kitsu[2] !== undefined;
    if (episode !== (type === "series")) return [];
    return KITSU_MEDIA_TYPES[type].map((mediaType) => packed(episode, ID_TYPE_KITSU, mediaType, Number(kitsu[1]), episode ? KITSU_SEASON : NONE16, episode ? Number(kitsu[2]) : NONE16));
  }
  return [];
}

/** What a request to the server carries: the sign-in's token, and this addon named as the client. */
export function jellyfinHeaders(token: string, viewer?: string): Record<string, string> {
  return {
    Authorization: `MediaBrowser Client="BttrSubs", Device="BttrSubs", DeviceId="bttrsubs", Version="1", Token="${token.replace(/["\\\s]/g, "")}"`,
    "Content-Type": "application/json",
    ...(viewer ? { "X-AIOStreams-User-IP": viewer } : {}),
  };
}

/** Where the account's Jellyfin server is, from its install URL. */
export function jellyfinBase(aiostreamsUrl: string): string {
  return `${new URL(aiostreamsUrl).origin}/jellyfin`;
}

/**
 * The versions the server holds for one item id, or undefined when it doesn't answer. Subtitles are
 * left out of the answer: asking for them would have the server ask this addon. Only the versions it
 * lists are asked for, since asking for every version can make it resolve the title again.
 */
export async function jellyfinVersions(aiostreamsUrl: string, token: string, itemId: string, timeoutMs: number, viewer?: string): Promise<JellyfinVersion[] | undefined> {
  const response = await fetch(`${jellyfinBase(aiostreamsUrl)}/Items/${itemId}/PlaybackInfo`, {
    method: "POST",
    headers: jellyfinHeaders(token, viewer),
    body: JSON.stringify({ SkipSubtitles: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { MediaSources?: Array<{ Path?: unknown; Size?: unknown; Protocol?: unknown; aiostreams?: { filename?: unknown } }> };
  const versions: JellyfinVersion[] = [];
  for (const source of body.MediaSources ?? []) {
    const filename = source.aiostreams?.filename;
    if (typeof source.Path !== "string" || !/^https?:\/\//.test(source.Path) || typeof filename !== "string" || !filename) continue;
    versions.push({ url: source.Path, filename, size: typeof source.Size === "number" && source.Size > 0 ? source.Size : undefined });
  }
  return versions;
}
