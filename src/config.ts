/**
 * Settings from the environment (.env in development, compose's env_file in Docker). Some of them can
 * also be changed on the dashboard, without a restart: settings.ts keeps those in the cache volume and
 * writes them over these, and .env stays the default they go back to.
 */
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const env = process.env;

/** A number from the environment; the fallback when it's unset or not a number. */
function envNumber(name: string, fallback: number): number {
  return parseNumber(env[name]) ?? fallback;
}

/** A number, or undefined when the text is empty or isn't one. */
export function parseNumber(raw: string | undefined): number | undefined {
  const value = Number(raw || NaN);
  return Number.isFinite(value) ? value : undefined;
}

/** A comma-separated list of origins, lower case, without trailing slashes. */
export function parseOrigins(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Public AIOStreams instances, as listed in the community guide (rentry.co/community-jf-guide). */
export const PUBLIC_AIOSTREAMS = [
  "https://aiostreams.viren070.me",
  "https://aiostreams.fortheweak.cloud",
  "https://aiostreamsfortheweebsstable.midnightignite.me",
  "https://aio.atbphosting.com"
];

/** Where OWN_AIOSTREAMS is reached when neither AIOSTREAMS_BASE nor OWN_AIOSTREAMS says. */
export const DEFAULT_AIOSTREAMS_BASE = "http://aiostreams:3000";

/** A switch as .env writes one: on (true, yes, 1) or off (false, no, 0); undefined when unset or neither. */
export function parseSwitch(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (text && ["on", "true", "yes", "1"].includes(text)) return true;
  if (text && ["off", "false", "no", "0"].includes(text)) return false;
  return undefined;
}

/** The IANA name Intl uses for a time zone, or undefined when Intl doesn't know it. */
export function parseTimeZone(value: string | undefined): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: value || "UTC" }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** The settings' built-in values, used when .env leaves them out. */
export const DEFAULTS = {
  timeZone: "UTC",
  dailyReadGb: 20,
  resultCacheTtlSeconds: 6 * 60 * 60,
  allowedAiostreams: PUBLIC_AIOSTREAMS,
  updateCheck: true,
  listBudgetMs: 8000,
  maxPerLanguage: 3,
  animeTitlesDataset: true,
  logDays: 7,
  logMaxMb: 50
};

/** The range each number is kept in: .env's is brought into it, the dashboard refuses one outside it. */
export const RANGES = {
  listBudgetMs: [2000, 20_000],
  maxPerLanguage: [1, 3],
  logDays: [0, 90],
  logMaxMb: [1, 10_000]
} as const;

/** A number brought into a range; undefined stays undefined. */
function within(value: number | undefined, [low, high]: readonly [number, number], whole = false): number | undefined {
  return value === undefined ? undefined : Math.min(high, Math.max(low, whole ? Math.floor(value) : value));
}

/** A comma-separated list of hosts, lower case. */
function parseHosts(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** An AniDB client's name as AniDB registers one (lower-case letters and digits), and its version (a whole number). */
export const ANIDB_CLIENT = /^[a-z0-9]{1,32}$/;
export const ANIDB_CLIENT_VER = /^[1-9]\d{0,5}$/;

/**
 * What .env says for each setting the dashboard can change: undefined where it's unset (or, for a
 * number or a time zone, not one), so the default applies.
 */
export const fromEnv = {
  addonPassword: env.ADDON_PASSWORD || undefined,
  allowedAiostreams: env.ALLOWED_AIOSTREAMS ? parseOrigins(env.ALLOWED_AIOSTREAMS) : undefined,
  ownAiostreams: parseOrigins(env.OWN_AIOSTREAMS)[0],
  aiostreamsBase: env.AIOSTREAMS_BASE ? env.AIOSTREAMS_BASE.replace(/\/+$/, "") : undefined,
  timeZone: env.TIME_ZONE ? parseTimeZone(env.TIME_ZONE) : undefined,
  dailyReadGb: parseNumber(env.DAILY_READ_GB),
  resultCacheTtlSeconds: parseNumber(env.RESULT_CACHE_TTL_SECONDS),
  updateCheck: parseSwitch(env.UPDATE_CHECK),
  listBudgetMs: within(parseNumber(env.LIST_BUDGET_MS), RANGES.listBudgetMs, true),
  maxPerLanguage: within(parseNumber(env.MAX_SUBTITLES_PER_LANGUAGE), RANGES.maxPerLanguage, true),
  privateStreamHosts: env.PRIVATE_STREAM_HOSTS ? parseHosts(env.PRIVATE_STREAM_HOSTS) : undefined,
  anidbClient: ANIDB_CLIENT.test(env.ANIDB_CLIENT ?? "") ? env.ANIDB_CLIENT : undefined,
  anidbClientVer: ANIDB_CLIENT_VER.test(env.ANIDB_CLIENT_VER ?? "") ? Number(env.ANIDB_CLIENT_VER) : undefined,
  animeTitlesDataset: parseSwitch(env.ANIME_TITLES_DATASET),
  logDays: within(parseNumber(env.LOG_DAYS), RANGES.logDays, true),
  logMaxMb: within(parseNumber(env.LOG_MAX_MB), RANGES.logMaxMb),
  openSubtitlesApiKey: env.OPENSUBTITLES_API_KEY?.trim() || undefined
};

/** Which of the settings that never change live are set in .env: true or false, never their values. */
export const ENV_ONLY = ["CONFIG_SECRET", "ADMIN_PASSWORD", "PUBLIC_BASE_URL", "CACHE_DIR", "CAPTIONS_DIR", "PORT"] as const;
export function envIsSet(name: (typeof ENV_ONLY)[number]): boolean {
  return Boolean(env[name]);
}

export const config = {
  port: envNumber("PORT", 7000),
  /** The clock the dashboard shows times on (TIME_ZONE, an IANA name). The days it counts stay UTC days, as SubDL's do. */
  timeZone: fromEnv.timeZone ?? DEFAULTS.timeZone,
  /** The public address of this addon (no trailing slash): manifest and download URLs use it. */
  publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/+$/, ""),
  /** Where the cache lives, relative to the working directory. */
  cacheDir: env.CACHE_DIR ?? ".cache",
  /** Where subtitles kept on this server are (CAPTIONS_DIR), relative to the working directory. See kept.ts. */
  captionsDir: env.CAPTIONS_DIR ?? "captions",
  /** Most GB read from playing files in a day (UTC), over everyone; 0 for no limit. See reads.ts. */
  dailyReadGb: Math.max(0, fromEnv.dailyReadGb ?? DEFAULTS.dailyReadGb),
  get dailyReadBytes(): number {
    return this.dailyReadGb * 1e9;
  },
  /** How long search results are kept, in seconds (6 hours). */
  resultCacheTtlSeconds: fromEnv.resultCacheTtlSeconds ?? DEFAULTS.resultCacheTtlSeconds,
  /**
   * Hosts on a private network a playing file may be read from (PRIVATE_STREAM_HOSTS: names or
   * addresses, with or without a port), such as a stream proxy on the LAN. See reads.ts, checkReadable.
   */
  privateStreamHosts: fromEnv.privateStreamHosts ?? [],
  /**
   * How long a subtitle list may take before it answers with what it has, in ms (LIST_BUDGET_MS, 2 to
   * 20 s). The list can take 1.5 s more for a first play's header, so the addon's timeout in AIOStreams
   * (7 s unless raised) must stay above this plus 2.5 s, or AIOStreams drops the whole list. The
   * configure page sets that timeout when it adds the addon, and names it for adding by hand.
   */
  listBudgetMs: fromEnv.listBudgetMs ?? DEFAULTS.listBudgetMs,
  /**
   * The most subtitles a configuration may list for one language (MAX_SUBTITLES_PER_LANGUAGE, 1 to 3).
   * Each one listed is downloaded and timed on every play, so this is the server's say over what its
   * configurations ask for (Settings.perLanguage).
   */
  maxPerLanguage: fromEnv.maxPerLanguage ?? DEFAULTS.maxPerLanguage,
  /**
   * A client registered for AniDB's HTTP API (ANIDB_CLIENT, lower case, and ANIDB_CLIENT_VER, a whole
   * number): with both set, an anime the Anime Kitsu addon gives no season map gets one from AniDB's
   * titles, asked a few at a time (anidb.ts). Unset: AniDB is never asked.
   */
  anidbClient: fromEnv.anidbClient as string | undefined,
  anidbClientVer: fromEnv.anidbClientVer as number | undefined,
  /**
   * OpenSubtitles' own API key (OPENSUBTITLES_API_KEY), one for the whole server: with it, OpenSubtitles
   * is listed from its own search, which marks machine and AI translations (sources.ts). Searching has
   * no daily limit and nothing is downloaded with it. Unset: the V3+ addon lists, as before.
   */
  openSubtitlesApiKey: fromEnv.openSubtitlesApiKey,
  /**
   * Whether the anime-offline-database is read for an anime's season titles when the Anime Kitsu addon
   * gives no season map and no AniDB client is set (ANIME_TITLES_DATASET; on unless turned off). It is
   * downloaded from GitHub the first time a show needs it (animetitles.ts).
   */
  animeTitlesDataset: fromEnv.animeTitlesDataset ?? DEFAULTS.animeTitlesDataset,
  /** Days of log files kept in the cache's logs folder (logs.ts), today included; 0 writes none. */
  logDays: fromEnv.logDays ?? DEFAULTS.logDays,
  /** Most MB the log files take together; the oldest day goes first. */
  logMaxMb: fromEnv.logMaxMb ?? DEFAULTS.logMaxMb,
  /** Whether the dashboard asks GitHub once a day for a newer release (updates.ts). On unless turned off. */
  updateCheck: fromEnv.updateCheck ?? DEFAULTS.updateCheck,
  /** Encrypts everyone's settings into their manifest URL. 32+ characters; changing it breaks every URL. */
  configSecret: env.CONFIG_SECRET || undefined,
  /** AIOStreams instances whose install URLs are accepted, as origins. Defaults to the public ones the community guides list. */
  allowedAiostreams: fromEnv.allowedAiostreams ?? [...DEFAULTS.allowedAiostreams],
  /** This server's own AIOStreams, if any: its install URLs are accepted, and it's reached at AIOSTREAMS_BASE. */
  ownAiostreams: fromEnv.ownAiostreams as string | undefined,
  /** Where OWN_AIOSTREAMS is reached from here, such as http://aiostreams:3000 on the same Docker network. Defaults to OWN_AIOSTREAMS itself. */
  aiostreamsBase: fromEnv.aiostreamsBase || fromEnv.ownAiostreams || DEFAULT_AIOSTREAMS_BASE,
  /**
   * Signs in to the configure page. Unset: open, for a proxy that asks for its own login. This is the
   * .env value; a password set on the dashboard replaces it (see settings.ts, addonPasswordState).
   */
  addonPassword: fromEnv.addonPassword as string | undefined,
  /** Signs in to the dashboard, and the configure page too. Required (server.ts refuses to start without it). */
  adminPassword: env.ADMIN_PASSWORD || undefined
};
