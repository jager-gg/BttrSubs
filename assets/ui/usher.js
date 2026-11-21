/*
 * Ask the usher. Pressing Bubs on setup's intro makes him tip his cap. Press him again within a few
 * seconds and he shows you the way: he points at the start button and his torch lights it, a soft
 * cone of light from his glove to the button, the way an usher shows you to your seat. Outside the card the
 * light lies on the page; inside, it lies on the card behind its words, so no line of text is covered.
 * Reduced motion: no cap tip or beam; the button's light ring shows still.
 * UsherPoke.attach(button, { render(mood, arm), target() }).
 */
(function (g) {
  // The Reduce motion switch (html.calm or html.moving) wins over the device's setting.
  const reduce = document.documentElement.classList.contains("calm") || (!document.documentElement.classList.contains("moving") && matchMedia("(prefers-reduced-motion: reduce)").matches);
  // His fingertip when pointing, in his drawing's own coordinates (see point() in bubs.js).
  const FINGER = { x: 416, y: 186 };

  const pulse = (el, cls, ms) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); };

  // The smallest convex shape holding the fingertip and the button's four corners: the torch's cone.
  function hull(pts) {
    pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = (list) => { const h = []; for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
    return half(pts).concat(half(pts.slice().reverse()));
  }

  function torch(button, target) {
    const svg = button.querySelector("svg");
    const m = svg?.getScreenCTM();
    const r = target.getBoundingClientRect();
    pulse(target, "spotlit", 1900);
    if (!m || reduce) return;
    const tip = { x: m.a * FINGER.x + m.c * FINGER.y + m.e, y: m.b * FINGER.x + m.d * FINGER.y + m.f };
    const pts = hull([tip, { x: r.left, y: r.top }, { x: r.right, y: r.top }, { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom }]);
    const ns = "http://www.w3.org/2000/svg";
    const card = target.closest(".intertitle");
    const c = card?.getBoundingClientRect();
    // The cone in coordinates offset by (dx, dy): the viewport for the page, the card's corner inside it.
    const cone = (id, dx, dy, mask = "") =>
      `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${tip.x - dx}" y1="${tip.y - dy}" x2="${(r.left + r.right) / 2 - dx}" y2="${(r.top + r.bottom) / 2 - dy}">` +
      `<stop offset="0" stop-color="#E6B43A" stop-opacity=".36"/><stop offset="1" stop-color="#E6B43A" stop-opacity=".1"/></linearGradient>${mask}</defs>` +
      `<polygon points="${pts.map((p) => `${(p.x - dx).toFixed(1)},${(p.y - dy).toFixed(1)}`).join(" ")}" fill="url(#${id})"${mask ? ' mask="url(#usher-out)"' : ""}/>`;
    const beam = document.createElementNS(ns, "svg");
    beam.setAttribute("class", "usher-beam");
    beam.setAttribute("aria-hidden", "true");
    // On the page, the card is cut out of the light.
    const cut = c ? `<mask id="usher-out" maskUnits="userSpaceOnUse" x="0" y="0" width="${innerWidth}" height="${innerHeight}"><rect width="${innerWidth}" height="${innerHeight}" fill="#fff"/><rect x="${c.left}" y="${c.top}" width="${c.width}" height="${c.height}" fill="#000"/></mask>` : "";
    beam.innerHTML = cone("usher-light", 0, 0, cut);
    document.body.appendChild(beam);
    const parts = [beam];
    if (card) {
      // In the card, the same light under its words.
      const inner = document.createElementNS(ns, "svg");
      inner.setAttribute("class", "usher-beam-in");
      inner.setAttribute("aria-hidden", "true");
      inner.innerHTML = cone("usher-light-in", c.left, c.top);
      card.prepend(inner);
      parts.push(inner);
    }
    setTimeout(() => parts.forEach((p) => p.remove()), 1900);
  }

  function attach(button, { render, target }) {
    let count = 0, reset = 0, busy = false;
    button.addEventListener("click", () => {
      if (busy) return;
      count++;
      clearTimeout(reset);
      reset = setTimeout(() => (count = 0), 3500);
      if (count < 2) {
        // A tip of the cap.
        render("beam", "wave");
        g.NoirEyes?.kick();
        if (!reduce) pulse(button, "tip", 950);
        return;
      }
      // Right this way.
      count = 0;
      busy = true;
      render("beam", "point");
      g.NoirEyes?.kick();
      if (!reduce) pulse(button, "tip", 950);
      const t = target();
      if (t) torch(button, t);
      setTimeout(() => { render("grin", "wave"); g.NoirEyes?.kick(); busy = false; }, 2100);
    });
  }

  g.UsherPoke = { attach };
})(window);
