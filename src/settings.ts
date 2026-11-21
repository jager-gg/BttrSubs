/**
 * The server settings the dashboard can change without a restart. They're kept in the cache volume
 * (settings.json, written whole or not at all) and written over the values config.ts read from .env,
 * which stay the defaults: each setting comes from the dashboard, else .env, else its default, and
 * resetting one on the dashboard goes back to .env or the default.
 *
 * CONFIG_SECRET, ADMIN_PASSWORD, PUBLIC_BASE_URL, CACHE_DIR and PORT are never changed here: the
 * dashboard only says whether .env sets them.
 *
 * Every value is checked as config.ts reads it (the same parsers), and refused when config.ts would
 * have fallen back to a default instead, so what's saved is always what's used. A password set here
 * is kept as a scrypt hash, never as itself, and is never sent back to the page.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { cachePath, writeFileAtomic } from "./cache.js";
import { ANIDB_CLIENT, ANIDB_CLIENT_VER, config, DEFAULT_AIOSTREAMS_BASE, DEFAULTS, ENV_ONLY, envIsSet, fromEnv, parseNumber, parseOrigins, parseSwitch, parseTimeZone, RANGES } from "./config.js";
import { anidbClientChanged } from "./anidb.js";
import { setLogLimits } from "./logs.js";
import { forgetStoredSettings } from "./profile.js";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;

export const SETTING_KEYS = [
  "addonPassword",
  "allowedAiostreams",
  "ownAiostreams",
  "aiostreamsBase",
  "openSubtitlesApiKey",
  "dailyReadGb",
  "privateStreamHosts",
  "anidbClient",
  "anidbClientVer",
  "animeTitlesDataset",
  "listBudgetMs",
  "maxPerLanguage",
  "resultCacheTtlSeconds",
  "timeZone",
  "logDays",
  "logMaxMb",
  "updateCheck"
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Each setting's .env name, as the dashboard shows it. */
export const ENV_NAME: Record<SettingKey, string> = {
  addonPassword: "ADDON_PASSWORD",
  allowedAiostreams: "ALLOWED_AIOSTREAMS",
  ownAiostreams: "OWN_AIOSTREAMS",
  aiostreamsBase: "AIOSTREAMS_BASE",
  openSubtitlesApiKey: "OPENSUBTITLES_API_KEY",
  timeZone: "TIME_ZONE",
  dailyReadGb: "DAILY_READ_GB",
  resultCacheTtlSeconds: "RESULT_CACHE_TTL_SECONDS",
  updateCheck: "UPDATE_CHECK",
  listBudgetMs: "LIST_BUDGET_MS",
  maxPerLanguage: "MAX_SUBTITLES_PER_LANGUAGE",
  privateStreamHosts: "PRIVATE_STREAM_HOSTS",
  anidbClient: "ANIDB_CLIENT",
  anidbClientVer: "ANIDB_CLIENT_VER",
  animeTitlesDataset: "ANIME_TITLES_DATASET",
  logDays: "LOG_DAYS",
  logMaxMb: "LOG_MAX_MB"
};

/** AniDB's client is its name and its version: set together or not at all, and reset together. */
const ANIDB_PAIR = ["anidbClient", "anidbClientVer"] as const;

/** What settings.json holds: only the settings changed on the dashboard. */
interface Saved {
  /** Off (the configure page opens for anyone), or a password's scrypt hash ("salt.hash", base64url). */
  addonPassword?: { off: true } | { scrypt: string };
  allowedAiostreams?: string[];
  /** "" for none, even when .env names one. */
  ownAiostreams?: string;
  aiostreamsBase?: string;
  /** OpenSubtitles' own API key as it is used; "" for none, even when .env gives one. */
  openSubtitlesApiKey?: string;
  timeZone?: string;
  dailyReadGb?: number;
  resultCacheTtlSeconds?: number;
  updateCheck?: boolean;
  listBudgetMs?: number;
  maxPerLanguage?: number;
  privateStreamHosts?: string[];
  /** "" for none, even when .env names one. */
  anidbClient?: string;
  /** 0 for none, even when .env gives one. */
  anidbClientVer?: number;
  animeTitlesDataset?: boolean;
  logDays?: number;
  logMaxMb?: number;
}

let saved: Saved = {};
let loaded = false;

const file = () => cachePath("settings.json");

// ---------- checks: the same parsers as config.ts, refusing what it would have replaced ----------

type Check<T> = { value: T } | { error: string };

export const MAX_ORIGINS = 20;
export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
export const MAX_READ_GB = 100_000;
export const TTL_RANGE = [60, 30 * 86_400] as const;
export const MAX_HOSTS = 20;
const HOST = /^(?<host>\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)(?::(?<port>[1-9]\d{0,4}))?$/;

/**
 * A host as reads.ts compares one with a file's address: a name or an address (IPv6 in brackets) in
 * the form a URL keeps it, lower case, with or without a port. No scheme, path, wildcard or space.
 */
function hostEntry(text: string): boolean {
  const found = HOST.exec(text)?.groups;
  if (!found || text.length > 260 || found.host.length > 253 || Number(found.port ?? 1) > 65_535) return false;
  // Never a link-local address: that is where a cloud host keeps its own metadata and credentials, not a stream.
  if (/^169\.254\.|^\[fe[89ab]/.test(found.host)) return false;
  try {
    return new URL(`http://${found.host}`).hostname === found.host;
  } catch {
    return false;
  }
}

/** A whole number in a range, from a form's text or a number. */
function wholeNumber(raw: unknown, [low, high]: readonly [number, number]): number | undefined {
  const value = parseNumber(String(raw ?? "").trim());
  return value !== undefined && Number.isInteger(value) && value >= low && value <= high ? value : undefined;
}

const thousands = (value: number) => value.toLocaleString("en-US");

/** An origin as config.ts keeps one (lower case, no trailing slash), and nothing but an origin. */
function origin(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === text && text.length <= 200;
  } catch {
    return false;
  }
}

function checkOrigins(raw: unknown, what: string): Check<string[]> {
  if (typeof raw !== "string" && !Array.isArray(raw)) return { error: `${what}: a list of addresses` };
  const text = Array.isArray(raw) ? raw.map(String).join(",") : raw;
  const list = [...new Set(parseOrigins(text.replace(/\s+/g, ",")))];
  const bad = list.find((o) => !origin(o));
  if (bad !== undefined) return { error: `${what}: "${bad.slice(0, 60)}" isn't an address like https://aiostreams.example.com (no path)` };
  if (list.length > MAX_ORIGINS) return { error: `${what}: up to ${MAX_ORIGINS} addresses` };
  return { value: list };
}

/** An API key as a site hands one out: one run of letters, digits, - or _. */
const API_KEY = /^[A-Za-z0-9_-]{8,128}$/;

const CHECKS: { [K in Exclude<SettingKey, "addonPassword">]: (raw: unknown) => Check<NonNullable<Saved[K]>> } = {
  allowedAiostreams: (raw) => checkOrigins(raw, "Accepted instances"),
  ownAiostreams: (raw) => {
    const list = checkOrigins(raw, "Your AIOStreams");
    if ("error" in list) return list;
    if (list.value.length > 1) return { error: "Your AIOStreams: one address, or none" };
    return { value: list.value[0] ?? "" };
  },
  aiostreamsBase: (raw) => {
    const text = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
    try {
      const url = new URL(text);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.search && !url.hash && !url.username && !url.password && text.length <= 200) return { value: text };
    } catch {}
    return { error: "Reached at: an http or https address, such as http://aiostreams:3000" };
  },
  openSubtitlesApiKey: (raw) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    return typeof raw === "string" && (text === "" || API_KEY.test(text)) ? { value: text } : { error: "OpenSubtitles API key: 8 to 128 letters, digits, - or _, or empty for none" };
  },
  timeZone: (raw) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    const zone = text && text.length <= 64 ? parseTimeZone(text) : undefined;
    return zone ? { value: zone } : { error: "Time zone: an IANA name such as Europe/London or UTC" };
  },
  dailyReadGb: (raw) => {
    const value = parseNumber(String(raw ?? "").trim());
    return value !== undefined && value >= 0 && value <= MAX_READ_GB ? { value } : { error: `Daily read limit: a number of GB from 0 (no limit) to ${MAX_READ_GB.toLocaleString("en-US")}` };
  },
  resultCacheTtlSeconds: (raw) => {
    const value = parseNumber(String(raw ?? "").trim());
    return value !== undefined && Number.isInteger(value) && value >= TTL_RANGE[0] && value <= TTL_RANGE[1]
      ? { value }
      : { error: `Search results kept for: whole seconds, from ${TTL_RANGE[0]} to ${TTL_RANGE[1].toLocaleString("en-US")} (30 days)` };
  },
  updateCheck: (raw) => {
    const value = typeof raw === "boolean" ? raw : parseSwitch(String(raw ?? ""));
    return value === undefined ? { error: "Check for updates: on or off" } : { value };
  },
  maxPerLanguage: (raw) => {
    const value = wholeNumber(raw, RANGES.maxPerLanguage);
    return value !== undefined ? { value } : { error: `Most subtitles per language: a whole number from ${RANGES.maxPerLanguage[0]} to ${RANGES.maxPerLanguage[1]}` };
  },
  listBudgetMs: (raw) => {
    const value = wholeNumber(raw, RANGES.listBudgetMs);
    return value !== undefined ? { value } : { error: `List time limit: whole milliseconds, from ${thousands(RANGES.listBudgetMs[0])} to ${thousands(RANGES.listBudgetMs[1])}` };
  },
  privateStreamHosts: (raw) => {
    if (typeof raw !== "string" && !Array.isArray(raw)) return { error: "Private stream hosts: a list of hosts" };
    const text = Array.isArray(raw) ? raw.map(String).join(",") : raw;
    const list = [...new Set(text.toLowerCase().split(/[\s,]+/).filter(Boolean))];
    const bad = list.find((h) => !hostEntry(h));
    if (bad !== undefined) return { error: `Private stream hosts: "${bad.slice(0, 60)}" isn't a host like proxy.lan or 192.168.1.9:8080 (a name or an address, with or without a port)` };
    if (list.length > MAX_HOSTS) return { error: `Private stream hosts: up to ${MAX_HOSTS} hosts` };
    return { value: list };
  },
  anidbClient: (raw) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    return typeof raw === "string" && (text === "" || ANIDB_CLIENT.test(text)) ? { value: text } : { error: "AniDB client: lower-case letters and digits, up to 32, or empty for none" };
  },
  anidbClientVer: (raw) => {
    const text = String(raw ?? "").trim();
    if (text === "" || text === "0") return { value: 0 };
    return ANIDB_CLIENT_VER.test(text) ? { value: Number(text) } : { error: "AniDB client version: a whole number from 1 to 999,999, or empty for none" };
  },
  animeTitlesDataset: (raw) => {
    const value = typeof raw === "boolean" ? raw : parseSwitch(String(raw ?? ""));
    return value === undefined ? { error: "Anime titles dataset: on or off" } : { value };
  },
  logDays: (raw) => {
    const value = wholeNumber(raw, RANGES.logDays);
    return value !== undefined ? { value } : { error: `Log days kept: whole days, from ${RANGES.logDays[0]} (no log files) to ${RANGES.logDays[1]}` };
  },
  logMaxMb: (raw) => {
    const value = parseNumber(String(raw ?? "").trim());
    return value !== undefined && value >= RANGES.logMaxMb[0] && value <= RANGES.logMaxMb[1] ? { value } : { error: `Log size limit: a number of MB, from ${RANGES.logMaxMb[0]} to ${thousands(RANGES.logMaxMb[1])}` };
  }
};

// ---------- what's in force ----------

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Writes the settings in force over config: the dashboard's, else .env's, else the defaults. */
function apply(): void {
  config.allowedAiostreams = saved.allowedAiostreams ?? fromEnv.allowedAiostreams ?? [...DEFAULTS.allowedAiostreams];
  config.ownAiostreams = saved.ownAiostreams !== undefined ? saved.ownAiostreams || undefined : fromEnv.ownAiostreams;
  config.aiostreamsBase = saved.aiostreamsBase ?? fromEnv.aiostreamsBase ?? config.ownAiostreams ?? DEFAULT_AIOSTREAMS_BASE;
  config.openSubtitlesApiKey = saved.openSubtitlesApiKey !== undefined ? saved.openSubtitlesApiKey || undefined : fromEnv.openSubtitlesApiKey;
  config.timeZone = saved.timeZone ?? fromEnv.timeZone ?? DEFAULTS.timeZone;
  config.dailyReadGb = saved.dailyReadGb ?? Math.max(0, fromEnv.dailyReadGb ?? DEFAULTS.dailyReadGb);
  config.resultCacheTtlSeconds = saved.resultCacheTtlSeconds ?? fromEnv.resultCacheTtlSeconds ?? DEFAULTS.resultCacheTtlSeconds;
  config.updateCheck = saved.updateCheck ?? fromEnv.updateCheck ?? DEFAULTS.updateCheck;
  config.listBudgetMs = saved.listBudgetMs ?? fromEnv.listBudgetMs ?? DEFAULTS.listBudgetMs;
  config.maxPerLanguage = saved.maxPerLanguage ?? fromEnv.maxPerLanguage ?? DEFAULTS.maxPerLanguage;
  config.privateStreamHosts = saved.privateStreamHosts ?? fromEnv.privateStreamHosts ?? [];
  const client = [config.anidbClient, config.anidbClientVer];
  config.anidbClient = saved.anidbClient !== undefined ? saved.anidbClient || undefined : fromEnv.anidbClient;
  config.anidbClientVer = saved.anidbClientVer !== undefined ? saved.anidbClientVer || undefined : fromEnv.anidbClientVer;
  // A client AniDB refused stops every request for a day and a half: a new one gets its try at once.
  if (loaded && (client[0] !== config.anidbClient || client[1] !== config.anidbClientVer)) void anidbClientChanged().catch(() => undefined);
  config.animeTitlesDataset = saved.animeTitlesDataset ?? fromEnv.animeTitlesDataset ?? DEFAULTS.animeTitlesDataset;
  const logDays = saved.logDays ?? fromEnv.logDays ?? DEFAULTS.logDays;
  const logMaxMb = saved.logMaxMb ?? fromEnv.logMaxMb ?? DEFAULTS.logMaxMb;
  // The log files take new limits only when they change: a writer started with its own keeps them.
  if (logDays !== config.logDays || logMaxMb !== config.logMaxMb) {
    config.logDays = logDays;
    config.logMaxMb = logMaxMb;
    setLogLimits(logDays, logMaxMb * 1e6);
  }
  // Links are checked against the accepted instances when read: read them again under the new list.
  forgetStoredSettings();
}

/** Reads settings.json once (at start), checking each value again; one that doesn't pass is left out. */
export function loadSettings(): void {
  if (loaded) return;
  loaded = true;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
  } catch {}
  saved = {};
  const password = raw.addonPassword as Saved["addonPassword"] | undefined;
  if (password && typeof password === "object" && ("off" in password ? password.off === true : typeof password.scrypt === "string" && /^[\w-]{22}\.[\w-]{43}$/.test(password.scrypt))) {
    saved.addonPassword = password;
  }
  for (const key of Object.keys(CHECKS) as Array<keyof typeof CHECKS>) {
    if (raw[key] === undefined) continue;
    const checked = CHECKS[key](key === "allowedAiostreams" && Array.isArray(raw[key]) ? (raw[key] as string[]).join(",") : raw[key]);
    if ("value" in checked) (saved as Record<string, unknown>)[key] = checked.value;
    else console.warn(`settings: ${key} in settings.json isn't valid, so it's left out`);
  }
  apply();
}

/** Whether the configure page asks for a password: the dashboard's choice, else whether ADDON_PASSWORD is set. */
export function addonPasswordSet(): boolean {
  const own = saved.addonPassword;
  return own ? "scrypt" in own : Boolean(config.addonPassword);
}

/** Whether this is the configure page's password. */
export async function addonPasswordMatches(given: string): Promise<boolean> {
  const own = saved.addonPassword;
  if (own) {
    if (!("scrypt" in own)) return false;
    const [salt, hash] = own.scrypt.split(".");
    const tried = await scrypt(given, Buffer.from(salt, "base64url"), 32);
    return timingSafeEqual(tried, Buffer.from(hash, "base64url"));
  }
  return Boolean(config.addonPassword) && timingSafeEqual(digest(given), digest(config.addonPassword as string));
}

/** Changes whenever the configure page's password does, for the session key (access.ts): a new password signs people out. */
export function addonPasswordFingerprint(): string {
  const own = saved.addonPassword;
  return own ? ("scrypt" in own ? `dashboard:${own.scrypt}` : "dashboard:off") : (config.addonPassword ?? "");
}

// ---------- the dashboard's view and changes ----------

export type Source = "dashboard" | ".env" | "default";

export interface SettingView {
  key: SettingKey;
  env: string;
  source: Source;
  /** What a reset goes back to: .env when it sets this, else the default. */
  resetTo: Exclude<Source, "dashboard">;
  /** The value in force, for the form; for the password and for a key only whether one is set. */
  value: string | number | boolean;
  /** The value a reset goes back to, as text; for the password and for a key only "on" or "off". */
  resetValue: string;
}

const listText = (list: string[]) => list.join("\n");

/** Every setting the dashboard can change, with its value in force and where that comes from. Never a password or a key. */
export function settingsView(): SettingView[] {
  const own = saved.ownAiostreams !== undefined ? saved.ownAiostreams || undefined : fromEnv.ownAiostreams;
  const views: Record<SettingKey, Omit<SettingView, "key" | "env" | "source" | "resetTo"> & { fromEnv: boolean }> = {
    addonPassword: { value: addonPasswordSet(), fromEnv: Boolean(fromEnv.addonPassword), resetValue: fromEnv.addonPassword ? "on" : "off" },
    allowedAiostreams: { value: listText(config.allowedAiostreams), fromEnv: fromEnv.allowedAiostreams !== undefined, resetValue: listText(fromEnv.allowedAiostreams ?? DEFAULTS.allowedAiostreams) },
    ownAiostreams: { value: config.ownAiostreams ?? "", fromEnv: fromEnv.ownAiostreams !== undefined, resetValue: fromEnv.ownAiostreams ?? "" },
    aiostreamsBase: { value: config.aiostreamsBase, fromEnv: fromEnv.aiostreamsBase !== undefined, resetValue: fromEnv.aiostreamsBase ?? own ?? DEFAULT_AIOSTREAMS_BASE },
    openSubtitlesApiKey: { value: Boolean(config.openSubtitlesApiKey), fromEnv: Boolean(fromEnv.openSubtitlesApiKey), resetValue: fromEnv.openSubtitlesApiKey ? "on" : "off" },
    timeZone: { value: config.timeZone, fromEnv: fromEnv.timeZone !== undefined, resetValue: fromEnv.timeZone ?? DEFAULTS.timeZone },
    dailyReadGb: { value: config.dailyReadGb, fromEnv: fromEnv.dailyReadGb !== undefined, resetValue: String(Math.max(0, fromEnv.dailyReadGb ?? DEFAULTS.dailyReadGb)) },
    resultCacheTtlSeconds: { value: config.resultCacheTtlSeconds, fromEnv: fromEnv.resultCacheTtlSeconds !== undefined, resetValue: String(fromEnv.resultCacheTtlSeconds ?? DEFAULTS.resultCacheTtlSeconds) },
    updateCheck: { value: config.updateCheck, fromEnv: fromEnv.updateCheck !== undefined, resetValue: (fromEnv.updateCheck ?? DEFAULTS.updateCheck) ? "on" : "off" },
    maxPerLanguage: { value: config.maxPerLanguage, fromEnv: fromEnv.maxPerLanguage !== undefined, resetValue: String(fromEnv.maxPerLanguage ?? DEFAULTS.maxPerLanguage) },
    listBudgetMs: { value: config.listBudgetMs, fromEnv: fromEnv.listBudgetMs !== undefined, resetValue: String(fromEnv.listBudgetMs ?? DEFAULTS.listBudgetMs) },
    privateStreamHosts: { value: listText(config.privateStreamHosts), fromEnv: fromEnv.privateStreamHosts !== undefined, resetValue: listText(fromEnv.privateStreamHosts ?? []) },
    anidbClient: { value: config.anidbClient ?? "", fromEnv: fromEnv.anidbClient !== undefined, resetValue: fromEnv.anidbClient ?? "" },
    anidbClientVer: { value: config.anidbClientVer ?? 0, fromEnv: fromEnv.anidbClientVer !== undefined, resetValue: String(fromEnv.anidbClientVer ?? 0) },
    animeTitlesDataset: { value: config.animeTitlesDataset, fromEnv: fromEnv.animeTitlesDataset !== undefined, resetValue: (fromEnv.animeTitlesDataset ?? DEFAULTS.animeTitlesDataset) ? "on" : "off" },
    logDays: { value: config.logDays, fromEnv: fromEnv.logDays !== undefined, resetValue: String(fromEnv.logDays ?? DEFAULTS.logDays) },
    logMaxMb: { value: config.logMaxMb, fromEnv: fromEnv.logMaxMb !== undefined, resetValue: String(fromEnv.logMaxMb ?? DEFAULTS.logMaxMb) }
  };
  return SETTING_KEYS.map((key) => {
    const { fromEnv: inEnv, ...view } = views[key];
    const resetTo = inEnv ? ".env" : "default";
    return { key, env: ENV_NAME[key], source: saved[key] !== undefined ? "dashboard" : resetTo, resetTo, ...view };
  });
}

/** The settings that are only ever set in .env: whether each is set, never its value. */
export function envOnlyView(): Array<{ env: string; set: boolean }> {
  return ENV_ONLY.map((env) => ({ env, set: envIsSet(env) }));
}

export type SettingsChange = { ok: true; changed: SettingKey[] } | { error: string; field?: SettingKey };

function save(next: Saved): void {
  writeFileAtomic(file(), `${JSON.stringify(next, null, 2)}\n`);
  saved = next;
  apply();
}

/**
 * Checks and saves settings from the dashboard: { addonPassword: { off: true } | { password }, timeZone: "…", … }.
 * All of them or none: one that doesn't pass saves nothing and says which. A value the same as the one
 * in force isn't saved, so an unchanged field keeps following .env.
 */
export async function changeSettings(input: Record<string, unknown>): Promise<SettingsChange> {
  const next: Saved = { ...saved };
  const changed: SettingKey[] = [];
  for (const key of Object.keys(input)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) return { error: "Unknown setting" };
  }
  if (input.addonPassword !== undefined) {
    const raw = input.addonPassword as { off?: unknown; password?: unknown } | null;
    if (raw && typeof raw === "object" && raw.off === true) {
      if (addonPasswordSet()) {
        next.addonPassword = { off: true };
        changed.push("addonPassword");
      }
    } else if (raw && typeof raw === "object" && typeof raw.password === "string") {
      const password = raw.password;
      if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD || /[\r\n]/.test(password)) {
        return { error: `Password: ${MIN_PASSWORD} to ${MAX_PASSWORD} characters on one line`, field: "addonPassword" };
      }
      if (config.adminPassword && timingSafeEqual(digest(password), digest(config.adminPassword))) {
        return { error: "Password: use one that's different from the dashboard's", field: "addonPassword" };
      }
      const salt = randomBytes(16);
      next.addonPassword = { scrypt: `${salt.toString("base64url")}.${(await scrypt(password, salt, 32)).toString("base64url")}` };
      changed.push("addonPassword");
    } else {
      return { error: "Password: set one, or turn it off", field: "addonPassword" };
    }
  }
  const current = Object.fromEntries(settingsView().map((v) => [v.key, v]));
  for (const key of Object.keys(CHECKS) as Array<keyof typeof CHECKS>) {
    if (input[key] === undefined) continue;
    const checked = CHECKS[key](input[key]);
    if ("error" in checked) return { error: checked.error, field: key };
    const shown = Array.isArray(checked.value) ? listText(checked.value) : checked.value;
    // The key's view says only whether one is set: it is compared with the key in force itself.
    const inForce = key === "openSubtitlesApiKey" ? (config.openSubtitlesApiKey ?? "") : current[key].value;
    if (shown === inForce && saved[key] === undefined) continue;
    (next as Record<string, unknown>)[key] = checked.value;
    changed.push(key);
  }
  // AniDB's client is a name and a version: one without the other asks nothing, so it isn't saved.
  if (ANIDB_PAIR.some((key) => input[key] !== undefined)) {
    const name = next.anidbClient ?? fromEnv.anidbClient ?? "";
    const version = next.anidbClientVer ?? fromEnv.anidbClientVer ?? 0;
    if (Boolean(name) !== Boolean(version)) {
      return name ? { error: "AniDB client version: set it with the client's name, or leave both empty", field: "anidbClientVer" } : { error: "AniDB client: set it with its version, or leave both empty", field: "anidbClient" };
    }
  }
  if (changed.length) save(next);
  return { ok: true, changed };
}

/** Puts settings back to .env or their defaults. */
export function resetSettings(keys: unknown): SettingsChange {
  if (!Array.isArray(keys) || keys.some((k) => !(SETTING_KEYS as readonly string[]).includes(k))) return { error: "Unknown setting" };
  const asked = new Set(keys as SettingKey[]);
  if (ANIDB_PAIR.some((key) => asked.has(key))) for (const key of ANIDB_PAIR) asked.add(key);
  const changed = [...asked].filter((k) => saved[k] !== undefined);
  if (!changed.length) return { ok: true, changed };
  const next: Saved = { ...saved };
  for (const key of changed) delete next[key];
  save(next);
  return { ok: true, changed };
}
