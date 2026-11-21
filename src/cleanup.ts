/**
 * Keeps the cache from growing for ever: once a day, files nobody has used
 * for KEEP_DAYS are deleted from the caches that rebuild themselves
 * (downloads, unpacked subtitles, synced copies, search results, each file's
 * signs and subtitle tracks). What was read from a playing file (its anchor
 * points, and the sizes it is known under) is kept READINGS_KEEP_DAYS: it is
 * small, and making it again reads the file from its host, where everything
 * else is made again from it and the subtitle with nothing read. The usage
 * counts in cache/stats are never touched.
 *
 * "Used" is the later of a file's last read and last write; the filesystem
 * updates read times at most once a day, which is plenty for rules of weeks.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { cachePath } from "./cache.js";
import { count } from "./stats.js";

export const KEEP_DAYS = 14;
/**
 * How long a playing file's readings are kept unused. Calibration (a server of four configurations):
 * 124 files' readings took 5.1 MB, about 40 KB a file; hearing a file with no subtitle track again
 * reads its audio for 9 to 17 s.
 */
export const READINGS_KEEP_DAYS = 60;
/** Each pruned cache folder, and how many days its files are kept unused. */
const PRUNED: Record<string, number> = {
  downloads: KEEP_DAYS,
  subtitles: KEEP_DAYS,
  synced: KEEP_DAYS,
  results: KEEP_DAYS,
  hashes: KEEP_DAYS,
  signs: KEEP_DAYS,
  anchors: READINGS_KEEP_DAYS,
  aliases: READINGS_KEEP_DAYS
};

/** Deletes files under the pruned caches unused for their folder's days; returns how many and their size. */
export async function pruneCache(now = Date.now()): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string, cutoff: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, cutoff);
        continue;
      }
      try {
        const info = await stat(full);
        if (Math.max(info.atimeMs, info.mtimeMs) < cutoff) {
          await rm(full, { force: true });
          files++;
          bytes += info.size;
        }
      } catch {}
    }
  };
  for (const [name, days] of Object.entries(PRUNED)) await walk(cachePath(name), now - days * 86400_000);
  return { files, bytes };
}

/** Runs the clean-up a minute after start, then every day. */
export function startCleanup(): void {
  const once = async () => {
    const { files, bytes } = await pruneCache();
    count("cache.prunedFiles", files);
    count("cache.prunedBytes", bytes);
    if (files) console.log(`cache: removed ${files} files unused for ${KEEP_DAYS} days, or ${READINGS_KEEP_DAYS} for a playing file's readings (${Math.round(bytes / 1048576)} MB)`);
  };
  setTimeout(() => void once(), 60_000).unref();
  setInterval(() => void once(), 86400_000).unref();
}
