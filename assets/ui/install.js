// The home-screen prompt. On a phone, in a browser rather than the home-screen app, a card above the dashboard's
// dock says how to add BttrSubs to the Home Screen: Safari's own steps on an iPhone or iPad, or an Install
// button where the browser offers one (beforeinstallprompt). Dismissing it hides it for good on this device,
// and it leaves by itself once the app is installed.
(() => {
  const KEY = "bttr-install-dismissed";
  const DELAY = 1400;
  const nav = navigator;
  const ua = nav.userAgent;
  const standalone = () => matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
  // Phones and small tablets: the layouts with the dock the card sits above.
  const phone = () => matchMedia("(max-width: 860px) and (pointer: coarse)").matches;
  const dismissed = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
  if (standalone() || dismissed()) return;

  const ios = /iPad|iPhone|iPod/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  // Safari itself: other iOS browsers name themselves, and in-app views leave out Safari's Version/.
  const safari = ios && /Version\/\d+/.test(ua) && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
  const safariVersion = Number(ua.match(/Version\/(\d+)/)?.[1] ?? 0);

  const icon = (d) => `<span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24">${d}</svg></span>`;
  const ICONS = {
    more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor"/>',
    share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5"/>',
    expand: '<path d="m6 9 6 6 6-6"/>',
    add: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>'
  };
  // Safari 26 keeps Share behind the ⋯ button and asks whether to open the page as a web app; earlier
  // Safari has Share in its toolbar.
  const STEPS = safariVersion >= 26
    ? [[ICONS.more, "More", "The three dots in Safari's bottom bar."], [ICONS.share, "Share", "Open the share menu."], [ICONS.expand, "View More", "Expand the list, or scroll down if you see it."], [ICONS.add, "Add to Home Screen", "Choose this action."], [null, "Add", "Open as Web App is already on."]]
    : [[ICONS.share, "Share", "In Safari's toolbar."], [ICONS.add, "Add to Home Screen", "Scroll down the list to it."], [null, "Add", "At the top right."]];

  let card = null;
  let offer = null;

  function hide(forGood) {
    if (forGood) try { localStorage.setItem(KEY, "1"); } catch { /* without storage it hides for this visit */ }
    if (!card) return;
    const hadFocus = card.contains(document.activeElement);
    card.remove();
    card = null;
    if (hadFocus) document.getElementById("main")?.focus({ preventScroll: true });
  }

  function show(kind) {
    if (card || !phone() || standalone() || dismissed()) return;
    card = document.createElement("aside");
    card.className = "install-card";
    card.setAttribute("aria-labelledby", "install-title");
    // A step without an icon is a button with words, drawn as that word in the key.
    const steps = STEPS.map(([d, label, hint]) => `<li>${d ? `<span class="install-key">${icon(d)}</span><span><b>${label}</b> ${hint}</span>` : `<span class="install-key word">${label}</span><span>${hint}</span>`}</li>`).join("");
    // An iOS home-screen app keeps its own cookies, apart from Safari's, so someone signed in here signs in
    // once more inside it. An app installed from Chrome shares the browser's.
    const signedIn = kind === "safari" && Boolean(document.getElementById("signout-form"));
    card.innerHTML = `<div class="install-head"><img alt="" width="40" height="40"><div><p class="install-title" id="install-title">Add BttrSubs to your Home Screen</p><p class="install-sub">It opens full screen, like an app${kind === "safari" ? ", without Safari's bars" : ""}.</p></div><button class="icon-btn" type="button" data-install-close aria-label="Dismiss">${icon(ICONS.close)}</button></div>${kind === "safari" ? `<ol class="install-steps">${steps}</ol>` : '<div class="install-go"><button class="btn primary" type="button" data-install>Install</button></div>'}${signedIn ? '<p class="install-note">The app keeps its own sign-in, so you sign in once more inside it.</p>' : ""}`;
    card.querySelector("img").src = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") ?? "/logo.png";
    card.querySelector("[data-install-close]").addEventListener("click", () => hide(true));
    card.querySelector("[data-install]")?.addEventListener("click", async () => {
      if (!offer) return hide(false);
      offer.prompt();
      const choice = await offer.userChoice.catch(() => ({ outcome: "dismissed" }));
      offer = null;
      hide(choice.outcome !== "accepted");
    });
    document.body.append(card);
  }

  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    offer = e;
    setTimeout(() => show("offer"), DELAY);
  });
  addEventListener("appinstalled", () => hide(true));
  matchMedia("(display-mode: standalone)").addEventListener?.("change", () => { if (standalone()) hide(false); });
  if (safari) setTimeout(() => show("safari"), DELAY);
})();
