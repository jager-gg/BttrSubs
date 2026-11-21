/**
 * Who can open the pages people use in a browser, the way AIOMetadata does it: ADDON_PASSWORD for
 * the configure page (making and editing links) and ADMIN_PASSWORD for the dashboard. The admin
 * password opens the configure page too, since the dashboard links to every link's configure page.
 * The addon paths AIOStreams and players call never ask. A password left unset leaves its pages
 * open, for a server whose reverse proxy asks for a login.
 *
 * Signing in sets a session cookie for SESSION_DAYS: the roles it opens, an expiry and an HMAC over
 * both, keyed by CONFIG_SECRET and the passwords, so changing a password signs everyone out. It is
 * SameSite=Lax: following a link from AIOStreams' Reconfigure button keeps you signed in, while a
 * form or fetch from another site doesn't carry it.
 *
 * Wrong passwords are slowed down per address (a second each) and, after LOGIN_MAX_FAILS in
 * LOGIN_WINDOW_MS, refused for the rest of that window. The configure checks, which call SubSource,
 * SubDL and AIOStreams, are limited to CHECK_MAX per minute per address.
 *
 * The dashboard's changes (settings, links, clearing errors) are POSTs that need the admin role, and
 * each must come from the dashboard itself, two ways (see adminWrite): the browser's own word that the
 * request is same-origin (Sec-Fetch-Site, else Origin), and a CSRF token the page was given, an HMAC of
 * the session keyed like the session itself. A request that fails either is counted like a wrong
 * password, with the same lockout; and every address gets at most CHECK_MAX changes a minute.
 *
 * The configure page's password can also be set on the dashboard (settings.ts); it is checked here
 * through addonPasswordMatches, and the session key follows it.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Response } from "express";
import { config } from "./config.js";
import { addonPasswordFingerprint, addonPasswordMatches, addonPasswordSet } from "./settings.js";
import { bubsScripts, escapeHtml, pageHead, uiUrl, WORDMARK } from "./ui.js";

export type Role = "addon" | "admin";

const COOKIE = "bttr_session";
const SESSION_DAYS = 30;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_DELAY_MS = 1000;
const CHECK_MAX = 30;

const digest = (text: string) => createHash("sha256").update(text).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** Whether a role's pages ask for a password (they're open when it's unset). */
function locked(role: Role): boolean {
  return role === "admin" ? Boolean(config.adminPassword) : addonPasswordSet();
}

/** Whether any password is set, so the pages show a Sign out button. */
export function authEnabled(): boolean {
  return Boolean(addonPasswordSet() || config.adminPassword);
}

function sessionKey(): Buffer {
  return createHash("sha256").update(`session|${config.configSecret ?? ""}|${addonPasswordFingerprint()}|${config.adminPassword ?? ""}`).digest();
}

function sign(body: string): string {
  return createHmac("sha256", sessionKey()).update(body).digest("base64url");
}

/** A session cookie's value for these roles. */
export function sessionValue(roles: Role[], now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ r: roles, e: now + SESSION_DAYS * 86400_000 })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** A cookie's value in the request, if it carries one by that name. */
function cookieValue(req: Request, name: string): string | undefined {
  return (req.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** A session value's roles and expiry when its signature holds and it hasn't expired. */
function readSession(raw: string | undefined): { roles: Role[]; expires: number } | undefined {
  if (!raw) return undefined;
  const [body, mac] = raw.split(".");
  if (!body || !mac || !same(mac, sign(body))) return undefined;
  try {
    const { r, e } = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { r: Role[]; e: number };
    return Array.isArray(r) && typeof e === "number" && e > Date.now() ? { roles: r, expires: e } : undefined;
  } catch {
    return undefined;
  }
}

/** The session cookie's value the request carries, when it's valid. */
function sessionCookie(req: Request): string | undefined {
  const raw = cookieValue(req, COOKIE);
  return readSession(raw) ? raw : undefined;
}

/** The roles a request's session opens; none without a valid, unexpired session. */
export function sessionRoles(req: Request): Role[] {
  return readSession(sessionCookie(req))?.roles ?? [];
}

/**
 * The dashboard's CSRF token for this request's session: an HMAC of the session cookie, keyed like
 * sessions, so it changes with the session and with any password. Without a session (the dashboard
 * left open for a proxy's login) it is the same for everyone, and the same-origin check still holds.
 */
export function csrfToken(req: Request): string {
  return createHmac("sha256", sessionKey()).update(`csrf|${sessionCookie(req) ?? ""}`).digest("base64url");
}

/** Whether the request may open a role's pages: no password for it, or a session that opens it (admin opens both). */
export function allowed(req: Request, role: Role): boolean {
  if (!locked(role)) return true;
  const roles = sessionRoles(req);
  return roles.includes(role) || (role === "addon" && roles.includes("admin"));
}

/** Only a path on this site to go back to after signing in. */
function safeNext(raw: unknown): string {
  const next = typeof raw === "string" ? raw : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/configure";
}

/**
 * Lets the request through when it may open the role's pages. Otherwise a page is sent to the
 * login page and back, and a request from a page's own script gets 401.
 */
export function requireRole(role: Role): RequestHandler {
  return (req, res, next) => {
    if (allowed(req, role)) {
      next();
      return;
    }
    res.set("Cache-Control", "no-store");
    if (req.method === "GET" && req.accepts(["html", "json"]) === "html") {
      res.redirect(303, `/login?${new URLSearchParams({ next: req.originalUrl, ...(role === "admin" ? { for: "admin" } : {}) })}`);
      return;
    }
    // Signed in, but not as the admin: say so, rather than "signed out".
    if (sessionRoles(req).length) {
      res.status(403).json({ error: "This needs the dashboard's password" });
      return;
    }
    res.status(401).json({ error: "Signed out. Reload the page to sign in again" });
  };
}

// ---------- rate limits ----------

const failures = new Map<string, number[]>();

function recentFails(ip: string, now = Date.now()): number[] {
  const kept = (failures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (kept.length) failures.set(ip, kept);
  else failures.delete(ip);
  return kept;
}

const checks = new Map<string, number[]>();

/** At most CHECK_MAX of the configure page's checks and saves per minute per address. */
export const checkLimit: RequestHandler = (req, res, next) => {
  const ip = req.ip ?? "?";
  const now = Date.now();
  const kept = (checks.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (kept.length >= CHECK_MAX) {
    res.set("Retry-After", "60").status(429).json({ error: "Too many tries in a minute. Wait a moment and try again" });
    return;
  }
  kept.push(now);
  checks.set(ip, kept);
  next();
};

/** Dashboard changes refused for not coming from the dashboard, per address, like wrong passwords. */
const forged = new Map<string, number[]>();
const changes = new Map<string, number[]>();

function recentForged(ip: string, now = Date.now()): number[] {
  const kept = (forged.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (kept.length) forged.set(ip, kept);
  else forged.delete(ip);
  return kept;
}

/** Whether the browser says the request comes from this site: Sec-Fetch-Site, else the Origin header. */
export function sameOrigin(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.get("origin");
  const host = req.get("x-forwarded-host") ?? req.get("host");
  try {
    return Boolean(origin && host && new URL(origin).host === host);
  } catch {
    return false;
  }
}

/**
 * Every change the dashboard makes goes through this, after its body is read: the admin role, at most
 * CHECK_MAX a minute per address, from the dashboard itself (same origin), carrying its CSRF token (the
 * X-CSRF-Token header, or a csrf field in a form). Five refusals for the last two in LOGIN_WINDOW_MS
 * lock that address out of changes for the rest of the window, as wrong passwords do from signing in.
 */
export const adminWrite: RequestHandler[] = [
  (req, res, next) => {
    const ip = req.ip ?? "?";
    const now = Date.now();
    res.set("Cache-Control", "no-store");
    if (recentForged(ip, now).length >= LOGIN_MAX_FAILS) {
      res.set("Retry-After", String(LOGIN_WINDOW_MS / 1000)).status(429).json({ error: "Too many refused changes. Try again in 15 minutes" });
      return;
    }
    const kept = (changes.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (kept.length >= CHECK_MAX) {
      res.set("Retry-After", "60").status(429).json({ error: "Too many changes in a minute. Wait a moment and try again" });
      return;
    }
    kept.push(now);
    changes.set(ip, kept);
    next();
  },
  requireRole("admin"),
  (req, res, next) => {
    const given = req.get("x-csrf-token") ?? (typeof req.body?.csrf === "string" ? req.body.csrf : "");
    if (sameOrigin(req) && given && same(given, csrfToken(req))) {
      next();
      return;
    }
    forged.set(req.ip ?? "?", [...recentForged(req.ip ?? "?"), Date.now()]);
    console.log("dashboard: a change was refused (not from the dashboard, or an old page)");
    res.status(403).json({ error: "Make changes from the dashboard itself. If it's open, reload it and try again" });
  }
];

/** Forgets old entries now and then, so the maps don't grow. */
setInterval(() => {
  const now = Date.now();
  for (const ip of failures.keys()) recentFails(ip, now);
  for (const ip of forged.keys()) recentForged(ip, now);
  for (const [ip, times] of checks) if (!times.some((t) => now - t < 60_000)) checks.delete(ip);
  for (const [ip, times] of changes) if (!times.some((t) => now - t < 60_000)) changes.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- the login page ----------

function cookie(req: Request, value: string, maxAgeSeconds: number): string {
  return [`${COOKIE}=${value}`, "Path=/", `Max-Age=${maxAgeSeconds}`, "HttpOnly", "SameSite=Lax", ...(req.secure ? ["Secure"] : [])].join("; ");
}

/**
 * Signs the request's own session again, after a change to the configure page's password: the new
 * key would sign the owner out with everyone else. Returns the page's new CSRF token.
 */
export function renewSession(req: Request, res: Response, roles: Role[]): string {
  if (!roles.length) return csrfToken(req);
  const value = sessionValue(roles);
  setSession(req, res, value, SESSION_DAYS * 86400);
  return createHmac("sha256", sessionKey()).update(`csrf|${value}`).digest("base64url");
}

/** Sets (or, with maxAge 0, clears) the session. */
function setSession(req: Request, res: Response, value: string, maxAgeSeconds: number): void {
  res.append("Set-Cookie", cookie(req, value, maxAgeSeconds));
}

const ALERT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2h.01"/></svg>';

/**
 * The sign-in page: Bubs beside a title card holding the one field. The form posts to /login; its script
 * asks for the answer as JSON so it can show it in place, and without the script the server answers with
 * this page again (an error) or the page asked for.
 */
export function loginPage(next: string, forAdmin: boolean, error?: string): string {
  const what = forAdmin ? "the dashboard" : "setting up a configuration";
  // The way to the other page, as the dashboard and setup each show it: a home-screen app has no address bar.
  const other = forAdmin
    ? { href: "/configure", label: "New configuration", icon: '<path d="M12 5v14M5 12h14"/>' }
    : { href: "/dashboard", label: "Dashboard", icon: '<rect x="3.5" y="3.5" width="7" height="9" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.5"/>' };
  return `<!doctype html>
<html lang="en">
<head>
${pageHead("Sign in · BttrSubs", { styles: ["signin.css"], app: forAdmin ? "dashboard" : "configure", bar: "paper" })}
</head>
<body>
<header class="signin-top">
  <a class="brand" href="/configure" aria-label="BttrSubs"><span class="brand-mark" id="brand-mark"></span>${WORDMARK}</a>
  <div class="signin-actions">
    <a class="signin-link" href="${other.href}" aria-label="${other.label}"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${other.icon}</svg></span><span class="link-word">${other.label}</span></a>
    <button class="icon-btn" type="button" id="theme" aria-label="Dark theme" aria-pressed="false"></button>
  </div>
</header>
<main class="signin" id="main">
  <div class="door">
    <div class="noir-live" id="bubs"></div>
    <div class="intertitle">
      <h1 class="caption" id="cap">Sign in.</h1>
      <p class="lede">Enter the password for ${what}.</p>
      <form id="form" method="post" action="/login" novalidate>
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <label for="password">Password</label>
        <div class="pw">
          <input class="field" id="password" type="password" name="password" autocomplete="current-password" required autofocus${error ? ' aria-invalid="true" aria-describedby="err"' : ""}>
          <button class="icon-btn" type="button" id="peek" aria-label="Show password" aria-pressed="false"><span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg></span></button>
        </div>
        <p class="signin-err" id="err" role="alert"${error ? "" : " hidden"}>${error ? `${ALERT_ICON}<span>${escapeHtml(error)}</span>` : ""}</p>
        <button class="btn primary go" type="submit" id="go">Sign in</button>
      </form>
    </div>
  </div>
</main>
${bubsScripts()}
<script src="${uiUrl("signin.js")}"></script>
</body>
</html>`;
}

/** What a wrong password is told: which password it is, and to check Caps Lock. */
function wrongPassword(forAdmin: boolean): string {
  return forAdmin
    ? "That password isn't right. It's the one set as ADMIN_PASSWORD on the server; check Caps Lock."
    : "That password isn't right. Ask whoever runs this server for it; check Caps Lock.";
}

/** /login and /logout. */
export function accessRoutes(): express.Router {
  const router = express.Router();

  router.get("/login", (req, res) => {
    const next = safeNext(req.query.next);
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    if (!authEnabled()) {
      res.redirect(303, next);
      return;
    }
    res.type("html").send(loginPage(next, req.query.for === "admin"));
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), async (req: Request, res: Response) => {
    const next = safeNext(req.body?.next);
    const forAdmin = /^\/dashboard(?:[/?#]|$)/.test(next);
    const ip = req.ip ?? "?";
    // The page's script asks for JSON and shows the answer in place; a plain form post gets a page.
    const json = req.accepts(["html", "json"]) === "json";
    const refuse = (status: number, error: string) => (json ? res.status(status).json({ error }) : res.status(status).type("html").send(loginPage(next, forAdmin, error)));
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    if (recentFails(ip).length >= LOGIN_MAX_FAILS) {
      refuse(429, "Too many wrong passwords. Try again in 15 minutes.");
      return;
    }
    const given = typeof req.body?.password === "string" ? req.body.password : "";
    const roles: Role[] = [];
    if (config.adminPassword && same(given, config.adminPassword)) roles.push("admin", "addon");
    else if (given && (await addonPasswordMatches(given))) roles.push("addon");
    if (roles.length === 0) {
      failures.set(ip, [...recentFails(ip), Date.now()]);
      await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
      console.log("login: wrong password");
      refuse(401, wrongPassword(forAdmin));
      return;
    }
    if (forAdmin && config.adminPassword && !roles.includes("admin")) {
      refuse(403, "That password opens configuration setup, not the dashboard.");
      return;
    }
    failures.delete(ip);
    res.removeHeader("Set-Cookie");
    setSession(req, res, sessionValue(roles), SESSION_DAYS * 86400);
    if (json) res.json({ next });
    else res.redirect(303, next);
  });

  router.post("/logout", (req, res) => {
    res.removeHeader("Set-Cookie");
    setSession(req, res, "", 0);
    res.set("Cache-Control", "no-store");
    res.redirect(303, "/login");
  });

  return router;
}
