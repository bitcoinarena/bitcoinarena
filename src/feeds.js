// Live data layer.
//
//   MarketFeed  -> Binance spot (price/trades/depth) + futures (!forceOrder liquidations)
//   MempoolFeed -> mempool.space websocket (blocks, fee bands) + REST (recent txs)
//
// Both feeds are "self-healing": they reconnect with backoff, and if the socket
// can't be established (geo-block, offline, corporate proxy) they transparently
// switch to a simulator that produces believable synthetic data so the game is
// always playable. When a real socket comes back, sim mode switches off again.

import { Emitter, clamp, rand, randInt, pick } from './util.js';
import { ENDPOINTS, SIM, EVENTS } from './config.js';

class ReconnectingSocket {
  constructor(url, { onOpen, onMessage, onDown, name = 'ws' }) {
    this.url = url; this.onOpen = onOpen; this.onMessage = onMessage; this.onDown = onDown;
    this.name = name; this.attempts = 0; this.dead = false; this.ws = null;
    this.connect();
  }
  connect() {
    if (this.dead) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { return this.retry(); }
    this.ws = ws;
    const guard = setTimeout(() => { if (ws.readyState !== 1) { try { ws.close(); } catch {} } }, 9000);
    ws.onopen = () => { clearTimeout(guard); this.attempts = 0; this.onOpen?.(ws); };
    ws.onmessage = (ev) => { try { this.onMessage?.(JSON.parse(ev.data)); } catch {} };
    ws.onerror = () => {};
    ws.onclose = () => { clearTimeout(guard); this.onDown?.(); this.retry(); };
  }
  retry() {
    if (this.dead) return;
    this.attempts++;
    const wait = Math.min(20000, 800 * Math.pow(1.7, Math.min(this.attempts, 8))) * (0.7 + Math.random() * 0.6);
    setTimeout(() => this.connect(), wait);
  }
  send(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() { this.dead = true; try { this.ws?.close(); } catch {} }
}

/* ------------------------------------------------------------------ market */

export class MarketFeed extends Emitter {
  constructor() {
    super();
    this.price = SIM.startPrice;
    this.change24h = 0;
    this.live = false;
    this.liveLiq = false;
    this.book = { bids: [], asks: [] };
    this.lastRealMsg = 0;
    this.lastPriceMove = 0;
    // -inf, not 0: performance.now() starts at 0, so a 0 here would read as
    // "a liquidation just arrived" and suppress the fallback for the first 45s.
    this.lastLiqAt = -Infinity;
    this.liquidations = [];      // rolling log, newest first
    this.tradeThreshold = 0;     // adaptive 'whale trade' cutoff
    this.tradeMedian = 0;
    this._simPrice = SIM.startPrice;
    this._simVel = 0;
    this._simDrift = rand(-1, 1);
    this._simTradeAcc = 0;
    this._boot();
  }

  _boot() {
    // Seed from REST so the first frame already has a real price even if the
    // socket takes a moment (or never) comes up.
    fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT')
      .then((r) => r.json())
      .then((d) => {
        const p = parseFloat(d.lastPrice);
        if (p > 0) {
          this.price = this._simPrice = p;
          this.lastPriceMove = performance.now();
          this.change24h = parseFloat(d.priceChangePercent) || 0;
          this.emit('price', { price: p, change24h: this.change24h });
        }
      })
      .catch(() => {});

    this.spot = new ReconnectingSocket(ENDPOINTS.binanceSpot, {
      name: 'spot',
      onOpen: () => { this.live = true; this.emit('status', this.status()); },
      onDown: () => { this.live = false; this.emit('status', this.status()); },
      onMessage: (msg) => this._onSpot(msg),
    });

    this.futs = new ReconnectingSocket(ENDPOINTS.binanceFutures, {
      name: 'futures',
      onOpen: () => { this.liveLiq = true; this.emit('status', this.status()); },
      onDown: () => { this.liveLiq = false; this.emit('status', this.status()); },
      onMessage: (msg) => this._onLiquidation(msg),
    });
  }

  /**
   * A socket that is open but silent is worse than one that is closed: it
   * freezes the whole world. Two ways that happens, and both count as stale:
   *   - no messages at all for 8s
   *   - messages still flowing (depth, ticker) but the PRICE hasn't budged in
   *     20s. The battlefield auto-zooms to the recent price range, so a frozen
   *     tape collapses that range to zero and pins the frontline dead centre.
   */
  get fresh() {
    const now = performance.now();
    return this.live && now - this.lastRealMsg < 8000 && now - this.lastPriceMove < 20000;
  }

  /** Liquidations are bursty — allow a long gap before assuming the feed is dry. */
  get liqFresh() { return this.liveLiq && performance.now() - this.lastLiqAt < 45000; }

  status() {
    return {
      live: this.fresh,
      socket: this.live,
      liquidations: this.liqFresh,
      mode: this.fresh ? 'LIVE' : this.live ? 'STALE' : 'SIM',
    };
  }

  _onSpot(msg) {
    const d = msg.data;
    if (!d) return;
    this.lastRealMsg = performance.now();
    if (d.e === 'aggTrade') {
      const price = parseFloat(d.p);
      const qty = parseFloat(d.q);
      // Keep the simulator's momentum coupled to reality so that if the feed
      // does stall, the handover is seamless rather than a visible jump.
      if (this._lastTradePrice) this._simVel = this._simVel * 0.9 + (price - this._lastTradePrice) * 4;
      if (Math.abs(price - (this._lastTradePrice ?? 0)) > 0.005) this.lastPriceMove = performance.now();
      this._lastTradePrice = price;
      this.price = this._simPrice = price;
      this._noteTradeSize(price * qty);
      this.emit('trade', { price, qty, usd: price * qty, buy: !d.m });
      this.emit('price', { price, change24h: this.change24h });
    } else if (d.e === '24hrTicker') {
      this.change24h = parseFloat(d.P);
      const c = parseFloat(d.c);
      if (Math.abs(c - this.price) > 0.005) this.lastPriceMove = performance.now();
      this.price = this._simPrice = c;
      this.emit('price', { price: this.price, change24h: this.change24h });
    } else if (d.bids && d.asks) {
      this.book = {
        bids: d.bids.map((b) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: d.asks.map((a) => [parseFloat(a[0]), parseFloat(a[1])]),
      };
      this.emit('depth', this.book);
    }
  }

  _onLiquidation(msg) {
    const o = msg?.data?.o;
    if (!o) return;
    const price = parseFloat(o.ap || o.p);
    const qty = parseFloat(o.q);
    const usd = price * qty;
    this.lastLiqAt = performance.now();
    // side SELL = a long got liquidated (bulls take the hit) and vice versa.
    this._pushLiq({ symbol: o.s || 'BTCUSDT', side: o.S === 'SELL' ? 'long' : 'short', price, qty, usd, real: true });
  }

  /**
   * "Whale" has to be relative, not a fixed dollar figure. On a quiet tape the
   * biggest trade of the minute is ~$20k; in a frenzy it's millions. So track a
   * rolling window of recent trade sizes and call anything in the top slice a
   * whale — that fires at a sane rate in both regimes.
   */
  _noteTradeSize(usd) {
    const w = this._tradeSizes || (this._tradeSizes = []);
    w.push(usd);
    if (w.length > 400) w.shift();
    const now = performance.now();
    if (w.length >= 40 && now - (this._threshAt || 0) > 2000) {
      this._threshAt = now;
      const sorted = [...w].sort((a, b) => a - b);
      this.tradeThreshold = sorted[Math.floor(EVENTS.whalePercentile * (sorted.length - 1))];
      this.tradeMedian = sorted[Math.floor(0.5 * (sorted.length - 1))];
    }
  }

  /** Is this trade an outlier for current conditions? */
  isWhaleTrade(usd) {
    return usd >= EVENTS.whaleFloorUsd && this.tradeThreshold > 0 && usd >= this.tradeThreshold;
  }

  _pushLiq(liq) {
    liq.at = Date.now();
    this.liquidations.unshift(liq);
    if (this.liquidations.length > 60) this.liquidations.pop();
    this.emit('liquidation', liq);
  }

  /**
   * Simulation tick. Price action and liquidations are simulated independently,
   * because in a quiet market the trade feed can be perfectly healthy while the
   * liquidation feed stays silent for minutes.
   */
  update(dt) {
    if (SIM.liquidations && !this.liqFresh) this._simLiquidations(dt);
    if (this.fresh) return;
    // Mean-reverting random walk with momentum bursts, so the terrain still
    // looks like a chart rather than white noise.
    this._simDrift += rand(-1, 1) * dt * 0.35;
    this._simDrift = clamp(this._simDrift * 0.995, -2.2, 2.2);
    if (Math.random() < dt * 0.05) this._simDrift += rand(-3, 3);
    this._simVel += (this._simDrift * 3.2 + rand(-14, 14)) * dt;
    this._simVel *= Math.exp(-1.4 * dt);
    this._simPrice = Math.max(1000, this._simPrice + this._simVel * dt * 9);
    this.price = this._simPrice;
    this.change24h = clamp(this.change24h + this._simVel * dt * 0.004, -9, 9);
    this.emit('price', { price: this.price, change24h: this.change24h });

    // Trades
    this._simTradeAcc += dt * (12 + Math.abs(this._simVel) * 1.5);
    while (this._simTradeAcc > 1) {
      this._simTradeAcc -= 1;
      const buy = Math.random() < 0.5 + clamp(this._simVel * 0.02, -0.3, 0.3);
      const qty = Math.pow(Math.random(), 4) * 6 + 0.002;
      this._noteTradeSize(this.price * qty);
      this.emit('trade', { price: this.price, qty, usd: this.price * qty, buy });
    }

    // Book
    if (!this._bookAcc || (this._bookAcc -= dt) <= 0) {
      this._bookAcc = 0.12;
      const mk = (dir) => Array.from({ length: 20 }, (_, i) => {
        const p = this.price * (1 + dir * (i + 1) * 0.0004);
        const wall = Math.random() < 0.12 ? rand(8, 45) : rand(0.2, 4);
        return [p, wall];
      });
      this.book = { bids: mk(-1), asks: mk(1) };
      this.emit('depth', this.book);
    }

  }

  /** Liquidations cluster around violent moves — same as the real thing. */
  _simLiquidations(dt) {
    if (!this.price) return;
    const violence = Math.abs(this._simVel) / 14;
    this._liqBurst = Math.max(0, (this._liqBurst || 0) - dt);
    if (Math.random() < dt * 0.03) this._liqBurst = rand(1.5, 5);   // cascades come in clusters
    const rate = 0.09 + violence * 0.8 + (this._liqBurst > 0 ? 1.0 : 0);
    if (Math.random() < dt * rate) {
      const side = this._simVel < 0 || Math.random() < 0.5 ? 'long' : 'short';
      const usd = Math.pow(Math.random(), 3.2) * 4_000_000 + 8000;
      this._pushLiq({
        symbol: pick(['BTCUSDT', 'BTCUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
        side,
        price: this.price * (1 + rand(-0.004, 0.004)),
        qty: usd / this.price,
        usd,
        real: false,
      });
    }
  }
}

/* ----------------------------------------------------------------- mempool */

const SIM_MINERS = ['Foundry USA', 'AntPool', 'ViaBTC', 'F2Pool', 'MARA Pool', 'Binance Pool', 'SpiderPool'];

export class MempoolFeed extends Emitter {
  constructor() {
    super();
    this.live = false;
    this.tipHeight = 0;
    this.mempoolCount = 0;
    this.mempoolVsize = 0;
    this.feeBands = [1, 2, 5, 12];   // projected block median fees (sat/vB)
    this.recommended = { fastestFee: 8, halfHourFee: 5, hourFee: 3, economyFee: 2, minimumFee: 1 };
    this.seen = new Set();
    this._simAcc = 0;
    this._simBlockIn = -Math.log(Math.random()) * SIM.blockMeanSec;
    this._boot();
  }

  _boot() {
    this.ws = new ReconnectingSocket(ENDPOINTS.mempoolWs, {
      name: 'mempool',
      onOpen: (ws) => {
        this.live = true;
        ws.send(JSON.stringify({ action: 'want', data: ['blocks', 'stats', 'mempool-blocks', 'live-2h-chart'] }));
        this.emit('status', this.status());
      },
      onDown: () => { this.live = false; this.emit('status', this.status()); },
      onMessage: (m) => this._onWs(m),
    });

    this._pollRecent();
    this._pollStats();
    setInterval(() => this._pollRecent(), 4000);
    setInterval(() => this._pollStats(), 30000);
  }

  status() { return { live: this.live, mode: this.live ? 'LIVE' : 'SIM' }; }

  _onWs(m) {
    if (m.block) this._emitBlock(m.block, true);
    if (Array.isArray(m.blocks) && m.blocks.length) this.tipHeight = Math.max(this.tipHeight, m.blocks.at(-1).height || 0);
    if (m['mempool-blocks']) {
      const mb = m['mempool-blocks'];
      this.feeBands = mb.slice(0, 6).map((b) => b.medianFee || 1);
      this.emit('bands', this.feeBands);
    }
    if (m.mempoolInfo) {
      this.mempoolCount = m.mempoolInfo.size || this.mempoolCount;
      this.mempoolVsize = (m.mempoolInfo.bytes || 0) / 1e6;
      this.emit('stats', { count: this.mempoolCount, vsizeMB: this.mempoolVsize, bands: this.feeBands });
    }
    if (m.fees) this.recommended = m.fees;
    // Some deployments push live transactions; use them if they show up.
    if (Array.isArray(m.transactions)) for (const tx of m.transactions) this._emitTx(tx);
  }

  async _pollRecent() {
    if (document.hidden) return;
    try {
      const r = await fetch(`${ENDPOINTS.mempoolApi}/mempool/recent`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const list = await r.json();
      this.live = true;
      for (const tx of list) this._emitTx(tx);
      this.emit('status', this.status());
    } catch {
      /* REST down too -> simulator carries the load in update() */
    }
  }

  async _pollStats() {
    if (document.hidden) return;
    try {
      const [mp, fees, tip] = await Promise.all([
        fetch(`${ENDPOINTS.mempoolApi}/mempool`).then((r) => r.json()),
        fetch(`${ENDPOINTS.mempoolApi}/v1/fees/recommended`).then((r) => r.json()),
        fetch(`${ENDPOINTS.mempoolApi}/blocks/tip/height`).then((r) => r.text()),
      ]);
      this.mempoolCount = mp.count ?? this.mempoolCount;
      this.mempoolVsize = (mp.vsize ?? 0) / 1e6;
      this.recommended = fees ?? this.recommended;
      const h = parseInt(tip, 10);
      if (h > 0) this.tipHeight = Math.max(this.tipHeight, h);
      this.emit('stats', { count: this.mempoolCount, vsizeMB: this.mempoolVsize, bands: this.feeBands });
    } catch {}
  }

  _emitTx(tx) {
    if (!tx?.txid || this.seen.has(tx.txid)) return;
    this.seen.add(tx.txid);
    if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-2000));
    const vsize = tx.vsize || tx.weight / 4 || 200;
    this.emit('tx', {
      txid: tx.txid,
      vsize,
      fee: tx.fee ?? 0,
      feeRate: (tx.fee ?? 0) / vsize,
      valueSats: tx.value ?? 0,
      real: true,
      seenAt: performance.now(),
    });
  }

  _emitBlock(b, real) {
    this.tipHeight = Math.max(this.tipHeight, b.height);
    this.emit('block', {
      height: b.height,
      txCount: b.tx_count ?? b.txCount ?? 0,
      size: b.size ?? 0,
      weight: b.weight ?? 0,
      totalFees: b.extras?.totalFees ?? b.totalFees ?? 0,
      medianFee: b.extras?.medianFee ?? b.medianFee ?? 0,
      miner: b.extras?.pool?.name ?? b.miner ?? 'Unknown',
      real,
    });
  }

  /** Simulator — runs only while both WS and REST are unreachable. */
  update(dt) {
    if (this.live) return;
    this.mempoolCount = clamp(this.mempoolCount + rand(-40, 45), 3000, 180000);
    this.mempoolVsize = this.mempoolCount * 0.00035;
    this._simAcc += dt * (3 + this.mempoolCount / 20000);
    while (this._simAcc > 1) {
      this._simAcc -= 1;
      const vsize = Math.round(140 + Math.pow(Math.random(), 3) * 2200);
      const feeRate = Math.max(1, Math.pow(Math.random(), 2.6) * 260 + 1);
      const valueSats = Math.round(Math.pow(Math.random(), 5) * 900e8 + 1e4);
      const txid = Array.from({ length: 64 }, () => '0123456789abcdef'[randInt(0, 15)]).join('');
      this.emit('tx', { txid, vsize, fee: Math.round(feeRate * vsize), feeRate, valueSats, real: false, seenAt: performance.now() });
    }
    this._simBlockIn -= dt;
    if (this._simBlockIn <= 0) {
      this._simBlockIn = -Math.log(Math.random()) * SIM.blockMeanSec;
      this.tipHeight = (this.tipHeight || 962700) + 1;
      this._emitBlock({
        height: this.tipHeight,
        tx_count: randInt(1800, 4200),
        size: randInt(900000, 1600000),
        weight: 3_980_000,
        totalFees: Math.round(rand(0.03, 0.6) * 1e8),
        medianFee: Math.round(rand(2, 90)),
        miner: pick(SIM_MINERS),
      }, false);
    }
  }
}
