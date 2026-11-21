/**
 * What's new in this build, and whether a newer release is out, for the dashboard's sidebar.
 *
 * What's new is the changelog shipped with this build (CHANGELOG.md): its newest section, read once at
 * start, so it needs no network.
 *
 * A newer release: once a day (the first a minute after start) this server asks GitHub's public API for
 * the project's latest release. It is a plain GET: it sends no identifier, no count and nothing about this
 * server, its configurations or what was played, and nothing is sent when it's off (Settings, or
 * UPDATE_CHECK=off in .env). Updating stays the owner's: the dashboard only says a release is out.
 */
import { readFileSync } from "node:fs";
import { config } from "./config.js";

/** Where the project's releases are published. */
export const REPOSITORY = "jager-gg/BttrSubs";
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;

export interface ReleaseNotes {
  /** The section's name: a version ("1.1.0") or "Unreleased" for changes since the last release. */
  heading: string;
  items: Array<{ title: string; text: string }>;
}

export interface Release {
  version: string;
  url: string;
  publishedAt: number;
}

/** Markdown inline marks as plain text: bold, code and links keep their words. */
const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();

/** The newest section of a changelog in the Keep a Changelog shape: "## [1.1.0]", then "- **Title:** text" lines. */
export function newestNotes(changelog: string): ReleaseNotes | undefined {
  const sections = changelog.split(/^## \[/m).slice(1);
  const first = sections[0];
  if (!first) return undefined;
  const heading = first.slice(0, first.indexOf("]"));
  const items = first
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const titled = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(line);
      return titled ? { title: plain(titled[1]).replace(/[:,]$/, ""), text: plain(titled[2]) } : { title: "", text: plain(line.slice(2)) };
    });
  return items.length ? { heading, items } : undefined;
}

let notes: ReleaseNotes | undefined | null = null;

/** This build's newest changelog section, read once; undefined when the changelog isn't shipped with it. */
export function whatsNew(): ReleaseNotes | undefined {
  if (notes === null) {
    try {
      notes = newestNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
    } catch {
      notes = undefined;
    }
  }
  return notes;
}

/** "v1.2.3" or "1.2.3" as numbers; undefined for anything else. */
export function versionOf(text: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = versionOf(candidate);
  const b = versionOf(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let latest: Release | undefined;

/** The latest release when it's newer than this build, from the last daily check. */
export function newerRelease(current: string): Release | undefined {
  return config.updateCheck && latest && isNewer(latest.version, current) ? latest : undefined;
}

/** Asks GitHub for the latest release once; nothing is kept when the answer isn't one (none yet, or unreachable). */
export async function checkForUpdate(fetchRelease: typeof fetch = fetch): Promise<void> {
  if (!config.updateCheck) return;
  try {
    const response = await fetchRelease(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "BttrSubs" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return;
    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown };
    const version = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
    if (!versionOf(version) || body.draft === true || body.prerelease === true) return;
    const url = typeof body.html_url === "string" && body.html_url.startsWith(`https://github.com/${REPOSITORY}/`) ? body.html_url : `https://github.com/${REPOSITORY}/releases/latest`;
    latest = { version, url, publishedAt: Date.parse(String(body.published_at)) || 0 };
  } catch {
    // Unreachable for now: the next day's check tries again.
  }
}

/** Starts the daily check (server.ts). */
export function startUpdateChecks(): void {
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_MS).unref();
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS).unref();
}

/** For tests: forgets the last check. */
export function resetUpdates(): void {
  latest = undefined;
  notes = null;
}
