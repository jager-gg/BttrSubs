/**
 * Turns at hearing a file's audio, per AIOStreams configuration. A file with no subtitle track is timed
 * by speech heard at a few spots, read from wherever the file is served; a server that fetches what's
 * read from its own source first (a usenet engine) shares that source's speed among everything read at
 * once. A player that asks ahead for the next episode's subtitles starts that file's hearing beside the
 * one being watched, and both are then ready later than the watched one alone would be. So one file is
 * heard at a time per configuration, in the order their lists came, and a file a download is waiting
 * on (someone is watching it) is heard at once, whatever else is being heard.
 */

/** Files a download asked for lately, by name without the size, and when. */
const watched = new Map<string, number>();
/** A download keeps its file first this long: a first play's hearing is over well within it. */
const WATCHED_MS = 10 * 60 * 1000;
/** A file waits for its turn at most this long, so a hearing that hangs holds nobody up for good. */
export const MAX_TURN_WAIT_MS = 30_000;

interface Line {
  hearing: Set<string>;
  waiting: Array<{ file: string; start: () => void }>;
}
const lines = new Map<string, Line>();

const nameOf = (file: string) => file.replace(/\/\d+$/, "");

export function isWatched(file: string, now = Date.now()): boolean {
  const at = watched.get(nameOf(file));
  return at !== undefined && now - at < WATCHED_MS;
}

/** A download asked for this file: it is heard at once, and one waiting for its turn starts now. */
export function watching(file: string, now = Date.now()): void {
  for (const [name, at] of watched) if (now - at >= WATCHED_MS) watched.delete(name);
  watched.set(nameOf(file), now);
  for (const line of lines.values()) {
    const i = line.waiting.findIndex((w) => nameOf(w.file) === nameOf(file));
    if (i >= 0) line.waiting.splice(i, 1)[0].start();
  }
}

/**
 * Waits for the file's turn at hearing under this configuration (`key`), then returns how long it
 * waited and what to call when its hearing is done (which lets the next file in).
 */
export async function hearingTurn(key: string, file: string): Promise<{ waitedMs: number; done: () => void }> {
  const line = lines.get(key) ?? { hearing: new Set<string>(), waiting: [] };
  lines.set(key, line);
  const started = Date.now();
  if (line.hearing.size > 0 && !isWatched(file)) {
    await new Promise<void>((resolve) => {
      // Counted as heard from the moment its turn comes, so nothing else slips in before it.
      const begin = () => {
        clearTimeout(timer);
        line.hearing.add(file);
        resolve();
      };
      const entry = { file, start: begin };
      const timer = setTimeout(() => {
        const i = line.waiting.indexOf(entry);
        if (i >= 0) line.waiting.splice(i, 1);
        begin();
      }, MAX_TURN_WAIT_MS);
      line.waiting.push(entry);
    });
  }
  line.hearing.add(file);
  let finished = false;
  return {
    waitedMs: Date.now() - started,
    done: () => {
      if (finished) return;
      finished = true;
      line.hearing.delete(file);
      if (line.hearing.size === 0) line.waiting.shift()?.start();
      if (line.hearing.size === 0 && line.waiting.length === 0) lines.delete(key);
    }
  };
}

/** For tests: forget every turn and every watched file. */
export function resetTurns(): void {
  watched.clear();
  lines.clear();
}
