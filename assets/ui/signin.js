/*
 * Sign-in: the form posts to /login and the server says whether the password opens the page asked for.
 * Bubs looks away while the password is typed, frowns at a wrong one, and beams on the way in; the page
 * then irises out and the next one irises in. Without this script the form still posts and the server
 * answers with the page again or the place to go.
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const reduce = document.documentElement.classList.contains("calm") || (!document.documentElement.classList.contains("moving") && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const B = window.BubsNoir;
  $("#brand-mark").innerHTML = B.symbol({ title: "" }).replace('role="img" aria-label=""', 'aria-hidden="true"');
  const bubs = $("#bubs"), pw = $("#password"), err = $("#err"), form = $("#form"), go = $("#go");
  const show = (mood) => { bubs.innerHTML = B.full({ mood, blink: true }); NoirEyes.kick(); };
  show(err.hidden ? "grin" : "clench");
  pw.addEventListener("focus", () => NoirEyes.lookAway(true));
  pw.addEventListener("blur", () => NoirEyes.lookAway(false));
  pw.addEventListener("input", () => { if (pw.getAttribute("aria-invalid")) { pw.removeAttribute("aria-invalid"); pw.removeAttribute("aria-describedby"); err.hidden = true; show("grin"); } });
  $("#peek").addEventListener("click", (e) => {
    const on = pw.type === "password";
    pw.type = on ? "text" : "password";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    e.currentTarget.setAttribute("aria-label", on ? "Hide password" : "Show password");
    pw.focus();
  });
  const ALERT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5M12 17.2h.01"/></svg>';
  const fail = (text) => {
    err.innerHTML = `${ALERT}<span></span>`;
    err.querySelector("span").textContent = text;
    err.hidden = false;
    pw.setAttribute("aria-invalid", "true");
    pw.setAttribute("aria-describedby", "err");
    show("clench");
    form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
    go.disabled = false;
    go.textContent = "Sign in";
    pw.focus();
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    if (!pw.value) return fail("Enter the password.");
    go.disabled = true;
    go.textContent = "Checking…";
    let answer;
    try {
      const response = await fetch(form.action, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(new FormData(form)) });
      answer = await response.json();
    } catch {
      return fail("The server didn't answer. Check your connection and try again.");
    }
    if (!answer?.next) return fail(answer?.error ?? "That didn't work. Try again.");
    show("beam");
    try { sessionStorage.setItem("bttr-iris", "1"); } catch {}
    if (!reduce) document.documentElement.classList.add("iris-out");
    // The caption stays as it is: a longer one could take another line and move the whole card.
    go.textContent = "Signing in…";
    setTimeout(() => location.assign(answer.next), reduce ? 0 : 900);
  });
  const themeBtn = $("#theme");
  const ICONS = { sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>', moon: '<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>' };
  const isDark = () => document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  // The browser's bar takes the page's own background in the theme shown, the one chosen here included.
  const paintBar = () => { const paper = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim(); const [first, ...rest] = document.querySelectorAll('meta[name="theme-color"]'); rest.forEach((m) => m.remove()); if (first) { first.content = paper; first.removeAttribute("media"); } };
  const paint = () => { paintBar(); const d = isDark(); themeBtn.setAttribute("aria-pressed", String(d)); themeBtn.setAttribute("aria-label", d ? "Light theme" : "Dark theme"); themeBtn.innerHTML = `<span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[d ? "sun" : "moon"]}</svg></span>`; };
  themeBtn.addEventListener("click", () => { const n = isDark() ? "light" : "dark"; document.documentElement.dataset.theme = n; try { localStorage.setItem("bttr-noir-theme", n); } catch {} paint(); });
  paint();
})();
