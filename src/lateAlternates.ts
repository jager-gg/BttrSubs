/**
 * Subtitles a source offered after a list had gone out, as fallbacks for that list's tracks.
 *
 * A list answers within its time and names each track's fallbacks in its download link, so a source
 * that answers a moment later adds nothing to the play in progress: its subtitles reach only the next
 * list. When every subtitle a track listed fails to fit the file, those late ones are the candidates
 * left, so they are kept here, by configuration, title and track, and a download tries them after the
 * ones its link names.
 *
 * Kept in memory for as long as a player may still hold the list. After a restart the next list has
 * them from the source's kept answer.
 */
export interface LateAlternate {
  ref: string;
  season?: number;
  episode?: number;
  pick?: number;
}

/** How long a title's late fallbacks are kept: past the longest a player keeps one list for. */
const KEPT_MS = 6 * 60 * 60_000;
/** Late fallbacks kept for one track at most. */
export const LATE_ALTERNATES = 6;
/** Tracks remembered at most; the one noted longest ago goes first. */
const MAX_KEPT = 5000;

const late = new Map<string, { at: number; alts: LateAlternate[] }>();
const keyOf = (configuration: string, videoId: string, language: string | undefined) => `${configuration}\n${videoId}\n${language ?? ""}`;

/** Adds a late source's subtitles to a track's fallbacks, in the order given, each once. `language` is the track's, none for dub captions. */
export function noteLateAlternates(configuration: string, videoId: string, language: string | undefined, alts: LateAlternate[]): void {
  if (alts.length === 0) return;
  const key = keyOf(configuration, videoId, language);
  const kept = late.get(key);
  const fresh = kept && Date.now() - kept.at < KEPT_MS ? kept.alts : [];
  const merged = [...fresh, ...alts.filter((a) => !fresh.some((k) => k.ref === a.ref))].slice(0, LATE_ALTERNATES);
  late.delete(key);
  late.set(key, { at: Date.now(), alts: merged });
  while (late.size > MAX_KEPT) late.delete(late.keys().next().value!);
}

/** The late fallbacks kept for a track. */
export function lateAlternates(configuration: string, videoId: string, language: string | undefined): LateAlternate[] {
  const kept = late.get(keyOf(configuration, videoId, language));
  return kept && Date.now() - kept.at < KEPT_MS ? kept.alts : [];
}

/** For tests: forget them all. */
export function forgetLateAlternates(): void {
  late.clear();
}
