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

const said = (r, okText) => ({ ok: !!r.ok, text: r.ok ? okText : (r.why || 'failed') });
const n = (x) => Number(x || 0).toLocaleString('en');
const short = (s) => `${String(s || '').slice(0, 16)}…`;
export const fedList = (fs) => ((fs || []).length ? ` Federations: ${fs.map((f) => f.name || String(f.federationId).slice(0, 12)).join(', ')}.` : ' No federation joined yet.');
export const lnText = (r) => `LND ${r.version || ''} runs on ${r.network}: node ${short(r.pubkey)}, block ${r.blockHeight}${r.syncedToChain ? ', synced' : ', waiting for Bitcoin Core to sync'}`
  + `${r.peers ? `. Lightning peers: ${r.peers}` : ''}${r.created ? '. Its wallet comes from your 24 words' : ''}.`;
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
    this.state = { conn: false, url: '', mac: '', cert: '', busy: false, lnMsg: null, lnOk: !!(ln && ln.pubkey), gwMsg: null, gwOk: false, funds: null, fundsWhy: null,
      peer: '', sats: '200000', ...(props.initial || {}) };
    for (const f of ['own', 'connect', 'later', 'gwSetup', 'gwLater', 'watchLn', 'watchGw', 'funds', 'openChannel']) this[f] = this[f].bind(this);
  }
  componentWillUnmount() { this.gone = true; clearTimeout(this.lnTimer); clearTimeout(this.gwTimer); }
  async own() {
    this.setState({ busy: true, lnMsg: { ok: true, text: 'Downloading LND, checking it and starting it…' } });
    const r = await this.props.post('/api/lightning/own', { boot: true });
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ lnMsg: said(r) });
    this.watchLn();
  }
  async watchLn() {
    if (this.gone) return;
    const r = await this.props.post('/api/lightning/status');
    if (this.gone) return;
    if (r.ok) return this.setState({ lnMsg: { ok: true, text: lnText(r) }, lnOk: true });
    this.setState({ lnMsg: { ok: !!r.waiting, text: r.waiting ? `Starting LND… (${r.why})` : r.why } });
    if (r.waiting) { clearTimeout(this.lnTimer); this.lnTimer = setTimeout(this.watchLn, this.props.pollMs || 5000); }
  }
  async connect() {
    const { url, mac, cert } = this.state;
    const r = await this.props.post('/api/lightning/connect', { restUrl: url, macaroonHex: mac, tlsCertPem: cert });
    if (!r.ok) return this.setState({ lnMsg: said(r) });
    this.setState({ lnMsg: { ok: true, text: `Connected: ${r.alias || ''} ${short(r.pubkey)}, block ${r.blockHeight}.` }, lnOk: true });
  }
  async later() { await this.props.post('/api/lightning/later'); this.props.reload(); }
  async gwSetup() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/gateway/setup', { boot: true });
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ gwMsg: said(r) });
    this.watchGw();
  }
  async watchGw() {
    if (this.gone) return;
    const r = await this.props.post('/api/gateway/status');
    if (this.gone) return;
    if (r.ok) {
      this.setState({ gwMsg: { ok: true, text: gwText(r) }, gwOk: true });
      return r.syncing ? null : this.funds();
    }
    this.setState({ gwMsg: { ok: !!r.waiting, text: r.waiting ? `Starting the gateway… (${r.why})` : r.why } });
    if (r.waiting) { clearTimeout(this.gwTimer); this.gwTimer = setTimeout(this.watchGw, this.props.pollMs || 5000); }
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
        <Msg r={s.lnMsg} />
        {s.lnOk ? <div id="ln-gw">
          <h3>The gateway</h3>
          <p>The gateway sends and receives Lightning payments for your federation's players, through this LND. Its wallet also comes from your 24 words.</p>
          {this.seat()}
          {s.funds ? <div>
            <div className="row"><div style={{ flex: 3 }}><label htmlFor="ch-peer">Peer (pubkey@host:port)</label><input id="ch-peer" placeholder="02…@host:9735" value={s.peer} onChange={(e) => this.setState({ peer: e.target.value })} /></div>
              <div><label htmlFor="ch-sats">Sat</label><input id="ch-sats" value={s.sats} onChange={(e) => this.setState({ sats: e.target.value })} /></div></div>
            <button type="button" className="ghost" onClick={this.openChannel}>Open a channel</button> <button type="button" className="ghost" onClick={this.funds}>Refresh</button></div> : null}
          {s.gwOk ? <button type="button" onClick={() => this.props.reload()}>Continue</button> : <>
            <button type="button" id="gw-setup" disabled={s.busy} onClick={this.gwSetup}>Set up the gateway</button>
            <button type="button" className="ghost" onClick={this.gwLater}>Skip the gateway for now</button></>}
          <Msg r={s.gwMsg} />
        </div> : null}
      </div>
    );
  }
}

// the total the wallet must receive, and its parts when there are more than the bond and its fees
export const PART = Object.freeze({ bond: 'bond', fees: 'fees', custodyUpdate: 'this update', advertUpdate: 'advertisement update', pegIn: 'peg-in', outside: 'outside channel', ring: 'ring channel', liquidity: 'liquidity deposit (into LND)', otherNodes: 'the other nodes (handed on from this wallet)' });
export const needText = (need, parts) => `${n(need)}${parts && Object.keys(parts).length > 2 ? ` (${Object.entries(parts).map(([k, v]) => `${PART[k] || k} ${n(v)}`).join(', ')})` : ''}`;
export const lockText = (l) => `The bond will be locked until block ${l.maturity} - ${l.blocks} blocks from now, about ${new Date(l.estimatedMs).toUTCString()}. The block number is the rule; the date is an estimate (testnet4 makes a block about every 10 minutes). Until then the bond cannot be withdrawn. After that, you withdraw it from your owner page.`;
/** What the deposit check found, in words; with the network's minimum for a new node when it is above the floor (§23A.3a, kanban #543). */
export const foundText = (r) => (r.coins.length
  ? `Found ${n(r.totalSats)} sat in ${r.coins.length} deposit(s) (${r.coins.map((c) => (c.height ? `confirmed at ${c.height}` : 'sent, not confirmed yet')).join(', ')}).${r.enough ? ' That is enough: you can post the bond now. The confirmations show on your dashboard.' : ` Needed: ${n(r.needSats)} sat in all (fees included).`}`
  : 'Nothing has arrived yet. A deposit shows here as soon as it is sent; it does not need to be confirmed.')
  + (r.minimum && r.minimum.sats > 50000 ? ` The network asks new nodes for a bond of at least ${n(r.minimum.sats)} sat right now (its federations are filling up), so your node is useful from the start.` : '')
  // A FURTHER NODE OF A COUNT (kanban #596): its part paid on from the first node's wallet
  + (r.fundedFrom && r.fundedFrom.txid ? ` Paid from the first node's wallet: ${n(r.fundedFrom.sats)} sat (${String(r.fundedFrom.txid).slice(0, 12)}…). It shows here once your Bitcoin connection sees it.` : '')
  + (r.fundWhy ? ` ${r.fundWhy}` : '');
/** Public testnet4 faucets for the guided way (kanban #635). */
export const FAUCETS = Object.freeze([['mempool.space', 'https://mempool.space/testnet4/faucet'], ['coinfaucet.eu', 'https://coinfaucet.eu/en/btc-testnet4/'], ['testnet4.dev', 'https://faucet.testnet4.dev/']]);

export class BondStep extends React.Component {
  constructor(props) {
    super(props);
    const w = props.st.wallet || {};
    this.state = { pegIn: '50000', need: needText(w.needSats, w.parts), found: null, busy: false, msg: null, coins: 'auto', ...(props.initial || {}) };
    this.check = this.check.bind(this); this.postBond = this.postBond.bind(this); this.later = this.later.bind(this); this.autoCoins = this.autoCoins.bind(this);
  }
  custody() { return (this.props.st.roles || []).includes('custody'); }
  body() { return this.custody() ? { pegInSats: Number(this.state.pegIn) } : {}; }
  async check() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/bond/check', this.body());
    this.setState({ busy: false });
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
        {coins === 'guided' ? <ol className="guided">
          <li>Copy your node's address: <code>{w.address}</code></li>
          <li>Open a faucet and paste the address: {FAUCETS.map(([name, url], i) => <React.Fragment key={url}>{i ? ', ' : ''}<a href={url} target="_blank" rel="noopener noreferrer">{name}</a></React.Fragment>)}. Some give less than you need; then use two.</li>
          <li>Come back and press <b>Check for my deposit</b>. It shows as soon as the coins are sent.</li>
        </ol> : null}
      </div>);
  }
  render() {
    const st = this.props.st; const w = st.wallet || {}; const later = !!st.custodyLater;
    const { pegIn, need, found, busy, msg } = this.state;
    return (
      <div className="aw">
        <h2>13. The bond</h2>
        {later
          ? <p>Your node already has a bond. Adding custody updates that bond's advertisement to say your node takes custody. <b>You do not post a second bond.</b> You need a little for that update, a reserve for the update that names your federation once it is founded, and the gateway's peg-in. Send <b>{need}</b> sat to your node's wallet:</p>
          : <p>Your node serves rounds once it has a bond: bitcoin locked on testnet4 under your node's key. Send at least <b>{need}</b> sat (fees included) to your node's own wallet:</p>}
        <p className="addr"><code>{w.address}</code></p>
        {this.coinChoice()}
        {this.custody() ? <div>
          {later ? null : <p>Custody needs more than the bond: a little for the advertisement that names your federation once it is founded, the <b>peg-in</b> (bitcoin your gateway moves into the federation so it can pay out over Lightning), the <b>outside channel</b> (100,000 sat) to a well-connected Lightning node, and the <b>ring channel</b> (150,000 sat) your node opens to the next node of the federation. It all stays in your node's wallet until it is needed.</p>}
          <label htmlFor="b-pegin">Peg-in for the gateway (sat)</label><input id="b-pegin" value={pegIn} onChange={(e) => this.setState({ pegIn: e.target.value })} /></div> : null}
        <button type="button" className="ghost" id="b-check" disabled={busy} onClick={this.check}>Check for my deposit</button>
        <Msg r={msg} />
        {found && found.lock ? <p className="sub">{lockText(found.lock)}</p> : null}
        <button type="button" id="b-post" disabled={busy || !(found && found.enough)} onClick={this.postBond}>{later ? 'Update my bond for custody' : 'Post the bond'}</button>
        <button type="button" className="ghost" onClick={this.later}>{later ? 'Later' : 'I\'ll post it later'}</button>
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

export class DoneStep extends React.Component {
  constructor(props) { super(props); this.state = { msg: null, finished: false }; this.finish = this.finish.bind(this); }
  async finish() {
    const r = await this.props.post('/api/finish');
    this.setState({ msg: said(r, `Finished. Setup has stopped. Your owner page: ${r.owner}`), finished: !!r.ok });
  }
  launchers(l) {
    if (!l) return null;
    const dir = String(l.start || '').replace(/[\\/][^\\/]+$/, '');
    const how = l.app ? <>open <b>Bitcoin Arena</b> in your Applications (<code>{l.app}</code>). It starts your node and opens its owner page</>
      : l.menu && /Start Menu/.test(l.menu) ? <>Start menu &gt; <b>Bitcoin Arena</b> &gt; Start Bitcoin Arena (also Stop, and the owner page)</>
        : <><b>Bitcoin Arena</b> in your desktop's menu, or <code>{l.start}</code></>;
    const cmd = l.command && l.command.name;
    return <>
      <p><b>Starting it again</b> (it also starts by itself after a reboot): {how}. The scripts for start, stop, status and the owner page are in <code>{dir}</code>.</p>
      {cmd ? <p><b>On the command line</b>: <code>{cmd} status</code> shows every service (your node, its guardian, LND, the gateway, Tor, the tunnel, the chain). <code>{cmd} doctor</code> finds problems and tells you the fix. <code>{cmd} restart lnd</code> restarts one service. <code>{cmd} config</code> shows the settings (<code>arena.conf</code>).{l.command.note ? ` ${l.command.note}.` : ''}</p> : null}</>;
  }
  render() {
    const st = this.props.st; const r = st.reach || {}; const sv = st.service || {}; const g = st.gateway; const b = st.bond;
    const base = r.url || `http://127.0.0.1:${st.seatPort}`;
    const owner = `${base}/Dashboard/owner`;
    const syncing = !!(st.coreSync && st.coreSync.interim);
    return (
      <div className="aw">
        <h2>Done</h2>
        <p>Your node runs as the user service <code>arena-node</code>{sv.boot ? ' and starts again after a reboot' : ' (it does not start again after a reboot)'}.</p>
        <p>Others reach it {reachLine(r)}.</p>
        <p>Node key: <code>{sv.identity || ''}</code></p>
        {syncing ? <p>Bitcoin Core is still syncing. Until it is done, your node reads the chain from a public server, and then it switches to your own Bitcoin Core by itself.</p> : null}
        <p><b>Your dashboard shows the rest</b>: the Bitcoin Core sync, and the confirmations of your bond and your peg-in. Open <code>{base}/Dashboard</code>, or your owner page.</p>
        {this.launchers(st.launchers)}
        <p>Owner page: <code>{owner}</code>{r.url ? '' : ' (this computer only: your node has no public address yet)'}. Log in with {st.owner && st.owner.mode === 'nostr' ? 'your Nostr key' : 'your 24 words'}.</p>
        {sv.boot && sv.linger === false ? <p className="warn">Run <code>sudo loginctl enable-linger $USER</code> once, so your node keeps running when you log out.</p> : null}
        {st.lightning ? <p>Lightning: {st.lightning.mode === 'own' ? <>LND set up here (the user service <code>arena-lnd</code>)</> : 'your own LND, connected'}, node <code>{st.lightning.pubkey || ''}</code>. {g && (g.testedMs || g.syncingMs)
          ? <>The gateway runs (the user service <code>arena-gateway</code>) at <code>{g.publicUrl || ''}</code>{(g.federations || []).length ? `, serving ${g.federations.map((f) => f.name || String(f.federationId).slice(0, 12)).join(', ')}` : ', no federation joined yet'}.</> : 'No gateway yet.'} Your node's guardian runs and waits to be drawn. When ten custody nodes guard no federation, they found one together. Your node then names it, joins its gateway to it and sends the peg-in by itself.</p> : null}
        {b ? <p>Bond: <code>{b.txid}</code>, {n(b.sats)} sat, <b>locked until block {b.maturity}</b> (about {new Date(b.lock.estimatedMs).toUTCString()}). Until then it cannot be withdrawn. From that block on, you withdraw it from your owner page, or <code>arena-install --rebond &lt;sat&gt;</code> makes it larger in one step.</p>
          : <p>No bond yet: send it to <code>{st.wallet ? st.wallet.address : ''}</code> and post it from your owner page. Until then your node is not drawn for rounds.</p>}
        <button type="button" id="finish" disabled={this.state.finished} onClick={this.finish}>Finish</button>
        <Msg r={this.state.msg} />
      </div>
    );
  }
}
