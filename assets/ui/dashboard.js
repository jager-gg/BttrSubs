/*
 * The dashboard: six sections drawn from one data object (window.BTTR, built by dashboardData.ts), and
 * every change sent to the server as a POST with the page's CSRF token. After a change, or on Refresh,
 * the page fetches the data again (/dashboard/data) and draws the open section anew.
 */
(() => {
  "use strict";
  let D = window.BTTR;
  let NOW = D.now;
  const DAY = 86_400_000;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  // A dropdown focused from code opens on iOS (its picker comes back right after a choice): after a
  // touch, focus put back after a panel is drawn again skips a dropdown (focusIn).
  let byFinger = false;
  addEventListener("pointerdown", (e) => { byFinger = e.pointerType === "touch"; }, true);
  addEventListener("keydown", () => { byFinger = false; }, true);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // Reduce motion: the switch in the shortcuts dialog (html.calm / html.moving), else the device's setting.
  const calmNow = () => document.documentElement.classList.contains("calm") || (!document.documentElement.classList.contains("moving") && matchMedia("(prefers-reduced-motion: reduce)").matches);
  let reduce = calmNow();
  const touch = matchMedia("(pointer: coarse)").matches;

  // ---------- icons: one stroke family, drawn here ----------
  const ICONS = {
    bubble: '<path d="M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H9.5c-1.3 1.6-3 2.6-5.3 2.9.9-1 1.3-2 1.3-3.2A4 4 0 0 1 3 14V8a4 4 0 0 1 4-4z"/><path d="M8.5 11.5h7M10 14.5h4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 20 3M16.5 6.5l3 3M14 9l2 2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="3"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
    alert: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2h.01"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
    moon: '<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    out: '<path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3"/><path d="M15 16.5 19.5 12 15 7.5M19.5 12H9"/>',
    chev: '<path d="M9 5.5 15.5 12 9 18.5"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    pause: '<path d="M8.5 5v14M15.5 5v14"/>',
    play: '<path d="M7.5 5.2v13.6a.6.6 0 0 0 .9.5l10.7-6.8a.6.6 0 0 0 0-1L8.4 4.7a.6.6 0 0 0-.9.5z"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13"/>',
    pen: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 7.5l2 2"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
    filter: '<path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20.5 20.5"/>',
    hide: '<path d="M3.5 3.5l17 17"/><path d="M10.4 5.7A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.7M6.7 6.7C4 8.4 2.5 12 2.5 12S6 18.5 12 18.5a8.7 8.7 0 0 0 4.6-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    up: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/><path d="M5 20.5h14"/>'
  };
  const icon = (name, cls = "ic") => `<span class="${cls}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[name]}</svg></span>`;
  const paintIcons = (root = document) => $$("[data-icon]", root).forEach((el) => { el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[el.dataset.icon]}</svg>`; el.removeAttribute("data-icon"); });

  const Bubs = window.BubsNoir;

  // ---------- the server ----------
  const csrf = () => $('meta[name="csrf"]').content;
  // A change: JSON in and out, from this page only (its CSRF token). Refused, it throws the server's words.
  async function post(path, body = {}) {
    let response;
    try {
      response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrf() }, body: JSON.stringify(body) });
    } catch {
      throw new Error("The server didn't answer. Check your connection and try again.");
    }
    const answer = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("Signed out. Reload the page to sign in again.");
    if (!response.ok) throw Object.assign(new Error(answer.error ? `${answer.error}.`.replace(/\.\.$/, ".") : `The server answered ${response.status}.`), { field: answer.field });
    return answer;
  }
  // The data again, as the server has it now; the open section is drawn anew from it.
  async function reload() {
    const response = await fetch("/dashboard/data", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (response.status === 401) throw new Error("Signed out. Reload the page to sign in again.");
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    D = await response.json();
    NOW = D.now;
    state.clearedAt = D.errorsClearedAt || 0;
    state.paused = { ...D.paused };
    state.names = { ...D.names };
    if (!Object.keys(state.draft).length && !state.pw) state.settings = Object.fromEntries(D.settings.map((s) => [s.key, { ...s }]));
    $("#updated").innerHTML = `<span class="upd-word">Updated </span>${hhmm(NOW)}`;
    syncBadge();
    paintNotes();
  }

  // ---------- formatting, on the dashboard's clock ----------
  const tz = D.tz;
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  const hhmm = (t) => clock.format(t);
  const n = (v) => Math.round(v ?? 0).toLocaleString("en-US");
  const dayLabel = (t) => {
    const k = dateKey.format(t);
    if (k === dateKey.format(NOW)) return "Today";
    if (k === dateKey.format(NOW - DAY)) return "Yesterday";
    return dayFmt.format(t);
  };
  const ago = (t) => {
    const s = Math.max(0, (NOW - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const d = Math.round(s / 86400);
    return `${d} ${d === 1 ? "day" : "days"} ago`;
  };
  const bytes = (b) => {
    if (!b) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log10(b) / 3));
    const v = b / 1000 ** i;
    return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${u[i]}`;
  };
  const duration = (s) => {
    s = Math.round(s);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
  };
  // Big numbers, small units: "2 h 10 min" sets 2 and 10 large, h and min small.
  const splitUnit = (text) => text.replace(/\s?([A-Za-z]+)/g, '<span class="unit">$1</span>').replace(/<\/span>(\d)/g, "</span> $1");
  const when = (t) => (dayLabel(t) === "Today" ? hhmm(t) : `${dayLabel(t).replace("Yesterday", "yesterday")}, ${hhmm(t)}`);
  const SRC = { subsource: "SubSource", subdl: "SubDL", wyzie: "Wyzie Subs", opensubtitles: "OpenSubtitles", thesubtitledb: "TheSubtitleDB", gestdown: "Gestdown", animetosho: "Anime Tosho", tsukihime: "TsukiHime", aninzb: "aninzb", subtitlecat: "Subtitle Cat", addons: "Added addons", aiostreams: "AIOStreams" };
  const srcId = (name) => {
    const k = String(name).toLowerCase().replace(/[^a-z]/g, "");
    return Object.keys(SRC).find((id) => k.startsWith(id)) ?? null;
  };
  const srcImg = (name) => {
    const id = srcId(name);
    return id && id !== "addons" ? `<img src="/sources/${id}.png?v=3" alt="" width="22" height="22">` : `<span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS.link}</svg></span>`;
  };
  const srcLabel = (name) => SRC[srcId(name)] ?? name;
  const breakable = (s) => esc(s).replace(/([._\-\])])/g, "$1<wbr>");

  // ---------- state ----------
  const state = {
    tab: "overview",
    debug: false,
    clearedAt: D.errorsClearedAt || 0,
    filter: { kind: "all", link: "all", q: "" },
    page: 0,
    paused: { ...D.paused },
    names: { ...D.names },
    settings: Object.fromEntries(D.settings.map((s) => [s.key, { ...s }])),
    draft: {},
    pw: "",
    refused: null,
    clearFor: "",
    confirming: null,
    errFor: "all"
  };
  const nameOf = (id) => state.names[id] ?? state.names[String(id).split("/")[0]] ?? null;
  const labelOf = (id) => nameOf(id) ?? `Unnamed · ${String(id).split("/")[0]}`;
  const live = () => D.activity.filter((a) => state.debug || !a.debug);
  const cutOf = (link) => Math.max(state.clearedAt, D.linkClears?.[link]?.errorsAt ?? 0);
  const cueOf = (a) => {
    if (a.kind === "list") return "list";
    if (a.result.startsWith("error")) return a.at >= cutOf(a.link) ? "error" : "list";
    if (a.result.startsWith("synced") || a.result === "first-pass timing") return "synced";
    return "asis";
  };
  const CUE_WORD = { synced: "Synced to the file", asis: "Sent unsynced", list: "List", error: "Failed request" };
  // The server says "sent as it came"; the page says what that means for the viewer.
  const resultWord = (r) => (r === "sent as it came" ? "sent unsynced" : r.replace(/, partial$/, ", a source late"));
  const took = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

  // ---------- inline help ----------
  const HELP = { day: "<b>One line per configuration</b>, each mark one request at its time. <b>Synced</b>: a subtitle timed to the file. <b>Sent unsynced</b>: it couldn't be timed, so it went out unchanged. <b>Another file's, not sent</b>: its lines fit nothing in the file and no other subtitle did, so one line saying so went out instead. <b>List</b>: a player asked which subtitles there are. <b>Failed request</b>: the player got nothing back. A source can fail inside a request that still answers; those show under Errors, not here. " + (touch ? "Tap the track" : "Point at the track, or use the arrow keys on it,") + " to read any mark.", week: "The last 7 days, test plays left out. <b>Subtitles synced</b>: of the subtitles players downloaded, the share timed to their file. <b>Closest to a limit</b>: the API key nearest one of its free-plan limits. <b>CPU time</b>: BttrSubs and the ffmpeg it runs. <b>Downloaded</b> and <b>Sent</b>: all of the container's traffic, mostly reading short parts of the videos played.", now: "Read inside the container a moment ago. <b>CPU</b> is a share of one core. <b>Memory</b> includes ffmpeg while it runs. <b>Cache on disk</b> holds subtitles, synced copies and each video's anchor points; files unused for 14 days are removed daily.", results: "<b>List</b>: a player asked which subtitles there are; “2 tracks, 2 synced” is how many went back and how many are timed to the file. <b>A source late</b>: one answered too late and was left out; its results are kept for next time. <b>Download</b>: a player fetched one subtitle. <b>Synced</b>: timed to the file, <b>(audio)</b> by listening to the speech. <b>Fallback</b>: the listed subtitle only fitted loosely, so another that fitted well was sent. <b>First-pass timing</b>: timed from the first windows while the rest is still measured. <b>Unsynced stand-in</b>: timing wasn't ready, so it went out untimed; the next request gets it synced. <b>Sent unsynced</b> and <b>couldn't sync</b>: no timing was found, so it went out unchanged.", keys: "<b>SubSource</b> allows 60 calls a minute, 1,800 an hour and 7,200 a day. <b>SubDL</b> allows 2,000 requests and 50 downloads a day. <b>Wyzie Subs</b> allows 1,000 requests a day, and a search costs one for each of its four sources.<br><br><b>This minute</b>, <b>this hour</b> and <b>today</b> count a key's calls over the last 60 seconds, 60 minutes and 24 hours, as SubSource counts them; when SubSource reports its own count, that is shown instead. SubDL counts by the calendar day in UTC. Wyzie Subs reports what a key has left with every reply, its day reset at midnight UTC; that count is shown, every app on the key included. <b>Refused</b>: the site turned a call away, usually for going over a limit." };
  const info = (id, what, text) =>
    `<span class="info-wrap"><button type="button" class="${text ? "info-link" : "info-btn"}" aria-expanded="false" aria-controls="info-${id}"${text ? "" : ` aria-label="Explain ${what}"`}>${text ? `${icon("info")}${text}` : icon("info")}</button><span class="info-pop" id="info-${id}" role="note" hidden>${HELP[id]}</span></span>`;

  // ---------- the verdict ----------
  function limits() {
    const out = [];
    for (const k of D.keys) {
      if (!k.weekCalls) continue;
      for (const m of k.meters) out.push({ what: `${SRC[k.service] ?? k.service} · ${m.label.toLowerCase()}`, used: m.used, max: m.max, key: k.id });
    }
    return out.sort((a, b) => b.used / b.max - a.used / a.max);
  }
  function verdict() {
    const errs = D.errors.filter((e) => !e.debug && e.at >= Math.max(NOW - DAY, state.clearedAt));
    const closest = limits()[0];
    const share = closest ? closest.used / closest.max : 0;
    const requests24 = D.activity.filter((a) => !a.debug && a.at >= NOW - DAY).length;
    const problems = [];
    // A key the site refused in the last 24 hours (usually for going over a limit): its searches went unanswered.
    const refused = D.keys.filter((k) => k.lastRefusedAt >= NOW - DAY).sort((a, b) => b.lastRefusedAt - a.lastRefusedAt)[0];
    if (refused) problems.push(["bad", `A ${SRC[refused.service] ?? refused.service} key was refused ${ago(refused.lastRefusedAt)}`, "keys"]);
    if (share >= 0.9) problems.push(["bad", `Close to a limit: ${closest.what}`, "keys"]);
    else if (share >= 0.6) problems.push(["warn", `Getting close to a limit: ${closest.what}`, "keys"]);
    // A source error inside a request that still answered is worth a look; a request that failed
    // (the player got nothing) is a real failure.
    const failed = errs.filter((e) => !stillAnswered(e)).length;
    const answered = errs.length - failed;
    const latest = (xs) => ago(Math.max(...xs.map((e) => e.at)));
    const failedErrs = errs.filter((e) => !stillAnswered(e)), answeredErrs = errs.filter(stillAnswered);
    if (failed) problems.push(["bad", failed === 1 ? `A request failed ${latest(failedErrs)}` : `${failed} requests failed in 24 h, the last ${latest(failedErrs)}`, "errors"]);
    // A source error whose request still answered is a hiccup: the next request asks again. It raises the
    // verdict only when one source keeps failing, more than twice its usual day and at least 3 times in 24 h.
    // Calibration (a week of real use): the busiest sources failed 10 to 12 times a week with every request
    // still answered, so a source's own usual day sets its bar, and fewer than 3 in a day never raises it.
    const bySource = Object.entries(answeredErrs.reduce((m, e) => ((m[e.where] = (m[e.where] ?? 0) + 1), m), {}));
    const usualDay = (src) => (D.sources.find((s) => s.id === src)?.failures ?? 0) / 7;
    const failing = bySource.filter(([src, k]) => k >= Math.max(3, 2 * usualDay(src))).sort((a, b) => b[1] - a[1]);
    const notes = [];
    if (failing.length) { const [src, k] = failing[0]; problems.push(["warn", `${SRC[src] ?? src} keeps failing: ${k} errors in 24 h, the last ${latest(answeredErrs.filter((e) => e.where === src))}; requests still answered`, "errors"]); }
    else if (answered) notes.push(["quiet", `${answered} source ${answered === 1 ? "hiccup" : "hiccups"} in 24 h, the last ${latest(answeredErrs)}; ${answered === 1 ? "its request" : "all"} still answered`, "errors"]);
    const level = problems.some(([l]) => l === "bad") ? "bad" : problems.length ? "warn" : requests24 ? "ok" : "quiet";
    const words = { ok: "Smooth as butter.", warn: "Worth a look.", bad: "Something's wrong.", quiet: "All quiet." }[level];
    const mood = { ok: "beam", warn: "half", bad: "clench", quiet: "sleepy" }[level];
    return { level, words, mood, problems, notes, requests24 };
  }

  // ---------- Bubs on the stage: lip sync and eyes on the pointer ----------
  let sayTimers = [];
  let said = false;
  function stageBubs(mood, mouth) {
    return `<button class="bubs-hit" type="button" id="bubs" tabindex="-1" aria-hidden="true"><div class="bubs-spot">${Bubs.full({ mood, mouth, blink: true, id: "stage" })}</div></button>`;
  }

  // His pupils follow the pointer anywhere on the page, eased so they glide rather than snap.
  const pointer = { x: null, y: null };
  let eyeLoop = 0;
  addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; if (!eyeLoop && !reduce) eyeLoop = requestAnimationFrame(trackEyes); }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.x = null; if (!eyeLoop && !reduce) eyeLoop = requestAnimationFrame(trackEyes); });
  function trackEyes() {
    eyeLoop = 0;
    const svg = $("#bubs-host svg");
    if (!svg) return;
    const m = svg.getScreenCTM();
    if (!m) return;
    let moving = false;
    for (const p of $$(".noir-pupil", svg)) {
      const cx = Number(p.dataset.cx), cy = Number(p.dataset.cy);
      let tx = 0, ty = 0;
      if (pointer.x !== null) {
        const sx = m.a * cx + m.c * cy + m.e, sy = m.b * cx + m.d * cy + m.f;
        const dx = pointer.x - sx, dy = pointer.y - sy;
        const d = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, d / 260);
        tx = (dx / d) * 8 * reach;
        ty = (dy / d) * 11 * reach;
      }
      const cur = p._o ?? { x: 0, y: 0 };
      cur.x += (tx - cur.x) * 0.18;
      cur.y += (ty - cur.y) * 0.18;
      p._o = cur;
      if (Math.abs(tx - cur.x) > 0.05 || Math.abs(ty - cur.y) > 0.05) moving = true;
      p.setAttribute("transform", `translate(${(cx + cur.x).toFixed(2)} ${(cy + cur.y).toFixed(2)})`);
    }
    if (moving) eyeLoop = requestAnimationFrame(trackEyes);
  }

  const shapeOf = (word) => {
    const w = word.toLowerCase();
    const v = (w.match(/[aeiou]/) ?? ["e"])[0];
    return v === "o" || v === "u" ? "talkO" : v === "a" ? "talkA" : "talkE";
  };
  function say(v) {
    sayTimers.forEach(clearTimeout);
    sayTimers = [];
    const host = $("#bubs-host");
    const cap = $("#caption");
    if (!host || !cap) return;
    host.innerHTML = stageBubs(v.mood, reduce ? undefined : "rest");
    $("#bubs").addEventListener("click", () => say(verdict()));
    const words = v.words.split(" ");
    cap.innerHTML = words.map((w) => `<span class="w${reduce ? "" : " wait"}">${esc(w)}</span>`).join(" ");
    // The first verdict is read from the heading; a later one (after a refresh) is said once here.
    if (said) $("#verdict-say").textContent = `Overview: ${v.words}`;
    said = true;
    const svg = $("svg", host);
    const setMouth = (k) => { const m = $(".bubs-mouth", svg); if (m) m.innerHTML = Bubs.MOUTHS[k]; };
    trackEyes();
    if (reduce) return;
    svg.parentElement.classList.add("bounce");
    let t = 260;
    words.forEach((w, i) => {
      const at = t;
      sayTimers.push(setTimeout(() => { setMouth(shapeOf(w)); $$(".w", cap)[i]?.classList.remove("wait"); }, at));
      sayTimers.push(setTimeout(() => setMouth("talkE"), at + 140));
      sayTimers.push(setTimeout(() => setMouth("rest"), at + 230));
      t += 300 + Math.min(220, w.length * 22);
    });
    sayTimers.push(setTimeout(() => {
      setMouth(Bubs.MOODS[v.mood].mouth);
      if (v.level === "ok") svg.parentElement.classList.add("cheer");
    }, t));
    sayTimers.push(setTimeout(() => svg.parentElement.classList.remove("bounce", "cheer"), t + 1400));
  }

  // ---------- overview ----------
  function laneData() {
    const from = NOW - DAY;
    const rows = live().filter((a) => a.at >= from);
    const ids = [...new Set(rows.map((a) => a.link))];
    for (const id of Object.keys(state.paused)) if (!ids.includes(id)) ids.push(id);
    ids.sort((a, b) => Math.max(...rows.filter((r) => r.link === b).map((r) => r.at), 0) - Math.max(...rows.filter((r) => r.link === a).map((r) => r.at), 0));
    return { from, rows, ids };
  }
  const xOf = (t, from) => ((t - from) / DAY) * 100;
  function hourTicks(from) {
    const out = [];
    for (let t = Math.ceil(from / 3_600_000) * 3_600_000; t <= NOW; t += 3_600_000) {
      const h = Number(hhmm(t).slice(0, 2));
      if (h % 6 === 0) out.push({ x: xOf(t, from), label: hhmm(t) });
    }
    return out;
  }
  function timetable() {
    const { from, rows, ids } = laneData();
    if (!ids.length) {
      return `<div class="empty"><div class="bubs-spot">${Bubs.full({ mood: "sleepy", shadow: false })}</div><div><h2>Nothing asked for in 24 hours</h2><p>The butter's still in the fridge. Requests show here as they come in, one line per configuration.</p></div></div>`;
    }
    const lanes = ids
      .map((id) => {
        const cues = rows.filter((a) => a.link === id).sort((a, b) => a.at - b.at)
          .map((a) => `<span class="cue ${cueOf(a)}" style="left:${xOf(a.at, from).toFixed(3)}%"></span>`).join("");
        return `<div class="lane${state.paused[id] ? " paused" : ""}"><span class="lane-name" title="${esc(labelOf(id))}">${esc(nameOf(id) ?? String(id).split("/")[0])}</span><div class="lane-track">${cues}</div></div>`;
      })
      .join("");
    const ticks = hourTicks(from).filter((t) => t.x < 88).map((t) => `<span style="left:${t.x.toFixed(2)}%">${t.label}</span>`).join("");
    return `<div class="tracks" id="tracks" tabindex="0" role="slider" aria-label="Requests in the last 24 hours" aria-valuemin="0" aria-valuemax="${rows.length}" aria-valuenow="0" aria-valuetext="Use the arrow keys to step through requests">
        ${lanes}
        <div class="axis"><span></span><div class="axis-in">${ticks}</div></div>
        <div class="now" aria-hidden="true"><b>now ${hhmm(NOW)}</b></div>
        <div class="scrub-line" id="scrub" hidden></div>
      </div>
      <p class="readout" id="readout">${rows.length ? `<span class="readout-sum"><b>${n(rows.length)}</b> ${rows.length === 1 ? "request" : "requests"} from ${ids.length} ${ids.length === 1 ? "configuration" : "configurations"}. ${touch ? "Tap" : "Point at"} the track to read another.</span><span class="readout-now" id="readout-now"></span>` : ""}</p>`;
  }
  function bindTimetable() {
    const box = $("#tracks");
    if (!box) return;
    const { from, rows } = laneData();
    const sorted = rows.slice().sort((a, b) => a.at - b.at);
    const track = $(".lane-track", box);
    const scrub = $("#scrub");
    // The summary line stays; only the line under it changes, and it never changes height.
    const now = $("#readout-now");
    let idx = sorted.length - 1;
    const newest = sorted[sorted.length - 1];
    const show = (a) => {
      if (!a) return;
      const r = track.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      scrub.hidden = false;
      scrub.style.left = `${r.left - b.left + (xOf(a.at, from) / 100) * r.width}px`;
      const detail = a.kind === "list" ? `list · ${a.result}` : `${resultWord(a.result)}`;
      now.innerHTML = `<span class="ro-meta">${a === newest ? "Newest: " : ""}<b>${hhmm(a.at)}</b> · ${esc(labelOf(a.link))} · ${esc(detail)}</span><span class="ro-what"><span class="cue ${cueOf(a)}"></span>${esc(a.what)}</span>`;
      box.setAttribute("aria-valuenow", String(sorted.indexOf(a)));
      box.setAttribute("aria-valuetext", `${hhmm(a.at)}, ${labelOf(a.link)}, ${a.what}, ${detail}`);
    };
    const nearest = (clientX) => {
      const r = track.getBoundingClientRect();
      const t = from + ((clientX - r.left) / r.width) * DAY;
      let best = null;
      for (const a of sorted) if (!best || Math.abs(a.at - t) < Math.abs(best.at - t)) best = a;
      return best;
    };
    // Untouched, it already answers: the newest request, marked on the track and named under it.
    show(newest);
    box.addEventListener("pointermove", (e) => { const a = nearest(e.clientX); idx = sorted.indexOf(a); show(a); });
    box.addEventListener("pointerdown", (e) => { const a = nearest(e.clientX); idx = sorted.indexOf(a); show(a); });
    box.addEventListener("keydown", (e) => {
      if (!sorted.length) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") idx = Math.max(0, idx - 1);
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") idx = Math.min(sorted.length - 1, idx + 1);
      else if (e.key === "Home") idx = 0;
      else if (e.key === "End") idx = sorted.length - 1;
      else return;
      e.preventDefault();
      show(sorted[idx]);
    });
  }

  function overview() {
    const v = verdict();
    const out = D.outcomes;
    const syncedShare = out.served ? out.synced / out.served : 0;
    const lines = v.problems.length
      ? v.problems.map(([lvl, text, to]) => `<li><a href="#${to}" data-tab="${to}"><span class="dot ${lvl}"></span>${esc(text)}${icon("chev", "ic chev")}</a></li>`).join("")
      : v.level === "quiet"
        ? `<li><span class="line"><span class="dot quiet"></span>Nothing was asked for in the last 24 hours</span></li>`
        : v.notes.length
          ? v.notes.map(([lvl, text, to]) => `<li><a href="#${to}" data-tab="${to}"><span class="dot ${lvl}"></span>${esc(text)}${icon("chev", "ic chev")}</a></li>`).join("")
          : `<li><span class="line"><span class="dot"></span>Nothing refused or failing in the last 24 hours</span></li>`;
    const closest = limits()[0];
    const cShare = closest ? closest.used / closest.max : 0;
    const lvl = (s) => (s >= 0.9 ? "bad" : s >= 0.6 ? "warn" : "ok");
    const weekErrors = D.errorsWeek;
    const today = D.days[0];
    const debugOn = state.debug;

    const days = D.days.slice(0, 7).reverse();
    const chart = (title, hint, value, fmt) => {
      const max = Math.max(...days.map(value), 1);
      const sticks = days.map((d, i) => {
        const v = value(d);
        const isToday = i === days.length - 1;
        const label = isToday ? "Today" : dayFmt.format(Date.parse(`${d.date}T12:00:00Z`)).replace(/ \w+$/, "");
        const share = v / max;
        return `<div class="stick${isToday ? " today" : ""}${v ? "" : " blank"}${share < 0.14 ? " tiny" : ""}" role="listitem" style="--h:${(share * 100).toFixed(1)}%" aria-label="${label}: ${fmt(v)}"><i><span class="val">${fmt(v)}</span></i></div>`;
      }).join("");
      const labels = days.map((d, i) => `<span class="${i === days.length - 1 ? "today" : ""}">${i === days.length - 1 ? "Today" : dayFmt.format(Date.parse(`${d.date}T12:00:00Z`)).split(" ").slice(0, 2).join(" ")}</span>`).join("");
      return `<div class="chart"><h3>${title}</h3><p class="hint">${hint}</p><div class="sticks" role="list" aria-label="${title}, each day" style="--n:${days.length}">${sticks}</div><div class="days" style="--n:${days.length}">${labels}</div></div>`;
    };
    const disk = D.server.disk;
    const diskShare = disk ? 1 - disk.freeBytes / disk.totalBytes : 0;
    const cpu = D.server.cpuPercent;
    const cpuShare = cpu === null ? 0 : cpu / 100;
    const cpuWord = cpuShare < 0.5 ? "Light" : cpuShare < 0.9 ? "Busy" : "Heavy";

    return `
      <div class="notes-inline">${noteCards("inline")}</div>
      <div class="stage level-${v.level}">
        <div id="bubs-host"></div>
        <div class="intertitle">
          <h1 class="caption" id="caption"></h1>
          <p class="sr-only" role="status" id="verdict-say"></p>
          <span class="sr-only" id="verdict-line" aria-hidden="true">Overview: ${esc(v.words)}</span>
          <ul class="verdict-lines">${lines}</ul>
          ${out.served ? `<p class="synced-line"><span><b>${Math.round(syncedShare * 100)}%</b> of this week's ${n(out.served)} subtitles synced to their file</span></p>` : ""}
        </div>
      </div>

      <section class="block track-card" aria-labelledby="h-24">
        <div class="block-head"><div class="head-title"><h2 id="h-24">Last 24 hours</h2>${info("day", "the 24-hour track")}</div>
          <label class="switch-row"><input class="switch" type="checkbox" role="switch" id="debug-toggle"${debugOn ? " checked" : ""}> Include the ${n(D.debugCount)} test plays</label>
        </div>
        <div class="legend"><span><i class="cue synced"></i>Synced</span><span><i class="cue asis"></i>Sent unsynced</span><span><i class="cue list"></i>List</span><span><i class="cue error"></i>Failed request</span></div>
        ${timetable()}
      </section>

      <section class="block" aria-labelledby="h-week">
        <div class="block-head"><div class="head-title"><h2 id="h-week">This week</h2>${info("week", "this week's figures")}</div><span class="meta">Last 7 days · test plays left out of the counts</span></div>
        <dl class="ledger">
          <div class="row"><dt>Subtitles synced</dt><dd>${out.served ? `${Math.round(syncedShare * 100)}<span class="unit">%</span>` : "–"}</dd><span class="note">${out.served ? `${n(out.synced)} of ${n(out.served)} served${out.asIs ? ` · ${n(out.asIs)} sent unsynced` : ""}${out.failed ? ` · ${n(out.failed)} failed` : ""}` : "None served this week"}</span><div class="tube" style="--v:${syncedShare}" aria-hidden="true"><i></i></div></div>
          <div class="row"><dt>Closest to a limit</dt><dd>${closest ? `<a href="#keys" data-tab="keys" aria-label="${n(closest.used)} of ${n(closest.max)}, ${esc(closest.what)}. Open Keys">${n(closest.used)}<span class="unit">/ ${n(closest.max)}</span></a>` : "–"}</dd><span class="note">${closest ? `<span class="dot ${lvl(cShare) === "ok" ? "" : lvl(cShare)}"></span>${esc(closest.what)} · ${cShare < 0.01 && closest.used ? "under 1" : Math.round(cShare * 100)}%` : "No key used this week"}</span><div class="tube ${lvl(cShare)}${cShare ? "" : " zero"}" style="--v:${cShare}" aria-hidden="true"><i></i></div></div>
          <div class="row"><dt>Errors</dt><dd>${weekErrors ? `<a href="#errors" data-tab="errors" aria-label="${n(weekErrors)} ${weekErrors === 1 ? "error" : "errors"} this week. Open Errors">${n(weekErrors)}</a>` : "0"}</dd><span class="note">${weekErrors ? `<span class="dot warn"></span>${state.clearedAt > NOW - 7 * DAY ? `Since you cleared them ${when(state.clearedAt)}` : "This week · see them"}` : `<span class="dot"></span>${state.clearedAt > NOW - 7 * DAY ? `None since you cleared them ${when(state.clearedAt)}` : "None this week"}`}</span></div>
          <div class="row small"><dt>CPU time</dt><dd>${splitUnit(duration(D.weekTotal.cpuS))}</dd><span class="note">Today ${duration(today.cpuS)}</span></div>
          <div class="row small"><dt>Downloaded</dt><dd>${splitUnit(bytes(D.weekTotal.rx))}</dd><span class="note">Today ${bytes(today.rx)}</span></div>
          <div class="row small"><dt>Sent</dt><dd>${splitUnit(bytes(D.weekTotal.tx))}</dd><span class="note">Today ${bytes(today.tx)}</span></div>
        </dl>
      </section>

      <section class="block" aria-labelledby="h-days">
        <div class="block-head"><h2 id="h-days">Per day</h2><span class="meta">Today melts a little</span></div>
        <div class="charts">
          ${chart("CPU time", "BttrSubs and the ffmpeg it runs. A new episode adds a few seconds.", (d) => d.cpuS, (v) => (v ? duration(v) : "0"))}
          ${chart("Data", "Downloaded plus sent. Mostly reading the played video's index, or short windows of it.", (d) => d.rx + d.tx, (v) => (v ? bytes(v) : "0"))}
        </div>
        <details class="more"><summary>${icon("chev")}Each day's numbers</summary>
          <div class="table-wrap" tabindex="0" role="region" aria-label="Each day's numbers"><table>
            <thead><tr><th scope="col">Day</th><th scope="col">CPU</th><th scope="col">Downloaded</th><th scope="col">Sent</th><th scope="col">Peak memory</th><th scope="col">Files read</th><th scope="col">ffmpeg</th><th scope="col">Lists</th><th scope="col">Subtitles</th><th scope="col">API calls</th><th scope="col">Errors</th></tr></thead>
            <tbody>${D.days.map((d) => `<tr><th scope="row">${dayLabel(Date.parse(`${d.date}T12:00:00Z`))}</th><td>${d.cpuS >= 1 ? duration(d.cpuS) : "–"}</td><td>${d.rx ? bytes(d.rx) : "–"}</td><td>${d.tx ? bytes(d.tx) : "–"}</td><td>${d.peakMb ? `${d.peakMb} MB` : "–"}</td><td>${n(d.files)}</td><td>${d.procS ? duration(d.procS) : "–"}</td><td>${n(d.lists)}</td><td>${n(d.downloads)}</td><td>${n(d.apiCalls)}</td><td class="${d.errors ? "bad" : ""}">${n(d.errors)}</td></tr>`).join("")}</tbody>
          </table></div>
        </details>
      </section>

      <section class="block" aria-labelledby="h-now">
        <div class="block-head"><div class="head-title"><h2 id="h-now">Right now</h2>${info("now", "the readings")}</div><span class="meta">Inside the container · up ${duration(D.server.uptimeS)}</span></div>
        <div class="readouts">
          <div class="readout-item"><h3>CPU</h3>${cpu === null ? `<div class="big">–</div><p>Only measured inside the addon's container.</p>` : `<div class="big">${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}<span class="unit">% of one core</span></div><div class="tube thin${cpuShare >= 0.9 ? " bad" : cpuShare >= 0.5 ? " warn" : ""}" style="--v:${Math.min(1, cpuShare)}" aria-hidden="true"><i></i></div><p><span class="state"><span class="dot${cpuShare >= 0.9 ? " bad" : cpuShare >= 0.5 ? " warn" : ""}"></span>${cpuWord}</span> · ${D.server.cores} cores; reading a new episode briefly uses more.</p>`}</div>
          <div class="readout-item"><h3>Memory</h3><div class="big">${D.server.memMb}<span class="unit">MB</span></div><p>${D.server.containerMemory ? `Peak ${D.server.memPeakMb} MB today (UTC). Includes ffmpeg while it runs.` : "BttrSubs alone; the container's figure is only measured inside it."}</p></div>
          <div class="readout-item"><h3>Cache on disk</h3><div class="big">${splitUnit(bytes(D.server.cache.bytes))}</div><p>${n(D.server.cache.files)} files. Files unused for 14 days are removed daily; what was read from a playing file is kept 60.</p>${disk ? `<div class="disk-meter"><span class="state"><span class="dot${diskShare >= 0.92 ? " bad" : diskShare >= 0.8 ? " warn" : ""}"></span>Disk ${Math.round(diskShare * 100)}% full · ${bytes(disk.freeBytes)} free</span><div class="tube thin${diskShare >= 0.92 ? " bad" : diskShare >= 0.8 ? " warn" : ""}" style="--v:${diskShare}" aria-hidden="true"><i></i></div></div>` : ""}</div>
        </div>
      </section>

      <section class="block" aria-labelledby="h-src">
        <div class="block-head"><h2 id="h-src">Sources this week</h2><span class="meta">All configurations · test plays left out</span></div>
        <div class="table-wrap src-wrap" tabindex="0" role="region" aria-label="Sources this week"><table>
          <thead><tr><th scope="col">Source</th><th scope="col">Calls</th><th scope="col">Downloads</th><th scope="col" title="Tracks it supplied in subtitle lists, one per language a list carried">Picked</th><th scope="col" title="Of the subtitles players got from it, the share that synced to their file">Synced</th><th scope="col">Failures</th></tr></thead>
          <tbody>${D.sources.map((s) => `<tr><th scope="row"><span class="src">${srcImg(s.id)}${SRC[s.id]}</span></th><td data-label="Calls">${n(s.calls)}</td><td data-label="Downloads">${s.id === "aiostreams" ? "–" : n(s.downloads)}</td><td data-label="Picked">${s.id === "aiostreams" ? "–" : n(s.picked)}</td><td data-label="Synced">${s.served ? `${n(s.synced)} of ${n(s.served)}` : "–"}</td><td data-label="Failures" class="${s.failures ? "bad" : ""}">${s.id === "aiostreams" ? "–" : n(s.failures)}</td></tr>`).join("")}</tbody>
        </table></div>
        <ul class="src-lines">${D.sources.map((s) => { const parts = [[s.calls, "calls"], [s.id === "aiostreams" ? 0 : s.downloads, "downloads"], [s.id === "aiostreams" ? 0 : s.picked, "picked"]].filter(([v]) => v).map(([v, w]) => `${n(v)} ${w}`); if (s.served) parts.push(`${n(s.synced)} of ${n(s.served)} synced`); const fails = s.id === "aiostreams" ? 0 : s.failures; return `<li><span class="src">${srcImg(s.id)}${SRC[s.id]}</span><span class="src-figs">${parts.join(" · ") || "Not used this week"}${fails ? ` · <b class="bad">${n(fails)} ${fails === 1 ? "failure" : "failures"}</b>` : ""}</span></li>`; }).join("")}</ul>
        <dl class="col-help"><div><dt>Picked</dt><dd>tracks it supplied in subtitle lists, one per language a list carried</dd></div><div><dt>Synced</dt><dd>of the subtitles players got from it, how many synced to their file</dd></div><div><dt>Failures</dt><dd>its refusals and failed requests this week, including errors cleared from Errors</dd></div></dl>
      </section>`;
  }
  function bindOverview() {
    $("#debug-toggle")?.addEventListener("change", (e) => { state.debug = e.target.checked; renderPanel("overview", { keepBubs: true }); });
    bindTimetable();
  }

  // ---------- keys ----------
  function keys() {
    const lvl = (s) => (s >= 0.9 ? "bad" : s >= 0.6 ? "warn" : "ok");
    const utcMidnight = (() => { const d = new Date(NOW); d.setUTCHours(24, 0, 0, 0); return d.getTime(); })();
    const groups = new Map();
    for (const k of D.keys) {
      const g = groups.get(k.link ?? "") ?? [];
      g.push(k);
      groups.set(k.link ?? "", g);
    }
    // A key used only in test plays this week is still its configuration's: its group shows with the busy ones.
    const used = (k) => k.weekCalls || k.testCalls;
    const busy = [...groups.entries()].filter(([, ks]) => ks.some(used)).sort((a, b) => Math.max(...b[1].map((k) => k.lastAt)) - Math.max(...a[1].map((k) => k.lastAt)));
    const idle = [...groups.entries()].filter(([, ks]) => !ks.some(used));
    // Calls in test plays aren't counted against a key: said beside the counted ones, or alone when there are none.
    const testLine = (k) => `${n(k.testCalls)} ${k.testCalls === 1 ? "call" : "calls"} in test plays this week, not counted`;
    const callsLine = (k) => (!k.weekCalls && k.testCalls ? testLine(k) : `${n(k.weekCalls)} ${k.weekCalls === 1 ? "call" : "calls"} this week${k.lastAt ? ` · last call ${hhmm(k.lastAt)}, ${ago(k.lastAt)}` : ""}${k.testCalls ? ` · ${n(k.testCalls)} more in test plays, not counted` : ""}`);
    const keyRow = (k) => {
      const zero = k.meters.filter((m) => !m.used);
      const meters = k.meters.filter((m) => m.used).map((m) => {
        const s = m.used / m.max;
        // When SubDL's day resets is said once, at the top of the page, not under every key.
        const note = m.note && !/midnight UTC/.test(m.note) ? m.note : "";
        return `<div class="meter${m.used ? "" : " unused"}"><div class="meter-top"><span>${m.label}</span><span><b>${n(m.used)}</b> <span class="of">/ ${n(m.max)}</span></span></div><div class="tube ${lvl(s)}${m.used ? "" : " zero"}" style="--v:${Math.min(1, s)}" role="meter" aria-label="${esc(SRC[k.service])} ${esc(k.tag)}, ${m.label}" aria-valuemin="0" aria-valuemax="${m.max}" aria-valuenow="${m.used}"><i></i></div>${note ? `<span class="note">${esc(note)}</span>` : ""}</div>`;
      }).join("") + (zero.length ? `<p class="meters-zero" style="grid-column:${k.meters.length - zero.length + 1} / -1">${k.meters.length === zero.length ? "Nothing used yet. " : ""}${zero.map((m) => `${esc(m.label)} 0 of ${n(m.max)}${m.note && !/midnight UTC/.test(m.note) ? ` (${esc(m.note)})` : ""}`).join(" · ")}</p>` : "");
      const refused = k.refused ? `Refused ${n(k.refused)}× this week${k.lastRefusedAt ? `, last at ${hhmm(k.lastRefusedAt)}, ${ago(k.lastRefusedAt)}` : ""}` : "Never refused";
      return `<div class="key"><div class="key-id"><span class="src">${srcImg(k.service)}${SRC[k.service]} <span class="mono">${esc(k.tag)}</span></span><span class="state"><span class="dot${k.refused ? " bad" : ""}"></span>${refused}</span><p>${callsLine(k)}</p></div><div class="meters${k.meters.length === 2 ? " two" : ""}">${meters}</div></div>`;
    };
    const subdlUsed = D.keys.some((k) => k.service === "subdl" && k.weekCalls);
    return `
      <header class="page-head"><h1 id="h-keys">Keys</h1><p>Each SubSource, SubDL and Wyzie Subs key against its free plan's limits. ${info("keys", "the limits", "The limits, and how they're counted")}</p>${subdlUsed ? `<p class="reset-line"><span class="dot"></span>SubDL's day resets at <b>${hhmm(utcMidnight)}</b>, midnight UTC, in ${duration((utcMidnight - NOW) / 1000)}.</p>` : ""}</header>
      ${busy.map(([link, ks]) => `<section class="group" aria-label="${esc(labelOf(link))}"><div class="group-head"><h2>${esc(nameOf(link) ?? "No configuration yet")}</h2><span class="mono">${esc(link)}</span></div>${ks.filter(used).sort((a, b) => (a.service === "subsource" ? 0 : 1) - (b.service === "subsource" ? 0 : 1)).map(keyRow).join("")}</section>`).join("")}
      ${busy.length || idle.length ? "" : `<div class="empty"><div class="bubs-spot">${Bubs.full({ mood: "sleepy", shadow: false })}</div><div><h2>No keys used yet</h2><p>A configuration's keys show here once it has been used, each against its limits.</p></div></div>`}
      ${idle.length ? `<section class="block" aria-labelledby="h-idle"><div class="block-head"><h2 id="h-idle">No calls this week</h2></div><ul class="idle-list">${idle.map(([link, ks]) => `<li><span><b>${esc(nameOf(link) ?? "Unnamed")}</b> <span class="mono">${esc(link)}</span></span><span>${ks.map((k) => `${SRC[k.service]} <span class="mono">${esc(k.tag)}</span>`).join(" · ")}</span></li>`).join("")}</ul></section>` : ""}`;
  }

  // ---------- activity ----------
  // Rows per page: as many as fit between the list's top and the window's bottom, less the pager and room for
  // two day headings (a page can span midnight); at least 10 on a phone, where the page then scrolls, and 5
  // elsewhere. Measured once per window size, and the list keeps that height, so the pager never moves
  // between pages, filters or visits.
  const fit = { size: "", rows: 18, min: 0 };
  function refit() {
    const size = `${innerWidth}x${innerHeight}`;
    const p = $("#p-activity");
    const log = $(".log", p);
    const shown = $$(".log-row", p).slice(0, 8);
    if (fit.size === size || !log || !shown.length) return;
    // Each part's full height, its margins included.
    const outer = (el) => { if (!el) return 0; const cs = getComputedStyle(el); return el.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom); };
    const rowH = Math.max(...shown.map(outer));
    const dayH = outer($(".log-day", p));
    const colsH = outer($(".log-cols", p));
    const pagerH = ($(".pager", p)?.getBoundingClientRect().height ?? 44) + 28;
    const below = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
    const room = innerHeight - (log.getBoundingClientRect().top + scrollY) - pagerH - below - 2 * dayH - colsH;
    fit.size = size;
    fit.rows = Math.max(matchMedia("(max-width: 860px)").matches ? 10 : 5, Math.floor(room / rowH));
    fit.min = Math.ceil(fit.rows * rowH + 2 * dayH + colsH);
    renderPanel("activity");
  }
  let refitting = 0;
  // A picker or keyboard opening on a phone changes the window's height: drawing the panel again then would
  // replace the dropdown or field in use under it (iOS closes its picker with it), so the fit waits until
  // focus leaves it.
  let refitAfter = false;
  const inUse = () => { const el = document.activeElement; return Boolean(el?.matches("select, input, textarea") && $("#p-activity")?.contains(el)); };
  const fitAgain = () => {
    if (inUse()) { refitAfter = true; return; }
    fit.size = "";
    if (state.tab === "activity") renderPanel("activity");
  };
  document.addEventListener("focusout", () => { if (refitAfter) { refitAfter = false; setTimeout(fitAgain, 0); } });
  addEventListener("resize", () => { clearTimeout(refitting); refitting = setTimeout(fitAgain, 150); });
  // Rows measured in a fallback font are a little off: measured again once the page's fonts are in.
  document.fonts?.ready.then(fitAgain);
  // A request with an error: one that failed, or one during which a source failed while the others answered.
  const isError = (a) => (a.result.startsWith("error") && a.at >= cutOf(a.link)) || Boolean(a.failed?.length);
  const KINDS = { all: "requests", list: "lists", download: "downloads", error: "requests with an error" };
  // Searching ignores case and treats dots, dashes and underscores as spaces, as file names use them.
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[._-]+/g, " ");
  function activityRows() {
    const words = norm(state.filter.q).split(/\s+/).filter(Boolean);
    const hit = (a) => { const hay = norm(`${a.what} ${a.detail?.file ?? ""} ${a.result} ${resultWord(a.result)} ${labelOf(a.link)}`); return words.every((w) => hay.includes(w)); };
    const kind = (a) => state.filter.kind === "all" || (state.filter.kind === "error" ? isError(a) : a.kind === state.filter.kind);
    return live().filter((a) => kind(a) && (state.filter.link === "all" || a.link === state.filter.link) && (!words.length || hit(a))).sort((a, b) => b.at - a.at);
  }
  function activity() {
    const PAGE = fit.rows;
    const rows = activityRows();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
    const links = [...new Set(D.activity.map((a) => a.link))];
    let lastDay = "";
    const cols = `<div class="log-cols" aria-hidden="true"><span>Time</span><span>Asked for</span><span>Kind</span><span>Result</span><span>Configuration</span><span>Took</span></div>`;
    const body = slice.map((a, i) => {
      const day = dayLabel(a.at);
      const head = day !== lastDay ? `<h2 class="log-day">${day}${day === "Today" || day === "Yesterday" ? `<span class="sr-only">, </span><span>${dayFmt.format(a.at)}</span>` : ""}</h2>` : "";
      lastDay = day;
      const cue = cueOf(a);
      const kind = a.kind === "list" ? "List" : "Download";
      // A row reads as one sentence to a screen reader, every column named.
      const said = `${hhmm(a.at)}, ${kind.toLowerCase()}: ${a.what}. Result: ${resultWord(a.result)}. ${labelOf(a.link)}. Took ${took(a.ms)}${a.debug ? ". Test play" : ""}`;
      return `${head}${i === 0 ? cols : ""}<button class="log-row" type="button" data-row="${state.page * PAGE + i}" aria-label="${esc(said)}"><span class="t">${hhmm(a.at)}</span><span class="what">${breakable(a.what)}${a.debug ? '<span class="dbg">test</span>' : ""}</span><span class="sub"><span class="kind">${kind}</span><span class="res${cue === "error" ? " bad" : ""}"><i class="cue ${a.kind === "list" ? "list" : cue}"></i>${esc(resultWord(a.result))}</span><span class="who">${esc(labelOf(a.link))}</span></span><span class="ms">${took(a.ms)}</span></button>`;
    }).join("");
    const q = (state.filter.q ?? "").trim();
    // The fitted page's height keeps the pager in place from page to page; a list of one page (a filter
    // such as Errors) takes its rows' own height, or its few rows would be stretched over the page.
    const empty = `<div class="empty"><div class="bubs-spot">${Bubs.full({ mood: "sleepy", shadow: false })}</div><div><h2>Nothing matches</h2><p>No ${KINDS[state.filter.kind]} ${q ? `matching “${esc(q)}” ` : ""}${state.filter.link === "all" ? "" : `from ${esc(labelOf(state.filter.link))} `}in the last 7 days${state.debug ? "" : ", test plays left out"}.</p><p style="margin-top:12px"><button class="btn small" type="button" id="reset-filters">Show everything</button></p></div></div>`;
    return `
      <header class="page-head"><div class="page-title"><h1 id="h-activity">Activity</h1><button class="btn" type="button" id="copy-diag" aria-describedby="diag-what" title="Server status and recent requests. Excludes keys, passwords, tokens and configuration names.">${icon("copy")}Copy diagnostics</button><span class="sr-only" id="diag-what">Copies server status and recent requests. Each request's details have their own Copy diagnostics. Excludes keys, passwords, tokens and configuration names.</span></div><p>Every list and subtitle asked for in the last 7 days. Open a row to see what was picked and how it was timed. ${info("results", "the results", "What the results mean")}</p></header>
      <div class="block">
        <div class="filters">
          <label class="search"><span class="ic" data-icon="search"></span><span class="sr-only">Find</span><input class="field" type="search" id="act-search" aria-label="Find in activity" placeholder="Find a file, episode or result" value="${esc(state.filter.q ?? "")}" autocomplete="off" spellcheck="false" aria-keyshortcuts="/"><kbd aria-hidden="true">/</kbd></label>
          <div class="seg" role="group" aria-label="Kind">${[["all", "All"], ["list", "Lists"], ["download", "Downloads"], ["error", "Errors"]].map(([k, l]) => `<button type="button" data-kind="${k}" aria-pressed="${state.filter.kind === k}">${l}</button>`).join("")}</div>
          <select class="select" id="link-filter" aria-label="Configuration"><option value="all">All configurations</option>${links.map((id) => `<option value="${esc(id)}"${state.filter.link === id ? " selected" : ""}>${esc(labelOf(id))}</option>`).join("")}</select>
          <label class="switch-row"><input class="switch" type="checkbox" role="switch" id="debug-toggle-2"${state.debug ? " checked" : ""}> Include the ${n(D.debugCount)} test plays</label>
          <span class="count">${n(rows.length)} ${rows.length === 1 ? "request" : "requests"}${q ? ` matching “${esc(q)}”` : ""} · last 7 days</span>
        </div>
        <div class="log"${slice.length && fit.min && rows.length > PAGE ? ` style="min-height:${fit.min}px"` : ""}>${slice.length ? body : empty}</div>
        ${rows.length > PAGE ? `<div class="pager"><button class="btn small" type="button" id="newer"${state.page === 0 ? " disabled" : ""}>Newer</button><span>${n(state.page * PAGE + 1)}–${n(Math.min(rows.length, state.page * PAGE + PAGE))} of ${n(rows.length)}</span><button class="btn small" type="button" id="older"${state.page >= pages - 1 ? " disabled" : ""}>Older</button></div>` : ""}
      </div>`;
  }
  function bindActivity() {
    const p = $("#p-activity");
    $$("[data-kind]", p).forEach((b) => b.addEventListener("click", () => { state.filter.kind = b.dataset.kind; state.page = 0; renderPanel("activity"); }));
    $("#link-filter", p)?.addEventListener("change", (e) => { state.filter.link = e.target.value; state.page = 0; renderPanel("activity"); });
    $("#debug-toggle-2", p)?.addEventListener("change", (e) => { state.debug = e.target.checked; state.page = 0; renderPanel("activity"); });
    $("#newer", p)?.addEventListener("click", () => { state.page--; renderPanel("activity"); });
    $("#older", p)?.addEventListener("click", () => { state.page++; renderPanel("activity"); });
    $("#reset-filters", p)?.addEventListener("click", () => { state.filter = { kind: "all", link: "all", q: "" }; state.debug = true; renderPanel("activity"); });
    $("#copy-diag", p)?.addEventListener("click", (e) => copyDiagnostics(e.currentTarget, $(".page-head", p)));
    // Typing filters as you go; the field keeps focus and caret across the redraw. Esc clears it.
    const s = $("#act-search", p);
    let wait = 0;
    const apply = () => {
      state.filter.q = s.value;
      state.page = 0;
      renderPanel("activity");
      const f = $("#act-search");
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    };
    s?.addEventListener("input", () => { clearTimeout(wait); wait = setTimeout(apply, 140); });
    s?.addEventListener("keydown", (e) => { if (e.key === "Escape" && s.value) { e.stopPropagation(); s.value = ""; apply(); } });
    const rows = activityRows();
    $$("[data-row]", p).forEach((b) => b.addEventListener("click", () => openDrawer(rows[Number(b.dataset.row)], b)));
    refit();
  }

  // ---------- drawer ----------
  let drawerReturn = null;
  function openDrawer(a, from) {
    if (!a) return;
    drawerReturn = from;
    const d = a.detail ?? {};
    const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
    let body = `<div class="diag"><button class="btn primary small" type="button" id="copy-diag-req">${icon("copy")}Copy diagnostics</button><p>Request record, log lines, file state and server status. Excludes keys, passwords, tokens and configuration names.</p></div>`;
    body += kv([["When", `${dayLabel(a.at)}, ${hhmm(a.at)}`], ["Configuration", esc(labelOf(a.link))], ["Result", `<span class="state"><span class="dot ${cueOf(a) === "error" ? "bad" : ""}"></span>${esc(resultWord(a.result))}</span>`], ["Took", took(a.ms)], ["Asked by", d.client ? `<span class="mono">${esc(d.client)}</span>` : undefined], ["Asked ahead", d.ahead ? "Yes: the next episode, while the one before it started" : undefined], ["Test play", a.debug ? "Yes, left out of the counts" : undefined]]);
    if (d.tracks?.length) {
      body += `<div class="block"><h3>Tracks sent, best first</h3><ul class="picks">${d.tracks.map((t) => `<li>${srcImg(t.source)}<span><b>${esc(t.lang)}</b> · ${esc(srcLabel(t.source))} <span class="mono">${esc(t.ref)}</span><span class="rel">${breakable(t.release ?? "")}</span></span><span class="chip${t.state === "synced" ? " on" : ""}">${esc(t.state)}</span></li>`).join("")}</ul></div>`;
    }
    if (d.late?.length) body += `<p class="hint">Left out because they answered late: ${d.late.map(esc).join(", ")}.</p>`;
    // Each source the list waited on, in the order they answered: what it gave and how long it took.
    const said = (s) => (s.state === "failed" ? "Failed" : s.state === "late" ? "Too late, left out" : s.state === "partly" ? `${n(s.got ?? 0)} by the deadline, the rest too late` : s.got === undefined ? "Answered" : `${n(s.got)} found`);
    if (d.sources?.length) body += `<div class="block"><h3>Sources asked</h3>${kv(d.sources.map((s) => [esc(s.name), `<span class="${s.state === "in time" ? "" : "bad-text"}">${said(s)}</span> · ${took(s.ms)}`]))}</div>`;
    if (a.failed?.length) body += `<div class="block"><h3>What failed while it was made</h3><ul class="picks">${a.failed.map((x) => `<li>${srcImg(x.where)}<span><b>${esc(WHERE[x.where] ?? srcLabel(x.where))}</b> ${plainError(x.message)}<span class="rel"><code>${esc(x.message)}</code></span></span></li>`).join("")}</ul>${a.result.startsWith("error") ? "" : '<p class="hint">The request still answered with the other sources.</p>'}</div>`;
    if (a.kind === "download") {
      body += `<div class="block"><h3>The subtitle</h3>${kv([["Language", esc(d.lang)], ["Source", d.source ? `<span class="src">${srcImg(d.source)}${esc(srcLabel(d.source))} <span class="mono">${esc(d.ref)}</span></span>` : undefined], ["Release", breakable(d.release)], ["Listed first", d.listed ? `<span class="mono">${esc(d.listed)}</span>, swapped because it couldn't be fetched` : undefined], ["Fallback", esc(d.fallback)], ["Signs & songs", d.signs ? breakable(d.signs) : undefined], ["Style", d.styled === "file" ? "The file's own subtitle style" : undefined], ["Sent", d.sent ? `${esc(d.sent.format.toUpperCase())}, ${bytes(d.sent.bytes)}${d.sent.gzip ? ", gzipped" : ""} · ${d.sent.kept ? "the player may keep it" : "not kept, asked for again next time"}` : undefined]])}</div>`;
      if (d.timing || d.fit !== undefined) {
        body += `<div class="block"><h3>How it was timed</h3>${kv([["Timing", esc(d.timing)], ["Against", d.reference ? (d.reference === "speech" ? "The voice (speech)" : `The file's ${esc(d.reference)} track`) : undefined], ["Windows", d.windows ? `${d.windows} measured` : undefined], ["Shift range", d.spread && d.spread[0] !== d.spread[1] ? `${d.spread[0]} to ${d.spread[1]} ms` : undefined], ["Lines moved", d.moved ? n(d.moved) : undefined], ["Snapped", d.snapped ? n(d.snapped) : undefined]])}${d.fit !== undefined ? `<div class="fit" title="How much of the file's own subtitle lines this subtitle covers once timed. A dub's wording differs from the file's lines, so it rarely reaches 100%."><span>Fit</span><div class="tube" style="--v:${d.fit / 100}" role="meter" aria-label="Fit" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${d.fit}"><i></i></div><b>${d.fit}%</b></div>` : ""}</div>`;
      }
    }
    if (d.file) body += `<div class="block"><h3>The file played</h3>${kv([["Name", `<span class="mono">${breakable(d.file)}</span>`], ["Size", d.size ? bytes(d.size) : undefined], ["Video", d.video ? `<span class="mono">${esc(d.video)}</span>` : undefined]])}</div>`;
    // A file name keeps its own case and breaks at its dots, so it reads as the file it is.
    const parts = a.what.split(" · ");
    const name = parts.pop();
    $("#drawer-title").innerHTML = `<span class="drawer-kind">${a.kind === "list" ? "List" : `Download${parts.length ? ` · ${esc(parts.join(" · "))}` : ""}`}</span><span class="drawer-name">${esc(name).replace(/([._])/g, "$1<wbr>")}</span>`;
    $("#drawer-body").innerHTML = body;
    $("#copy-diag-req").addEventListener("click", (e) => copyDiagnostics(e.currentTarget, $("#drawer-body .diag"), a));
    const dr = $("#drawer");
    dr.hidden = false;
    // The drawer is a modal panel over a scrim: the page behind it is inert, so Tab stays inside it
    // and nothing behind can be tapped by accident. Esc, the close button or the scrim close it.
    $("#scrim").hidden = false;
    $(".shell").inert = true;
    dr.setAttribute("tabindex", "-1");
    $("[data-close]", dr).focus();
  }
  // Tab and Shift+Tab wrap round the drawer's own controls, so focus never leaves the open panel.
  $("#drawer").addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const stops = $$("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])", e.currentTarget).filter((el) => el.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  function closeDrawer() {
    const dr = $("#drawer");
    if (dr.hidden) return;
    dr.hidden = true;
    $("#scrim").hidden = true;
    $(".shell").inert = false;
    drawerReturn?.focus();
  }

  // ---------- configurations ----------
  // A configuration's newest request under the page's test-play rule, so Configs, the 24-hour track and
  // Activity always agree. One used only in test plays says so.
  const lastSeenOf = (c) => { const at = D.activity.filter((a) => a.link === c.id && (state.debug || !a.debug)).map((a) => a.at); return at.length ? Math.max(...at) : 0; };
  function configs() {
    const from = NOW - DAY;
    const list = D.configs;
    const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
    const row = (c) => {
      const paused = Boolean(state.paused[c.id]);
      const cues = live().filter((a) => a.link === c.id && a.at >= from).map((a) => `<span class="cue ${cueOf(a)}" style="left:${xOf(a.at, from).toFixed(2)}%"></span>`).join("");
      const flags = [c.allowMachine ? "Machine translations allowed" : "No machine translations", { include: "Hearing-impaired included", exclude: "No hearing-impaired", only: "Hearing-impaired only" }[c.hearingImpaired], c.skipEmbedded ? "Skips languages the file has" : "Lists every language", c.hideUnsynced ? "Synced only" : null, c.keepAss ? "Keeps subtitle styling" : null, c.dropSounds ? "Sound descriptions removed" : null, c.signs ? "Signs & songs with English Dub" : null, c.ownStyle ? "In the file's own style" : null, c.styles ? `${c.styles} ${c.styles === 1 ? "style" : "styles"}` : null].filter(Boolean);
      const name = nameOf(c.id);
      const seen = lastSeenOf(c);
      const testsOnly = !seen && c.lastSeen > 0;
      // Languages and sources come from the configuration's own settings, which this server learns from its
      // first request; until then there is nothing to show, and nothing to configure or copy.
      const none = c.known ? "None" : "Shows after its first use";
      const seenDay = seen ? dayLabel(seen) : "";
      return `<article class="config" data-id="${esc(c.id)}">
        <div class="config-name">
          <h2>${esc(name ?? "Unnamed")} <span class="status-pill${paused ? " paused" : ""}"><span class="dot${paused ? " bad" : seen > NOW - DAY ? "" : " quiet"}"></span>${paused ? "Paused" : seen > NOW - DAY ? "Active today" : seen ? `Seen ${ago(seen)}` : testsOnly ? "Test plays only" : "Not used yet"}</span></h2>
          <span class="mono">${esc(c.id)}</span>
        </div>
          <div class="uses">
            <div class="uses-row"><span class="lbl">Languages</span><span class="vals">${c.languages.length ? c.languages.map((l) => `<span class="chip">${esc(l)}</span>`).join("") : `<span class="pending">${none}</span>`}</span></div>
            <div class="uses-row"><span class="lbl">Sources</span><span class="vals">${c.sources.length ? `<span class="src-strip" aria-hidden="true">${c.sources.map((s) => `<span title="${esc(srcLabel(s))}">${srcImg(s)}</span>`).join("")}</span><span class="src-names">${esc(andList(c.sources.map(srcLabel)))}</span>` : `<span class="pending">${none}</span>`}</span></div>
            <div class="uses-row"><span class="lbl">Syncs with</span><span class="vals">${c.aiostreams ? `<span class="mono">${esc(c.aiostreams)}</span>` : `<span class="pending">${c.known ? "No AIOStreams: unsynced" : none}</span>`}</span></div>
            <div class="uses-row"><span class="lbl">Set to</span><span class="vals set-to">${esc(flags.map((f, i) => (i ? f[0].toLowerCase() + f.slice(1) : f)).join(", "))}.</span></div>
          </div>
        <div class="config-side">
          <dl class="figs"><div><dt>lists asked for</dt><dd>${n(c.lists)}</dd></div><div><dt>subtitles served</dt><dd>${n(c.served)}</dd></div><div><dt>${seen ? `last seen ${seenDay === "Today" || seenDay === "Yesterday" ? seenDay.toLowerCase() : esc(seenDay)}` : "not seen yet"}</dt><dd>${seen ? hhmm(seen) : "–"}</dd></div></dl>
          <div><div class="mini${paused ? " paused" : ""}" aria-label="Last 24 hours">${cues}</div><div class="mini-cap"><span>24 h ago</span><span>now</span></div></div>
        </div>
        <div class="actions" role="group" aria-label="${esc(name ?? c.id)}">
          ${c.known ? `<a class="btn small" href="/dashboard/links/configure?link=${encodeURIComponent(c.id)}" data-act="configure">${icon("ext")}Configure</a><button class="btn small" type="button" data-act="copy">${icon("copy")}Copy install URL</button>` : ""}
          <button class="btn small" type="button" data-act="rename">${icon("pen")}Rename</button>
          <button class="btn small" type="button" data-act="pause">${icon(paused ? "play" : "pause")}${paused ? "Resume" : "Pause"}</button>
          <button class="btn small danger push" type="button" data-act="delete">${icon("trash")}Delete</button>
        </div>
      </article>`;
    };
    return `
      <header class="page-head"><div class="page-title"><h1 id="h-configs">Configurations</h1><a class="btn primary" href="/configure">${icon("plus")}New configuration</a></div><p>Each install link made on this server, by the name you gave it. Figures and times leave test plays out, as everywhere on this dashboard.</p></header>
      <div>${list.map(row).join("")}</div>`;
  }
  function bindConfigs() {
    const p = $("#p-configs");
    $$(".config", p).forEach((card) => {
      const id = card.dataset.id;
      const nm = labelOf(id);
      const closeForms = () => $$(".inline-form", card).forEach((f) => f.remove());
      // A change to this configuration: the button waits for the server, then the section is drawn from its data.
      const change = async (b, path, body, done) => {
        b.disabled = true;
        b.setAttribute("aria-busy", "true");
        try {
          await post(path, { link: id, ...body });
          await reload();
          toast(done);
          renderPanel("configs");
        } catch (error) {
          b.disabled = false;
          b.removeAttribute("aria-busy");
          toast(error.message);
        }
      };
      card.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-act]");
        if (!b) return;
        const act = b.dataset.act;
        // Its setup page, through the dashboard (/dashboard/links/configure), which knows its install URL.
        if (act === "configure") return;
        e.preventDefault();
        if (act === "pause") {
          const pause = !state.paused[id];
          return change(b, "/dashboard/links/pause", { paused: pause }, pause ? `${nm} is paused: its lists and downloads answer with nothing until you resume it.` : `${nm} is running again.`);
        }
        if (act === "copy") return copyInstallUrl(b, card, id, nm);
        closeForms();
        if (act === "rename") {
          card.insertAdjacentHTML("beforeend", `<form class="inline-form"><label for="rn-${esc(id)}"><b>Rename ${esc(nm)}</b></label><div class="row"><input class="field" id="rn-${esc(id)}" maxlength="40" autocomplete="off" value="${esc(nameOf(id) ?? "")}" placeholder="A name, like Living room TV"><button class="btn primary" type="submit">Save name</button><button class="btn" type="button" data-cancel>Cancel</button></div><p>Up to 40 characters. Empty goes back to its id. Its install URL stays the same.</p></form>`);
          const f = $(".inline-form", card);
          $("input", f).focus();
          f.addEventListener("submit", (ev) => { ev.preventDefault(); const v = $("input", f).value.trim(); change($('button[type="submit"]', f), "/dashboard/links/rename", { name: v }, v ? `Renamed to ${v}.` : "Name removed; it shows by its id."); });
          $("[data-cancel]", f).addEventListener("click", () => { closeForms(); b.focus(); });
        }
        if (act === "delete") {
          card.insertAdjacentHTML("beforeend", `<div class="inline-form" role="group" aria-label="Delete ${esc(nm)}"><p><b>Delete ${esc(nm)}?</b> Its install URL stops working in AIOStreams and players right away and can't be brought back; they would make a new configuration. Its history stays in Activity and Errors.</p><div class="row"><button class="btn danger solid" type="button" data-confirm>Delete ${esc(nm)}</button><button class="btn" type="button" data-cancel>Cancel</button></div></div>`);
          const f = $(".inline-form", card);
          $("[data-cancel]", f).focus();
          $("[data-cancel]", f).addEventListener("click", () => { closeForms(); b.focus(); });
          $("[data-confirm]", f).addEventListener("click", (ev) => change(ev.currentTarget, "/dashboard/links/delete", { confirm: id }, `Deleted ${nm}.`));
        }
      });
    });
  }

  // Its install URL, asked for when the button is pressed (the page never holds it), then copied. Where the
  // browser won't copy, the URL shows in a field, selected, to copy by hand.
  async function copyInstallUrl(b, card, id, nm) {
    b.disabled = true;
    let url;
    try {
      url = (await post("/dashboard/links/install-url", { link: id })).url;
    } catch (error) {
      b.disabled = false;
      return toast(error.message);
    }
    b.disabled = false;
    try {
      await navigator.clipboard.writeText(url);
      toast(`${nm}'s install URL is copied. In AIOStreams, add it as a custom addon.`);
    } catch {
      $$(".inline-form", card).forEach((f) => f.remove());
      card.insertAdjacentHTML("beforeend", `<div class="inline-form" role="group" aria-label="${esc(nm)}'s install URL"><label for="url-${esc(id)}"><b>${esc(nm)}'s install URL</b></label><div class="row"><input class="field mono" id="url-${esc(id)}" readonly value="${esc(url)}"><button class="btn" type="button" data-cancel>Close</button></div><p>The browser didn't allow copying: it's selected, copy it with your keyboard. It holds this configuration's keys, sealed; share it only with its owner.</p></div>`);
      const f = $(".inline-form", card);
      $("[data-cancel]", f).addEventListener("click", () => { f.remove(); b.focus(); });
      $("input", f).focus();
      $("input", f).select();
    }
  }

  // ---------- diagnostics ----------
  // One text for troubleshooting (diagnostics.ts): a request in full (`a`), or the server and its newest
  // requests. It's asked for when the button is pressed and handed to the clipboard as a promise,
  // since Safari lets a page copy only within the tap itself. Where the browser won't copy, the text shows
  // in a box under `where`, selected, to copy by hand.
  async function copyDiagnostics(b, where, a) {
    const url = `/dashboard/diagnostics${a ? `?${new URLSearchParams({ at: String(a.at), link: a.link })}` : ""}`;
    const text = fetch(url, { headers: { Accept: "text/plain" }, cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Signed out: sign in again, then copy." : `The server answered ${r.status}.`);
      return r.text();
    });
    text.catch(() => {});
    b.disabled = true;
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      else await navigator.clipboard.writeText(await text);
      toast(`Diagnostics copied (${n((await text).split("\n").length)} lines).`);
    } catch {
      let body;
      try {
        body = await text;
      } catch (error) {
        return toast(error.message);
      }
      $$(".diag-box", where.parentElement).forEach((x) => x.remove());
      where.insertAdjacentHTML("afterend", `<div class="inline-form diag-box" role="group" aria-label="Diagnostics"><label for="diag-text"><b>Diagnostics</b></label><textarea class="field" id="diag-text" readonly rows="8">${esc(body)}</textarea><div class="row"><button class="btn" type="button" data-cancel>Close</button></div><p>The browser blocked copying. The text is selected; copy it with the keyboard.</p></div>`);
      const box = where.nextElementSibling;
      $("[data-cancel]", box).addEventListener("click", () => { box.remove(); b.focus(); });
      $("textarea", box).focus();
      $("textarea", box).select();
    } finally {
      b.disabled = false;
    }
  }

  // ---------- errors ----------
  // What went wrong, in plain words, from the raw message's kind: a timeout, a site that couldn't be
  // reached, an HTTP status, or a failure of some other kind. The raw message stays under it.
  const statusOf = (m) => Number((m.match(/\b([45]\d\d)\b/) ?? [])[1]) || (/too many requests|rate.?limit/i.test(m) ? 429 : /unauthori[sz]ed|forbidden|invalid api key/i.test(m) ? 401 : 0);
  const plainError = (msg) => {
    const m = String(msg);
    if (/abort|time ?out|timed out/i.test(m)) return "timed out";
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "couldn't be looked up";
    if (/fetch failed|ECONNREFUSED|ECONNRESET|socket|network/i.test(m)) return "couldn't be reached";
    const status = statusOf(m);
    if (status) return `answered with error ${status}`;
    return "failed";
  };
  // Whether the request it happened in still answered: the server's record of that request when it has
  // one, else a request of the same configuration within a minute of the error that didn't end in an error.
  const whatToDo = (e) => {
    const m = String(e.message);
    const status = statusOf(m);
    // Reading the playing file: the download still went out, synced by a fallback or as it came.
    if (/no stream in AIOStreams/i.test(m)) return "AIOStreams' list didn't hold the playing file under the name the player sent, so the file couldn't be read and its subtitles went out as they came. Playing it again often finds it.";
    if (/ADM-ZIP/i.test(m)) return "A subtitle pack from a source couldn't be opened, so that one subtitle wasn't timed. The others are unaffected.";
    if (e.where === "sync" || /ffmpeg|ffprobe/i.test(m)) return "Reading the playing file to time the subtitle failed: the stream may have ended early or moved. The request's row in Activity says what the player got.";
    if (/abort|time ?out|timed out/i.test(m)) return "Nothing to do if it's rare: the site was slow, and the next request asks it again. If it repeats every day, the site may be struggling.";
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "The site's address couldn't be looked up: a DNS problem on this server, or the site's name is gone. If every source shows it, it's this server.";
    if (/fetch failed|ECONNREFUSED|ECONNRESET|socket|network/i.test(m)) return "Usually the site was down for a moment; the next request tries it again. If it lasts, check the site in a browser.";
    if (status === 401 || status === 403) return "Its key was turned away: check the key in this configuration's setup (Configure), or make a new one on the site.";
    if (status === 429) return "Too many calls: it eases off by itself. Keys shows how close each key is to its limits.";
    if (status >= 500) return "A fault on the site's side; the next request tries it again.";
    return "The next request tries it again. If it keeps happening, the raw message below says more.";
  };
  // Where an error happened when it wasn't a source: a part of BttrSubs itself.
  const WHERE = { request: "The request", sync: "Syncing", download: "The download" };
  const stillAnswered = (e) => e.answered ?? D.activity.some((a) => a.link === e.link && Math.abs(a.at - e.at) < 60_000 && !a.result.startsWith("error"));
  // Repeats of one error (a player retrying a link) are one row with a count, the first and last time, and
  // every configuration it happened to; test plays' errors are rows of their own, shown with the switch.
  function errorGroups(list) {
    const groups = new Map();
    for (const e of list) {
      const key = `${e.debug ? "test" : ""}\n${e.where}\n${e.message}`;
      const g = groups.get(key) ?? { where: e.where, message: e.message, debug: Boolean(e.debug), times: 0, first: e.at, last: e.at, links: [], what: "", inLog: false, answered: 0 };
      g.times++;
      g.first = Math.min(g.first, e.at);
      g.last = Math.max(g.last, e.at);
      if (e.link && !g.links.includes(e.link)) g.links.push(e.link);
      if (e.what && !g.what) g.what = e.what;
      if (e.inLog) g.inLog = true;
      if (stillAnswered(e)) g.answered++;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.last - a.last);
  }
  const answeredLine = (g) => g.where === "request" ? "" : g.times === 1 ? (g.answered ? "the request still answered with the other sources" : "the request it was part of failed") : g.answered === g.times ? "each request still answered with the other sources" : g.answered ? `${n(g.answered)} of ${n(g.times)} requests still answered` : "the requests it was part of failed";
  const sinceLabel = (at, last) => (dayLabel(at) === dayLabel(last) ? hhmm(at) : `${dayLabel(at)} ${hhmm(at)}`);
  function errors() {
    const week = D.errors.filter((e) => e.at >= state.clearedAt);
    const links = [...new Set(week.filter((e) => state.debug || !e.debug).map((e) => e.link).filter(Boolean))];
    if (state.errFor !== "all" && !links.includes(state.errFor)) state.errFor = "all";
    const tests = week.filter((e) => e.debug).length;
    const mine = week.filter((e) => (state.debug || !e.debug) && (state.errFor === "all" || e.link === state.errFor));
    const groups = errorGroups(mine);
    const real = mine.filter((e) => !e.debug).length;
    const kinds = groups.filter((g) => !g.debug).length;
    const span = state.clearedAt > NOW - 7 * DAY ? `since you cleared them ${when(state.clearedAt)}` : "in the last 7 days";
    const from = state.errFor === "all" ? "" : ` from ${esc(labelOf(state.errFor))}`;
    // The list keeps the newest few; the week's count can be larger, and says so.
    const more = state.errFor === "all" && D.errorsWeek > real;
    const scope = real ? `${more ? `${n(D.errorsWeek)}${D.errorsMore ? "+" : ""} errors ${span}; the newest ${n(real)} are listed` : `${n(real)} ${real === 1 ? "error" : "errors"}${from} ${span}`}${kinds > 1 ? `, ${n(kinds)} kinds` : ""}` : `No errors${from} ${span}`;
    // Files AIOStreams' list dropped while they played: the ones still timed leave no error, so both are counted here.
    const gone = D.unlisted.lost + D.unlisted.recovered;
    const lost = gone && state.errFor === "all" ? `<p class="err-scope err-lost">${n(gone)} playing ${gone === 1 ? "file was" : "files were"} missing from AIOStreams' list ${span}${D.unlisted.recovered ? `: ${D.unlisted.lost ? n(D.unlisted.recovered) : gone === 1 ? "it was" : "all"} still timed through the link an earlier list gave` : ""}${D.unlisted.lost ? `${D.unlisted.recovered ? `, ${n(D.unlisted.lost)} not found, so ${D.unlisted.lost === 1 ? "its" : "their"}` : `, so ${gone === 1 ? "its" : "their"}`} subtitles carry a notice instead of timing` : ""}.${D.unlisted.lost ? " If this keeps happening for one configuration, the AIOStreams URL saved in it may be older than the one its app uses now: paste the app's own URL into it again." : ""}</p>` : "";
    const row = (g) => `<article class="err${g.debug ? " is-test" : ""}">
          <span class="err-src">${srcImg(g.where)}<i class="err-dot" aria-hidden="true"></i></span>
          <div class="err-body">
            <h2 class="err-title">${esc(WHERE[g.where] ?? srcLabel(g.where))} ${plainError(g.message)}${g.debug ? '<span class="dbg">test</span>' : ""}</h2>
            <p class="err-meta">${g.links.length ? `<span>${g.links.map((id) => esc(labelOf(id))).join(", ")}</span>` : ""}${g.what ? `<span class="err-on">On ${breakable(g.what)}</span>` : ""}${answeredLine(g) ? `<span>${answeredLine(g)}</span>` : ""}</p>
            <p class="err-do">${whatToDo(g)}</p>
            <p class="err-raw"><code>${esc(g.message)}</code>${g.inLog ? `<a class="err-go" href="#activity" data-show-activity="${esc(g.links.length === 1 ? g.links[0] : "all")}">Show in activity${icon("chev", "ic chev")}</a>` : ""}</p>
          </div>
          <div class="when"><b>${hhmm(g.last)}</b><span>${dayLabel(g.last)}, ${ago(g.last)}</span>${g.times > 1 ? `<span class="err-times"><b>×${n(g.times)}</b> since ${sinceLabel(g.first, g.last)}</span>` : ""}</div>
        </article>`;
    const body = groups.length
      ? groups.map(row).join("")
      : `<div class="empty"><div class="bubs-spot">${Bubs.full({ mood: "beam", shadow: false })}</div><div><h2>No errors${from}${state.clearedAt > NOW - 7 * DAY ? ` since ${when(state.clearedAt)}` : ""}</h2><p>Smooth as butter. When a source fails or times out, it shows here with the configuration it happened in.</p>${state.errFor === "all" ? "" : '<p style="margin-top:12px"><button class="btn small" type="button" id="err-all">Show every configuration</button></p>'}</div></div>`;
    return `
      <header class="page-head"><h1 id="h-errors">Errors</h1><p>Sources that failed or timed out in the last 7 days. Repeats are one row with a count. Clearing hides them from every count on this page. Nothing is deleted, and Undo is offered for a few seconds after.</p></header>
      <div class="block">
        <div class="err-tools">${week.length || gone ? `<button class="btn" type="button" id="clear-errors">${icon("hide")}Clear errors</button>` : ""}${links.length > 1 ? `<select class="select" id="err-link" aria-label="Configuration"><option value="all">All configurations</option>${links.map((id) => `<option value="${esc(id)}"${state.errFor === id ? " selected" : ""}>${esc(labelOf(id))}</option>`).join("")}</select>` : ""}${tests ? `<label class="switch-row"><input class="switch" type="checkbox" role="switch" id="err-debug"${state.debug ? " checked" : ""}> Include the ${n(tests)} ${tests === 1 ? "error" : "errors"} from test plays</label>` : ""}${groups.length ? `<span class="err-scope">${scope}</span>` : ""}</div>
        <div>${body}</div>
        ${lost}
      </div>`;
  }
  // Clearing hides the errors from every count; the server keeps them, so the message's Undo brings them back.
  async function clearErrors(e) {
    const b = e?.currentTarget;
    if (b) b.disabled = true;
    try {
      await post("/dashboard/errors/clear");
      await reload();
      renderPanel(state.tab);
      toast("Errors cleared. Bubs feels better.", () => undoClear());
    } catch (error) {
      if (b) b.disabled = false;
      toast(error.message);
    }
  }
  async function undoClear() {
    try {
      await post("/dashboard/errors/clear?undo=1");
      await reload();
      renderPanel(state.tab);
      toast("Clear undone. The errors count again.");
    } catch (error) {
      toast(error.message);
    }
  }
  function bindErrors() {
    $$("[data-show-activity]").forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); state.filter = { kind: "error", link: a.dataset.showActivity, q: "" }; state.page = 0; go("activity", ev); }));
    $("#err-link")?.addEventListener("change", (e) => { state.errFor = e.target.value; renderPanel("errors"); });
    $("#err-debug")?.addEventListener("change", (e) => { state.debug = e.target.checked; renderPanel("errors"); });
    $("#err-all")?.addEventListener("click", () => { state.errFor = "all"; renderPanel("errors"); });
    $("#clear-errors")?.addEventListener("click", clearErrors);
  }
  function syncBadge() {
    const c = D.errorsWeek;
    const b = $("#err-badge");
    b.hidden = !c;
    b.textContent = c > 99 ? "99+" : `${c}${D.errorsMore ? "+" : ""}`;
    b.setAttribute("aria-label", `${c}${D.errorsMore ? " or more" : ""} errors`);
  }

  // ---------- settings ----------
  const SOURCE_TAG = { default: "Default", ".env": "From .env", dashboard: "Set here" };
  // Each setting is checked as you type, with the server's own rules and ranges, so nothing it would
  // refuse (or quietly misread) can be saved.
  const SECONDS = { minutes: 60, hours: 3600, days: 86400 };
  const isOrigin = (t) => { const x = t.toLowerCase().replace(/\/+$/, ""); try { const u = new URL(x); return /^https?:$/.test(u.protocol) && u.origin === x && x.length <= 200; } catch { return false; } };
  const ADDRESS = "isn't an address like https://aiostreams.example.com (no path).";
  // A host as the server takes one: a name or an address (IPv6 in brackets), with or without a port.
  const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)(?::([1-9]\d{0,4}))?$/;
  const isHost = (t) => { const m = HOST.exec(t.toLowerCase()); if (!m || m[1].length > 253 || Number(m[2] ?? 1) > 65535) return false; try { return new URL(`http://${m[1]}`).hostname === m[1]; } catch { return false; } };
  const drafted = (key) => String(state.draft[key] ?? state.settings[key]?.value ?? "").trim();
  // AniDB's client is a name and a version: one without the other is said at the empty one.
  const PAIR = { anidbClient: "anidbClientVer", anidbClientVer: "anidbClient" };
  const pairError = (key) => (PAIR[key] && !drafted(key) && drafted(PAIR[key]) ? (key === "anidbClient" ? "Give the client's name too, or clear its version." : "Give the client's version too, or clear its name.") : "");
  function settingError(key) {
    const s = state.settings[key];
    const v = drafted(key);
    const list = () => v.split(/[\s,]+/).filter(Boolean);
    if (s.kind === "number") {
      if (!v && s.optional) return pairError(key);
      return (s.whole ? /^\d+$/ : /^\d+(\.\d+)?$/).test(v) && Number(v) >= s.min && Number(v) <= s.max ? pairError(key) : s.invalid;
    }
    if (s.kind === "name") return !v || /^[a-z0-9]{1,32}$/.test(v) ? pairError(key) : s.invalid;
    if (s.kind === "hosts") { const bad = list().find((x) => !isHost(x)); return bad ? `“${bad.slice(0, 60)}” isn't a host like proxy.lan or 192.168.1.9:8080.` : list().length > s.max ? `Up to ${s.max} hosts.` : ""; }
    if (s.kind === "key") return !v || /^[A-Za-z0-9_-]{8,128}$/.test(v) ? "" : s.invalid;
    switch (key) {
      case "allowedAiostreams": { const bad = list().find((x) => !isOrigin(x)); return bad ? `“${bad.slice(0, 60)}” ${ADDRESS}` : list().length > s.max ? `Up to ${s.max} addresses.` : ""; }
      case "ownAiostreams": { const bad = list().find((x) => !isOrigin(x)); return bad ? `“${bad.slice(0, 60)}” ${ADDRESS}` : list().length > 1 ? "One address, or none." : ""; }
      case "aiostreamsBase": { try { const u = new URL(v); if (/^https?:$/.test(u.protocol) && !u.search && !u.hash && !u.username && v.length <= 200) return ""; } catch {} return "An http or https address, such as http://aiostreams:3000."; }
      case "timeZone": { try { if (v && v.length <= 64) { new Intl.DateTimeFormat("en-GB", { timeZone: v }); return ""; } } catch {} return "A time zone name, such as Europe/London or UTC."; }
      case "resultCacheTtlSeconds": { const sec = Number(v) * SECONDS[state.draft[`${key}:unit`] ?? s.unit]; return /^\d+$/.test(v) && sec >= 60 && sec <= 30 * 86400 ? "" : "Whole minutes, hours or days, from 1 minute to 30 days."; }
      case "addonPassword": { const on = (state.draft[key] ?? s.value) === "on"; const n = (state.pw ?? "").length; return on && s.value !== "on" && (n < 8 || n > 128) ? "A password of 8 to 128 characters, or the page stays open." : on && n && (n < 8 || n > 128) ? "A new password of 8 to 128 characters, or leave it empty to keep the one set." : ""; }
    }
    return "";
  }
  // What the server refused on a save, said at its field until that field changes: its message without the label in front.
  const serverError = (key) => (state.refused?.key === key ? state.refused.message : "");
  const settingErrors = () => Object.keys(state.settings).map((k) => [k, settingError(k) || serverError(k)]).filter(([, e]) => e);
  // No instance accepted and none of your own: no configuration can sync.
  const noInstance = () => !drafted("allowedAiostreams") && !drafted("ownAiostreams");
  const ZONES = (() => { try { const z = Intl.supportedValuesOf("timeZone"); return z.includes("UTC") ? z : ["UTC", ...z]; } catch { return ["UTC"]; } })();
  // A number with its unit, or the name a 0 has ("no limit").
  const numberShown = (s, value) => (value === "" || value === undefined ? "none" : !Number(value) && s.zero ? s.zero : `${Number(value).toLocaleString("en-US")}${s.unit ? ` ${s.unit}` : ""}`);
  // What Reset goes back to, in the control's own words.
  const resetShown = (s) => {
    const r = s.resetValue;
    if (s.key === "addonPassword") return r === "on" || r === true ? "password on" : "open";
    if (s.kind === "toggle") return r === "on" || r === true ? "on" : "off";
    if (s.kind === "key") return r === "on" ? "the key in .env" : "none";
    if (s.kind === "number") return numberShown(s, r);
    if (s.kind === "duration") return `${r} ${s.resetUnit}`;
    const t = String(r ?? "").trim();
    return t ? t.split(/\s+/).join(", ") : "none";
  };
  // The timeout this addon needs in AIOStreams for a list that may take this long.
  const BUDGET_SLACK = 3000;
  const budgetLine = (v) => (/^\d+$/.test(String(v).trim()) ? `Timeout in AIOStreams: ${(Number(v) + BUDGET_SLACK).toLocaleString("en-US")} ms or more.` : "");
  const hint = (s) => (s.hint ? `<span class="live">${esc(s.hint)}</span>` : "");
  function control(s) {
    const v = state.draft[s.key] ?? s.value;
    const id = `set-${s.key}`;
    if (s.kind === "switch") return `<label class="switch-row"><input class="switch" type="checkbox" role="switch" id="${id}" data-key="${s.key}"${v === "on" ? " checked" : ""}> Ask for a password</label><span class="live">${v === "on" ? "On: friends need the password to make or change a configuration." : "Off: anyone with the setup link can make a configuration."}</span>${v === "on" ? `<input class="field" type="password" data-pw id="set-addonPassword-pw" value="${esc(state.pw ?? "")}" placeholder="${s.value === "on" ? "A new password, or empty to keep it" : "New password, 8 or more characters"}" aria-label="New password" autocomplete="new-password">` : ""}`;
    if (s.kind === "toggle") return `<label class="switch-row"><input class="switch" type="checkbox" role="switch" id="${id}" data-key="${s.key}"${v === "on" ? " checked" : ""}> ${esc(s.switchLabel)}</label><span class="live">${esc(v === "on" ? s.onText : s.offText)}</span>`;
    if (s.kind === "list" || s.kind === "hosts") return `<textarea class="field" id="${id}" data-key="${s.key}" rows="${Math.max(3, String(v).split("\n").length + 1)}" spellcheck="false" autocapitalize="off" autocomplete="off"${s.kind === "hosts" ? ' placeholder="None"' : ""}>${esc(v)}</textarea>${hint(s)}${s.key === "allowedAiostreams" ? `<p class="set-warn" id="inst-none"${noInstance() ? "" : " hidden"}>${icon("alert")}<span>No instance is accepted, so no configuration can sync.</span></p>` : ""}`;
    if (s.kind === "zone") return `<span class="unit-field"><input class="field" id="${id}" data-key="${s.key}" value="${esc(v)}" list="zones" placeholder="Search, like Europe/London" autocomplete="off" spellcheck="false"><span>${icon("globe")}</span></span><datalist id="zones">${ZONES.map((z) => `<option value="${esc(z)}"></option>`).join("")}</datalist><span class="live" id="zone-live">Now ${(() => { try { return new Intl.DateTimeFormat("en-GB", { timeZone: v, hour: "2-digit", minute: "2-digit", hour12: false }).format(NOW); } catch { return "–"; } })()} there</span>`;
    if (s.kind === "duration") {
      const u = state.draft[`${s.key}:unit`] ?? s.unit;
      return `<div class="pair-row"><input class="field" id="${id}" data-key="${s.key}" inputmode="numeric" value="${esc(v)}"><select class="select" data-key="${s.key}:unit" aria-label="${esc(s.label)}, unit">${["minutes", "hours", "days"].map((x) => `<option${x === u ? " selected" : ""}>${x}</option>`).join("")}</select></div><span class="live">From 1 minute to 30 days</span>`;
    }
    if (s.kind === "number") {
      const field = `<input class="field" id="${id}" data-key="${s.key}" inputmode="${s.whole ? "numeric" : "decimal"}" value="${esc(v)}" autocomplete="off"${s.optional ? ' placeholder="None"' : ""}>`;
      const range = s.hint ? hint(s) : `<span class="live">From ${s.min.toLocaleString("en-US")} to ${s.max.toLocaleString("en-US")}</span>`;
      return `${s.unit ? `<span class="unit-field">${field}<span>${esc(s.unit)}</span></span>` : field}${range}${s.key === "listBudgetMs" ? `<span class="live strong" id="budget-live">${budgetLine(v)}</span>` : ""}`;
    }
    // A key is never sent to the page: the field starts empty, and what is typed replaces the one set.
    if (s.kind === "key") return `<input class="field mono" type="password" id="${id}" data-key="${s.key}" value="${esc(state.draft[s.key] ?? "")}" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="${state.settings[s.key].set ? "A key is set. Type a new one to replace it" : "None"}">${hint(s)}`;
    return `<input class="field mono" id="${id}" data-key="${s.key}" value="${esc(v)}" spellcheck="false" autocapitalize="off" autocomplete="off"${s.kind === "name" ? ' placeholder="None"' : ""}>${hint(s)}`;
  }
  // Read-only, beside the setting it belongs to: what was read today against the limit, and AniDB's line.
  function readsState() {
    const r = D.settingsStatus.reads;
    const share = r.limitBytes ? Math.min(1, r.todayBytes / r.limitBytes) : 0;
    const spent = r.limitBytes > 0 && r.todayBytes >= r.limitBytes;
    return `<div class="set-state" role="group" aria-label="Read today"><div class="set-state-top"><span class="set-state-name">Read today</span><span><b>${bytes(r.todayBytes)}</b>${r.limitBytes ? ` of ${bytes(r.limitBytes)}` : ", no limit"}</span></div>${r.limitBytes ? `<div class="tube thin${spent ? " bad" : share >= 0.8 ? " warn" : ""}" style="--v:${share}" aria-hidden="true"><i></i></div>` : ""}<span class="live">${spent ? "The limit is spent: new files are listed unsynced until midnight UTC." : "Counted over everyone. It starts again at midnight UTC."}</span>${r.paused.map((h) => `<span class="state"><span class="dot warn"></span><span>Reads from ${esc(h.host)} are paused for ${duration(h.pausedForMs / 1000)} more: it refused them.</span></span>`).join("")}</div>`;
  }
  function anidbState() {
    const a = D.settingsStatus.anidb;
    const line = !a.configured
      ? `<span class="state"><span class="dot quiet"></span><span>Not set: AniDB is never asked.</span></span>`
      : a.stoppedForMs
        ? `<span class="state"><span class="dot bad"></span><span>Stopped for ${duration(a.stoppedForMs / 1000)} more${a.why ? `: AniDB answered “${esc(a.why)}”` : ""}.</span></span><span class="live">Nothing is asked until then, so a refusal isn't made worse.</span>`
        : `<span class="state"><span class="dot"></span><span>In use: ${n(a.askedToday)} of ${n(a.dailyMax)} requests today.</span></span><div class="tube thin${a.askedToday >= a.dailyMax ? " bad" : ""}" style="--v:${Math.min(1, a.askedToday / a.dailyMax)}" aria-hidden="true"><i></i></div><span class="live">One request every 4 seconds at most, and an anime once in 90 days.</span>`;
    return `<div class="set-state" role="group" aria-label="AniDB now"><div class="set-state-top"><span class="set-state-name">AniDB now</span></div>${line}</div>`;
  }
  const STATE_UNDER = { dailyReadGb: readsState, anidbClient: anidbState };
  // The .env-only settings: what each is for, and which have no working default (unset, they're a warning).
  const ENV_WORDS = {
    CONFIG_SECRET: "Encrypts every configuration into its install URL. Changing it breaks every URL.",
    ADMIN_PASSWORD: "Signs in to this dashboard, and to the configure page.",
    PUBLIC_BASE_URL: "This addon's public address, written into every install URL.",
    CACHE_DIR: "The folder the cache, the stats and these settings are kept in.",
    PORT: "The port the server listens on inside the container."
  };
  const ENV_NEEDED = new Set(["CONFIG_SECRET", "ADMIN_PASSWORD", "PUBLIC_BASE_URL"]);
  const slug = (g) => g.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // A setting's help, with each site it names linked where its words first appear.
  const helpHtml = (s) => (s.links ?? []).reduce((html, [words, url]) => html.replace(esc(words), `<a class="out-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(words)}${icon("ext", "ic ext")}<span class="sr-only"> (opens in a new tab)</span></a>`), esc(s.help));
  function settingRow(s) {
    const cur = state.settings[s.key];
    return `<div class="set"><div class="set-label"><label for="set-${s.key}">${esc(s.label)}<span class="unsaved">Unsaved</span></label><p>${helpHtml(s)}</p><div class="src-line"><span class="tag${cur.source === "dashboard" ? " here" : ""}">${SOURCE_TAG[cur.source]}</span><span class="mono env-name">${esc(s.env)}</span>${s.key === "anidbClient" ? `<button class="reset" type="button" data-open-guide aria-haspopup="dialog">How to get one</button>` : ""}${cur.source === "dashboard" ? `<button class="reset" type="button" data-reset="${s.key}">Reset to ${cur.resetTo === ".env" ? ".env" : "the default"}<span class="reset-to">: ${esc(resetShown(cur))}</span></button>` : ""}</div></div><div class="set-control">${control(cur)}<p class="field-error" id="err-${s.key}" role="alert" hidden></p>${STATE_UNDER[s.key]?.() ?? ""}</div></div>${s.key === "logMaxMb" ? logsRow() : ""}`;
  }
  // Kept in this browser only, never on the server: it changes nothing for anyone else, and needs no Save.
  const motionNote = (on, own) => `${on ? "On: sections change at once; the title card and Bubs keep still." : "Off: the iris, the flicker and Bubs' eyes move."}${own ? "" : " Your device's setting."}`;
  const deviceSection = () => `<section class="set-group" aria-labelledby="g-this-device"><h2 id="g-this-device" tabindex="-1">This device</h2><p class="set-note">Kept in this browser only. It changes at once and nothing is sent to the server.</p>
      <div class="set"><div class="set-label"><label for="dev-motion">Reduce motion</label><p>Stops the iris between sections, the title card's flicker and Bubs' eyes. Until it's switched here, the device's own setting decides.</p></div>
        <div class="set-control"><label class="switch-row"><input class="switch" type="checkbox" role="switch" id="dev-motion" aria-describedby="dev-motion-note"${reduce ? " checked" : ""}> Reduce motion</label><span class="live" id="dev-motion-note">${esc(motionNote(reduce, (() => { try { return localStorage.getItem("bttr-motion"); } catch { return null; } })()))}</span></div></div>
    </section>`;
  function settings() {
    const groups = D.settingGroups.filter((g) => D.settings.some((s) => s.group === g));
    const count = (source) => Object.values(state.settings).filter((s) => s.source === source).length;
    const parts = [[count("dashboard"), "set here"], [count(".env"), "from .env"], [count("default"), "at the default"]].filter(([c]) => c).map(([c, what]) => `${c} ${what}`);
    return `
      <header class="page-head"><h1 id="h-settings">Settings</h1><p>Every server setting that can change while BttrSubs runs. A change is in force as soon as it's saved, with no restart. Each setting says where its value comes from; Reset puts it back to .env or the default.</p></header>
      <nav class="set-index" aria-label="Settings sections">${[...groups, "This device", "Data", "Only in .env"].map((g) => `<button type="button" class="set-jump" data-jump="g-${slug(g)}">${esc(g)}</button>`).join("")}<span class="set-summary">${D.settings.length} settings: ${parts.join(", ")}</span></nav>
      <form class="settings" id="settings-form" novalidate>
        ${groups.map((g) => `<section class="set-group" aria-labelledby="g-${slug(g)}"><h2 id="g-${slug(g)}" tabindex="-1">${esc(g)}</h2>${D.settings.filter((s) => s.group === g).map(settingRow).join("")}</section>`).join("")}
        ${deviceSection()}
        ${dataSection()}
        <section class="set-group" aria-labelledby="g-only-in-env"><h2 id="g-only-in-env" tabindex="-1">Only in .env</h2><p class="set-note">Read once when the container starts, so changing one needs a restart. The page shows whether each is set, never its value.</p><ul class="env-list">${D.envOnly.map((e) => `<li><span class="mono">${e.env}</span><span class="env-what">${esc(ENV_WORDS[e.env] ?? "")}</span><span class="state"><span class="dot${e.set ? "" : ENV_NEEDED.has(e.env) ? " warn" : " quiet"}"></span>${e.set ? "Set" : ENV_NEEDED.has(e.env) ? "Not set" : "Default"}</span></li>`).join("")}</ul></section>
      </form>`;
  }
  function bindSettings() {
    const f = $("#settings-form");
    if (!f) return;
    const current = (k) => (k.endsWith(":unit") ? state.settings[k.split(":")[0]].unit : state.settings[k].value);
    // A new password typed while one is set counts as a change of its own.
    const changed = () => {
      const c = Object.keys(state.draft).filter((k) => String(state.draft[k]) !== String(current(k)));
      return state.pw && !c.includes("addonPassword") ? [...c, "addonPassword"] : c;
    };
    const sync = () => {
      const c = changed();
      // Each row with an unsaved change says so beside its label.
      const errs = Object.fromEntries(settingErrors());
      $$(".set", f).forEach((row) => {
        const keys = $$("[data-key]", row).map((el) => el.dataset.key);
        row.classList.toggle("changed", keys.some((k) => c.includes(k)));
        // A value the server would refuse: an oxblood line under it, said once to screen readers.
        const p = $(".field-error", row);
        if (!p) return;
        const key = p.id.slice(4);
        const msg = errs[key] ?? "";
        if (p.dataset.msg !== msg) { p.dataset.msg = msg; p.hidden = !msg; p.innerHTML = msg ? `${icon("alert")}<span>${esc(msg)}</span>` : ""; }
        const field = $(key === "addonPassword" ? "[data-pw]" : `#set-${key}`, row);
        if (field) { if (msg) field.setAttribute("aria-invalid", "true"); else field.removeAttribute("aria-invalid"); if (msg) field.setAttribute("aria-describedby", p.id); else field.removeAttribute("aria-describedby"); }
      });
      const none = $("#inst-none", f);
      if (none) none.hidden = !noInstance();
      const bar = $("#savebar");
      const save = $("#save");
      if (!c.length) { if (!bar.classList.contains("saved")) bar.hidden = true; return; }
      bar.classList.remove("saved");
      bar.hidden = false;
      $("#discard").hidden = false;
      save.hidden = false;
      const bad = Object.keys(errs).length;
      save.disabled = Boolean(bad);
      bar.classList.toggle("blocked", Boolean(bad));
      $("#savebar-text").textContent = bad ? `${bad} ${bad === 1 ? "change needs" : "changes need"} fixing before saving` : `${c.length} unsaved ${c.length === 1 ? "change" : "changes"}`;
    };
    f.addEventListener("input", (e) => {
      if (e.target.matches("[data-pw]")) { state.pw = e.target.value; if (state.refused?.key === "addonPassword") state.refused = null; sync(); return; }
      const k = e.target.dataset.key;
      if (!k) return;
      if (state.refused?.key === k.split(":")[0]) state.refused = null;
      if (k === "listBudgetMs") $("#budget-live").textContent = budgetLine(e.target.value);
      state.draft[k] = e.target.type === "checkbox" ? (e.target.checked ? "on" : "off") : e.target.value;
      if (k === "timeZone") { const l = $("#zone-live"); try { l.textContent = `Now ${new Intl.DateTimeFormat("en-GB", { timeZone: e.target.value, hour: "2-digit", minute: "2-digit", hour12: false }).format(NOW)} there`; } catch { l.textContent = ""; } }
      if (e.target.type === "checkbox") { renderPanel("settings"); }
      sync();
    });
    $$("[data-reset]", f).forEach((b) => b.addEventListener("click", async () => {
      const key = b.dataset.reset;
      b.disabled = true;
      try {
        const answer = await post("/dashboard/settings", { reset: [key] });
        applySaved(answer);
        // AniDB's client and its version go back together.
        for (const k of [key, PAIR[key]].filter(Boolean)) {
          delete state.draft[k];
          delete state.draft[`${k}:unit`];
          if (state.refused?.key === k) state.refused = null;
        }
        if (key === "addonPassword") state.pw = "";
        const s = state.settings[key];
        toast(`${PAIR[key] ? "AniDB's client and its version are" : `${s.label} is`} back to ${s.source === ".env" ? ".env" : "the default"}.`);
        renderPanel("settings");
        focusIn("settings");
      } catch (error) {
        b.disabled = false;
        toast(error.message);
      }
    }));
    // The sections' index: each button brings its section to the top and moves focus to its heading.
    $$("[data-jump]", $("#p-settings")).forEach((b) => b.addEventListener("click", () => {
      const h = document.getElementById(b.dataset.jump);
      if (!h) return;
      h.closest(".set-group").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      h.focus({ preventScroll: true });
    }));
    $("#dev-motion", f)?.addEventListener("change", (e) => setMotion(e.target.checked));
    $("[data-open-guide]", f)?.addEventListener("click", openGuide);
    bindData();
    sync();
  }
  // The server's answer to a save or reset: the settings as they now are, and a new CSRF token when a
  // new configure-page password signed the session again.
  function applySaved(answer) {
    if (answer.csrf) $('meta[name="csrf"]').content = answer.csrf;
    if (answer.settings) state.settings = Object.fromEntries(answer.settings.map((x) => [x.key, { ...x }]));
    if (answer.settingsStatus) D.settingsStatus = answer.settingsStatus;
  }
  $("#discard").addEventListener("click", () => { state.draft = {}; state.pw = ""; state.refused = null; $("#savebar").hidden = true; renderPanel("settings"); focusIn("settings"); });
  $("#save").addEventListener("click", async () => {
    if (settingErrors().length) { $("[aria-invalid]", $("#settings-form"))?.focus(); return; }
    // Only what changed, each in the server's own units: seconds, GB, a list, a password or off.
    const set = {};
    for (const [k, v] of Object.entries(state.draft)) {
      const key = k.split(":")[0];
      const s = state.settings[key];
      if (key === "resultCacheTtlSeconds") set[key] = String(Number(state.draft[key] ?? s.value) * SECONDS[state.draft[`${key}:unit`] ?? s.unit]);
      else if (key === "addonPassword") set[key] = v === "on" ? { password: state.pw } : { off: true };
      else set[key] = v;
    }
    if (state.pw && state.settings.addonPassword.value === "on" && !("addonPassword" in set)) set.addonPassword = { password: state.pw };
    if (set.addonPassword?.password === "" && state.settings.addonPassword.value === "on") delete set.addonPassword;
    const save = $("#save");
    save.disabled = true;
    let answer;
    try {
      answer = await post("/dashboard/settings", { set });
    } catch (error) {
      save.disabled = false;
      // A value the server refused is said at its field, in the field's own words; anything else in the bar.
      if (error.field && state.settings[error.field]) {
        const said = error.message.replace(/^[^:"“]{1,40}: /, "");
        state.refused = { key: error.field, message: said[0].toUpperCase() + said.slice(1) };
        renderPanel("settings");
        $(error.field === "addonPassword" ? "[data-pw]" : `#set-${error.field}`)?.focus();
      } else $("#savebar-text").textContent = error.message;
      return;
    }
    applySaved(answer);
    state.refused = null;
    state.pw = "";
    state.draft = {};
    const bar = $("#savebar");
    bar.classList.add("saved");
    $("#savebar-text").textContent = "Saved. In force now, no restart needed.";
    $("#discard").hidden = true;
    $("#save").hidden = true;
    renderPanel("settings");
    focusIn("settings");
    setTimeout(() => { bar.hidden = true; bar.classList.remove("saved"); $("#discard").hidden = false; save.hidden = false; save.disabled = false; }, 3500);
  });

  // ---------- what's new and updates ----------
  // Two cards above New configuration (on phones, floating above the dock on Overview): a newer release, when the daily
  // check found one, and this build's own notes. Each can be dismissed, kept in this browser per release;
  // the footer's What's new opens the notes again.
  const notePref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const setNotePref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const notesKey = () => (D.updates.notes ? `${D.version}:${D.updates.notes.heading}:${D.updates.notes.items[0]?.title ?? ""}` : "");
  const notesTitle = () => (D.updates.notes?.heading === "Unreleased" ? `Since ${D.version}` : `In ${D.updates.notes?.heading ?? D.version}`);
  function noteCards(where) {
    const out = [];
    const up = D.updates.newer;
    if (up && notePref("bttr-note-update") !== up.version) {
      out.push(`<div class="side-note update"><div class="side-note-head">${icon("up")}<b>Update available</b><button class="icon-btn dismiss" type="button" data-dismiss-note="update" aria-label="Dismiss the update to ${esc(up.version)}">${icon("close")}</button></div><p>BttrSubs ${esc(up.version)} is out${up.publishedAt ? `, ${ago(up.publishedAt)}` : ""}. You run ${esc(D.version)}.</p><button type="button" class="side-note-link" data-open-notes="update">How to update${icon("chev", "ic chev")}</button></div>`);
    }
    const notes = D.updates.notes;
    if (notes && notePref("bttr-note-new") !== notesKey()) {
      const topics = notes.items.map((x) => x.title).filter(Boolean);
      out.push(`<div class="side-note"><div class="side-note-head">${icon("bell")}<b>What's new</b><button class="icon-btn dismiss" type="button" data-dismiss-note="new" aria-label="Dismiss what's new">${icon("close")}</button></div><p>${esc(notesTitle())}: ${esc(topics.length ? andList(topics.map((t) => (/^[A-Z](?![A-Z])/.test(t) ? t[0].toLowerCase() + t.slice(1) : t))) : notes.items[0].text)}.</p><button type="button" class="side-note-link" data-open-notes="new">Read more${icon("chev", "ic chev")}</button></div>`);
    }
    return out.join("");
  }
  const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  function paintNotes() {
    const side = $("#side-notes");
    side.innerHTML = noteCards("side");
    side.hidden = !side.innerHTML;
    const inline = $(".notes-inline");
    if (inline) inline.innerHTML = noteCards("inline");
    $("#show-notes").hidden = !D.updates.notes && !D.updates.newer;
  }
  function openNotes(which) {
    const up = D.updates.newer;
    const d = $("#notes-help");
    if (which === "update" && up) {
      $("#notes-title").textContent = `BttrSubs ${up.version} is out`;
      $("#notes-body").innerHTML = `<p>You run ${esc(D.version)}. What changed is in its <a href="${esc(up.url)}" target="_blank" rel="noopener">release notes${icon("ext", "ic ext")}<span class="sr-only"> (opens in a new tab)</span></a>.</p><p>To update, in BttrSubs' folder on the server:</p><p><code>docker compose pull &amp;&amp; docker compose up -d</code></p><p>Configurations, stats and these settings are kept: they live in the cache volume. An image updater such as Watchtower does this by itself.</p><p class="notes-foot">Checked once a day. Settings can turn the check off.</p>`;
    } else {
      const notes = D.updates.notes;
      $("#notes-title").textContent = `What's new in BttrSubs`;
      $("#notes-body").innerHTML = notes
        ? `<p class="notes-when">${esc(notesTitle())}</p><ul class="notes-list">${notes.items.map((x) => `<li>${x.title ? `<b>${esc(x.title)}.</b> ` : ""}${esc(x.text)}</li>`).join("")}</ul>`
        : `<p>This build has no notes.</p>`;
    }
    paintIcons(d);
    d.showModal();
  }
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-notes]");
    if (open) return openNotes(open.dataset.openNotes);
    const dismiss = e.target.closest("[data-dismiss-note]");
    if (!dismiss) return;
    if (dismiss.dataset.dismissNote === "update") setNotePref("bttr-note-update", D.updates.newer?.version ?? "");
    else setNotePref("bttr-note-new", notesKey());
    paintNotes();
    toast(dismiss.dataset.dismissNote === "update" ? "Dismissed until the next release." : "Dismissed. What's new is in the footer.");
  });
  $("#show-notes").addEventListener("click", () => openNotes(D.updates.newer && notePref("bttr-note-update") !== D.updates.newer.version ? "update" : "new"));
  $("#notes-help").addEventListener("click", (e) => { if (e.target === e.currentTarget || e.target.closest("[data-close-notes]")) $("#notes-help").close(); });

  // ---------- Settings · Data: clearing, for everything or one configuration ----------
  // Each clear asks once (what it does, for whom), then runs; the message after it offers Undo for a few seconds.
  const WHAT = {
    errors: ["Clear errors", "They stop counting everywhere on this page: the overview, the 24-hour track, the sources, the keys and the badges."],
    activity: ["Clear activity", "The log and the 24-hour track start again from now. The week's totals (synced, CPU, data) stay."],
    both: ["Clear both", "Errors stop counting everywhere, and the log and the 24-hour track start again from now. The week's totals stay."]
  };
  // The server's log files: kept in its cache folder, so an update doesn't lose them; one download for a bug report.
  const logsRow = () => `<div class="set"><div class="set-label"><span class="lbl" id="l-logs">Log files</span><p>What the server printed, one file a day. Addresses keep only their host and long tokens are cut, so the download can go into a bug report.</p></div>
        <div class="set-control">${D.logs ? `<div class="data-actions"><a class="btn" href="/dashboard/logs" download aria-describedby="l-logs">${icon("download")}Download logs</a></div><span class="live">${D.logs.days ? `${n(D.logs.days)} ${D.logs.days === 1 ? "day" : "days"}, ${bytes(D.logs.bytes)}` : "Nothing yet"}; the last ${n(D.logs.keepDays)} ${D.logs.keepDays === 1 ? "day is" : "days are"} kept (LOG_DAYS)</span>` : `<span class="live">Off: no days are kept (LOG_DAYS is 0), so only the container's own log has them.</span>`}</div></div>`;
  function dataSection() {
    const link = state.clearFor;
    const ids = [...new Set([...D.configs.map((c) => c.id), ...D.activity.map((a) => a.link), ...D.errors.map((e) => e.link).filter(Boolean)])];
    const who = link ? labelOf(link) : "everything";
    const confirm = state.confirming && WHAT[state.confirming];
    return `<section class="set-group" aria-labelledby="g-data"><h2 id="g-data" tabindex="-1">Data</h2>
      <div class="set"><div class="set-label"><label class="lbl" for="clear-for">Clear for</label><p>Everything, or one configuration's own errors and activity. Clearing hides them from every count on this page. Nothing is deleted, and Undo is offered for a few seconds after.</p></div>
        <div class="set-control">
          <select class="select" id="clear-for"><option value="">Everything</option>${ids.map((id) => `<option value="${esc(id)}"${id === link ? " selected" : ""}>${esc(labelOf(id))}</option>`).join("")}</select>
          <div class="data-actions">${Object.entries(WHAT).map(([k, [label]]) => `<button class="btn" type="button" data-clear="${k}">${icon("hide")}${label}</button>`).join("")}</div>
          ${confirm ? `<div class="inline-form" role="group" aria-label="${esc(confirm[0])} for ${esc(who)}"><p><b>${esc(confirm[0])} for ${esc(who)}?</b> ${esc(confirm[1])} Nothing is deleted.</p><div class="row"><button class="btn danger solid" type="button" data-confirm-clear>${esc(confirm[0])}</button><button class="btn" type="button" data-cancel-clear>Cancel</button></div></div>` : ""}
        </div></div>
    </section>`;
  }
  // A clear or its undo on the server, for the scope chosen when it ran; the page is drawn again from the data.
  // Clear both is undone as its two halves.
  async function runClear(kind, undo, b, link = state.clearFor) {
    const query = [undo ? "undo=1" : "", link ? `link=${encodeURIComponent(link)}` : ""].filter(Boolean).join("&");
    const paths = kind === "both" ? (undo ? ["/dashboard/errors/clear", "/dashboard/activity/clear"] : ["/dashboard/clear"]) : [`/dashboard/${kind}/clear`];
    if (b) b.disabled = true;
    try {
      for (const path of paths) await post(`${path}${query ? `?${query}` : ""}`);
      await reload();
      state.confirming = null;
      renderPanel(state.tab);
      const who = link ? `${labelOf(link)}'s ` : "";
      toast(undo ? "Clear undone." : `${kind === "both" ? `${who}errors and activity` : `${who}${kind}`} cleared.`, undo ? undefined : () => runClear(kind, true, undefined, link));
    } catch (error) {
      if (b) b.disabled = false;
      toast(error.message);
    }
  }
  function bindData() {
    const p = $("#p-settings");
    $("#clear-for", p)?.addEventListener("change", (e) => { state.clearFor = e.target.value; state.confirming = null; renderPanel("settings"); $("#clear-for")?.focus(); });
    $$("[data-clear]", p).forEach((b) => b.addEventListener("click", () => { state.confirming = b.dataset.clear; renderPanel("settings"); $("[data-cancel-clear]")?.focus(); }));
    $("[data-cancel-clear]", p)?.addEventListener("click", () => { const k = state.confirming; state.confirming = null; renderPanel("settings"); $(`[data-clear="${k}"]`)?.focus(); });
    $("[data-confirm-clear]", p)?.addEventListener("click", (e) => runClear(state.confirming, false, e.currentTarget));
  }

  // ---------- toast ----------
  let toastTimer;
  // A message with Undo stays 6 seconds, and while its Undo has the keyboard's focus.
  function toast(text, undo) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
    t.hidden = false;
    const ms = undo ? 6000 : 3800;
    const close = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); };
    if (undo) {
      const b = $("button", t);
      b.addEventListener("click", () => { t.hidden = true; undo(); focusIn(state.tab, "#clear-errors"); });
      b.addEventListener("focus", () => clearTimeout(toastTimer));
      b.addEventListener("blur", close);
    }
    close();
  }

  // ---------- panels and navigation ----------
  const RENDER = { overview: [overview, bindOverview], keys: [keys, () => {}], activity: [activity, bindActivity], configs: [configs, bindConfigs], errors: [errors, bindErrors], settings: [settings, bindSettings] };
  // After a redraw, focus goes back to the control that was used, or to what took its place (a page button
  // that turned off hands over to the other), or to the section's heading: never to the top of the page.
  const FOCUS_NEXT = { "#newer": "#older", "#older": "#newer" };
  const focusKey = (el, p) => {
    if (!el || !p.contains(el)) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.dataset.kind) return `[data-kind="${el.dataset.kind}"]`;
    const card = el.closest(".config");
    if (card) return `.config[data-id="${card.dataset.id}"] [data-act="${el.dataset.act ?? "rename"}"]`;
    return null;
  };
  function focusIn(tab, ...sels) {
    const p = $(`#p-${tab}`);
    const usable = (s) => { const el = s && $(s, p); return el && !el.disabled && el.offsetParent !== null ? el : null; };
    const target = sels.map(usable).find(Boolean) ?? $(`#h-${tab}`, p) ?? $("h1", p);
    if (!target || (byFinger && target.tagName === "SELECT")) return;
    if (!target.matches("a[href], button, input, select, textarea, [tabindex]")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
  function renderPanel(tab, { keepBubs = false } = {}) {
    const p = $(`#p-${tab}`);
    const had = p.contains(document.activeElement);
    const key = focusKey(document.activeElement, p);
    const host = keepBubs ? $("#bubs-host")?.innerHTML : null;
    const cap = keepBubs ? $("#caption")?.innerHTML : null;
    p.innerHTML = RENDER[tab][0]();
    paintIcons(p);
    RENDER[tab][1]();
    $$("[data-tab]", p).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); go(a.dataset.tab, e); }));
    if (tab === "overview") {
      if (keepBubs && host) { $("#bubs-host").innerHTML = host; $("#caption").innerHTML = cap; $("#bubs").addEventListener("click", () => say(verdict())); }
      else say(verdict());
    }
    if (had) focusIn(tab, key, FOCUS_NEXT[key]);
  }
  // The butter mark glides to the current section: down the sidebar on desktop, across the dock on phones.
  function placeMarker(animate) {
    const nav = $(".tabs");
    const cur = $(`.tab[aria-current="page"]`, nav);
    const m = $(".tab-marker", nav);
    if (!cur) return;
    const vertical = getComputedStyle(nav).flexDirection === "column";
    if (!animate || reduce) nav.classList.add("no-anim");
    m.style.transform = vertical ? `translateY(${cur.offsetTop}px)` : `translateX(${cur.offsetLeft}px)`;
    m.style.width = vertical ? "" : `${cur.offsetWidth}px`;
    m.style.height = vertical ? `${cur.offsetHeight}px` : "";
    if (!animate || reduce) { m.offsetWidth; nav.classList.remove("no-anim"); }
  }
  function swap(tab) {
    $$(".tab").forEach((t) => (t.dataset.tab === tab ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current")));
    $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== tab));
    renderPanel(tab);
  }
  function go(tab, ev) {
    if (!RENDER[tab]) tab = "overview";
    const prev = state.tab;
    state.tab = tab;
    closeDrawer();
    $("#toast").hidden = true;
    // Sections cut with an iris on the content (palace.css); the sidebar stays put and its mark moves at once.
    if (ev && prev !== tab && !reduce && document.startViewTransition) {
      $$(".tab").forEach((t) => (t.dataset.tab === tab ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current")));
      placeMarker(true);
      document.startViewTransition(() => { swap(tab); window.scrollTo(0, 0); });
    } else {
      swap(tab);
      placeMarker(prev !== tab);
      if (ev && prev !== tab) window.scrollTo({ top: 0, behavior: "auto" });
    }
    if (history.replaceState) history.replaceState(null, "", `#${tab}`);
    if (ev && prev !== tab) $("#main").focus({ preventScroll: true });
  }

  // ---------- header, footer, theme ----------
  $("#brand-mark").innerHTML = Bubs.symbol({ title: "" }).replace('role="img" aria-label=""', 'aria-hidden="true"');
  $("#updated").innerHTML = `<span class="upd-word">Updated </span>${hhmm(NOW)}`;
  $("#version").textContent = D.version;
  $("#tz").textContent = tz.replace("_", " ");
  paintIcons();
  $$(".tab, .brand").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); go(a.dataset.tab, e); }));
  $("#refresh").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    const ic = $("svg", b);
    if (!reduce) ic.animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 650, easing: "cubic-bezier(.16,1,.3,1)" });
    b.disabled = true;
    try {
      await reload();
      renderPanel(state.tab, { keepBubs: state.tab !== "overview" });
      toast(`Up to date: ${hhmm(NOW)}.`);
    } catch (error) {
      toast(error.message);
    }
    b.disabled = false;
  });
  const themeBtn = $("#theme");
  const isDark = () => document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const syncTheme = () => {
    const d = isDark();
    themeBtn.setAttribute("aria-pressed", String(d));
    themeBtn.setAttribute("aria-label", d ? "Light theme" : "Dark theme");
    themeBtn.innerHTML = `<span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[d ? "sun" : "moon"]}</svg></span>`;
  };
  themeBtn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("bttr-noir-theme", next); } catch {}
    syncTheme();
  });
  syncTheme();
  // Signing out ends the owner's session and goes to the sign-in page, on a second press so a stray tap does nothing.
  if ($(".signout")) {
    const so = $(".signout"), word = $("span:not(.ic)", so);
    let t = 0;
    const disarm = () => { clearTimeout(t); so.classList.remove("confirm"); word.textContent = "Sign out"; so.setAttribute("aria-label", "Sign out"); };
    so.addEventListener("click", () => {
      if (!so.classList.contains("confirm")) { so.classList.add("confirm"); word.textContent = "Sign out?"; so.setAttribute("aria-label", "Sign out? Press again to sign out"); clearTimeout(t); t = setTimeout(disarm, 4000); return; }
      $("#signout-form").submit();
    });
    so.addEventListener("blur", disarm);
  }
  $("[data-close]").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  const closeInfo = (except) => $$(".info-pop:not([hidden])").forEach((p) => { if (p === except) return; p.hidden = true; $(`[aria-controls="${p.id}"]`)?.setAttribute("aria-expanded", "false"); });
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".info-btn, .info-link");
    if (!b) { if (!e.target.closest(".info-pop")) closeInfo(); return; }
    const pop = document.getElementById(b.getAttribute("aria-controls"));
    const open = pop.hidden;
    closeInfo(pop);
    pop.hidden = !open;
    if (open) $("#toast").hidden = true;
    b.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $(".info-pop:not([hidden])");
    if (open) { const b = $(`[aria-controls="${open.id}"]`); closeInfo(); b?.focus(); return; }
    closeDrawer();
  });
  addEventListener("resize", () => placeMarker(false));
  addEventListener("hashchange", () => { const t = location.hash.slice(1); if (t !== state.tab && RENDER[t]) go(t); });

  // Number keys 1 to 6 open the sections in sidebar order, unless you're typing in a field.
  const ORDER = $$(".tabs .tab").map((t) => t.dataset.tab);
  $$(".tabs .tab").forEach((t, i) => { t.setAttribute("aria-keyshortcuts", String(i + 1)); t.title = `${($(".word-long", t) ?? $(".tab-word", t)).textContent.trim()} (${i + 1})`; });
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.repeat || !keysOn()) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.key === "/") {
      e.preventDefault();
      const focus = () => $("#act-search")?.focus();
      if (state.tab !== "activity") { go("activity", { clientX: 0, clientY: 0 }); setTimeout(focus, 120); } else focus();
      return;
    }
    if (e.key === "?") { e.preventDefault(); toggleKeys(); return; }
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && ORDER[i]) { e.preventDefault(); go(ORDER[i], { clientX: 0, clientY: 0 }); }
  });
  // Preferences, kept in this browser: single-key shortcuts (on unless switched off) and reduced motion
  // (the device's setting until switched here).
  const pref = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  // The same switch is in the shortcuts dialog and in Settings, This device (phones have no shortcuts dialog to open).
  function setMotion(on) {
    setPref("bttr-motion", on ? "reduce" : "full");
    document.documentElement.classList.toggle("calm", on);
    document.documentElement.classList.toggle("moving", !on);
    reduce = calmNow();
    paintPrefs();
  }
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  function keysOn() { return pref("bttr-keys") !== "off"; }
  function paintPrefs() {
    const k = keysOn(), m = reduce, own = pref("bttr-motion");
    $("#pref-keys").checked = k;
    $("#pref-keys-note").textContent = k ? "On: 1–6, / and ? work anywhere outside a field." : "Off: keys only type into fields; this list opens from the footer.";
    for (const [box, note] of [["#pref-motion", "#pref-motion-note"], ["#dev-motion", "#dev-motion-note"]]) {
      if (!$(box)) continue;
      $(box).checked = m;
      $(note).textContent = motionNote(m, own);
    }
    $$(".tabs .tab").forEach((t, i) => { const w = ($(".word-long", t) ?? $(".tab-word", t)).textContent.trim(); if (k) { t.setAttribute("aria-keyshortcuts", String(i + 1)); t.title = `${w} (${i + 1})`; } else { t.removeAttribute("aria-keyshortcuts"); t.title = w; } });
  }
  $("#pref-keys").addEventListener("change", (e) => { setPref("bttr-keys", e.target.checked ? "on" : "off"); paintPrefs(); });
  $("#pref-motion").addEventListener("change", (e) => setMotion(e.target.checked));
  paintPrefs();
  function toggleKeys() {
    const d = $("#keys-help");
    if (d.open) return d.close();
    d.showModal();
  }
  // AniDB's setup guide: focus goes into it, Escape or Close shuts it, and focus comes back to the control that opened it
  // (found again by its data attribute, since a redraw may have replaced it).
  function openGuide() {
    const d = $("#anidb-help");
    d.addEventListener("close", () => $("[data-open-guide]")?.focus(), { once: true });
    d.showModal();
    $("[data-close-guide]", d).focus();
  }
  $("#anidb-help").addEventListener("click", (e) => { if (e.target === e.currentTarget || e.target.closest("[data-close-guide]")) $("#anidb-help").close(); });
  $("#keys-help").addEventListener("click", (e) => { if (e.target === e.currentTarget || e.target.closest("[data-close-keys]")) $("#keys-help").close(); });
  $("#show-keys").addEventListener("click", toggleKeys);

  syncBadge();
  paintNotes();
  const first = location.hash.slice(1);
  go(RENDER[first] ? first : "overview");
  document.fonts?.ready.then(() => placeMarker(false));
})();
