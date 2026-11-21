/**
 * The dashboard's data: everything its page draws, in one plain object (window.BTTR), built from the
 * stats (stats.ts), the configurations' settings (profile.ts) and the server settings (settings.ts).
 * The page's script draws every section from it and filters it as you go; GET /dashboard/data sends it
 * again for Refresh and after a change.
 *
 * Every figure is worked out here or in stats.ts, never guessed in the page. It carries no token, key,
 * password or address with credentials: configurations are named by their ids, keys by their tags,
 * AIOStreams instances by their hosts.
 */
import { anidbConfigured, anidbNow, anidbPace } from "./anidb.js";
import { config, RANGES } from "./config.js";
import { activityWeek, afterClear, afterLinkClears, answeredByRequest, ERRORS_KEPT, type Activity, type KeyUsage, type StatsView } from "./stats.js";
import { envOnlyView, MAX_HOSTS, MAX_ORIGINS, MAX_READ_GB, settingsView, TTL_RANGE, type SettingView } from "./settings.js";
import { newerRelease, whatsNew, type Release, type ReleaseNotes } from "./updates.js";
import { logSummary } from "./logs.js";
import { readsNow } from "./reads.js";

type Counters = Record<string, number>;
const DAY = 86_400_000;

const sum = (c: Counters, prefix: string, suffix = "") => Object.entries(c).reduce((t, [k, v]) => (k.startsWith(prefix) && k.endsWith(suffix) && k !== "lastSeen" ? t + v : t), 0);
const cpuSeconds = (c: Counters) => (c["own.cpu.ms"] ?? c["cpu.ms"] ?? 0) / 1000;

/** The sources in the Sources table, in order; Subtitle Cat and added addons only in a week that used them. */
const SOURCES = ["subsource", "subdl", "wyzie", "opensubtitles", "thesubtitledb", "gestdown", "animetosho", "subtitlecat", "addons"] as const;
/** The name a source's activity rows carry (sourceWeek's keys), by its id. */
const ROW_NAME: Record<string, string> = { subsource: "SubSource", subdl: "SubDL", wyzie: "Wyzie Subs", opensubtitles: "OpenSubtitles", subtitlecat: "Subtitle Cat", thesubtitledb: "TheSubtitleDB", gestdown: "Gestdown", animetosho: "Anime Tosho", addons: "An added addon" };

/**
 * A free Wyzie key's requests today, of its day's limit (x-ratelimit-limit): what its last reply left
 * (x-wyzie-balance), every app on the key included, while that reply is from today (UTC); else
 * BttrSubs' own count of calls, which counts a search once though it costs one request a source.
 */
function wyzieDay(h: Record<string, string>, last: KeyUsage | undefined, ownCalls: number, now: number): { used: number; max: number; note: string } {
  const max = Number(h["x-ratelimit-limit"]) || 1000;
  const left = Number(h["x-wyzie-balance"]);
  const today = now - (now % DAY);
  return h["x-wyzie-balance"] !== undefined && Number.isFinite(left) && (last?.lastAt ?? 0) >= today
    ? { used: Math.max(0, max - left), max, note: "Wyzie's own count" }
    : { used: ownCalls, max, note: "" };
}

export interface DashboardSetting {
  key: SettingView["key"];
  group: string;
  label: string;
  /** What it does, and when to change it. */
  help: string;
  env: string;
  /** Its control: the password's switch, an on/off toggle, a list of addresses or hosts, one address, a time zone, a number, a duration, a client's name. */
  kind: "switch" | "toggle" | "list" | "hosts" | "url" | "zone" | "number" | "duration" | "name" | "key";
  /** For a key always empty: the page is told only whether one is set (`set`). */
  value: string | number;
  set?: boolean;
  source: SettingView["source"];
  /** Where Reset goes back to, and that value as the control shows it. */
  resetTo: SettingView["resetTo"];
  resetValue: string | number;
  unit?: string;
  resetUnit?: string;
  /** Sites the help names, each linked where its words first appear: [words, address]. */
  links?: Array<[string, string]>;
  /** A line under the control: the range, the form, an example. */
  hint?: string;
  /** A toggle's own words: beside the switch, and what on and off each mean. */
  switchLabel?: string;
  onText?: string;
  offText?: string;
  /** A number's range as settings.ts checks it, whether it must be whole, whether empty means none, and what the page says for one outside it. */
  min?: number;
  max?: number;
  whole?: boolean;
  optional?: boolean;
  invalid?: string;
  /** What a number of 0 is called ("no limit"), where 0 has a meaning of its own. */
  zero?: string;
}

/** The groups of the Settings section, in order. */
const SETTING_GROUPS = ["Access", "AIOStreams", "Subtitle sources", "Reading files", "Anime", "Lists and timing", "Logs and updates"] as const;

/** Seconds in the largest unit that holds them whole: 21600 is 6 hours. */
function inUnit(seconds: number): { value: number; unit: "minutes" | "hours" | "days" } {
  if (seconds % 86400 === 0) return { value: seconds / 86400, unit: "days" };
  if (seconds % 3600 === 0) return { value: seconds / 3600, unit: "hours" };
  return { value: Math.round(seconds / 60), unit: "minutes" };
}

/** The server settings as the Settings section shows them: each in its own units, saying where its value comes from. */
export function dashboardSettings(views: SettingView[] = settingsView()): DashboardSetting[] {
  type Words = Pick<DashboardSetting, "group" | "label" | "help" | "kind"> & Partial<Pick<DashboardSetting, "links" | "unit" | "hint" | "switchLabel" | "onText" | "offText" | "min" | "max" | "whole" | "optional" | "invalid" | "zero">> & { group: (typeof SETTING_GROUPS)[number] };
  const thousands = (value: number) => value.toLocaleString("en-US");
  const [budgetLow, budgetHigh] = RANGES.listBudgetMs;
  const WORDS: Record<SettingView["key"], Words> = {
    addonPassword: {
      group: "Access",
      label: "Configure page password",
      help: "Asks for a password before anyone can make or change a configuration. Turn it on when the configure page can be opened without another login in front of it. The dashboard's own password is ADMIN_PASSWORD in .env.",
      kind: "switch"
    },
    allowedAiostreams: {
      group: "AIOStreams",
      label: "Accepted instances",
      help: "Public AIOStreams instances a configuration may sync with. Removing one stops the configurations that use it until it's added back.",
      kind: "list",
      hint: "One address per line, like https://aiostreams.example.com",
      max: MAX_ORIGINS
    },
    ownAiostreams: { group: "AIOStreams", label: "Your AIOStreams", help: "Your own instance's public address: accepted too, and offered first on the configure page. Empty for none.", kind: "url", hint: "Its public address, with no path" },
    aiostreamsBase: { group: "AIOStreams", label: "Reached at", help: "Where this server reaches your instance. Change it when both run on one Docker network, so requests stay inside it.", kind: "url", hint: "Such as http://aiostreams:3000" },
    openSubtitlesApiKey: {
      group: "Subtitle sources",
      label: "OpenSubtitles API key",
      help: "OpenSubtitles' own API key, one for the whole server, free with an account at opensubtitles.com. With it, OpenSubtitles is listed from its own search, which marks machine and AI translations; without it, from OpenSubtitles V3+, which doesn't. Only searches use it: subtitles are still downloaded through OpenSubtitles V3+.",
      kind: "key",
      links: [["opensubtitles.com", "https://www.opensubtitles.com/consumers"]],
      hint: "Kept on this server and never shown again",
      invalid: "A key of 8 to 128 letters, digits, - or _."
    },
    dailyReadGb: {
      group: "Reading files",
      label: "Daily read limit",
      help: "The most video read in a UTC day for timing, over everyone. Once it's spent, new files are listed unsynced until the next day. Lower it when the files' host counts traffic.",
      kind: "number",
      unit: "GB a day",
      min: 0,
      max: MAX_READ_GB,
      zero: "no limit",
      hint: `From 0 (no limit) to ${thousands(MAX_READ_GB)}`,
      invalid: `A number of GB, from 0 (no limit) to ${thousands(MAX_READ_GB)}.`
    },
    privateStreamHosts: {
      group: "Reading files",
      label: "Private stream hosts",
      help: "Hosts on a private network that a playing file may be read from, such as a stream proxy on your LAN. Without one, a file is read only from the public internet and your own AIOStreams. Add only a host you run: anything a stream list names there gets read.",
      kind: "hosts",
      hint: "One host per line: a name or an address, with or without a port, like proxy.lan or 192.168.1.9:8080",
      max: MAX_HOSTS
    },
    anidbClient: {
      group: "Anime",
      label: "AniDB client",
      help: "The name of a client registered for AniDB's HTTP API (anidb.net, Add Project). With a name and a version, an anime that gets no season map from the Anime Kitsu addon gets one from AniDB's titles. Empty: AniDB is never asked.",
      kind: "name",
      links: [["anidb.net", "https://anidb.net/"]],
      hint: "Lower-case letters and digits, set together with the version",
      invalid: "Lower-case letters and digits, up to 32, or empty for none."
    },
    anidbClientVer: {
      group: "Anime",
      label: "AniDB client version",
      help: "The version number AniDB has for that client. It is saved and reset together with the name.",
      kind: "number",
      min: 1,
      max: 999_999,
      whole: true,
      optional: true,
      hint: "A whole number, usually 1",
      invalid: "A whole number from 1 to 999,999, or empty for none."
    },
    animeTitlesDataset: {
      group: "Anime",
      label: "Anime titles dataset",
      help: "Season titles from the anime-offline-database, for an anime AniDB hasn't answered for or when no client is set. It is downloaded from GitHub when a show first needs it. Turn it off to make no such download.",
      kind: "toggle",
      links: [["anime-offline-database", "https://github.com/manami-project/anime-offline-database"]],
      switchLabel: "Use the anime-offline-database",
      onText: "On: downloaded when first needed, then looked up once a day at most.",
      offText: "Off: never downloaded. Season titles come from AniDB only, when a client is set."
    },
    maxPerLanguage: {
      group: "Lists and timing",
      label: "Most subtitles per language",
      help: "The most subtitles any configuration may list for one language. Each one listed is downloaded and timed on every play, so more costs each key's downloads and this server's work. A configuration that asks for more gets this many.",
      kind: "number",
      unit: "a language",
      min: RANGES.maxPerLanguage[0],
      max: RANGES.maxPerLanguage[1],
      whole: true,
      hint: `From ${RANGES.maxPerLanguage[0]} to ${RANGES.maxPerLanguage[1]}`,
      invalid: `A whole number from ${RANGES.maxPerLanguage[0]} to ${RANGES.maxPerLanguage[1]}.`
    },
    listBudgetMs: {
      group: "Lists and timing",
      label: "List time limit",
      help: "How long a subtitle list may take before it answers with what it has. This addon's timeout in AIOStreams must be at least this plus 2,500 ms, or AIOStreams drops the whole list: Add to AIOStreams on the configure page sets it. Raise both together when lists come back short.",
      kind: "number",
      unit: "ms",
      min: budgetLow,
      max: budgetHigh,
      whole: true,
      invalid: `Whole milliseconds, from ${thousands(budgetLow)} to ${thousands(budgetHigh)}.`
    },
    resultCacheTtlSeconds: {
      group: "Lists and timing",
      label: "Search results kept for",
      help: "How long a subtitle search's results are reused before the sources are asked again. Shorter finds new subtitles sooner and spends more of each key's allowance.",
      kind: "duration"
    },
    timeZone: { group: "Lists and timing", label: "Time zone", help: "The clock every time on this dashboard is shown in. Days are still counted in UTC.", kind: "zone" },
    logDays: {
      group: "Logs and updates",
      label: "Log days kept",
      help: "Days of log files kept in the cache folder, today included, so the log outlives an update. Fewer days delete the older files at once; 0 writes none.",
      kind: "number",
      unit: "days",
      min: RANGES.logDays[0],
      max: RANGES.logDays[1],
      whole: true,
      zero: "no log files",
      hint: `From 0 (no log files) to ${RANGES.logDays[1]}`,
      invalid: `Whole days, from 0 (no log files) to ${RANGES.logDays[1]}.`
    },
    logMaxMb: {
      group: "Logs and updates",
      label: "Log size limit",
      help: "The most the log files take together. Past it, the oldest day is deleted first, and a day that fills it alone stops being written until the next.",
      kind: "number",
      unit: "MB",
      min: RANGES.logMaxMb[0],
      max: RANGES.logMaxMb[1],
      hint: `From ${RANGES.logMaxMb[0]} to ${thousands(RANGES.logMaxMb[1])}`,
      invalid: `A number of MB, from ${RANGES.logMaxMb[0]} to ${thousands(RANGES.logMaxMb[1])}.`
    },
    updateCheck: {
      group: "Logs and updates",
      label: "Check for updates",
      help: "Once a day, asks GitHub whether a newer BttrSubs is out, and says so in the sidebar. It sends nothing about this server. Updating is still yours to do.",
      kind: "toggle",
      switchLabel: "Ask GitHub once a day",
      onText: "On: a newer release shows in the sidebar. Nothing about this server is sent.",
      offText: "Off: nothing is asked. New releases are on the project's releases page."
    }
  };
  return views.map((v) => {
    const words = WORDS[v.key];
    const base = { key: v.key, env: v.env, source: v.source, resetTo: v.resetTo, ...words };
    if (words.kind === "switch" || words.kind === "toggle") return { ...base, value: v.value ? "on" : "off", resetValue: v.resetValue };
    if (v.key === "resultCacheTtlSeconds") {
      const now = inUnit(Number(v.value));
      const reset = inUnit(Number(v.resetValue));
      return { ...base, value: now.value, unit: now.unit, resetValue: reset.value, resetUnit: reset.unit };
    }
    // A number that may be left out is 0 in settings.ts and an empty field on the page.
    if (words.kind === "number") return words.optional ? { ...base, value: Number(v.value) || "", resetValue: Number(v.resetValue) || "" } : { ...base, value: Number(v.value), resetValue: Number(v.resetValue) };
    if (words.kind === "key") return { ...base, value: "", set: Boolean(v.value), resetValue: v.resetValue };
    return { ...base, value: String(v.value), resetValue: v.resetValue };
  });
}

/** What the settings' own sections show beside them, read-only: the day's reads against their limit, and AniDB's line. */
interface SettingsStatus {
  reads: { todayBytes: number; limitBytes: number; paused: Array<{ host: string; pausedForMs: number }> };
  anidb: AnidbState;
}
type AnidbState = Awaited<ReturnType<typeof anidbNow>>;

/** AniDB's line with nothing read from disk: whether a client is set, and the most a day allows. */
const anidbUnread = (): AnidbState => ({ configured: anidbConfigured(), askedToday: 0, dailyMax: anidbPace.dailyMax, stoppedForMs: 0 });

export function settingsStatus(anidb: AnidbState = anidbUnread(), now = Date.now()): SettingsStatus {
  const reads = readsNow(now);
  return {
    reads: { todayBytes: reads.todayBytes, limitBytes: reads.limitBytes, paused: reads.hosts.filter((h) => h.pausedForMs > 0).map((h) => ({ host: h.host, pausedForMs: h.pausedForMs })) },
    anidb: { ...anidb, configured: anidbConfigured() }
  };
}

/** The range the duration control accepts, in seconds (settings.ts checks it again). */
export const DURATION_RANGE = TTL_RANGE;

export interface DashboardData {
  version: string;
  now: number;
  tz: string;
  names: Record<string, string>;
  days: Array<{ date: string; cpuS: number; rx: number; tx: number; peakMb: number; files: number; procS: number; lists: number; downloads: number; apiCalls: number; errors: number }>;
  weekTotal: { cpuS: number; rx: number; tx: number };
  activity: Array<Omit<Activity, "req" | "period">>;
  debugCount: number;
  outcomes: StatsView["outcomes"];
  configs: Array<{
    id: string;
    name: string | null;
    lists: number;
    served: number;
    lastSeen: number;
    languages: string[];
    sources: string[];
    aiostreams: string | null;
    allowMachine: boolean;
    hearingImpaired: "include" | "exclude" | "only";
    skipEmbedded: boolean;
    hideUnsynced: boolean;
    keepAss: boolean;
    dropSounds: boolean;
    signs: boolean;
    ownStyle: boolean;
    styles: number;
    /** Its settings are known here, so it can be configured and its install URL copied. */
    known: boolean;
  }>;
  /** The week's errors: what each happened on, test plays marked, whether its request is still in the activity log and still answered. */
  errors: Array<{ at: number; where: string; message: string; link: string; what?: string; debug?: boolean; inLog?: boolean; answered?: boolean }>;
  /** Playing files AIOStreams' list didn't hold this week: `lost` went out untimed, `recovered` were read through the link an earlier list gave. */
  unlisted: { lost: number; recovered: number };
  /** How many errors the week had, test plays left out: more than the list holds when it keeps only its newest; `errorsMore` when even that is a floor. */
  errorsWeek: number;
  errorsMore: boolean;
  errorsClearedAt: number;
  canUndoClear: boolean;
  activityClearedAt: number;
  canUndoClearActivity: boolean;
  /** Each configuration's own clears: when its errors and its activity were cleared, and whether Undo can bring them back. */
  linkClears: Record<string, { errorsAt: number; canUndoErrors: boolean; activityAt: number; canUndoActivity: boolean }>;
  keys: Array<{ id: string; service: string; tag: string; link: string | null; weekCalls: number; testCalls: number; refused: number; lastAt: number; lastRefusedAt: number; meters: Array<{ label: string; used: number; max: number; note: string }> }>;
  sources: Array<{ id: string; calls: number; downloads: number; failures: number; picked: number; served: number; synced: number }>;
  server: { cores: number; cpuPercent: number | null; memMb: number; memPeakMb: number; containerMemory: boolean; uptimeS: number; cache: { bytes: number; files: number }; disk: { freeBytes: number; totalBytes: number } | null };
  settings: DashboardSetting[];
  settingGroups: readonly string[];
  settingsStatus: SettingsStatus;
  envOnly: Array<{ env: string; set: boolean }>;
  paused: Record<string, number>;
  /** The log files kept (logs.ts): how many days and bytes, and how many days are kept; null when they're off. */
  logs: { days: number; bytes: number; keepDays: number } | null;
  /** This build's newest changelog section, and a newer release when the daily check found one. */
  updates: { notes: ReleaseNotes | null; newer: Release | null; checking: boolean };
}

export function dashboardData(raw: StatsView, now = Date.now(), anidb?: AnidbState): DashboardData {
  // After a clear, nothing from before it counts as an error anywhere on the page; the stored counts stay.
  const view = { ...raw, days: raw.days.map((day) => afterLinkClears(afterClear(day, raw.errorsClearedAt, raw.errorsBase), raw.errorsClearedAt, raw.errorsBase, raw.linkErrors ?? {})) };
  const week = view.days.slice(0, 7);
  const weekTotal: Counters = {};
  for (const day of week) for (const [k, v] of Object.entries(day.total)) weekTotal[k] = (weekTotal[k] ?? 0) + v;
  const today = view.days[0];

  const days = view.days.map((d) => ({
    date: d.date,
    cpuS: cpuSeconds(d.total),
    rx: d.total["net.rx"] ?? 0,
    tx: d.total["net.tx"] ?? 0,
    peakMb: d.peak?.memMb ?? 0,
    files: d.total["sync.files"] ?? 0,
    procS: sum(d.total, "proc.", ".ms") / 1000,
    lists: d.total.lists ?? 0,
    downloads: d.total.downloads ?? 0,
    apiCalls: sum(d.total, "api.") - sum(d.total, "api.", ".fail"),
    errors: sum(d.total, "errors.")
  }));

  const activity = activityWeek().map(({ req: _req, period: _period, ...a }) => a);

  // ---------- keys: each one against its free plan ----------
  // SubSource's free plan (its API docs): 60 calls a minute, 1,800 an hour, 7,200 a day. SubDL's (its
  // dashboard): 2,000 requests and 50 downloads a day, reset at midnight UTC.
  const keyIds = new Set([...Object.keys(view.windows), ...week.flatMap((d) => [...Object.keys(d.keys ?? {}), ...Object.keys(d.debug?.keys ?? {})])]);
  const keys = [...keyIds].sort().map((id) => {
    const [service, tag = ""] = id.split(":");
    const todayUse: KeyUsage = today.keys?.[id] ?? { calls: 0, refused: 0, busiestMinute: 0 };
    const w = view.windows[id] ?? { minute: 0, hour: 0, day: 0 };
    let weekCalls = 0, refused = 0, lastRefusedAt = 0;
    let last: KeyUsage | undefined, owner: KeyUsage | undefined;
    // A key used only in test plays this week has no call counted, but it is still its configuration's.
    let testOwner: KeyUsage | undefined;
    let testCalls = 0;
    for (const day of week) {
      const t = day.debug?.keys?.[id];
      if (t) {
        testCalls += t.calls;
        if (t.link && (!testOwner || (t.lastAt ?? 0) >= (testOwner.lastAt ?? 0))) testOwner = t;
      }
      const u = day.keys?.[id];
      if (!u) continue;
      weekCalls += u.calls;
      refused += u.refused;
      lastRefusedAt = Math.max(lastRefusedAt, u.lastRefusedAt ?? 0);
      if (!last || (u.lastAt ?? 0) > (last.lastAt ?? 0)) last = u;
      if (u.link && (!owner || (u.lastAt ?? 0) >= (owner.lastAt ?? 0))) owner = u;
    }
    // SubSource sends its own count with every reply (x-ratelimit-remaining, -hour, -day), every app on the
    // key included: it is used while its window lasts; before the first reply, or after, BttrSubs' own count.
    const h = last?.headers ?? {};
    const site = (suffix: string, limit: number, windowMs: number): number | undefined => {
      const left = Number(h[`x-ratelimit-remaining${suffix}`]);
      const max = Number(h[`x-ratelimit-limit${suffix}`]) || limit;
      return h[`x-ratelimit-remaining${suffix}`] !== undefined && Number.isFinite(left) && last?.lastAt && now - last.lastAt < windowMs ? max - left : undefined;
    };
    const siteDay = site("-day", 7200, DAY);
    const meters =
      service === "subsource"
        ? [
            { label: "This minute", used: site("", 60, 60_000) ?? w.minute, max: 60, note: todayUse.busiestMinute ? `busiest minute today: ${todayUse.busiestMinute}` : "" },
            { label: "This hour", used: site("-hour", 1800, 3_600_000) ?? w.hour, max: 1800, note: "" },
            { label: "Today", used: siteDay ?? Math.max(w.day, todayUse.calls), max: 7200, note: siteDay !== undefined ? "SubSource's own count" : "" }
          ]
        : service === "subdl"
          ? [
              { label: "Requests today", used: todayUse.calls - (todayUse.downloads ?? 0), max: 2000, note: "" },
              { label: "Downloads today", used: todayUse.downloads ?? 0, max: 50, note: "resets at midnight UTC" }
            ]
          : service === "wyzie" && (h["x-wyzie-plan"] ?? "free") === "free"
            ? [{ label: "Requests today", ...wyzieDay(h, last, todayUse.calls, now) }]
            : [];
    return { id, service, tag, link: owner?.link ?? testOwner?.link ?? null, weekCalls, testCalls, refused, lastAt: last?.lastAt ?? 0, lastRefusedAt, meters };
  });

  // ---------- sources this week ----------
  const used = (s: string) => (weekTotal[`api.${s}`] ?? 0) + (weekTotal[`fetch.${s}`] ?? 0) + (weekTotal[`errors.${s}`] ?? 0) > 0;
  const sources = [
    ...SOURCES.filter((s) => (s !== "addons" && s !== "subtitlecat") || used(s)).map((s) => {
      const w = view.sourceWeek?.[ROW_NAME[s]] ?? { picked: 0, served: 0, synced: 0 };
      return { id: s, calls: weekTotal[`api.${s}`] ?? 0, downloads: weekTotal[`fetch.${s}`] ?? 0, failures: (weekTotal[`api.${s}.fail`] ?? 0) + (weekTotal[`errors.${s}`] ?? 0), ...w };
    }),
    { id: "aiostreams", calls: weekTotal["api.aiostreams"] ?? 0, downloads: 0, failures: 0, picked: 0, served: 0, synced: 0 }
  ];

  // ---------- configurations ----------
  // Every configuration used this week (by the log, or the day counters) or known by its settings; one
  // deleted on the dashboard leaves the list, its history stays in the other sections.
  const gone = new Set(view.deleted ?? []);
  const lastSeen = new Map<string, number>();
  for (const a of activity) lastSeen.set(a.link, Math.max(lastSeen.get(a.link) ?? 0, a.at));
  for (const day of week) for (const [id, c] of Object.entries(day.links)) lastSeen.set(id, Math.max(lastSeen.get(id) ?? 0, c.lastSeen ?? 0));
  const ids = [...new Set([...Object.keys(view.linkWeek ?? {}), ...week.flatMap((d) => Object.keys(d.links)), ...Object.keys(view.settings)])].filter((id) => !gone.has(id));
  const nameOf = (id: string) => view.names[id] ?? view.names[id.split("/")[0]] ?? null;
  const configs = ids
    .map((id) => {
      const set = view.settings[id];
      const w = view.linkWeek?.[id] ?? { lists: 0, served: 0, lastSeen: 0 };
      return {
        id,
        name: nameOf(id),
        lists: w.lists,
        served: w.served,
        lastSeen: lastSeen.get(id) ?? 0,
        languages: set?.languages ?? [],
        sources: set?.sources ?? [],
        aiostreams: set?.aiostreams ?? null,
        allowMachine: set?.allowMachine ?? false,
        hearingImpaired: set?.hearingImpaired ?? "include",
        skipEmbedded: set?.skipEmbedded ?? true,
        hideUnsynced: set?.hideUnsynced ?? false,
        keepAss: set?.keepAss ?? false,
        dropSounds: set?.dropSounds ?? false,
        signs: set?.signs ?? false,
        ownStyle: set?.ownStyle ?? false,
        styles: set?.styles ?? 0,
        known: Boolean(set)
      };
    })
    .sort((a, b) => b.lastSeen - a.lastSeen);

  // ---------- errors: the week's, each with what it happened on and whether its request still answered ----------
  const answered = answeredByRequest();
  const errors = view.errors
    .filter((e) => e.at >= now - 7 * DAY)
    .map((e) => ({ at: e.at, where: e.where, message: e.message, link: e.link ?? "", ...(e.what ? { what: e.what } : {}), ...(e.debug ? { debug: true } : {}), ...(e.inLog ? { inLog: true } : {}), ...(e.req && answered.has(e.req) ? { answered: answered.get(e.req) } : {}) }));
  // The day counters count every error and the list keeps only the newest ERRORS_KEPT, so the week's number
  // is the larger of the two, test plays left out. After a clear this week the counters restart mid-day, so
  // the list is the count, and a full list means at least that many.
  const listed = errors.filter((e) => !e.debug).length;
  const clearedThisWeek = view.errorsClearedAt >= now - 7 * DAY;
  const errorsWeek = clearedThisWeek ? listed : Math.max(sum(weekTotal, "errors.") - (view.debug?.pastErrors ?? 0), listed);

  const n = view.now;
  return {
    version: view.version,
    now,
    tz: config.timeZone,
    names: view.names,
    days,
    weekTotal: { cpuS: cpuSeconds(weekTotal), rx: weekTotal["net.rx"] ?? 0, tx: weekTotal["net.tx"] ?? 0 },
    activity,
    debugCount: view.debug?.activity ?? activity.filter((a) => a.debug).length,
    outcomes: view.outcomes,
    configs,
    errors,
    unlisted: { lost: weekTotal["sync.unlisted"] ?? 0, recovered: weekTotal["sync.unlistedRecovered"] ?? 0 },
    errorsWeek,
    errorsMore: clearedThisWeek && listed >= ERRORS_KEPT,
    errorsClearedAt: view.errorsClearedAt,
    canUndoClear: view.canUndoClear,
    activityClearedAt: view.activityClearedAt ?? 0,
    canUndoClearActivity: view.canUndoClearActivity ?? false,
    linkClears: Object.fromEntries(
      [...new Set([...Object.keys(view.linkErrors ?? {}), ...Object.keys(view.linkActivity ?? {})])].map((id) => {
        const e = view.linkErrors?.[id];
        const a = view.linkActivity?.[id];
        return [id, { errorsAt: e?.at ?? 0, canUndoErrors: Boolean(e?.undo), activityAt: a?.at ?? 0, canUndoActivity: Boolean(a?.undo) }];
      })
    ),
    keys,
    sources,
    server: {
      cores: n.cores,
      cpuPercent: n.cpuPercent ?? null,
      memMb: n.memMb ?? n.rssMb,
      // The day's highest, sampled as memMb is: the container's own high-water mark counts file pages too.
      memPeakMb: Math.max(today.peak?.memMb ?? 0, n.memMb ?? n.rssMb),
      containerMemory: n.memMb !== undefined,
      uptimeS: view.uptimeS,
      cache: n.cache,
      disk: n.disk ?? null
    },
    settings: dashboardSettings(),
    settingGroups: SETTING_GROUPS,
    settingsStatus: settingsStatus(anidb, now),
    envOnly: envOnlyView(),
    paused: view.paused ?? {},
    logs: logSummary(),
    updates: { notes: whatsNew() ?? null, newer: newerRelease(view.version) ?? null, checking: config.updateCheck }
  };
}
