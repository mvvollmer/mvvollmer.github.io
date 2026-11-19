/* Site-wide music player: a sound button in the top-right corner with a song menu.
   Exposes window.SiteMusic so the sky map can play music while stars are hovered.
   Playback position and song carry across pages within a visit (sessionStorage). */
(function () {
  const TRACKS = [
    { title: "Constellations", src: "music/Constellations.mp3" },
    { title: "Under the Stars", src: "music/UnderTheStarsV2.mp3" },
  ];
  const VOL = 0.55;
  const KEY = "mvv-music";

  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || "{}"); } catch (e) {}

  let track = Number.isInteger(saved.track) && TRACKS[saved.track] ? saved.track : 0;
  let manual = !!saved.manual;     // the visitor pressed play on the widget
  let hovering = false;            // the sky map wants music while a star is hovered
  let fadeTimer = 0, leaveTimer = 0;

  const audio = new Audio();
  audio.preload = "metadata"; audio.loop = true; audio.volume = 0;
  audio.src = TRACKS[track].src;
  if (saved.time) audio.addEventListener("loadedmetadata", () => { try { audio.currentTime = saved.time % (audio.duration || 1e9); } catch (e) {} }, { once: true });

  // ---- widget ----
  const el = document.createElement("div");
  el.className = "music-widget";
  el.innerHTML = `
    <button class="mw-toggle" type="button" aria-label="Play music"><i class="fa-solid fa-volume-xmark"></i></button>
    <button class="mw-menu" type="button" aria-label="Choose a song" aria-haspopup="true" aria-expanded="false"><i class="fa-solid fa-bars"></i></button>
    <div class="mw-list" role="menu" hidden>
      <div class="mw-head">Music by Miles</div>
      ${TRACKS.map((t, i) => `<button type="button" role="menuitemradio" data-i="${i}"><i class="fa-solid fa-check"></i><span>${t.title}</span></button>`).join("")}
    </div>`;
  document.body.appendChild(el);
  if (document.querySelector(".topnav")) el.classList.add("below-nav");
  const toggle = el.querySelector(".mw-toggle"), menuBtn = el.querySelector(".mw-menu"), list = el.querySelector(".mw-list");

  function render() {
    const on = !audio.paused && (manual || hovering);
    toggle.innerHTML = on ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-xmark"></i>';
    toggle.setAttribute("aria-label", on ? "Pause music" : "Play music");
    toggle.title = (on ? "Pause: " : "Play: ") + TRACKS[track].title;
    el.classList.toggle("playing", on);
    list.querySelectorAll("[data-i]").forEach((b) => {
      const sel = +b.dataset.i === track;
      b.classList.toggle("active", sel); b.setAttribute("aria-checked", String(sel));
    });
  }

  // iOS Safari ignores audio.volume (it stays at 1), so fades never finish there.
  // Detect that once and skip straight to the end state; also cap every fade at ~1.2s.
  const canFade = (() => { try { const a = new Audio(); a.volume = 0.5; return Math.abs(a.volume - 0.5) < 0.01; } catch (e) { return false; } })();
  function fadeTo(target, done) {
    clearInterval(fadeTimer);
    if (!canFade) { done && done(); return; }
    let ticks = 0;
    fadeTimer = setInterval(() => {
      const step = target > audio.volume ? 0.04 : -0.04, v = audio.volume + step;
      if (++ticks > 30 || (step > 0 && v >= target) || (step < 0 && v <= target)) {
        audio.volume = Math.max(0, Math.min(1, target)); clearInterval(fadeTimer); done && done();
      } else audio.volume = Math.max(0, Math.min(1, v));
    }, 40);
  }

  // Resolves true if sound started; false if the browser is waiting for a click first.
  function start() {
    return audio.play().then(() => { fadeTo(VOL); render(); return true; })
      .catch(() => { el.classList.add("needs-click"); render(); return false; });
  }
  function stop() { fadeTo(0, () => { audio.pause(); render(); }); }

  toggle.addEventListener("click", () => {
    el.classList.remove("needs-click");
    if (!audio.paused && (manual || hovering)) { manual = false; hovering = false; stop(); }
    else { manual = true; start(); }
    save();
  });
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = list.hidden; list.hidden = !open; menuBtn.setAttribute("aria-expanded", String(open));
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]"); if (!b) return;
    setTrack(+b.dataset.i, true);
    list.hidden = true; menuBtn.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => { if (!el.contains(e.target)) { list.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { list.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); } });

  function setTrack(i, play) {
    if (i === track && !audio.paused) return;
    const wasOn = !audio.paused;
    track = i; clearInterval(fadeTimer);
    audio.pause(); audio.src = TRACKS[track].src; audio.load(); audio.volume = 0;
    if (play || wasOn) { manual = manual || play; start(); } else render();
    save();
  }

  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify({ track, manual, time: audio.currentTime || 0 })); } catch (e) {}
  }
  window.addEventListener("pagehide", save);

  // A visitor who had music on keeps it on across pages; browsers may need one click on the new page.
  if (manual) {
    start().then((ok) => {
      if (ok) return;
      const resume = () => { if (manual && audio.paused) { el.classList.remove("needs-click"); start(); } };
      document.addEventListener("pointerdown", resume, { once: true, capture: true });
    });
  }

  // ---- API for the sky map ----
  window.SiteMusic = {
    hoverStart() {
      clearTimeout(leaveTimer);
      if (hovering) return Promise.resolve(true);
      hovering = true;
      if (!audio.paused && audio.volume >= VOL - 0.01) return Promise.resolve(true);
      return start();
    },
    hoverEnd() {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => { hovering = false; if (!manual) stop(); else render(); }, 650);
    },
    get title() { return TRACKS[track].title; },
  };
  render();
})();
