/**
 * The dashboard (/dashboard): whether BttrSubs is doing its job, what it costs this server (its own
 * container only), the API keys against their limits, the activity and errors, each configuration, and
 * the server settings that change without a restart.
 *
 * The page is a shell: dashboard.js draws its six sections from the data (dashboardData.ts) written into
 * the page, and fetches it again on Refresh and after each change. Every change is a POST from the page's
 * own script with the CSRF token it was given (see access.ts, adminWrite). No token, key or password is
 * ever written into the page; a configuration's install URL is sent only when its Copy button asks.
 */
import { anidbPace } from "./anidb.js";
import type { DashboardData } from "./dashboardData.js";
import { bubsScripts, escapeHtml, pageHead, scriptJson, uiUrl, WORDMARK } from "./ui.js";

export interface DashboardOptions {
  csrf: string;
  /** Signed in with a password, so Sign out means something. */
  signedIn: boolean;
}

const TABS: Array<[id: string, icon: string, word: string, short?: string]> = [
  ["overview", "bubble", "Overview"],
  ["keys", "key", "Keys"],
  ["activity", "list", "Activity"],
  ["configs", "link", "Configurations", "Configs"],
  ["errors", "alert", "Errors"],
  ["settings", "sliders", "Settings"]
];

/** A link out of the dashboard: a new tab, no referrer, and said so to screen readers. */
const out = (url: string, text: string) => `<a class="out-link" href="${url}" target="_blank" rel="noopener noreferrer">${text}<span class="ic" data-icon="ext"></span><span class="sr-only"> (opens in a new tab)</span></a>`;

/**
 * How to register an AniDB client for ANIDB_CLIENT and ANIDB_CLIENT_VER, step by step with the site's own
 * words and pages. A client's API type can't be changed and a client can't be deleted, so the warning comes
 * before Add Client. The limits come from anidbPace, as anidb.ts keeps them.
 */
function anidbGuide(): string {
  return `<dialog class="help-dialog guide-dialog" id="anidb-help" aria-labelledby="anidb-title">
  <div class="help-head"><h2 id="anidb-title">Set up an AniDB client</h2><button class="icon-btn" type="button" data-close-guide aria-label="Close"><span class="ic" data-icon="close"></span></button></div>
  <div class="guide-body">
    <p>Season titles for anime that have no season map. Free, about five minutes.</p>
    <ol class="guide-steps">
      <li><b>Sign in at ${out("https://anidb.net", "anidb.net")}</b> (a free account).</li>
      <li><b>Open ${out("https://anidb.net/software/add", "Add New Client")}.</b> Under <b>Register A New Project</b>: any name, <b>Public Project?</b> on <b>no, private only</b>. Click <b>Add Project</b>.</li>
      <li><b>Under Register A New Client:</b> a <b>Client Name</b> in lower-case letters, <b>API: HTTP API, not UDP API</b>, <b>Version: 1</b>. Click <b>Add Client</b>.
        <p class="guide-warn" role="note"><span class="ic" data-icon="alert"></span><span><b>HTTP API can't be changed</b> afterwards, and a client can't be deleted.</span></p></li>
      <li><b>Back here:</b> fill <b>AniDB client</b> and <b>AniDB client version</b>, then <b>Save changes</b>.</li>
    </ol>
    <p class="guide-foot">At most one request every ${anidbPace.everyMs / 1000} s and ${anidbPace.dailyMax} a day, by ${out("https://wiki.anidb.net/HTTP_API_Definition", "AniDB's rules")}. Without a client, titles come from the anime-offline-database.</p>
  </div>
</dialog>`;
}

export function dashboardPage(data: DashboardData, opts: DashboardOptions): string {
  const tabs = TABS.map(
    ([id, ic, word, short]) =>
      `<a class="tab" href="#${id}" data-tab="${id}"><span class="ic" data-icon="${ic}"></span><span class="tab-word">${short ? `<span class="word-long">${word}</span><span class="word-short">${short}</span>` : word}</span>${id === "errors" ? '<span class="badge" id="err-badge" hidden></span>' : ""}</a>`
  ).join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
${pageHead("BttrSubs · Dashboard", { app: "dashboard", extra: `<meta name="csrf" content="${escapeHtml(opts.csrf)}">` })}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="side">
   <div class="side-in">
    <a class="brand" href="#overview" data-tab="overview" aria-label="BttrSubs, overview">
      <span class="brand-mark" id="brand-mark"></span>
      ${WORDMARK}
    </a>
    <nav class="tabs" aria-label="Dashboard">
      <span class="tab-marker" aria-hidden="true"></span>
      ${tabs}
    </nav>
    <div class="side-end">
      <div class="side-notes" id="side-notes"></div>
      <a class="side-link new-link" href="/configure" aria-label="New configuration"><span class="ic" data-icon="plus"></span><span>New configuration</span></a>
      <div class="updated-row"><span class="updated" id="updated"></span><button class="icon-btn" type="button" id="refresh" aria-label="Refresh"><span class="ic" data-icon="refresh"></span></button></div>
      <div class="side-actions">
        <button class="icon-btn" type="button" id="theme" aria-label="Dark theme" aria-pressed="false"><span class="ic" data-icon="moon"></span></button>
        ${opts.signedIn ? `<button class="text-btn signout" type="button" aria-label="Sign out"><span class="ic" data-icon="out"></span><span>Sign out</span></button>` : ""}
      </div>
    </div>
   </div>
  </aside>

  <div class="work">
    <main id="main" tabindex="-1">
      <section class="panel" id="p-overview" data-panel="overview" aria-labelledby="verdict-line"></section>
      <section class="panel" id="p-keys" data-panel="keys" aria-labelledby="h-keys" hidden></section>
      <section class="panel" id="p-activity" data-panel="activity" aria-labelledby="h-activity" hidden></section>
      <section class="panel" id="p-configs" data-panel="configs" aria-labelledby="h-configs" hidden></section>
      <section class="panel" id="p-errors" data-panel="errors" aria-labelledby="h-errors" hidden></section>
      <section class="panel" id="p-settings" data-panel="settings" aria-labelledby="h-settings" hidden></section>
    </main>
    <footer class="foot">
      <span>BttrSubs <span id="version"></span> · times in <span id="tz"></span></span>
      <button type="button" class="kbd-hint" id="show-notes">What's new</button>
      <button type="button" class="kbd-hint" id="show-keys">Shortcuts and motion <kbd>?</kbd></button>
    </footer>
  </div>
</div>

<dialog class="help-dialog" id="keys-help" aria-labelledby="keys-title">
  <div class="help-head"><h2 id="keys-title">Shortcuts and motion</h2><button class="icon-btn" type="button" data-close-keys aria-label="Close"><span class="ic" data-icon="close"></span></button></div>
  <dl class="keys">
    <div><dt><kbd>1</kbd>–<kbd>6</kbd></dt><dd>Overview, Keys, Activity, Configurations, Errors, Settings</dd></div>
    <div><dt><kbd>/</kbd></dt><dd>Find a file, episode or result in Activity</dd></div>
    <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Step through requests on the 24-hour track</dd></div>
    <div><dt><kbd>Esc</kbd></dt><dd>Close a panel, an explanation, or clear the search</dd></div>
    <div><dt><kbd>?</kbd></dt><dd>This list</dd></div>
  </dl>
  <div class="prefs">
    <div class="pref"><div><label for="pref-keys">Single-key shortcuts</label><p id="pref-keys-note"></p></div><input class="switch" type="checkbox" role="switch" id="pref-keys" aria-describedby="pref-keys-note"></div>
    <div class="pref"><div><label for="pref-motion">Reduce motion</label><p id="pref-motion-note"></p></div><input class="switch" type="checkbox" role="switch" id="pref-motion" aria-describedby="pref-motion-note"></div>
  </div>
</dialog>
${anidbGuide()}
<dialog class="help-dialog notes-dialog" id="notes-help" aria-labelledby="notes-title">
  <div class="help-head"><h2 id="notes-title"></h2><button class="icon-btn" type="button" data-close-notes aria-label="Close"><span class="ic" data-icon="close"></span></button></div>
  <div class="notes-body" id="notes-body"></div>
</dialog>
<div class="scrim" id="scrim" hidden></div>
<div class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden>
  <div class="drawer-head">
    <h2 id="drawer-title"></h2>
    <button class="icon-btn" type="button" data-close aria-label="Close"><span class="ic" data-icon="close"></span></button>
  </div>
  <div class="drawer-body" id="drawer-body"></div>
</div>

<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<div class="savebar" id="savebar" hidden>
  <span class="savebar-text" id="savebar-text" aria-live="polite"></span>
  <button class="btn" type="button" id="discard">Discard</button>
  <button class="btn primary" type="button" id="save">Save changes</button>
</div>
${opts.signedIn ? '<form id="signout-form" method="post" action="/logout" hidden></form>' : ""}

<script>window.BTTR = ${scriptJson(data)};</script>
${bubsScripts(false)}
<script src="${uiUrl("dashboard.js")}"></script>
<script src="${uiUrl("install.js")}"></script>
</body>
</html>`;
}
