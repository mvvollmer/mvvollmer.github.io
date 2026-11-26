/* Poker page: seats, dealing, the human's controls, and the bots, on top of engine.js and bots.js. */
(function () {
  const C = window.PokerCards, E = window.PokerEngine, B = window.PokerBots, R = window.PokerRanges;
  const BB = 2, SB = 1, START = 200;                       // 1/2 blinds, 100 big blind stacks
  const $ = (s, r = document) => r.querySelector(s);
  const SUIT_SYM = ["♣", "♦", "♥", "♠"];
  // casino chips: $1 white, $5 red, $25 green, $100 black, $500 purple, $1,000 orange (display only;
  // the engine counts in $1 units and the agents reason in big blinds and pot fractions)
  const CHIPS = [[1000, "orange"], [500, "purple"], [100, "black"], [25, "green"], [5, "red"], [1, "white"]];
  const money = (v) => "$" + Math.round(v).toLocaleString("en-US");
  function chipsHTML(amount, maxPerColumn = 6) {
    if (!amount) return "";
    let left = amount;
    const cols = [];
    for (const [value, color] of CHIPS) {
      const k = Math.floor(left / value);
      if (k) { cols.push({ color, value, k }); left -= k * value; }
    }
    return `<span class="chips" title="${money(amount)}">` + cols.map(({ color, value, k }) =>
      `<span class="chip-col" title="${k} × ${money(value)}">` +
      Array.from({ length: Math.min(k, maxPerColumn) }, () => `<i class="chip chip-${color}"></i>`).join("") + `</span>`).join("") + `</span>`;
  }
  const BOT_TYPES = { rebel: "ReBeL", q: "Q-learning", random: "Random" };
  const BOT_BLURB = {
    rebel: "Policy, value, and bet-sizing networks trained through self-play, with a look-ahead search. At two-, three-, and five-player tables it knows who each opponent is and estimates their hand from how they bet; four- and six-handed tables use earlier specialists that still win their head-to-head tests.",
    q: "Tabular Q-learning over a simplified view of the hand: equity, pot odds, position, and players left.",
    random: "Picks a legal action at random. The baseline every agent in the paper had to beat.",
  };

  // version stamp from this script's own URL (?v=...), reused so model files refresh with the site
  const VERSION = ((document.currentScript && document.currentScript.src.match(/[?&]v=([\w-]+)/)) || [])[1] || "";
  const modelCache = {};
  const state = { style: "trained", players: [], button: 0, hand: null, seatOf: null, history: null, handNo: 0, busy: false, thinking: true, speed: 750 };

  // ------------------------------------------------------------------ setup
  // each table size can have its own ReBeL model (manifest.json maps players -> file)
  const fetchJSON = (f) => fetch(`data/poker/${f}${VERSION ? "?v=" + VERSION : ""}`).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
  async function loadModels(n) {
    if (modelCache[n]) return modelCache[n];
    let file = "rebel-v2.json";
    try { const m = await fetchJSON("manifest.json"); file = m[String(n)] || m.default || file; } catch (e) { /* fall back to the general model */ }
    const [rebel, q, typeProfiles, preflopStrength] = await Promise.all(
      [fetchJSON(file), fetchJSON("qlearning.json"), fetchJSON("type_profiles.json"), fetchJSON("preflop_strength.json")]);
    R.setData({ typeProfiles, preflopStrength });
    return (modelCache[n] = { rebel, q, file });
  }
  let models = null;

  function makeBot(type) {
    const bot = type === "rebel" ? new B.RebelBot(models.rebel) : type === "q" ? new B.QBot(models.q) : new B.RandomBot();
    bot.style = state.style;
    return bot;
  }
  function setStyle(style) {
    state.style = style;
    document.querySelectorAll(".bot-style").forEach((sel) => { sel.value = style; });
    state.players.forEach((p) => { if (p.bot) p.bot.style = style; });
    try { localStorage.setItem("poker-style", style); } catch (e) { /* storage unavailable */ }
  }

  function renderSetup() {
    const n = +$("#seat-count").value;
    const box = $("#bot-seats");
    const prev = [...box.querySelectorAll("select")].map((s) => s.value);
    const defaults = ["rebel", "q", "random", "rebel", "q"];
    box.innerHTML = "";
    for (let k = 1; k < n; k++) {
      const v = prev[k - 1] || defaults[k - 1];
      box.insertAdjacentHTML("beforeend", `<label class="bot-pick">Seat ${k + 1}<select data-k="${k}">
        ${Object.entries(BOT_TYPES).map(([id, name]) => `<option value="${id}" ${id === v ? "selected" : ""}>${name}</option>`).join("")}
      </select></label>`);
    }
  }

  async function start() {
    $("#start-btn").disabled = true;
    $("#start-btn").textContent = "Loading the agents…";
    try { models = await loadModels(+$("#seat-count").value); } catch (e) {
      $("#start-btn").textContent = "Couldn't load the models; try reloading"; return;
    }
    const n = +$("#seat-count").value;
    const types = [...$("#bot-seats").querySelectorAll("select")].map((s) => s.value);
    const count = {};
    state.players = [{ name: "You", type: "human", stack: START, net: 0 }];
    types.forEach((t) => {
      count[t] = (count[t] || 0) + 1;
      const same = types.filter((x) => x === t).length;
      state.players.push({ name: BOT_TYPES[t] + (same > 1 ? " " + count[t] : ""), type: t, bot: makeBot(t), stack: START, net: 0 });
    });
    state.history = state.players.map(() => []);
    // what the table learns about each player across the session; you appear to the bots as "unknown"
    state.models = state.players.map((p) => new R.PlayerModel(p.type === "human" ? "unknown" : p.type));
    state.button = Math.floor(Math.random() * n);
    state.handNo = 0;
    $("#setup").hidden = true;
    $("#game").hidden = false;
    $("#log").innerHTML = "";
    buildSeats();
    nextHand();
  }

  // ------------------------------------------------------------------ table rendering
  function cardHTML(c, hidden, extra = "") {
    if (hidden) return `<span class="pcard back"></span>`;
    const s = C.suitOf(c), r = C.RANKS[c >> 2] === "T" ? "10" : C.RANKS[c >> 2];
    const tip = extra === "runout" ? ` title="Not dealt: the card that would have come"` : "";
    return `<span class="pcard ${s === 1 || s === 2 ? "red" : ""} ${extra}"${tip}><b>${r}</b><i>${SUIT_SYM[s]}</i></span>`;
  }

  function buildSeats() {
    const n = state.players.length, wrap = $("#seats");
    wrap.innerHTML = "";
    state.players.forEach((p, seat) => {
      // seat 0 (you) at the bottom centre, others clockwise around the oval
      const ang = Math.PI / 2 + (2 * Math.PI * seat) / n;
      const x = 50 + 44 * Math.cos(ang), y = 50 + 40 * Math.sin(ang);
      // bets sit in front of each player, pushed toward the middle of the table
      const bx = (-Math.cos(ang) * 92).toFixed(0), by = (-Math.sin(ang) * 54).toFixed(0);
      wrap.insertAdjacentHTML("beforeend", `<div class="seat ${seat === 0 ? "me" : ""}" id="seat-${seat}" style="left:${x}%;top:${y}%;--bx:${bx}px;--by:${by}px">
        <div class="seat-cards"></div>
        <div class="seat-plate"><span class="seat-name">${p.name}</span><span class="seat-stack"></span></div>
        <div class="seat-bet"></div><div class="seat-dealer" hidden>D</div><div class="seat-say"></div>
      </div>`);
    });
  }

  function render(reveal = false) {
    const h = state.hand;
    state.players.forEach((p, seat) => {
      const el = $("#seat-" + seat), i = state.idxOf[seat];
      const folded = h.folded[i];
      el.classList.toggle("folded", folded);
      el.classList.toggle("acting", !h.done && h.actor === i);
      if (!h.done) el.classList.remove("winner");
      el.querySelector(".seat-stack").textContent = money(h.stacks[i]);
      const showCards = seat === 0 || (reveal && !folded);          // every hand that reaches showdown is revealed
      el.querySelector(".seat-cards").innerHTML = folded && seat !== 0 ? "" : h.hole[i].map((c) => cardHTML(c, !showCards)).join("");
      el.querySelector(".seat-bet").innerHTML = h.bets[i] ? `${chipsHTML(h.bets[i])}<b>${money(h.bets[i])}</b>` : "";
      el.querySelector(".seat-dealer").hidden = seat !== state.button;
      if (h.stacks[i] === 0 && !folded && !h.done) el.querySelector(".seat-say").textContent = "All in";
    });
    // once a hand is over, show the rest of the board as it would have run out (faded), so a fold can be judged
    const runout = h.done ? h.fullBoard.slice(h.board.length, 5) : [];
    $("#board").innerHTML = h.board.map((c) => cardHTML(c)).join("") + runout.map((c) => cardHTML(c, false, "runout")).join("")
      + "<span class='pcard slot'></span>".repeat(5 - h.board.length - runout.length);
    const pot = h.committed.reduce((a, b) => a + b, 0) - h.bets.reduce((a, b) => a + b, 0);   // chips already in the middle
    const total = h.committed.reduce((a, b) => a + b, 0);
    $("#pot").innerHTML = `${chipsHTML(h.done ? total : pot, 8)}<span>Pot ${money(total)}</span>`
      + (runout.length ? `<small class="runout-note">Faded cards: what would have come</small>` : "");
  }

  function say(seat, text) {
    const el = $("#seat-" + seat + " .seat-say");
    el.textContent = text;
    el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  }

  function log(html) {
    const li = document.createElement("li");
    li.innerHTML = html;
    $("#log").prepend(li);
  }

  // ------------------------------------------------------------------ hands
  function nextHand() {
    const n = state.players.length;
    // busted players reload to 100 bb (their losses are already counted in net)
    state.players.forEach((p) => { if (p.stack < BB) { p.stack = START; p.reloads = (p.reloads || 0) + 1; } });
    state.button = (state.button + 1) % n;
    state.handNo++;
    // engine index i sits at table seat (button + 1 + i) % n (PokerKit posting order)
    state.seatOf = [...Array(n).keys()].map((i) => (state.button + 1 + i) % n);
    state.idxOf = new Array(n);
    state.seatOf.forEach((seat, i) => { state.idxOf[seat] = i; });
    const deck = [...Array(52).keys()];
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const hole = state.seatOf.map((_, i) => [deck[2 * i], deck[2 * i + 1]]);
    state.hand = new E.Hand({ stacks: state.seatOf.map((s) => state.players[s].stack), smallBlind: SB, bigBlind: BB, hole, board: deck.slice(2 * n, 2 * n + 5) });
    state.tracker = new R.RangeTracker(state.seatOf.map((seat) => state.models[seat]));
    state.players.forEach((_, s) => { $("#seat-" + s + " .seat-say").textContent = ""; });
    $("#thinking").innerHTML = "";
    $("#next-btn").hidden = true;
    log(`<strong>Hand ${state.handNo}</strong> · ${state.players[state.button].name} on the button`);
    render();
    step();
  }

  function observation(i) {
    const h = state.hand, n = h.n, seat = state.seatOf[i];
    state.tracker.setBoard(h.board);
    const canRaise = h.canRaise(i), toCall = h.toCall(i);
    const legal = [];
    if (h.canFold(i)) legal.push(B.FOLD);
    legal.push(toCall > 0 ? B.CALL : B.CHECK);
    if (canRaise) legal.push(B.BET);
    const order = [...Array(n - 1).keys()].map((k) => (i + 1 + k) % n);
    return {
      hole: h.hole[i], board: h.board, street: h.street, pot: h.committed.reduce((a, b) => a + b, 0), toCall, stack: h.stacks[i],
      committed: h.committed[i], minRaiseTo: canRaise ? h.minRaiseTo(i) : null, maxRaiseTo: canRaise ? h.maxRaiseTo(i) : null,
      currentBet: h.bets[i], legal, activeOpponents: order.filter((j) => !h.folded[j]).length,
      playersLeftToAct: h.queue.slice(1).length, numPlayers: n, bigBlind: BB,
      opponentBets: order.map((j) => state.history[state.seatOf[j]].slice()),
      raisesThisStreet: h.log.filter((e) => e.street === h.street && e.kind === "raise").length,
      // opponent modeling: who they are, how they play, and what they are estimated to hold
      opponentTypes: order.map((j) => state.models[state.seatOf[j]].type),
      opponentStats: order.map((j) => state.models[state.seatOf[j]].stats()),
      opponentActive: order.map((j) => !h.folded[j]),
      opponentRanges: order.map((j) => state.tracker.w[j]),
      opponentRangeStrength: order.map((j) => state.tracker.rangeStrength(j)),
    };
  }

  function pushHistory(seat, bb) { const hst = state.history[seat]; hst.push(bb); if (hst.length > 30) hst.shift(); }

  function apply(i, action, raiseTo) {
    const h = state.hand, seat = state.seatOf[i], name = state.players[seat].name, before = h.bets[i];
    const streetNames = ["preflop", "flop", "turn", "river"], st = h.street, facedBet = h.toCall(i);
    state.tracker.setBoard(h.board);
    const lenBefore = h.log.length;
    const you = state.players[seat].type === "human", v = (third, base) => (you ? base : third);   // "You raise", "ReBeL raises"
    if (action === B.FOLD && h.canFold(i)) { h.fold(); say(seat, "Fold"); log(`${name} ${v("folds", "fold")}`); }
    else if (action === B.BET && h.canRaise(i)) {
      const amt = Math.round(Math.min(Math.max(raiseTo || h.minRaiseTo(i), h.minRaiseTo(i)), h.maxRaiseTo(i)));
      const verb = h.maxBet() === 0 ? v("bets", "bet") : v("raises to", "raise to");
      h.raiseTo(amt);
      pushHistory(seat, (amt - before) / BB);
      say(seat, (h.stacks[i] === 0 ? "All in " : "") + (/^bet/.test(verb) ? "Bet " : "Raise ") + money(amt));
      log(`${name} ${verb} ${money(amt)}${h.stacks[i] === 0 ? " (all in)" : ""}`);
    } else {
      const paid = h.toCall(i);
      h.checkOrCall();
      if (paid) pushHistory(seat, paid / BB);
      say(seat, paid ? `Call ${money(paid)}` : "Check");
      log(`${name} ${paid ? v("calls ", "call ") + money(paid) : v("checks", "check")}`);
    }
    // every action updates what the table believes about this player's hand and tendencies
    const act = h.log[lenBefore];
    if (act) {
      const [facing, code] = R.actionCode(facedBet, act.kind === "check" ? "check" : act.kind);
      state.tracker.update(i, st, facing, code);
    }
    if (!h.done && h.street !== st) { log(`<em>${streetNames[h.street]}: ${h.board.map(C.cardStr).join(" ")}</em>`); clearSays(); }
  }

  function clearSays() { state.players.forEach((_, s) => { const el = $("#seat-" + s + " .seat-say"); if (!/All in/.test(el.textContent)) el.textContent = ""; }); }

  function step() {
    const h = state.hand;
    render();
    if (h.done) return finishHand();
    const i = h.actor, seat = state.seatOf[i], p = state.players[seat];
    if (p.type === "human") return showControls(i);
    hideControls();
    state.busy = true;
    setTimeout(() => {
      const obs = observation(i);
      const { action, raiseTo, info } = p.bot.act(obs);
      if (state.thinking) showThinking(p, info, obs);
      apply(i, action, raiseTo);
      state.busy = false;
      step();
    }, state.speed);
  }

  function finishHand() {
    const h = state.hand;
    hideControls();
    const shown = h.scores && Object.keys(h.scores).length > 1;
    render(shown);
    state.seatOf.forEach((seat, i) => {
      const p = state.players[seat];
      p.stack = h.stacks[i];
      p.net += h.payoffs[i];
      if (h.payoffs[i] > 0) {
        const how = shown && h.scores[i] !== undefined ? ` with ${C.CATEGORY_NAMES[C.categoryOf(h.scores[i])].toLowerCase()}` : "";
        say(seat, `Wins ${money(h.winnings[i])}`);
        log(`<strong>${p.name} ${p.type === "human" ? "win" : "wins"} ${money(h.winnings[i])}${how}</strong>`);
        $("#seat-" + seat).classList.add("winner");
      }
    });
    if (h.board.length < 5) log(`<em>Cards that would have come: ${h.fullBoard.slice(h.board.length, 5).map(C.cardStr).join(" ")} (board ${h.fullBoard.map(C.cardStr).join(" ")})</em>`);
    if (shown) log(`<em>Showdown: ${state.seatOf.map((seat, i) => h.folded[i] ? null : `${state.players[seat].name} ${h.hole[i].map(C.cardStr).join(" ")} (${C.CATEGORY_NAMES[C.categoryOf(h.scores[i])].toLowerCase()})`).filter(Boolean).join(" · ")}</em>`);
    renderScores();
    $("#next-btn").hidden = false;
    if ($("#auto-next").checked) setTimeout(() => { if (!$("#next-btn").hidden) nextHand(); }, 2600);
  }

  function renderScores() {
    $("#scores").innerHTML = state.players.map((p) =>
      `<li><span>${p.name}${p.type !== "human" ? ` <small>${BOT_TYPES[p.type]}</small>` : ""}</span><b class="${p.net >= 0 ? "up" : "down"}">${p.net >= 0 ? "+" : "−"}${money(Math.abs(p.net))} <small>(${p.net >= 0 ? "+" : ""}${(p.net / BB).toFixed(1)} bb)</small></b></li>`).join("")
      + `<li class="muted">${state.handNo} hand${state.handNo === 1 ? "" : "s"} played</li>`;
  }

  // ------------------------------------------------------------------ human controls
  function showControls(i) {
    const h = state.hand, box = $("#controls");
    box.hidden = false;
    const toCall = h.toCall(i), canRaise = h.canRaise(i);
    $("#fold-btn").hidden = !h.canFold(i);
    $("#call-btn").textContent = toCall ? `Call ${money(toCall)}` : "Check";
    $("#raise-row").hidden = !canRaise;
    if (canRaise) {
      const lo = h.minRaiseTo(i), hi = h.maxRaiseTo(i), slider = $("#raise-slider"), num = $("#raise-amt");
      slider.min = num.min = lo; slider.max = num.max = hi;
      setRaise(lo, true);                               // default amount, but no chips clicked yet
      state.pile = 0;                                   // chips clicked so far this turn
      $("#pile-note").textContent = "Click chips to build your bet";
      const pot = h.committed.reduce((a, b) => a + b, 0);
      box.dataset.pot = pot; box.dataset.cur = h.bets[i]; box.dataset.call = toCall;
    }
    $("#call-btn").focus({ preventScroll: true });
  }
  function hideControls() { $("#controls").hidden = true; }
  // v is the raise-to total; the chip preview shows what you are pushing in on top of your current bet
  function setRaise(v, fromChips = false) {
    const s = $("#raise-slider"), lo = +s.min, hi = +s.max, cur = state.hand.bets[state.hand.actor] || 0;
    v = Math.round(Math.min(Math.max(v, lo), hi));
    s.value = v; $("#raise-amt").value = v;
    if (!fromChips) { state.pile = v - cur; $("#pile-note").textContent = ""; }
    $("#raise-btn").textContent = `${state.hand.maxBet() === 0 ? "Bet" : "Raise to"} ${money(v)}${v === hi ? " (all in)" : ""}`;
    $("#raise-chips").innerHTML = chipsHTML(v - cur);
  }
  // clicking chips adds them to the pile you are pushing in; the pile becomes a raise-to amount
  function addChip(value) {
    const h = state.hand, i = h.actor, cur = h.bets[i], lo = h.minRaiseTo(i), hi = h.maxRaiseTo(i);
    state.pile = Math.min((state.pile > 0 ? state.pile : 0) + value, hi - cur);
    const target = cur + state.pile;
    setRaise(target, true);
    $("#pile-note").textContent = target >= hi ? `${money(state.pile)} in: that is all in`
      : target < lo ? `${money(state.pile)} in so far; the minimum ${h.maxBet() === 0 ? "bet" : "raise"} is to ${money(lo)}`
      : `${money(state.pile)} in`;
  }
  function resetBet() {
    const h = state.hand;
    state.pile = 0;
    setRaise(h.minRaiseTo(h.actor), true);
    $("#pile-note").textContent = "Bet reset: click chips to build your bet";
  }
  function humanAct(action) {
    const h = state.hand;
    if (!h || h.done || state.busy || state.players[state.seatOf[h.actor]].type !== "human") return;
    apply(h.actor, action, action === B.BET ? +$("#raise-amt").value : null);
    step();
  }

  // ------------------------------------------------------------------ AI thinking panel
  const TYPE_NAMES = { random: "Random", q: "Q-learning", rebel: "ReBeL", unknown: "unknown player" };
  function readsHTML(obs) {
    const h = state.hand, me = h.actor, n = h.n;
    const rows = [];
    for (let k = 1; k < n; k++) {
      const j = (me + k) % n;
      if (h.folded[j]) continue;
      const seat = state.seatOf[j], p = state.players[seat], m = state.models[seat];
      const label = p.type === "human" ? "You (unknown)" : `${p.name}`;
      if (m.type === "random") { rows.push(`<li><b>${label}</b>: random bets carry no information, so any two cards</li>`); continue; }
      const read = state.tracker.topClasses(j, obs.hole, 5);
      const st = state.tracker.rangeStrength(j), base = h.board.length ? 0.5 : 0.5;
      const label2 = st > base + 0.1 ? "strong" : st < base - 0.08 ? "weak" : "medium-strength";
      const [fold, aggr, ev] = m.stats();
      const guess = read.focus < 1.3 ? "no clear read yet, could be almost anything" : `${label2} range, likely ${read.hands.join(", ")}`;
      rows.push(`<li><b>${label}</b>: ${guess} <span class="muted">(folds to bets ${Math.round(fold * 100)}%, aggressive ${Math.round(aggr * 100)}%, ${Math.round(ev * 60)} actions seen)</span></li>`);
    }
    return rows.length ? `<p class="reads-title">Its read on the table</p><ul class="reads">${rows.join("")}</ul>` : "";
  }
  function showThinking(p, info, obs) {
    if (!info) { $("#thinking").innerHTML = `<p><strong>${p.name}</strong> chose at random.</p>`; return; }
    const names = ["Fold", "Check", "Call", "Bet/raise"];
    const blocked = Array.isArray(info.blocked) ? info.blocked.length : info.blocked;
    const note = blocked ? `<p class="muted">Conservative betting ruled out ${Array.isArray(info.blocked) ? info.blocked.join(", ") : blocked + " raise size" + (blocked === 1 ? "" : "s")}.</p>` : "";
    let html = `<p><strong>${p.name}</strong> · equity <b>${Math.round(info.equity * 100)}%</b> against random hands`
      + (info.rangeEquity != null ? `, <b>${Math.round(info.rangeEquity * 100)}%</b> against what it thinks you all hold` : "") + `</p>`;
    if (info.rangeEquity != null) html += readsHTML(obs);
    if (info.candidates) {
      const rows = info.candidates.slice().sort((a, b) => b.prob - a.prob).map((c) =>
        `<tr><td>${names[c.action]}${c.action === 3 ? ` ${c.size}× pot` : ""}</td><td>${c.valueBB >= 0 ? "+" : ""}${c.valueBB.toFixed(1)} bb</td><td><span class="bar" style="width:${Math.round(c.prob * 100)}%"></span>${Math.round(c.prob * 100)}%</td></tr>`).join("");
      html += `<table class="think"><tr><th>Option</th><th>Value net</th><th>Chosen with</th></tr>${rows}</table>`;
    } else if (info.values) {
      const rows = Object.entries(info.values).map(([k, v]) => `<tr><td>${k}${k === info.choice ? " ✓" : ""}</td><td>${v >= 0 ? "+" : ""}${v.toFixed(2)} bb</td></tr>`).join("");
      html += `<table class="think"><tr><th>Option</th><th>Learned value</th></tr>${rows}</table>`;
    }
    $("#thinking").innerHTML = html + note;
  }

  // ------------------------------------------------------------------ wiring
  document.addEventListener("DOMContentLoaded", () => {
    $("#seat-count").addEventListener("change", renderSetup);
    renderSetup();
    $("#start-btn").addEventListener("click", start);
    $("#fold-btn").addEventListener("click", () => humanAct(B.FOLD));
    $("#call-btn").addEventListener("click", () => humanAct(B.CALL));
    $("#raise-btn").addEventListener("click", () => humanAct(B.BET));
    $("#raise-slider").addEventListener("input", (e) => setRaise(+e.target.value));
    document.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => addChip(+b.dataset.chip)));
    $("#reset-bet").addEventListener("click", resetBet);
    $("#raise-amt").addEventListener("change", (e) => setRaise(+e.target.value));
    document.querySelectorAll("[data-pot]").forEach((b) => b.addEventListener("click", () => {
      const box = $("#controls"), f = b.dataset.pot;
      if (f === "all") return setRaise(+$("#raise-slider").max);
      setRaise(+box.dataset.cur + +box.dataset.call + parseFloat(f) * (+box.dataset.pot + +box.dataset.call));
    }));
    $("#next-btn").addEventListener("click", nextHand);
    $("#thinking-toggle").addEventListener("change", (e) => { state.thinking = e.target.checked; $("#thinking-card").hidden = !e.target.checked; });
    $("#speed").addEventListener("change", (e) => { state.speed = +e.target.value; });
    document.querySelectorAll(".bot-style").forEach((sel) => sel.addEventListener("change", (e) => setStyle(e.target.value)));
    let saved = "trained";
    try { saved = localStorage.getItem("poker-style") || "trained"; } catch (e) { /* storage unavailable */ }
    setStyle(saved);
    $("#new-table").addEventListener("click", () => { $("#game").hidden = true; $("#setup").hidden = false; $("#start-btn").disabled = false; $("#start-btn").textContent = "Deal me in"; });
    document.addEventListener("keydown", (e) => {
      if ($("#controls").hidden || /input|select|textarea/i.test(document.activeElement.tagName) && document.activeElement.type !== "range") return;
      if (e.key === "f" && !$("#fold-btn").hidden) humanAct(B.FOLD);
      if (e.key === "c") humanAct(B.CALL);
      if (e.key === "r" && !$("#raise-row").hidden) humanAct(B.BET);
    });
    document.querySelectorAll("[data-blurb]").forEach((el) => { el.textContent = BOT_BLURB[el.dataset.blurb]; });
  });
})();
