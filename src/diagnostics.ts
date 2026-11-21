/**
 * Diagnostics: one text, put on the clipboard by the dashboard's Copy diagnostics, for troubleshooting.
 * It holds the build and the server, its settings and the sources' state now, and then either one
 * request in full or the recent requests:
 *
 * - One request: its record, what failed during it, every log line it and the work it started left
 *   (req=…, logs.ts), the lines around it that name its file or episode, the same episode's other
 *   requests, and what's kept about the file it played (its readings, its signs).
 * - The recent requests: the newest ones, one line each, and the newest log lines.
 *
 * Nothing in it opens or spends anything, or names anyone: no key, password, token or install URL, and
 * no configuration's name. Configurations go by their ids, keys by their tags, and addresses keep only
 * their host (the log files are written that way, and the activity holds none).
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { feedNow } from "./animetosho.js";
import { cacheKey, cachePath } from "./cache.js";
import { dashboardData, type DashboardData } from "./dashboardData.js";
import { logFiles, logFilesWritten, scrubLine } from "./logs.js";
import { readsNow } from "./reads.js";
import { signsKept } from "./signsjob.js";
import { activityWeek, statsView, type Activity, type ErrorNote } from "./stats.js";
import type { FileAnchors } from "./sync.js";

/** One request's own log lines at most, and the lines around it that name its file or episode. */
const REQUEST_LINES = 400;
const NEARBY_LINES = 150;
/** Around a request, the stretch whose lines may concern it without its id: work it joined that began before it, and what it started after. */
const BEFORE_MS = 2 * 60_000;
const AFTER_MS = 10 * 60_000;
/** The same episode's other requests this long either side of it. */
const EPISODE_MS = 60 * 60_000;
/** Without a request: the newest requests and log lines. */
const RECENT_REQUESTS = 40;
const RECENT_LINES = 200;

const stamp = (t: number) => new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const thousands = (n: number) => Math.round(n).toLocaleString("en-US");
const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

/** A request's record, a field a line: lists one item a line (a track, a source), objects as compact JSON. */
function record(a: Activity): string[] {
  const out = [`kind: ${a.kind} · what: ${a.what} · result: ${a.result} · ms: ${a.ms}${a.debug ? " · test play" : ""}`];
  for (const [key, value] of Object.entries(a.detail ?? {})) {
    if (Array.isArray(value) && value.some((v) => typeof v === "object")) out.push(`${key}:`, ...value.map((v) => `  ${JSON.stringify(v)}`));
    else out.push(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return out.map((line) => `  ${line}`);
}
const span = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const heading = (title: string) => `\n== ${title} ==`;

/** The deployed commit, when the image was built with a REVISION file beside it. */
async function build(): Promise<string | undefined> {
  try {
    return (await readFile(path.join(process.cwd(), "REVISION"), "utf8")).trim().slice(0, 40) || undefined;
  } catch {
    return undefined;
  }
}

/** One request in one line: when, what, how it ended, how long, for whom, from what. */
function oneLine(a: Activity): string {
  const client = a.detail?.client ? ` · ${a.detail.client}` : "";
  return `${stamp(a.at)}  ${a.kind.padEnd(8)} ${a.what} → ${a.result} · ${thousands(a.ms)} ms · ${a.link}${a.debug ? " · test play" : ""}${client}`;
}

/** The kept log lines whose time falls in [from, to], oldest first, every line of every day it spans. */
async function linesBetween(from: number, to: number): Promise<string[]> {
  await logFilesWritten();
  const first = new Date(from).toISOString().slice(0, 10);
  const last = new Date(to).toISOString().slice(0, 10);
  const out: string[] = [];
  for (const f of logFiles()) {
    if (f.day < first || f.day > last) continue;
    let text: string;
    try {
      text = await readFile(f.file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = Date.parse(line.slice(0, 24));
      if (t >= from && t <= to) out.push(line);
    }
  }
  return out;
}

/** The newest `n` kept log lines. */
async function newestLines(n: number): Promise<string[]> {
  await logFilesWritten();
  const out: string[] = [];
  for (const f of logFiles().reverse()) {
    let text: string;
    try {
      text = await readFile(f.file, "utf8");
    } catch {
      continue;
    }
    out.unshift(...text.split("\n").filter(Boolean));
    if (out.length >= n) break;
  }
  return out.slice(-n);
}

/** What's kept about the playing file's readings, the lines themselves left out. */
async function readings(fileRef: string): Promise<string[]> {
  let kept: FileAnchors;
  try {
    kept = JSON.parse(await readFile(cachePath("anchors", `${cacheKey({ kind: "file-anchors", filename: fileRef })}.json`), "utf8")) as FileAnchors;
  } catch {
    return ["Readings: none kept (the file hasn't been read, or they were cleared)."];
  }
  const windows = kept.windows ?? [];
  const lines = windows.reduce((sum, w) => sum + (w.cues?.length ?? 0), 0);
  const langs = kept.trackLangs ? Object.entries(kept.trackLangs).map(([track, lang]) => `${track}:${lang}`).join(", ") : "";
  const subtitleLangs = (kept as { subtitleLangs?: string[] }).subtitleLangs;
  return [
    `Readings: ${kept.source === "index" ? "from the Matroska index" : kept.speechOnly ? "speech only (no subtitle track)" : "windows read"}, duration ${thousands(kept.duration ?? 0)} ms, ${windows.length} windows, ${thousands(lines)} lines`,
    `  timed by track ${kept.track ?? "-"}${kept.image ? " (an image track)" : ""}; other tracks ${kept.others?.join(", ") || "-"}; language tracks ${kept.langTracks?.join(", ") || "-"}${langs ? `; track languages ${langs}` : ""}`,
    `  audio track ${kept.audio ?? "-"} (${kept.audioLang ?? "untagged"}); embedded subtitle languages ${subtitleLangs?.join(", ") || "-"}; rounds ${kept.rounds ?? 0}${kept.bitrate ? `; ${thousands(kept.bitrate / 1000)} kbit/s` : ""}`
  ];
}

/** The build, the server, its settings and the sources' state now. */
function server(data: DashboardData, revision: string | undefined): string[] {
  const s = data.server;
  const reads = readsNow();
  const feed = feedNow();
  const out = [
    heading("Server"),
    `BttrSubs ${data.version}${revision ? `, build ${revision}` : ""} · Node ${process.version} · ${os.platform()} ${os.arch()} · up ${span(s.uptimeS * 1000)} · dashboard clock ${data.tz}`,
    `CPU ${s.cpuPercent === null ? "-" : `${s.cpuPercent}%`} of ${s.cores} cores · memory ${s.memMb} MB (peak ${s.memPeakMb} MB${s.containerMemory ? ", the container's" : ""}) · cache ${mb(s.cache.bytes)} in ${thousands(s.cache.files)} files${s.disk ? ` · disk ${mb(s.disk.freeBytes)} free of ${mb(s.disk.totalBytes)}` : ""}`,
    `Log files: ${data.logs ? `${data.logs.days} days, ${mb(data.logs.bytes)}, ${data.logs.keepDays} days kept` : "off (LOG_DAYS=0): no log lines below"}`,
    `File reads today: ${mb(reads.todayBytes)}${reads.limitBytes > 0 ? ` of ${mb(reads.limitBytes)}` : ", no daily limit"}`,
    ...reads.hosts.map((h) => `  host ${h.host}: refused (${h.status ?? "-"}), ${h.refusals} in a row${h.pausedForMs ? `, paused ${span(h.pausedForMs)} more` : ""}`),
    `Anime Tosho's line now: waiting ${feed.waiting.first} first / ${feed.waiting.signs} signs / ${feed.waiting.later} later, ${feed.inFlight} in flight, ${feed.allowance} allowed at once${feed.refusedForMs ? `, refused for ${span(feed.refusedForMs)} more` : ""}`,
    ...(data.updates.newer ? [`A newer release is out: ${data.updates.newer.version}`] : []),
    heading("Settings"),
    ...data.settings.map((x) => `${x.label} (${x.env}): ${String(x.value).replace(/\n/g, ", ") || "-"}${x.unit ? ` ${x.unit}` : ""} [${x.source}]`),
    `Set in the environment: ${data.envOnly.map((e) => `${e.env} ${e.set ? "set" : "unset"}`).join(", ")}`,
    heading("API keys this week (by tag)"),
    ...(data.keys.length
      ? data.keys.map((k) => `${k.service} ${k.tag}${k.link ? ` (${k.link})` : ""}: ${thousands(k.weekCalls)} calls, ${k.refused} refused${k.lastRefusedAt ? ` (last ${stamp(k.lastRefusedAt)})` : ""}${k.meters.length ? `; ${k.meters.map((m) => `${m.label} ${m.used}/${m.max}${m.note ? ` ${m.note}` : ""}`).join("; ")}` : ""}`)
      : ["none"]),
    heading("Sources this week"),
    ...data.sources.map((x) => `${x.id}: ${thousands(x.calls)} calls, ${thousands(x.downloads)} downloads, ${x.failures} failures; picked ${x.picked}, served ${x.served}, synced ${x.synced}`)
  ];
  const paused = Object.keys(data.paused);
  if (paused.length) out.push(`Paused configurations: ${paused.join(", ")}`);
  return out;
}

/** A configuration as the dashboard describes it, by its id: never its name, its keys or its AIOStreams address past the host. */
function configuration(data: DashboardData, link: string): string[] {
  const c = data.configs.find((x) => x.id === link);
  if (!c) return [heading(`Configuration ${link}`), "Not known on this server (its settings were never seen here, or it was deleted)."];
  return [
    heading(`Configuration ${c.id}`),
    `Languages: ${c.languages.join(", ") || "-"} · sources: ${c.sources.join(", ") || "-"} · AIOStreams ${c.aiostreams ?? "-"}`,
    `Machine translations ${c.allowMachine ? "on" : "off"} · hearing impaired ${c.hearingImpaired} · skip embedded ${c.skipEmbedded ? "on" : "off"} · hide unsynced ${c.hideUnsynced ? "on" : "off"} · keep ASS ${c.keepAss ? "on" : "off"} · drop sounds ${c.dropSounds ? "on" : "off"} · signs ${c.signs ? "on" : "off"} · file's style ${c.ownStyle ? "on" : "off"} · raised styles ${c.styles}`,
    `This week: ${c.lists} lists, ${c.served} served; last seen ${c.lastSeen ? stamp(c.lastSeen) : "never"}`
  ];
}

function errorLines(list: Array<Pick<ErrorNote, "at" | "where" | "message" | "link" | "what">>): string[] {
  return list.length ? list.map((e) => `${stamp(e.at)}  ${e.where}${e.link ? ` (${e.link})` : ""}${e.what ? ` on ${e.what}` : ""}: ${e.message}`) : ["none"];
}

/**
 * The diagnostics text: for one request (its time and configuration, as the dashboard's activity gives
 * them) or, without one, for the server and its recent requests.
 */
export async function diagnosticsText(version: string, request?: { at: number; link: string }): Promise<string> {
  const view = await statsView(version);
  const data = dashboardData(view);
  const revision = await build();
  const now = Date.now();
  const out = [
    `BttrSubs diagnostics · generated ${stamp(now)}`,
    "Contains no API keys, passwords, tokens, install URLs or configuration names. URLs are reduced to their host.",
    `Scope: ${request ? `one request (configuration ${request.link}, ${stamp(request.at)})` : "server state and recent requests"}`
  ];
  const week = activityWeek();
  const a = request ? week.find((x) => x.at === request.at && x.link === request.link) : undefined;

  if (request && !a) out.push("", "The request is no longer in the activity log (cleared, or older than 7 days). Server state follows.");
  if (a) {
    const d = a.detail ?? {};
    const fileRef = d.file ? (d.size ? `${d.file}/${d.size}` : d.file) : undefined;
    out.push(
      heading("Request"),
      oneLine(a),
      `Request id ${a.req ?? "- (recorded before request ids)"} · ran ${stamp(a.at - a.ms)} to ${stamp(a.at)}`,
      "Record:",
      ...record(a)
    );
    const noted = view.errors.filter((e) => a.req && e.req === a.req);
    out.push(heading("Errors during the request"), ...errorLines(noted));

    const sameEpisode = week
      .filter((x) => x !== a && Math.abs(x.at - a.at) <= EPISODE_MS && ((d.video && x.detail?.video === d.video) || x.what === a.what))
      .sort((x, y) => x.at - y.at);
    out.push(heading("Other requests for this episode (within 1 h)"), ...(sameEpisode.length ? sameEpisode.map(oneLine) : ["none"]));

    const around = await linesBetween(a.at - a.ms - BEFORE_MS, a.at + AFTER_MS);
    const tag = a.req ? ` req=${a.req} ` : undefined;
    const own = tag ? around.filter((l) => l.includes(tag)) : [];
    const names = [d.video, d.file && scrubLine(d.file)].filter((x): x is string => Boolean(x));
    const nearby = around.filter((l) => (!tag || !l.includes(tag)) && names.some((n) => l.includes(n)));
    out.push(
      heading(`Log lines for this request (${own.length}${own.length > REQUEST_LINES ? `, first ${REQUEST_LINES} shown` : ""})`),
      ...(own.length ? own.slice(0, REQUEST_LINES) : [data.logs ? "none with its id" : "log files are off"]),
      heading(`Related log lines naming the file or episode, ${span(BEFORE_MS)} before to ${span(AFTER_MS)} after (${nearby.length}${nearby.length > NEARBY_LINES ? `, last ${NEARBY_LINES} shown` : ""})`),
      ...(nearby.length ? nearby.slice(-NEARBY_LINES) : ["none"])
    );

    if (fileRef) {
      out.push(heading("Played file"), `${d.file}${d.size ? ` · ${thousands(d.size)} bytes` : ""}${d.video ? ` · ${d.video}` : ""}`, ...(await readings(fileRef)));
      if (d.video) {
        const signs = await signsKept(d.video, fileRef);
        out.push(
          signs
            ? `Signs kept: ${signs.found ? `${signs.events ?? "?"} from "${signs.signsName}" of ${signs.release}${signs.signs === signs.partner ? " (a full track's)" : ""}, ${signs.settled === false ? "a signs track still looked for" : "settled"}` : "none found"}, ${stamp(signs.at)}`
            : "Signs kept: none (not looked for, or signs are off)"
        );
      }
    }
    out.push(...configuration(data, a.link));
  } else {
    const recent = week
      .filter((x) => !request || x.link === request.link)
      .sort((x, y) => y.at - x.at)
      .slice(0, RECENT_REQUESTS);
    out.push(heading(`Recent requests (${recent.length})`), ...(recent.length ? recent.map(oneLine) : ["none in the last 7 days"]));
    const lines = await newestLines(RECENT_LINES);
    out.push(heading(`Recent log lines (${lines.length})`), ...(lines.length ? lines : [data.logs ? "none" : "log files are off"]));
  }

  out.push(heading("Errors this week (newest first)"), ...errorLines(data.errors));
  out.push(...server(data, revision));
  return `${out.join("\n")}\n`;
}
