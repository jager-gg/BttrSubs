import { createApp } from "./app.js";
import { config } from "./config.js";
import { startLogFiles } from "./logs.js";
import { startAnimeLists } from "./animelists.js";
import { startStats } from "./stats.js";
import { startCleanup } from "./cleanup.js";
import { startUpdateChecks } from "./updates.js";
import { addonPasswordSet, loadSettings } from "./settings.js";

// First, so the log files have everything from here on, the reasons for refusing to start included.
startLogFiles();
startAnimeLists();

if (!config.configSecret || config.configSecret.length < 32) {
  console.error("CONFIG_SECRET (32+ characters) is required: it encrypts everyone's settings into their manifest URL.");
  console.error("Make one with `openssl rand -hex 32`, put it in .env, and keep it: changing it breaks every link.");
  process.exit(1);
}
if (!config.publicBaseUrl) {
  console.warn("PUBLIC_BASE_URL is unset: the configure page can't make links until it's set to this addon's address.");
}
if (!config.adminPassword || config.adminPassword.length < 8) {
  console.error("ADMIN_PASSWORD (8+ characters) is required: it signs in to the dashboard, which shows what everyone played.");
  process.exit(1);
}
// Settings changed on the dashboard apply from the start, over .env's.
loadSettings();
if (!addonPasswordSet()) console.warn("The configure page has no password (ADDON_PASSWORD, or the dashboard's settings): anyone who can open /configure can create a configuration (fine behind a proxy login).");
if (config.allowedAiostreams.length === 0 && !config.ownAiostreams) {
  console.warn("No AIOStreams instance is accepted (ALLOWED_AIOSTREAMS, or the dashboard's settings): nothing will sync.");
}

await startStats();
startCleanup();
startUpdateChecks();

createApp().listen(config.port, () => {
  console.log(`BttrSubs listening on :${config.port}; configure at ${config.publicBaseUrl ?? "<PUBLIC_BASE_URL>"}/configure, dashboard at /dashboard`);
  // Only the owner's own instance is reached at another address than its public one.
  const own = config.ownAiostreams ? ` (yours, ${config.ownAiostreams}, is reached at ${config.aiostreamsBase})` : "";
  console.log(`AIOStreams accepted from: ${config.allowedAiostreams.join(", ") || "none"}${own}`);
});
