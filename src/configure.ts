/**
 * The configure flow's server side. The page is opened bare (/configure) for a
 * new setup, or from AIOStreams' Reconfigure button (/<token>/configure) with
 * the current settings filled in. Saved keys are never sent to the browser:
 * their fields stay empty and are kept unless something new is typed.
 *
 * Each step is checked when the person moves on from it (checkStep), so a
 * mistake shows where it was made; saving checks everything again.
 */
import { config } from "./config.js";
import { fetchPublic, readCapped } from "./net.js";
import { ADDON_ID } from "./types.js";
import { metaOf } from "./cinemeta.js";
import { IMDB_ID, LINK_LABEL, MAX_ADDONS, MAX_OTHER_URLS, MAX_PASSWORD, MAX_STYLES, MAX_TOKEN, RAISE_MAX, RAISE_MIN, STYLE_SCOPES, parseAiostreamsUrl, sameAiostreamsConfiguration, sealSettings, settingsProblem, styleRulesOf, type Addon, type Settings, type StyleRule, type StyleScope } from "./profile.js";
import { lookOf } from "./srt.js";
import { accountIn, jellyfinSignIn, linkedAppsOf, signIn } from "./aiostreamsAccount.js";
import { wyzieAccepts } from "./wyzie.js";

export { configurePage } from "./page.js";

/** What the page sends: the form as it stands, its styles whole (each place's look and how far up). */
export type ConfigureInput = Partial<Omit<Settings, "raise" | "styles" | "aiostreamsAlso">> & {
  addAddons?: unknown;
  /** The AIOStreams account as the page asks for it: the instance's address and the configuration's UUID, beside its password. */
  aiostreamsAddress?: unknown;
  aiostreamsId?: unknown;
  /** Another install URL as typed in its one field, or "remove" for the saved ones; saved, they are a list (Settings.aiostreamsAlso). */
  aiostreamsAlso?: unknown;
  removeAddons?: unknown;
  label?: unknown;
  styles?: unknown;
};
type Problem = { error: string };

/** SubDL answers status: true for a working key (one search, never logged: the URL carries the key). */
async function subdlAccepts(apiKey: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ api_key: apiKey, imdb_id: "tt0111161", type: "movie", languages: "EN", subs_per_page: "1" });
    const response = await fetch(`https://api.subdl.com/api/v1/subtitles?${query}`, { signal: AbortSignal.timeout(15000) });
    const body = (await response.json()) as { status?: boolean };
    return response.ok && body.status === true;
  } catch {
    return false;
  }
}

async function reachable(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    return response.ok;
  } catch {
    return false;
  }
}


/**
 * A pasted addon checked the way AIOStreams would: its manifest loads and
 * offers subtitles. Returns its name, or what's wrong. AIOStreams itself is
 * turned away: it asks BttrSubs for subtitles, so it would ask itself.
 */
export async function checkAddon(raw: string): Promise<Addon | Problem> {
  const url = raw.trim().replace(/^stremio:\/\//i, "https://");
  if (!/^https:\/\/\S+\/manifest\.json$/.test(url) || url.length > 2048) return { error: "Other addons: paste the addon's https manifest URL, ending in /manifest.json" };
  let manifest: { id?: string; name?: string; resources?: Array<string | { name?: string }> };
  try {
    const response = await fetchPublic(url, 10000, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = JSON.parse((await readCapped(response, 500_000)).toString("utf8"));
  } catch {
    return { error: "Other addons: one of them didn't load. Check its URL (it must be public and https)" };
  }
  const name = String(manifest.name ?? "").trim().slice(0, 40) || new URL(url).hostname;
  // BttrSubs added to itself would ask itself forever.
  if (String(manifest.id) === ADDON_ID || (config.publicBaseUrl && url.startsWith(`${config.publicBaseUrl}/`))) return { error: "Other addons: that's BttrSubs itself" };
  if (/aiostreams/i.test(`${manifest.id ?? ""} ${manifest.name ?? ""}`)) {
    return { error: "Other addons: add the subtitle addons themselves, not AIOStreams (it asks BttrSubs, so it would ask itself)" };
  }
  const resources = (manifest.resources ?? []).map((r) => (typeof r === "string" ? r : r?.name));
  if (!resources.includes("subtitles")) return { error: `Other addons: ${name} doesn't offer subtitles` };
  return { name, url };
}

/** A typed value replaces the saved one, "remove" clears it, empty keeps it. */
function keepOrReplace(typed: unknown, saved?: string): string | undefined {
  const value = typeof typed === "string" ? typed.trim() : "";
  if (value.toLowerCase() === "remove") return undefined;
  return value || saved || undefined;
}

/** Saved addons stay unless removed by position; pasted ones (one per line) are checked and added. */
async function gatherAddons(input: ConfigureInput, current?: Settings): Promise<Addon[] | Problem> {
  const remove = new Set(Array.isArray(input.removeAddons) ? input.removeAddons.map(Number) : []);
  const addons = (current?.addons ?? []).filter((_, i) => !remove.has(i));
  const pasted = (typeof input.addAddons === "string" ? input.addAddons : "").split(/\s+/).filter(Boolean);
  if (addons.length + pasted.length > MAX_ADDONS) return { error: `Other addons: up to ${MAX_ADDONS}` };
  for (const raw of pasted) {
    const checked = await checkAddon(raw);
    if ("error" in checked) return checked;
    if (!addons.some((a) => a.url === checked.url)) addons.push(checked);
  }
  return addons;
}

/** A height as typed: a whole percent within the allowed range, or undefined. */
function percentOf(typed: unknown): number | undefined {
  const value = Number(typeof typed === "string" ? typed.trim().replace(/%$/, "") : typed);
  return Number.isInteger(value) && value >= RAISE_MIN && value <= RAISE_MAX ? value : undefined;
}

const RAISE_RANGE = `${RAISE_MIN} to ${RAISE_MAX}%`;

/**
 * The styles as the page sends them, whole: each place's look and how far up. A show is found by its
 * IMDb id (or any link holding one) and named as Cinemeta names it, unless the configuration has it
 * already; a style that sets neither is left out, and a second one for a place replaces the first.
 * Without a list, the saved styles stay (shows moved up before styles among them).
 */
async function gatherStyles(input: ConfigureInput, current?: Settings): Promise<StyleRule[] | Problem> {
  const saved = current ? styleRulesOf(current) : [];
  if (!Array.isArray(input.styles)) return saved;
  const rules: StyleRule[] = [];
  for (const raw of input.styles as Array<Record<string, unknown> | null>) {
    const scope = String(raw?.scope ?? "") as StyleScope;
    if (!STYLE_SCOPES.includes(scope)) return { error: "Styles: each is for every subtitle, anime, series, films or one show" };
    const look = typeof raw?.look === "string" && raw.look ? raw.look : undefined;
    if (look !== undefined && !lookOf(look)) return { error: "Styles: that look isn't one this server can draw" };
    const typedUp = raw?.up === undefined || raw.up === null || raw.up === "" ? undefined : raw.up;
    const up = typedUp === undefined ? undefined : percentOf(typedUp);
    if (typedUp !== undefined && up === undefined) return { error: `Styles: how far up must be ${RAISE_RANGE}` };
    if (look === undefined && up === undefined) continue;
    let rule: StyleRule = { scope, ...(look ? { look } : {}), ...(up ? { up } : {}) };
    if (scope === "show") {
      const id = /tt\d{5,10}/.exec(String(raw?.id ?? ""))?.[0];
      if (!id || !IMDB_ID.test(id)) return { error: "Styles: paste the show's IMDb link, or its id (tt…)" };
      let name = saved.find((r) => r.scope === "show" && r.id === id)?.name;
      if (!name) {
        const meta = (await metaOf("series", id)) ?? (await metaOf("movie", id));
        if (!meta) return { error: `Styles: Cinemeta doesn't know ${id}. Check the IMDb id` };
        name = `${meta.name}${meta.year ? ` (${meta.year})` : ""}`.slice(0, 100);
      }
      rule = { scope, id, name, ...(look ? { look } : {}), ...(up ? { up } : {}) };
    }
    const at = rules.findIndex((r) => r.scope === rule.scope && r.id === rule.id);
    if (at >= 0) rules[at] = rule;
    else rules.push(rule);
    if (rules.length > MAX_STYLES) return { error: `Styles: up to ${MAX_STYLES}` };
  }
  return rules;
}

/** The link name as typed: trimmed, with runs of spaces made one. Empty means none. */
function labelOf(typed: unknown): string | undefined {
  const label = typeof typed === "string" ? typed.trim().replace(/\s+/g, " ") : "";
  return label || undefined;
}

/** The configuration's other install URLs: the saved ones with the one typed added; "remove" drops them all. */
function otherUrls(typed: unknown, saved: string[] = [], first?: string): string[] {
  const value = typeof typed === "string" ? typed.trim() : "";
  if (value.toLowerCase() === "remove") return [];
  return value && value !== first && !saved.includes(value) ? [...saved, value] : saved;
}

/** The AIOStreams account a configuration is to hold: its install URL and, when it has one, its password. */
type Account = { aiostreams?: string; password?: string };

/** A configuration's UUID as AIOStreams shows it. */
const CONFIG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether two install URLs are one AIOStreams account. */
function sameAccount(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && sameAiostreamsConfiguration(parseAiostreamsUrl(a), parseAiostreamsUrl(b)));
}

/**
 * The AIOStreams account the form describes. A typed password signs in at the address with the UUID,
 * and the configuration takes the install URL AIOStreams writes for that sign-in; an account that is
 * already the configuration's keeps the URL it has while that still works, so what is kept under it
 * stays. Without a typed password the saved account stays ("remove" forgets only the password).
 */
async function accountOf(input: ConfigureInput, current?: Settings): Promise<Account | Problem> {
  const typed = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const aiostreams = keepOrReplace(input.aiostreams, current?.aiostreams);
  const saved = current?.aiostreams ? accountIn(current.aiostreams) : undefined;
  const address = typed(input.aiostreamsAddress).replace(/\/+$/, "").toLowerCase() || saved?.origin || "";
  const id = typed(input.aiostreamsId).toLowerCase() || saved?.uuid || "";
  const isSaved = Boolean(saved && saved.origin.toLowerCase() === address && saved.uuid.toLowerCase() === id);
  const password = typeof input.aiostreamsPassword === "string" ? input.aiostreamsPassword : "";
  if (password.trim().toLowerCase() === "remove") return { aiostreams };
  if (!password) {
    if (!typed(input.aiostreams) && (address || id) && !isSaved) return { error: "AIOStreams password: needed to sign in. It's the one you chose when you saved your AIOStreams configuration" };
    return { aiostreams, password: sameAccount(aiostreams, current?.aiostreams) ? current?.aiostreamsPassword : undefined };
  }
  if (!address) return { error: "AIOStreams address: needed. It's the address you open your AIOStreams at" };
  if (!id) return { error: "AIOStreams UUID: needed. AIOStreams shows it under Save & Install" };
  if (!CONFIG_UUID.test(id)) return { error: "AIOStreams UUID: that doesn't look like one. Copy it again from Save & Install in AIOStreams" };
  if (password.length > MAX_PASSWORD) return { error: `AIOStreams password: up to ${MAX_PASSWORD} characters` };
  const parsed = parseAiostreamsUrl(`${address}/stremio/${id}/-/manifest.json`);
  if (!parsed) return { error: "AIOStreams address: must be a supported AIOStreams instance, like https://aiostreams.example.com" };
  if (isSaved && password === current?.aiostreamsPassword) return { aiostreams: current.aiostreams, password };
  const base = parsed.origin === config.ownAiostreams ? config.aiostreamsBase : parsed.origin;
  const signed = await signIn(base, id, password, 15000);
  if (signed === "refused") return { error: "AIOStreams password: that AIOStreams didn't accept this UUID and password" };
  if (!signed) return { error: "AIOStreams address: it didn't answer. Check the address" };
  const kept = isSaved ? parseAiostreamsUrl(current!.aiostreams!) : undefined;
  if (kept && (await reachable(`${base}${kept.path}/manifest.json`))) return { aiostreams: current!.aiostreams, password };
  return { aiostreams: `${parsed.origin}/stremio/${id}/${signed.encryptedPassword}/manifest.json`, password };
}

/** The settings the form describes, keeping saved keys and the AIOStreams account when their fields are empty. */
function draft(input: ConfigureInput, addons: Addon[], current?: Settings, styles: StyleRule[] = current ? styleRulesOf(current) : [], account?: Account): Settings {
  const label = labelOf(input.label);
  const aiostreams = account ? account.aiostreams : keepOrReplace(input.aiostreams, current?.aiostreams);
  const also = otherUrls(input.aiostreamsAlso, current?.aiostreamsAlso, aiostreams);
  const password = account ? account.password : sameAccount(aiostreams, current?.aiostreams) ? current?.aiostreamsPassword : undefined;
  return {
    subsource: keepOrReplace(input.subsource, current?.subsource),
    subdl: keepOrReplace(input.subdl, current?.subdl),
    wyzie: keepOrReplace(input.wyzie, current?.wyzie),
    opensubtitles: input.opensubtitles === true,
    // Kept only when on: off is what a link without it means.
    ...(input.subtitlecat === true ? { subtitlecat: true } : {}),
    // On unless turned off: only an explicit false is kept.
    ...(input.thesubtitledb === false ? { thesubtitledb: false } : {}),
    ...(input.gestdown === false ? { gestdown: false } : {}),
    ...(input.animetosho === false ? { animetosho: false } : {}),
    ...(addons.length ? { addons } : {}),
    aiostreams,
    ...(also.length ? { aiostreamsAlso: also } : {}),
    ...(password && aiostreams ? { aiostreamsPassword: password } : {}),
    languages: [...new Set((input.languages ?? []).map((l) => String(l).trim()).filter(Boolean))],
    allowMachine: input.allowMachine === true,
    hearingImpaired: (input.hearingImpaired as Settings["hearingImpaired"]) ?? "include",
    ...(input.keepEmbedded === true ? { keepEmbedded: true } : {}),
    ...(input.hideUnsynced === true ? { hideUnsynced: true } : {}),
    // Kept only when more than one: one is what a link without it means.
    ...(input.perLanguage !== undefined && input.perLanguage !== 1 ? { perLanguage: input.perLanguage as number } : {}),
    ...(input.keepAss === true ? { keepAss: true } : {}),
    ...(input.dropSounds === true ? { dropSounds: true } : {}),
    ...(input.signs === true ? { signs: true } : {}),
    ...(input.ownStyle === true ? { ownStyle: true } : {}),
    ...(styles.length ? { styles } : {}),
    ...(label ? { label } : {})
  };
}

/** Sync is what BttrSubs is for: every link needs an AIOStreams account, held as an install URL its instance recognises. */
async function syncProblem(aiostreams: string | undefined, current?: Settings): Promise<Problem | undefined> {
  if (!aiostreams) return { error: "AIOStreams address: needed, with your UUID and password. It's how BttrSubs finds the file you're playing" };
  const aio = parseAiostreamsUrl(aiostreams);
  if (!aio) return { error: "AIOStreams address: must be a supported AIOStreams instance" };
  if (aiostreams === current?.aiostreams) return undefined;
  const base = aio.origin === config.ownAiostreams ? config.aiostreamsBase : aio.origin;
  if (!(await reachable(`${base}${aio.path}/manifest.json`))) {
    return { error: "AIOStreams address: that instance didn't recognise this account. Check the UUID and password" };
  }
  return undefined;
}

/** What is wrong with one other install URL: another account's, or one its instance doesn't recognise (unless `known`). */
async function otherUrlProblem(first: ReturnType<typeof parseAiostreamsUrl>, url: string, known: boolean): Promise<Problem | undefined> {
  const parsed = parseAiostreamsUrl(url);
  if (!parsed) return { error: "Another install URL: must end in /manifest.json and come from a supported AIOStreams instance" };
  if (!sameAiostreamsConfiguration(first, parsed)) return { error: "Another install URL: it is for another AIOStreams account or instance than the first. Each one here is a copy of the same configuration" };
  if (known) return undefined;
  const base = parsed.origin === config.ownAiostreams ? config.aiostreamsBase : parsed.origin;
  if (!(await reachable(`${base}${parsed.path}/manifest.json`))) return { error: "Another install URL: that instance didn't recognise it. Copy it again from the player or server that uses it" };
  return undefined;
}

/** Each other install URL is the first one's configuration, and a new one is recognised by its instance. */
async function otherUrlsProblem(aiostreams: string | undefined, also: string[], current?: Settings): Promise<Problem | undefined> {
  if (also.length > MAX_OTHER_URLS) return { error: `Another install URL: up to ${MAX_OTHER_URLS} besides the first. Remove the saved ones to add this one` };
  const first = aiostreams ? parseAiostreamsUrl(aiostreams) : undefined;
  for (const url of also) {
    const problem = await otherUrlProblem(first, url, Boolean(current?.aiostreamsAlso?.includes(url)));
    if (problem) return problem;
  }
  return undefined;
}

/** How long each part of an account test waits for AIOStreams. */
const TEST_TIMEOUT_MS = 10_000;

/**
 * What a test of the AIOStreams account finds, part by part, for the page to show beside each:
 * the sign-in; AIOStreams' Jellyfin server, which its own apps and Jellyfin apps connected to it
 * play through; the linked Stremio; and the other install URLs (AIOMetadata's).
 */
export interface AccountTest {
  /** "incomplete" while a part is missing; a problem names the field that is wrong. */
  signIn: "ok" | "refused" | "unanswered" | "incomplete" | Problem;
  jellyfin?: "ready" | "off" | "refused" | "unanswered";
  /** "unpushed" before the first push, "failed" and "expired" as AIOStreams reports the last push. */
  stremio?: "linked" | "unpushed" | "failed" | "expired" | "unlinked" | "unavailable" | "unanswered";
  /** "none" when there are none; a problem when one is another account's or isn't recognised. */
  also?: "matches" | "none" | Problem;
}

/** The linked Stremio's state: the best of the account's Stremio links. */
function stremioOf(apps: Awaited<ReturnType<typeof linkedAppsOf>>): NonNullable<AccountTest["stremio"]> {
  if (apps === undefined) return "unanswered";
  if (apps === "unavailable" || apps === "refused") return "unavailable";
  const states = apps.filter((app) => app.platform.toLowerCase() === "stremio").map((app) => (app.lastStatus === "ok" && app.urls.length ? "linked" : app.lastStatus === "error" ? "failed" : app.lastStatus === "expired" ? "expired" : "unpushed"));
  return (["linked", "unpushed", "failed", "expired"] as const).find((state) => states.includes(state)) ?? "unlinked";
}

/**
 * Tests the account the form describes, as it would be saved: a typed password, or the saved one
 * for the saved account. A test signs in once; AIOStreams limits failed sign-ins, so the page asks
 * only when a field is left or the person asks again, never while one is typed in.
 */
export async function testAccount(input: ConfigureInput, current?: Settings): Promise<AccountTest> {
  const typed = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const saved = current?.aiostreams ? accountIn(current.aiostreams) : undefined;
  const address = typed(input.aiostreamsAddress).replace(/\/+$/, "").toLowerCase() || saved?.origin.toLowerCase() || "";
  const id = typed(input.aiostreamsId).toLowerCase() || saved?.uuid.toLowerCase() || "";
  const isSaved = Boolean(saved && saved.origin.toLowerCase() === address && saved.uuid.toLowerCase() === id);
  const passwordTyped = typeof input.aiostreamsPassword === "string" ? input.aiostreamsPassword : "";
  const password = passwordTyped.trim().toLowerCase() === "remove" ? "" : passwordTyped || (isSaved ? current?.aiostreamsPassword ?? "" : "");
  if (!address || !id || !password) return { signIn: "incomplete" };
  if (!CONFIG_UUID.test(id)) return { signIn: { error: "AIOStreams UUID: that doesn't look like one. Copy it again from Save & Install in AIOStreams" } };
  if (password.length > MAX_PASSWORD) return { signIn: { error: `AIOStreams password: up to ${MAX_PASSWORD} characters` } };
  const parsed = parseAiostreamsUrl(`${address}/stremio/${id}/-/manifest.json`);
  if (!parsed) return { signIn: { error: "AIOStreams address: must be a supported AIOStreams instance, like https://aiostreams.example.com" } };
  const base = parsed.origin === config.ownAiostreams ? config.aiostreamsBase : parsed.origin;
  const signed = await signIn(base, id, password, TEST_TIMEOUT_MS);
  if (signed === "refused") return { signIn: "refused" };
  if (!signed) return { signIn: "unanswered" };
  const typedAlso = typed(input.aiostreamsAlso);
  const also = typedAlso.toLowerCase() === "remove" ? [] : typedAlso ? [typedAlso] : current?.aiostreamsAlso ?? [];
  const [jellyfin, apps, alsoProblem] = await Promise.all([
    jellyfinSignIn(base, id, password, TEST_TIMEOUT_MS),
    linkedAppsOf(base, id, password, TEST_TIMEOUT_MS),
    (async () => {
      for (const url of also) {
        const problem = await otherUrlProblem(parsed, url, false);
        if (problem) return problem;
      }
      return undefined;
    })(),
  ]);
  return {
    signIn: "ok",
    jellyfin: typeof jellyfin === "object" ? "ready" : jellyfin === "refused" ? "refused" : jellyfin === "unavailable" ? "off" : "unanswered",
    stremio: stremioOf(apps),
    also: alsoProblem ?? (also.length ? "matches" : "none"),
  };
}

/** New keys must be accepted by their site; saved ones were checked when they were added. */
async function keysProblem(settings: Settings, current?: Settings): Promise<Problem | undefined> {
  if (settings.subsource && settings.subsource !== current?.subsource) {
    const ok = await reachable("https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=tt0111161", {
      headers: { "X-API-Key": settings.subsource, Accept: "application/json" }
    });
    if (!ok) return { error: "SubSource API key: SubSource didn't accept it" };
  }
  if (settings.subdl && settings.subdl !== current?.subdl && !(await subdlAccepts(settings.subdl))) {
    return { error: "SubDL API key: SubDL didn't accept it" };
  }
  if (settings.wyzie && settings.wyzie !== current?.wyzie && !(await wyzieAccepts(settings.wyzie))) {
    return { error: "Wyzie Subs key: Wyzie didn't accept it" };
  }
  return undefined;
}

/** What's wrong with one part of the settings, from settingsProblem's checks for that part. */
function partProblem(settings: Settings, prefixes: string[]): Problem | undefined {
  const problem = settingsProblem(settings);
  return problem && prefixes.some((p) => problem.startsWith(p)) ? { error: problem } : undefined;
}

/**
 * Checks one step of the flow before the person moves on: "sync", "sources",
 * "languages", "style" or "name". Steps with nothing to check pass.
 */
export async function checkStep(step: string, input: ConfigureInput, current?: Settings): Promise<{ ok: true } | Problem> {
  if (step === "sync") {
    const account = await accountOf(input, current);
    if ("error" in account) return account;
    const aiostreams = account.aiostreams;
    return (await syncProblem(aiostreams, current)) ?? (await otherUrlsProblem(aiostreams, otherUrls(input.aiostreamsAlso, current?.aiostreamsAlso, aiostreams), current)) ?? { ok: true };
  }
  if (step === "sources") {
    const addons = await gatherAddons(input, current);
    if ("error" in addons) return addons;
    const settings = draft(input, addons, current);
    // The other steps aren't filled in yet: only this step's own checks count here.
    const local = { ...settings, aiostreams: undefined, languages: ["English"], label: undefined };
    return partProblem(local, ["SubSource", "SubDL", "Wyzie", "Other addons", "Sources"]) ?? (await keysProblem(settings, current)) ?? { ok: true };
  }
  if (step === "languages") {
    const settings = draft(input, [], current);
    return partProblem({ ...settings, subsource: undefined, subdl: undefined, wyzie: undefined, opensubtitles: true, aiostreams: undefined, label: undefined }, ["Languages"]) ?? { ok: true };
  }
  if (step === "style") {
    const styles = await gatherStyles(input, current);
    return "error" in styles ? styles : { ok: true };
  }
  if (step === "name") {
    const label = labelOf(input.label);
    return label && !LINK_LABEL.test(label) ? { error: "Configuration name: use up to 40 letters, digits, spaces or simple punctuation" } : { ok: true };
  }
  return { ok: true };
}

/** Builds the settings from the whole form, checks them all, and returns the new manifest URL. */
export async function saveConfiguration(input: ConfigureInput, current?: Settings): Promise<{ manifestUrl: string; settings: Settings } | Problem> {
  const addons = await gatherAddons(input, current);
  if ("error" in addons) return addons;
  const styles = await gatherStyles(input, current);
  if ("error" in styles) return styles;
  const account = await accountOf(input, current);
  if ("error" in account) return account;
  const settings = draft(input, addons, current, styles, account);
  const problem = settingsProblem(settings);
  if (problem) return { error: problem };
  const failed = (await syncProblem(settings.aiostreams, current)) ?? (await otherUrlsProblem(settings.aiostreams, settings.aiostreamsAlso ?? [], current)) ?? (await keysProblem(settings, current));
  if (failed) return failed;
  if (!config.publicBaseUrl) return { error: "This server has no PUBLIC_BASE_URL set" };
  const token = sealSettings(settings);
  if (token.length > MAX_TOKEN) return { error: "Other addons: their URLs are too long to fit in one install URL. Remove one" };
  return { manifestUrl: `${config.publicBaseUrl}/${token}/manifest.json`, settings };
}
