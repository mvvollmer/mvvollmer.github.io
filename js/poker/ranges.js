/* Opponent modeling: player types, session tendencies, and hand ranges.
   A line-for-line port of PokerArena/arena/ranges.py (parity checked in tests/test_js_ranges.py).

   Every player has a public range: a weight for each of the 1,326 hole-card combos, narrowed after each
   of their actions. Within the current range the weakest hands fold (or check), the middle calls, and the
   strongest raise (or bet), with cut points set by how often that player takes each action in that spot:
   a profile for their type, moved toward what they have actually done this session. Random players'
   actions carry no information, so their ranges are never narrowed. Humans appear as "unknown". */
(function (root) {
  const C = typeof module !== "undefined" ? require("./cards.js") : root.PokerCards;
  const TYPES = ["random", "q", "rebel", "unknown"];
  const COMBOS = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) COMBOS.push([a, b]);
  const N = COMBOS.length;                       // 1326
  const GENERIC_PRIOR = [[0.70, 0.30], [0.55, 0.30, 0.15], [0.60, 0.40], [0.40, 0.45, 0.15]];
  const PRIOR_STRENGTH = 8.0, TAU = 0.08, FLOOR = 0.05;

  let profiles = {}, preflop = null;
  function setData({ typeProfiles, preflopStrength }) {
    profiles = typeProfiles || {};
    preflop = new Float64Array(N);
    COMBOS.forEach(([a, b], i) => { preflop[i] = preflopStrength[handClass(a, b)]; });
  }

  function handClass(a, b) {
    const ra = a >> 2, rb = b >> 2, hi = Math.max(ra, rb), lo = Math.min(ra, rb);
    if (hi === lo) return C.RANKS[hi] + C.RANKS[hi];
    return C.RANKS[hi] + C.RANKS[lo] + ((a & 3) === (b & 3) ? "s" : "o");
  }

  function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  function upperBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; }

  function comboStrength(board) {
    if (!board.length) return Float64Array.from(preflop);
    const used = new Set(board), scores = new Array(N).fill(-1), valid = [];
    COMBOS.forEach(([a, b], i) => { if (!used.has(a) && !used.has(b)) { scores[i] = C.evaluate([a, b, ...board]); valid.push(scores[i]); } });
    valid.sort((x, y) => x - y);
    const s = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      if (scores[i] < 0) { s[i] = -1; continue; }
      const lo = lowerBound(valid, scores[i]), hi = upperBound(valid, scores[i]);
      s[i] = (lo + 0.5 * (hi - lo)) / Math.max(valid.length, 1);
    }
    return s;
  }

  const sigmoid = (x) => 1 / (1 + Math.exp(-x));

  class PlayerModel {
    constructor(type) { this.type = TYPES.includes(type) ? type : "unknown"; this.counts = [[0, 0], [0, 0, 0], [0, 0], [0, 0, 0]]; }
    prior(ctx) { const p = profiles[this.type]; return p ? p[ctx] : GENERIC_PRIOR[ctx]; }
    freqs(ctx) {
      const pr = this.prior(ctx), c = this.counts[ctx], n = c.reduce((a, b) => a + b, 0);
      return c.map((ck, k) => (ck + PRIOR_STRENGTH * pr[k]) / (n + PRIOR_STRENGTH));
    }
    observe(ctx, code) { this.counts[ctx][code] += 1; }
    stats() {
      const f1 = this.freqs(1), f3 = this.freqs(3), g0 = this.freqs(0), g2 = this.freqs(2);
      const n = this.counts.reduce((a, c) => a + c.reduce((x, y) => x + y, 0), 0);
      return [0.5 * (f1[0] + f3[0]), 0.25 * (f1[2] + f3[2] + g0[1] + g2[1]), Math.min(n, 60) / 60];
    }
  }

  class RangeTracker {
    constructor(models) {
      this.models = models;
      this.w = models.map(() => new Float64Array(N).fill(1));
      this.board = [];
      this.strength = Float64Array.from(preflop);
      this.order = null;
    }
    setBoard(board) {
      if (board.length === this.board.length) return;
      this.board = board.slice();
      const dead = new Set(board);
      for (const w of this.w) COMBOS.forEach(([a, b], i) => { if (dead.has(a) || dead.has(b)) w[i] = 0; });
      this.strength = comboStrength(board);
      this.order = null;
    }
    _order() {                                        // stable argsort by strength
      if (!this.order) { const s = this.strength; this.order = [...Array(N).keys()].sort((i, j) => s[i] - s[j] || i - j); }
      return this.order;
    }
    percentile(p) {
      const w = this.w[p], order = this._order(), u = new Float64Array(N);
      let cum = 0, total = 0;
      for (const i of order) total += w[i];
      if (total <= 0) total = 1;
      for (const i of order) { cum += w[i]; u[i] = (cum - 0.5 * w[i]) / total; }
      return u;
    }
    update(p, street, facing, code) {
      const m = this.models[p], ctx = (street === 0 ? 0 : 2) + (facing ? 1 : 0);
      const freqs = m.freqs(ctx);
      m.observe(ctx, code);
      if (m.type === "random") return;
      const u = this.percentile(p);
      const lo = freqs.slice(0, code).reduce((a, b) => a + b, 0), hi = lo + freqs[code];
      const w = this.w[p];
      let s = 0;
      for (let i = 0; i < N; i++) {
        let like = 1;
        if (code > 0) like *= sigmoid((u[i] - lo) / TAU);
        if (code < freqs.length - 1) like *= sigmoid((hi - u[i]) / TAU);
        w[i] *= FLOOR + (1 - FLOOR) * like;
        s += w[i];
      }
      if (s > 0) { const k = s / N; for (let i = 0; i < N; i++) w[i] /= k; }
    }
    rangeStrength(p) {
      const w = this.w[p], st = this.strength;
      let num = 0, den = 0;
      for (let i = 0; i < N; i++) if (st[i] >= 0) { num += w[i] * st[i]; den += w[i]; }
      return num / Math.max(den, 1e-9);
    }
    /* the most likely starting-hand classes in a range, for the "AI thinking" panel: ranked by average
       weight per combo (so offsuit hands, which have more combos, do not crowd the list), plus how
       concentrated the range is (1 = no information yet) */
    topClasses(p, exclude = [], k = 6) {
      const w = this.w[p], ex = new Set(exclude), mass = {}, n = {};
      let total = 0, live = 0, maxW = 0;
      COMBOS.forEach(([a, b], i) => {
        if (ex.has(a) || ex.has(b) || this.strength[i] < 0) return;
        const c = handClass(a, b); mass[c] = (mass[c] || 0) + w[i]; n[c] = (n[c] || 0) + 1; total += w[i]; live++;
      });
      const avg = Object.keys(mass).map((c) => [c, mass[c] / n[c]]).sort((x, y) => y[1] - x[1]);
      const mean = total / Math.max(live, 1);
      return { hands: avg.slice(0, k).map(([c]) => c), focus: avg.length ? avg[0][1] / Math.max(mean, 1e-9) : 1 };
    }
  }

  // Monte Carlo share of the pot against opponents whose hands are drawn from their ranges.
  function rangeEquity(hole, board, ranges, samples, rand = Math.random) {
    if (!ranges.length) return 1;
    const known = new Set([...hole, ...board]);
    const cums = ranges.map((w) => {
      const cum = new Float64Array(N);
      let tot = 0;
      for (let i = 0; i < N; i++) { const [a, b] = COMBOS[i]; tot += known.has(a) || known.has(b) ? 0 : w[i]; cum[i] = tot; }
      if (tot <= 0) { tot = 0; for (let i = 0; i < N; i++) { const [a, b] = COMBOS[i]; tot += known.has(a) || known.has(b) ? 0 : 1; cum[i] = tot; } }
      for (let i = 0; i < N; i++) cum[i] /= tot;
      return cum;
    });
    const needBoard = 5 - board.length, base = [];
    for (let c = 0; c < 52; c++) if (!known.has(c)) base.push(c);
    let total = 0;
    for (let s = 0; s < samples; s++) {
      const used = new Set(), hands = [];
      for (const cum of cums) {
        let pick = null;
        for (let t = 0; t < 12; t++) {
          const i = Math.min(upperBound(cum, rand()), N - 1), [a, b] = COMBOS[i];
          if (!used.has(a) && !used.has(b)) { pick = [a, b]; break; }
        }
        if (!pick) { const rest = base.filter((c) => !used.has(c)); const i = Math.floor(rand() * rest.length); let j = Math.floor(rand() * (rest.length - 1)); if (j >= i) j++; pick = [rest[i], rest[j]]; }
        used.add(pick[0]); used.add(pick[1]); hands.push(pick);
      }
      const rest = base.filter((c) => !used.has(c));
      for (let i = 0; i < needBoard; i++) { const j = i + Math.floor(rand() * (rest.length - i)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      const full = board.concat(rest.slice(0, needBoard)), mine = C.evaluate(hole.concat(full));
      let ties = 1, lost = false;
      for (const h of hands) { const t = C.evaluate(h.concat(full)); if (t > mine) { lost = true; break; } if (t === mine) ties++; }
      if (!lost) total += 1 / ties;
    }
    return total / samples;
  }

  function actionCode(toCall, kind) {
    if (toCall > 0) return [true, { fold: 0, call: 1, raise: 2 }[kind]];
    return [false, { check: 0, raise: 1 }[kind]];
  }

  const api = { TYPES, COMBOS, N, setData, handClass, comboStrength, PlayerModel, RangeTracker, rangeEquity, actionCode };
  if (typeof module !== "undefined") module.exports = api; else root.PokerRanges = api;
})(typeof window !== "undefined" ? window : globalThis);
