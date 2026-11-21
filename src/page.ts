/**
 * The configure page: a guided flow in five steps, Sync (required: it's what BttrSubs is for), Sources,
 * Languages, Filters, then Name and create. setup.js draws it in the browser; the server checks each step
 * as it's left and makes or saves the configuration (configure.ts).
 *
 * Someone changing an existing link (AIOStreams' Reconfigure button, or the dashboard's Configure) opens on
 * the review, can jump to any step, and saves from there; the link's URL stays the same.
 *
 * Saved keys and URLs are never written into the page: it only knows they're set. Saved addons show by
 * name and host (the rest of their URL can hold that addon's keys).
 */
import { languageLabel } from "./variants.js";
import { accountIn } from "./aiostreamsAccount.js";
import { config, PUBLIC_AIOSTREAMS } from "./config.js";
import { DEFAULT_RAISE, MAX_ADDONS, MAX_OTHER_URLS, MAX_STYLES, perLanguageOf, RAISE_MAX, RAISE_MIN, REGULAR_ENGLISH, styleRulesOf, type Settings } from "./profile.js";
import { CHANGE_LIMITS, FONTS, LOOKS, PLAIN, USUAL_UP, usualUpOf, type Look } from "./srt.js";

/** An ASS colour (&HAABBGGRR) as CSS (#RRGGBB). */
const cssColour = (ass: string): string => `#${ass.slice(-2)}${ass.slice(-4, -2)}${ass.slice(-6, -4)}`;
/** An ASS colour's see-through share (its alpha, 00 solid to FF clear) as CSS opacity. */
const cssOpacity = (ass: string): number => Math.round((1 - parseInt(ass.slice(2, 4), 16) / 255) * 100) / 100;
/** A look as the page draws and changes it: colours as CSS, the shadow's opacity, and where its lines sit unmoved. */
const lookForPage = (id: string, look: Look) => ({
  id,
  name: look.name,
  font: look.font,
  colour: cssColour(look.colour),
  outlineColour: cssColour(look.outlineColour),
  shadowOpacity: cssOpacity(look.backColour),
  bold: look.bold,
  size: look.size,
  box: look.border === 3,
  outline: look.outline,
  shadow: look.shadow,
  up: usualUpOf(look)
});
import type { Role } from "./access.js";
import { bubsScripts, escapeHtml, pageHead, scriptJson, uiUrl, WORDMARK } from "./ui.js";

/** The languages offered as chips, after English Dub and English. */
const COMMON_LANGUAGES = ["Spanish", "Spanish (LA)", "Spanish (EU)", "French", "Portuguese", "German", "Italian", "Arabic", "Russian", "Turkish", "Polish", "Dutch", "Indonesian", "Malay", "Persian", "Urdu", "Japanese", "Korean", "Vietnamese"];


/** What setup.js starts from: the configuration as it stands, without any key or URL. */
export function setupState(current: Settings | undefined) {
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  };
  return {
    editing: Boolean(current),
    regularEnglish: REGULAR_ENGLISH,
    languages: COMMON_LANGUAGES,
    // The names shown for the ones a player shows under a fuller name (a regional kind, variants.ts).
    languageLabels: Object.fromEntries(COMMON_LANGUAGES.map((l) => [l, languageLabel(l)]).filter(([l, label]) => label !== l)),
    // This server's own AIOStreams first, then the public ones it accepts.
    instances: [...(config.ownAiostreams ? [config.ownAiostreams] : []), ...PUBLIC_AIOSTREAMS.filter((o) => config.allowedAiostreams.includes(o) && o !== config.ownAiostreams)],
    own: Boolean(config.ownAiostreams),
    // perLanguageMax: the most subtitles a language this server lists (MAX_SUBTITLES_PER_LANGUAGE), so the page never offers more.
    limits: { addons: MAX_ADDONS, otherUrls: MAX_OTHER_URLS, styles: MAX_STYLES, raiseMin: RAISE_MIN, raiseMax: RAISE_MAX, raiseDefault: DEFAULT_RAISE, usualUp: USUAL_UP, perLanguageMax: config.maxPerLanguage },
    // The looks a style can choose, and the plain one, with what the page's preview draws and changes of each.
    looks: Object.entries(LOOKS).map(([id, look]) => lookForPage(id, look)),
    plainLook: lookForPage("plain", PLAIN),
    fonts: Object.entries(FONTS).map(([id, name]) => ({ id, name })),
    changeLimits: CHANGE_LIMITS,
    saved: { aio: Boolean(current?.aiostreams), aioAlso: current?.aiostreamsAlso?.length ?? 0, aioPw: Boolean(current?.aiostreamsPassword), subsource: Boolean(current?.subsource), subdl: Boolean(current?.subdl), wyzie: Boolean(current?.wyzie) },
    // The saved AIOStreams account, as its fields show it: where it is and which configuration. Never its password.
    account: (current?.aiostreams && accountIn(current.aiostreams)) || undefined,
    current: current
      ? {
          opensubtitles: current.opensubtitles === true,
          subtitlecat: current.subtitlecat === true,
          // On unless the configuration turned them off.
          thesubtitledb: current.thesubtitledb !== false,
          gestdown: current.gestdown !== false,
          animetosho: current.animetosho !== false,
          languages: current.languages,
          allowMachine: Boolean(current.allowMachine),
          skipEmbedded: current.keepEmbedded !== true,
          hideUnsynced: current.hideUnsynced === true,
          keepAss: current.keepAss === true,
          dropSounds: current.dropSounds === true,
          signs: current.signs === true,
          ownStyle: current.ownStyle === true,
          hearingImpaired: current.hearingImpaired ?? "include",
          perLanguage: perLanguageOf(current),
          label: current.label ?? "",
          addons: (current.addons ?? []).map((a) => ({ name: a.name, host: hostOf(a.url) })),
          styles: styleRulesOf(current).map((r) => ({ scope: r.scope, ...(r.id ? { id: r.id, name: r.name } : {}), ...(r.look ? { look: r.look } : {}), ...(r.up ? { up: r.up } : {}) }))
        }
      : null
  };
}

/**
 * The page: the sidebar (the steps, the way to the dashboard, and for someone signed in, Sign out), and the
 * step being worked on, drawn by setup.js. The dashboard link is there for everyone: a home-screen app has
 * no address bar and keeps its own sign-in apart from the browser's, so it is the owner's one way there,
 * and anyone else who follows it meets the dashboard's sign-in.
 */
export function configurePage(current?: Settings, roles: Role[] = []): string {
  const editing = Boolean(current);
  return `<!doctype html>
<html lang="en">
<head>
${pageHead(editing ? `Editing ${current?.label ? escapeHtml(current.label) : "your configuration"} · BttrSubs` : "Set up BttrSubs", { styles: ["configure.css"] })}
</head>
<body class="cfg-page">
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="side">
   <div class="side-in">
    <a class="brand" href="#" aria-label="BttrSubs, what it does"><span class="brand-mark" id="brand-mark"></span>${WORDMARK}</a>
    <p class="side-label">${editing ? `Editing ${current?.label ? escapeHtml(current.label) : "your configuration"}` : "New configuration"}</p>
    <nav class="tabs cfg-steps" id="steps" aria-label="Setup"></nav>
    <div class="side-end">
      <a class="side-link dash-link" href="/dashboard" aria-label="Dashboard"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="9" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.5"/></svg></span><span>Dashboard</span></a>
      <div class="side-actions">
        <button class="icon-btn" type="button" id="theme" aria-label="Dark theme" aria-pressed="false"></button>
        ${roles.length ? `<button class="text-btn signout" type="button" aria-label="Sign out"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3"/><path d="M15 16.5 19.5 12 15 7.5M19.5 12H9"/></svg></span><span>Sign out</span></button>` : ""}
      </div>
    </div>
   </div>
  </aside>
  <div class="work"><main id="main" class="cfg-main" tabindex="-1"><noscript><p>Setting up BttrSubs needs JavaScript.</p></noscript></main></div>
</div>
${roles.length ? '<form id="signout-form" method="post" action="/logout" hidden></form>' : ""}
<script>window.BTTR_SETUP = ${scriptJson(setupState(current))};</script>
${bubsScripts()}
<script src="${uiUrl("usher.js")}"></script>
<script src="${uiUrl("setup.js")}"></script>
</body>
</html>`;
}
