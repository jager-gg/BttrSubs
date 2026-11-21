/**
 * Regional kinds of one language that subtitle sites mostly file under the language itself.
 *
 * Spanish is two written standards on screen: Spain's, and Latin America's. Most sites have one
 * "Spanish"; the few with a tag for either carry it on a small share of their uploads. So a track
 * for one kind is filled from everything filed as Spanish, and each subtitle's kind is told from
 * what is known of it, cheapest first:
 *
 * - the site's own tag (the subtitle's language is the kind's);
 * - a mark in its release names or notes ("lat", "Latino", "Europeo", "Español (España)");
 * - its own words, once the file is downloaded (spanishKind).
 *
 * A subtitle marked or written as the other kind is not served on the track; one that says nothing
 * either way is.
 */
import { readFile } from "node:fs/promises";
import { dialogueText } from "./subtitlecat.js";
import { decodeSubtitle } from "./text.js";
import type { SubSourceSubtitle } from "./types.js";

const LATIN_AMERICA_MARK = /(?:^|[^a-z])(?:lat|latino|latina|latam|latinoam[eé]rica(?:no)?|hispanoam[eé]rica(?:no)?|es[-_. ]?(?:419|mx|la)|m[eé]xic(?:o|ano))(?:[^a-z]|$)/i;
const SPAIN_MARK = /(?:^|[^a-z])(?:europeo|europea|castellano|castilian|espa[ñn]a|es[-_. ]?es|spain)(?:[^a-z]|$)/i;

interface Variant {
  /** The language sites file it under. */
  base: string;
  /** Its name as a player shows it. */
  label: string;
  /** What spanishKind calls it. */
  kind: "spain" | "america";
  /** A mark of this kind in a release name or note, and a mark of the other. */
  own: RegExp;
  other: RegExp;
}

/** The kinds, by the language name a configuration holds (lower case, as OpenSubtitles names them). */
export const VARIANTS: Record<string, Variant> = {
  "spanish (la)": { base: "spanish", label: "Spanish (Latin America)", kind: "america", own: LATIN_AMERICA_MARK, other: SPAIN_MARK },
  "spanish (eu)": { base: "spanish", label: "Spanish (Spain)", kind: "spain", own: SPAIN_MARK, other: LATIN_AMERICA_MARK },
};

const variantOf = (language: string | undefined): Variant | undefined => (language ? VARIANTS[language.trim().toLowerCase()] : undefined);

/** The language a kind is filed under ("spanish (la)" -> "spanish"), or none for a language with no kinds. */
export function baseLanguage(language: string): string | undefined {
  return variantOf(language)?.base;
}

/** A language's name as a player shows it: a kind's full name, else the name as it is. */
export function languageLabel(language: string): string {
  return variantOf(language)?.label ?? language;
}

/** Whether a subtitle belongs to a track's pool: filed under the track's language, or under the language its kind is filed under. */
export function filedUnder(subtitle: { language?: string | null }, language: string): boolean {
  return subtitle.language === language || (subtitle.language !== undefined && subtitle.language === baseLanguage(language));
}

/** What a subtitle's tag, release names and notes say of its kind, for a track of `language`. */
function markedAs(subtitle: SubSourceSubtitle, language: string, variant: Variant): "own" | "other" | undefined {
  if (subtitle.language === language) return "own";
  if (Object.keys(VARIANTS).some((name) => name !== language && subtitle.language === name)) return "other";
  const said = [...(subtitle.releaseInfo ?? []), subtitle.commentary ?? ""].join(" \n ");
  const own = variant.own.test(said);
  const other = variant.other.test(said);
  return own === other ? undefined : own ? "own" : "other";
}

/**
 * A kind's candidates in order: the ones marked as it first, then the ones that say nothing, each
 * group as it was ranked; the ones marked as the other kind are left out. A language with no kinds
 * keeps its list as it is.
 */
export function forVariant<T extends SubSourceSubtitle>(subtitles: T[], language: string): T[] {
  const variant = variantOf(language);
  if (!variant) return subtitles;
  const marks = subtitles.map((subtitle) => markedAs(subtitle, language, variant));
  const ordered = [...subtitles.filter((_, i) => marks[i] === "own"), ...subtitles.filter((_, i) => marks[i] === undefined)];
  // A source asked for the kind and for the language it is filed under can give one subtitle twice: once is enough.
  const seen = new Set<string>();
  return ordered.filter((subtitle) => {
    const id = `${subtitle.source ?? ""}|${subtitle.ref ?? subtitle.subtitleId}`;
    return seen.has(id) ? false : (seen.add(id), true);
  });
}

/**
 * Forms only Spain's Spanish uses: the second person plural's pronouns and verb endings. Its
 * commands ("sentaos", "poneos") are left out: they end as plural nouns do ("deseos", "paseos").
 */
const SPAIN_FORMS = /\b(?:vosotr[oa]s|vuestr[oa]s?|sois|hab[eé]is|est[aá]is|ten[eé]is|pod[eé]is|quer[eé]is|sab[eé]is|vais|hac[eé]is|dec[ií]s|ven[ií]s|[a-zñ]{2,}[áé]is)\b/gi;
/** "os" before a word: Spain's "you" as an object ("os digo"). */
const SPAIN_OS = /(?:^|[\s¿¡,.;:"'-])os\s+[a-zñáéíóú]+/gi;
/** Latin America's plural "you", which Spain keeps for formal speech. */
const USTEDES = /\bustedes\b/i;
/** Too few words to tell a kind by. */
const MIN_WORDS = 500;
/**
 * Spain's forms per 1,000 words at or above which a subtitle is Spain's.
 * Calibration (2026-11-21 UTC, 55 Spanish subtitles of one film and one episode): the ones named or
 * tagged Latin American, and the ones worded like them, had 0 to 0.15 per 1,000 words and "ustedes"
 * in all but two; the ones named European, and the ones worded like them, had 0.58 to 9.5 and
 * "ustedes" once at most.
 */
const SPAIN_PER_THOUSAND = 0.35;
/** Spain's forms a subtitle must hold to be called Spain's, however short it is. */
const SPAIN_MIN_FORMS = 3;
/** Words from which a subtitle with "ustedes" and next to none of Spain's forms is Latin America's. */
const AMERICA_MIN_WORDS = 2000;

/** Which Spanish a subtitle's text is written in, or undefined when its words don't say. */
export function spanishKind(text: string): "spain" | "america" | undefined {
  const body = dialogueText(text);
  const words = body.match(/[a-zñáéíóúü]+/gi)?.length ?? 0;
  if (words < MIN_WORDS) return undefined;
  const forms = (body.match(SPAIN_FORMS)?.length ?? 0) + (body.match(SPAIN_OS)?.length ?? 0);
  const rate = (forms / words) * 1000;
  if (forms >= SPAIN_MIN_FORMS && rate >= SPAIN_PER_THOUSAND) return "spain";
  if (rate < SPAIN_PER_THOUSAND && words >= AMERICA_MIN_WORDS && USTEDES.test(body)) return "america";
  return undefined;
}

/** Each stored file's kind, read once: a file never changes under its name. */
const kinds = new Map<string, ReturnType<typeof spanishKind>>();
const MAX_KEPT = 5000;

/**
 * Whether a stored subtitle is written in the other kind than its track's: Spain's on a Latin
 * American track, or the reverse. False for a track with no kind, and for a file whose words don't say.
 */
export async function otherKind(file: string, language: string | undefined): Promise<boolean> {
  const variant = variantOf(language);
  if (!variant) return false;
  let kind = kinds.get(file);
  if (!kinds.has(file)) {
    kind = await readFile(file).then(
      (raw) => spanishKind(decodeSubtitle(raw, variant.base)),
      () => undefined
    );
    kinds.set(file, kind);
    while (kinds.size > MAX_KEPT) kinds.delete(kinds.keys().next().value!);
  }
  return kind !== undefined && kind !== variant.kind;
}
