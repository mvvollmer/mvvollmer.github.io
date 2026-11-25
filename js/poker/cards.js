/* Cards and a 7-card hand evaluator: a line-for-line port of PokerArena/arena/cards.py.
   Cards are ints 0..51 = rankIndex * 4 + suitIndex (rankIndex 0 = deuce .. 12 = ace). */
(function (root) {
  const RANKS = "23456789TJQKA", SUITS = "cdhs";
  const HIGH_CARD = 0, PAIR = 1, TWO_PAIR = 2, TRIPS = 3, STRAIGHT = 4, FLUSH = 5, FULL_HOUSE = 6, QUADS = 7, STRAIGHT_FLUSH = 8;
  const CATEGORY_NAMES = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];

  const card = (t) => RANKS.indexOf(t[0].toUpperCase()) * 4 + SUITS.indexOf(t[1].toLowerCase());
  const cardStr = (c) => RANKS[c >> 2] + SUITS[c & 3];
  const rankOf = (c) => (c >> 2) + 2;
  const suitOf = (c) => c & 3;

  function straightHigh(mask) {
    const wheel = (mask << 1) | ((mask >> 12) & 1);
    for (let high = 13; high > 3; high--) {
      const run = 0b11111 << (high - 4);
      if ((wheel & run) === run) return high - 1;
    }
    return -1;
  }

  function pack(category, kickers) {
    let score = category;
    for (let i = 0; i < 5; i++) score = score * 16 + (i < kickers.length ? kickers[i] : 0);
    return score;
  }

  function evaluate(cards) {
    const rankCounts = new Array(13).fill(0), suitCounts = [0, 0, 0, 0], suitMasks = [0, 0, 0, 0];
    let mask = 0;
    for (const c of cards) {
      const r = c >> 2, s = c & 3;
      rankCounts[r]++; suitCounts[s]++; suitMasks[s] |= 1 << r; mask |= 1 << r;
    }
    let flushScore = -1;
    for (let s = 0; s < 4; s++) {
      if (suitCounts[s] >= 5) {
        const high = straightHigh(suitMasks[s]);
        if (high >= 0) return pack(STRAIGHT_FLUSH, [high]);
        const fr = [];
        for (let r = 12; r >= 0 && fr.length < 5; r--) if ((suitMasks[s] >> r) & 1) fr.push(r);
        flushScore = pack(FLUSH, fr);
        break;
      }
    }
    const quads = [], trips = [], pairs = [], singles = [];
    for (let r = 12; r >= 0; r--) {
      const k = rankCounts[r];
      if (k === 4) quads.push(r); else if (k === 3) trips.push(r); else if (k === 2) pairs.push(r); else if (k === 1) singles.push(r);
    }
    if (quads.length) {
      let kicker = 0;
      for (let r = 0; r < 13; r++) if (rankCounts[r] && r !== quads[0]) kicker = r;
      return pack(QUADS, [quads[0], kicker]);
    }
    if (trips.length && (trips.length > 1 || pairs.length)) {
      const pair = Math.max(...trips.slice(1), ...pairs);
      return pack(FULL_HOUSE, [trips[0], pair]);
    }
    if (flushScore >= 0) return flushScore;
    const high = straightHigh(mask);
    if (high >= 0) return pack(STRAIGHT, [high]);
    if (trips.length) return pack(TRIPS, [trips[0], ...singles.slice(0, 2)]);
    if (pairs.length >= 2) {
      const rest = [...pairs.slice(2), ...singles];
      return pack(TWO_PAIR, [pairs[0], pairs[1], rest.length ? Math.max(...rest) : 0]);
    }
    if (pairs.length) return pack(PAIR, [pairs[0], ...singles.slice(0, 3)]);
    return pack(HIGH_CARD, singles.slice(0, 5));
  }

  const categoryOf = (score) => Math.floor(score / 1048576);   // 16 ** 5

  // Monte Carlo share of the pot against `opponents` random hands (ties split).
  function equity(hole, board, opponents, samples, rand = Math.random) {
    if (opponents <= 0) return 1;
    const known = new Set([...hole, ...board]);
    const deck = [];
    for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
    const needBoard = 5 - board.length, needed = needBoard + 2 * opponents;
    let total = 0;
    for (let s = 0; s < samples; s++) {
      for (let i = 0; i < needed; i++) {             // partial Fisher-Yates
        const j = i + Math.floor(rand() * (deck.length - i));
        const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
      }
      const fullBoard = board.concat(deck.slice(0, needBoard));
      const mine = evaluate(hole.concat(fullBoard));
      let ties = 1, lost = false;
      for (let o = 0; o < opponents; o++) {
        const j = needBoard + 2 * o;
        const theirs = evaluate([deck[j], deck[j + 1]].concat(fullBoard));
        if (theirs > mine) { lost = true; break; }
        if (theirs === mine) ties++;
      }
      if (!lost) total += 1 / ties;
    }
    return total / samples;
  }

  const api = { RANKS, SUITS, CATEGORY_NAMES, HIGH_CARD, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS, STRAIGHT_FLUSH,
    card, cardStr, rankOf, suitOf, evaluate, categoryOf, equity };
  if (typeof module !== "undefined") module.exports = api; else root.PokerCards = api;
})(typeof window !== "undefined" ? window : globalThis);
