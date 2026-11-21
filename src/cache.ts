/**
 * The on-disk cache. Everything lives under CACHE_DIR, one folder per kind of
 * thing (results, downloads, subtitles, synced, anchors, stats). JSON results
 * carry their own expiry; other files stay until cleanup.ts prunes them.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/** A cached JSON value and the moment (ms) it stops being good. */
type Stored<T> = { expiresAt: number; data: T };

/** A path inside the cache folder: CACHE_DIR as given when absolute, else inside the working folder. */
export function cachePath(...parts: string[]): string {
  return path.resolve(process.cwd(), config.cacheDir, ...parts);
}

/**
 * Writes a file whole or not at all: a temporary file next to it, then a rename over it, so a crash or
 * a full disk never leaves half a file for the next start to read.
 */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

/**
 * The same, without blocking: for files other requests may be reading or looking for meanwhile (a
 * downloaded subtitle, the episode's file taken out of it). A file that exists is whole.
 */
export async function writeFileWhole(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** A stable file name for anything JSON can describe. Existing cache files depend on it never changing. */
export function cacheKey(what: unknown): string {
  return createHash("sha256").update(JSON.stringify(what)).digest("hex");
}

const jsonFile = (folder: string, key: string) => cachePath(folder, `${key}.json`);

/** The value kept under folder/key, or nothing when it's missing, unreadable or past its time. */
export async function readJsonCache<T>(folder: string, key: string): Promise<T | undefined> {
  try {
    const stored = JSON.parse(await readFile(jsonFile(folder, key), "utf8")) as Stored<T>;
    return stored.expiresAt >= Date.now() ? stored.data : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a value under folder/key for ttlSeconds (by default the result lifetime from the config). */
export async function writeJsonCache<T>(folder: string, key: string, data: T, ttlSeconds = config.resultCacheTtlSeconds): Promise<void> {
  await mkdir(cachePath(folder), { recursive: true });
  const stored: Stored<T> = { expiresAt: Date.now() + ttlSeconds * 1000, data };
  await writeFile(jsonFile(folder, key), JSON.stringify(stored), "utf8");
}
