/**
 * The browser pages' parts that live on the server: their files under /ui/, sign-in's answer to its own
 * script, a configuration's install URL for Copy install URL, styles from the page, and the
 * sidebar's What's new and update notice (updates.ts).
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CACHE = ".cache-ui-test";
const ENV = { CONFIG_SECRET: "ui-test-secret-ui-test-secret-ui-test-1", CACHE_DIR: CACHE, PUBLIC_BASE_URL: "https://sync.example", ALLOWED_AIOSTREAMS: "https://aiostreams.example.com" };
const ADMIN = "ui-admin-pass-for-tests";

let base = "";
let close = () => {};
let profile: typeof import("../src/profile.js");
let access: typeof import("../src/access.js");
let updates: typeof import("../src/updates.js");
let config: (typeof import("../src/config.js"))["config"];
let lastIp = 10;
const nextIp = () => `10.30.0.${++lastIp}`;

beforeAll(async () => {
  Object.assign(process.env, ENV);
  [profile, access, updates] = await Promise.all([import("../src/profile.js"), import("../src/access.js"), import("../src/updates.js")]);
  config = (await import("../src/config.js")).config;
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(async () => {
  close();
  for (const name of Object.keys(ENV)) delete process.env[name];
  await rm(path.join(process.cwd(), CACHE), { recursive: true, force: true });
});

describe("the pages' files", () => {
  it("are served from /ui/, kept a year when the link names their version, and nothing else is", async () => {
    const page = await (await fetch(`${base}/configure`)).text();
    const link = page.match(/href="(\/ui\/app\.css\?v=[0-9a-f]{10})"/)?.[1];
    expect(link).toBeDefined();
    const css = await fetch(`${base}${link}`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // Without its version (or an old one) it isn't kept, so a new one is never missed.
    expect((await fetch(`${base}/ui/app.css?v=0000000000`)).headers.get("cache-control")).toBe("no-cache");
    const font = await fetch(`${base}/ui/fonts/hanken-latin.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    for (const nope of ["/ui/nope.js", "/ui/..%2Fbttr-subs-logo-512.png", "/ui/../package.json", "/ui/fonts"]) expect((await fetch(`${base}${nope}`)).status).toBe(404);
  });
});

describe("the pages as a home-screen app", () => {
  it("cover the whole site, so moving between them stays in the app's window", async () => {
    for (const [page, start] of [["/dashboard", "/dashboard"], ["/configure", "/configure"]] as const) {
      const html = await (await fetch(`${base}${page}`)).text();
      // At /app/<start>/manifest.json: a path ending like an addon's manifest, which a login proxy leaves open.
      expect(html).toContain(`<link rel="manifest" href="/app${start}/manifest.json">`);
      const manifest = await fetch(`${base}/app${start}/manifest.json`);
      expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
      const app = (await manifest.json()) as { icons: Array<{ src: string; sizes: string; purpose: string }> };
      expect(app).toMatchObject({ name: "BttrSubs", start_url: start, scope: "/", display: "standalone" });
      // Its icon is the logo (open to a phone fetching it without cookies), at a versioned address.
      expect(app.icons).toEqual([{ src: expect.stringMatching(/^\/logo\.png\?v=[0-9a-f]{10}$/), sizes: "512x512", type: "image/png", purpose: "any" }]);
      const png = await fetch(`${base}${app.icons[0].src}`);
      expect([png.status, png.headers.get("content-type")]).toEqual([200, "image/png"]);
      expect(html).toContain(`<link rel="apple-touch-icon" href="${app.icons[0].src}">`);
      // The status bar lies over the page in the app, on the top bar's graphite.
      expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
    }
    // A configuration's own setup page belongs to the same app as /configure.
    const token = profile.sealSettings({ opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" });
    expect(await (await fetch(`${base}/${token}/configure`)).text()).toContain('href="/app/configure/manifest.json"');
    // The addon's own manifests are untouched by these.
    expect((await (await fetch(`${base}/manifest.json`)).json()).id).toBe("bttr.subs");
  });

  it("are offered for the Home Screen on the dashboard only, where the app is worth keeping", async () => {
    const dashboard = await (await fetch(`${base}/dashboard`)).text();
    expect(dashboard).toContain('id="p-overview"');
    expect(dashboard).toMatch(/<script src="\/ui\/install\.js\?v=[0-9a-f]{10}"><\/script>/);
    expect(await (await fetch(`${base}/configure`)).text()).not.toContain("install.js");
    const script = await (await fetch(`${base}/ui/install.js`)).text();
    // Never inside the app itself, and gone for good once dismissed.
    expect(script).toContain('matchMedia("(display-mode: standalone)").matches || nav.standalone === true');
    expect(script).toContain('localStorage.setItem(KEY, "1")');
  });
});

describe("a configuration's own setup page", () => {
  it("says which configuration is being edited", async () => {
    const token = profile.sealSettings({ opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include", label: "Living room" });
    const html = await (await fetch(`${base}/${token}/configure`)).text();
    expect(html).toContain("<title>Editing Living room · BttrSubs</title>");
    expect(html).toContain('<p class="side-label">Editing Living room</p>');
    expect(await (await fetch(`${base}/configure`)).text()).toContain('<p class="side-label">New configuration</p>');
  });
});

describe("the sign-in pages", () => {
  it("each show the way to the other page, as a home-screen app has no address bar", () => {
    expect(access.loginPage("/dashboard", true)).toContain('<a class="signin-link" href="/configure" aria-label="New configuration">');
    expect(access.loginPage("/configure", false)).toContain('<a class="signin-link" href="/dashboard" aria-label="Dashboard">');
  });

  it("give the browser's bar the page's own background in each theme, where setup and the dashboard give their top bar's graphite", async () => {
    const colours = (html: string) => [...html.matchAll(/<meta name="theme-color" content="([^"]+)"(?: media="([^"]+)")?>/g)].map((m) => [m[1], m[2] ?? ""]);
    for (const forAdmin of [true, false]) {
      expect(colours(access.loginPage(forAdmin ? "/dashboard" : "/configure", forAdmin))).toEqual([
        ["#EEEEEC", "(prefers-color-scheme: light)"],
        ["#121316", "(prefers-color-scheme: dark)"]
      ]);
    }
    for (const page of ["/dashboard", "/configure"]) expect(colours(await (await fetch(`${base}${page}`)).text())).toEqual([["#16171A", ""]]);
    // The colours are app.css's own --paper, light and dark.
    const css = await (await fetch(`${base}/ui/app.css`)).text();
    expect(css).toContain("--paper: #EEEEEC;");
    expect(css).toContain("--paper: #121316;");
  });
});

describe("signing in from the page's script", () => {
  async function withAdmin(run: () => Promise<void>) {
    config.adminPassword = ADMIN;
    try {
      await run();
    } finally {
      config.adminPassword = undefined;
    }
  }
  const signIn = (password: string, ip = nextIp()) =>
    fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip }, body: new URLSearchParams({ password, next: "/dashboard" }) });

  it("answers with where to go, or what's wrong, as JSON", () =>
    withAdmin(async () => {
      const wrong = await signIn("not-it");
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: "That password isn't right. It's the one set as ADMIN_PASSWORD on the server; check Caps Lock." });
      const right = await signIn(ADMIN);
      expect(right.status).toBe(200);
      expect(await right.json()).toEqual({ next: "/dashboard" });
      expect(right.headers.get("set-cookie")).toMatch(/^bttr_session=/);
    }), 10000);

  it("answers a plain form with the page again, and the way in", () =>
    withAdmin(async () => {
      const form = (password: string) => fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": nextIp() }, body: new URLSearchParams({ password, next: "/dashboard" }) });
      const wrong = await form("not-it");
      expect(wrong.status).toBe(401);
      const html = await wrong.text();
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain("check Caps Lock");
      const right = await form(ADMIN);
      expect(right.status).toBe(303);
      expect(right.headers.get("location")).toBe("/dashboard");
    }), 10000);
});

describe("Copy install URL", () => {
  const change = async (body: unknown, cookie = "") => {
    const html = await (await fetch(`${base}/dashboard`, { headers: cookie ? { Cookie: cookie } : {} })).text();
    const csrf = html.match(/<meta name="csrf" content="([^"]*)">/)?.[1] ?? "";
    return fetch(`${base}/dashboard/links/install-url`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": csrf, "X-Forwarded-For": nextIp(), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  };

  it("gives a configuration's install URL only when asked, from the dashboard itself", async () => {
    const token = profile.sealSettings({ subsource: "sk_placeholder_copy_key", aiostreams: "https://aiostreams.example.com/stremio/copy0001-uuid/E2-placeholder/manifest.json", languages: ["English"], allowMachine: false, hearingImpaired: "include" });
    const id = profile.profileFromSettings(profile.openSettings(token)!, token).name;
    profile.noteLinkToken(id, token);
    const answer = await change({ link: id });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ url: `https://sync.example/${token}/manifest.json` });
    // The page itself never holds it.
    expect(await (await fetch(`${base}/dashboard`)).text()).not.toContain(token);
    expect((await change({ link: "nobody/000000" })).status).toBe(404);
    // Not from the dashboard: refused.
    const forged = await fetch(`${base}/dashboard/links/install-url`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", "X-CSRF-Token": "x", "X-Forwarded-For": nextIp() }, body: JSON.stringify({ link: id }) });
    expect(forged.status).toBe(403);
    // A deleted configuration has none.
    await profile.deleteLink(id);
    expect((await change({ link: id })).status).toBe(404);
  });
});

describe("styles from the page", () => {
  it("checks each one, and finds a show the configuration has with nothing looked up", async () => {
    const { checkStep } = await import("../src/configure.js");
    expect(await checkStep("style", { styles: [{ scope: "show", id: "not an id", up: "15" }] })).toEqual({ error: "Styles: paste the show's IMDb link, or its id (tt…)" });
    expect(await checkStep("style", { styles: [{ scope: "show", id: "tt0000001", up: "200" }] })).toEqual({ error: "Styles: how far up must be 1 to 80%" });
    // A show moved up before styles takes the new height as its style, with nothing looked up.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const current = { opensubtitles: true, languages: ["English"], allowMachine: false, hearingImpaired: "include" as const, raise: [{ id: "tt0000002", name: "Show (2020)", percent: 15 }] };
    expect(await checkStep("style", { styles: [{ scope: "show", id: "tt0000002", up: "30" }, { scope: "all", look: "large" }] }, current)).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("what's new and updates", () => {
  it("reads the newest section of the changelog shipped with this build", () => {
    const notes = updates.newestNotes(readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8"));
    expect(notes?.heading).toMatch(/^(Unreleased|\d+\.\d+\.\d+)$/);
    expect(notes?.items.length).toBeGreaterThan(0);
    expect(notes?.items.every((x) => !x.text.includes("**") && !x.text.includes("`"))).toBe(true);
    expect(updates.newestNotes("## [2.0.0]\n\nFirst.\n\n- **Faster,** by a lot: `x` and [docs](https://e.example).\n- Plain line.\n")).toEqual({
      heading: "2.0.0",
      items: [{ title: "Faster", text: "by a lot: x and docs." }, { title: "", text: "Plain line." }]
    });
    expect(updates.newestNotes("# Changelog\n")).toBeUndefined();
  });

  it("compares versions by number, never as text", () => {
    expect(updates.isNewer("v1.10.0", "1.9.3")).toBe(true);
    expect(updates.isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(updates.isNewer("0.9.9", "1.0.0")).toBe(false);
    expect(updates.isNewer("1.1.0-beta", "1.0.0")).toBe(false);
  });

  it("asks GitHub once with a plain GET, and says only a newer, published release", async () => {
    const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    updates.resetUpdates();
    const ok = answer({ tag_name: "v9.0.0", html_url: "https://github.com/jager-gg/BttrSubs/releases/tag/v9.0.0", published_at: "2026-11-10T00:00:00Z" });
    await updates.checkForUpdate(ok as unknown as typeof fetch);
    expect(ok).toHaveBeenCalledTimes(1);
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/jager-gg/BttrSubs/releases/latest");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Accept: "application/vnd.github+json", "User-Agent": "BttrSubs" });
    expect(updates.newerRelease("1.0.0")).toEqual({ version: "9.0.0", url: "https://github.com/jager-gg/BttrSubs/releases/tag/v9.0.0", publishedAt: Date.parse("2026-11-10T00:00:00Z") });
    expect(updates.newerRelease("9.0.0")).toBeUndefined();
    // A link elsewhere is never shown; the project's own releases page stands in.
    updates.resetUpdates();
    await updates.checkForUpdate(answer({ tag_name: "v9.0.1", html_url: "https://evil.example/x" }) as unknown as typeof fetch);
    expect(updates.newerRelease("1.0.0")?.url).toBe("https://github.com/jager-gg/BttrSubs/releases/latest");
    // None published yet, a pre-release, or unreachable: nothing.
    for (const fetcher of [answer({ message: "Not Found" }, 404), answer({ tag_name: "v9.1.0", prerelease: true }), vi.fn(async () => { throw new Error("offline"); })]) {
      updates.resetUpdates();
      await updates.checkForUpdate(fetcher as unknown as typeof fetch);
      expect(updates.newerRelease("1.0.0")).toBeUndefined();
    }
  });

  it("asks nothing when switched off, and shows nothing it found before", async () => {
    updates.resetUpdates();
    await updates.checkForUpdate((async () => new Response(JSON.stringify({ tag_name: "v9.0.0" }))) as unknown as typeof fetch);
    config.updateCheck = false;
    try {
      expect(updates.newerRelease("1.0.0")).toBeUndefined();
      const never = vi.fn();
      await updates.checkForUpdate(never as unknown as typeof fetch);
      expect(never).not.toHaveBeenCalled();
    } finally {
      config.updateCheck = true;
      updates.resetUpdates();
    }
  });

  it("goes to the dashboard with its data, and the session can see the switch", async () => {
    const owner = `bttr_session=${access.sessionValue(["admin", "addon"])}`;
    const data = (await (await fetch(`${base}/dashboard/data`, { headers: { Cookie: owner } })).json()) as { updates: { notes: { heading: string } | null; newer: unknown; checking: boolean }; settings: Array<{ key: string; kind: string; value: string }> };
    expect(data.updates.notes?.heading).toMatch(/^(Unreleased|\d+\.\d+\.\d+)$/);
    expect(data.updates.newer).toBeNull();
    expect(data.updates.checking).toBe(true);
    expect(data.settings.find((x) => x.key === "updateCheck")).toMatchObject({ kind: "toggle", value: "on" });
  });
});
