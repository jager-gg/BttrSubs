/**
 * Who a request is for. Each person's settings live in their manifest URL,
 * encrypted with CONFIG_SECRET:
 *
 *   https://<PUBLIC_BASE_URL>/<token>/manifest.json
 *
 * The configure page makes the token; AIOStreams' "Reconfigure" button opens
 * <token>/configure to change it. Nothing about anyone is stored here, beyond what the owner does
 * to a link from the dashboard: edited settings, a pause, a deletion (see "managing links" below).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { cachePath, writeFileAtomic } from "./cache.js";
import { config } from "./config.js";
import { lookOf } from "./srt.js";
import { noteInstallUrls } from "./installUrls.js";

export interface Language {
  /** SubSource's name for it, lower case: "spanish". */
  name: string;
  /** The label players get, e.g. "Spanish". */
  code: string;
}

/** A Stremio subtitle addon someone added: its manifest URL may hold that addon's own keys. */
export interface Addon {
  name: string;
  url: string;
}

/** Most addons one link can carry; their URLs make the link longer. */
export const MAX_ADDONS = 3;

export interface Profile {
  /** The link's id in logs and on the usage page: AIOStreams uuid prefix and key tag. */
  name: string;
  /** The name its owner gave the link, if any ("Sara", "Living room TV"). */
  label?: string;
  /** Empty when SubSource isn't used. */
  subsourceKey: string;
  subdlKey?: string;
  /** Wyzie Subs, with its own key. */
  wyzieKey?: string;
  /** OpenSubtitles V3+ (no key). */
  opensubtitles: boolean;
  /** Subtitle Cat (no key): uploads found by name, listed only once synced to the playing file. */
  subtitlecat: boolean;
  /** TheSubtitleDB (no key), by IMDb id. */
  thesubtitledb: boolean;
  /** Gestdown (no key): Addic7ed's TV subtitles. */
  gestdown: boolean;
  /** Anime Tosho (no key): dub captions from anime releases' own tracks. */
  animetosho: boolean;
  /** Other Stremio subtitle addons asked too. */
  addons: Addon[];
  /** AIOStreams install URL used to find the playing file, as reached from here; no sync without it. */
  aiostreamsUrl?: string;
  /** The configuration's other install URLs (installUrls.ts), as reached from here. */
  aiostreamsAlso?: string[];
  /** English Dub captions on or off. */
  dub: boolean;
  extraLanguages: Language[];
  /** Subtitles listed for each language at most, English Dub included, as the configuration asks (Settings.perLanguage). */
  perLanguage: number;
  /** Keep machine and AI translations. */
  allowMachine: boolean;
  /** For the other languages; dub captions are hearing-impaired by nature. */
  hearingImpaired: "include" | "exclude" | "only";
  /**
   * Leave out a language the playing file already has full text subtitles in: they're timed to that
   * file already. Dub captions are always listed (a file's English is the translation, not the dub).
   */
  skipEmbedded: boolean;
  /** Leave out tracks known not to sync to the playing file (see Settings.hideUnsynced). */
  hideUnsynced: boolean;
  /** Send a subtitle uploaded as ASS as ASS (see Settings.keepAss). */
  keepAss: boolean;
  /** Take sound descriptions and speaker names out of what is sent (see Settings.dropSounds). */
  dropSounds: boolean;
  /** Signs & songs with English Dub (see Settings.signs). */
  signs: boolean;
  /** English in the playing file's own subtitle style (see Settings.ownStyle). */
  ownStyle: boolean;
  /** Its styles, shows moved up before styles existed among them (styleRulesOf). */
  styles: StyleRule[];
  /** Path in front of this profile's URLs: "/<token>". */
  prefix: string;
}

/** What a manifest URL holds. */
export interface Settings {
  /** API keys of the sources used; at least one source is required. */
  subsource?: string;
  subdl?: string;
  wyzie?: string;
  /** OpenSubtitles V3+, which needs no key. */
  opensubtitles?: boolean;
  /** Subtitle Cat, which needs no key. Off unless a link turns it on. */
  subtitlecat?: boolean;
  /** TheSubtitleDB, Gestdown and Anime Tosho, which need no key: on unless a link turns them off (false). */
  thesubtitledb?: boolean;
  gestdown?: boolean;
  animetosho?: boolean;
  /** Other Stremio subtitle addons, by manifest URL. */
  addons?: Addon[];
  /** AIOStreams install URL (https://<allowed host>/stremio/<uuid>/<password>/manifest.json); no sync without it. */
  aiostreams?: string;
  /** Other install URLs of the same AIOStreams configuration: the copies its players use (installUrls.ts). */
  aiostreamsAlso?: string[];
  /** The AIOStreams account's password: reads the install URLs in its linked apps and signs in to its own Jellyfin server (aiostreamsAccount.ts). */
  aiostreamsPassword?: string;
  /** SubSource language names; "English" means the English Dub captions. */
  languages: string[];
  allowMachine: boolean;
  hearingImpaired: "include" | "exclude" | "only";
  /**
   * Subtitles listed for each language at most (1 to MAX_PER_LANGUAGE), English Dub included: the best
   * ones for the playing file, in order. Unset: one. The others still stand behind the listed ones,
   * and take a listed one's place when it can't be synced.
   */
  perLanguage?: number;
  /** A name for the link, shown on the usage page instead of its id. */
  label?: string;
  /** List every language even when the file already has it embedded. Unset: those languages are left out. */
  keepEmbedded?: boolean;
  /** Leave out tracks known not to sync to the playing file, instead of listing them unsynced. */
  hideUnsynced?: boolean;
  /**
   * Send a subtitle uploaded as ASS as ASS, with its styles and positions, for players that draw it.
   * Unset: every subtitle goes out as SRT, which every player shows.
   */
  keepAss?: boolean;
  /**
   * Take sound descriptions ("[door creaks]", "(laughs)", sung lines) and speaker names ("JOHN:") out
   * of the text sent (clean.ts), for hearing-impaired subtitles and dub captions. The timing is the same.
   */
  dropSounds?: boolean;
  /**
   * Signs & songs with English Dub: an anime release's signs track (its on-screen text and song lines,
   * typeset), timed to the playing file by that release's dialogue and sent in one ASS script with the
   * dub's lines (signs.ts, signsjob.ts).
   */
  signs?: boolean;
  /** English Dub and English in the playing file's own subtitle style: the font, size and colours of its dialogue subtitles. */
  ownStyle?: boolean;
  /** Looks and heights for the subtitles, for everything, anime, series, films or one show (StyleRule). */
  styles?: StyleRule[];
  /**
   * Shows moved up, as links kept them before styles: each reads as a one-show style with that height
   * (styleRulesOf), and a save writes them into `styles`.
   */
  raise?: ShowRaise[];
  /**
   * The link's id on the usage page and in its counts, once it has been edited: the one it was made
   * with, kept when an edit changes what the id is worked out from (the AIOStreams account, the key).
   */
  linkId?: string;
}

/** One raised show: its IMDb id, its name as Cinemeta gives it, and how high its lines go. */
export interface ShowRaise {
  id: string;
  name: string;
  percent: number;
}

export const MAX_RAISED = 20;
/** The most subtitles one language may list, whatever a configuration or the server asks. */
export const MAX_PER_LANGUAGE = 3;

/** How many subtitles a configuration lists for each language: what it asks for, one when it doesn't say. */
export function perLanguageOf(settings: Pick<Settings, "perLanguage">): number {
  const asked = settings.perLanguage;
  return typeof asked === "number" && Number.isInteger(asked) && asked >= 1 && asked <= MAX_PER_LANGUAGE ? asked : 1;
}

/** Where a style applies: every subtitle, anime, series, films, or one show by its IMDb id. */
export const STYLE_SCOPES = ["all", "anime", "series", "movie", "show"] as const;
export type StyleScope = (typeof STYLE_SCOPES)[number];

/**
 * A style: a look (lookOf: a preset, or one with changes) for subtitles with no styling of their own, and how far up their lines
 * sit, for one place. Either may be left out, and the most specific style that sets each wins (styleFor).
 */
export interface StyleRule {
  scope: StyleScope;
  /** The show's IMDb id and its name as Cinemeta gives it, for a one-show style. */
  id?: string;
  name?: string;
  look?: string;
  /** How far up, as a share of the picture's height from the bottom. */
  up?: number;
}

/** The four kinds and a style for each show moved up before. */
export const MAX_STYLES = 4 + MAX_RAISED;

/** A configuration's styles: its own, then each show it moved up before styles existed, as a one-show style. */
export function styleRulesOf(s: Pick<Settings, "styles" | "raise">): StyleRule[] {
  const rules = [...(s.styles ?? [])];
  for (const r of s.raise ?? []) if (!rules.some((x) => x.scope === "show" && x.id === r.id)) rules.push({ scope: "show", id: r.id, name: r.name, up: r.percent });
  return rules;
}

/** How specific each place is: one show, then anime, then series or films, then everything. */
const SPECIFIC: Record<StyleScope, number> = { show: 3, anime: 2, series: 1, movie: 1, all: 0 };

/** One title's look and height: for each, the most specific of the styles that apply which sets it. */
export function styleFor(rules: StyleRule[], title: { imdbId?: string; type?: string; anime?: boolean }): { look?: string; up?: number } {
  const applies = (r: StyleRule) => r.scope === "all" || (r.scope === "show" ? Boolean(title.imdbId) && r.id === title.imdbId : r.scope === "anime" ? title.anime === true : r.scope === title.type);
  const ranked = rules.filter(applies).sort((a, b) => SPECIFIC[b.scope] - SPECIFIC[a.scope]);
  return { look: ranked.find((r) => r.look)?.look, up: ranked.find((r) => r.up)?.up };
}
export const RAISE_MIN = 1;
export const RAISE_MAX = 80;
/**
 * A typed show added with no height of its own: just above text burned in at the bottom.
 * Calibration (a 2160p web release's burned-in dialogue, on a decoded frame): the text spans 8.5% to
 * 13.0% of the height up from the bottom, so lines at 15% clear it with 2% to spare.
 */
export const DEFAULT_RAISE = 15;
export const IMDB_ID = /^tt\d{5,10}$/;

const TOKEN_VERSION = "2";
const LANGUAGE_NAME = /^[A-Za-z][A-Za-z ()-]{1,30}$/;
/** Letters (any script), digits, spaces and a little punctuation, up to 40 characters. */
export const LINK_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .,'’&()_-]{0,39}$/u;

function secretKey(): Buffer {
  const secret = config.configSecret;
  if (!secret || secret.length < 32) throw new Error("CONFIG_SECRET (32+ characters) is not set");
  return createHash("sha256").update(secret).digest();
}

/** The AIOStreams URL split into its allowed origin and config path, or undefined when it isn't one. */
export function parseAiostreamsUrl(url: string): { origin: string; path: string } | undefined {
  const match = url.trim().match(/^(https?:\/\/[^/]+)(\/stremio\/[^/\s]+\/[^/\s]+)\/manifest\.json$/);
  if (!match) return undefined;
  const origin = match[1].toLowerCase();
  const allowed = config.allowedAiostreams.includes(origin) || origin === config.ownAiostreams;
  return allowed ? { origin, path: match[2] } : undefined;
}

/** The longest AIOStreams password kept. */
export const MAX_PASSWORD = 256;

/** The most other install URLs a configuration holds. */
export const MAX_OTHER_URLS = 3;

/** Whether two parsed install URLs are one AIOStreams configuration: the same instance and account. */
export function sameAiostreamsConfiguration(a: { origin: string; path: string } | undefined, b: { origin: string; path: string } | undefined): boolean {
  return Boolean(a && b && a.origin === b.origin && a.path.split("/")[2] === b.path.split("/")[2]);
}

/** Returns what's wrong with the settings, or undefined when they're fine. */
export function settingsProblem(s: Settings): string | undefined {
  const key = (k?: string) => !k || (k.length >= 10 && !/\s/.test(k));
  if (!key(s.subsource)) return "SubSource API key: that doesn't look like a key";
  if (!key(s.subdl)) return "SubDL API key: that doesn't look like a key";
  if (!key(s.wyzie)) return "Wyzie Subs key: that doesn't look like a key";
  const addons = s.addons ?? [];
  if (!Array.isArray(addons) || addons.length > MAX_ADDONS) return `Other addons: up to ${MAX_ADDONS}`;
  if (addons.some((a) => typeof a?.name !== "string" || a.name.length > 60 || typeof a.url !== "string" || a.url.length > 2048 || !/^https:\/\/\S+\/manifest\.json$/.test(a.url))) {
    return "Other addons: each must be an https manifest URL ending in /manifest.json";
  }
  // TheSubtitleDB and Gestdown search by id on their own; Subtitle Cat (by name) and Anime Tosho (anime dub captions) need another beside them.
  if (!s.subsource && !s.subdl && !s.wyzie && !s.opensubtitles && s.thesubtitledb === false && s.gestdown === false && addons.length === 0) {
    return `Sources: ${s.subtitlecat || s.animetosho !== false ? "Subtitle Cat and Anime Tosho need another source beside them. " : ""}Add a SubSource, SubDL or Wyzie Subs key, turn on OpenSubtitles, TheSubtitleDB or Gestdown, or add an addon`;
  }
  if (s.aiostreams && !parseAiostreamsUrl(s.aiostreams)) {
    return "AIOStreams: its address must be a supported AIOStreams instance";
  }
  const also = s.aiostreamsAlso ?? [];
  if (!Array.isArray(also) || also.length > MAX_OTHER_URLS) return `Another install URL: up to ${MAX_OTHER_URLS} besides the first`;
  const first = s.aiostreams ? parseAiostreamsUrl(s.aiostreams) : undefined;
  if (also.some((url) => typeof url !== "string" || url.length > 2048 || !sameAiostreamsConfiguration(first, parseAiostreamsUrl(url)))) {
    return "Another install URL: it must be an install URL of the same AIOStreams configuration as the first";
  }
  if (s.aiostreamsPassword !== undefined && (typeof s.aiostreamsPassword !== "string" || !s.aiostreamsPassword || s.aiostreamsPassword.length > MAX_PASSWORD || !first)) {
    return `AIOStreams password: up to ${MAX_PASSWORD} characters, with the AIOStreams address and ID it belongs to`;
  }
  if (!Array.isArray(s.languages) || s.languages.length === 0) return "Languages: pick at least one";
  if (s.languages.length > 10 || s.languages.some((l) => !LANGUAGE_NAME.test(l))) return "Languages: up to 10 SubSource language names";
  if (!["include", "exclude", "only"].includes(s.hearingImpaired)) return "Hearing impaired: include, exclude or only";
  if (s.perLanguage !== undefined && (!Number.isInteger(s.perLanguage) || s.perLanguage < 1 || s.perLanguage > MAX_PER_LANGUAGE)) return `Subtitles per language: a whole number from 1 to ${MAX_PER_LANGUAGE}`;
  const raise = s.raise ?? [];
  if (!Array.isArray(raise) || raise.length > MAX_RAISED) return `Move subtitles up: up to ${MAX_RAISED} shows`;
  if (raise.some((r) => !IMDB_ID.test(String(r?.id)) || typeof r.name !== "string" || r.name.length > 100 || !Number.isInteger(r.percent) || r.percent < RAISE_MIN || r.percent > RAISE_MAX)) {
    return `Move subtitles up: each show needs an IMDb id and a height from ${RAISE_MIN} to ${RAISE_MAX}%`;
  }
  if (new Set(raise.map((r) => r.id)).size !== raise.length) return "Move subtitles up: each show once";
  const styles = s.styles ?? [];
  if (!Array.isArray(styles) || styles.length > MAX_STYLES) return `Styles: up to ${MAX_STYLES}`;
  for (const r of styles) {
    if (!r || !(STYLE_SCOPES as readonly string[]).includes(r.scope)) return "Styles: each is for every subtitle, anime, series, films or one show";
    if (r.scope === "show" ? !IMDB_ID.test(String(r.id)) || typeof r.name !== "string" || r.name.length > 100 : r.id !== undefined || r.name !== undefined) return "Styles: a show's style needs its IMDb id";
    if (r.look !== undefined && (typeof r.look !== "string" || !lookOf(r.look))) return "Styles: that look isn't one this server can draw";
    if (r.up !== undefined && (!Number.isInteger(r.up) || r.up < RAISE_MIN || r.up > RAISE_MAX)) return `Styles: how far up must be ${RAISE_MIN} to ${RAISE_MAX}%`;
    if (r.look === undefined && r.up === undefined) return "Styles: each sets a look, how far up, or both";
  }
  if (new Set(styles.map((r) => `${r.scope}:${r.id ?? ""}`)).size !== styles.length) return "Styles: one for each place";
  if (s.label !== undefined && (typeof s.label !== "string" || !LINK_LABEL.test(s.label))) return "Configuration name: use up to 40 letters, digits, spaces or simple punctuation";
  return undefined;
}

/** Longest token accepted; links stay well under what servers allow in a URL. */
export const MAX_TOKEN = 6000;

/**
 * The nonce comes from the text itself (an HMAC of it), so the same settings
 * always give the same link. Only equal texts share a nonce, and they then
 * give equal ciphertexts, which tells nothing new.
 */
function seal(text: string): string {
  const iv = createHmac("sha256", secretKey()).update("nonce\0").update(text).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function unseal(sealed: string): string | undefined {
  try {
    if (sealed.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(sealed)) return undefined;
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export function sealSettings(settings: Settings): string {
  const problem = settingsProblem(settings);
  if (problem) throw new Error(problem);
  return TOKEN_VERSION + seal(JSON.stringify(settings));
}

/** The settings in a token, or undefined if it isn't one of ours or was altered. */
export function openSettings(token: string): Settings | undefined {
  if (!token.startsWith(TOKEN_VERSION)) return undefined;
  const json = unseal(token.slice(TOKEN_VERSION.length));
  if (!json) return undefined;
  try {
    const settings = JSON.parse(json) as Settings;
    return settingsProblem(settings) ? undefined : settings;
  } catch {
    return undefined;
  }
}

/**
 * A subtitle URL from an added addon, encrypted for its download link: it can
 * carry that addon's keys, so it never appears in the clear or on disk here.
 * "u" keeps these apart from settings tokens.
 */
export function sealUrl(url: string): string {
  return `u${seal(url)}`;
}

export function openUrl(sealed: string): string | undefined {
  return sealed.startsWith("u") ? unseal(sealed.slice(1)) : undefined;
}

/**
 * The settings' name for regular English subtitles: translated from the original audio and timed to
 * it, picked and synced like any other language. "English" on its own has meant the English Dub
 * captions since the first links, so it keeps that meaning.
 */
export const REGULAR_ENGLISH = "English Subtitles";

/** A link id as profileFromSettings makes them: the AIOStreams account's first 8 characters, a 6-character key tag. */
export const LINK_ID = /^[\w-]{1,8}\/[0-9a-f]{6}$/;

/** The settings to keep for a link edited in place: the edit, under the id the link already has (see linkId). */
export function keptLinkSettings(edited: Settings, before: Settings | undefined, token: string): Settings {
  const linkId = before ? profileFromSettings(before, token).name : edited.linkId;
  return linkId ? { ...edited, linkId } : edited;
}

export function profileFromSettings(settings: Settings, token: string): Profile {
  const aio = settings.aiostreams ? parseAiostreamsUrl(settings.aiostreams) : undefined;
  const uuid = aio?.path.split("/")[2] ?? "no-sync";
  const keyTag = createHash("sha256").update(settings.subsource || settings.subdl || "opensubtitles").digest("hex").slice(0, 6);
  const own = aio && config.ownAiostreams === aio.origin;
  // This server's own instance is looked up inside the Docker network; others over the internet.
  const reached = (parsed: { origin: string; path: string }) => `${own ? config.aiostreamsBase : parsed.origin}${parsed.path}/manifest.json`;
  const aiostreamsUrl = aio ? reached(aio) : undefined;
  const aiostreamsAlso = (settings.aiostreamsAlso ?? [])
    .map((url) => parseAiostreamsUrl(url))
    .filter((parsed): parsed is { origin: string; path: string } => sameAiostreamsConfiguration(aio, parsed))
    .map(reached)
    .filter((url) => url !== aiostreamsUrl);
  noteInstallUrls(aiostreamsUrl, aiostreamsAlso, aio && typeof settings.aiostreamsPassword === "string" && settings.aiostreamsPassword ? settings.aiostreamsPassword : undefined);
  return {
    name: settings.linkId && LINK_ID.test(settings.linkId) ? settings.linkId : `${uuid.slice(0, 8)}/${keyTag}`,
    label: settings.label,
    subsourceKey: settings.subsource ?? "",
    subdlKey: settings.subdl || undefined,
    wyzieKey: settings.wyzie || undefined,
    opensubtitles: settings.opensubtitles === true,
    subtitlecat: settings.subtitlecat === true,
    // The free sources are on unless a link turns them off.
    thesubtitledb: settings.thesubtitledb !== false,
    gestdown: settings.gestdown !== false,
    animetosho: settings.animetosho !== false,
    addons: settings.addons ?? [],
    aiostreamsUrl,
    aiostreamsAlso,
    dub: settings.languages.some((l) => l.toLowerCase() === "english"),
    extraLanguages: settings.languages
      .filter((l) => l.toLowerCase() !== "english")
      .map((l) => (l.toLowerCase() === REGULAR_ENGLISH.toLowerCase() ? { name: "english", code: "English" } : { name: l.toLowerCase(), code: l })),
    perLanguage: perLanguageOf(settings),
    allowMachine: settings.allowMachine,
    hearingImpaired: settings.hearingImpaired,
    skipEmbedded: settings.keepEmbedded !== true,
    hideUnsynced: settings.hideUnsynced === true,
    keepAss: settings.keepAss === true,
    dropSounds: settings.dropSounds === true,
    signs: settings.signs === true,
    ownStyle: settings.ownStyle === true,
    styles: styleRulesOf(settings),
    prefix: `/${token}`
  };
}

const RESOURCE = /\/(manifest\.json|configure(?:\/check|\/test|\/add)?|subtitles\/.+|download\/.+)$/;

export interface Routed {
  /** Undefined on the bare /manifest.json and /configure, which belong to no one. */
  profile?: Profile;
  token?: string;
  settings?: Settings;
  /** The rest of the path, e.g. "/subtitles/series/tt1:1:1.json". */
  resource: string;
}

/** Splits "/<token>/<resource>". Undefined for anything else, including altered tokens. */
export function routePath(path: string): Routed | undefined {
  const match = path.match(RESOURCE);
  if (!match) return undefined;
  const head = path.slice(0, match.index);
  const resource = `/${match[1]}`;
  if (head === "") return ["/manifest.json", "/configure", "/configure/check", "/configure/test"].includes(resource) ? { resource } : undefined;
  const token = head.slice(1);
  if (!openSettings(token) || isDeleted(token)) return undefined;
  // Edits made on the link's configure page are kept under the link, so its URL never changes.
  const settings = storedSettings(token) ?? (openSettings(token) as Settings);
  return { profile: profileFromSettings(settings, token), token, settings, resource };
}

// ---------- settings edited in place ----------

/**
 * Where a link's edited settings are kept: cache/links/<hash of the link's token>.json, holding them
 * sealed the same way a token is (so the file alone, without CONFIG_SECRET, says nothing). The link's
 * URL stays what AIOStreams already has; a missing file means the settings the URL was made with.
 */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 40);
}

function linkFile(token: string): string {
  return path.join(cachePath("links"), `${tokenHash(token)}.json`);
}

/** Read once per link, then kept in memory (this server is the only one writing them). */
const stored = new Map<string, Settings | null>();

export function storedSettings(token: string): Settings | undefined {
  const file = linkFile(token);
  if (!stored.has(file)) {
    try {
      const { sealed } = JSON.parse(readFileSync(file, "utf8")) as { sealed: string };
      stored.set(file, openSettings(sealed) ?? null);
    } catch {
      stored.set(file, null);
    }
  }
  return stored.get(file) ?? undefined;
}

/**
 * Forgets what was read of the edited settings, so they're read again: a stored link whose AIOStreams
 * instance wasn't accepted when it was read can open again once the dashboard accepts it.
 */
export function forgetStoredSettings(): void {
  stored.clear();
}

/**
 * Each link's token by its id, remembered from its requests (cache/links/known.json), so the
 * dashboard can open a link's configure page. The newest token wins when one id has several (a link
 * made again with the same AIOStreams and key). The dashboard needs ADMIN_PASSWORD or a login at the proxy.
 */
let known: Record<string, string> | undefined;

function knownFile(): string {
  return path.join(cachePath("links"), "known.json");
}

export function knownLinks(): Record<string, string> {
  if (!known) {
    try {
      known = JSON.parse(readFileSync(knownFile(), "utf8")) as Record<string, string>;
    } catch {
      known = {};
    }
  }
  return known;
}

export function noteLinkToken(link: string, token: string): void {
  const links = knownLinks();
  if (links[link] === token) return;
  known = { ...links, [link]: token };
  try {
    writeFileAtomic(knownFile(), JSON.stringify(known));
  } catch (error) {
    console.error(`links: not saved: ${error instanceof Error ? error.message : error}`);
  }
}

/** What a link is set to, for the dashboard: which keys are set, never the keys. */
export interface LinkSummary {
  /** The name it carries, for the dashboard's Rename field. */
  label?: string;
  languages: string[];
  sources: string[];
  /** The AIOStreams instance's host; undefined without sync. */
  aiostreams?: string;
  allowMachine: boolean;
  hearingImpaired: Settings["hearingImpaired"];
  skipEmbedded: boolean;
  hideUnsynced: boolean;
  keepAss: boolean;
  dropSounds: boolean;
  signs: boolean;
  ownStyle: boolean;
  /** How many styles it has (styleRulesOf). */
  styles: number;
  /** Edited on its configure page since it was made. */
  edited: boolean;
}

export function linkSummary(token: string): LinkSummary | undefined {
  const original = openSettings(token);
  if (!original) return undefined;
  const edited = storedSettings(token);
  const s = edited ?? original;
  const addons = s.addons?.length ?? 0;
  const sources = [
    ...(s.subsource ? ["SubSource"] : []),
    ...(s.subdl ? ["SubDL"] : []),
    ...(s.wyzie ? ["Wyzie Subs"] : []),
    ...(s.opensubtitles ? ["OpenSubtitles"] : []),
    ...(s.subtitlecat === true ? ["Subtitle Cat"] : []),
    ...(s.thesubtitledb !== false ? ["TheSubtitleDB"] : []),
    ...(s.gestdown !== false ? ["Gestdown"] : []),
    ...(s.animetosho !== false ? ["Anime Tosho"] : []),
    ...(addons ? [addons === 1 ? "1 addon" : `${addons} addons`] : [])
  ];
  return {
    label: s.label,
    languages: s.languages.map((l) => (l.toLowerCase() === "english" ? "English Dub" : l.toLowerCase() === REGULAR_ENGLISH.toLowerCase() ? "English" : l)),
    sources,
    aiostreams: s.aiostreams ? parseAiostreamsUrl(s.aiostreams)?.origin.replace(/^https?:\/\//, "") : undefined,
    allowMachine: s.allowMachine,
    hearingImpaired: s.hearingImpaired,
    skipEmbedded: s.keepEmbedded !== true,
    hideUnsynced: s.hideUnsynced === true,
    keepAss: s.keepAss === true,
    dropSounds: s.dropSounds === true,
    signs: s.signs === true,
    ownStyle: s.ownStyle === true,
    styles: styleRulesOf(s).length,
    edited: Boolean(edited)
  };
}

/** Keeps new settings for an existing link: its URL keeps working, with these from now on. */
export function storeSettings(token: string, settings: Settings): void {
  const file = linkFile(token);
  writeFileAtomic(file, JSON.stringify({ sealed: sealSettings(settings), at: new Date().toISOString() }));
  stored.set(file, settings);
}

// ---------- managing links from the dashboard ----------

/**
 * The owner can rename, pause and delete a link from the dashboard, by its id (Profile.name). The
 * dashboard never sees a link's token: these find it in known.json, the token its last requests used.
 *
 * - Paused links (links/paused.json, id to when): their manifest still answers, but their subtitle
 *   lists are empty and their downloads refused, until they're resumed.
 * - Deleted links (links/deleted.json, a hash of the token to the id and when): their URL answers as
 *   an unknown link from then on. Deleting removes that link's edited settings, its pause and its
 *   entry in known.json; its usage history in stats/ stays, and every other link is left alone. A
 *   token is sealed and carries its own settings, so it can't be unmade: refusing it is what deletes it.
 */
let paused: Record<string, number> | undefined;
let deleted: Record<string, { link: string; at: number }> | undefined;

function readJson<T extends object>(file: string, fallback: T): T {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as T;
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

const pausedFile = () => path.join(cachePath("links"), "paused.json");
const deletedFile = () => path.join(cachePath("links"), "deleted.json");

export function pausedLinks(): Record<string, number> {
  return (paused ??= readJson<Record<string, number>>(pausedFile(), {}));
}

export function isPaused(link: string): boolean {
  return Object.hasOwn(pausedLinks(), link);
}

function deletedTokens(): Record<string, { link: string; at: number }> {
  return (deleted ??= readJson<Record<string, { link: string; at: number }>>(deletedFile(), {}));
}

function isDeleted(token: string): boolean {
  return Object.hasOwn(deletedTokens(), tokenHash(token));
}

/** Ids of deleted links that no request has brought back since (a link made again gets its id again). */
export function deletedLinks(): string[] {
  const links = knownLinks();
  return [...new Set(Object.values(deletedTokens()).map((d) => d.link))].filter((link) => !Object.hasOwn(links, link));
}

/** The link's token, if its requests have been seen; never shown on the dashboard. */
function tokenOf(link: string): string | undefined {
  const links = knownLinks();
  return Object.hasOwn(links, link) ? links[link] : undefined;
}

/** The address of a link's configure page, for the dashboard's redirect to it. */
export function configurePathOf(link: string): string | undefined {
  const token = tokenOf(link);
  return token && openSettings(token) ? `/${token}/configure` : undefined;
}

/**
 * A link's install URL, for the dashboard's Copy install URL: its token under PUBLIC_BASE_URL. Given only
 * when asked for one link, so a token is never written into the dashboard's page.
 */
export function installUrlOf(link: string): string | undefined {
  const token = tokenOf(link);
  return token && openSettings(token) && !isDeleted(token) && config.publicBaseUrl ? `${config.publicBaseUrl}/${token}/manifest.json` : undefined;
}

export type LinkChange = { ok: true } | { error: string; status: number };

const unknownLink: LinkChange = { error: "That configuration isn't known here any more. Reload the dashboard", status: 404 };

/** Gives a link a new name, or none ("" or undefined): kept with its settings, as the configure page does. */
export function renameLink(link: string, name: string | undefined): LinkChange {
  const token = tokenOf(link);
  const current = token ? (storedSettings(token) ?? openSettings(token)) : undefined;
  if (!token || !current) return unknownLink;
  const label = name?.trim() || undefined;
  if (label !== undefined && !LINK_LABEL.test(label)) return { error: "Name: use up to 40 letters, digits, spaces or simple punctuation", status: 400 };
  const { label: _old, ...rest } = current;
  storeSettings(token, label === undefined ? rest : { ...rest, label });
  return { ok: true };
}

/** Pauses or resumes a link. */
export function setPaused(link: string, on: boolean): LinkChange {
  if (!tokenOf(link)) return unknownLink;
  const { [link]: _was, ...rest } = pausedLinks();
  paused = on ? { ...rest, [link]: Date.now() } : rest;
  writeFileAtomic(pausedFile(), JSON.stringify(paused));
  return { ok: true };
}

/** Deletes a link: its URL stops working, and only its own stored data goes (see above). */
export function deleteLink(link: string): LinkChange {
  const token = tokenOf(link);
  if (!token) return unknownLink;
  deleted = { ...deletedTokens(), [tokenHash(token)]: { link, at: Date.now() } };
  writeFileAtomic(deletedFile(), JSON.stringify(deleted));
  rmSync(linkFile(token), { force: true });
  stored.delete(linkFile(token));
  const { [link]: _token, ...others } = knownLinks();
  known = others;
  writeFileAtomic(knownFile(), JSON.stringify(known));
  if (isPaused(link)) {
    const { [link]: _at, ...rest } = pausedLinks();
    paused = rest;
    writeFileAtomic(pausedFile(), JSON.stringify(paused));
  }
  return { ok: true };
}
