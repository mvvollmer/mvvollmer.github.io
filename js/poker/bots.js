/* The three opponents, ported from PokerArena/arena (features.py and agents.py).
   Feature extraction and network outputs are checked against Python in
   PokerArena/tests/test_js_bots.py.

   An observation (obs) has the same fields as the Python Observation, in camelCase:
   hole, board, street, pot, toCall, stack, committed, minRaiseTo, maxRaiseTo, currentBet,
   legal (subset of FOLD/CHECK/CALL/BET), activeOpponents, playersLeftToAct, numPlayers,
   bigBlind, opponentBets (per opponent, seat order after this player: bet history in bb). */
(function (root) {
  const C = typeof module !== "undefined" ? require("./cards.js") : root.PokerCards;
  const FOLD = 0, CHECK = 1, CALL = 2, BET = 3;
  const MAX_OPP = 5, HAND_DIM = 21, OPP_DIM = 8 * MAX_OPP, PUBLIC_DIM = 13, STATE_DIM = HAND_DIM + OPP_DIM + PUBLIC_DIM;

  // ------------------------------------------------------------------ features
  function count(arr, v) { let k = 0; for (const x of arr) if (x === v) k++; return k; }

  function straightPotential(u) {
    if (u.length < 3) return 0;
    const gaps = []; for (let i = 1; i < u.length; i++) gaps.push(u[i] - u[i - 1]);
    const consecutive = gaps.filter((g) => g === 1).length + 1;
    if (consecutive >= 4) return 1;
    if (u.includes(14) && [2, 3, 4, 5].some((r) => u.includes(r))) return 1;
    if (consecutive >= 3 && gaps.filter((g) => g <= 2).length >= 3) return 1;
    return 0;
  }

  function handFeatures(hole, board) {
    const f = new Float64Array(HAND_DIM);
    const rh = hole.map(C.rankOf);
    if (!board.length) {
      const lo = Math.min(...rh), hi = Math.max(...rh);
      f[lo === hi ? C.PAIR : C.HIGH_CARD] = 1;
      f[10] = C.suitOf(hole[0]) === C.suitOf(hole[1]) ? 1 : 0;
      f[11] = hi - lo <= 4 ? 1 : 0;
      return f;
    }
    const cards = hole.concat(board);
    const cat = C.categoryOf(C.evaluate(cards));
    const ranks = cards.map(C.rankOf);
    let idx = cat;
    if (cat === C.STRAIGHT_FLUSH && [14, 13, 12, 11, 10].every((r) => ranks.includes(r))) idx = 9;
    f[idx] = 1;
    if (board.length < 5) {
      const suits = cards.map(C.suitOf);
      f[10] = Math.max(...[...new Set(suits)].map((s) => count(suits, s))) / 7;
      f[11] = straightPotential([...new Set(ranks)].sort((a, b) => a - b));
      const counts = [...new Set(ranks)].map((r) => count(ranks, r));
      const pairs = counts.filter((c) => c === 2).length, trips = counts.filter((c) => c === 3).length;
      f[12] = (trips && pairs) || trips >= 2 ? 0 : (trips >= 1 || pairs >= 2 ? 1 : 0);
    }
    if (cat === C.HIGH_CARD) f[13] = (Math.max(...rh) - 2) / 12;
    else if (cat === C.PAIR) {
      const pair = Math.max(...ranks.filter((r) => count(ranks, r) >= 2));
      if (rh[0] === rh[1] && rh[0] === pair) f[14] = (pair - 2) / 12 + 0.5;
      else { const u = [...new Set(ranks)].sort((a, b) => a - b); f[14] = u.indexOf(pair) / u.length; }
    } else if (cat === C.TWO_PAIR) {
      const ps = [...new Set(ranks.filter((r) => count(ranks, r) >= 2))].sort((a, b) => b - a);
      if (ps.slice(0, 2).every((r) => rh.includes(r))) f[15] = 1;
      else if (ps.slice(0, 2).some((r) => rh.includes(r))) f[15] = 0.5 + (ps[0] - 2) / 24;
      else f[15] = ps[0] / 14;
    } else if (cat === C.TRIPS) {
      const t = ranks.find((r) => count(ranks, r) >= 3);
      f[16] = rh[0] === rh[1] && rh[0] === t ? 1 : (rh.includes(t) ? 0.7 + (t - 2) / 40 : (t - 2) / 12);
    } else if (cat === C.STRAIGHT) {
      const u = [...new Set(ranks)].sort((a, b) => a - b);
      let high = 5;
      for (let i = 0; i + 4 < u.length; i++) if (u[i + 4] - u[i] === 4) high = u[i + 4];
      f[17] = (high - 5) / 9;
    } else if (cat === C.FLUSH) {
      const suits = cards.map(C.suitOf);
      let fs = suits[0], best = -1;
      for (const s of new Set(suits)) { const k = count(suits, s); if (k > best) { best = k; fs = s; } }
      f[18] = (Math.max(...cards.filter((c) => C.suitOf(c) === fs).map(C.rankOf)) - 2) / 12;
    } else if (cat === C.FULL_HOUSE) {
      const t = Math.max(...ranks.filter((r) => count(ranks, r) >= 3));
      const others = ranks.filter((r) => count(ranks, r) >= 2 && r !== t);
      const p = others.length ? Math.max(...others) : t;
      if (count(rh, t) === 2) f[19] = 1;
      else if (rh.includes(t) && rh.includes(p)) f[19] = 0.8;
      else f[19] = (t - 2) / 12;
    } else if (cat === C.QUADS) {
      const q = ranks.find((r) => count(ranks, r) >= 4), k = count(rh, q);
      f[20] = k === 2 ? 1 : (k === 1 ? 0.8 : (q - 2) / 12);
    }
    return f;
  }

  function median(sorted) { const m = sorted.length >> 1; return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; }

  function opponentFeatures(opponentBets) {
    const out = new Float64Array(OPP_DIM);
    opponentBets.slice(0, MAX_OPP).forEach((bets, k) => {
      if (bets.length <= 3) return;
      const b = bets.map((x) => x / 10);
      const n = b.length, mean = b.reduce((a, c) => a + c, 0) / n;
      const std = Math.sqrt(b.reduce((a, c) => a + (c - mean) ** 2, 0) / n);
      let diffSum = 0; for (let i = 1; i < n; i++) diffSum += b[i] - b[i - 1];
      const last3 = b.slice(-3);
      const vals = [Math.min(...b), median([...b].sort((x, y) => x - y)), mean, Math.max(...b), std / (mean + 1e-8),
        diffSum / (n - 1), last3.reduce((a, c) => a + c, 0) / last3.length, b.filter((x) => x > mean).length / n];
      vals.forEach((v, j) => { out[8 * k + j] = v; });
    });
    return out;
  }

  function publicFeatures(o, eq) {
    const f = new Float64Array(PUBLIC_DIM);
    f[o.street] = 1;
    f[4] = eq;
    f[5] = o.toCall ? o.toCall / (o.pot + o.toCall) : 0;
    f[6] = Math.min(o.stack / Math.max(o.pot, 1), 10) / 10;
    f[7] = o.toCall / Math.max(o.bigBlind * 100, 1);
    f[8] = o.committed / Math.max(o.committed + o.stack, 1);
    f[9] = o.activeOpponents / MAX_OPP;
    f[10] = o.playersLeftToAct / MAX_OPP;
    f[11] = o.numPlayers / 6;
    f[12] = o.toCall > o.bigBlind ? 1 : 0;
    return f;
  }

  function featurize(o, eq) {
    const x = new Float64Array(STATE_DIM);
    x.set(handFeatures(o.hole, o.board), 0);
    x.set(opponentFeatures(o.opponentBets), HAND_DIM);
    x.set(publicFeatures(o, eq), HAND_DIM + OPP_DIM);
    return x;
  }

  function raiseToFor(o, potFraction) {
    const target = o.currentBet + o.toCall + potFraction * (o.pot + o.toCall);
    return Math.round(Math.min(Math.max(target, o.minRaiseTo), o.maxRaiseTo));
  }

  // ------------------------------------------------------------------ Random
  class RandomBot {
    constructor(rand = Math.random) { this.name = "Random"; this.rand = rand; }
    act(o) {
      const a = o.legal[Math.floor(this.rand() * o.legal.length)];
      if (a !== BET) return { action: a };
      if (this.rand() < 0.05) return { action: BET, raiseTo: o.maxRaiseTo };
      const hi = Math.min(o.maxRaiseTo, raiseToFor(o, 1.0));
      return { action: BET, raiseTo: o.minRaiseTo + Math.floor(this.rand() * (Math.max(o.minRaiseTo, hi) - o.minRaiseTo + 1)) };
    }
  }

  // ------------------------------------------------------------------ Q-learning
  const Q_ACTIONS = ["fold", "check/call", "raise 1/2 pot", "raise pot", "all in"];
  function qState(o, eq) {
    const share = eq * (o.activeOpponents + 1);
    const eb = [0.5, 0.8, 1.0, 1.3, 1.7, 2.2].filter((t) => share > t).length;
    let fb = 0;
    if (o.toCall) { const frac = o.toCall / Math.max(o.pot, 1); fb = frac <= 0.5 ? 1 : (frac <= 1.0 ? 2 : 3); }
    const pos = o.playersLeftToAct === 0 ? 1 : 0;
    const opp = Math.min(o.activeOpponents, 3) - 1;
    return (((o.street * 7 + eb) * 4 + fb) * 2 + pos) * 3 + opp;
  }
  class QBot {
    constructor(table, { samples = 64, rand = Math.random } = {}) { this.name = "Q-learning"; this.q = table.q; this.samples = samples; this.rand = rand; }
    act(o) {
      const eq = C.equity(o.hole, o.board, o.activeOpponents, this.samples, this.rand);
      const s = qState(o, eq);
      const legal = [1];
      if (o.legal.includes(FOLD)) legal.push(0);
      if (o.legal.includes(BET)) legal.push(2, 3, 4);
      const vals = legal.map((a) => this.q[s][a]);
      const best = Math.max(...vals);
      const ties = legal.filter((a, k) => vals[k] === best);
      const a = ties[Math.floor(this.rand() * ties.length)];
      const info = { equity: eq, values: Object.fromEntries(legal.map((x, k) => [Q_ACTIONS[x], vals[k]])), choice: Q_ACTIONS[a] };
      if (a === 0) return { action: FOLD, info };
      if (a === 1) return { action: o.toCall ? CALL : CHECK, info };
      if (a === 4) return { action: BET, raiseTo: o.maxRaiseTo, info };
      return { action: BET, raiseTo: raiseToFor(o, a === 2 ? 0.5 : 1.0), info };
    }
  }

  // ------------------------------------------------------------------ ReBeL networks
  function erf(x) {                                  // Abramowitz & Stegun 7.1.26
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const gelu = (x) => 0.5 * x * (1 + erf(x / Math.SQRT2));

  // layers: [{type: "linear", w: [out][in], b: [out]} | {type: "layernorm", w, b} | {type: "gelu"} | {type: "softplus"}]
  function runMLP(layers, input) {
    let x = Array.from(input);
    for (const L of layers) {
      if (L.type === "linear") {
        const out = new Array(L.b.length);
        for (let o = 0; o < L.b.length; o++) { let s = L.b[o]; const w = L.w[o]; for (let i = 0; i < x.length; i++) s += w[i] * x[i]; out[o] = s; }
        x = out;
      } else if (L.type === "layernorm") {
        const m = x.reduce((a, c) => a + c, 0) / x.length;
        const v = x.reduce((a, c) => a + (c - m) ** 2, 0) / x.length;
        const d = Math.sqrt(v + 1e-5);
        x = x.map((c, i) => ((c - m) / d) * L.w[i] + L.b[i]);
      } else if (L.type === "gelu") x = x.map(gelu);
      else if (L.type === "softplus") x = x.map((c) => (c > 20 ? c : Math.log1p(Math.exp(c))));
    }
    return x;
  }

  function actionVec(a, frac) { const v = [0, 0, 0, 0, 0]; v[a] = 1; v[4] = a === BET ? frac : 0; return v; }

  class RebelBot {
    constructor(model, { samples = 64, temperature = 0.15, rand = Math.random } = {}) {
      this.name = "ReBeL"; this.m = model; this.samples = samples; this.temperature = temperature; this.rand = rand;
    }
    policy(x) { return runMLP(this.m.policy, x); }
    value(x, a, frac) { return runMLP(this.m.value, Array.from(x).concat(actionVec(a, frac)))[0]; }
    betFrac(x) { return Math.min(Math.max(runMLP(this.m.bet, x)[0], 0.25), 4.0); }

    act(o) {
      const eq = C.equity(o.hole, o.board, o.activeOpponents, this.samples, this.rand);
      const x = featurize(o, eq);
      const logits = this.policy(x);
      const masked = logits.map((l, a) => (o.legal.includes(a) ? l : -Infinity));
      const mx = Math.max(...masked);
      const ex = masked.map((l) => (l === -Infinity ? 0 : Math.exp(l - mx)));
      const z = ex.reduce((a, c) => a + c, 0);
      const prior = ex.map((e) => e / z);
      const betFrac = this.betFrac(x);
      // search: score each legal action (and several bet sizes) with the value network
      const floor = 0.5 / o.legal.length, cands = [];
      for (const a of o.legal) {
        const pa = 0.5 * prior[a] + floor;
        if (a === BET) {
          const sizes = [...new Set([Math.round(betFrac * 100) / 100, 0.5, 1.0, 2.0])].sort((p, q) => p - q);
          for (const s of sizes) cands.push({ a, s, p: pa / sizes.length });
        } else cands.push({ a, s: 0, p: pa });
      }
      for (const c of cands) c.q = c.a === FOLD ? -o.committed / o.bigBlind / 10 : this.value(x, c.a, c.s);
      const zs = cands.map((c) => c.q / this.temperature + Math.log(Math.max(c.p, 1e-6)));
      const zmax = Math.max(...zs);
      const w = zs.map((v) => Math.exp(v - zmax)), ws = w.reduce((a, c) => a + c, 0);
      cands.forEach((c, k) => { c.prob = w[k] / ws; });
      let r = this.rand(), pick = cands[cands.length - 1];
      for (const c of cands) { r -= c.prob; if (r <= 0) { pick = c; break; } }
      const info = { equity: eq, prior, candidates: cands.map((c) => ({ action: c.a, size: c.s, valueBB: c.q * 10, prob: c.prob })) };
      if (pick.a === BET) return { action: BET, raiseTo: raiseToFor(o, pick.s), info };
      return { action: pick.a, info };
    }
  }

  const api = { FOLD, CHECK, CALL, BET, STATE_DIM, Q_ACTIONS, featurize, handFeatures, opponentFeatures, publicFeatures, qState, raiseToFor, runMLP,
    RandomBot, QBot, RebelBot };
  if (typeof module !== "undefined") module.exports = api; else root.PokerBots = api;
})(typeof window !== "undefined" ? window : globalThis);
