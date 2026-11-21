/**
 * Shapes shared across BttrSubs. SubSource's records are the common
 * currency: SubDL, OpenSubtitles and added addons are converted to them
 * (sources.ts), so one ranking works for every source.
 */

/** The addon's manifest id. */
export const ADDON_ID = "bttr.subs";

/** What a player asked subtitles for (see stremio.ts). */
export interface StremioSubtitleRequest {
  /** "movie" or "series". */
  type: string;
  /** Stremio's id for the video: "tt0000001", "tt0000001:1:2" or "kitsu:…". */
  id: string;
  imdbId?: string;
  season?: number;
  episode?: number;
  /** The playing file's name, when the player sends it. */
  filename?: string;
  /** The OpenSubtitles hash and size of the file, when the player sends them. */
  videoHash?: string;
  videoSize?: string;
  /** Episode number counted across all seasons, for packs numbered that way. */
  absoluteEpisode?: number;
}

/**
 * A show's seasons as the Anime Kitsu addon lists them (ids.ts): one entry per season, part of a
 * season or special, each with its own titles and the IMDb place of each of its episodes. Anime
 * uploaders name a later season by its own title ("Show: Second Arc - 03") and count its episodes
 * from 1, so the title says which season a bare number belongs to (matching.ts).
 */
export interface SeasonMap {
  /** The show's own name, as Cinemeta gives it. */
  show: string;
  entries: Array<{
    /** Its Kitsu id ("1000"): Anime Tosho finds an episode's releases by it (animetosho.ts). */
    kitsuId?: string;
    /** Its name and aliases, as the addon gives them. */
    titles: string[];
    /** Its own episode number -> [IMDb season, IMDb episode]. */
    episodes: Record<string, [number, number]>;
  }>;
}

/** One SubSource title record. Series have one per season, plus sometimes a season 0 for the whole show. */
export interface SubSourceMovie {
  movieId: number;
  title: string;
  type: "movie" | "tvseries" | string;
  imdbId?: string | null;
  season?: number | null;
  /** 0 when SubSource has no subtitles on the record at all. */
  subtitleCount?: number;
}

/** One subtitle, as SubSource lists it (the other sources fill in what they can). */
export interface SubSourceSubtitle {
  subtitleId: number;
  movieId: number;
  /** SubSource's language name, lower case: "english", "spanish". */
  language: string;

  // Where it comes from. SubSource's own subtitles go by subtitleId alone.
  /** Source-tagged id for other sources ("sd…", "os…"); SubSource uses subtitleId. */
  ref?: string;
  source?: "subsource" | "subdl" | "opensubtitles" | "addon" | "subtitlecat" | "thesubtitledb" | "gestdown" | "animetosho" | "wyzie" | "kept";
  /** An added addon's subtitle URL, sealed (see sealUrl): it may carry that addon's keys. */
  sealedUrl?: string;
  /** The source already searched for this episode, so the result is for it. */
  episodeTrusted?: boolean;
  /** The source matched it to the playing file's hash (the player's videoHash): it was made for this very file. */
  hashMatch?: boolean;
  /** Its own id at the addon that listed it, when the addon gave one (OpenSubtitles' id, for Stremio's own addon). */
  addonId?: string;
  /** The season of the SubSource record it was listed under (0: the whole series). */
  recordSeason?: number;
  /**
   * Listed under a SubSource record found by the season's own name, not by the show's IMDb id (see
   * namedRecords): "film" when that record is a film's. Its names alone say which episode it is for.
   */
  namedRecord?: "series" | "film";

  // What the uploader wrote: release names and notes are what matching reads.
  releaseInfo?: string[] | null;
  commentary?: string | null;
  productionType?: string | null;
  releaseType?: string | null;
  contributors?: Array<{ id?: number; displayname?: string | null }> | null;
  link?: string | null;

  /** How many files the download holds: more than one means a pack. */
  files?: number | null;
  /** The names of the files its pack holds, as the source lists them without a download (SubDL's unpack_files). */
  packFiles?: string[];
  hearingImpaired?: boolean | null;

  // Popularity, for breaking ties.
  downloads?: number | null;
  rating?: { good?: number | null; bad?: number | null; total?: number | null } | null;
  createdAt?: string | null;
}

/** A subtitle that fits the request, with what the ranking needs (see matching.ts). */
export interface RankedSubtitle extends SubSourceSubtitle {
  /** 2 for "Eng Dubbed Version", 1 for other dub tags (or any subtitle, when no dub tag is required). */
  dubtitleScore: 1 | 2;
  /** Its names mark this exact episode, not just the season. */
  episodeExact: boolean;
  /** Files inside are numbered by absolute episode (e.g. a pack named "Ep1-100"). */
  absoluteNumbered?: boolean;
  /**
   * The episode's number within the season or part its name gives, when that differs from the IMDb
   * episode ("Show: Third Arc Part 2 - 01" is IMDb's season 3 episode 12): its file in a pack is found by it.
   */
  pick?: number;
  /**
   * The pack's own number for the file to take, when that is tried in place of the episode's (a
   * fallback for a pack that numbers its files its own way, see PACK_NEIGHBOURS in app.ts).
   */
  packEpisode?: number;
  /** Fit of its release names to the playing filename, see releaseMatch. */
  releaseMatch?: number;
  /** Whether its release names give the playing file's cut: 1 the same, -1 another, 0 either names none (matching.ts editionFit). */
  editionFit?: number;
  /** Translation quality, see quality.ts: 3 official, 2 human, 1 unknown. */
  quality?: 1 | 2 | 3;
  /** A machine or AI translation, kept because the link allows them: ranked below every other. */
  machine?: boolean;
  /** From a source that searched for this episode, but its name gives only another season: ranked below one naming this season. */
  otherSeason?: boolean;
}
