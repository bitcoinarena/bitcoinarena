// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S LAST STEPS, IN REACT (kanban #564, installer slice 3): Lightning (LND set up here or connected, watched until it runs),
// the gateway and its seat (what it earns, what it needs - inbound, outbound, peg-in, online - and the channels), the bond (the deposit
// named whole with its parts, found, its lock, posted) and the summary at the end. Each gets the wizard's `st`, `post` and `reload`; the
// watchers stop when the wizard leaves the step (the page unmounts it).
// KANBAN #635 (2026-10-25): testcoins from the Arena faucet or a guided way; a deposit counts once it is sent, not once it is
// confirmed; LND and the gateway set up while Bitcoin Core still syncs ("Lnd muss nicht auf dem Bitcoin Core Testnet Sync warten"); the
// confirmations shown on the dashboards, not waited for here; plain words.
import React from 'react';
import { Msg } from './WizardSteps.jsx';
import { ServiceProgress } from './SetupSteps.jsx';

const said = (r, okText) => ({ ok: !!r.ok, text: r.ok ? okText : (r.why || 'failed') });
const n = (x) => Number(x || 0).toLocaleString('en');
const short = (s) => `${String(s || '').slice(0, 16)}…`;
export const fedList = (fs) => ((fs || []).length ? ` Federations: ${fs.map((f) => f.name || String(f.federationId).slice(0, 12)).join(', ')}.` : ' No federation joined yet.');
export const lnText = (r) => `LND ${r.version || ''} runs on ${r.network}: node ${short(r.pubkey)}, block ${r.blockHeight}${r.syncedToChain ? ', synced' : ', waiting for Bitcoin Core to sync'}`
  + `${r.peers ? `. Lightning peers: ${r.peers}` : ''}${r.created ? '. Its wallet comes from your 24 words' : ''}.`;
// THE LIGHTNING STEP'S PROGRESS (kanban #661, 2026-10-25: "Da hätte ich auch gerne mehr debugs und eine progress bar", and for the
// gateway "Da auch"): GET /api/lightning/progress every second while LND or the gateway starts; the bar, the stages, and the program's
// last log lines once a stage is slow
export const LND_HINT = {
  download: 'LND comes from its official release. Setup checks the file against its published checksum before it runs it.',
  reach: 'Two other nodes try to reach this computer on Lightning\'s port. If they cannot, LND gets a Tor address instead.',
  start: 'LND reads its settings, connects to your Bitcoin Core and becomes a service of this computer.',
  wallet: 'LND\'s wallet comes from your 24 words. LND needs some seconds before it accepts it.',
  answer: 'LND answers once it has connected to your Bitcoin Core. While Bitcoin Core is still downloading the chain, this waits for it and can take a long time.',
};
export const GW_HINT = {
  find: 'The gateway program ships with this release.',
  start: 'The gateway gets its settings (its wallet from your 24 words, your LND) and becomes a service of this computer.',
  answer: 'The gateway connects to LND and opens its own database. This usually takes 10 to 60 seconds.',
};
const LND_BUDGET = { download: 60000, reach: 20000, start: 10000, wallet: 30000, answer: 60000 };
const GW_BUDGET = { find: 2000, start: 10000, answer: 60000 };
/** What the gateway says: running and connected, or running and waiting for the chain (kanban #635). */
export const gwText = (r) => (r.syncing ? 'The gateway runs. It connects to Lightning by itself once Bitcoin Core has synced; your dashboard shows when.'
  : `The gateway runs (${r.state}) on LND ${short(r.lightningPubkey)}, ${r.network}, block ${r.blockHeight}.${fedList(r.federations)}`);

/** One need of the gateway seat: done or not, a meter, the numbers. */
class Need extends React.Component {
  render() {
    const { id, what, have, min, num } = this.props;
    const pct = min ? Math.min(100, Math.round((100 * have) / min)) : 100;
    return (
      <div className="need" id={id}><span className="ok">{pct >= 100 ? '✓' : '○'}</span><span className="what">{what}</span>
        <span className="meter"><i style={{ width: `${pct}%` }} /></span><span className="num">{num || <>{n(have)} / <b>{n(min)}</b> sat</>}</span></div>);
  }
}

export class LightningStep extends React.Component {
  constructor(props) {
    super(props);
    const ln = props.st.lightning;
    // THE GATEWAY ON ITS OWN PAGE once LND runs (the owner's playtest 2026-10-25: "Gateway soll sein eigener Bereich sein wenn LND fertig
    // sein und nicht nur drunter spawnen"): LND's page ends with "Continue to the gateway"; a step opened again with LND running starts there
    this.state = { conn: false, url: '', mac: '', cert: '', busy: false, lnMsg: null, lnOk: !!(ln && ln.pubkey), gwPage: !!(ln && ln.pubkey), gwMsg: null, gwOk: false, funds: null, fundsWhy: null,
      peer: '', sats: '200000', ...(props.initial || {}) };
    for (const f of ['own', 'connect', 'later', 'gwSetup', 'gwLater', 'watchLn', 'watchGw', 'funds', 'openChannel', 'progress']) this[f] = this[f].bind(this);
  }
  componentDidMount() { return this.progress(); }   // after a reload: a start still running shows its progress again
  componentWillUnmount() { this.gone = true; clearTimeout(this.lnTimer); clearTimeout(this.gwTimer); clearInterval(this.progTimer); }
  async progress() {
    if (!this.props.get || this.gone) return;
    const p = await this.props.get('/api/lightning/progress');
    if (this.gone || !p || !p.ok) return;
    this.setState({ prog: p });
    const running = (p.lnd && p.lnd.running) || (p.gateway && p.gateway.running);
    if (running && !this.progTimer) this.progTimer = setInterval(this.progress, 1000);
    if (!running && !this.state.busy && this.progTimer) { clearInterval(this.progTimer); this.progTimer = null; }
  }
  follow() { if (this.props.get && !this.progTimer) { this.progTimer = setInterval(this.progress, 1000); } }
  async own() {
    this.setState({ busy: true, lnMsg: null });
    this.follow();
    const r = await this.props.post('/api/lightning/own', { boot: true });
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ lnMsg: said(r) });
    this.watchLn();
  }
  async watchLn() {
    if (this.gone) return;
    const r = await this.props.post('/api/lightning/status');
    if (this.gone) return;
    if (r.ok || !r.waiting) this.progress();
    if (r.ok) return this.setState({ lnMsg: { ok: true, text: lnText(r) }, lnOk: true });
    this.setState({ lnMsg: { ok: !!r.waiting, text: r.waiting ? `Starting LND… (${r.why})` : r.why } });
    if (r.waiting) { clearTimeout(this.lnTimer); this.lnTimer = setTimeout(this.watchLn, this.props.pollMs || 2000); }
  }
  async connect() {
    const { url, mac, cert } = this.state;
    const r = await this.props.post('/api/lightning/connect', { restUrl: url, macaroonHex: mac, tlsCertPem: cert });
    if (!r.ok) return this.setState({ lnMsg: said(r) });
    this.setState({ lnMsg: { ok: true, text: `Connected: ${r.alias || ''} ${short(r.pubkey)}, block ${r.blockHeight}.` }, lnOk: true });
  }
  async later() { await this.props.post('/api/lightning/later'); this.props.reload(); }
  async gwSetup() {
    this.setState({ busy: true, gwMsg: null });
    this.follow();
    const r = await this.props.post('/api/gateway/setup', { boot: true });
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ gwMsg: said(r) });
    this.watchGw();
  }
  async watchGw() {
    if (this.gone) return;
    const r = await this.props.post('/api/gateway/status');
    if (this.gone) return;
    if (r.ok || !r.waiting) this.progress();
    if (r.ok) {
      this.setState({ gwMsg: { ok: true, text: gwText(r) }, gwOk: true });
      return r.syncing ? null : this.funds();
    }
    this.setState({ gwMsg: { ok: !!r.waiting, text: r.waiting ? `Starting the gateway… (${r.why})` : r.why } });
    if (r.waiting) { clearTimeout(this.gwTimer); this.gwTimer = setTimeout(this.watchGw, this.props.pollMs || 2000); }
  }
  async gwLater() {
    const r = await this.props.post('/api/gateway/later');
    if (!r.ok) return this.setState({ gwMsg: said(r) });
    this.props.reload();
  }
  async funds() {
    const r = await this.props.post('/api/lightning/funds');
    this.setState(r.ok ? { funds: r, fundsWhy: null } : { fundsWhy: r.why });
  }
  async openChannel() {
    const r = await this.props.post('/api/lightning/channel', { peer: this.state.peer, sats: Number(this.state.sats) });
    this.setState({ gwMsg: said(r, `Channel opening: ${r.fundingTxid || ''}. It counts once it is confirmed.`) });
    this.funds();
  }
  seat() {
    const f = this.state.funds; const seat = (f && f.seat) || { minInboundSats: 100000, minOutboundSats: 100000, minPegInSats: 50000 };
    const c = (f && f.channels) || { open: [], pending: [], inboundSats: 0, outboundSats: 0 };
    return (
      <div className="seat">
        <div className="seat-head">⚡ Earn more: run your federation's gateway</div>
        <div className="seat-tiles">
          <div className="tile"><b>2 seats</b><span>per federation</span></div>
          <div className="tile"><b>Every day</b><span>a new pick, so your turn comes</span></div>
          <div className="tile"><b>~3.5×</b><span>a guardian's earnings</span></div>
        </div>
        <div className="earn">
          <div className="ebar"><span className="lbl">Guardian</span><span className="fill" style={{ width: '28%' }} /><span className="val">0.09 %</span></div>
          <div className="ebar"><span className="lbl">Gateway</span><span className="fill gw" style={{ width: '100%' }} /><span className="val">0.31 % + fees</span></div>
          <div className="sub">of every round's volume in your federation</div>
        </div>
        <div className="seat-needs">
          <Need id="need-in" what="Inbound (deposits)" have={c.inboundSats || 0} min={seat.minInboundSats} />
          <Need id="need-out" what="Outbound (payouts)" have={c.outboundSats || 0} min={seat.minOutboundSats} />
          <p className="sub">Inbound comes by itself. When your federation is founded, each of its nodes opens a channel to the next one in a ring, so every gateway gets one channel in and one out.</p>
          <Need what="Peg-in" have={1} min={1} num={<><b>{n(seat.minPegInSats)}</b> sat · sent by your node</>} />
          <Need what="Online" have={0} min={1} num="95 % of the day" />
        </div>
        <details><summary>How are seats chosen?</summary>
          <p>Only the federation's own guardians can stand. Every day (144 blocks) the guardians rank the gateways that meet the needs above: most Lightning routed first, then channel size, uptime and bond. They take the top two. When gateways are equal, a fair draw decides, so every eligible gateway gets its days. A seated gateway keeps its seat unless it drops out or another one routes 25 % more.</p>
        </details>
        {f ? <>
          <p className="sub">Channels: {c.open.length} open, {c.pending.length} opening; inbound {n(c.inboundSats)} sat, outbound {n(c.outboundSats)} sat (a gateway seat needs {n(seat.minInboundSats)} each way).</p>
          <p className="sub">LND's own wallet for channels: <code>{f.address}</code> - {n(f.onchainSats)} sat confirmed{f.unconfirmedSats ? `, ${n(f.unconfirmedSats)} arriving` : ''}</p></>
          : this.state.fundsWhy ? <p className="sub">Channels: {this.state.fundsWhy}</p> : null}
      </div>);
  }
  render() {
    const s = this.state; const syncing = !!(this.props.st.coreSync && this.props.st.coreSync.interim);
    if (s.gwPage) return this.gatewayPage();
    return (
      <div className="aw">
        <h2>10. Lightning (custody)</h2>
        <p>Custody needs a Lightning node. Setup can install <b>LND</b> here. It runs on your Bitcoin Core, starts as a service, and makes its wallet from your 24 words, so one seed covers everything. You can also connect an LND you already run.</p>
        {syncing ? <p className="sub">Bitcoin Core is still syncing. That is fine: LND starts now and catches up by itself.</p> : null}
        {!s.lnOk ? <div className="kinds">
          <button type="button" id="ln-own" disabled={s.busy} onClick={this.own}>Set up LND here</button>
          <button type="button" className="ghost" onClick={() => this.setState({ conn: true })}>Connect my LND</button>
          <button type="button" className="ghost" onClick={this.later}>Set it up later</button></div> : null}
        {s.conn && !s.lnOk ? <div>
          <label htmlFor="ln-url">REST address</label><input id="ln-url" placeholder="https://127.0.0.1:8080" value={s.url} onChange={(e) => this.setState({ url: e.target.value })} />
          <label htmlFor="ln-mac">Admin macaroon (hex: <code>xxd -p -c 1000 admin.macaroon</code>)</label><input id="ln-mac" value={s.mac} onChange={(e) => this.setState({ mac: e.target.value })} />
          <label htmlFor="ln-cert">TLS certificate (tls.cert)</label><textarea id="ln-cert" rows="4" placeholder="-----BEGIN CERTIFICATE-----" value={s.cert} onChange={(e) => this.setState({ cert: e.target.value })} />
          <button type="button" onClick={this.connect}>Test and connect</button></div> : null}
        {s.prog && s.prog.lnd && s.prog.lnd.elapsedMs !== undefined ? <ServiceProgress id="ln-progress" progress={s.prog.lnd} hints={LND_HINT} budgets={LND_BUDGET}
          slowAt={{ download: 120000, answer: 60000, wallet: 60000 }} slowText="LND takes longer than usual. Setup keeps asking it; the log below says what it is doing." logOf="LND's last messages:" /> : null}
        <Msg r={s.lnMsg} />
        {s.lnOk ? <button type="button" id="ln-next" onClick={() => this.setState({ gwPage: true })}>Continue to the gateway</button> : null}
      </div>
    );
  }
  gatewayPage() {
    const s = this.state; const ln = this.props.st.lightning || {};
    return (
      <div className="aw" id="ln-gw">
        <h2>10. Lightning: your gateway</h2>
        <p className="gw-done"><span className="ok">✓</span> LND runs{ln.pubkey || (s.lnMsg && s.lnMsg.ok) ? <> · node <code>{short(ln.pubkey || '')}</code></> : null}</p>
        <p>The gateway sends and receives Lightning payments for your federation's players, through your LND. Its wallet also comes from your 24 words.</p>
        {this.seat()}
        {s.funds ? <div>
          <div className="row"><div style={{ flex: 3 }}><label htmlFor="ch-peer">Peer (pubkey@host:port)</label><input id="ch-peer" placeholder="02…@host:9735" value={s.peer} onChange={(e) => this.setState({ peer: e.target.value })} /></div>
            <div><label htmlFor="ch-sats">Sat</label><input id="ch-sats" value={s.sats} onChange={(e) => this.setState({ sats: e.target.value })} /></div></div>
          <button type="button" className="ghost" onClick={this.openChannel}>Open a channel</button> <button type="button" className="ghost" onClick={this.funds}>Refresh</button></div> : null}
        {s.gwOk ? <button type="button" onClick={() => this.props.reload()}>Continue</button> : <>
          <button type="button" id="gw-setup" disabled={s.busy} onClick={this.gwSetup}>Set up the gateway</button>
          <button type="button" className="ghost" onClick={this.gwLater}>Skip the gateway for now</button></>}
        {s.prog && s.prog.gateway && s.prog.gateway.elapsedMs !== undefined ? <ServiceProgress id="gw-progress" progress={s.prog.gateway} hints={GW_HINT} budgets={GW_BUDGET}
          slowAt={{ answer: 60000 }} slowText="The gateway takes longer than usual. Setup keeps asking it; the log below says what it is doing." logOf="The gateway's last messages:" /> : null}
        <Msg r={s.gwMsg} />
        {/* NO "BACK TO LND" (kanban #730, the owner: its page said only what LND is, and its "Continue to the gateway" led back here - "this is
          confusing"): with LND running there is nothing to do on LND's page, and the line above already says it runs */}
      </div>
    );
  }
}

// the total the wallet must receive, and its parts when there are more than the bond and its fees
export const PART = Object.freeze({ bond: 'bond', fees: 'fees', custodyUpdate: 'this update', advertUpdate: 'advertisement update', pegIn: 'peg-in', outside: 'outside channel', ring: 'ring channel', liquidity: 'liquidity deposit (into LND)', otherNodes: 'the other nodes (handed on from this wallet)' });
/** One line under each part of a custody deposit (the owner's playtest 2026-10-25: "more colorful", fewer words). */
export const COVER_WHY = Object.freeze({ bond: 'locked; your node earns with it', pegIn: 'into the federation, so your gateway can pay out', ring: 'channel to the next node of your federation',
  outside: 'channel to a well-connected Lightning node', advertUpdate: 'names your federation once it is founded', custodyUpdate: 'tells the network your node takes custody', fees: 'network fees' });
export const needText = (need, parts) => `${n(need)}${parts && Object.keys(parts).length > 2 ? ` (${Object.entries(parts).map(([k, v]) => `${PART[k] || k} ${n(v)}`).join(', ')})` : ''}`;
export const lockText = (l) => `The bond will be locked until block ${l.maturity} - ${l.blocks} blocks from now, about ${new Date(l.estimatedMs).toUTCString()}. The block number is the rule; the date is an estimate (testnet4 makes a block about every 10 minutes). Until then the bond cannot be withdrawn. After that, you withdraw it from your owner page.`;
/** What the deposit check found, in words; with the network's minimum for a new node when it is above the floor (§23A.3a, kanban #543). */
export const foundText = (r) => (r.coins.length
  ? `Found ${n(r.totalSats)} sat in ${r.coins.length} deposit(s) (${r.coins.map((c) => (c.height ? `confirmed at ${c.height}` : 'sent, not confirmed yet')).join(', ')}).${r.enough ? ' Monitor confirmations on your dashboard.' : ` Needed: ${n(r.needSats)} sat in all (fees included).`}`
  : 'Nothing has arrived yet. A deposit shows here as soon as it is sent; it does not need to be confirmed.')
  + (r.minimum && r.minimum.sats > 50000 ? ` The network asks new nodes for a bond of at least ${n(r.minimum.sats)} sat right now (its federations are filling up), so your node is useful from the start.` : '')
  // A FURTHER NODE OF A COUNT (kanban #596): its part paid on from the first node's wallet
  + (r.fundedFrom && r.fundedFrom.txid ? ` Paid from the first node's wallet: ${n(r.fundedFrom.sats)} sat (${String(r.fundedFrom.txid).slice(0, 12)}…). It shows here once your Bitcoin connection sees it.` : '')
  + (r.fundWhy ? ` ${r.fundWhy}` : '');
/** Public testnet4 faucets for the guided way (kanban #635). */
export const FAUCETS = Object.freeze([['mempool.space', 'https://mempool.space/testnet4/faucet'], ['coinfaucet.eu', 'https://coinfaucet.eu/en/btc-testnet4/'], ['testnet4.dev', 'https://faucet.testnet4.dev/']]);

/** How often the bond step looks for the deposit by itself (kanban #763). */
export const BOND_CHECK_EVERY_MS = 15000;

export class BondStep extends React.Component {
  constructor(props) {
    super(props);
    const w = props.st.wallet || {};
    this.state = { pegIn: '50000', need: needText(w.needSats, w.parts), found: null, busy: false, msg: null, coins: 'auto', ...(props.initial || {}) };
    this.check = this.check.bind(this); this.postBond = this.postBond.bind(this); this.later = this.later.bind(this); this.autoCoins = this.autoCoins.bind(this);
  }
  // THE DEPOSIT LOOKED FOR WITHOUT A CLICK (kanban #763, 2026-10-28: "when opening step 11, we could automatically check for deposits and
  // not wait for the user to click on the button. at least if the install script recognizes a previous installation"): asked once when the
  // step opens and again every BOND_CHECK_EVERY_MS until the deposit is enough; the button still asks at once
  componentDidMount() { if (this.props.post) this.auto(); }
  componentWillUnmount() { this.gone = true; clearTimeout(this.autoTimer); }
  async auto() {
    if (this.gone) return;
    if (!this.state.busy) await this.check({ quiet: true });
    if (this.gone || (this.state.found && this.state.found.enough)) return;
    this.autoTimer = setTimeout(() => this.auto(), BOND_CHECK_EVERY_MS);
  }
  custody() { return (this.props.st.roles || []).includes('custody'); }
  body() { return this.custody() ? { pegInSats: Number(this.state.pegIn) } : {}; }
  async check({ quiet = false } = {}) {
    // THE CHECK SHOWS WHILE IT RUNS (kanban #813, the owner: "some indication that the balance check is being performed"), the automatic one too
    this.setState({ checking: true, ...(quiet ? {} : { busy: true }) });
    const r = await this.props.post('/api/bond/check', this.body());
    if (this.gone) return;
    this.setState({ checking: false, checkedAt: Date.now(), ...(quiet ? {} : { busy: false }) });
    // an automatic ask that finds nothing yet says nothing: the step's own text already says what to send
    if (quiet && (!r.ok || !(r.found || r.sats || r.enough))) return;
    if (!r.ok) return this.setState({ msg: said(r), found: null });
    this.setState({ found: r, msg: { ok: !!r.enough, text: foundText(r) }, ...(r.parts && Object.keys(r.parts).length > 2 ? { need: needText(r.needSats, r.parts) } : {}) });
  }
  /** TESTCOINS FROM THE ARENA FAUCET (kanban #635): what is missing, sent to this node's address; then the deposit is checked. */
  async autoCoins() {
    this.setState({ busy: true, msg: { ok: true, text: 'Asking the Bitcoin Arena faucet…' } });
    const r = await this.props.post('/api/coins/auto', this.body());
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ coins: r.guided ? 'guided' : this.state.coins, msg: { ok: false, text: `${r.why}${r.guided ? ' Use the guided way below.' : ''}` } });
    return this.check();
  }
  async postBond() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/bond/post');
    if (!r.ok) return this.setState({ busy: false, msg: said(r) });
    this.props.reload();
  }
  async later() { const r = await this.props.post('/api/bond/later'); if (r.ok) this.props.reload(); }
  async copyAddr() {
    try { await navigator.clipboard.writeText((this.props.st.wallet || {}).address); this.setState({ copied: true }); } catch { this.setState({ copied: false }); }
  }
  /** What a custody node's deposit pays for: one coloured tile per part, with its amount (the wallet's own numbers). */
  covers() {
    const w = this.props.st.wallet || {}; const f = this.state.found;
    const parts = (f && f.parts) || w.parts || {};
    const order = ['bond', 'pegIn', 'ring', 'outside', 'advertUpdate', 'custodyUpdate', 'liquidity', 'otherNodes', 'fees'];
    const keys = Object.keys(parts).length ? order.filter((k) => parts[k]).concat(Object.keys(parts).filter((k) => !order.includes(k))) : [];
    if (!keys.length) return <p className="sub">Custody needs more than the bond: the peg-in, two Lightning channels and a little for the advertisement. It all stays in your node's wallet until it is needed.</p>;
    return (
      <div className="covers"><b>What your deposit covers</b>
        <div className="cover-tiles">{keys.map((k) => (
          <div key={k} className={`cover c-${k}`}><span className="amt">{n(parts[k])} sat</span><span className="what">{PART[k] || k}</span>{COVER_WHY[k] ? <span className="why">{COVER_WHY[k]}</span> : null}</div>))}</div>
        <p className="sub">It all stays in your node's wallet until it is needed.</p>
      </div>);
  }
  coinChoice() {
    const { coins, busy } = this.state; const w = this.props.st.wallet || {};
    const pick = (k, title, text) => (
      <label className={`choice${coins === k ? ' on' : ''}`}><input type="radio" name="coins" value={k} checked={coins === k} onChange={() => this.setState({ coins: k })} />
        <div><b>{title}</b><p>{text}</p></div></label>);
    return (
      <div className="choices" id="coins">
        {pick('auto', 'Get test coins automatically', 'The Bitcoin Arena faucet sends exactly what is missing to your node. Free, once per node.')}
        {coins === 'auto' ? <button type="button" id="coins-auto" disabled={busy} onClick={this.autoCoins}>Send me the test coins</button> : null}
        {pick('guided', 'Get them myself', 'From a public testnet4 faucet, in three steps.')}
        {/* THREE STEPS AT A GLANCE (the owner's playtest 2026-10-25: "Less wall of text and clearer and more colorful") */}
        {coins === 'guided' ? <ol className="guided steps3">
          <li><span className="n">1</span><div><b>Copy your address</b>
            <div className="addr-copy"><code>{w.address}</code><button type="button" className="ghost" id="addr-copy" onClick={() => this.copyAddr()}>{this.state.copied ? 'Copied ✓' : 'Copy'}</button></div></div></li>
          <li><span className="n">2</span><div><b>Paste it at a faucet</b>
            <div className="faucets">{FAUCETS.map(([name, url]) => <a key={url} className="faucet" href={url} target="_blank" rel="noopener noreferrer">{name} ↗</a>)}</div>
            <p className="sub">One faucet may give too little. Then use a second one.</p></div></li>
          <li><span className="n">3</span><div><b>Come back and press "Check for my deposit"</b>
            <p className="sub">Your coins show as soon as they are sent.</p></div></li>
        </ol> : null}
      </div>);
  }
  render() {
    const st = this.props.st; const w = st.wallet || {}; const later = !!st.custodyLater;
    const { pegIn, need, found, busy, msg, checking, checkedAt } = this.state;
    return (
      <div className="aw">
        <h2>13. The bond</h2>
        {later
          ? <p>Your node already has a bond. Adding custody updates that bond's advertisement to say your node takes custody. <b>You do not post a second bond.</b> You need a little for that update, a reserve for the update that names your federation once it is founded, and the gateway's peg-in. Send <b>{need}</b> sat to your node's wallet:</p>
          : <p>Your node serves rounds once it has a bond: bitcoin locked on testnet4 under your node's key. Send at least <b>{this.custody() ? `${n(w.needSats)} sat` : `${need} sat`}</b> to your node's own wallet{this.custody() ? '. What it covers is below.' : ' (fees included).'}</p>}
        {this.state.coins === 'guided' ? null : <p className="addr"><code>{w.address}</code></p>}
        {this.coinChoice()}
        {this.custody() ? <div>
          {later ? null : this.covers()}
          <label htmlFor="b-pegin">Peg-in for the gateway (sat)</label><input id="b-pegin" value={pegIn} onChange={(e) => this.setState({ pegIn: e.target.value })} /></div> : null}
        <button type="button" className="ghost" id="b-check" disabled={busy || checking} onClick={() => this.check()}>{checking ? 'Checking…' : 'Check for my deposit'}</button>
        <p className="sub" id="b-checking">{checking ? 'Checking your node\'s wallet for the deposit…'
          : found && found.enough ? ' ' : checkedAt ? `Last checked ${new Date(checkedAt).toLocaleTimeString()}. Setup checks again by itself.` : ' '}</p>
        <Msg r={msg} />
        {found && found.lock ? <p className="sub">{lockText(found.lock)}</p> : null}
        <button type="button" id="b-post" disabled={busy || !(found && found.enough)} onClick={this.postBond}>{later ? 'Update my bond for custody' : 'Post the bond'}</button>
        <button type="button" className="ghost" onClick={this.later}>{later ? 'Later' : 'I\'ll post it later'}</button>
        {/* POSTED LATER FROM THE OWNER AREA (kanban #728): the same wallet, the same bond */}
        {later ? null : <p className="sub">Later works too: post it from your owner area, under Bond.</p>}
        <p className="sub">You do not wait for confirmations here. Your dashboard shows how many the bond and the peg-in have, and when they count.</p>
      </div>
    );
  }
}

/** How others reach the node, in the owner's words, for each way in. */
export function reachLine(r) {
  const url = <code>{r.url || '(no name yet)'}</code>;
  if (r.mode === 'direct') return <>directly at {url} (keep port {r.port} open and forwarded)</>;
  if (r.mode === 'permanent') return <>at {url} through your Cloudflare tunnel (the user service <code>arena-tunnel</code>)</>;
  if (r.mode === 'workers') return <>at {url}, your Worker on workers.dev, which forwards to your node's tunnel (the service <code>arena-workers</code> keeps it up to date)</>;
  if (r.mode === 'tailscale') return <>at {url} through Tailscale Funnel (Tailscale keeps it running; <code>tailscale funnel status</code> shows it)</>;
  return <>at {url} through a temporary tunnel. <b>This name changes when the tunnel restarts</b>; set up a permanent tunnel later from your owner page</>;
}

// THE LAST PAGE (playtest 2026-10-25: "This is a wall of text. Make it more structured, klarer lesbar und der finish link geht auf
// unser dashboard. Der Tunnel link öffnet in einem neuen fenster. Es muss auch moderner ausschauen"): a headline, the two things to do
// (the dashboard, Finish - which then opens the dashboard), one card per part, links in a new window, the command line folded away
const ext = (url, text) => <a href={url} target="_blank" rel="noopener noreferrer">{text || url}</a>;
const ends = (x, k = 10) => (x ? `${String(x).slice(0, k)}…${String(x).slice(-6)}` : '');
const REACH_NOTE = { direct: 'Directly, through your open port.', permanent: 'Your Cloudflare tunnel: a permanent name.', workers: 'Your Worker on workers.dev: a permanent name.',
  tailscale: 'Tailscale Funnel: a permanent name.', quick: 'A temporary tunnel: the name changes when it restarts. Set up a permanent one later on your owner page.' };

export const OWNER_SITE = 'https://testnet.bitcoin-arena.io/owner/';
export class DoneStep extends React.Component {
  constructor(props) { super(props); this.state = { msg: null, finished: false }; this.finish = this.finish.bind(this); }
  async finish() {
    // the dashboard's tab opened at the click (a popup opened later is blocked), then handed the owner's key so the owner page opens logged in
    const open = this.props.open || ((url) => (typeof window !== 'undefined' ? window.open(url, '_blank') : null));
    const w = open('about:blank');
    const h = await this.props.get('/api/owner/handoff').catch(() => null);   // before Finish: the setup's session ends with it
    const r = await this.props.post('/api/finish');
    if (!r.ok) { if (w && w.close) w.close(); return this.setState({ msg: said(r) }); }
    const url = this.ownerSite() ? `${this.ownerSite()}&owner-handoff` : this.dashboard();
    if (w) {
      if (h && h.ok && typeof window !== 'undefined') {
        const origin = new URL(url).origin;
        const on = (e) => {
          if (e.source !== w || !e.data || e.data.type !== 'arena-owner-ready') return;
          w.postMessage({ type: 'arena-owner-key', kind: h.kind, seed: h.seed, secret: h.secret }, origin);
          window.removeEventListener('message', on);
        };
        window.addEventListener('message', on);
      }
      w.location.href = this.ownerSite() ? url : `${url}#owner-handoff`;
    }
    this.setState({ finished: true, msg: { ok: true, text: w ? 'Setup is finished. Your dashboard opened in a new tab, and the owner area there is logged in.' : `Setup is finished. Open your dashboard: ${url}` } });
  }
  base() { const st = this.props.st; return (st.reach && st.reach.url) || this.local(); }
  // the dashboard and the owner page on this computer at the node's own port: it never changes, so the login handed over stays (the owner's
  // playtest 2026-10-25: after a restart the quick tunnel had a new name, and the owner page there was logged out)
  local() { return `http://127.0.0.1:${this.props.st.seatPort}`; }
  // THE OWNER PAGE ON THE ARENA SITE (kanban #668, the owner's playtest 2026-10-25: "Das reicht nicht wenn der Server Remote ist. Der
  // installer soll es in die Session rein kopieren auch wenn sich die url geändert hat"): one address that never changes, the login kept
  // there per node key; the site finds the node where it is now. Null before the node has a key.
  ownerSite() { const id = this.props.st.service && this.props.st.service.identity; return id ? `${OWNER_SITE}#node=${id}` : null; }
  dashboard() { return `${this.local()}/dashboard`; }   // lowercase (playtest 2026-10-25: "ohne grosses D")
  more(l) {
    if (!l) return null;
    const dir = String(l.start || '').replace(/[\\/][^\\/]+$/, '');
    const how = l.app ? <>Open <b>Bitcoin Arena</b> in your Applications. It shows whether your node runs, with Start, Stop, Doctor and the dashboard.</>
      : l.menu && /Start Menu/.test(l.menu) ? <>Start menu &gt; <b>Bitcoin Arena</b>: whether your node runs, with Start, Stop, Doctor and the dashboard.</>
        : <><b>Bitcoin Arena</b> in your desktop's menu, or <code>{l.start}</code>.</>;
    const cmd = l.command && l.command.name;
    return (
      <details className="done-more"><summary>Start, stop and the command line</summary>
        <p>{how} The scripts are in <code>{dir}</code>.</p>
        {cmd ? <ul>
          <li><code>{cmd} status</code> - every service and what it answers</li>
          <li><code>{cmd} doctor</code> - finds problems and names the fix</li>
          <li><code>{cmd} restart lnd</code> - restarts one service</li>
          <li><code>{cmd} config</code> - the settings ({'arena.conf'})</li>
        </ul> : null}
        {l.command && l.command.note ? <p className="sub">{l.command.note}</p> : null}
      </details>);
  }
  render() {
    const st = this.props.st; const r = st.reach || {}; const sv = st.service || {}; const g = st.gateway; const b = st.bond;
    const owner = this.ownerSite() || `${this.local()}/dashboard/owner`;
    const syncing = !!(st.coreSync && st.coreSync.interim);
    const card = (id, icon, title, body) => <div className="done-card" id={id}><div className="done-card-head"><span aria-hidden="true">{icon}</span><b>{title}</b></div>{body}</div>;
    return (
      <div className="aw done">
        <div className="done-hero">
          <div className="done-check" aria-hidden="true">✓</div>
          <div><h2>Your node runs</h2>
            <p className="sub">{sv.boot ? 'It starts again by itself after a reboot.' : 'It does not start again by itself after a reboot.'} Your dashboard shows everything still in progress.</p></div>
        </div>
        <div className="done-actions">
          {/* one button (playtest 2026-10-25: "Finish soll sagen \"Open Node Dashboard\""): it ends setup and opens the dashboard, owner logged in */}
          {this.state.finished ? <a className="btn" id="open-dashboard" href={this.ownerSite() || this.dashboard()} target="_blank" rel="noopener noreferrer">Open Node Dashboard</a>
            : <button type="button" id="finish" onClick={this.finish}>Open Node Dashboard</button>}
        </div>
        <Msg r={this.state.msg} />
        <div className="done-grid">
          {card('done-address', '🌐', 'Public address', <>{r.url ? ext(r.url) : <span className="sub">none yet</span>}<p className="sub">{REACH_NOTE[r.mode] || REACH_NOTE.quick}</p></>)}
          {card('done-owner', '🔑', 'Owner page', <>{ext(owner, 'Open your owner page')}<p className="sub">Log in with {st.owner && st.owner.mode === 'nostr' ? 'your Nostr key' : 'your 24 words'}.{r.url ? '' : ' This computer only, until your node has a public address.'}</p></>)}
          {card('done-bond', '🔒', 'Bond', b ? <><p className="big">{n(b.sats)} sat</p><p className="sub">Locked until block {n(b.maturity)} (about {new Date(b.lock.estimatedMs).toUTCString().slice(0, 16)}). Then you withdraw it on your owner page.</p><p className="sub mono">{ends(b.txid)}</p></>
            : <p className="sub">No bond yet. Send it to <code>{st.wallet ? st.wallet.address : ''}</code> and post it on your owner page.</p>)}
          {st.lightning ? card('done-lightning', '⚡', 'Lightning', <><p className="sub">{st.lightning.mode === 'own' ? 'LND runs here.' : 'Your own LND, connected.'} Node <span className="mono">{ends(st.lightning.pubkey)}</span></p>
            <p className="sub">{g && (g.testedMs || g.syncingMs) ? ((g.federations || []).length ? `Gateway runs, serving ${g.federations.map((f) => f.name || String(f.federationId).slice(0, 12)).join(', ')}.` : 'Gateway runs. It joins a federation once your node is drawn into one.') : 'No gateway yet.'}</p></>) : null}
          {syncing ? card('done-core', '₿', 'Bitcoin Core', <p className="sub">Still syncing. Until then your node reads the chain from a public server, then it switches by itself.</p>) : null}
          {card('done-key', '🪪', 'Node key', <p className="sub mono">{ends(sv.identity, 16)}</p>)}
        </div>
        {sv.boot && sv.linger === false ? <p className="warn">Run <code>sudo loginctl enable-linger $USER</code> once, so your node keeps running when you log out.</p> : null}
        {this.more(st.launchers)}
      </div>
    );
  }
}
