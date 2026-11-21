/** Language names (lower case) to ISO 639-1 codes, as AIOStreams' OpenSubtitles V3+ preset lists them. */
export const LANGUAGE_CODES: Record<string, string> = {
  "afrikaans": "af",
  "belarusian": "be",
  "burmese": "my",
  "abkhazian": "ab",
  "arabic": "ar",
  "armenian": "hy",
  "assamese": "as",
  "asturian": "at",
  "basque": "eu",
  "bengali": "bn",
  "breton": "br",
  "bulgarian": "bg",
  "catalan": "ca",
  "french": "fr",
  "georgian": "ka",
  "german": "de",
  "gaelic": "gd",
  "irish": "ga",
  "galician": "gl",
  "greek": "el",
  "hebrew": "he",
  "hindi": "hi",
  "croatian": "hr",
  "hungarian": "hu",
  "igbo": "ig",
  "icelandic": "is",
  "interlingua": "ia",
  "kazakh": "kk",
  "latvian": "lv",
  "lithuanian": "lt",
  "malayalam": "ml",
  "italian": "it",
  "japanese": "ja",
  "khmer": "km",
  "korean": "ko",
  "kurdish": "ku",
  "macedonian": "mk",
  "marathi": "mr",
  "navajo": "nv",
  "norwegian": "no",
  "occitan": "oc",
  "persian": "fa",
  "polish": "pl",
  "pushto": "ps",
  "russian": "ru",
  "serbian": "sr",
  "slovak": "sk",
  "slovenian": "sl",
  "syriac": "sy",
  "tamil": "ta",
  "montenegrin": "me",
  "chinese bilingual": "ze",
  "sindhi": "sd",
  "spanish": "es",
  "swahili": "sw",
  "swedish": "sv",
  "tatar": "tt",
  "telugu": "te",
  "thai": "th",
  "turkmen": "tk",
  "turkish": "tr",
  "ukrainian": "uk",
  "uzbek": "uz",
  "vietnamese": "vi",
  "welsh": "cy",
  "romanian": "ro",
  "albanian": "sq",
  "aragonese": "an",
  "azerbaijani": "az",
  "bosnian": "bs",
  "czech": "cs",
  "danish": "da",
  "dutch": "nl",
  "english": "en",
  "esperanto": "eo",
  "estonian": "et",
  "finnish": "fi",
  "indonesian": "id",
  "kannada": "kn",
  "luxembourgish": "lb",
  "malay": "ms",
  "manipuri": "ma",
  "mongolian": "mn",
  "nepali": "ne",
  "odia": "or",
  "sinhalese": "si",
  "northern sami": "se",
  "somali": "so",
  "tagalog": "tl",
  "urdu": "ur",
  "portuguese (mz)": "pm",
  "spanish (la)": "ea",
  "extremaduran": "ex",
  "dari": "pr",
  "spanish (eu)": "sp",
  "santali": "sx",
  "toki pona": "tp",
  "chinese (simplified)": "zh-cn",
  "portuguese": "pt-pt",
  "portuguese (br)": "pt-br",
  "chinese (traditional)": "zh-tw",
  "users": "users",
  "all": "all"
};

export function languageCode(name: string): string | undefined {
  return LANGUAGE_CODES[name.trim().toLowerCase()];
}

export function languageName(code: string): string | undefined {
  const c = code.trim().toLowerCase();
  const hit = Object.entries(LANGUAGE_CODES).find(([, v]) => v === c);
  return hit?.[0];
}

/** "ara" or "arabic" -> "Arabic". */
export function languageTitle(code: string): string {
  if (code.length > 3) return `${code.charAt(0).toUpperCase()}${code.slice(1)}`;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(new Intl.Locale(code).language) ?? code;
  } catch {
    return code;
  }
}

/**
 * Whether two language codes or names are one language, regional variants aside: "ita" and
 * "italian", "fre" and "fra", "pt-BR" and "por", "portuguese (br)" and "Portuguese".
 */
export function sameLanguage(a: string, b: string): boolean {
  const base = (code: string) => languageTitle(/^[a-z]{2,3}-/i.test(code) ? code.split("-")[0] : code).toLowerCase().replace(/\s*\(.*\)$/, "");
  return base(a) === base(b);
}
