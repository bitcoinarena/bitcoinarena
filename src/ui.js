import { LANES, TRUCKS, WORLD, FEE } from './config.js';
import { IS_MOBILE, TIER } from './quality.js';
import { fmtUsd, fmtNum, fmtBtc, fmtFee, fmtDuration, fmtPrice, fmtAgo, clamp, lerp, shortId } from './util.js';

const $ = (id) => document.getElementById(id);

const EDU = {
  package: 'Every package is one unconfirmed Bitcoin transaction sitting in the mempool. Miners pick transactions by fee RATE (sat/vB), not by total fee — a small high-rate transaction beats a fat cheap one.',
  vsize: 'vB (virtual bytes) is how much block space a transaction occupies. A block holds ~1,000,000 vB, so blockspace is the scarce good everyone is bidding for.',
  truck: 'Your truck is a candidate block template: limited space, filled greedily by fee rate. Real miners solve exactly this knapsack problem every ten minutes.',
  block: 'A new block is found roughly every 10 minutes. It seals ~1M vB of transactions into the chain. That is the moment your cargo stops being a promise and becomes history.',
  frontline: 'The glowing seam is the current price. Green ground is territory bulls have taken, red is bears. The terrain behind it is real price history — you are literally driving on the chart.',
  liquidation: 'A liquidation is a leveraged position force-closed by the exchange. They cluster at price levels and cascade, which is why they land here as airstrikes.',
  orderbook: 'The translucent walls are live order book depth. Big resting bids/asks are walls the price has to chew through — real support and resistance.',
  fee: 'Fee rate decides your place in the queue. Below the next block\'s median fee, your package waits. That is why low-fee packages here look so sad.',
  rbf: 'RBF (Replace-By-Fee) lets a stuck transaction be rebroadcast with a higher fee. In game: pay fees to bump a package straight to VIP.',
};

export class UI {
  constructor(game) {
    this.game = game;
    this.el = {
      hud: $('hud'), boot: $('boot'), bootStatus: $('boot-status'),
      price: $('price'), change: $('change'), biasFill: $('bias-fill'), biasLabel: $('bias-label'),
      score: $('score'), fees: $('fees'), height: $('height'), blocktimer: $('blocktimer'),
      blockWindow: $('block-window'), bwTime: $('bw-time'),
      pillMarket: $('pill-market'), pillMempool: $('pill-mempool'), pillFps: $('pill-fps'),
      fleetList: $('fleet-list'), cargoList: $('cargo-list'), cargoCap: $('cargo-cap'),
      mpCount: $('mp-count'), mpCongestion: $('mp-congestion'), mpBar: $('mp-bar'), feeBands: $('fee-bands'),
      log: $('log'), radio: $('radio'), toast: $('toast'), tooltip: $('tooltip'),
      edu: $('edu'), eduBody: $('edu-body'), shop: $('shop'), camModes: $('cam-modes'),
      minimap: $('minimap'), book: $('book-canvas'),
      liqBody: $('liq-body'), liqHead: $('liq-tag'), liqSim: $('liq-sim'),
      roundHeight: $('round-height'), roundFill: $('round-fill'), roundScore: $('round-score'),
      roundPkgs: $('round-pkgs'), roundVb: $('round-vb'), standings: $('standings'),
      roundHistory: $('round-history'), mpBlocks: $('mp-blocks'),
      scorePanel: $('score-panel'), marketPanel: $('market-panel'),
      fleetPanel: $('fleet-panel'), minimapWrap: $('minimap-wrap'),
    };
    this.mm = this.el.minimap.getContext('2d');
    this.bookCtx = this.el.book.getContext('2d');
    this.logLines = 0;
    this.eduMode = false;
    this._buildCamButtons();
    this._buildShop();
    this._buildLanes();
    this._buildEdu();
    this._buildMobile();
    this._layout();
    addEventListener('resize', () => this._layout());
    if (this.el.liqSim) this.el.liqSim.onclick = () => this.game.toggleLiqSim();
    this.fleetDirty = true;
  }

  /**
   * On a phone the side panels would cover the battlefield, so they become
   * bottom sheets and only one is open at a time. The shop moves out of the
   * action bar into its own sheet, because a horizontally scrolling row of
   * truck purchases is unusable with a thumb.
   */
  _buildMobile() {
    this.tabs = $('mtabs');
    if (!IS_MOBILE || !this.tabs) return;
    document.body.classList.add('mobile');

    // give the shop a home of its own
    const sheet = document.createElement('div');
    sheet.id = 'shop-sheet';
    sheet.className = 'panel';
    sheet.innerHTML = '<h3>DEPOT — UPGRADES</h3>';
    sheet.appendChild(this.el.shop);
    $('hud').appendChild(sheet);

    this.openSheet = null;
    for (const btn of this.tabs.querySelectorAll('button')) {
      btn.onclick = () => this.toggleSheet(btn.dataset.sheet);
    }
  }

  /**
   * The fleet panel grows with the number of routes, and at five it ran under
   * the minimap in the corner. Give it exactly the room between its own top and
   * whatever is parked at the bottom of that column.
   */
  _layout() {
    if (IS_MOBILE) return;
    const fleet = this.el.fleetPanel, mm = this.el.minimapWrap;
    if (!fleet || !mm) return;
    const bottom = mm.offsetTop || (innerHeight - 200);
    fleet.style.maxHeight = `${Math.max(200, bottom - fleet.offsetTop - 12)}px`;
  }

  toggleSheet(id) {
    const next = this.openSheet === id ? null : id;
    for (const btn of this.tabs.querySelectorAll('button')) {
      const target = $(btn.dataset.sheet);
      const on = btn.dataset.sheet === next;
      btn.classList.toggle('on', on);
      target?.classList.toggle('sheet-open', on);
    }
    this.openSheet = next;
    this.game.audio.click();
  }

  /* ------------------------------------------------------------- static */

  _buildCamButtons() {
    const modes = [['cinematic', '1 CINE'], ['god', '2 GOD'], ['follow', '3 FOLLOW'], ['plaza', '4 PLAZA'], ['driver', '5 DRIVER'], ['free', '6 FREE']];
    this.el.camModes.innerHTML = '';
    for (const [id, label] of modes) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.mode = id;
      b.onclick = () => this.game.setCamera(id);
      this.el.camModes.appendChild(b);
    }
  }

  _buildShop() {
    this.el.shop.innerHTML = '';
    for (const spec of TRUCKS.slice(1)) {
      const b = document.createElement('button');
      b.className = 'btn qa locked';
      b.dataset.truck = spec.id;
      b.innerHTML = `🚚 ${spec.name} <i>${fmtNum(spec.cost)}</i>`;
      b.title = spec.desc;
      b.onclick = () => this.game.buyTruck(spec);
      this.el.shop.appendChild(b);
    }
  }

  _buildLanes() {
    for (const b of document.querySelectorAll('.lane')) {
      b.onclick = () => this.game.setLane(b.dataset.lane);
      b.onmouseenter = (e) => this.tooltip({
        title: LANES[b.dataset.lane].name,
        rows: [['Risk', `${Math.round(LANES[b.dataset.lane].risk * 100)}%`], ['Score', `×${LANES[b.dataset.lane].mult}`]],
        edu: LANES[b.dataset.lane].desc,
      }, e.clientX, e.clientY);
      b.onmouseleave = () => this.hideTooltip();
    }
  }

  _buildEdu() {
    this.el.eduBody.innerHTML = Object.entries({
      'The battlefield is the chart': EDU.frontline,
      'Packages are transactions': EDU.package,
      'Blockspace is the scarce good': EDU.vsize,
      'Your truck is a block template': EDU.truck,
      'Fee rate is your place in the queue': EDU.fee,
      'Replace-By-Fee': EDU.rbf,
      'Order book walls': EDU.orderbook,
      'Liquidation airstrikes': EDU.liquidation,
      'What a block actually is': EDU.block,
    }).map(([h, p]) => `<h5>${h}</h5><p>${p}</p>`).join('');
    $('edu-close').onclick = () => this.el.edu.classList.add('hidden');
  }

  /* ------------------------------------------------------------ updates */

  showHud() { this.el.boot.classList.add('hidden'); this.el.hud.classList.remove('hidden'); }
  bootStatus(t) { this.el.bootStatus.textContent = t; }

  setPrice(price, change) {
    const txt = fmtPrice(price);
    if (txt !== this._priceTxt) {
      // Flash the ticker on every real tick — in a quiet market this is the
      // only visible proof that the feed is alive.
      const up = price >= (this._priceVal ?? price);
      this.el.price.textContent = txt;
      this.el.price.classList.remove('tick-up', 'tick-down');
      void this.el.price.offsetWidth;                  // restart the animation
      this.el.price.classList.add(up ? 'tick-up' : 'tick-down');
      this._priceTxt = txt;
      this._priceVal = price;
    }
    const flat = Math.abs(change) < 0.005;
    this.el.change.textContent = `${flat ? '' : change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
    this.el.change.className = flat ? '' : change >= 0 ? 'up' : 'down';
  }

  setLiquidations(list, liqLive) {
    const head = this.el.liqHead;
    if (head) {
      head.textContent = liqLive ? 'LIVE' : 'SIM';
      head.className = `feed-tag ${liqLive ? '' : 'sim'}`;
    }
    if (!list.length) {
      this.el.liqBody.innerHTML = '<i class="dim">watching the tape… no liquidations yet</i>';
      this._liqHtml = null;
      return;
    }
    const html = list.slice(0, 9).map((l) => `
      <div class="liq-row ${l.side}">
        <span class="liq-age">${fmtAgo(l.at)}</span>
        <span class="liq-sym">${(l.symbol || 'BTC').replace('USDT', '')}</span>
        <span class="liq-side">${l.side === 'long' ? 'LONG' : 'SHORT'}</span>
        <span class="liq-usd">${fmtUsd(l.usd)}</span>
        <span class="liq-px">${fmtUsd(l.price)}</span>
        ${l.real ? '' : '<span class="liq-sim">sim</span>'}
      </div>`).join('');
    if (html !== this._liqHtml) { this.el.liqBody.innerHTML = html; this._liqHtml = html; }
  }

  setBias(bias) {
    this.el.biasFill.style.left = `${clamp((bias + 1) / 2, 0, 1) * 100}%`;
    this.el.biasLabel.textContent =
      bias > 0.28 ? 'BULL DOMINANCE' : bias < -0.28 ? 'BEAR DOMINANCE' : 'CONTESTED';
    this.el.biasLabel.style.color = bias > 0.28 ? 'var(--bull)' : bias < -0.28 ? 'var(--bear)' : 'var(--dim)';
  }

  setStatus(market, mempool, fps) {
    const set = (el, label, s) => {
      el.className = `pill ${s.live ? '' : 'sim'}`;
      el.innerHTML = `${label} <b>${s.mode}</b>`;
    };
    set(this.el.pillMarket, 'MARKET', market);
    set(this.el.pillMempool, 'MEMPOOL', mempool);
    this.el.pillFps.textContent = `${fps | 0} fps`;
  }

  setScore(score, fees, height, nextBlockSec) {
    this.el.score.textContent = Math.round(score).toLocaleString('en-US');
    this.el.fees.textContent = fmtBtc(fees);
    this.el.blocktimer.textContent = nextBlockSec == null ? '—' : fmtDuration(nextBlockSec);
  }

  /**
   * The block is the round, so the panel leads with which block is being
   * contested, how far through it we are, and what has been banked into it.
   * The standings list is rendered as a leaderboard even with one player,
   * because that is exactly the shape multiplayer will fill.
   */
  setRound({ height, round, progress, standings, history, mempoolBlocks }) {
    this.el.roundHeight.textContent = height ? `BLOCK ${height.toLocaleString('en-US')}` : 'BLOCK —';
    this.el.roundFill.style.width = `${progress * 100}%`;
    this.el.roundFill.classList.toggle('due', progress > 0.92);
    this.el.roundScore.textContent = Math.round(round.score).toLocaleString('en-US');
    this.el.roundPkgs.textContent = String(round.delivered);
    this.el.roundVb.textContent = `${fmtNum(round.vbytes)} vB`;
    this.el.mpBlocks.textContent = mempoolBlocks ? `${mempoolBlocks.toFixed(1)} blocks` : '—';

    const rows = standings.map((r) => `
      <div class="stand-row ${r.you ? 'you' : ''}">
        <span class="stand-rank">${r.rank}</span>
        <span class="stand-name">${r.name}</span>
        <span class="stand-pkg">${r.packages}</span>
        <span class="stand-score">${Math.round(r.score).toLocaleString('en-US')}</span>
      </div>`).join('');
    if (rows !== this._standHtml) { this.el.standings.innerHTML = rows; this._standHtml = rows; }

    // The round panel grows and shrinks with the standings and history, so the
    // market panel below it has to follow rather than sit at a fixed offset.
    if (!IS_MOBILE) {
      const h = this.el.scorePanel.offsetHeight;
      if (h !== this._scoreH) {
        this._scoreH = h;
        this.el.marketPanel.style.top = `${this.el.scorePanel.offsetTop + h + 10}px`;
      }
    }

    const hist = history.slice(0, 4).map((h) => `
      <div class="hist-row"><span>#${(h.sealedBy ?? 0).toLocaleString('en-US')}</span>
        <span>${h.delivered}p</span>
        <b>${Math.round(h.score).toLocaleString('en-US')}</b></div>`).join('');
    if (hist !== this._histHtml) { this.el.roundHistory.innerHTML = hist; this._histHtml = hist; }
  }

  /** Called the moment a block seals the round. */
  setRoundResult(done, block) {
    if (done.delivered > 0) {
      this.toast(`ROUND ${block.height.toLocaleString('en-US')} · ${Math.round(done.score).toLocaleString('en-US')} PTS`, 'var(--orange)');
      this.log('block', `Round settled into block ${block.height.toLocaleString('en-US')} — ${done.delivered} packages, ${fmtNum(done.vbytes)} vB, ${Math.round(done.score).toLocaleString('en-US')} pts`);
    } else {
      this.log('ops', `Round closed on block ${block.height.toLocaleString('en-US')} with nothing delivered — next round is open`);
    }
  }

  setBlockWindow(t) {
    if (t > 0) {
      this.el.blockWindow.classList.remove('hidden');
      this.el.bwTime.textContent = `${t.toFixed(1)}s`;
    } else this.el.blockWindow.classList.add('hidden');
  }

  setMempool(count, vsizeMB, rec, congestion) {
    this.el.mpCount.textContent = count ? count.toLocaleString('en-US') : '—';
    this.el.mpCongestion.textContent =
      congestion > 0.75 ? 'GRIDLOCK' : congestion > 0.45 ? 'BUSY' : congestion > 0.2 ? 'FLOWING' : 'CLEAR';
    this.el.mpBar.style.width = `${clamp(congestion, 0.03, 1) * 100}%`;
    const cells = [
      ['next block', rec.fastestFee], ['~30 min', rec.halfHourFee],
      ['~1 hour', rec.hourFee], ['no rush', rec.minimumFee],
    ];
    const html = cells.map(([label, v]) => `<div>${fmtFee(v ?? 1)}<em>${label}</em></div>`).join('');
    if (html !== this._bandHtml) { this.el.feeBands.innerHTML = html; this._bandHtml = html; }
  }

  setLiqSim(on) {
    if (!this.el.liqSim) return;
    this.el.liqSim.textContent = on ? 'SIM ON' : 'SIM OFF';
    this.el.liqSim.classList.toggle('on', !!on);
  }

  setFleet(trucks, selected, lane, roads) {
    const html = trucks.map((t) => {
      const used = t.cargo.reduce((a, p) => a + p.vsize, 0);
      const fill = clamp(used / t.spec.capacity, 0, 1) * 100;
      const hp = clamp(t.hp / t.maxHp, 0, 1) * 100;
      return `<div class="truck-row ${t === selected ? 'sel' : ''}" data-truck="${t.id}">
        <div class="truck-top"><b>${t.spec.name}</b><span class="truck-state ${t.state}">${t.state}</span></div>
        <div class="bar"><i style="width:${fill}%"></i></div>
        <div class="bar hp"><i style="width:${hp}%"></i></div>
      </div>`;
    }).join('');
    if (html !== this._fleetHtml) {
      this.el.fleetList.innerHTML = html;
      this._fleetHtml = html;
      for (const row of this.el.fleetList.querySelectorAll('.truck-row')) {
        row.onclick = () => this.game.selectTruck(+row.dataset.truck);
      }
    }
    for (const b of document.querySelectorAll('.lane')) {
      const id = b.dataset.lane;
      b.classList.toggle('sel', id === lane);
      const eta = roads ? roads.repairEta(id) : 0;
      const wear = roads ? roads.wearLevel(id) : 0;
      b.classList.toggle('cut', eta > 0);
      b.classList.toggle('worn', eta <= 0 && wear > 0.12);
      let tag = b.querySelector('.lane-cut');
      const text = eta > 0
        ? `ROAD CUT — engineers ${Math.ceil(eta)}s`
        : wear > 0.12 ? `SURFACE DAMAGE ${Math.round(wear * 100)}%` : null;
      if (text) {
        if (!tag) { tag = document.createElement('i'); tag.className = 'lane-cut'; b.appendChild(tag); }
        tag.textContent = text;
        tag.style.color = eta > 0 ? 'var(--bear)' : 'var(--gold)';
      } else if (tag) tag.remove();
    }

    if (selected) {
      const used = selected.cargo.reduce((a, p) => a + p.vsize, 0);
      this.el.cargoCap.textContent = `${used.toLocaleString('en-US')} / ${selected.spec.capacity.toLocaleString('en-US')} vB`;
      this.el.cargoList.innerHTML = selected.cargo.length
        ? selected.cargo.map((p) => `<div class="row"><span>${shortId(p.txid)}</span><span>${fmtFee(p.feeRate)} s/vB</span></div>`).join('')
        : '<i class="dim">empty — click packages in the plaza, or press SPACE</i>';
    }
  }

  setShop(owned, fees) {
    for (const b of this.el.shop.querySelectorAll('button')) {
      const spec = TRUCKS.find((t) => t.id === b.dataset.truck);
      const has = owned.has(spec.id);
      b.classList.toggle('owned', has);
      b.classList.toggle('locked', !has && fees < spec.cost);
      b.disabled = has || fees < spec.cost;
    }
  }

  setCamera(mode) {
    for (const b of this.el.camModes.children) b.classList.toggle('sel', b.dataset.mode === mode);
  }

  log(kind, text) {
    const d = document.createElement('div');
    d.className = `line ${kind}`;
    d.textContent = text;
    this.el.log.appendChild(d);
    if (this.el.log.children.length > 40) this.el.log.removeChild(this.el.log.firstChild);
  }

  radio(text) {
    const d = document.createElement('div');
    d.className = 'msg';
    d.textContent = `📻 ${text}`;
    this.el.radio.appendChild(d);
    setTimeout(() => d.remove(), 4200);
    while (this.el.radio.children.length > 3) this.el.radio.firstChild.remove();
  }

  toast(text, color = 'var(--gold)') {
    const d = document.createElement('div');
    d.className = 't';
    d.style.color = color;
    d.textContent = text;
    this.el.toast.appendChild(d);
    setTimeout(() => d.remove(), 2500);
  }

  /* ----------------------------------------------------------- tooltip */

  tooltip({ title, rows = [], edu = null }, x, y) {
    const t = this.el.tooltip;
    t.innerHTML = `<h4>${title}</h4>${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join('')}` +
      (edu && this.eduMode !== false ? `<div class="edu">💡 ${edu}</div>` : '');
    t.classList.remove('hidden');
    const w = 300, h = t.offsetHeight || 120;
    t.style.left = `${clamp(x + 16, 8, innerWidth - w - 8)}px`;
    t.style.top = `${clamp(y + 14, 8, innerHeight - h - 8)}px`;
  }

  packageTooltip(p, x, y) {
    this.tooltip({
      title: `${p.tier.name} PACKAGE${p.whale ? ' 🐋' : ''}${p.pizza ? ' 🍕' : ''}`,
      rows: [
        ['txid', shortId(p.txid)],
        ['fee rate', `${fmtFee(p.feeRate)} sat/vB`],
        ['size', `${p.vsize.toLocaleString('en-US')} vB`],
        ['fee', `${p.fee.toLocaleString('en-US')} sat`],
        ['value', `${p.btc.toFixed(4)} BTC · ${fmtUsd(p.usd)}`],
        ['source', p.real ? 'live mempool' : 'simulated'],
      ],
      edu: p.feeRate < 3 ? EDU.fee : EDU.package,
    }, x, y);
  }

  truckTooltip(t, x, y) {
    const used = t.cargo.reduce((a, p) => a + p.vsize, 0);
    this.tooltip({
      title: t.spec.name,
      rows: [
        ['state', t.state],
        ['cargo', `${used.toLocaleString('en-US')} / ${t.spec.capacity.toLocaleString('en-US')} vB`],
        ['packages', String(t.cargo.length)],
        ['hull', `${Math.round(t.hp)} / ${Math.round(t.maxHp)}`],
        ['route', LANES[t.lane].name],
      ],
      edu: EDU.truck,
    }, x, y);
  }

  hideTooltip() { this.el.tooltip.classList.add('hidden'); }

  /* ---------------------------------------------------------- canvases */

  drawBook(book, price, bf) {
    const c = this.bookCtx, w = this.el.book.width, h = this.el.book.height;
    c.clearRect(0, 0, w, h);
    if (!book || !book.bids.length) return;
    let maxQ = 0.0001;
    for (const [, q] of [...book.bids, ...book.asks]) maxQ = Math.max(maxQ, q);
    const n = Math.min(20, book.bids.length);
    const bw = w / (n * 2);
    for (let i = 0; i < n; i++) {
      const [, bq] = book.bids[i];
      const [, aq] = book.asks[i] || [0, 0];
      const bh = (bq / maxQ) * (h - 6), ah = (aq / maxQ) * (h - 6);
      c.fillStyle = 'rgba(61,220,132,.75)';
      c.fillRect((n - 1 - i) * bw, h - bh, bw - 1, bh);
      c.fillStyle = 'rgba(255,77,94,.75)';
      c.fillRect(w / 2 + i * bw, h - ah, bw - 1, ah);
    }
    c.fillStyle = 'rgba(255,212,71,.9)';
    c.fillRect(w / 2 - 1, 0, 2, h);
  }

  drawMinimap(bf, logistics, cam) {
    const c = this.mm, w = this.el.minimap.width, h = this.el.minimap.height;
    const X = (x) => ((x + WORLD.width / 2) / WORLD.width) * w;
    const Z = (z) => ((z + WORLD.depth / 2) / WORLD.depth) * h;
    c.clearRect(0, 0, w, h);

    // territory fill
    c.fillStyle = 'rgba(61,220,132,.16)';
    c.beginPath(); c.moveTo(0, 0);
    for (let i = 0; i <= WORLD.columns; i += 2) c.lineTo(X(bf.colX(i)), Z(bf.frontZ[i]));
    c.lineTo(w, 0); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,77,94,.16)';
    c.beginPath(); c.moveTo(0, h);
    for (let i = 0; i <= WORLD.columns; i += 2) c.lineTo(X(bf.colX(i)), Z(bf.frontZ[i]));
    c.lineTo(w, h); c.closePath(); c.fill();

    // frontline
    c.strokeStyle = 'rgba(255,212,71,.95)'; c.lineWidth = 1.6;
    c.beginPath();
    for (let i = 0; i <= WORLD.columns; i += 2) {
      const px = X(bf.colX(i)), pz = Z(bf.frontZ[i]);
      i === 0 ? c.moveTo(px, pz) : c.lineTo(px, pz);
    }
    c.stroke();

    // craters = danger zones
    for (const cr of bf.craters) {
      c.fillStyle = `rgba(255,90,58,${0.25 * cr.k})`;
      c.beginPath(); c.arc(X(cr.x), Z(cr.z), (cr.r / WORLD.width) * w * 1.6, 0, Math.PI * 2); c.fill();
    }

    // liquidation strikes: incoming warnings + fresh impact markers
    for (const m of bf.markers) {
      c.strokeStyle = m.side === 'long' ? `rgba(255,77,94,${m.life})` : `rgba(61,220,132,${m.life})`;
      c.lineWidth = 1.4;
      const r = 3 + m.power * 2.4;
      c.beginPath(); c.arc(X(m.x), Z(m.z), r * (2 - m.life), 0, Math.PI * 2); c.stroke();
    }
    for (const m of bf.incoming) {
      const px = X(m.x), pz = Z(m.z);
      c.strokeStyle = 'rgba(255,212,71,.95)'; c.lineWidth = 1.2;
      c.beginPath(); c.arc(px, pz, 4 + Math.sin(m.t * 22) * 2.5, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(px - 6, pz); c.lineTo(px + 6, pz);
      c.moveTo(px, pz - 6); c.lineTo(px, pz + 6); c.stroke();
    }

    // plaza + depot
    c.fillStyle = 'rgba(126,224,255,.85)';
    c.fillRect(X(WORLD.plazaX) - 4, Z(0) - 8, 6, 16);
    c.fillStyle = 'rgba(247,147,26,.95)';
    c.fillRect(X(WORLD.depotX) - 2, Z(0) - 9, 6, 18);

    // packages (plaza cluster)
    c.fillStyle = 'rgba(126,224,255,.55)';
    for (const p of logistics.packages) {
      if (p.state !== 'plaza') continue;
      c.fillRect(X(p.pos.x), Z(p.pos.z), 1.6, 1.6);
    }

    // trucks
    for (const t of logistics.trucks) {
      c.fillStyle = t.state === 'wrecked' ? 'rgba(255,77,94,.9)' : 'rgba(255,212,71,1)';
      c.beginPath(); c.arc(X(t.pos.x), Z(t.pos.z), 3.2, 0, Math.PI * 2); c.fill();
    }

    // camera frustum hint
    if (cam) {
      c.strokeStyle = 'rgba(255,255,255,.35)';
      c.beginPath(); c.arc(X(cam.position.x), Z(cam.position.z), 2.5, 0, Math.PI * 2); c.stroke();
    }
  }
}

export { EDU };
