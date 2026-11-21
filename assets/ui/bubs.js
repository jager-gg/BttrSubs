/*
 * Bubs, the BttrSubs mascot: the butter-pat subtitle bubble drawn as a 1930s picture-palace usher. Grayscale
 * ink, a pillbox cap with a gold band, a bow tie, and the butter melting off his head as the one colour.
 * Drawn in code as SVG strings (window.BubsNoir), so every pose and mood is one function call.
 */
(function (g) {
  const C = {
    bone: "#F8F8F6", paper: "#EEEEEC", body: "#E7E7E3", shade: "#C6C8CA", graphite: "#16171A",
    smoke: "#53565C", ash: "#9B9EA4", butter: "#E6B43A", butterDeep: "#C9962B", oxblood: "#A2312B"
  };
  let uid = 0;

  // A butter pat whose lower-left corner runs out into a bubble's tail. bodyPath(t) slides the tail from
  // that corner (t = 0) to the middle of his bottom edge, pointing down (t = 1). Both ends share one
  // command list, so any t in between is a clean shape; at t = 0 the corner arc has zero length and the
  // outline is exactly the resting one.
  const TAIL_FROM = [166, 150, 268, 132, 284, 106, 300, 118, 280, 102, 262, 100, 230, 100, 100, 230];
  const TAIL_TO = [222, 214, 270, 208, 290, 200, 308, 192, 290, 186, 270, 178, 266, 150, 100, 216];
  function bodyPath(t = 0) {
    const v = TAIL_FROM.map((a, i) => +(a + (TAIL_TO[i] - a) * t).toFixed(2));
    return (
      `M150 76H250A50 50 0 0 1 300 126V216A50 50 0 0 1 250 266H${v[0]}` +
      `C${v[1]} ${v[2]} ${v[3]} ${v[4]} ${v[5]} ${v[6]}C${v[7]} ${v[8]} ${v[9]} ${v[10]} ${v[11]} ${v[12]}` +
      `H${v[13]}A50 50 0 0 1 ${v[14]} ${v[15]}V126A50 50 0 0 1 150 76Z`
    );
  }
  const BODY = bodyPath(0);
  // The melt on his head, the one place colour lives.
  const TOP =
    "M80 60H320V108H291C285 108 283 112 283 119V141A11 11 0 0 1 261 141V119" +
    "C261 112 259 108 253 108C232 108 226 101 204 102C180 103 168 110 140 108C118 106 104 101 80 103Z";
  const TOP_EDGE =
    "M300 108H291C285 108 283 112 283 119V141A11 11 0 0 1 261 141V119C261 112 259 108 253 108" +
    "C232 108 226 101 204 102C180 103 168 110 140 108C118 106 104 101 100 102";
  // One flat cel shade down his right side and under the mouth.
  const SHADE = "M300 96C286 150 292 214 246 262C220 276 180 272 150 266L120 320H340V80Z";

  // ---------- the mouth ----------
  const S = (d, w = 5, col = C.graphite) => `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const F = (d, fill, w = 0) => `<path d="${d}" fill="${fill}"${w ? ` stroke="${C.graphite}" stroke-width="${w}" stroke-linejoin="round"` : ""}/>`;
  const cheeks = (y = 196) => S(`M130 ${y}Q129 ${y + 12} 140 ${y + 16}M270 ${y}Q271 ${y + 12} 260 ${y + 16}`, 4.5);
  const MOUTHS = {
    // A confident closed smile.
    grin: S("M138 206Q200 252 262 206", 6) + cheeks(198),
    // All good: an open smile.
    beam: F("M136 198Q200 210 264 198Q258 248 200 252Q142 248 136 198Z", C.graphite, 4) + F("M147 204Q200 215 253 204L250 216Q200 227 150 216Z", C.bone) + F("M170 240Q200 226 230 240Q216 248 200 248Q184 248 170 240Z", C.smoke) + cheeks(188),
    // Worth a look: a smile pulled to one side.
    half: S("M152 226Q198 240 246 214", 6) + S("M252 206Q254 217 246 221", 4.5),
    // Something's wrong: a wavering, worried line.
    clench: S("M144 230Q158 218 172 230T200 230T228 230T256 230", 5.5),
    // Asleep: a small closed curve.
    shut: S("M174 228Q200 238 226 228", 5.5),
    // Annoyed: a tight frown.
    frown: S("M156 240Q200 214 244 240", 6),
    // Talking frames.
    rest: S("M156 220Q200 242 244 220", 6),
    talkA: F("M162 202Q200 198 238 202Q240 244 200 248Q160 244 162 202Z", C.graphite, 4) + F("M169 207Q200 214 231 207L230 216Q200 222 170 216Z", C.bone) + F("M176 238Q200 228 224 238Q214 244 200 244Q186 244 176 238Z", C.smoke),
    talkO: F("M200 202C218 202 226 215 226 226C226 238 214 246 200 246C186 246 174 238 174 226C174 215 182 202 200 202Z", C.graphite, 4) + F("M186 236Q200 230 214 236Q208 241 200 241Q192 241 186 236Z", C.smoke),
    talkE: F("M146 212Q200 222 254 212Q250 240 200 244Q150 240 146 212Z", C.graphite, 4) + F("M155 216Q200 226 245 216L243 225Q200 234 157 225Z", C.bone)
  };

  // ---------- eyes ----------
  const EYES = [
    { cx: 177, cy: 146, rx: 23, ry: 32 },
    { cx: 225, cy: 146, rx: 23, ry: 32 }
  ];
  const MOODS = {
    // At ease.
    grin: { look: [3, 0], lids: [0.06, 0.06], tilt: [0, 0], brows: ["M158 106Q177 97 196 105", "M206 105Q225 97 244 106"], mouth: "grin" },
    // All good.
    beam: { look: [0, -4], lids: [0, 0], tilt: [0, 0], brows: ["M156 104Q176 92 196 104", "M206 104Q226 92 246 104"], mouth: "beam" },
    // Worth a look: one brow up, eyes sliding sideways.
    half: { look: [9, 4], lids: [0.1, 0.28], tilt: [0, -8], brows: ["M156 100Q176 90 196 102", "M206 118L246 112"], mouth: "half" },
    // Something's wrong: wide eyes, tiny pupils, brows up, and he points at it instead of waving.
    clench: { look: [0, 0], lids: [0, 0], tilt: [0, 0], brows: ["M158 112Q174 98 194 100", "M208 100Q228 98 244 112"], mouth: "clench", small: true, arm: "point" },
    // Nothing to report.
    sleepy: { look: [0, 6], lids: [0.6, 0.6], tilt: [0, 0], brows: ["M158 112Q177 108 196 113", "M206 113Q225 108 244 112"], mouth: "shut" },
    // Annoyed past patience: brows in a V, lids slanting down to the middle, tiny pupils, a frown.
    angry: { look: [0, 3], lids: [0.24, 0.24], tilt: [16, -16], brows: ["M152 98L197 121", "M205 121L250 98"], mouth: "frown", small: true, vein: true, arm: "point" }
  };

  function eye(e, i, mood, id) {
    const [dx, dy] = mood.look;
    const pr = mood.small ? [6.5, 9] : [11, 17];
    const clip = `${id}-e${i}`;
    const top = e.cy - e.ry;
    const lidY = top + mood.lids[i] * e.ry * 2;
    const t = mood.tilt[i];
    const lid = mood.lids[i] > 0
      ? F(`M${e.cx - e.rx - 6} ${top - 8}H${e.cx + e.rx + 6}V${lidY + t / 2}L${e.cx - e.rx - 6} ${lidY - t / 2}Z`, C.body) + S(`M${e.cx - e.rx} ${lidY - t / 2}L${e.cx + e.rx} ${lidY + t / 2}`, 4.5)
      : "";
    return (
      `<clipPath id="${clip}"><ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}"/></clipPath>` +
      `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="${C.bone}"/>` +
      `<g clip-path="url(#${clip})">` +
      `<g class="noir-pupil" data-cx="${e.cx + dx}" data-cy="${e.cy + dy}" transform="translate(${e.cx + dx} ${e.cy + dy})">` +
      `<ellipse rx="${pr[0]}" ry="${pr[1]}" fill="${C.graphite}"/>` +
      (mood.small ? "" : `<path d="M0.5 -1L-1.5 -${pr[1] + 4}L${pr[0] + 5} -${pr[1] - 4}Z" fill="${C.bone}"/>`) +
      `</g>` + lid + `</g>` +
      `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" fill="none" stroke="${C.graphite}" stroke-width="4.5"/>`
    );
  }

  function face(moodName, id, mouth, blink) {
    const m = MOODS[moodName] ?? MOODS.grin;
    return (
      `<g class="bubs-eyes">${EYES.map((e, i) => eye(e, i, m, id)).join("")}</g>` +
      (blink ? `<g class="bubs-blink" aria-hidden="true">${EYES.map((e) => `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx + 1.5}" ry="${e.ry + 1.5}" fill="${C.body}" stroke="${C.graphite}" stroke-width="4.5" style="transform-origin:${e.cx}px ${e.cy - e.ry}px;transform:scaleY(0)"/>`).join("")}</g>` : "") +
      `<g class="bubs-brows">${m.brows.map((d) => S(d, 4.8)).join("")}</g>` +
      // The cartoon anger mark: four short veins bulging round a point on his temple.
      (m.vein ? `<g class="noir-vein">${S("M119 111Q128 115 127 121M141 111Q132 115 133 121M119 133Q128 129 127 123M141 133Q132 129 133 123", 3.6, C.oxblood)}</g>` : "") +
      `<g class="bubs-mouth">${MOUTHS[mouth ?? m.mouth]}</g>`
    );
  }

  function torso(id, mood, { mouth, blink = false, stroke = 5.5 } = {}) {
    return (
      `<clipPath id="${id}-b"><path class="noir-body" d="${BODY}"/></clipPath>` +
      `<path class="noir-body" d="${BODY}" fill="${C.body}"/>` +
      `<g clip-path="url(#${id}-b)">${F(SHADE, C.shade)}` +
      // What he holds inside: empty at rest, filled when the melt is drawn down into him.
      `<rect class="noir-tank" x="80" y="312" width="240" height="0" fill="${C.butter}"/>` +
      `<g class="noir-melt">${F(TOP, C.butter)}${S(TOP_EDGE, 3)}` +
      `<path d="M126 92Q138 84 152 84" fill="none" stroke="${C.bone}" stroke-width="5" stroke-linecap="round" opacity=".9"/></g></g>` +
      `<g class="bubs-face">${face(mood, id, mouth, blink)}</g>` +
      `<path class="noir-body" d="${BODY}" fill="none" stroke="${C.graphite}" stroke-width="${stroke}" stroke-linejoin="round"/>`
    );
  }

  // ---------- limbs ----------
  const LINE = (d, w = 6) => S(d, w);
  const GLOVE = (d, w = 3.6) => F(d, C.bone, w);

  // An open hand, raised in a slow wave: three fingers fanned, thumb out.
  function wave() {
    return (
      `<g class="noir-wave">` +
      GLOVE("M340 104C336 92 334 78 337 70C340 63 350 64 351 71C353 80 352 94 352 103Z") +
      GLOVE("M351 102C351 88 352 72 356 64C360 57 370 59 370 67C371 78 366 93 363 104Z") +
      GLOVE("M362 106C366 94 372 82 378 77C384 72 391 77 388 84C384 94 376 104 370 112Z") +
      GLOVE("M334 140C326 128 328 108 340 102C350 97 364 99 370 108C376 120 372 136 364 142C354 148 341 147 334 140Z") +
      GLOVE("M338 122C328 118 316 110 313 100C311 92 319 89 324 94C330 101 338 107 346 112Z") +
      S("M343 128Q350 131 357 128M344 136Q351 139 358 136", 2.6) +
      GLOVE("M334 142Q350 148 366 141C370 147 375 154 373 159C364 167 334 167 326 159C325 154 330 147 334 142Z") +
      S("M330 150Q350 156 370 149", 2.6) +
      `</g>`
    );
  }
  // A fist with the index finger out, pointing to his right (at the title card beside him).
  function point() {
    return (
      `<g class="noir-point">` +
      GLOVE("M370 184C382 181 394 180 399 182C405 185 404 193 398 194C388 196 378 196 372 196Z") +
      GLOVE("M346 184C352 177 368 176 375 183C381 190 380 206 373 212C364 218 350 217 345 210C340 202 341 190 346 184Z") +
      S("M352 200Q361 203 370 200M352 208Q360 211 368 208", 2.6) +
      GLOVE("M350 189C356 184 366 184 370 188C371 192 364 194 356 194C351 194 348 192 350 189Z") +
      GLOVE("M344 180Q338 197 344 214C338 219 330 221 326 218C320 208 320 188 326 178C330 175 338 176 344 180Z") +
      S("M337 182Q332 197 337 213", 2.6) +
      `</g>`
    );
  }
  // A hand on the hip, from its back: three stitch lines, knuckles curling onto the body.
  function hip() {
    return (
      GLOVE("M62 226C70 212 94 208 106 214C116 217 118 226 112 231C119 234 119 244 112 247C118 252 113 262 102 262C86 266 70 264 62 256C56 246 56 234 62 226Z") +
      S("M107 231Q103 232 99 230M106 247Q102 248 98 246", 2.6) +
      S("M74 229Q84 226 92 228M73 239Q84 237 93 239M74 249Q84 249 92 250", 2.6) +
      GLOVE("M63 222Q58 241 63 260C57 265 50 270 45 269C37 262 36 220 45 213C50 212 57 217 63 222Z") +
      S("M55 221Q50 241 55 261", 2.6)
    );
  }
  function shoe(flip) {
    const t = flip ? ` transform="translate(400 0) scale(-1 1)"` : "";
    return (
      `<g${t}>` + F("M170 400C188 400 194 432 176 440H110C78 440 72 400 106 393C128 388 148 401 160 399Z", C.graphite, 4) +
      S("M98 410Q108 400 124 400", 5, C.bone) + `</g>`
    );
  }

  // A pillbox cap, tilted, with a gold band and button; it sits on the melt.
  function cap(stroke = 4) {
    const side = "M-36 -30V-4A36 9 0 0 0 36 -4V-30Z";
    return (
      `<g class="bubs-cap-lift"><g class="bubs-cap" transform="translate(222 84) rotate(-9)">` +
      F(side, C.graphite) + F("M-36 -16A36 9 0 0 0 36 -16V-8A36 9 0 0 1 -36 -8Z", C.butter) +
      S(side, stroke) + `<ellipse cx="0" cy="-30" rx="36" ry="9" fill="${C.smoke}" stroke="${C.graphite}" stroke-width="${stroke}"/>` +
      `<circle cx="0" cy="-30" r="4.5" fill="${C.butter}" stroke="${C.graphite}" stroke-width="2"/>` + `</g></g>`
    );
  }
  // A bow tie where his bubble meets his legs.
  function tie() {
    return (
      `<g class="bubs-tie" transform="translate(203 271) scale(.92)">` +
      F("M0 0L-30 -13Q-37 0 -30 13Z", C.graphite, 3) + F("M0 0L30 -13Q37 0 30 13Z", C.graphite, 3) +
      S("M-21 -6Q-24 0 -22 6M21 -6Q24 0 22 6", 2, C.smoke) +
      `<rect x="-6.5" y="-7.5" width="13" height="15" rx="3" fill="${C.graphite}" stroke="${C.graphite}" stroke-width="2"/>` +
      S("M-2.5 -4V4", 1.6, C.smoke) + `</g>`
    );
  }

  /** Bubs standing: a mood (MOODS), an optional mouth frame, an arm pose ("wave" or "point"), and a floor shadow. */
  function full({ mood = "grin", mouth, shadow = true, id, blink = false, arm } = {}) {
    id = id ?? `noir${++uid}`;
    const pose = arm ?? MOODS[mood]?.arm ?? "wave";
    const rightArm = pose === "point"
      ? `<g class="bubs-arm-right">${LINE("M299 198C318 204 332 200 340 197")}<g transform="translate(332 197) scale(1.18) translate(-332 -197)">${point()}</g></g>`
      : `<g class="bubs-arm-right">${LINE("M299 198C346 200 358 180 352 160")}<g transform="translate(352 162) scale(1.22) translate(-350 -160)">${wave()}</g></g>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="24 30 380 422" role="img" aria-label="Bubs, the BttrSubs mascot">` +
      (shadow ? `<ellipse cx="204" cy="442" rx="122" ry="9" fill="${C.graphite}" opacity=".16" class="bubs-shadow"/>` : "") +
      `<g class="bubs-legs">${LINE("M180 262C182 318 156 346 162 402")}${LINE("M226 262C224 316 252 342 244 402")}${shoe(false)}<g transform="rotate(-10 236 438)">${shoe(true)}</g></g>` +
      `<g class="bubs-upper">` +
      `<g class="bubs-arm-left">${LINE("M102 186C36 178 30 244 70 240")}</g>` +
      rightArm +
      `<g class="bubs-body">${torso(id, mood, { mouth, blink })}</g>` +
      tie() + cap() + hip() +
      `</g></svg>`
    );
  }

  /** His head and cap alone, for the sidebar's mark. */
  function symbol({ size, title = "BttrSubs" } = {}) {
    const id = `noirs${++uid}`;
    const sz = size ? ` width="${size}" height="${size}"` : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="84 34 232 278"${sz} role="img" aria-label="${title}">` +
      `<clipPath id="${id}"><path d="${BODY}"/></clipPath>` + F(BODY, C.body) +
      `<g clip-path="url(#${id})">${F(SHADE, C.shade)}${F(TOP, C.butter)}${S(TOP_EDGE, 5)}</g>` +
      S("M136 196Q200 250 264 196", 14) + S("M124 184Q123 201 137 206M276 184Q277 201 263 206", 9) +
      `<path d="${BODY}" fill="none" stroke="${C.graphite}" stroke-width="10" stroke-linejoin="round"/>` + cap(8) + `</svg>`
    );
  }

  g.BubsNoir = { C, full, symbol, bodyPath, MOUTHS, MOODS, moods: Object.keys(MOODS) };
})(window);
