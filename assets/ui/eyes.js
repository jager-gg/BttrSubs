/*
 * Bubs' eyes on any page with a standing Bubs (.noir-live): his pupils follow the pointer, eased so they
 * glide rather than snap. NoirEyes.lookAway(true) turns them up and aside, e.g. while a password is typed.
 * Reduced motion: still eyes.
 */
(function (g) {
  // The Reduce motion switch (html.calm or html.moving) wins over the device's setting.
  const reduce = document.documentElement.classList.contains("calm") || (!document.documentElement.classList.contains("moving") && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const pointer = { x: null, y: null };
  let away = false;
  let loop = 0;
  const svgs = () => [...document.querySelectorAll(".noir-live svg")];
  function frame() {
    loop = 0;
    let moving = false;
    for (const svg of svgs()) {
      const m = svg.getScreenCTM();
      if (!m) continue;
      for (const p of svg.querySelectorAll(".noir-pupil")) {
        const cx = Number(p.dataset.cx), cy = Number(p.dataset.cy);
        let tx = 0, ty = 0;
        if (away) { tx = -8; ty = -11; }
        else if (pointer.x !== null) {
          const sx = m.a * cx + m.c * cy + m.e, sy = m.b * cx + m.d * cy + m.f;
          const dx = pointer.x - sx, dy = pointer.y - sy, d = Math.hypot(dx, dy) || 1, reach = Math.min(1, d / 260);
          tx = (dx / d) * 8 * reach;
          ty = (dy / d) * 11 * reach;
        }
        const o = p._o ?? { x: 0, y: 0 };
        o.x += (tx - o.x) * 0.18;
        o.y += (ty - o.y) * 0.18;
        p._o = o;
        if (Math.abs(tx - o.x) > 0.05 || Math.abs(ty - o.y) > 0.05) moving = true;
        p.setAttribute("transform", `translate(${(cx + o.x).toFixed(2)} ${(cy + o.y).toFixed(2)})`);
      }
    }
    if (moving) loop = requestAnimationFrame(frame);
  }
  const kick = () => { if (!loop && !reduce) loop = requestAnimationFrame(frame); };
  addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; kick(); }, { passive: true });
  document.addEventListener("pointerleave", () => { pointer.x = null; kick(); });
  g.NoirEyes = { kick, lookAway(on) { away = on; kick(); } };
})(window);
