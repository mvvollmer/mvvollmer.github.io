/* No-limit hold'em engine for 2-6 players that follows PokerKit's rules exactly
   (verified hand by hand against PokerKit in PokerArena/tests/test_js_engine.py).

   Player indices follow PokerKit's posting order:
     3+ players: 0 = small blind, 1 = big blind, ..., n-1 = button
     heads-up:   0 = big blind, 1 = small blind (= button)

   Betting uses PokerKit's model: each street keeps a queue of players who still owe an action.
   A raise refills the queue with everyone else who has chips; a check, call, or fold removes the
   actor. The last raise size sets the minimum raise; a short all-in raise does not reopen betting
   for players who already acted unless short all-ins add up to a full raise; nobody may raise
   when no other live player could put in more chips. Uncalled bets come back through side pots,
   hands that cannot win any pot are mucked before pots are built, and an odd remainder in a
   split pot goes to the first winner in index order. */
(function (root) {
  const C = typeof module !== "undefined" ? require("./cards.js") : root.PokerCards;

  class Hand {
    /* stacks: starting stacks in index order; hole: [[c, c], ...]; board: 5 cards, revealed by street */
    constructor({ stacks, smallBlind = 1, bigBlind = 2, hole, board }) {
      const n = stacks.length;
      this.n = n; this.bb = bigBlind; this.sb = smallBlind;
      this.starting = stacks.slice();
      this.stacks = stacks.slice();
      this.bets = new Array(n).fill(0);
      this.committed = new Array(n).fill(0);
      this.folded = new Array(n).fill(false);
      this.hole = hole; this.fullBoard = board; this.board = [];
      this.street = 0; this.done = false; this.log = [];
      // raw blind per index (PokerKit reverses the blinds heads-up)
      this.blinds = new Array(n).fill(0);
      if (n === 2) { this.blinds[0] = bigBlind; this.blinds[1] = smallBlind; }
      else { this.blinds[0] = smallBlind; this.blinds[1] = bigBlind; }
      for (let i = 0; i < n; i++) if (this.blinds[i]) this._put(i, this.blinds[i]);
      this._beginStreet();
    }

    _put(i, amount) {
      const a = Math.min(amount, this.stacks[i]);
      this.stacks[i] -= a; this.bets[i] += a; this.committed[i] += a;
    }
    alive(i) { return !this.folded[i]; }
    aliveCount() { return this.folded.filter((f) => !f).length; }
    maxBet() { return Math.max(...this.bets); }
    get actor() { return this.queue.length ? this.queue[0] : null; }

    effectiveStack(i) {
      if (!this.alive(i)) return 0;
      const totals = [];
      for (let j = 0; j < this.n; j++) if (this.alive(j)) totals.push(this.bets[j] + this.stacks[j]);
      totals.sort((a, b) => a - b);
      return Math.min(this.stacks[i], Math.max(0, totals[totals.length - 2] - this.bets[i]));
    }

    _rotated(start) { return [...Array(this.n).keys()].map((k) => (start + k) % this.n); }

    // ------------------------------------------------------------ streets
    _beginStreet() {
      // opener: the player after the largest blind (later streets: index 0)
      let best = -1, bestKey = null;
      for (let i = 0; i < this.n; i++) {
        const key = [this.bets[i] * Math.sign(this.blinds[i]), i];
        if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { bestKey = key; best = i; }
      }
      const opener = this.street === 0 ? (best + 1) % this.n : (this.n - 1 + 1) % this.n;
      this.queue = this._rotated(opener).filter((i) => this.alive(i) && this.stacks[i] > 0 && this.effectiveStack(i) > 0);
      this.lastRaise = 0;               // PokerKit's completion_betting_or_raising_amount
      this.acted = new Set();
      this.shortAllIns = [];
      if (this.queue.length === 1 && this.bets[this.queue[0]] >= this.maxBet()) this.queue = [];
      if (!this.queue.length || this.aliveCount() <= 1) this._endBetting();
    }

    _endBetting() {
      this.queue = [];
      if (this.aliveCount() <= 1 || this.street === 3) return this._finish();
      this.street++;
      this.board = this.fullBoard.slice(0, this.street + 2);
      this.bets.fill(0);
      this._beginStreet();
    }

    // ------------------------------------------------------------ legal info for the actor
    toCall(i = this.actor) { return Math.min(this.stacks[i], this.maxBet() - this.bets[i]); }
    canFold(i = this.actor) { return this.bets[i] < this.maxBet(); }
    canRaise(i = this.actor) {
      if (i === null) return false;
      if (this.toCall(i) < this.lastRaise) return false;                       // facing only a short all-in
      const shortSum = this.shortAllIns.reduce((a, b) => a + b, 0);
      if (this.shortAllIns.length && shortSum < this.lastRaise && this.acted.has(i)) return false;
      if (this.stacks[i] <= this.maxBet() - this.bets[i]) return false;        // can only call
      for (let j = 0; j < this.n; j++)
        if (j !== i && this.alive(j) && this.stacks[j] + this.bets[j] > this.maxBet()) return true;
      return false;                                                             // nobody could call a raise
    }
    minRaiseTo(i = this.actor) {
      return Math.min(this.stacks[i] + this.bets[i], Math.max(this.lastRaise, this.bb) + this.maxBet());
    }
    maxRaiseTo(i = this.actor) { return this.stacks[i] + this.bets[i]; }
    legal() {
      const i = this.actor, r = this.canRaise(i);
      return { actor: i, canFold: this.canFold(i), toCall: this.toCall(i), canRaise: r,
        minRaiseTo: r ? this.minRaiseTo(i) : null, maxRaiseTo: r ? this.maxRaiseTo(i) : null };
    }

    // ------------------------------------------------------------ actions
    fold() {
      if (!this.canFold()) throw new Error("cannot fold when checking is free");
      const i = this.queue.shift();
      this.acted.add(i);
      this.folded[i] = true;
      this._record(i, "fold", 0);
    }
    checkOrCall() {
      const i = this.queue.shift(), amt = this.toCall(i);
      this.acted.add(i);
      this._put(i, amt);
      this._record(i, amt ? "call" : "check", amt);
    }
    raiseTo(total) {
      const i = this.actor;
      if (!this.canRaise(i)) throw new Error("raising is not allowed");
      const lo = this.minRaiseTo(i), hi = this.maxRaiseTo(i);
      if (total < lo || total > hi) throw new Error(`raise must be between ${lo} and ${hi}`);
      const increment = total - this.maxBet();
      this._put(i, total - this.bets[i]);
      this.queue = this._rotated(i + 1).filter((j) => j !== i && this.alive(j) && this.stacks[j] > 0);
      if (increment >= this.lastRaise) { this.acted = new Set([i]); } else { this.acted.add(i); }
      this.lastRaise = Math.max(this.lastRaise, increment);
      if (this.stacks[i] > 0) this.shortAllIns = []; else this.shortAllIns.push(increment);
      if (this.shortAllIns.reduce((a, b) => a + b, 0) >= this.lastRaise) this.shortAllIns = [];
      this._record(i, "raise", total);
    }

    _record(i, kind, amount) {
      this.log.push({ actor: i, kind, amount, street: this.street });
      if (!this.queue.length || this.aliveCount() <= 1) this._endBetting();
    }

    // ------------------------------------------------------------ showdown and payouts
    _finish() {
      this.done = true; this.queue = [];
      const n = this.n, contrib = this.committed.slice();
      // return the uncalled part of the largest contribution
      const order = [...contrib.keys()].sort((x, y) => contrib[y] - contrib[x]);
      const returned = new Array(n).fill(0);
      if (n > 1 && contrib[order[0]] > contrib[order[1]]) {
        returned[order[0]] = contrib[order[0]] - contrib[order[1]];
        contrib[order[0]] = contrib[order[1]];
      }
      const live = [...Array(n).keys()].filter((i) => this.alive(i));
      const win = returned.slice();
      if (live.length === 1) {
        win[live[0]] += contrib.reduce((a, b) => a + b, 0);
      } else {
        this.board = this.fullBoard.slice(0, 5);
        const score = {};
        for (const i of live) score[i] = C.evaluate(this.hole[i].concat(this.board));
        // hands that cannot win any pot are killed (mucked) before chips are pushed
        const survivors = live.filter((i) => this._buildPots(contrib, live).some(
          (pot) => pot.eligible.includes(i) && pot.eligible.every((j) => score[j] <= score[i])));
        this.mucked = live.filter((i) => !survivors.includes(i));
        const pots = this._buildPots(contrib, survivors);
        this.pots = pots;
        for (const pot of pots) {
          if (!pot.amount || !pot.eligible.length) continue;
          const best = Math.max(...pot.eligible.map((i) => score[i]));
          const winners = pot.eligible.filter((i) => score[i] === best);      // index order
          const share = Math.floor(pot.amount / winners.length);
          winners.forEach((w, k) => { win[w] += share + (k === 0 ? pot.amount - share * winners.length : 0); });
        }
        this.scores = score;
      }
      this.winnings = win;
      this.payoffs = win.map((w, i) => w - this.committed[i]);
      for (let i = 0; i < n; i++) this.stacks[i] += win[i];
    }

    // main pot then side pots; consecutive layers with the same eligible players merge (as in PokerKit)
    _buildPots(contrib, eligibleSet) {
      const levels = [...new Set(contrib)].sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      for (const lv of levels) {
        let amount = 0;
        for (let i = 0; i < this.n; i++) if (contrib[i] >= lv) amount += lv - prev;
        prev = lv;
        const eligible = eligibleSet.filter((i) => contrib[i] >= lv);
        const last = pots[pots.length - 1];
        if (last && last.eligible.join() === eligible.join()) last.amount += amount;
        else pots.push({ amount, eligible });
      }
      return pots.filter((p) => p.amount > 0);
    }
  }

  const api = { Hand };
  if (typeof module !== "undefined") module.exports = api; else root.PokerEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
