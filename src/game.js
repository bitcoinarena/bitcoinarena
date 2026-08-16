import * as THREE from 'three';
import { Stage } from './render/scene.js';
import { FX } from './render/fx.js';
import { Battlefield } from './world/battlefield.js';
import { Logistics, feeTier } from './world/logistics.js';
import { MarketFeed, MempoolFeed } from './feeds.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { bindInput } from './input.js';
import { LANES, TRUCKS, SCORE, COSTS, WORLD, CAMERAS } from './config.js';
import { Emitter, clamp, lerp, approach, rand, fmtUsd, fmtNum, shortId, pick } from './util.js';

export class Game {
  constructor(canvas) {
    this.events = new Emitter();
    this.stage = new Stage(canvas);
    this.fx = new FX(this.stage.scene);
    this.bf = new Battlefield(this.stage.scene, this.fx);
    this.audio = new Audio();
    this.logistics = new Logistics(this.stage.scene, this.fx, this.bf, this.audio, this.events);
    this.ui = new UI(this);

    this.market = new MarketFeed();
    this.mempool = new MempoolFeed();

    // ---- run state
    this.started = false;
    this.spectator = false;
    this.score = 0;
    this.fees = 0;                 // banked sats -> upgrade currency
    this.owned = new Set(['vanguard']);
    this.selectedTruck = this.logistics.trucks[0];
    this.lane = 'bull';
    this.blockWindow = 0;
    this.delivered = 0;
    this.lastBlockAt = performance.now();
    this.blockIntervalHint = 600;

    // ---- derived market state
    this.price = 0;
    this.change24h = 0;
    this.flow = 0;                 // buy/sell imbalance, -1..1
    this.volatility = 0;
    this.bias = 0;
    this._volAcc = 0;
    this._lastPrice = 0;
    this._stingCd = 0;
    this._fps = 60;
    this._uiAcc = 0;
    this._spawnBudget = 0;

    this._wireFeeds();
    this._wireEvents();
    bindInput(this);

    this.setCamera('cinematic');
    this.ui.setCamera('cinematic');
  }

  /* --------------------------------------------------------------- feed */

  _wireFeeds() {
    this.market.on('price', ({ price, change24h }) => {
      this.price = price;
      this.change24h = change24h;
    });

    this.market.on('trade', ({ usd, buy, price }) => {
      const w = clamp(usd / 60000, 0, 1);
      this.flow = clamp(this.flow + (buy ? w : -w) * 0.35, -1, 1);
      if (usd > 250000) {
        this.events.emit('log', {
          kind: buy ? 'deliver' : 'liq',
          text: `${buy ? 'BULL' : 'BEAR'} block trade ${fmtUsd(usd)} @ ${fmtUsd(price)}`,
        });
      }
    });

    this.market.on('depth', (book) => { this.bf.setDepth(book); this.book = book; });

    this.market.on('liquidation', (liq) => {
      // The shell is in the air for a beat before it lands — impact effects and
      // damage resolve in the callback so the warning and the hit line up.
      this.bf.airstrike(liq.price, liq.usd, liq.side, (hit) => {
        this.logistics.shockwave(hit.x, hit.z, hit.power);
        this.stage.addShake(clamp(hit.power * 0.5, 0.15, 1.6));
        this.audio.explosion(clamp(hit.power * 0.6, 0.3, 1.4));
        this.fx.text(`${fmtUsd(liq.usd)} REKT`, hit.x, hit.y + 16, hit.z, {
          color: liq.side === 'long' ? '#ff6b78' : '#5ff0a8', life: 2.4, scale: 0.7 + hit.power * 0.3,
        });
      });
      this.events.emit('log', {
        kind: 'liq',
        text: `AIRSTRIKE — ${fmtUsd(liq.usd)} ${liq.side.toUpperCase()} liquidation on ${(liq.symbol || 'BTCUSDT').replace('USDT', '')} hits ${liq.side === 'long' ? 'BULL' : 'BEAR'} lines @ ${fmtUsd(liq.price)}${liq.real ? '' : ' (sim)'}`,
      });
      if (liq.usd > 1_000_000) this.ui.toast(`${fmtUsd(liq.usd)} LIQUIDATED`, liq.side === 'long' ? 'var(--bear)' : 'var(--bull)');
    });

    this.mempool.on('tx', (tx) => {
      if (!this.price) return;
      // Smart sampling: always take high fee rates and whales, sample the rest.
      const whale = tx.valueSats / 1e8 >= 5;
      const keep = whale || tx.feeRate > 25 || Math.random() < 0.55;
      if (!keep) return;
      this.logistics.addPackage(tx, this.price);
    });

    this.mempool.on('block', (b) => this._onBlock(b));

    this.mempool.on('stats', () => {});

    const status = () => this.ui.setStatus(this.market.status(), this.mempool.status(), this._fps);
    this.market.on('status', status);
    this.mempool.on('status', status);
  }

  _wireEvents() {
    this.events.on('log', ({ kind, text }) => this.ui.log(kind, text));
    this.events.on('radio', ({ text }) => this.ui.radio(text));
    this.events.on('shake', (v) => this.stage.addShake(v));
    this.events.on('deliver', (d) => this._onDeliver(d));
  }

  /* ------------------------------------------------------------ scoring */

  _onDeliver({ truck, cargo }) {
    if (!cargo.length) return;
    const laneMult = LANES[truck.lane].mult;
    const windowMult = this.blockWindow > 0 ? SCORE.windowMult : 1;
    let pts = 0, sats = 0, rescued = 0;

    for (const p of cargo) {
      const feeMult = 1 + Math.log10(1 + p.feeRate) * SCORE.feeBonus;
      const worth = SCORE.handling + SCORE.valueWeight * Math.log10(1 + p.usd) + SCORE.feeWeight * p.fee;
      let v = worth * feeMult * laneMult * windowMult;
      if (this.logistics.time - p.born > SCORE.rescueAgeSec && p.tier.name === 'Stuck') {
        v += SCORE.rescueBonus;
        rescued++;
      }
      pts += v;
      sats += p.fee * laneMult;
    }
    // Filling the truck to the brim is what a miner would do — reward it.
    const used = cargo.reduce((a, p) => a + p.vsize, 0);
    const fill = used / truck.spec.capacity;
    if (fill > 0.9) { pts *= SCORE.fullBlockBonus; this.ui.toast('FULL BLOCK TEMPLATE +25%', 'var(--bull)'); }

    this.score += pts;
    this.fees += sats;
    this.delivered += cargo.length;

    this.audio.cash(laneMult * windowMult);
    this.fx.text(`+${fmtNum(pts)}`, WORLD.depotX - 14, 20, 0, { color: '#ffd447', life: 2.2, scale: 1.5 });
    this.events.emit('log', {
      kind: 'deliver',
      text: `${cargo.length} package${cargo.length > 1 ? 's' : ''} (${used.toLocaleString('en-US')} vB) delivered via ${LANES[truck.lane].name} — +${fmtNum(pts)} pts${windowMult > 1 ? ' ×3 BLOCK WINDOW' : ''}`,
    });
    if (rescued) this.events.emit('log', { kind: 'ops', text: `Rescued ${rescued} stuck low-fee package${rescued > 1 ? 's' : ''} — the mempool thanks you` });
  }

  _onBlock(b) {
    const gap = (performance.now() - this.lastBlockAt) / 1000;
    if (gap > 20) this.blockIntervalHint = lerp(this.blockIntervalHint, clamp(gap, 60, 3600), 0.25);
    this.lastBlockAt = performance.now();
    this.blockWindow = SCORE.blockWindowSec;

    this.audio.blockFound();
    this.stage.addShake(1.4);
    this.fx.confetti(WORLD.depotX - 10, 22, 0, 320);
    this.logistics.spawnConvoy(b.height);
    this.logistics.pushBlockMarker();
    this.ui.toast(`BLOCK ${b.height.toLocaleString('en-US')} FOUND`, 'var(--orange)');
    this.fx.text(`BLOCK ${b.height}`, WORLD.depotX - 30, 30, 0, { color: '#f7931a', life: 3.4, scale: 2 });

    this.events.emit('log', {
      kind: 'block',
      text: `BLOCK ${b.height.toLocaleString('en-US')} mined by ${b.miner} — ${b.txCount.toLocaleString('en-US')} txs, ${(b.totalFees / 1e8).toFixed(3)} BTC fees, median ${b.medianFee} sat/vB${b.real ? '' : ' (sim)'}`,
    });

    // Any loaded truck at the plaza seals immediately and rolls out — that is
    // exactly what a miner does the moment a template is ready.
    for (const t of this.logistics.trucks) {
      if (t.state === 'idle' && t.cargo.length) {
        this.logistics.dispatch(t, t.lane);
        this.events.emit('log', { kind: 'ops', text: `${t.spec.name} sealed and rolling — block window open for ${SCORE.blockWindowSec}s` });
      }
    }

    // Packages that beat the block's median fee get confirmed without you.
    const median = Math.max(1, b.medianFee || 1);
    let mined = 0;
    for (const p of [...this.logistics.packages]) {
      if (p.state !== 'plaza') continue;
      if (p.feeRate >= median && Math.random() < 0.8) {
        this.logistics._remove(p, true);
        this.fx.spawn(p.pos.x, p.pos.y + 1, p.pos.z, { color: 0xf7931a, count: 8, size: 1.4, life: 0.8, speed: 7 });
        mined++;
      }
    }
    if (mined) this.events.emit('log', { kind: 'ops', text: `${mined} packages confirmed into block ${b.height} without you (fee ≥ ${median} sat/vB)` });
  }

  /* ------------------------------------------------------------- player */

  start(spectator = false) {
    this.started = true;
    this.spectator = spectator;
    document.body.classList.toggle('spectator', spectator);
    this.audio.resume();
    this.ui.showHud();
    this.ui.log('ops', spectator
      ? 'WAR ROOM online. Sit back and watch the war over Bitcoin unfold.'
      : 'Logistics Commander on deck. Load packages, pick a route, survive.');
    this.setCamera(spectator ? 'cinematic' : 'plaza');
  }

  setCamera(mode) {
    if (!CAMERAS.includes(mode)) return;
    this.stage.setMode(mode);
    this.ui.setCamera(mode);
  }

  selectTruck(id) {
    const t = this.logistics.trucks.find((x) => x.id === id);
    if (t) { this.selectedTruck = t; this.audio.click(); }
  }

  setLane(lane) {
    if (!LANES[lane]) return;
    this.lane = lane;
    if (this.selectedTruck && this.selectedTruck.state === 'idle') this.selectedTruck.lane = lane;
    this.audio.click();
  }

  togglePackage(p) {
    if (!p || p.state !== 'plaza') return;
    if (this.logistics.selected.has(p)) this.logistics.selected.delete(p);
    else this.logistics.selected.add(p);
    this.audio.click();
  }

  loadSelected() {
    const t = this.selectedTruck;
    if (!t) return;
    let n = 0;
    for (const p of [...this.logistics.selected]) if (this.logistics.load(t, p)) n++;
    if (!n) this.audio.error();
  }

  autoLoad() {
    if (this.selectedTruck) this.logistics.autoLoad(this.selectedTruck);
  }

  dispatch() {
    const t = this.selectedTruck;
    if (!t) return;
    this.logistics.dispatch(t, this.lane);
  }

  boost() {
    const t = this.selectedTruck;
    if (!t || t.state !== 'enroute' || this.fees < COSTS.boost) return this.audio.error();
    this.fees -= COSTS.boost;
    t.boost = 3.5;
    this.audio.horn();
    this.events.emit('log', { kind: 'ops', text: `${t.spec.name} burning ${fmtNum(COSTS.boost)} sat of fuel — boost engaged` });
  }

  repair() {
    const t = this.selectedTruck;
    if (!t || t.hp >= t.maxHp || this.fees < COSTS.repair) return this.audio.error();
    this.fees -= COSTS.repair;
    t.hp = t.maxHp;
    if (t.state === 'wrecked') t.state = 'idle';
    this.audio.stamp();
    this.events.emit('log', { kind: 'ops', text: `${t.spec.name} repaired for ${fmtNum(COSTS.repair)} sat` });
  }

  /** RBF: pay fees to bump every selected package straight to VIP. */
  rbf() {
    const sel = [...this.logistics.selected].filter((p) => p.state === 'plaza');
    if (!sel.length) return this.audio.error();
    const cost = sel.reduce((a, p) => a + Math.max(COSTS.rbfMin, p.vsize * COSTS.rbfPerVbyte), 0);
    if (this.fees < cost) {
      this.events.emit('log', { kind: 'ops', text: `RBF needs ${fmtNum(cost)} sat — you have ${fmtNum(this.fees)}` });
      return this.audio.error();
    }
    this.fees -= cost;
    for (const p of sel) {
      p.feeRate = Math.max(p.feeRate * 2.5, 120);
      p.fee = Math.round(p.feeRate * p.vsize);
      p.tier = feeTier(p.feeRate, this.logistics.feeBaseline);
      this.fx.spawn(p.pos.x, p.pos.y + 2, p.pos.z, { color: 0xffd447, count: 22, size: 1.8, life: 1.1, speed: 8 });
    }
    this.audio.stamp();
    this.events.emit('log', { kind: 'ops', text: `RBF: bumped ${sel.length} package(s) to VIP for ${fmtNum(cost)} sat` });
  }

  buyTruck(spec) {
    if (this.owned.has(spec.id) || this.fees < spec.cost) return this.audio.error();
    this.fees -= spec.cost;
    this.owned.add(spec.id);
    const t = this.logistics.addTruck(spec);
    this.selectedTruck = t;
    this.audio.cash(2);
    this.ui.toast(`${spec.name.toUpperCase()} ACQUIRED`, 'var(--bull)');
    this.events.emit('log', { kind: 'ops', text: `${spec.name} joins the fleet — ${spec.desc}` });
  }

  toggleEdu() {
    this.ui.el.edu.classList.toggle('hidden');
    this.audio.click();
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.muted);
    document.getElementById('qa-mute').textContent = this.audio.muted ? '🔇' : '🔊';
  }

  /* --------------------------------------------------------------- loop */

  update(dt) {
    this.market.update(dt);
    this.mempool.update(dt);

    // derived market signals
    this.flow = approach(this.flow, 0, 0.9, dt);
    if (this._lastPrice) {
      const d = Math.abs(this.price - this._lastPrice) / Math.max(1, this._lastPrice);
      this._volAcc = approach(this._volAcc, d * 900, 2.5, dt);
    }
    this._lastPrice = this.price;
    this.volatility = clamp(this._volAcc, 0, 1);
    this.bias = clamp(this.flow * 0.55 + clamp(this.change24h / 4, -1, 1) * 0.45, -1, 1);

    this.bf.volatility = this.volatility;
    this.bf.setFlow(this.flow);
    this.bf.feedPrice(this.price || 0, dt);

    const ctx = {
      volatility: this.volatility,
      manualSteer: this.manualSteer,
      onGunfire: () => this.audio.battle(0.3 + this.volatility),
    };
    this.bf.update(dt, ctx);
    this.logistics.update(dt, ctx);
    this.fx.update(dt);

    if (this.blockWindow > 0) this.blockWindow = Math.max(0, this.blockWindow - dt);

    // audio intensity follows the war
    this.audio.setIntensity(clamp(this.volatility * 0.8 + Math.abs(this.flow) * 0.4, 0, 1));

    // price stingers
    this._stingCd -= dt;
    if (this._stingCd <= 0 && Math.abs(this.change24h) > 1.5 && this.volatility > 0.55) {
      this._stingCd = 22;
      if (this.flow > 0.2) { this.audio.numberGoUp(); this.ui.toast('NUMBER GO UP', 'var(--bull)'); }
      else if (this.flow < -0.2) { this.audio.numberGoDown(); this.ui.toast('NUMBER GO DOWN', 'var(--bear)'); }
    }

    this.stage.update(dt, {
      bias: this.bias,
      volatility: this.volatility,
      frontlineAt: (x) => this.bf.frontlineAt(x),
      truck: this.selectedTruck,
    });

    this._updateUI(dt);
  }

  _updateUI(dt) {
    this._uiAcc += dt;
    if (this._uiAcc < 0.1) return;
    this._uiAcc = 0;

    this.ui.setPrice(this.price, this.change24h);
    this.ui.setBias(this.bias * 0.6 + this.bf.bullDominance() * 0.4);
    const nextIn = Math.max(0, this.blockIntervalHint - (performance.now() - this.lastBlockAt) / 1000);
    this.ui.setScore(this.score, this.fees, this.mempool.tipHeight, nextIn);
    this.ui.setBlockWindow(this.blockWindow);
    this.ui.setFleet(this.logistics.trucks, this.selectedTruck, this.lane);
    this.ui.setShop(this.owned, this.fees);
    this.ui.setStatus(this.market.status(), this.mempool.status(), this._fps);

    const rec = this.mempool.recommended;
    this.logistics.setFeeBaseline(rec.halfHourFee ?? this.mempool.feeBands[0] ?? 1);
    const congestion = clamp(this.mempool.mempoolCount / 90000, 0, 1);
    this.ui.setMempool(this.mempool.mempoolCount, this.mempool.mempoolVsize, rec, congestion);
    this.ui.setLiquidations(this.market.liquidations, this.market.liqFresh);
    this.ui.drawBook(this.book, this.price, this.bf);
    this.ui.drawMinimap(this.bf, this.logistics, this.stage.camera);

    const btn = document.getElementById('qa-dispatch');
    if (btn) btn.disabled = !this.selectedTruck || this.selectedTruck.state !== 'idle' || !this.selectedTruck.cargo.length;
  }

  setFps(f) { this._fps = f; }
}
