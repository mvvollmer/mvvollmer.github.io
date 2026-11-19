/* Interactive sky map: the sky over Massachusetts at 7:00 AM on 23 April 2002.
   Real star positions (J2000) converted to altitude/azimuth for the site and time,
   drawn with a stereographic projection. Opens on Taurus; as the visitor moves
   the mouse or drags around, whichever constellation is nearest the cursor lights up.
   Hover any constellation to play music. */
(function () {
  const root = document.getElementById("sky");
  if (!root || typeof SKY === "undefined") return;

  const canvas = root.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const tip = root.querySelector(".sky-tip");
  const hint = root.querySelector(".sky-hint");
  const timeInput = root.querySelector(".sky-time input");
  const timeLabel = root.querySelector(".sky-time output");
  const playBtn = root.querySelector(".sky-play");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const LAT = SKY.site.lat * D2R;
  const ACCENT = "20,157,221";

  const view = { az: 64, alt: 2, fov: 125 };
  let hours = 0, W = 0, H = 0, DPR = 1, scale = 1;
  let hoverCon = null, mouse = null, raf = 0;

  const stars = Object.entries(SKY.stars).map(([k, s]) => ({ key: k, ...s, phase: Math.random() * 6.28, speed: 0.6 + Math.random() * 1.4 }));
  const byKey = Object.fromEntries(stars.map((s) => [s.key, s]));
  const cons = SKY.constellations;
  const conByName = Object.fromEntries(cons.map((c) => [c.name, c]));
  for (const c of cons) c.keys = [...new Set(c.lines.flat())];
  let focus = conByName.Taurus;            // constellation nearest the cursor
  for (const c of cons) c.level = c === focus ? 1 : 0;   // eased highlight amount, 0..1

  // ---------- astronomy ----------
  function lstHours() {
    const jd = (SKY.site.utc + hours * 3600000) / 86400000 + 2440587.5;
    const gmst = 18.697374558 + 24.06570982441908 * (jd - 2451545.0);
    return (((gmst + SKY.site.lon / 15) % 24) + 24) % 24;
  }
  function toHorizon(ra, dec, lst) {
    const h = (lst - ra) * 15 * D2R, d = dec * D2R;
    const alt = Math.asin(Math.sin(LAT) * Math.sin(d) + Math.cos(LAT) * Math.cos(d) * Math.cos(h));
    const az = Math.atan2(-Math.cos(d) * Math.sin(h), Math.sin(d) * Math.cos(LAT) - Math.cos(d) * Math.sin(LAT) * Math.cos(h));
    return { alt, az };
  }
  // ---------- projection ----------
  function basis() {
    const a = view.az * D2R, e = view.alt * D2R;
    const c = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
    const r = [Math.cos(a), -Math.sin(a), 0];
    const u = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
    return { c, r, u };
  }
  function project(alt, az, B) {
    const v = [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
    const dz = v[0] * B.c[0] + v[1] * B.c[1] + v[2] * B.c[2];
    if (dz < -0.35) return null;
    const k = 2 / (1 + dz);
    const dx = v[0] * B.r[0] + v[1] * B.r[1] + v[2] * B.r[2];
    const dy = v[0] * B.u[0] + v[1] * B.u[1] + v[2] * B.u[2];
    return { x: W / 2 + k * dx * scale, y: H / 2 - k * dy * scale };
  }

  function resize() {
    const rect = root.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width; H = rect.height;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    view.fov = W < 520 ? 100 : 125;
    scale = (W / 2) / (2 * Math.tan((view.fov * D2R) / 4));
    redraw();
  }

  // ---------- drawing ----------
  // blend from the resting style to the accent highlight as con.level goes 0 -> 1
  function mix(a, b, k) { return a + (b - a) * k; }
  function conStyle(con) {
    const k = con === hoverCon ? 1 : con.level;
    const base = con.zodiac ? [120, 190, 230, 0.42, 1.1] : [168, 169, 180, 0.22, 0.85];
    const r = Math.round(mix(base[0], 20, k)), g = Math.round(mix(base[1], 157, k)), b = Math.round(mix(base[2], 221, k));
    return { w: mix(base[4], con === hoverCon ? 2.3 : 1.8, k), col: `rgba(${r},${g},${b},${mix(base[3], 1, k)})`, glow: k * (con === hoverCon ? 14 : 8) };
  }
  // pick the constellation nearest the cursor (distance to its figure's lines)
  function updateFocus() {
    if (mouse) {
      let best = null, bd = Math.min(W, H) * 0.22;
      for (const c of cons) for (const [a, b] of c.lines) {
        const pa = byKey[a].p, pb = byKey[b].p;
        if (!pa || !pb) continue;
        const d = segDist(mouse, pa, pb) - (c.zodiac ? 6 : 0);   // star signs win close calls
        if (d < bd) { bd = d; best = c; }
      }
      if (best) focus = best;             // the last one stays lit until the cursor nears another
    }
    for (const c of cons) {
      const target = c === focus ? 1 : 0;
      c.level = reduceMotion ? target : c.level + (target - c.level) * 0.12;
    }
  }
  function label(txt, x, y, color, size, bold) {
    ctx.font = `${bold ? "700 " : ""}${size}px Poppins, system-ui, sans-serif`;
    ctx.fillStyle = color; ctx.fillText(txt, x, y);
  }

  function draw(now) {
    const t = now / 1000, lst = lstHours(), B = basis();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#040b14"); g.addColorStop(0.65, "#0a1a2c"); g.addColorStop(1, "#10263c");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    for (const s of stars) { const h = toHorizon(s.ra, s.dec, lst); s.alt = h.alt; s.p = project(h.alt, h.az, B); }
    updateFocus();

    // altitude rings
    ctx.lineWidth = 1; ctx.setLineDash([2, 6]); ctx.strokeStyle = "rgba(168,169,180,0.07)";
    for (const altDeg of [30, 60]) {
      ctx.beginPath(); let first = true;
      for (let a = 0; a <= 360; a += 3) {
        const p = project(altDeg * D2R, a * D2R, B);
        if (!p) { first = true; continue; }
        first ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); first = false;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // constellation figures (highlighted ones last, so they sit on top)
    const order = cons.filter((c) => c !== focus && c !== hoverCon).concat([focus, hoverCon].filter(Boolean));
    for (const con of order) {
      const st = conStyle(con);
      ctx.lineWidth = st.w; ctx.strokeStyle = st.col;
      if (st.glow) { ctx.shadowColor = `rgba(${ACCENT},0.9)`; ctx.shadowBlur = st.glow; }
      ctx.beginPath();
      for (const [a, b] of con.lines) {
        const pa = byKey[a].p, pb = byKey[b].p;
        if (pa && pb) { ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); }
      }
      ctx.stroke(); ctx.shadowBlur = 0;
    }

    // the Sun
    const sh = toHorizon(SKY.sun.ra, SKY.sun.dec, lst), sp = project(sh.alt, sh.az, B);
    if (sp) {
      const rg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, 42);
      rg.addColorStop(0, "rgba(255,214,120,0.95)"); rg.addColorStop(0.18, "rgba(255,190,90,0.6)"); rg.addColorStop(1, "rgba(255,170,60,0)");
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(sp.x, sp.y, 42, 0, 6.283); ctx.fill();
      label("Sun", sp.x + 14, sp.y - 12, "rgba(255,214,140,0.9)", 12);
    }

    // stars
    const lit = new Set([...(focus && focus.level > 0.5 ? focus.keys : []), ...(hoverCon ? hoverCon.keys : [])]);
    for (const s of stars) {
      if (!s.p) continue;
      const isLit = lit.has(s.key);
      let r = Math.max(0.7, 3.4 - 0.6 * s.m), alpha = Math.min(1, 1.15 - s.m * 0.13);
      if (!reduceMotion) alpha *= 0.82 + 0.18 * Math.sin(t * s.speed + s.phase);
      if (hoverCon && hoverCon.keys.includes(s.key)) r *= 1.25;
      ctx.fillStyle = isLit ? `rgba(215,238,255,${alpha})` : `rgba(255,255,255,${alpha})`;
      if (isLit || s.m < 1) { ctx.shadowColor = isLit ? `rgba(${ACCENT},1)` : "rgba(255,255,255,0.8)"; ctx.shadowBlur = isLit ? 10 : 6; }
      ctx.beginPath(); ctx.arc(s.p.x, s.p.y, r, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
    }

    // translucent ground: stars below the horizon stay visible, dimmed
    ctx.beginPath(); let started = false;
    for (let a = view.az - 120; a <= view.az + 120; a += 2) {
      const p = project(0, a * D2R, B); if (!p) continue;
      started ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); started = true;
    }
    if (started) {
      ctx.lineTo(W + 50, H + 50); ctx.lineTo(-50, H + 50); ctx.closePath();
      const gg = ctx.createLinearGradient(0, H * 0.5, 0, H);
      gg.addColorStop(0, "rgba(3,8,14,0.55)"); gg.addColorStop(1, "rgba(3,8,14,0.8)");
      ctx.fillStyle = gg; ctx.fill();
      ctx.strokeStyle = "rgba(168,169,180,0.45)"; ctx.lineWidth = 1; ctx.stroke();
    }
    for (const [txt, a] of [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]]) {
      const p = project(0, a * D2R, B);
      if (p && p.x > 10 && p.x < W - 10 && p.y > 0 && p.y < H - 4) label(txt, p.x - 6, p.y + 16, "rgba(168,169,180,0.75)", 11);
    }

    // names
    for (const con of cons) {
      const s = byKey[con.label]; if (!s.p) continue;
      const k = con === hoverCon ? 1 : con.level;
      if (k > 0.5) label(con.name.toUpperCase() + (con === hoverCon ? "  ♪" : ""), s.p.x + 12, s.p.y + 22, `rgba(${ACCENT},${k})`, 13, true);
      else if (con.zodiac) label(con.name, s.p.x + 10, s.p.y + 20, "rgba(150,200,235,0.6)", 11);
      else label(con.name, s.p.x + 8, s.p.y - 8, "rgba(168,169,180,0.42)", 10);
    }
  }
  const redraw = () => draw(performance.now());

  // ---------- hit testing ----------
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    let t = L ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function hitTest(p) {
    let con = null, best = 15;
    for (const c of cons) for (const [a, b] of c.lines) {
      const pa = byKey[a].p, pb = byKey[b].p;
      if (!pa || !pb) continue;
      let d = segDist(p, pa, pb); if (c.zodiac) d -= 3;          // zodiac figures win close calls
      if (d < best) { best = d; con = c; }
    }
    const pl = byKey.alcyone.p;
    if (pl && Math.hypot(p.x - pl.x, p.y - pl.y) < 22) con = conByName.Taurus;
    let star = null, bd = 11;
    for (const s of stars) {
      if (!s.p) continue;
      const d = Math.hypot(p.x - s.p.x, p.y - s.p.y);
      if (d < bd) { bd = d; star = s; }
    }
    if (!con && star) con = cons.find((c) => c.keys.includes(star.key)) || null;
    return { con, star };
  }
  function showTip(s, p) {
    if (!s) { tip.hidden = true; return; }
    tip.textContent = `${s.n} · ${s.c} · mag ${s.m.toFixed(1)}${s.alt < 0 ? " · below the horizon" : ""}`;
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(p.x + 14, W - tip.offsetWidth - 8)) + "px";
    tip.style.top = Math.max(p.y - 34, 8) + "px";
  }

  // ---------- music (shared site player) ----------
  let musicOn = false;
  function music(on) {
    if (on === musicOn || !window.SiteMusic) return;
    musicOn = on;
    if (on) SiteMusic.hoverStart().then((ok) => { hint.hidden = ok; if (!ok) hint.textContent = "Click once to let the stars play music"; });
    else SiteMusic.hoverEnd();
  }
  function setHover(con) {
    if (con !== hoverCon) { hoverCon = con; root.classList.toggle("is-hover", !!con); if (reduceMotion) redraw(); }
    music(!!con);
  }

  // ---------- pointer ----------
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, az: view.az, alt: view.alt, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      const k = view.fov / W;
      view.az = (drag.az - dx * k + 360) % 360;
      view.alt = Math.max(-60, Math.min(85, drag.alt + dy * k));
      tip.hidden = true;
      if (reduceMotion) redraw();
      return;
    }
    const h = hitTest(mouse);
    if (e.pointerType === "mouse") setHover(h.con);
    showTip(h.star, mouse);
    canvas.style.cursor = h.con || h.star ? "pointer" : "grab";
  });
  canvas.addEventListener("pointerup", (e) => {
    const wasClick = drag && !drag.moved; drag = null;
    if (!wasClick || !mouse) return;
    const h = hitTest(mouse);
    if (e.pointerType !== "mouse") { setHover(h.con && h.con !== hoverCon ? h.con : null); showTip(h.star, mouse); }
    else if (h.con && window.SiteMusic) { musicOn = false; music(true); }   // a click unlocks audio in strict browsers
  });
  canvas.addEventListener("pointerleave", () => { if (!drag) { setHover(null); showTip(null); } });

  // ---------- time ----------
  function fmtTime() {
    const mins = Math.round((7 + hours) * 60);
    const h = Math.floor((((mins / 60) % 24) + 24) % 24), m = ((mins % 60) + 60) % 60;
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  }
  function setHours(v) { hours = v; timeInput.value = v; timeLabel.textContent = fmtTime(); if (reduceMotion) redraw(); }
  timeInput.addEventListener("input", () => setHours(parseFloat(timeInput.value)));
  let anim = null;
  playBtn.addEventListener("click", () => {
    if (anim) { cancelAnimationFrame(anim); anim = null; playBtn.innerHTML = '<i class="fa-solid fa-play"></i>'; return; }
    playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    let last = performance.now();
    const step = (now) => {
      let v = hours + ((now - last) / 1000) * 0.6; last = now;
      if (v > 6) v = -6;
      setHours(v); anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  });
  root.querySelector(".sky-reset").addEventListener("click", () => {
    setHours(0); view.az = 64; view.alt = 2; redraw();
  });

  // ---------- loop ----------
  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) loop(); }).observe(root);
  function loop() {
    cancelAnimationFrame(raf);
    if (!visible || reduceMotion) return;
    raf = requestAnimationFrame((now) => { draw(now); loop(); });
  }
  new ResizeObserver(resize).observe(root);
  setHours(0); resize(); loop();
})();
