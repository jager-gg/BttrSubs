/*
 * Setup (/configure for a new configuration, /<token>/configure to change one): an intro, six steps (Sync,
 * Sources, Languages, Filters, Style, then Name and create), a review and the install URL. The server checks each
 * step as it's left (<page>/check) and makes or saves the configuration (a POST to the page's own address).
 *
 * Saved keys and the AIOStreams URL never come back to this page (window.BTTR_SETUP says only that they're
 * set): their fields stay empty, and empty keeps them. A reload, or a phone dropping the tab while you copy
 * the URL, brings back the step, the choices, the name and a link already made (sessionStorage, this tab
 * only); typed keys are left out, as browsers leave password fields out.
 */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // The Reduce motion switch (html.calm or html.moving) wins over the device's setting.
  const reduce = document.documentElement.classList.contains("calm") || (!document.documentElement.classList.contains("moving") && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const S = window.BTTR_SETUP;
  // The page's own address saves; the same with /check checks a step.
  const SAVE_URL = location.pathname.replace(/\/+$/, "");
  const CHECK_URL = `${SAVE_URL}/check`;
  const B = window.BubsNoir;

  const ICONS = {
    check: '<path d="M5 12.5 10 17.5 19 7"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
    key: '<circle cx="8" cy="15.5" r="4.5"/><path d="M11.2 12.3 20 3.5M16.5 7l3 3M13.8 9.7l2 2"/>',
    chev: '<path d="M9 5.5 15.5 12 9 18.5"/>',
    back: '<path d="M15 5.5 8.5 12 15 18.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    alert: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    moon: '<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>'
  };
  const icon = (n, cls = "ic") => `<span class="${cls}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[n]}</svg></span>`;

  const editing = S.editing;
  // A phrase that moves to the next line whole, so a line breaks between phrases rather than inside one.
  const phrase = (s) => `<span class="ph">${s}</span>`;
  // Each step's intro is its sentences: each starts a line of its own.
  const STEPS = [
    ["sync", "Sync", "Connect AIOStreams", [`It tells BttrSubs ${phrase("which file you're playing,")} ${phrase("so every subtitle")} ${phrase("can be timed to it.")}`, "Nothing in AIOStreams is changed."]],
    ["sources", "Sources", "Choose your sources", ["Where subtitles are searched.", `Turn on at least one; ${phrase("the best result wins,")} ${phrase("whichever site it's from.")}`]],
    ["languages", "Languages", "Pick your languages", [`Every language you pick ${phrase("gets its best subtitle,")} ${phrase("synced to your file.")}`]],
    ["filters", "Filters", "Set your filters", ["Which subtitles can be picked.", `Official translations always rank first, ${phrase("then people's.")}`]],
    ["style", "Style", "Choose how they look", [`How subtitles look ${phrase("in players that draw styled subtitles (ASS).")}`, "Others show them as plain text."]],
    ["finish", editing ? "Review" : "Create", editing ? "Review and save" : "Name it and create", editing ? ["Change any step, then save.", "Your install URL stays the same."] : [`Check everything once more, ${phrase("give the configuration a name,")} ${phrase("and create it.")}`]]
  ];
  // "English" in the settings is the dub captions; the regular subtitles are S.regularEnglish.
  const LANGS = [["English", "English Dub"], [S.regularEnglish, "English"], ...S.languages.map((l) => [l, S.languageLabels?.[l] ?? l])];
  const shownLang = (l) => (LANGS.find(([v]) => v === l) ?? [l, l])[1];
  const SOURCES = [
    ["opensubtitles", "OpenSubtitles", "The biggest library."],
    ["thesubtitledb", "TheSubtitleDB", "Films and series in many languages."],
    ["gestdown", "Gestdown", "Addic7ed's TV subtitles. Series only."],
    ["animetosho", "Anime Tosho", "English Dub captions from anime releases' own tracks, when the sites have none. Anime only, and only with English Dub picked."],
    ["tsukihime", "TsukiHime", "The subtitle tracks anime releases carry, in every language you pick, and the dub's captions where a release has them. Anime only."],
    ["aninzb", "aninzb", "The same, from recent anime releases on usenet. Anime only."],
    ["subtitlecat", "Subtitle Cat", "Fan translations and other uploads the sites lack. Listed only once synced to your file; works beside at least one other source."]
  ];
  // Filters' switches, the one on by default first; Style's switch has a step of its own.
  const FILTERS = [
    ["skipEmbedded", "Skip languages the file already has", "On: a language the video already has full subtitles in is left out. English Dub always stays, except on a title made in English: there it is regular English, left out like any other when the video has English."],
    ["allowMachine", "Machine and AI translations", "On: they can be picked too. Off leaves them out completely."],
    ["hideUnsynced", "Only subtitles that sync", "On: a subtitle that can't be synced to your file is left out, instead of listed as not synced. When the file itself can't be read, nothing is listed."],
    ["keepAss", "Keep the subtitle's own styling", "Some subtitles carry their own fonts, colours and positions. On: they keep them, once the subtitle has been fetched. Off: they are sent as plain text, unless a style below, Signs & songs or your file's style applies."],
    ["dropSounds", "Remove sound descriptions", "On: [door creaks], (laughs), sung ♪ lines and speaker names like JOHN: are taken out of the text. The timing stays the same."],
    ["signs", "Signs & songs with English Dub", "Anime only, and only with English Dub picked. On: the on-screen text and song lines a fan release typesets are shown with English Dub, timed to your file. They come from Anime Tosho, also when that source is off. Your player needs to show ASS subtitles."],
    ["ownStyle", "Use your file's subtitle style", "On: every subtitle takes the font, size and colours of the subtitles inside your file, when it has styled ones, in place of your style's look below and of the upload's own styling. A font without the letters of a language falls back to your player's own. Off: the plain look, or your style below."]
  ];
  const STYLE = new Set(["keepAss", "dropSounds", "signs", "ownStyle"]);
  const HI = { include: "Hearing-impaired included", exclude: "No hearing-impaired", only: "Hearing-impaired only" };
  const MOODS = { intro: "beam", sync: "grin", sources: "half", languages: "beam", filters: "grin", style: "beam", finish: "half", done: "beam" };

  // ---------- state ----------
  const C = S.current;
  const st = {
    step: editing ? "finish" : "intro",
    // How far Next has got: every step can be opened, but Next walks them in order.
    reached: editing ? STEPS.length - 1 : 0,
    // The AIOStreams account: a saved one's address and UUID are filled in, its password never is.
    aioAddress: S.account?.origin ?? (S.own ? S.instances[0] ?? "" : ""), aioId: S.account?.uuid ?? "", aioPw: "",
    aioAlso: "", subsource: "", subdl: "", wyzie: "",
    remove: { subsource: false, subdl: false, wyzie: false, aioAlso: false, aioPw: false },
    src: Object.fromEntries(SOURCES.map(([k]) => [k, C ? C[k] : k !== "subtitlecat"])),
    addons: "",
    removeAddons: [],
    langs: C ? C.languages.filter((l) => LANGS.some(([v]) => v === l)) : ["English"],
    other: C ? C.languages.filter((l) => !LANGS.some(([v]) => v === l)).join(", ") : "",
    flt: Object.fromEntries(FILTERS.map(([k]) => [k, C ? C[k] : k === "skipEmbedded" || k === "keepAss"])),
    hi: C?.hearingImpaired ?? "include",
    // Subtitles a language lists: the configuration's, never more than this server allows.
    per: C?.perLanguage ?? 1,
    // The styles as they stand, edited in place, and the one being added.
    styles: (C?.styles ?? []).map((r) => ({ ...r })),
    addStyle: { scope: "all", id: "", lang: "", look: "", up: String(S.limits.usualUp), changes: {} },
    // The preview's own picture and line: never saved with the configuration.
    preview: { scene: "dark", text: "" },
    name: C?.label ?? "",
    url: "", inPlace: false, sent: "",
    // Whether the saved configuration can be added to AIOStreams from here, and how that went ("" until tried).
    canAdd: false, added: "", timeoutMs: 0,
    // The AIOStreams account the server last accepted (accountMark); "" stands for the saved one.
    checkedAio: S.saved.aio ? "" : null,
    // The Sync step's last test: what it was asked for (testMark) and what it found (configure.ts, AccountTest).
    test: { mark: "", result: null, busy: false },
    // The AIOMetadata URL's field, opened with Add URL.
    alsoOpen: false,
    flagged: []
  };
  const DRAFT = `bttr-setup:${location.pathname}`;
  // A half-filled Add a style isn't kept: it starts afresh, at the usual height, on every visit. A test is asked again.
  const save = () => {
    const { subsource: _s, subdl: _d, wyzie: _w, aioPw: _p, addStyle: _a, preview: _v, test: _t, ...kept } = st;
    try { sessionStorage.setItem(DRAFT, JSON.stringify(kept)); } catch {}
  };
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT) ?? "null");
    if (d) delete d.addStyle;
    if (d) delete d.watch;
    if (d) delete d.test;
    if (d) Object.assign(st, d, { remove: { ...st.remove, ...d.remove }, src: { ...st.src, ...d.src }, flt: { ...st.flt, ...d.flt } });
  } catch {}

  // ---------- what the form says ----------
  const AIO_URL = /^https?:\/\/[^\s/]+\/stremio\/[^\s/]+\/[^\s/]+\/manifest\.json$/;
  const host = (u) => { try { return new URL(u).host; } catch { return ""; } };
  const ADDRESS = /^https?:\/\/[^\s/]+$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const address = () => st.aioAddress.trim().replace(/\/+$/, "");
  const uuid = () => st.aioId.trim();
  /** Whether the address and UUID in the form are the saved account's. */
  const savedAccount = () => Boolean(S.account) && address().toLowerCase() === S.account.origin.toLowerCase() && uuid().toLowerCase() === S.account.uuid.toLowerCase();
  /** The account as typed, without its password: what the server's answer is remembered for. */
  const accountMark = () => (savedAccount() && !st.aioPw ? "" : `${address()}|${uuid()}|${st.aioPw.length}`);
  /** What is wrong with the account as typed, as [field, message]; with `all`, a missing part counts too. */
  const accountProblem = (all) => {
    if (savedAccount() && !st.aioPw) return undefined;
    if (address() && !ADDRESS.test(address())) return ["aioAddress", "That doesn't look like an address. Use the one you open AIOStreams at, like https://aiostreams.example.com."];
    if (uuid() && !UUID.test(uuid())) return ["aioId", "That doesn't look like a UUID. Copy it again from Save & Install in AIOStreams."];
    if (!all) return undefined;
    if (!address()) return ["aioAddress", "Type the address you open your AIOStreams at."];
    if (!uuid()) return ["aioId", "Paste your UUID. AIOStreams shows it under Save & Install."];
    if (!st.aioPw && !savedAccount()) return ["aioPw", "Type your AIOStreams password to continue."];
    return undefined;
  };
  /** A key that will be in the configuration: typed now, or saved and not being removed. */
  const present = (k) => !st.remove[k] && (st[k].trim() !== "" || S.saved[k]);
  const pastedAddons = () => new Set(st.addons.split(/\s+/).filter(Boolean).map((u) => u.replace(/^stremio:\/\//i, "https://")));
  const addonCount = () => (C?.addons ?? []).filter((_, i) => !st.removeAddons.includes(i)).length + pastedAddons().size;
  const sourceCount = () => SOURCES.filter(([k]) => st.src[k]).length + (present("subsource") ? 1 : 0) + (present("subdl") ? 1 : 0) + (present("wyzie") ? 1 : 0) + addonCount();
  // A name typed under Other languages that has a chip is that chip, by the chip's own wording first:
  // "English" typed there is the regular English, as the chip of that name is, not English Dub.
  const chipFor = (typed) => {
    const t = typed.toLowerCase();
    return (LANGS.find(([, label]) => label.toLowerCase() === t) ?? LANGS.find(([value]) => value.toLowerCase() === t))?.[0];
  };
  const langList = () => [...new Set([...st.langs, ...st.other.split(",").map((s) => s.trim()).filter(Boolean).map((s) => chipFor(s) ?? s)])];
  const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  // Where a style applies, and what the preview draws of a look.
  const WHERE = { all: "All subtitles", anime: "Anime", series: "Series", movie: "Films", show: "One title" };
  const whereOf = (r) => `${r.scope === "show" ? r.name ?? r.id : WHERE[r.scope]}${r.lang ? ` · ${shownLang(r.lang)}` : ""}`;
  // A look as links carry it: a preset's id, or a preset ("plain" for none) and its changes, each a letter
  // and its value joined by "_" ("yellow_o0000ff_w2.4"; srt.ts lookOf). The page keeps preset and changes apart.
  const CHANGES = ["c", "o", "w", "h", "f", "g", "z", "b", "x", "i", "s", "k", "t", "n"];
  // A font typed by name, as a look carries it: a + for each space.
  const FONT_NAME = new RegExp(S.fontName);
  const fontSpec = (typed) => typed.trim().replace(/\s+/g, "+");
  const parseLook = (spec) => {
    const [base, ...parts] = String(spec ?? "").split("_");
    return { base: base === "plain" ? "" : base, changes: Object.fromEntries(parts.map((p) => [p[0], p.slice(1)])) };
  };
  const specOf = (base, changes) => {
    const parts = CHANGES.filter((k) => changes[k] !== undefined).map((k) => k + changes[k]);
    return parts.length ? [base || "plain", ...parts].join("_") : base;
  };
  const presetOf = (base) => S.looks.find((l) => l.id === base) ?? S.plainLook;
  // A preset's own value for each change, as the change writes it: a value it has already is no change.
  const presetValues = (p) => ({ c: p.colour.slice(1).toLowerCase(), o: p.outlineColour.slice(1).toLowerCase(), w: String(p.outline), h: String(p.shadow), f: S.fonts.find((f) => f.name === p.font)?.id, z: "100", b: p.bold ? "1" : "0", x: p.box ? "1" : "0", i: p.italic ? "1" : "0", s: String(p.spacing), k: String(S.changeLimits.boxUsual), t: p.top ? "1" : "0" });
  // The look drawn: its preset with the changes on top.
  const drawnLook = (spec) => {
    const { base, changes: c } = parseLook(spec);
    const p = presetOf(base);
    const l = { ...p };
    if (c.c) l.colour = `#${c.c}`;
    if (c.o) l.outlineColour = `#${c.o}`;
    if (c.w !== undefined) l.outline = Number(c.w);
    if (c.h !== undefined) l.shadow = Number(c.h);
    if (c.f) l.font = S.fonts.find((f) => f.id === c.f)?.name ?? l.font;
    if (c.g) l.font = c.g.replace(/\+/g, " ");
    if (c.z) l.size = Math.round(p.size * Number(c.z)) / 100;
    if (c.b !== undefined) l.bold = c.b === "1";
    if (c.x !== undefined) l.box = c.x === "1";
    if (c.i !== undefined) l.italic = c.i === "1";
    if (c.s !== undefined) l.spacing = Number(c.s);
    l.boxSolid = c.k !== undefined ? Number(c.k) : S.changeLimits.boxUsual;
    if (c.t !== undefined) l.top = c.t === "1";
    return l;
  };
  // Where a look's lines sit unmoved: its preset's own height, else the usual.
  const usualFor = (look) => S.looks.find((l) => l.id === parseLook(look).base)?.up ?? S.limits.usualUp;
  const changeCount = (spec) => Object.keys(parseLook(spec).changes).length;
  const lookName = (spec) => `${parseLook(spec).base ? presetOf(parseLook(spec).base).name : "Plain"}${changeCount(spec) ? ", changed" : ""}`;
  const lookOptions = (chosen, plain = "Look unchanged") =>
    `<option value=""${chosen ? "" : " selected"}>${plain}</option>` +
    (changeCount(chosen) ? `<option value="${esc(chosen)}" selected>${esc(lookName(chosen))}</option>` : "") +
    S.looks.map((l) => `<option value="${l.id}"${l.id === chosen ? " selected" : ""}>${esc(l.name)}</option>`).join("");
  // The preview is a small picture: the line sits `up`% of its height from the bottom, at the size and outline the
  // subtitle script gives it (a script 288 high), so a look and a height read as they will in a player.
  // An outline as wide as the script's: a stroke drawn under the letters, half of it showing.
  const lookCss = (spec, up, zoom = 1) => {
    const l = drawnLook(spec);
    const at = goodPct(up) ? Number(up) : usualFor(spec);
    const cq = (px) => `${(((px * zoom) / 288) * 100).toFixed(2)}cqh`;
    const across = "left:50%;right:auto;translate:-50% 0;text-align:center;";
    const where = zoom > 1 ? "left:50%;right:auto;top:50%;bottom:auto;translate:-50% -50%;" : `${l.top ? `top:${at}%;bottom:auto;` : `bottom:${at}%;top:auto;`}${across}`;
    const rgb = (hex, a) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ")} / ${a})`;
    const text = `${where}font-family:"${l.font}",Arial,sans-serif;color:${l.colour};font-weight:${l.bold ? 700 : 500};font-style:${l.italic ? "italic" : "normal"};letter-spacing:${cq(l.spacing ?? 0)};font-size:${cq(l.size)};`;
    if (l.box) return `${text}background:${rgb(l.outlineColour, (l.boxSolid ?? 50) / 100)};padding:${cq(l.outline)} calc(2 * ${cq(l.outline)});-webkit-text-stroke:0;text-shadow:none`;
    const shadow = l.shadow > 0 ? `${cq(l.shadow)} ${cq(l.shadow)} 0 rgb(0 0 0 / ${l.shadowOpacity})` : "none";
    return `${text}-webkit-text-stroke:${cq(2 * l.outline)} ${l.outlineColour};paint-order:stroke fill;text-shadow:${shadow}`;
  };

  // The style being added: its place has a style already (Add replaces it, so the button says Save).
  const showIdOf = (typed) => (String(typed).match(/tt\d{5,10}/) ?? [""])[0];
  const placeTaken = (a) => st.styles.some((r) => r.scope === a.scope && (r.id ?? "") === (a.scope === "show" ? showIdOf(a.id) : "") && (r.lang ?? "") === (a.lang ?? ""));
  const changedNote = (n) => (n ? `${n} changed` : "");
  // The changes to the chosen look: colours, font, size, outline, shadow, bold and a box, each starting at the look's own.
  const changesPanel = (a) => {
    const d = drawnLook(specOf(a.look, a.changes));
    const L = S.changeLimits;
    const range = (k, label, min, max, step, value, unit = "", off = false) =>
      `<label class="change"><span>${label} <output data-out="${k}">${value}${unit}</output></span><input type="range" data-change="${k}" min="${min}" max="${max}" step="${step}" value="${value}"${off ? " disabled" : ""}></label>`;
    const flag = (k, label, on) => `<label class="switch-row"><input class="switch" type="checkbox" role="switch" data-change="${k}"${on ? " checked" : ""}>${label}</label>`;
    // A choice of a few: one pressed, each a button (a change like the others, by its letter).
    const seg = (k, label, options, chosen) =>
      `<div class="change"><span id="l-seg-${k}">${label}</span><div class="seg small" role="radiogroup" aria-labelledby="l-seg-${k}">${options.map(([v, t]) => `<button type="button" role="radio" data-seg-change="${k}" data-value="${v}" aria-checked="${v === chosen}" aria-pressed="${v === chosen}">${t}</button>`).join("")}</div></div>`;
    const group = (title, body) => `<fieldset class="change-group"><legend>${title}</legend><div class="change-grid">${body}</div></fieldset>`;
    return (
      `<details class="style-changes"${a.open === false ? "" : " open"}><summary>${icon("sliders")}Adjust the look<span class="changes-count" data-changes-count>${changedNote(Object.keys(a.changes).length)}</span><button type="button" class="changes-reset" data-changes-clear${Object.keys(a.changes).length ? "" : ' style="visibility:hidden"'}>Reset</button></summary>` +
      group("Text",
        `<label class="change change-colour"><span>Colour</span><input type="color" class="colour" data-change="c" value="${d.colour.toLowerCase()}"></label>` +
        `<label class="change"><span>Font</span><select class="select" data-change="f">${S.fonts.map((f) => `<option value="${f.id}"${!a.changes.g && !a.otherFont && f.name === d.font ? " selected" : ""}>${esc(f.name)}</option>`).join("")}<option value="other"${a.changes.g || a.otherFont ? " selected" : ""}>Another font…</option></select></label>` +
        `<label class="change"><span>Font name</span><input class="field" data-font-name maxlength="40" placeholder="e.g. Noto Sans" value="${esc((a.changes.g ?? "").replace(/\+/g, " "))}" spellcheck="false" autocomplete="off" aria-describedby="h-font-name"${a.changes.g || a.otherFont ? "" : " disabled"}><span class="change-note" id="h-font-name" data-font-note>For a font your player has. The preview shows it only if this device has it too.</span></label>` +
        range("z", "Size", L.sizeMin, L.sizeMax, 5, a.changes.z ?? "100", `% of this look's (${d.size})`) +
        range("s", "Letter spacing", 0, L.spacingMax, 0.5, d.spacing ?? 0) +
        flag("b", "Bold", d.bold) +
        flag("i", "Italic", d.italic)) +
      group("Edge",
        `<label class="change change-colour"><span data-outline-label>${d.box ? "Box colour" : "Outline colour"}</span><input type="color" class="colour" data-change="o" value="${d.outlineColour.toLowerCase()}"></label>` +
        range("w", "Outline", 0, L.outlineMax, 0.2, d.outline) +
        range("h", "Shadow", 0, L.shadowMax, 0.2, d.shadow) +
        flag("x", "Box behind the text", d.box) +
        range("k", "Box opacity", L.boxMin, L.boxMax, 10, d.boxSolid ?? L.boxUsual, "%", !d.box)) +
      group("Place",
        `<div class="change"><span id="l-style-up">Height from the edge</span>${stepper('id="c-style-up" aria-labelledby="l-style-up"', a.up, "How far from the edge, in percent", String(a.up).trim() !== "" && !goodPct(a.up), { unit: "%" })}</div>` +
        seg("t", "Edge of the picture", [["0", "Bottom"], ["1", "Top"]], d.top ? "1" : "0")) +
      `</details>`
    );
  };

  /** The form as the server reads it (configure.ts, ConfigureInput). */
  const body = () => ({
    subsource: st.remove.subsource ? "remove" : st.subsource.trim(),
    subdl: st.remove.subdl ? "remove" : st.subdl.trim(),
    wyzie: st.remove.wyzie ? "remove" : st.wyzie.trim(),
    ...st.src,
    addAddons: st.addons,
    removeAddons: st.removeAddons,
    aiostreamsAddress: address(),
    aiostreamsId: uuid(),
    aiostreamsPassword: st.remove.aioPw ? "remove" : st.aioPw,
    aiostreamsAlso: st.remove.aioAlso ? "remove" : st.aioAlso.trim(),
    languages: langList(),
    allowMachine: st.flt.allowMachine,
    keepEmbedded: !st.flt.skipEmbedded,
    hideUnsynced: st.flt.hideUnsynced,
    keepAss: st.flt.keepAss,
    dropSounds: st.flt.dropSounds,
    signs: st.flt.signs,
    ownStyle: st.flt.ownStyle,
    styles: st.styles.map((r) => ({ scope: r.scope, ...(r.id ? { id: r.id } : {}), ...(r.lang ? { lang: r.lang } : {}), look: r.look ?? "", up: r.up ?? "" })),
    hearingImpaired: st.hi,
    perLanguage: Number(st.per) || 1,
    label: st.name.trim()
  });

  /** What can be told without asking the server, by step. */
  function problem(id) {
    if (id === "sync" && accountProblem(true)) return accountProblem(true);
    if (id === "sync" && !st.remove.aioAlso && st.aioAlso.trim() && !AIO_URL.test(st.aioAlso.trim())) return ["aioAlso", "That doesn't look like an AIOStreams install URL. It ends in /manifest.json."];
    if (id === "sources" && st.subsource.trim() && st.subsource.trim().length < 10) return ["subsource", "That key looks too short. Copy the whole key from subsource.net/api."];
    if (id === "sources" && !present("subsource") && !present("subdl") && !present("wyzie") && !st.src.opensubtitles && !st.src.thesubtitledb && !st.src.gestdown && !addonCount()) {
      return ["sources", `${st.src.subtitlecat || st.src.animetosho ? "Subtitle Cat and Anime Tosho need another source beside them. " : ""}Add a SubSource, SubDL or Wyzie Subs key, turn on OpenSubtitles, TheSubtitleDB or Gestdown, or add an addon.`];
    }
    if (id === "languages" && !langList().length) return ["langs", "Pick at least one language."];
    if (id === "style") {
      const bad = st.styles.find((r) => r.up !== undefined && r.up !== "" && !goodPct(r.up));
      if (bad) return ["styles", `${whereOf(bad)}: how far up is a whole percent from ${S.limits.raiseMin} to ${S.limits.raiseMax}.`];
    }
    return null;
  }
  const goodPct = (v) => /^\d+$/.test(String(v).trim()) && Number(v) >= S.limits.raiseMin && Number(v) <= S.limits.raiseMax;
  const NEEDS = { sync: "your AIOStreams address, UUID and password", sources: "at least one source", languages: "at least one language", style: "a whole percent for each style's height" };
  const missingStep = () => STEPS.slice(0, -1).map(([id]) => id).find((id) => problem(id));

  // A draft kept from before this setting existed has none: one, as a configuration without it.
  const perOf = () => Math.min(Number(st.per) || 1, S.limits.perLanguageMax);
  const summary = {
    sync: () => (accountProblem(true) ? (S.saved.aio || address() || uuid() ? "Check your AIOStreams sign-in" : "Needs your AIOStreams sign-in") : st.test.result?.signIn === "ok" && st.test.mark === testMark() ? `Connected: ${host(address())}` : accountMark() === "" ? "Connected (saved)" : accountMark() === st.checkedAio ? `Connected: ${host(address())}` : `${host(address())}, checked on Next`),
    sources: () => `${sourceCount()} ${sourceCount() === 1 ? "source" : "sources"}${addonCount() ? ", addons included" : ""}`,
    languages: () => { const l = langList().map(shownLang); return l.length ? andList(l.slice(0, 3)) + (l.length > 3 ? ` +${l.length - 3}` : "") : "None picked"; },
    filters: () => [st.flt.allowMachine ? "Machine translations allowed" : "No machine translations", HI[st.hi], st.flt.hideUnsynced ? "Synced only" : "", st.flt.skipEmbedded ? "" : "The file's languages listed too", perOf() > 1 ? `${perOf()} per language` : ""].filter(Boolean).join(" · "),
    style: () => [st.flt.keepAss ? "Own styling kept" : "Plain text", st.flt.dropSounds ? "No sound descriptions" : "", st.flt.signs ? "Signs & songs" : "", st.flt.ownStyle ? "File's style" : "", st.styles.length ? `${st.styles.length} ${st.styles.length === 1 ? "style" : "styles"}` : ""].filter(Boolean).join(" · "),
    finish: () => (st.url ? (st.inPlace ? "Saved" : "Created") : missingStep() ? `Waits for ${STEPS.find(([id]) => id === missingStep())[1]}` : editing ? "Ready to save" : "Ready to create")
  };
  const stateOf = (id, i) => {
    if (id === "finish") return st.url ? "done" : "";
    if (problem(id) && (i < st.reached || st.flagged.includes(id))) return "todo";
    return i < st.reached && !problem(id) ? "done" : "";
  };

  // ---------- the step index ----------
  const steps = $("#steps"), main = $("#main");
  steps.innerHTML =
    `<span class="tab-marker" aria-hidden="true"></span>` +
    `<button type="button" class="tab step-tab" data-step="intro"><span class="step-num intro-num" aria-hidden="true">${icon("star")}</span><span class="tab-word">Intro</span><span class="step-sub">What it does</span></button>` +
    STEPS.map(([id, label], i) => `<button type="button" class="tab step-tab" data-step="${id}"><span class="step-num" aria-hidden="true"><span class="n">${i + 1}</span>${icon("check", "ic tick")}</span><span class="tab-word">${label}</span><span class="step-sub" data-sub="${id}"></span></button>`).join("");

  // ---------- fields ----------
  // A site named in a help line, linked: it opens in a new tab and says so to screen readers.
  const site = (address) => `<a class="out-link" href="https://${address}" target="_blank" rel="noopener">${address}${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a>`;
  // A logo drawn with no ground of its own sits on black, as its app shows it.
  const ON_BLACK = new Set(["stremio", "aiometadata"]);
  const srcImg = (id) => (`<img class="src-ic${ON_BLACK.has(id) ? " on-black" : ""}" src="/sources/${id}.png?v=2" alt="" width="24" height="24">`);
  const sw = (name, title, help, on, extra = "", lead = "") =>
    `<div class="set cfg-switch"><div class="set-label">${lead}<label class="lbl" for="c-${name}">${title}</label><p>${help}</p>${extra}</div><div class="set-control"><input class="switch" type="checkbox" id="c-${name}" data-flag="${name}"${on ? " checked" : ""} role="switch"></div></div>`;
  // `marks` sit beside the label, outside the <label>, so a button among them is a control of its own.
  const field = (name, label, ph, help, val = "", lead = "", type = "text", extra = "", marks = "") =>
    `<div class="set"><div class="set-label">${lead}${marks ? `<span class="lbl-row"><label class="lbl" for="c-${name}">${label}</label>${marks}</span>` : `<label class="lbl" for="c-${name}">${label}</label>`}<p id="h-${name}">${help}</p></div><div class="set-control"><input class="field${type === "url" ? " mono" : ""}" id="c-${name}" data-field="${name}" type="${type}" placeholder="${esc(ph)}" value="${esc(val)}" spellcheck="false" autocomplete="off" aria-describedby="h-${name}"${extra}><p class="field-error" id="e-${name}" role="alert" hidden></p></div></div>`;
  // A key field: saved keys show as Saved (never the key), and can be dropped with Stop using.
  const RECOMMENDED = `<span class="tag rec">${icon("star")}Recommended</span>`;
  // A warning: a mark that is a button, opening what it warns of.
  const warning = (id, words) =>
    `<span class="info-wrap"><button type="button" class="tag warn" data-warn aria-expanded="false" aria-controls="warn-${id}">${icon("alert")}Warning</button><span class="info-pop warn-pop" id="warn-${id}" role="note" hidden>${words}</span></span>`;
  // `marks` go beside the label, before Saved.
  const keyField = (k, label, ph, help, site, marks = "") => {
    const saved = S.saved[k];
    const removing = st.remove[k];
    const note = removing ? `Will be removed when you ${editing ? "save" : "create"}. <button type="button" class="text-link" data-unremove="${k}">Keep it</button>` : saved ? `Saved. Leave empty to keep it. <button type="button" class="text-link" data-remove="${k}">Stop using ${site}</button>` : help;
    return field(k, label, saved ? "Type a new one to replace it" : ph, note, removing ? "" : st[k], srcImg(k), "password", removing ? " disabled" : "", `${marks}${saved ? `<span class="tag">${removing ? "Removing" : "Saved"}</span>` : ""}`);
  };
  // A whole number: digits typed (a text field, so a wheel or a stray "e" never changes it), or the two buttons, one a
  // press, within data-min and data-max. A height by default; `o` gives another range, unit and button names.
  const stepper = (attrs, value, name, invalid, o = {}) => {
    const { min = S.limits.raiseMin, max = S.limits.raiseMax, unit = "% up", down = "Lower", up = "Higher" } = o;
    return `<span class="stepper${invalid ? " bad" : ""}"><input class="field" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="${String(max).length}" enterkeyhint="done" autocomplete="off" value="${esc(String(value))}" data-min="${min}" data-max="${max}" ${attrs} aria-label="${name}"${invalid ? ' aria-invalid="true"' : ""}><span class="stepper-unit" aria-hidden="true">${unit}</span>` +
      `<button type="button" class="step-btn" data-step-by="-1" aria-label="${down}">${icon("minus")}</button><button type="button" class="step-btn" data-step-by="1" aria-label="${up}">${icon("plus")}</button></span>`;
  };
  // ---------- the Sync step ----------
  // The account is one band of three fields. Each kind of app is a row with what the last test found
  // for it, and the steps to take only where something is missing. Saved values show as Saved or a
  // count (never the value), and can be dropped.
  // A path through another app's menus: each name whole, breaking only after a "›", which stays with the name before it.
  const menuPath = (...names) => names.map((n) => `<b class="nm">${n}</b>`).join('<span class="sep" aria-hidden="true">&nbsp;›</span> ');
  // A finding: its words with a mark (a tick when fine, a ring when worth a look, a cross when wrong), or grey words before there is one.
  const finding = (kind, text) => (kind === "wait" ? `<span class="st st-wait">${text}</span>` : `<span class="st st-${kind}"><span class="st-ic" aria-hidden="true">${kind === "ok" ? icon("check") : kind === "bad" ? icon("close") : ""}</span>${text}</span>`);
  const againBtn = () => `<button type="button" class="btn small" data-test-again>Check again</button>`;
  const accountField = (k, label, type, ph, val, hint, extra = "") =>
    `<div class="acct-f"><label class="lbl" for="c-${k}">${label}</label><input class="field${type === "url" ? " mono" : ""}" id="c-${k}" data-field="${k}" type="${type}" placeholder="${esc(ph)}" value="${esc(val)}" spellcheck="false" autocomplete="off" aria-describedby="h-${k}"${extra}><p class="acct-hint" id="h-${k}">${hint}</p><p class="field-error" id="e-${k}" role="alert" hidden></p></div>`;
  const passwordHint = () =>
    st.remove.aioPw ? `Forgotten when you ${editing ? "save" : "create"}: the AIOStreams app and a linked Stremio are no longer covered, and this page can't add the addon for you. <button type="button" class="text-link" data-unremove="aioPw">Keep it</button>`
      : S.saved.aioPw ? `Saved. <button type="button" class="text-link" data-remove="aioPw">Forget it</button>`
      : S.saved.aio ? "Not saved yet. It covers the AIOStreams app and a linked Stremio." : "";
  // AIOMetadata's URL shows once it is added, saved or typed.
  const alsoOpen = () => st.alsoOpen || S.saved.aioAlso > 0 || st.aioAlso.trim() !== "";
  const alsoMore = () => {
    const saved = S.saved.aioAlso, removing = st.remove.aioAlso, full = saved >= S.limits.otherUrls && !removing;
    const note = removing ? `${saved === 1 ? "The saved one is" : `The ${saved} saved are`} removed when you ${editing ? "save" : "create"}. <button type="button" class="text-link" data-unremove="aioAlso">Keep ${saved === 1 ? "it" : "them"}</button>`
      : saved ? `${saved} saved${full ? ", the most there can be" : ""}. <button type="button" class="text-link" data-remove="aioAlso">Remove ${saved === 1 ? "it" : "them"}</button>` : "";
    return `<p>${phrase("In AIOMetadata:")} ${menuPath("Jellyfin", "Make titles play", "Stream addon for everyone")}</p>` +
      `<input class="field mono" id="c-aioAlso" data-field="aioAlso" type="url" placeholder="${removing || full ? "" : "https://…/stremio/…/…/manifest.json"}" value="${esc(removing || full ? "" : st.aioAlso)}" spellcheck="false" autocomplete="off" aria-label="AIOMetadata's AIOStreams URL" aria-describedby="h-aioAlso"${removing || full ? " disabled" : ""}>` +
      `<p class="acct-hint" id="h-aioAlso">${note}</p><p class="field-error" id="e-aioAlso" role="alert" hidden></p>`;
  };
  const appItem = (key, logo, name, sub, more = "") =>
    `<li class="app"><span class="app-ic">${srcImg(logo)}</span><span class="app-name">${phrase(name)}${sub ? `<small>${sub}</small>` : ""}</span><span class="app-side" data-side="${key}" role="status"></span><div class="app-more" data-more="${key}"${more ? "" : " hidden"}>${more}</div></li>`;

  // What each finding shows: its mark, its words, and for one that needs something, what to do.
  const TEST_URL = `${SAVE_URL}/test`;
  const SIGN_FINDING = {
    ok: ["ok", "Signed in"],
    refused: ["bad", "AIOStreams didn't accept this UUID and password", "Change one of them to try again."],
    unanswered: ["bad", "That AIOStreams didn't answer. Check the address"],
    offline: ["bad", "Couldn't reach BttrSubs. Check your connection"],
    busy: ["bad", "Too many checks in a minute. Wait a moment"]
  };
  const PUSH = `${phrase("In AIOStreams:")} ${menuPath("Save &amp; Install", "Linked accounts")}${phrase(", then <b>Push</b> on Stremio.")}`;
  const APP_FINDING = {
    jellyfin: {
      ready: ["ok", "Ready"],
      off: ["idle", "Off on this AIOStreams", "Its owner has AIOStreams' Jellyfin server turned off."],
      refused: ["bad", "Refused"],
      unanswered: ["idle", "Didn't answer"]
    },
    stremio: {
      linked: ["ok", "Linked"],
      unpushed: ["idle", "Not pushed yet", PUSH],
      failed: ["bad", "Last push failed", PUSH],
      expired: ["bad", "Sign-in expired", `${phrase("In AIOStreams:")} ${menuPath("Save &amp; Install", "Linked accounts")}${phrase(", sign in to Stremio again,")} ${phrase("then <b>Push</b>.")}`],
      unlinked: ["idle", "Not linked", `${phrase("In AIOStreams:")} ${menuPath("Save &amp; Install", "Linked accounts", "Link an account", "Stremio")}${phrase(", then <b>Push</b>.")}`],
      unavailable: ["idle", "Not on this AIOStreams"],
      unanswered: ["idle", "Didn't answer"]
    }
  };
  // A finding that can change in AIOStreams without anything changing here gets Check again.
  const ASK_AGAIN = new Set(["unanswered", "offline", "busy", "unpushed", "failed", "expired", "unlinked"]);
  /** What a test is asked for: the account and AIOMetadata's URL as they stand. */
  const testMark = () => [address().toLowerCase(), uuid().toLowerCase(), st.remove.aioPw ? "\0remove" : st.aioPw, st.remove.aioAlso ? "\0remove" : st.aioAlso.trim()].join("\n");
  const unlabelled = (message) => esc(message.replace(/^[^:]+:\s*/, "").replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1."));

  /**
   * Tests the account as the form has it, once for each version of it: AIOStreams limits failed sign-ins,
   * so a test runs when a field is left or the step opens, never while a field is typed in, and a refused
   * pair isn't asked again until a field changes. Check again asks once more.
   */
  async function runTest(again = false) {
    if (accountProblem(true)) {
      st.test = { mark: "", result: null, busy: false };
      return paintTest();
    }
    const mark = testMark();
    if (!again && st.test.mark === mark) return paintTest();
    st.test = { mark, result: null, busy: true };
    paintTest();
    let result;
    try {
      const response = await fetch(TEST_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body()) });
      result = response.status === 429 ? { signIn: "busy" } : response.ok ? await response.json() : { signIn: "unanswered" };
    } catch {
      result = { signIn: "offline" };
    }
    if (st.test.mark !== mark) return;
    st.test = { mark, result, busy: false };
    paintTest();
    syncIndex();
  }
  /**
   * Shows the last test's findings in the step, leaving the fields as they are. A finding stands only for
   * the account it was asked for: while a field is being changed, the step says when it will sign in.
   */
  function paintTest() {
    const signBox = $("#sign-state", main);
    if (!signBox) return;
    const now = testMark().split("\n"), then = st.test.mark.split("\n");
    const complete = !accountProblem(true);
    const sameAccount = complete && now.slice(0, 3).join("\n") === then.slice(0, 3).join("\n");
    const busy = sameAccount && st.test.busy;
    const r = sameAccount && !busy ? st.test.result : null;
    const signed = r?.signIn === "ok";
    const sign = busy ? ["wait", "Signing in…"]
      : !complete || r?.signIn === "incomplete" ? ["wait", savedAccount() && !S.saved.aioPw && !st.aioPw ? "Type your password to sign in" : "Signs in once all three are filled"]
      : !r ? ["wait", "Signs in when you leave the field"]
      : typeof r.signIn === "object" ? ["bad", unlabelled(r.signIn.error)]
      : SIGN_FINDING[r.signIn] ?? SIGN_FINDING.unanswered;
    signBox.innerHTML = finding(sign[0], sign[1]) + (sign[2] ? `<span class="st-note">${sign[2]}</span>` : "") + (!busy && ASK_AGAIN.has(r?.signIn) ? againBtn() : "");
    for (const key of ["jellyfin", "stremio"]) {
      const side = $(`[data-side="${key}"]`, main), more = $(`[data-more="${key}"]`, main);
      const found = signed ? APP_FINDING[key][r[key]] ?? APP_FINDING[key].unanswered : null;
      side.innerHTML = found ? finding(found[0], found[1]) + (ASK_AGAIN.has(r[key]) ? againBtn() : "") : finding("wait", busy ? "Checking…" : "After sign-in");
      more.innerHTML = found?.[2] ? `<p>${found[2]}</p>` : "";
      more.hidden = !found?.[2];
    }
    const alsoSide = $('[data-side="also"]', main);
    const alsoFound = signed && now[3] === then[3];
    const alsoWrong = alsoFound && typeof r.also === "object";
    alsoSide.innerHTML = !alsoOpen() ? `<button type="button" class="btn small" data-also-open>${icon("plus")}Add URL</button>` : alsoFound && r.also === "matches" ? finding("ok", "Matches") : alsoWrong ? finding("bad", "Not usable") : "";
    const alsoError = $("#e-aioAlso", main), alsoField = $("#c-aioAlso", main);
    if (alsoError) {
      alsoError.hidden = !alsoWrong;
      alsoError.innerHTML = alsoWrong ? `${icon("alert")}<span>${unlabelled(r.also.error)}</span>` : "";
      if (alsoWrong) alsoField?.setAttribute("aria-invalid", "true");
      else alsoField?.removeAttribute("aria-invalid");
    }
  }
  const group = (title, note) => `<h2 class="cfg-group">${title}</h2><p class="cfg-group-note">${note}</p>`;
  const chipInner = (on, l) => icon(on ? "check" : "plus") + esc(l);

  const panels = {
    sync: () =>
      group("Your AIOStreams", `The password stays encrypted in your install URL ${phrase("and goes only to your AIOStreams.")}`) +
      `<div class="acct">` +
      accountField("aioAddress", "Address", "url", "https://aiostreams.example.com", st.aioAddress, S.instanceGone && !st.aioAddress ? "The AIOStreams instance this configuration used is no longer accepted by this server. Enter one it accepts; until then nothing is listed." : "No path after it") +
      accountField("aioId", "UUID", "url", "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", st.aioId, menuPath("Save &amp; Install", "Your UUID")) +
      accountField("aioPw", "Password", "password", S.saved.aioPw ? "Type a new one to replace it" : "Your AIOStreams password", st.remove.aioPw ? "" : st.aioPw, passwordHint(), st.remove.aioPw ? " disabled" : "") +
      `</div><p class="acct-state" id="sign-state" role="status"></p>` +
      group("Your apps", "") +
      `<ul class="apps">` +
      appItem("jellyfin", "aiostreams", "AIOStreams app", "and Jellyfin apps on AIOStreams") +
      appItem("stremio", "stremio", "Stremio", "and apps that use its addons") +
      appItem("also", "aiometadata", "Jellyfin via AIOMetadata", "", alsoOpen() ? alsoMore() : "") +
      `</ul>` +
      `<p class="cfg-aside"><button type="button" class="text-link" data-dialog>${icon("globe")}Which AIOStreams instances work?</button></p>`,
    sources: () =>
      group("Subtitle sites", "No key needed.") +
      SOURCES.map(([k, n, h]) => sw(`src-${k}`, n, h, st.src[k], k === "opensubtitles" && !S.openSubtitlesKey ? warning("opensubtitles", "On this server OpenSubtitles marks AI translations but not machine ones. Some can be picked even with <b>Machine and AI translations</b> off.") : "", srcImg(k))).join("") +
      `<p class="field-error" id="e-sources" role="alert" hidden></p>` +
      group("Sites that need a free key", "Your keys stay encrypted inside your install URL.") +
      keyField("subsource", "SubSource API key", "sk_…", `A free key is at ${site("subsource.net/api")}.`, "SubSource", RECOMMENDED) +
      keyField("subdl", "SubDL API key", "Your SubDL key", `Often has dub caption packs. A free key is at ${site("subdl.com/panel/api")}.`, "SubDL", RECOMMENDED) +
      keyField("wyzie", "Wyzie Subs key", "Your Wyzie key", `Asks several subtitle sites at once. A free key, 1,000 requests a day, is at ${site("sub.wyzie.io/redeem")}.`, "Wyzie Subs", warning("wyzie", "Wyzie Subs doesn't say which of its subtitles are machine translations. Some can be picked even with <b>Machine and AI translations</b> off.")) +
      group("Other subtitle addons", "Optional. Any Stremio subtitle addon is asked too, and what it finds is ranked and synced.") +
      ((C?.addons ?? []).length ? `<ul class="raised">${C.addons.map((a, i) => { const off = st.removeAddons.includes(i); return `<li${off ? ' class="removing"' : ""}><b>${esc(a.name)}</b><span class="mono">${esc(a.host)}</span><button type="button" class="text-link" data-unaddon="${i}" aria-label="${off ? "Keep" : "Remove"} ${esc(a.name)}">${icon(off ? "undo" : "trash")}${off ? "Keep" : "Remove"}</button></li>`; }).join("")}</ul>` : "") +
      `<div class="set"><div class="set-label"><label class="lbl" for="c-addons">${(C?.addons ?? []).length ? "Add more addons" : "Other addons' install URLs"}</label><p id="h-addons">Up to ${S.limits.addons} in all, one per line: each addon's install link, ending in manifest.json. Not AIOStreams itself, since it asks BttrSubs.</p></div><div class="set-control"><textarea class="field mono" id="c-addons" data-field="addons" rows="2" placeholder="https://…/manifest.json" spellcheck="false" aria-describedby="h-addons">${esc(st.addons)}</textarea><p class="field-error" id="e-addons" role="alert" hidden></p></div></div>`,
    languages: () =>
      `<div class="cfg-chips" role="group" aria-label="Subtitle languages">${LANGS.map(([v, l]) => `<button type="button" class="chip chip-toggle${st.langs.includes(v) ? " on" : ""}" data-lang="${esc(v)}" aria-pressed="${st.langs.includes(v)}">${chipInner(st.langs.includes(v), l)}</button>`).join("")}</div>` +
      `<details class="cfg-info"><summary>${icon("info")}English Dub or English?</summary><p><b>English Dub</b> is for watching the English dub: captions written from it, so they match the English voices. <b>English</b> is for watching in the original language: regular subtitles. Shows made in English get regular English subtitles with either.</p></details>` +
      `<p class="field-error" id="e-langs" role="alert" hidden></p>` +
      field("other", "Other languages", "Comma-separated, e.g. Greek, Thai", "Any language not in the list above.", st.other),
    filters: () => {
      const flagRows = FILTERS.filter(([k]) => !STYLE.has(k)).map(([k, t, h]) => sw(k, t, h, st.flt[k])).join("");
      const hiRow = `<div class="set"><div class="set-label"><span class="lbl" id="hi-l">Hearing-impaired subtitles</span><p>For the other languages: include them, leave them out, or use only them. Dub captions always describe sounds; Style can take those out. With Only and Remove sound descriptions both on, those subtitles are picked and their descriptions taken out.</p></div><div class="set-control"><div class="seg" role="radiogroup" aria-labelledby="hi-l">${["include", "exclude", "only"].map((v) => `<button type="button" role="radio" data-hi="${v}" aria-checked="${st.hi === v}" aria-pressed="${st.hi === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div></div></div>`;
      // Subtitles per language: one setting for every language, English Dub included, within what this server allows.
      const max = S.limits.perLanguageMax;
      const perRow = `<div class="set"><div class="set-label"><label class="lbl" for="c-per">Subtitles per language</label><p id="h-per">Each language lists its best subtitle; the others still stand behind it and take its place when it can't be synced. More give you a choice when the first is poor, at a download and a timing pass each on every play.</p></div><div class="set-control">${
        max > 1
          ? stepper('id="c-per" aria-describedby="h-per"', perOf(), "Subtitles per language", false, { min: 1, max, unit: perOf() === 1 ? "subtitle" : "subtitles", down: "Fewer", up: "More" })
          : `<p class="per-fixed"><b>1</b> subtitle<span>Set by this server's owner.</span></p>`
      }${(Number(st.per) || 1) > max ? `<p class="per-note">You asked for ${Number(st.per)}; this server lists ${max} at most. Your ${Number(st.per)} is kept for when it lists more.</p>` : ""}</div></div>`;
      return flagRows + hiRow + perRow;
    },
    style: () => {
      const flagRows = FILTERS.filter(([k]) => STYLE.has(k)).map(([k, t, h]) => sw(k, t, h, st.flt[k])).join("");
      const a = st.addStyle;
      const rows = st.styles.map((r, i) => `<li class="style-row"><span class="style-where"><b>${esc(whereOf(r))}</b>${r.scope === "show" ? `<span class="mono">${esc(r.id)}</span>` : ""}</span><select class="select" data-style-look="${i}" aria-label="${esc(whereOf(r))}: look">${lookOptions(r.look)}</select>${stepper(`data-style-up="${i}"`, r.up ?? usualFor(r.look), `${esc(whereOf(r))}: how far up, in percent`, r.up !== undefined && r.up !== "" && !goodPct(r.up))}<button type="button" class="icon-btn" data-style-edit="${i}" aria-label="Change the style for ${esc(whereOf(r))}" title="Change">${icon("sliders")}</button><button type="button" class="icon-btn" data-style-remove="${i}" aria-label="Remove the style for ${esc(whereOf(r))}">${icon("trash")}</button></li>`).join("");
      return flagRows +
        `<h2 class="cfg-group">Styles</h2><p class="cfg-group-note">A look, a height, or both, for all subtitles or just anime, series, films or one title, in every language or one. A style for the track's language comes first, then the most specific place.</p>` +
        (rows ? `<ul class="style-list">${rows}</ul>` : "") +
        `<div class="set style-add"><div class="set-label"><label class="lbl" for="c-style-where">Add a style</label><p id="h-style-where">Subtitles usually sit ${S.limits.usualUp}% up; ${S.limits.raiseDefault}% clears most text on the picture's bottom.</p></div><div class="set-control style-editor">` +
        `<div class="style-pick"><select class="select" id="c-style-where" aria-describedby="h-style-where">${Object.entries(WHERE).map(([k, l]) => `<option value="${k}"${k === a.scope ? " selected" : ""}>${l}</option>`).join("")}</select><input class="field mono" id="c-style-show" placeholder="IMDb link or tt…" value="${esc(a.id)}" spellcheck="false" autocomplete="off" aria-label="The title's IMDb link or id"${a.scope === "show" ? "" : " hidden"}><select class="select" id="c-style-lang" aria-label="Language"><option value="">Every language</option>${[...new Set([...langList(), ...(a.lang ? [a.lang] : [])])].map((l) => `<option value="${esc(l)}"${l === a.lang ? " selected" : ""}>${esc(shownLang(l))} only</option>`).join("")}</select></div>` +
        `<div class="editor-stage"><div class="look-preview" data-scene="${st.preview.scene}" aria-hidden="true"><span data-look-preview style="${esc(lookCss(specOf(a.look, a.changes), a.up))}">${esc(st.preview.text || "Subtitles look like this.")}</span></div>` +
        `<div class="preview-tools"><div class="seg small" role="radiogroup" aria-label="The picture behind the preview">${[["dark", "Dark scene"], ["bright", "Bright scene"]].map(([v, t]) => `<button type="button" role="radio" data-scene-pick="${v}" aria-checked="${v === st.preview.scene}" aria-pressed="${v === st.preview.scene}">${t}</button>`).join("")}</div><input class="field" data-preview-text maxlength="60" placeholder="Type a line to preview" value="${esc(st.preview.text)}" aria-label="A line of your own for the preview" autocomplete="off"></div>` +
        `<div class="look-cards" role="radiogroup" aria-label="Look">${[{ id: "", name: Object.keys(a.changes).length ? "Plain" : "Keep as it is" }, ...S.looks].map((l) => `<button type="button" class="look-card" role="radio" data-look-card="${l.id}" aria-checked="${l.id === a.look}" aria-pressed="${l.id === a.look}"><span class="look-card-pic" aria-hidden="true"><span style="${esc(lookCss(l.id, undefined, 5))}">Abc</span></span><span class="look-card-name">${esc(l.name)}</span></button>`).join("")}</div></div>` +
        changesPanel(a) +
        `<button type="button" class="btn primary style-add-btn" data-style-add>${icon("plus")}${placeTaken(a) ? "Save this style" : "Add this style"}</button><p class="field-error" id="e-styles" role="alert" hidden></p></div></div>`;
    },
    finish: () => {
      const missing = missingStep();
      return (
        field("name", "Configuration name", "e.g. Sara, Living room TV", "Optional. Shown on the dashboard instead of the configuration's id.", st.name, "", "text", ' maxlength="40"') +
        `<h2 class="cfg-group">Review</h2><div class="review">${STEPS.slice(0, 5).map(([id, label]) => `<div class="review-row"><span class="review-label">${label}</span><span class="review-value${problem(id) ? " missing" : ""}">${esc(summary[id]())}</span><button type="button" class="text-link" data-goto="${id}">Change<span class="sr-only"> ${label.toLowerCase()}</span></button></div>`).join("")}</div>` +
        `<div class="create">${missing ? `<p class="blocked">${icon("alert")}<span>${editing ? "Saving" : "Create"} needs ${NEEDS[missing]} first.</span> <button type="button" class="text-link" data-goto="${missing}">Go to ${STEPS.find(([id]) => id === missing)[1]}</button></p>` : ""}<button type="button" class="btn primary big" id="create"${missing ? ' aria-disabled="true"' : ""}><span class="spin" aria-hidden="true"></span><span>${editing ? "Save configuration" : "Create configuration"}</span></button><p class="field-error" id="e-create" role="alert" hidden></p></div>`
      );
    }
  };

  // ---------- the pages around the steps: the intro, a step's heading, the finished card ----------
  const live = (mood, cls = "") => `<div class="noir-live ${cls}">${B.full({ mood, blink: true, shadow: cls !== "peek" })}</div>`;
  const intro = () => {
    const spots = [[3, 18], [26, 23], [56, 14], [76, 20]];
    const lane = (cls) => spots.map(([l, w]) => `<i class="${cls}" style="left:${l}%;width:${w}%"></i>`).join("");
    const subs = spots.map(([l, w], i) => `<i class="sub" style="left:${l}%;width:${w}%;--off:${[-6, 5, 3, -4][i]}%"></i>`).join("");
    return `
      <div class="stage">
        <div id="bubs-host"><button type="button" class="bubs-poke noir-live" id="poke" aria-label="Bubs, your usher. Press him twice and he shows you where to start.">${B.full({ mood: "beam", blink: true, id: "poke" })}</button></div>
        <div class="intertitle">
          <h1 class="caption cfg-title">Smooth, buttery subtitles.</h1>
          <p class="it-sub">Synced better.</p>
          <p class="synced-line">Subtitles that match the dub, timed to your video. Pick an episode: BttrSubs finds the best subtitles, lines them up with your exact file, and hands them to your player.</p>
          <div class="it-go"><button type="button" class="btn primary big" data-start>${editing ? "Back to my settings" : "Set up my configuration"}${icon("chev")}</button><span>${editing ? "Your settings are as you left them." : "Takes about a minute. Have your AIOStreams address, UUID and password ready."}</span></div>
        </div>
      </div>
      <section class="demo" aria-label="Subtitles sliding into line with the voices">
        <div class="demo-lane"><span>Voices</span><div class="demo-row">${lane("voice")}</div></div>
        <div class="demo-lane"><span>Subtitles</span><div class="demo-row subs">${subs}</div></div>
        <p class="demo-note"><span class="dot"></span>Synced to your file</p>
        <div class="player" role="img" aria-label="Your player's subtitle menu with BttrSubs' tracks">
          <p>Your player's subtitles</p>
          <span class="on"><i></i><b>English<small>Dub · Synced · BttrSubs</small></b>${icon("check")}</span>
          <span><i></i><b>Spanish<small>Synced · BttrSubs</small></b></span>
          <span><i></i><b>Off</b></span>
        </div>
      </section>
      <section class="features" aria-label="What it does">
        <div><h2>English Dub captions</h2><p>Written from the dub, so the words match the voices. Official English CC when a show has none.</p></div>
        <div><h2>Synced to your video</h2><p>Retimed to the exact file you play, even one with no subtitles of its own. No delay to adjust yourself.</p></div>
        <div><h2>Your languages too</h2><p>The best subtitle in each language you pick, right next to the English one.</p></div>
      </section>
      <details class="perks-more" open><summary>Six more things it does</summary>
      <ul class="perks">
        <li><b>Real translations first</b>Official first, then people's. No machine or AI unless you allow it.</li>
        <li><b>Made for your copy</b>Subtitles from your file's group or streaming service win.</li>
        <li><b>Many sources, one pick</b>Eight sources and your own addons, ranked together.</li>
        <li><b>Knows anime numbering</b>Episode 113 or season 2 episode 13, season packs too.</li>
        <li><b>Honest labels</b>Says when one can't sync to your file, or leaves it out.</li>
        <li><b>Works where you watch</b>Through AIOStreams, in Stremio, Jellyfin and other players.</li>
      </ul>
      </details>`;
  };
  const stepHead = (id, title, desc) => `<header class="step-head"><div class="step-title">${editing ? `<p class="step-editing">Editing ${esc(C?.label || "your configuration")}</p>` : ""}<h1>${title}</h1><p>${desc.map((s) => `<span class="sent">${s}</span>`).join(" ")}</p></div>${live(MOODS[id], "peek")}</header>`;
  // A link is short to look at, whole when copied.
  const shortUrl = (url) => url.replace(/^(https?:\/\/[^/]+\/)(.{10}).+(.{6})(\/manifest\.json)$/, "$1$2…$3$4");
  // The timeout this addon's entry needs in AIOStreams, as the save answered it.
  const timeoutSaid = () => `${st.timeoutMs.toLocaleString("en-US")} ms`;
  const result = () =>
    `<div class="stage">
        <div id="bubs-host">${live("beam")}</div>
        <div class="intertitle"><h1 class="caption cfg-title">${st.inPlace ? "Saved and in use." : "Buttered up and ready."}</h1><p class="synced-line">${st.inPlace ? "Your install URL stays the same: AIOStreams uses the new settings from the next play, nothing to reinstall." : st.canAdd ? "Add it to your AIOStreams from here, or copy the install URL and add it yourself." : "Your install URL. Copy it, then add it in AIOStreams."}</p></div>
      </div>
      <section class="result">
        ${st.canAdd ? `<div class="add-aio"><button type="button" class="btn${st.inPlace ? "" : " primary"}" id="add-aio"${st.added ? " disabled" : ""}><span class="spin"></span>${st.added ? `${icon("check")}In your AIOStreams` : "Add to AIOStreams"}</button><p id="add-status" role="status">${st.added ? esc(st.added) : st.timeoutMs ? `Also sets its <b>Timeout</b> in AIOStreams to <b>${timeoutSaid()}</b>.` : ""}</p></div>` : st.inPlace && st.timeoutMs ? `<p class="timeout-note">In AIOStreams, this addon's <b>Timeout</b> must be at least <b>${timeoutSaid()}</b>.</p>` : ""}
        <div class="url-box"><output class="mono" id="url" aria-label="Your BttrSubs install URL">${esc(shortUrl(st.url))}</output><button type="button" class="btn${st.canAdd && !st.inPlace ? "" : " primary"}" id="copy"><span class="idle">${icon("copy")}Copy install URL</span><span class="done">${icon("check")}Copied</span></button><span class="sr-only" id="copy-status" role="status"></span></div>
        ${st.inPlace || st.added ? "" : `<ol class="after"><li><span>Go to <b>Addons</b> and choose <b>Add addon → Custom</b>.</span></li><li><span><b>Paste</b> this install URL as the Manifest URL.</span></li><li><span>Tick <b>Subtitles</b> under Resources${st.timeoutMs ? `, set <b>Timeout</b> to <b>${timeoutSaid()}</b>` : ""}, then save.</span></li></ol>`}
        <button type="button" class="text-link" data-edit>Change a setting</button>
      </section>`;

  function renderStep(id) {
    if (id === "intro") return intro();
    if (id === "finish" && st.url) return result();
    const i = STEPS.findIndex(([s]) => s === id);
    const [, , title, desc] = STEPS[i];
    const next = STEPS[i + 1];
    // Once every step has been through Next, moving on from one goes straight back to the review.
    const toReview = st.reached >= STEPS.length - 1;
    return (
      stepHead(id, title, desc) +
      `<div class="cfg-rows">${panels[id]()}</div>` +
      (next
        ? `<div class="step-nav"><button type="button" class="btn" data-back>${icon("back")}Back</button><span class="step-count">Step ${i + 1} of ${STEPS.length}</span><button type="button" class="btn primary" data-next><span class="spin" aria-hidden="true"></span><span>${toReview ? "Back to review" : `Next: ${next[1]}`}</span>${icon("chev")}</button></div><p class="field-error step-error" id="e-step" role="alert" hidden></p>`
        : `<div class="step-nav"><button type="button" class="btn" data-back>${icon("back")}Back</button><span class="step-count">Step ${STEPS.length} of ${STEPS.length}</span><span></span></div>`)
    );
  }

  function placeMarker(animate) {
    const cur = steps.querySelector('[aria-current="step"]'), m = steps.querySelector(".tab-marker");
    if (!cur || !m) return;
    const vertical = getComputedStyle(steps).flexDirection === "column";
    if (!animate || reduce) steps.classList.add("no-anim");
    m.style.transform = vertical ? `translateY(${cur.offsetTop}px)` : `translateX(${cur.offsetLeft}px)`;
    m.style.width = vertical ? "" : `${cur.offsetWidth}px`;
    m.style.height = vertical ? `${cur.offsetHeight}px` : "";
    if (!animate || reduce) { m.offsetWidth; steps.classList.remove("no-anim"); }
    if (!vertical && steps.scrollWidth > steps.clientWidth) steps.scrollTo({ left: cur.offsetLeft - (steps.clientWidth - cur.offsetWidth) / 2, behavior: reduce ? "auto" : "smooth" });
  }
  let first = true;
  function syncIndex() {
    $$(".step-tab", steps).forEach((b) => {
      const id = b.dataset.step;
      const i = STEPS.findIndex(([s]) => s === id);
      if (id === st.step) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
      b.dataset.state = i < 0 ? "" : stateOf(id, i);
      const sub = $("[data-sub]", b);
      if (sub) sub.textContent = summary[id]();
      const word = $(".tab-word", b)?.textContent ?? "";
      const said = b.dataset.state === "done" ? ", done" : b.dataset.state === "todo" ? ", needs attention" : "";
      b.setAttribute("aria-label", `${i >= 0 ? `Step ${i + 1}: ` : ""}${word}${said}${sub?.textContent ? `, ${sub.textContent}` : ""}`);
    });
    save();
    placeMarker(!first);
    first = false;
  }

  // ---------- errors under the field they're about ----------
  function showErrors(err, { focus = true } = {}) {
    $$(".field-error", main).forEach((p) => {
      const k = p.id.slice(2);
      p.hidden = !err[k];
      p.innerHTML = err[k] ? `${icon("alert")}<span></span>` : "";
      if (err[k]) $("span:not(.ic)", p).textContent = err[k];
      const f = $(`#c-${k}`, main);
      if (!f) return;
      if (err[k]) { f.setAttribute("aria-invalid", "true"); f.setAttribute("aria-describedby", `${p.id} h-${k}`); }
      else { f.removeAttribute("aria-invalid"); f.setAttribute("aria-describedby", `h-${k}`); }
    });
    const firstKey = Object.keys(err)[0];
    if (firstKey && focus) ($(`#c-${firstKey}`, main) ?? $(`#e-${firstKey}`, main))?.focus();
  }
  // The server's messages start with what they're about ("SubDL API key: …"): each goes under its field, on its step.
  const FIELD_OF = [["SubSource", "subsource", "sources"], ["SubDL", "subdl", "sources"], ["Wyzie", "wyzie", "sources"], ["Other addons", "addons", "sources"], ["Sources", "sources", "sources"], ["Another install URL", "aioAlso", "sync"], ["AIOStreams UUID", "aioId", "sync"], ["AIOStreams password", "aioPw", "sync"], ["AIOStreams", "aioAddress", "sync"], ["Languages", "langs", "languages"], ["Configuration name", "name", "finish"], ["Styles", "styles", "style"], ["Move subtitles up", "styles", "style"]];
  function serverError(message) {
    const hit = FIELD_OF.find(([prefix]) => message.startsWith(prefix));
    const text = message.replace(/^[^:]+:\s*/, "").replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.");
    if (!hit) return showErrors({ [st.step === "finish" ? "create" : "step"]: message.replace(/([^.!?])$/, "$1.") });
    const [, key, step] = hit;
    if (step !== st.step) go(step, { instant: true });
    showErrors({ [key]: text });
  }

  // ---------- moving through the steps ----------
  function go(id, opts = {}) {
    const run = () => {
      st.step = id;
      main.innerHTML = renderStep(id);
      bind();
      syncIndex();
      onStep(id);
    };
    if (!opts.instant && !reduce && document.startViewTransition) document.startViewTransition(run);
    else run();
    if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: "auto" });
  }
  // The server checks a step as it's left; the button keeps its size while it waits.
  async function check(id) {
    const response = await fetch(CHECK_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ step: id, ...body() }) });
    const answer = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("Signed out. Reload the page to sign in again.");
    if (!response.ok) throw new Error(answer.error || "Couldn't check this step. Try again in a moment.");
  }
  async function next(btn) {
    const i = STEPS.findIndex(([s]) => s === st.step);
    const local = problem(st.step);
    if (local) return showErrors({ [local[0]]: local[1] });
    btn.classList.add("busy");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    try {
      await check(st.step);
    } catch (error) {
      btn.classList.remove("busy");
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      return serverError(error.message === "Failed to fetch" ? "Couldn't reach BttrSubs. Check your connection and try again." : error.message);
    }
    if (st.step === "sync") st.checkedAio = accountMark();
    st.flagged = st.flagged.filter((s) => s !== st.step);
    st.reached = Math.max(st.reached, i + 1);
    go(st.reached >= STEPS.length - 1 ? "finish" : STEPS[i + 1][0]);
  }
  async function create(btn) {
    const missing = missingStep();
    if (missing) {
      go(missing);
      const p = problem(missing);
      setTimeout(() => showErrors({ [p[0]]: p[1] }), 30);
      return;
    }
    btn.classList.add("busy");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    const sent = body();
    let answer;
    try {
      const response = await fetch(SAVE_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(sent) });
      answer = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error("Signed out. Reload the page to sign in again.");
      if (!response.ok) throw new Error(answer.error || "Couldn't save. Try again in a moment.");
    } catch (error) {
      btn.classList.remove("busy");
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      return serverError(error.message === "Failed to fetch" ? "Couldn't reach BttrSubs. Check your connection and try again." : error.message);
    }
    st.url = answer.manifestUrl;
    st.inPlace = Boolean(answer.inPlace);
    st.canAdd = Boolean(answer.canAdd);
    st.timeoutMs = Number(answer.timeoutMs) || 0;
    st.added = "";
    st.reached = STEPS.length;
    go("finish");
  }

  function bind() {
    const b = main;
    $$("[data-field]", b).forEach((f) => f.addEventListener("input", () => {
      st[f.dataset.field] = f.value;
      if (f.getAttribute("aria-invalid")) showErrors({}, { focus: false });
      if (f.dataset.field.startsWith("aio") && !accountProblem(false)) st.flagged = st.flagged.filter((s) => s !== "sync");
      if (f.dataset.field.startsWith("aio")) paintTest();
      syncIndex();
    }));
    // The account is tested as each of its fields is left, and AIOMetadata's URL with it (runTest).
    ["aioAddress", "aioId", "aioPw", "aioAlso"].forEach((k) => $(`#c-${k}`, b)?.addEventListener("change", () => runTest()));
    // An address or UUID that won't work is flagged as soon as its field is left, and Sync is marked on the step strip.
    ["aioAddress", "aioId"].forEach((k) => $(`#c-${k}`, b)?.addEventListener("blur", () => {
      const p = accountProblem(false);
      if (!p || p[0] !== k) return;
      if (!st.flagged.includes("sync")) st.flagged.push("sync");
      showErrors({ [p[0]]: p[1] }, { focus: false });
      syncIndex();
    }));
    $$("[data-flag]", b).forEach((f) => f.addEventListener("change", () => {
      const k = f.dataset.flag;
      if (k.startsWith("src-")) st.src[k.slice(4)] = f.checked;
      else st.flt[k] = f.checked;
      syncIndex();
    }));
    $$("[data-remove], [data-unremove]", b).forEach((x) => x.addEventListener("click", () => {
      const k = x.dataset.remove ?? x.dataset.unremove;
      st.remove[k] = x.dataset.remove !== undefined;
      st[k] = "";
      go(st.step, { instant: true, keepScroll: true });
      $(st.remove[k] ? `[data-unremove="${k}"]` : `[data-remove="${k}"]`, main)?.focus();
    }));
    $$("[data-unaddon]", b).forEach((x) => x.addEventListener("click", () => {
      const i = Number(x.dataset.unaddon);
      st.removeAddons = st.removeAddons.includes(i) ? st.removeAddons.filter((n) => n !== i) : [...st.removeAddons, i];
      go("sources", { instant: true, keepScroll: true });
      $(`[data-unaddon="${i}"]`, main)?.focus();
    }));
    $$("[data-lang]", b).forEach((c) => c.addEventListener("click", () => {
      const l = c.dataset.lang;
      st.langs = st.langs.includes(l) ? st.langs.filter((x) => x !== l) : [...st.langs, l];
      const on = st.langs.includes(l);
      c.classList.toggle("on", on);
      c.setAttribute("aria-pressed", String(on));
      c.innerHTML = chipInner(on, shownLang(l));
      syncIndex();
    }));
    $$("[data-hi]", b).forEach((c) => c.addEventListener("click", () => { st.hi = c.dataset.hi; $$("[data-hi]", b).forEach((x) => { x.setAttribute("aria-pressed", String(x === c)); x.setAttribute("aria-checked", String(x === c)); }); syncIndex(); }));
    $("#c-per", b)?.addEventListener("input", (e) => {
      if (inRange(e.target)) st.per = Number(e.target.value);
      markHeight(e.target);
      const unit = $(".stepper-unit", e.target.closest(".stepper"));
      if (unit) unit.textContent = Number(e.target.value) === 1 ? "subtitle" : "subtitles";
      syncIndex();
    });
    // Styles: the one being added, and each in place.
    $("#c-style-where", b)?.addEventListener("change", (e) => {
      st.addStyle.scope = e.target.value;
      go("style", { instant: true, keepScroll: true });
      $(st.addStyle.scope === "show" ? "#c-style-show" : "#c-style-where", main)?.focus();
    });
    $("#c-style-show", b)?.addEventListener("input", (e) => { st.addStyle.id = e.target.value; });
    $("#c-style-lang", b)?.addEventListener("change", (e) => {
      st.addStyle.lang = e.target.value;
      go("style", { instant: true, keepScroll: true });
      $("#c-style-lang", main)?.focus();
    });
    // The preview draws what was last touched: the style being added, or a style's row.
    // A number in a stepper's own range, as its field holds it.
    const inRange = (x, v = x.value) => /^\d+$/.test(String(v).trim()) && Number(v) >= Number(x.dataset.min) && Number(v) <= Number(x.dataset.max);
    // A number out of range is marked at once; a height's preview stays where the last good one put it.
    const markHeight = (x) => {
      const bad = Boolean(x.value.trim()) && !inRange(x);
      if (bad) x.setAttribute("aria-invalid", "true");
      else x.removeAttribute("aria-invalid");
      x.closest(".stepper")?.classList.toggle("bad", bad);
      // At an end of the range, the button that would pass it says it can't.
      for (const btn of $$("[data-step-by]", x.closest(".stepper"))) {
        const next = Number(x.value) + Number(btn.dataset.stepBy);
        btn.setAttribute("aria-disabled", String(inRange(x) && !inRange(x, next)));
      }
    };
    // The buttons: one a press, held down they repeat, and they stop at the range the server takes. An empty or bad
    // height steps from the look's usual one, anything else from its lowest. Each step goes through the field's input event.
    const stepHeight = (btn) => {
      const x = $("input", btn.closest(".stepper"));
      const height = x.id === "c-style-up" || x.dataset.styleUp !== undefined;
      const r = x.dataset.styleUp !== undefined ? st.styles[Number(x.dataset.styleUp)] : null;
      const from = inRange(x) ? Number(x.value) : height ? usualFor(r ? r.look : addSpec()) : Number(x.dataset.min);
      const to = Math.min(Number(x.dataset.max), Math.max(Number(x.dataset.min), from + Number(btn.dataset.stepBy)));
      if (String(to) === x.value) return false;
      x.value = String(to);
      x.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    // The repeat belongs to the button held: another button losing focus as this one is pressed doesn't stop it.
    let held, heldBy = null, pressed = false;
    const release = (btn) => { if (btn && btn !== heldBy) return; clearTimeout(held); clearInterval(held); heldBy = null; };
    $$("[data-step-by]", b).forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        pressed = true;
        release();
        stepHeight(btn);
        heldBy = btn;
        held = setTimeout(() => { held = setInterval(() => { if (!stepHeight(btn)) release(); }, 70); }, 420);
      });
      for (const end of ["pointerup", "pointerleave", "pointercancel", "blur"]) btn.addEventListener(end, () => release(btn));
      // A press was already counted on pointerdown; the keyboard's Enter and Space come as a click alone.
      btn.addEventListener("click", () => { if (pressed) pressed = false; else stepHeight(btn); });
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
    });
    $$(".stepper input", b).forEach((x) => {
      markHeight(x);
      // Digits only, as they are typed or pasted.
      x.addEventListener("input", () => { const clean = x.value.replace(/\D/g, "").slice(0, x.maxLength); if (clean !== x.value) x.value = clean; }, { capture: true });
      // The arrow keys step it, as a number field's do.
      x.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        stepHeight($(`[data-step-by="${e.key === "ArrowUp" ? 1 : -1}"]`, x.closest(".stepper")));
      });
      // On a touch screen the keyboard covers the lower half: the field goes to the top, the preview stays in sight under it.
      if (matchMedia("(pointer: coarse)").matches) x.addEventListener("focus", () => setTimeout(() => x.closest(".stepper").scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }), 350));
    });
    const preview = (look, up) => { const p = $("[data-look-preview]", b); if (p) p.style.cssText = lookCss(look ?? "", up); };
    const addSpec = () => specOf(st.addStyle.look, st.addStyle.changes);
    $$("[data-look-card]", b).forEach((card) => card.addEventListener("click", () => {
      const a = st.addStyle;
      const picked = card.dataset.lookCard;
      // A height left at the look's usual follows the new look's.
      if (!String(a.up).trim() || Number(a.up) === usualFor(a.look)) a.up = String(usualFor(picked));
      a.look = picked;
      // Changes stay on the new look, but not those it has already; the controls start at its values.
      const own = presetValues(presetOf(a.look));
      for (const k of Object.keys(a.changes)) if (a.changes[k] === own[k]) delete a.changes[k];
      go("style", { instant: true, keepScroll: true });
      $('[data-look-card][aria-checked="true"]', main)?.focus();
    }));
    $("#c-style-up", b)?.addEventListener("input", (e) => {
      st.addStyle.up = e.target.value;
      markHeight(e.target);
      if (!e.target.value.trim() || goodPct(e.target.value)) preview(addSpec(), st.addStyle.up);
    });
    $$("[data-look-card], #c-style-up", b).forEach((x) => x.addEventListener("focus", () => preview(addSpec(), st.addStyle.up)));
    // The preview's picture and line.
    $$("[data-scene-pick]", b).forEach((x) => x.addEventListener("click", () => {
      st.preview.scene = x.dataset.scenePick;
      $(".look-preview", b).dataset.scene = st.preview.scene;
      $$("[data-scene-pick]", b).forEach((y) => { y.setAttribute("aria-pressed", String(y === x)); y.setAttribute("aria-checked", String(y === x)); });
    }));
    $("[data-preview-text]", b)?.addEventListener("input", (e) => {
      st.preview.text = e.target.value;
      const p = $("[data-look-preview]", b);
      if (p) p.textContent = st.preview.text || "Subtitles look like this.";
    });
    $(".style-changes", b)?.addEventListener("toggle", (e) => { st.addStyle.open = e.currentTarget.open; });
    const changed = (k, value) => {
      const a = st.addStyle;
      if (value === "" || value === presetValues(presetOf(a.look))[k]) delete a.changes[k];
      else a.changes[k] = value;
      const n = Object.keys(a.changes).length;
      $("[data-changes-count]", b).textContent = changedNote(n);
      $("[data-changes-clear]", b).style.visibility = n === 0 ? "hidden" : "visible";
      // How solid the box is counts only with a box.
      const solid = $('[data-change="k"]', b);
      if (solid) solid.disabled = !drawnLook(addSpec()).box;
      $("[data-outline-label]", b).textContent = drawnLook(addSpec()).box ? "Box colour" : "Outline colour";
      const plain = $('[data-look-card=""] .look-card-name', b);
      if (plain) plain.textContent = n ? "Plain" : "Keep as it is";
      preview(addSpec(), a.up);
    };
    $$("[data-change]", b).forEach((x) => {
      x.addEventListener("focus", () => preview(addSpec(), st.addStyle.up));
      x.addEventListener("input", () => {
        const a = st.addStyle;
        const k = x.dataset.change;
        if (k === "f") {
          const name = $("[data-font-name]", b);
          a.otherFont = x.value === "other";
          name.disabled = !a.otherFont;
          if (a.otherFont) {
            delete a.changes.f;
            changed("g", FONT_NAME.test(fontSpec(name.value)) ? fontSpec(name.value) : "");
            name.focus();
            return;
          }
          name.value = "";
          name.removeAttribute("aria-invalid");
          delete a.changes.g;
        }
        const value = ["b", "x", "i"].includes(k) ? (x.checked ? "1" : "0") : k === "c" || k === "o" ? x.value.slice(1).toLowerCase() : ["w", "h", "s"].includes(k) ? String(Number(x.value)) : x.value;
        changed(k, value);
        const out = $(`[data-out="${k}"]`, b);
        if (out) out.textContent = k === "z" ? `${x.value}% of this look's (${drawnLook(addSpec()).size})` : `${x.value}${k === "k" ? "%" : ""}`;
      });
    });
    $("[data-font-name]", b)?.addEventListener("input", (e) => {
      const typed = fontSpec(e.target.value);
      const good = typed === "" || FONT_NAME.test(typed);
      if (good) e.target.removeAttribute("aria-invalid");
      else e.target.setAttribute("aria-invalid", "true");
      $("[data-font-note]", b).textContent = good ? "For a font your player has. The preview shows it only if this device has it too." : "Letters, digits, spaces and . ' - only, 40 at most.";
      changed("g", good ? typed : "");
    });
    $$("[data-seg-change]", b).forEach((x) => x.addEventListener("click", () => {
      changed(x.dataset.segChange, x.dataset.value);
      $$(`[data-seg-change="${x.dataset.segChange}"]`, b).forEach((y) => { y.setAttribute("aria-pressed", String(y === x)); y.setAttribute("aria-checked", String(y === x)); });
    }));
    $("[data-changes-clear]", b)?.addEventListener("click", (e) => {
      // It is inside the heading that opens and closes the changes: a press on it is its own.
      e.preventDefault();
      e.stopPropagation();
      st.addStyle.changes = {};
      go("style", { instant: true, keepScroll: true });
      $(".style-changes summary", main)?.focus();
    });
    $$("[data-style-edit]", b).forEach((x) => x.addEventListener("click", () => {
      const r = st.styles[Number(x.dataset.styleEdit)];
      const { base, changes } = parseLook(r.look);
      st.addStyle = { scope: r.scope, id: r.id ?? "", lang: r.lang ?? "", look: base, up: String(r.up ?? usualFor(r.look)), changes, open: Object.keys(changes).length > 0 };
      go("style", { instant: true, keepScroll: true });
      const pick = $('[data-look-card][aria-checked="true"]', main) ?? $("[data-look-card]", main);
      pick?.scrollIntoView({ block: "center" });
      pick?.focus();
    }));
    $$("[data-style-look], [data-style-up]", b).forEach((x) => x.addEventListener("focus", () => { const r = st.styles[Number(x.dataset.styleLook ?? x.dataset.styleUp)]; preview(r.look, r.up); }));
    $("[data-style-add]", b)?.addEventListener("click", () => {
      const a = st.addStyle;
      const typed = String(a.up).trim();
      // The usual height moves nothing, so it isn't kept.
      const up = typed && Number(typed) !== usualFor(a.look) ? typed : "";
      const look = specOf(a.look, a.changes);
      const id = a.scope === "show" ? (a.id.match(/tt\d{5,10}/) ?? [""])[0] : "";
      if (a.scope === "show" && !id) return showErrors({ styles: "Paste the show's IMDb link, or its id (tt and digits)." });
      if (typed && !goodPct(typed)) return showErrors({ styles: `How far up is a whole percent from ${S.limits.raiseMin} to ${S.limits.raiseMax}.` });
      if (!look && !up) return showErrors({ styles: `Choose a look, a height other than the usual ${usualFor("")}%, or both.` });
      const rule = { scope: a.scope, ...(id ? { id, name: st.styles.find((r) => r.id === id)?.name } : {}), ...(a.lang ? { lang: a.lang } : {}), ...(look ? { look } : {}), ...(up ? { up } : {}) };
      // One style for each place: adding one where there is one replaces it.
      const at = st.styles.findIndex((r) => r.scope === rule.scope && (r.id ?? "") === (rule.id ?? "") && (r.lang ?? "") === (rule.lang ?? ""));
      if (at < 0 && st.styles.length >= S.limits.styles) return showErrors({ styles: `Up to ${S.limits.styles} styles.` });
      if (at >= 0) st.styles[at] = rule;
      else st.styles.push(rule);
      st.addStyle = { scope: a.scope, id: "", lang: "", look: "", up: String(S.limits.usualUp), changes: {} };
      go("style", { instant: true, keepScroll: true });
      $("#c-style-where", main)?.focus();
    });
    $$("[data-style-look]", b).forEach((x) => x.addEventListener("change", () => {
      const r = st.styles[Number(x.dataset.styleLook)];
      if (x.value) r.look = x.value;
      else delete r.look;
      // A height at the new look's usual moves nothing; one not set shows the new look's.
      if (r.up !== undefined && Number(r.up) === usualFor(r.look)) delete r.up;
      const field = $(`[data-style-up="${x.dataset.styleLook}"]`, b);
      if (r.up === undefined && field) field.value = String(usualFor(r.look));
      preview(r.look, r.up);
      syncIndex();
    }));
    $$("[data-style-up]", b).forEach((x) => x.addEventListener("input", () => {
      const r = st.styles[Number(x.dataset.styleUp)];
      if (x.value.trim() && Number(x.value) !== usualFor(r.look)) r.up = x.value;
      else delete r.up;
      markHeight(x);
      if (!x.value.trim() || goodPct(x.value)) preview(r.look, x.value);
      syncIndex();
    }));
    $$("[data-style-remove]", b).forEach((x) => x.addEventListener("click", () => {
      st.styles.splice(Number(x.dataset.styleRemove), 1);
      go("style", { instant: true, keepScroll: true });
      $("#c-style-where", main)?.focus();
    }));
    $$("[data-goto]", b).forEach((x) => x.addEventListener("click", () => go(x.dataset.goto)));
    $("[data-back]", b)?.addEventListener("click", () => { const i = STEPS.findIndex(([s]) => s === st.step); go(i > 0 ? STEPS[i - 1][0] : "intro"); });
    $("[data-next]", b)?.addEventListener("click", (e) => next(e.currentTarget));
    $("[data-dialog]", b)?.addEventListener("click", openInstances);
    $("#create", b)?.addEventListener("click", (e) => create(e.currentTarget));
    $("#copy", b)?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try { await navigator.clipboard.writeText(st.url); }
      catch { const area = document.createElement("textarea"); area.value = st.url; document.body.append(area); area.select(); document.execCommand("copy"); area.remove(); }
      btn.classList.add("copied");
      $("#copy-status", b).textContent = "Install URL copied. Paste it into AIOStreams.";
      setTimeout(() => btn.classList.remove("copied"), 2200);
    });
    $("#add-aio", b)?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const status = $("#add-status", b);
      btn.classList.add("busy");
      btn.disabled = true;
      status.classList.remove("bad");
      status.textContent = "Asking your AIOStreams…";
      let answer = {};
      let failed = "";
      try {
        // The saved configuration's own address: the server reads the account from it, so nothing is sent.
        const response = await fetch(new URL(st.url).pathname.replace(/\/manifest\.json$/, "/configure/add"), { method: "POST", headers: { Accept: "application/json" } });
        answer = await response.json().catch(() => ({}));
        if (response.status === 401) failed = "Signed out. Reload the page to sign in again.";
        else if (response.status === 429) failed = "Too many tries just now. Wait a minute and try again.";
        else if (!response.ok) failed = answer.error || "Couldn't add it. Copy the install URL and add it in AIOStreams yourself.";
      } catch {
        failed = "Couldn't reach BttrSubs. Check your connection and try again.";
      }
      if (failed) {
        btn.classList.remove("busy");
        btn.disabled = false;
        status.classList.add("bad");
        status.textContent = failed;
        return;
      }
      st.added = answer.state === "present" ? `Already in your AIOStreams as "${answer.name}". Nothing to add.` : answer.state === "updated" ? `Your AIOStreams already had "${answer.name}": it's now set up for this configuration.` : `Added to your AIOStreams as "${answer.name}". You'll find it under Addons there.`;
      go("finish");
    });
    $("[data-edit]", b)?.addEventListener("click", () => { st.url = ""; go("finish"); });
    // Enter in a field moves the flow on, as the step's own button does.
    $$("input.field", b).forEach((f) => f.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || f.id === "c-style-show" || f.id === "c-style-up" || f.dataset.styleUp !== undefined) return;
      e.preventDefault();
      ($("[data-next]", b) ?? $("#create", b))?.click();
    }));
  }
  function openInstances() {
    let d = $("#cfg-instances");
    if (!d) {
      d = document.createElement("dialog");
      d.id = "cfg-instances";
      d.className = "cfg-dialog";
      d.setAttribute("aria-labelledby", "inst-title");
      const list = S.instances.map((u) => `<li><a class="mono out-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ""))}${icon("ext")}<span class="sr-only"> (opens in a new tab)</span></a></li>`).join("");
      d.innerHTML = `<div class="dialog-head"><h2 id="inst-title">Which AIOStreams instances work?</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div>` +
        (list ? `<p>If someone set one up for you, use theirs${S.own ? " (the first one here)" : ""}. Otherwise any of these works: open it, save a configuration there, then use its address, UUID and password here.</p><ul class="inst">${list}</ul>` : `<p>This server takes only the AIOStreams its owner set up. Ask them for its address.</p>`) +
        `<p><b>Run your own?</b> Set <b>Pipeline cache TTL</b> to 60 in its admin settings. When a play's file isn't in the list BttrSubs gets, a linked Stremio or an AIOMetadata URL then gets the very list that player chose from, from memory, instead of asking every addon again. The AIOStreams app and Jellyfin apps on AIOStreams don't need it.</p>`;
      document.body.appendChild(d);
      $("[data-close]", d).addEventListener("click", () => d.close());
      d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    }
    d.showModal();
  }

  function onStep(id) {
    main.querySelector("[data-start]")?.addEventListener("click", () => go(editing ? "finish" : "sync"));
    if (id === "sync") runTest();
    // On phones the perks start folded, so the intro is the card, the demo and three features.
    if (id === "intro" && matchMedia("(max-width: 860px)").matches) main.querySelector(".perks-more")?.removeAttribute("open");
    // On the intro, Bubs is the usher: press him and he tips his cap; twice, and he lights the way to the start button.
    const poke = main.querySelector("#poke");
    if (id === "intro" && poke) UsherPoke.attach(poke, { render: (mood, arm) => { poke.innerHTML = B.full({ mood, arm, blink: true, id: "poke" }); }, target: () => main.querySelector("[data-start]") });
    NoirEyes.kick();
  }

  steps.addEventListener("click", (e) => { const t = e.target.closest(".step-tab"); if (t) go(t.dataset.step); });
  // A warning's words open on its button and close on it again, on a click elsewhere, or on Escape.
  const closeWarnings = (except) => $$(".warn-pop:not([hidden])").forEach((pop) => { if (pop === except) return; pop.hidden = true; $(`[aria-controls="${pop.id}"]`)?.setAttribute("aria-expanded", "false"); });
  document.addEventListener("click", (e) => {
    const button = e.target.closest("[data-warn]");
    if (!button) { if (!e.target.closest(".warn-pop")) closeWarnings(); return; }
    const pop = document.getElementById(button.getAttribute("aria-controls"));
    const open = pop.hidden;
    closeWarnings(pop);
    pop.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (e) => {
    const open = e.key === "Escape" ? $(".warn-pop:not([hidden])") : null;
    if (!open) return;
    const button = $(`[aria-controls="${open.id}"]`);
    closeWarnings();
    button?.focus();
  });
  // The Sync step's own buttons: test again, and open AIOMetadata's field.
  main.addEventListener("click", (e) => {
    if (e.target.closest("[data-test-again]")) runTest(true);
    if (e.target.closest("[data-also-open]")) {
      st.alsoOpen = true;
      go("sync", { instant: true, keepScroll: true });
      $("#c-aioAlso", main)?.focus();
    }
  });
  addEventListener("resize", () => placeMarker(false));
  document.fonts?.ready.then(() => placeMarker(false));

  // ---------- the sidebar: the mark, the theme, the owner's way back and Sign out ----------
  $("#brand-mark").innerHTML = B.symbol({ title: "" }).replace('role="img" aria-label=""', 'aria-hidden="true"');
  $(".brand").addEventListener("click", (e) => { e.preventDefault(); go("intro"); });
  const themeBtn = $("#theme");
  const isDark = () => document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const paintTheme = () => { const d = isDark(); themeBtn.setAttribute("aria-pressed", String(d)); themeBtn.setAttribute("aria-label", d ? "Light theme" : "Dark theme"); themeBtn.innerHTML = icon(d ? "sun" : "moon"); };
  themeBtn.addEventListener("click", () => { const n = isDark() ? "light" : "dark"; document.documentElement.dataset.theme = n; try { localStorage.setItem("bttr-noir-theme", n); } catch {} paintTheme(); });
  paintTheme();
  // Sign out asks once more: the first press shows "Sign out?" for 4 s, the second signs out.
  const so = $(".signout");
  if (so) {
    const word = $("span:not(.ic)", so);
    let t = 0;
    const disarm = () => { clearTimeout(t); so.classList.remove("confirm"); word.textContent = "Sign out"; so.setAttribute("aria-label", "Sign out"); };
    so.addEventListener("click", () => {
      if (!so.classList.contains("confirm")) { so.classList.add("confirm"); word.textContent = "Sign out?"; so.setAttribute("aria-label", "Sign out? Press again to sign out"); clearTimeout(t); t = setTimeout(disarm, 4000); return; }
      $("#signout-form").submit();
    });
    so.addEventListener("blur", disarm);
  }

  go(st.step === "intro" || STEPS.some(([s]) => s === st.step) ? st.step : "intro", { instant: true });
})();
