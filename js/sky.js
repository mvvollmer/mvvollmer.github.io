/* Interactive sky map. Opens on the sky over Massachusetts at 7:00 AM on 23 April 2002,
   with Taurus highlighted. Visitors can drag around, hover constellations to play music,
   and pick any date, time, and place.

   Data: named stars and constellation figures in sky-data.js; background stars (to mag 7),
   Messier objects, and the Milky Way outline from compact local copies of the open
   d3-celestial catalogues in data/sky/. Sun and Moon positions are computed for the chosen moment. */
(function () {
  const root = document.getElementById("sky");
  if (!root || typeof SKY === "undefined") return;

  const $ = (sel) => root.querySelector(sel);
  const canvas = $("canvas"), ctx = canvas.getContext("2d");
  const tip = $(".sky-tip"), hint = $(".sky-hint"), title = $(".sky-title-text");
  const timeInput = $(".sky-time input"), timeLabel = $(".sky-time output");
  const panel = $(".sky-panel"), whenBtn = $(".sky-when");
  const dateField = $(".sky-date"), clockField = $(".sky-clock"), placeField = $(".sky-place");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const ACCENT = "20,157,221";
  const DATA = "data/sky/", VERSION = "202611251326";   // VERSION is updated by bump-version.sh

  // ---------- places (real coordinates and IANA time zones; DST handled by the browser) ----------
  const PLACES = [
    ["Worcester, MA", "Massachusetts", 42.2626, -71.8023, "America/New_York"],
    ["Boston, MA", "Massachusetts", 42.3601, -71.0589, "America/New_York"],
    ["New York, NY", "New York", 40.7128, -74.006, "America/New_York"],
    ["Orlando, FL", "Florida", 28.5384, -81.3789, "America/New_York"],
    ["Miami, FL", "Florida", 25.7617, -80.1918, "America/New_York"],
    ["Chicago, IL", "Illinois", 41.8781, -87.6298, "America/Chicago"],
    ["Denver, CO", "Colorado", 39.7392, -104.9903, "America/Denver"],
    ["Los Angeles, CA", "California", 34.0522, -118.2437, "America/Los_Angeles"],
    ["San Francisco, CA", "California", 37.7749, -122.4194, "America/Los_Angeles"],
    ["Seattle, WA", "Washington", 47.6062, -122.3321, "America/Los_Angeles"],
    ["Anchorage, AK", "Alaska", 61.2181, -149.9003, "America/Anchorage"],
    ["Honolulu, HI", "Hawaii", 21.3069, -157.8583, "Pacific/Honolulu"],
    ["Toronto", "Ontario", 43.6532, -79.3832, "America/Toronto"],
    ["Mexico City", "Mexico", 19.4326, -99.1332, "America/Mexico_City"],
    ["Panama City", "Panama", 8.9824, -79.5199, "America/Panama"],
    ["Kralendijk", "Bonaire", 12.1443, -68.2655, "America/Kralendijk"],
    ["São Paulo", "Brazil", -23.5505, -46.6333, "America/Sao_Paulo"],
    ["Buenos Aires", "Argentina", -34.6037, -58.3816, "America/Argentina/Buenos_Aires"],
    ["Reykjavík", "Iceland", 64.1466, -21.9426, "Atlantic/Reykjavik"],
    ["Dublin", "Ireland", 53.3498, -6.2603, "Europe/Dublin"],
    ["London", "England", 51.5074, -0.1278, "Europe/London"],
    ["Paris", "France", 48.8566, 2.3522, "Europe/Paris"],
    ["Madrid", "Spain", 40.4168, -3.7038, "Europe/Madrid"],
    ["Milan", "Italy", 45.4642, 9.19, "Europe/Rome"],
    ["Rome", "Italy", 41.9028, 12.4964, "Europe/Rome"],
    ["Berlin", "Germany", 52.52, 13.405, "Europe/Berlin"],
    ["Copenhagen", "Denmark", 55.6761, 12.5683, "Europe/Copenhagen"],
    ["Athens", "Greece", 37.9838, 23.7275, "Europe/Athens"],
    ["Cairo", "Egypt", 30.0444, 31.2357, "Africa/Cairo"],
    ["Nairobi", "Kenya", -1.2921, 36.8219, "Africa/Nairobi"],
    ["Cape Town", "South Africa", -33.9249, 18.4241, "Africa/Johannesburg"],
    ["Dubai", "UAE", 25.2048, 55.2708, "Asia/Dubai"],
    ["Mumbai", "India", 19.076, 72.8777, "Asia/Kolkata"],
    ["Bangkok", "Thailand", 13.7563, 100.5018, "Asia/Bangkok"],
    ["Singapore", "Singapore", 1.3521, 103.8198, "Asia/Singapore"],
    ["Beijing", "China", 39.9042, 116.4074, "Asia/Shanghai"],
    ["Seoul", "South Korea", 37.5665, 126.978, "Asia/Seoul"],
    ["Tokyo", "Japan", 35.6762, 139.6503, "Asia/Tokyo"],
    ["Sydney", "Australia", -33.8688, 151.2093, "Australia/Sydney"],
    ["Auckland", "New Zealand", -36.8485, 174.7633, "Pacific/Auckland"],
  ].map(([name, region, lat, lon, tz]) => ({ name, region, lat, lon, tz }));

  const BIRTH = { date: "2002-04-23", time: "07:00", place: PLACES[0] };
  // utc0 is local midnight of the chosen date; hours is the time of day on the slider (0 to 24)
  const state = { date: BIRTH.date, time: BIRTH.time, place: BIRTH.place, utc0: 0, hours: 7 };
  const toHours = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h + m / 60; };

  // local wall-clock time in a time zone -> UTC milliseconds
  function tzOffsetMs(utcMs, tz) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(utcMs)).reduce((o, p) => (o[p.type] = p.value, o), {});
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) - utcMs;
  }
  function zonedToUtc(dateStr, timeStr, tz) {
    const [y, m, d] = dateStr.split("-").map(Number), [hh, mm] = timeStr.split(":").map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    let utc = guess - tzOffsetMs(guess, tz);
    utc = guess - tzOffsetMs(utc, tz);
    return utc;
  }

  // ---------- view and objects ----------
  const view = { az: 64, alt: 2, fov: 125 };
  let W = 0, H = 0, DPR = 1, scale = 1, LAT = 0;
  let hoverCon = null, hoverObj = null, mouse = null, raf = 0;

  const named = Object.entries(SKY.stars).map(([k, s]) => prep({ key: k, ...s, phase: Math.random() * 6.28, speed: 0.6 + Math.random() * 1.4 }));
  const byKey = Object.fromEntries(named.map((s) => [s.key, s]));
  const cons = SKY.constellations;
  for (const c of cons) c.keys = [...new Set(c.lines.flat())];
  let focus = cons.find((c) => c.name === "Taurus");
  for (const c of cons) c.level = c === focus ? 1 : 0;

  let bg = [], dsos = [], mw = [];   // filled once the catalogues load
  let bgBright = [], bgBuckets = [];   // bright stars twinkle individually; faint ones draw in batches
  const mwCanvas = document.createElement("canvas"), mwCtx = mwCanvas.getContext("2d");
  const mwBlur = document.createElement("canvas"), mwBlurCtx = mwBlur.getContext("2d");
  let mwKey = "";
  const sun = prep({ ra: 0, dec: 0 }), moon = prep({ ra: 0, dec: 0 });

  function prep(o) {
    const d = o.dec * D2R;
    o.sd = Math.sin(d); o.cd = Math.cos(d); o.raRad = o.ra * 15 * D2R;
    return o;
  }

  // ---------- astronomy ----------
  const utcNow = () => state.utc0 + state.hours * 3600000;
  function lstRad() {
    const jd = utcNow() / 86400000 + 2440587.5;
    const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0);
    return (((gmst + state.place.lon) % 360) + 360) % 360 * D2R;
  }
  // unit vector (ve = east, vn = north, vu = up) for an object at the current sidereal time;
  // named "v*" so they never collide with catalogue fields such as a star's name (n)
  function horizon(o, lst, sl, cl) {
    const h = lst - o.raRad, ch = Math.cos(h);
    o.ve = -o.cd * Math.sin(h);
    o.vn = o.sd * cl - o.cd * sl * ch;
    o.vu = sl * o.sd + cl * o.cd * ch;
  }
  // low-precision Sun and Moon (accurate to a fraction of a degree, plenty for a sky map)
  function sunMoon() {
    const n = utcNow() / 86400000 + 2440587.5 - 2451545.0;
    const eps = (23.439 - 0.0000004 * n) * D2R;
    const g = (357.528 + 0.9856003 * n) * D2R;
    const lamS = (280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
    setEq(sun, lamS, 0, eps);
    const Lm = (218.316 + 13.176396 * n) * D2R, Mm = (134.963 + 13.064993 * n) * D2R, F = (93.272 + 13.22935 * n) * D2R;
    const lamM = Lm + 6.289 * D2R * Math.sin(Mm), betM = 5.128 * D2R * Math.sin(F);
    setEq(moon, lamM, betM, eps);
    moon.illum = (1 - Math.cos(lamM - lamS) * Math.cos(betM)) / 2;   // fraction lit
  }
  function setEq(o, lam, bet, eps) {
    const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
    const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
    o.raRad = ra; o.sd = Math.sin(dec); o.cd = Math.cos(dec);
  }

  let lastKey = "";
  function updatePositions() {
    const key = utcNow() + "|" + state.place.lat + "|" + state.place.lon + "|" + bg.length + "|" + mw.length;
    if (key === lastKey) return;
    lastKey = key;
    LAT = state.place.lat * D2R;
    const lst = lstRad(), sl = Math.sin(LAT), cl = Math.cos(LAT);
    sunMoon();
    for (const o of named) horizon(o, lst, sl, cl);
    for (const o of bg) horizon(o, lst, sl, cl);
    for (const o of dsos) horizon(o, lst, sl, cl);
    horizon(sun, lst, sl, cl); horizon(moon, lst, sl, cl);
    for (const layer of mw) for (const ring of layer.rings) for (const o of ring) horizon(o, lst, sl, cl);
  }

  // ---------- projection ----------
  let B = null;
  function basis() {
    const a = view.az * D2R, e = view.alt * D2R;
    const c = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
    const r = [Math.cos(a), -Math.sin(a), 0];
    const u = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
    B = { c, r, u };
  }
  function proj(o, limit = -0.35) {
    const dz = o.ve * B.c[0] + o.vn * B.c[1] + o.vu * B.c[2];
    if (dz < limit) return null;
    const k = 2 / (1 + dz) * scale;
    return { x: W / 2 + k * (o.ve * B.r[0] + o.vn * B.r[1] + o.vu * B.r[2]), y: H / 2 - k * (o.ve * B.u[0] + o.vn * B.u[1] + o.vu * B.u[2]) };
  }
  const projAltAz = (alt, az) => proj({ ve: Math.cos(alt) * Math.sin(az), vn: Math.cos(alt) * Math.cos(az), vu: Math.sin(alt) });

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

  // ---------- drawing helpers ----------
  const mix = (a, b, k) => a + (b - a) * k;
  function label(txt, x, y, color, size, bold) {
    ctx.font = `${bold ? "700 " : ""}${size}px Poppins, system-ui, sans-serif`;
    ctx.fillStyle = color; ctx.fillText(txt, x, y);
  }
  function bvColor(bv) {
    if (isNaN(bv)) return "255,255,255";
    if (bv < 0) return "170,195,255";
    if (bv < 0.4) return "215,228,255";
    if (bv < 0.8) return "255,248,235";
    if (bv < 1.3) return "255,226,190";
    return "255,200,150";
  }
  function conStyle(con) {
    const k = con === hoverCon ? 1 : con.level;
    const base = con.zodiac ? [120, 190, 230, 0.42, 1.1] : [168, 169, 180, 0.22, 0.85];
    return {
      w: mix(base[4], con === hoverCon ? 2.3 : 1.8, k),
      col: `rgba(${Math.round(mix(base[0], 20, k))},${Math.round(mix(base[1], 157, k))},${Math.round(mix(base[2], 221, k))},${mix(base[3], 1, k)})`,
      glow: k * (con === hoverCon ? 14 : 8),
    };
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    let t = L ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  // constellation nearest the cursor lights up; the last one stays lit until another is nearer
  function updateFocus() {
    if (mouse) {
      let best = null, bd = Math.min(W, H) * 0.22;
      for (const c of cons) for (const [a, b] of c.lines) {
        const pa = byKey[a].p, pb = byKey[b].p;
        if (!pa || !pb) continue;
        const d = segDist(mouse, pa, pb) - (c.zodiac ? 6 : 0);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) focus = best;
    }
    for (const c of cons) {
      const target = c === focus ? 1 : 0;
      c.level = reduceMotion ? target : c.level + (target - c.level) * 0.12;
    }
  }

  const DSO_LOOK = {
    galaxy: { col: "255,236,210", a: 0.5 }, nebula: { col: "255,140,180", a: 0.45 }, planetary: { col: "120,230,220", a: 0.6 },
    remnant: { col: "255,170,140", a: 0.45 }, globular: { col: "255,240,200", a: 0.55 }, open: { col: "190,215,255", a: 0.35 },
  };
  function dsoKind(t) {
    if (t === "s" || t === "e" || t === "i" || t === "g") return "galaxy";
    if (t === "pn") return "planetary";
    if (t === "snr") return "remnant";
    if (t === "gc") return "globular";
    if (t === "oc" || t === "pos") return "open";
    return "nebula";
  }

  // ---------- main draw ----------
  function draw(now) {
    const t = now / 1000;
    updatePositions(); basis();

    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#030810"); g.addColorStop(0.65, "#081627"); g.addColorStop(1, "#0f2439");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // Milky Way: five nested brightness levels, rendered small and blurred into a cached layer
    if (mw.length) {
      const key = lastKey + "|" + view.az.toFixed(2) + "|" + view.alt.toFixed(2) + "|" + W + "x" + H;
      if (key !== mwKey) {
        mwKey = key;
        const f = 0.25;
        mwCanvas.width = Math.max(1, Math.round(W * f)); mwCanvas.height = Math.max(1, Math.round(H * f));
        mwCtx.setTransform(f, 0, 0, f, 0, 0);
        mwCtx.clearRect(0, 0, W, H);
        for (const layer of mw) {
          mwCtx.fillStyle = `rgba(190,205,255,${layer.alpha})`;
          mwCtx.beginPath();
          for (const ring of layer.rings) {
            let started = false;
            for (const o of ring) {
              const p = proj(o, -0.9);
              if (!p) { started = false; continue; }
              started ? mwCtx.lineTo(p.x, p.y) : mwCtx.moveTo(p.x, p.y); started = true;
            }
            mwCtx.closePath();
          }
          mwCtx.fill("evenodd");
        }
        // blur once per view change, at quarter resolution (about 10px on screen)
        mwBlur.width = mwCanvas.width; mwBlur.height = mwCanvas.height;
        mwBlurCtx.filter = "blur(2.5px)";
        mwBlurCtx.drawImage(mwCanvas, 0, 0);
      }
      ctx.drawImage(mwBlur, 0, 0, W, H);
    }

    // galaxies, nebulae, clusters
    const pxPerRad = scale;
    for (const o of dsos) {
      const p = proj(o); o.p = p; if (!p) continue;
      const look = DSO_LOOK[o.kind];
      const rx = Math.max(3, o.dimA / 60 * D2R * pxPerRad * 1.6), ry = Math.max(2.2, o.dimB / 60 * D2R * pxPerRad * 1.6);
      o.r = rx;
      const hov = o === hoverObj;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(o.rot); ctx.scale(1, ry / rx);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      rg.addColorStop(0, `rgba(${look.col},${look.a * (hov ? 1.6 : 1)})`); rg.addColorStop(1, `rgba(${look.col},0)`);
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 6.283); ctx.fill();
      ctx.restore();
      if (o.kind === "open" || o.kind === "globular") {
        ctx.fillStyle = `rgba(${look.col},0.7)`; ctx.beginPath(); ctx.arc(p.x, p.y, 0.9, 0, 6.283); ctx.fill();
      }
    }

    // background stars: faint ones batched by colour and brightness, bright ones twinkle
    for (const b of bgBuckets) {
      ctx.fillStyle = b.style; ctx.beginPath();
      for (const s of b.stars) { const p = proj(s); if (p) ctx.rect(p.x - s.r, p.y - s.r, s.r * 2, s.r * 2); }
      ctx.fill();
    }
    for (const s of bgBright) {
      const p = proj(s); if (!p) continue;
      let a = s.a;
      if (!reduceMotion) a *= 0.8 + 0.2 * Math.sin(t * s.speed + s.phase);
      ctx.fillStyle = `rgba(${s.col},${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, s.r, 0, 6.283); ctx.fill();
    }

    // named stars' positions, then constellation figures
    for (const s of named) { s.p = proj(s); s.alt = Math.asin(Math.max(-1, Math.min(1, s.vu))); }
    updateFocus();
    ctx.lineWidth = 1; ctx.setLineDash([2, 6]); ctx.strokeStyle = "rgba(168,169,180,0.07)";
    for (const altDeg of [30, 60]) {
      ctx.beginPath(); let first = true;
      for (let a = 0; a <= 360; a += 3) {
        const p = projAltAz(altDeg * D2R, a * D2R);
        if (!p) { first = true; continue; }
        first ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); first = false;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
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

    // named stars on top
    const lit = new Set([...(focus && focus.level > 0.5 ? focus.keys : []), ...(hoverCon ? hoverCon.keys : [])]);
    for (const s of named) {
      if (!s.p) continue;
      const isLit = lit.has(s.key);
      let r = Math.max(0.8, 3.4 - 0.6 * s.m), alpha = Math.min(1, 1.15 - s.m * 0.13);
      if (!reduceMotion) alpha *= 0.82 + 0.18 * Math.sin(t * s.speed + s.phase);
      if (hoverCon && hoverCon.keys.includes(s.key)) r *= 1.25;
      ctx.fillStyle = isLit ? `rgba(215,238,255,${alpha})` : `rgba(255,255,255,${alpha})`;
      if (isLit || s.m < 1) { ctx.shadowColor = isLit ? `rgba(${ACCENT},1)` : "rgba(255,255,255,0.8)"; ctx.shadowBlur = isLit ? 10 : 6; }
      ctx.beginPath(); ctx.arc(s.p.x, s.p.y, r, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;
    }

    // Moon (with phase) and Sun
    const mp = proj(moon), sp = proj(sun), spLoose = proj(sun, -0.95);
    if (mp) {
      const R = 8;
      ctx.save(); ctx.beginPath(); ctx.arc(mp.x, mp.y, R, 0, 6.283); ctx.clip();
      ctx.fillStyle = "rgba(60,66,78,0.9)"; ctx.fillRect(mp.x - R, mp.y - R, 2 * R, 2 * R);
      let dx = 1, dy = 0;
      if (spLoose) { dx = spLoose.x - mp.x; dy = spLoose.y - mp.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L; }
      ctx.fillStyle = "rgba(240,236,220,0.95)";
      ctx.beginPath(); ctx.arc(mp.x, mp.y, R, 0, 6.283); ctx.fill();
      ctx.fillStyle = "rgba(40,46,58,0.92)";
      const off = 2 * R * moon.illum;
      ctx.beginPath(); ctx.arc(mp.x - dx * off, mp.y - dy * off, R, 0, 6.283); ctx.fill();
      ctx.restore();
      label("Moon", mp.x + 12, mp.y - 10, "rgba(230,230,220,0.8)", 11);
      moon.p = mp;
    } else moon.p = null;
    if (sp) {
      const rg = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, 42);
      rg.addColorStop(0, "rgba(255,214,120,0.95)"); rg.addColorStop(0.18, "rgba(255,190,90,0.6)"); rg.addColorStop(1, "rgba(255,170,60,0)");
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(sp.x, sp.y, 42, 0, 6.283); ctx.fill();
      label("Sun", sp.x + 14, sp.y - 12, "rgba(255,214,140,0.9)", 12);
    }

    // translucent ground: everything below the horizon stays visible, dimmed
    ctx.beginPath(); let started = false;
    for (let a = view.az - 120; a <= view.az + 120; a += 2) {
      const p = projAltAz(0, a * D2R); if (!p) continue;
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
      const p = projAltAz(0, a * D2R);
      if (p && p.x > 10 && p.x < W - 10 && p.y > 0 && p.y < H - 4) label(txt, p.x - 6, p.y + 16, "rgba(168,169,180,0.75)", 11);
    }

    // constellation names
    for (const con of cons) {
      const s = byKey[con.label]; if (!s.p) continue;
      const k = con === hoverCon ? 1 : con.level;
      if (k > 0.5) label(con.name.toUpperCase() + (con === hoverCon ? "  ♪" : ""), s.p.x + 12, s.p.y + 22, `rgba(${ACCENT},${k})`, 13, true);
      else if (con.zodiac) label(con.name, s.p.x + 10, s.p.y + 20, "rgba(150,200,235,0.6)", 11);
      else label(con.name, s.p.x + 8, s.p.y - 8, "rgba(168,169,180,0.42)", 10);
    }
  }
  const redraw = () => draw(performance.now());

  // ---------- hit testing and tooltips ----------
  function hitTest(p) {
    let con = null, best = 15;
    for (const c of cons) for (const [a, b] of c.lines) {
      const pa = byKey[a].p, pb = byKey[b].p;
      if (!pa || !pb) continue;
      let d = segDist(p, pa, pb); if (c.zodiac) d -= 3;
      if (d < best) { best = d; con = c; }
    }
    const pl = byKey.alcyone.p;
    if (pl && Math.hypot(p.x - pl.x, p.y - pl.y) < 22) con = cons.find((c) => c.name === "Taurus");
    let obj = null, bd = 11;
    for (const s of named) {
      if (!s.p) continue;
      const d = Math.hypot(p.x - s.p.x, p.y - s.p.y);
      if (d < bd) { bd = d; obj = s; }
    }
    if (!obj) for (const o of dsos) {
      if (!o.p) continue;
      const d = Math.hypot(p.x - o.p.x, p.y - o.p.y);
      if (d < Math.max(10, Math.min(o.r, 40))) { obj = o; break; }
    }
    if (!obj && moon.p && Math.hypot(p.x - moon.p.x, p.y - moon.p.y) < 12) obj = { tipText: `Moon · ${Math.round(moon.illum * 100)}% lit` };
    if (!con && obj && obj.c) con = cons.find((c) => c.keys.includes(obj.key)) || null;
    return { con, obj };
  }
  function showTip(o, p) {
    if (!o) { tip.hidden = true; return; }
    tip.textContent = o.tipText || `${o.n} · ${o.c} · mag ${o.m.toFixed(1)}${o.alt < 0 ? " · below the horizon" : ""}`;
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(p.x + 14, W - tip.offsetWidth - 8)) + "px";
    tip.style.top = Math.max(p.y - 34, 8) + "px";
  }

  // ---------- music (shared site player) ----------
  let musicOn = false;
  function music(on) {
    if (on === musicOn || !window.SiteMusic) return;
    musicOn = on;
    if (on) SiteMusic.hoverStart().then((ok) => { hint.hidden = ok; if (!ok) hint.textContent = "Click once on the stars to play music"; });
    else SiteMusic.hoverEnd();
  }
  function setHover(con) {
    if (con !== hoverCon) { hoverCon = con; root.classList.toggle("is-hover", !!con); }
    music(!!con);
  }

  // ---------- pointer ----------
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, az: view.az, alt: view.alt, moved: false };
    canvas.setPointerCapture(e.pointerId);
    panel.hidden = true; whenBtn.setAttribute("aria-expanded", "false");
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
    hoverObj = h.obj && h.obj.kind ? h.obj : null;
    showTip(h.obj, mouse);
    canvas.style.cursor = h.con || h.obj ? "pointer" : "grab";
    if (reduceMotion) redraw();
  });
  canvas.addEventListener("pointerup", (e) => {
    const wasClick = drag && !drag.moved; drag = null;
    if (!wasClick || !mouse) return;
    const h = hitTest(mouse);
    if (e.pointerType !== "mouse") { if (h.con) focus = h.con; setHover(h.con && h.con !== hoverCon ? h.con : null); showTip(h.obj, mouse); }
    else if (h.con && window.SiteMusic) { musicOn = false; music(true); }
  });
  canvas.addEventListener("pointerleave", () => { if (!drag) { setHover(null); hoverObj = null; showTip(null); } });

  // ---------- date, time, and place ----------
  const longDate = (s) => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
  function applyMoment() {
    state.utc0 = zonedToUtc(state.date, "00:00", state.place.tz);
    const isBirth = state.date === BIRTH.date && state.time === BIRTH.time && state.place === BIRTH.place;
    root.classList.toggle("is-custom", !isBirth);
    title.textContent = `${state.place.region} · ${longDate(state.date)}`;
    setHours(toHours(state.time));
  }
  // the clock reading at the current slider position, in the place's own time zone (handles DST days)
  function fmtTime() {
    return new Date(utcNow()).toLocaleTimeString("en-US", { timeZone: state.place.tz, hour: "numeric", minute: "2-digit" });
  }
  function setHours(v) {
    state.hours = Math.max(0, Math.min(24, v));
    const mins = Math.min(23 * 60 + 59, Math.round(state.hours * 60));
    state.time = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    timeInput.value = Math.round(state.hours * 60); timeLabel.textContent = fmtTime();
    if (!panel.hidden) clockField.value = state.time;
    if (reduceMotion) redraw();
  }
  timeInput.addEventListener("input", () => setHours(parseFloat(timeInput.value) / 60));   // slider counts minutes

  placeField.innerHTML = PLACES.map((p, i) => `<option value="${i}">${p.name}${p.name.includes(",") ? "" : ", " + p.region}</option>`).join("") + `<option value="here">My location</option>`;
  function syncFields() {
    dateField.value = state.date; clockField.value = state.time;
    const i = PLACES.indexOf(state.place); placeField.value = i >= 0 ? String(i) : "here";
  }
  whenBtn.addEventListener("click", () => {
    const open = panel.hidden; panel.hidden = !open; whenBtn.setAttribute("aria-expanded", String(open));
    if (open) syncFields();
  });
  dateField.addEventListener("change", () => { if (dateField.value) { state.date = dateField.value; applyMoment(); } });
  clockField.addEventListener("change", () => { if (clockField.value) { state.time = clockField.value; applyMoment(); } });
  placeField.addEventListener("change", () => {
    if (placeField.value !== "here") { state.place = PLACES[+placeField.value]; applyMoment(); return; }
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      state.place = { name: "My location", region: "Your sky", lat: pos.coords.latitude, lon: pos.coords.longitude, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
      applyMoment();
    }, () => { syncFields(); });
  });
  $(".sky-now").addEventListener("click", () => {
    const d = new Date(), tz = state.place.tz;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
    state.date = `${parts.year}-${parts.month}-${parts.day}`; state.time = `${parts.hour}:${parts.minute}`;
    syncFields(); applyMoment();
  });
  function resetAll() {
    state.date = BIRTH.date; state.time = BIRTH.time; state.place = BIRTH.place;
    view.az = 64; view.alt = 2; focus = cons.find((c) => c.name === "Taurus");
    syncFields(); applyMoment(); redraw();
  }
  $(".sky-birth").addEventListener("click", resetAll);
  $(".sky-reset").addEventListener("click", resetAll);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") panel.hidden = true; });

  let anim = null;
  const playBtn = $(".sky-play");
  playBtn.addEventListener("click", () => {
    if (anim) { cancelAnimationFrame(anim); anim = null; playBtn.innerHTML = '<i class="fa-solid fa-play"></i>'; return; }
    playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    let last = performance.now();
    const step = (now) => {
      let v = state.hours + ((now - last) / 1000) * 0.6; last = now;
      if (v > 24) v = 0;
      setHours(v); anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  });

  // ---------- catalogues (compact local copies; see data/sky/README.md) ----------
  Promise.all(["stars.json", "messier.json", "milkyway.json"].map((f) => fetch(DATA + f + "?v=" + VERSION).then((r) => r.ok ? r.json() : null).catch(() => null)))
    .then(([stars, messier, milky]) => {
      if (stars) {
        bg = stars.map(([ra, dec, m, bv]) => prep({ ra, dec, m, col: bvColor(bv === null ? NaN : bv),
          r: Math.max(0.5, 2.6 - 0.4 * m), a: Math.max(0.22, Math.min(0.95, 1.1 - 0.12 * m)), phase: Math.random() * 6.28, speed: 0.5 + Math.random() * 1.5 }));
        bgBright = bg.filter((s) => s.m < 4.5);
        const buckets = {};
        for (const s of bg) {
          if (s.m < 4.5) continue;
          const a = (Math.round(s.a * 10) / 10).toFixed(1), key = s.col + "|" + a;
          (buckets[key] = buckets[key] || { style: `rgba(${s.col},${a})`, stars: [] }).stars.push(s);
        }
        bgBuckets = Object.values(buckets);
      }
      const kindNames = { galaxy: "galaxy", nebula: "nebula", planetary: "planetary nebula", remnant: "supernova remnant", globular: "globular cluster", open: "star cluster" };
      if (messier) dsos = messier.map(([ra, dec, name, alt, type, mag, dimA, dimB], i) => {
        const kind = dsoKind(type);
        return prep({ ra, dec, kind, dimA, dimB, rot: ((i * 37) % 180) * D2R,
          tipText: `${name}${alt ? " · " + alt : ""} · ${kindNames[kind]}${mag !== null ? " · mag " + mag : ""}` });
      });
      if (milky) {
        const alphas = [0.035, 0.035, 0.04, 0.045, 0.05];
        mw = milky.map((rings, i) => ({ alpha: alphas[i] || 0.04, rings: rings.map((ring) => ring.map(([ra, dec]) => prep({ ra, dec }))) }));
      }
      lastKey = ""; redraw();
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
  syncFields(); applyMoment(); resize(); loop();
})();
