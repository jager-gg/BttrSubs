/**
 * Subtitles kept on this server: files its operator put in a folder (CAPTIONS_DIR), listed for the
 * video they are named for like any source's, and synced to the playing file like any other. For
 * subtitles no source carries, such as a broadcast's captions of a dub pulled out of its video file.
 *
 * One folder a title, named by its IMDb id; in it one file an episode, or one for a film:
 *
 *   captions/tt0000001/S03E02.en.dub.srt   English captions of the dub, season 3 episode 2
 *   captions/tt0000001/S03E02.es.ass       a Spanish subtitle for the same episode
 *   captions/tt0000002/film.en.srt         a film's English subtitle
 *
 * The language is a two or three letter code (English when left out); ".dub" marks captions that
 * follow the dub's words, which English Dub lists.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { languageName } from "./langcodes.js";
import type { StremioSubtitleRequest, SubSourceSubtitle } from "./types.js";

const NAME = /^(?:s(\d{1,2})e(\d{1,4})|(film))(?:\.([a-z]{2,3}))?(\.dub)?\.(srt|ass|ssa|vtt)$/i;
/** A subtitle file is far smaller; anything bigger isn't read. */
const MAX_BYTES = 10_000_000;

/** Where the kept files are: CAPTIONS_DIR as given when absolute, else inside the working folder. */
const folder = () => path.resolve(process.cwd(), config.captionsDir);

/** The kept files found so far, by their ref. */
const known = new Map<string, string>();

/** A ref that changes when the file does, so a replaced file isn't served from an old copy. */
function refOfFile(relative: string, size: number, mtimeMs: number): string {
  return `kc${createHash("sha256").update(`${relative}|${size}|${Math.round(mtimeMs)}`).digest("hex").slice(0, 16)}`;
}

interface KeptFile {
  ref: string;
  file: string;
  season?: number;
  episode?: number;
  language: string;
  dub: boolean;
}

/** One title's kept files; none when it has no folder. */
async function filesOf(imdbId: string): Promise<KeptFile[]> {
  const dir = path.join(folder(), imdbId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: KeptFile[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const language = languageName(m[4] ?? "en");
    if (!language) continue;
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size === 0 || info.size > MAX_BYTES) continue;
    const ref = refOfFile(`${imdbId}/${name.toLowerCase()}`, info.size, info.mtimeMs);
    known.set(ref, file);
    files.push({ ref, file, season: m[3] ? undefined : Number(m[1]), episode: m[3] ? undefined : Number(m[2]), language, dub: Boolean(m[5]) });
  }
  return files;
}

/** The kept subtitles for this video in the wanted languages. */
export async function keptSubtitles(request: StremioSubtitleRequest, wanted: string[]): Promise<SubSourceSubtitle[]> {
  const imdbId = request.imdbId ?? "";
  if (!/^tt\d{1,12}$/.test(imdbId)) return [];
  const series = request.type === "series";
  const mine = (await filesOf(imdbId)).filter((f) => wanted.includes(f.language) && (series ? f.season === request.season && f.episode === request.episode : f.season === undefined));
  return mine.map((f) => {
    const at = series ? `S${String(f.season).padStart(2, "0")}E${String(f.episode).padStart(2, "0")}` : "Film";
    return {
      subtitleId: 0,
      movieId: 0,
      ref: f.ref,
      source: "kept" as const,
      language: f.language,
      // Named the way uploaders name dub captions, so the same rules read it (matching.ts).
      releaseInfo: [f.dub ? `${at}.Eng.Dubbed.Version.CC` : at],
      commentary: f.dub ? "Official captions of the dub, kept on this server" : "Kept on this server",
      files: 1,
      episodeTrusted: true,
      hearingImpaired: f.dub,
      downloads: 0
    };
  });
}

/** A kept subtitle's bytes, by its ref: found again on disk when this process hasn't listed it. */
export async function readKept(ref: string): Promise<Buffer> {
  if (!known.has(ref)) {
    for (const title of await readdir(folder()).catch(() => [] as string[])) {
      if (/^tt\d{1,12}$/.test(title)) await filesOf(title);
      if (known.has(ref)) break;
    }
  }
  const file = known.get(ref);
  if (!file) throw new Error(`unknown subtitle ${ref}`);
  return readFile(file);
}

/** For tests: forgets the files found so far. */
export function resetKept(): void {
  known.clear();
}
