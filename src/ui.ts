/**
 * What the pages people open in a browser share (the dashboard, setup and sign-in): the files under
 * assets/ui, served at /ui/, and the head every page opens with.
 *
 * Each link to a file carries a hash of its contents (?v=), read once at start, so a browser keeps a
 * file for a year and fetches it again only when it changes. Fonts are linked from the stylesheets
 * without one and kept a month.
 *
 * The look is a 1930s picture palace: silver-screen greys, butter gold as the one colour,
 * Didone titles, and Bubs the usher. Theme (light or dark) and Reduce motion are the viewer's, kept in
 * their browser; a script in the head applies both before the first paint, so nothing flashes.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestHandler } from "express";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** A value for a <script> element's text: JSON that can't close the element or open a comment. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Each source's own icon (its site's favicon or app icon, 64px, in assets/sources), served from this
 * server at /sources/<id>.png so no viewer's browser ever calls the site itself. The logos are their
 * owners' trademarks, shown only to say which service is which (THIRD_PARTY_NOTICES.md).
 */
export const SOURCE_ICONS = ["subsource", "subdl", "wyzie", "opensubtitles", "thesubtitledb", "gestdown", "animetosho", "tsukihime", "aninzb", "subtitlecat", "aiostreams", "stremio", "aiometadata", "jellyfin"] as const;

const UI_DIR = fileURLToPath(new URL("../assets/ui/", import.meta.url));
const TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2" };

/** Every file under assets/ui by its path there ("fonts/hanken-latin.woff2"), with its contents' hash. */
const FILES = new Map<string, string>();
(function read(dir: string) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) read(full);
    else if (TYPES[path.extname(name)]) FILES.set(path.relative(UI_DIR, full).split(path.sep).join("/"), createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 10));
  }
})(UI_DIR);

/** A file's address with its version: "/ui/app.css?v=1a2b3c4d5e". */
export function uiUrl(file: string): string {
  const version = FILES.get(file);
  if (!version) throw new Error(`No such UI file: ${file}`);
  return `/ui/${file}?v=${version}`;
}

/** Serves /ui/<file>: only the files read at start, nothing else on the disk. */
export const serveUi: RequestHandler = (req, res) => {
  const file = req.path.replace(/^\/+/, "");
  if (!FILES.has(file)) {
    res.status(404).type("text").send("Not found");
    return;
  }
  const versioned = req.query.v === FILES.get(file);
  res.set("Cache-Control", versioned ? "public, max-age=31536000, immutable" : file.startsWith("fonts/") ? "public, max-age=2592000" : "no-cache");
  res.type(TYPES[path.extname(file)]);
  res.sendFile(path.join(UI_DIR, file));
};

/**
 * Before the first paint: Reduce motion (html.calm, or html.moving when switched off) from the
 * shortcuts dialog's switch, else the device's setting; and the theme chosen with the sidebar's button.
 */
const MOTION = `try { const m = localStorage.getItem("bttr-motion"); if (m === "reduce") document.documentElement.classList.add("calm"); else if (m === "full") document.documentElement.classList.add("moving"); else if (matchMedia("(prefers-reduced-motion: reduce)").matches) document.documentElement.classList.add("calm"); } catch {}`;
const THEME = `try { const t = localStorage.getItem("bttr-noir-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}`;
/** Signing in irises out; the page it opens irises in (palace.css), unless motion is reduced. */
const IRIS = `try { if (sessionStorage.getItem("bttr-iris")) { sessionStorage.removeItem("bttr-iris"); if (!document.documentElement.classList.contains("calm")) document.documentElement.classList.add("iris-in"); } } catch {}`;

/** The graphite of the sidebar and the phone's top bar, in both themes: the app's window colour. */
const GRAPHITE = "#16171A";
/** The page's own background (app.css, --paper), light and dark: the browser's bar on a page with no top bar of its own. */
export const PAPER = { light: "#EEEEEC", dark: "#121316" };

/** A file's version for its links: a hash of its contents, read once at start. */
const assetVersion = (file: string) => createHash("sha256").update(readFileSync(new URL(`../assets/${file}`, import.meta.url))).digest("hex").slice(0, 10);
/**
 * The logo (/logo.png, Bubs' head on the graphite tile, 512 px) and the tab icon (/favicon.png), each linked
 * with its version. /logo.png doubles as the home-screen app's icon: it is one of the paths a login proxy
 * leaves open (README), and a phone fetches a home-screen icon without the browser's cookies.
 */
export const LOGO_URL = `/logo.png?v=${assetVersion("bttr-subs-logo-512.png")}`;
const FAVICON_URL = `/favicon.png?v=${assetVersion("bttr-subs-favicon-64.png")}`;

/**
 * The pages as an app added to a phone's home screen. Its scope is the whole site, so moving between
 * setup, sign-in and the dashboard stays in the app's own window: a page outside an app's scope opens in
 * a browser laid over it. `start` is where the app opens: the dashboard for its owner, setup for friends.
 * It is served at /app/<start>/manifest.json, a path that ends like an addon's manifest, which a login
 * proxy leaves open for AIOStreams (README): a phone reads it without the browser's cookies.
 */
export function webManifest(start: "/dashboard" | "/configure"): Record<string, unknown> {
  return {
    id: start,
    name: "BttrSubs",
    short_name: "BttrSubs",
    start_url: start,
    scope: "/",
    display: "standalone",
    background_color: GRAPHITE,
    theme_color: GRAPHITE,
    icons: [{ src: LOGO_URL, sizes: "512x512", type: "image/png", purpose: "any" }]
  };
}

/**
 * The head of every page: the viewer's motion and theme applied first, the two text fonts preloaded,
 * then the page's stylesheets, with palace.css (the period layer) last. `styles` are the page's own,
 * between app.css and palace.css; `app` is the home-screen app it belongs to.
 */
export function pageHead(title: string, opts: { styles?: string[]; extra?: string; app?: "dashboard" | "configure"; bar?: "paper" } = {}): string {
  // A page with a graphite top bar gives the browser's bar that graphite; sign-in, whose top is the page itself, its
  // paper in each theme (the page's script follows the theme button).
  const themeColor =
    opts.bar === "paper"
      ? `<meta name="theme-color" content="${PAPER.light}" media="(prefers-color-scheme: light)">\n<meta name="theme-color" content="${PAPER.dark}" media="(prefers-color-scheme: dark)">`
      : `<meta name="theme-color" content="${GRAPHITE}">`;
  return `<meta charset="utf-8">
<script>${MOTION}</script>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="${FAVICON_URL}">
<link rel="manifest" href="/app/${(opts.app ?? "configure").replace(/^\//, "")}/manifest.json">
<link rel="apple-touch-icon" href="${LOGO_URL}">
<meta name="apple-mobile-web-app-title" content="BttrSubs">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
${themeColor}
<link rel="preload" href="${uiUrl("fonts/bigshoulders-latin.woff2").replace(/\?.*$/, "")}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${uiUrl("fonts/hanken-latin.woff2").replace(/\?.*$/, "")}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${uiUrl("app.css")}">
${(opts.styles ?? []).map((s) => `<link rel="stylesheet" href="${uiUrl(s)}">`).join("\n")}
<script>${THEME}</script>
<link rel="stylesheet" href="${uiUrl("palace.css")}">
<script>${IRIS}</script>
${opts.extra ?? ""}`;
}

/** The scripts that draw Bubs: his figure (bubs.js) and, where he stands on the page, his eyes. */
export function bubsScripts(eyes = true): string {
  return `<script src="${uiUrl("bubs.js")}"></script>${eyes ? `\n<script src="${uiUrl("eyes.js")}"></script>` : ""}`;
}

/** The wordmark: BttrSubs in Didone, "Bttr" in gold. */
export const WORDMARK = `<span class="brand-word"><span class="bw-gold">Bttr</span>Subs</span>`;

/** The theme button's two faces. */
export const THEME_ICONS = {
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  moon: '<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>'
};
