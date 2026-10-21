// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S LAST STEPS, IN REACT (kanban #564, installer slice 3): Lightning (LND set up here or connected, watched until it runs),
// the gateway and its seat (what it earns, what it needs - inbound, outbound, peg-in, online - and the channels), the bond (the deposit
// named whole with its parts, found, its lock, posted) and the summary at the end. Each gets the wizard's `st`, `post` and `reload`; the
// watchers stop when the wizard leaves the step (the page unmounts it).
import React from 'react';
import { Msg } from './WizardSteps.jsx';

const said = (r, okText) => ({ ok: !!r.ok, text: r.ok ? okText : (r.why || 'failed') });
const n = (x) => Number(x || 0).toLocaleString('en');
const short = (s) => `${String(s || '').slice(0, 16)}…`;
export const fedList = (fs) => ((fs || []).length ? ` Federations: ${fs.map((f) => f.name || String(f.federationId).slice(0, 12)).join(', ')}.` : ' No federation joined yet.');
export const lnText = (r) => `LND ${r.version || ''} runs on ${r.network}: node ${short(r.pubkey)}, block ${r.blockHeight}${r.syncedToChain ? ', synced' : ', catching up with the chain'}`
  + `${r.peers ? `. Lightning peers: ${r.peers}` : ''}${r.created ? '; its wallet was made from your words' : ''}.`;

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
    this.setState({ busy: true, lnMsg: { ok: true, text: 'Downloading and checking LND, then starting it…' } });
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
      this.setState({ gwMsg: { ok: true, text: `The gateway runs (${r.state}) on LND ${short(r.lightningPubkey)}, ${r.network}, block ${r.blockHeight}.${fedList(r.federations)}` }, gwOk: true });
      return this.funds();
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
    this.setState({ gwMsg: said(r, `Channel opening: ${r.fundingTxid || ''} (it counts once it is confirmed).`) });
    this.funds();
  }
  seat() {
    const f = this.state.funds; const seat = (f && f.seat) || { minInboundSats: 100000, minOutboundSats: 100000, minPegInSats: 50000 };
    const c = (f && f.channels) || { open: [], pending: [], inboundSats: 0, outboundSats: 0 };
    return (
      <div className="seat">
        <div className="seat-head">⚡ Earn more: host your federation's gateway</div>
        <div className="seat-tiles">
          <div className="tile"><b>2 seats</b><span>per federation</span></div>
          <div className="tile"><b>Every day</b><span>a fresh pick - your turn comes</span></div>
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
          <p className="sub">Inbound comes by itself: when your federation is founded, each of its nodes opens a channel to the next one (a ring), so every gateway gets one channel in and one out.</p>
          <Need what="Peg-in" have={1} min={1} num={<><b>{n(seat.minPegInSats)}</b> sat · sent automatically</>} />
          <Need what="Online" have={0} min={1} num="95 % of the day" />
        </div>
        <details><summary>How are seats chosen?</summary>
          <p>Only the federation's own guardians can stand. Every day (144 blocks) its guardians rank the gateways that meet the three needs above - most Lightning routed first, then channel size, uptime and bond - and take the top two. While gateways are equal it comes down to a fair draw, so every eligible gateway gets its days. A seated gateway keeps its seat unless it drops out or another routes 25 % more.</p>
        </details>
        {f ? <>
          <p className="sub">Channels: {c.open.length} open, {c.pending.length} opening; inbound {n(c.inboundSats)} sat, outbound {n(c.outboundSats)} sat (a gateway seat needs {n(seat.minInboundSats)} each way).</p>
          <p className="sub">LND's own wallet for channels: <code>{f.address}</code> - {n(f.onchainSats)} sat confirmed{f.unconfirmedSats ? `, ${n(f.unconfirmedSats)} arriving` : ''}</p></>
          : this.state.fundsWhy ? <p className="sub">Channels: {this.state.fundsWhy}</p> : null}
      </div>);
  }
  render() {
    const s = this.state;
    return (
      <div className="aw">
        <h2>7. Lightning (custody)</h2>
        <p>Custody needs a Lightning node. The installer can set up <b>LND</b> here - checked download, testnet4 on your Bitcoin Core, started as a service, its wallet made from your 24 words (one seed for everything; LND's channel backup file is separate, the owner page shows where) - or connect one you already run.</p>
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
          <p>The Fedimint gateway pays and receives Lightning for a federation's users through this LND. Its e-cash wallet is made from your 24 words too.</p>
          {this.seat()}
          {s.funds ? <div>
            <div className="row"><div style={{ flex: 3 }}><label htmlFor="ch-peer">Peer (pubkey@host:port)</label><input id="ch-peer" placeholder="02…@host:9735" value={s.peer} onChange={(e) => this.setState({ peer: e.target.value })} /></div>
              <div><label htmlFor="ch-sats">Sat</label><input id="ch-sats" value={s.sats} onChange={(e) => this.setState({ sats: e.target.value })} /></div></div>
            <button type="button" className="ghost" onClick={this.openChannel}>Open a channel</button> <button type="button" className="ghost" onClick={this.funds}>Refresh</button></div> : null}
          {s.gwOk ? <button type="button" onClick={() => this.props.reload()}>Continue</button> : <>
            <button type="button" id="gw-setup" disabled={s.busy} onClick={this.gwSetup}>Set up the gateway</button>
            <button type="button" className="ghost" onClick={this.gwLater}>Without the gateway for now</button></>}
          <Msg r={s.gwMsg} />
        </div> : null}
      </div>
    );
  }
}

// the total the wallet must receive, and its parts when there are more than the bond and its fees
export const PART = Object.freeze({ bond: 'bond', fees: 'fees', custodyUpdate: 'this update', advertUpdate: 'advertisement update', pegIn: 'peg-in', outside: 'outside channel', ring: 'ring channel', liquidity: 'liquidity deposit (into LND)' });
export const needText = (need, parts) => `${n(need)}${parts && Object.keys(parts).length > 2 ? ` (${Object.entries(parts).map(([k, v]) => `${PART[k] || k} ${n(v)}`).join(', ')})` : ''}`;
export const lockText = (l) => `The bond will be locked until block ${l.maturity} - ${l.blocks} blocks from now, about ${new Date(l.estimatedMs).toUTCString()} (testnet4 blocks come about every 10 minutes; the block height is the rule, the date an estimate). Until then it cannot be withdrawn; after that, the owner page withdraws it.`;
/** What the deposit check found, in words; with the network's minimum for a new node when it is above the floor (§23A.3a, kanban #543). */
export const foundText = (r) => (r.coins.length
  ? `Found ${n(r.totalSats)} sat in ${r.coins.length} deposit(s) (${r.coins.map((c) => (c.height ? `confirmed at ${c.height}` : 'unconfirmed')).join(', ')}).${r.enough ? '' : ` Needed: ${n(r.needSats)} sat in all (fees included).`}`
  : 'Nothing has arrived yet. A deposit shows once your Bitcoin connection sees it (Bitcoin Core: once it is confirmed).')
  + (r.minimum && r.minimum.sats > 50000 ? ` The network asks a new node to bond at least ${n(r.minimum.sats)} sat now (its federations are filling up), so your node is useful from the start.` : '');

export class BondStep extends React.Component {
  constructor(props) {
    super(props);
    const w = props.st.wallet || {};
    this.state = { pegIn: '50000', need: needText(w.needSats, w.parts), found: null, busy: false, msg: null, ...(props.initial || {}) };
    this.check = this.check.bind(this); this.postBond = this.postBond.bind(this); this.later = this.later.bind(this);
  }
  custody() { return (this.props.st.roles || []).includes('custody'); }
  async check() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/bond/check', this.custody() ? { pegInSats: Number(this.state.pegIn) } : {});
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ msg: said(r), found: null });
    this.setState({ found: r, msg: { ok: !!r.enough, text: foundText(r) }, ...(r.parts && Object.keys(r.parts).length > 2 ? { need: needText(r.needSats, r.parts) } : {}) });
  }
  async postBond() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/bond/post');
    if (!r.ok) return this.setState({ busy: false, msg: said(r) });
    this.props.reload();
  }
  async later() { const r = await this.props.post('/api/bond/later'); if (r.ok) this.props.reload(); }
  render() {
    const st = this.props.st; const w = st.wallet || {}; const later = !!st.custodyLater;
    const { pegIn, need, found, busy, msg } = this.state;
    return (
      <div className="aw">
        <h2>10. The bond</h2>
        {later
          ? <p>Your node has its bond already. Adding custody updates that bond's advertisement to say your node takes custody - <b>no second bond</b>. It needs a little for that update, a reserve for the update that names your federation once it is founded, and the gateway's peg-in. Send <b>{need}</b> sat to your node's wallet:</p>
          : <p>Your node serves rounds once it has a bond: bitcoin locked on testnet4 under your node's key. Send at least <b>{need}</b> sat (fees included) to your node's own wallet:</p>}
        <p className="addr"><code>{w.address}</code></p>
        <p className="sub">No testnet4 coins? Get them free from <a href="https://coinfaucet.eu/en/btc-testnet4/" target="_blank" rel="noopener noreferrer">coinfaucet.eu</a>.</p>
        {this.custody() ? <div>
          {later ? null : <p>Custody needs more: besides the bond, a little for the advertisement that names your federation once it is founded, the <b>peg-in</b> for your gateway - bitcoin it moves into the federation so it can pay out Lightning - the <b>outside channel</b> (100,000 sat) to a well-connected Lightning node, which links your gateway to the wider network, and the <b>ring channel</b> (150,000 sat) your node opens to the next node of the federation. All of it stays in your node's wallet until then.</p>}
          <label htmlFor="b-pegin">Peg-in for the gateway (sat)</label><input id="b-pegin" value={pegIn} onChange={(e) => this.setState({ pegIn: e.target.value })} /></div> : null}
        <button type="button" className="ghost" id="b-check" disabled={busy} onClick={this.check}>Check for my deposit</button>
        <Msg r={msg} />
        {found && found.lock ? <p className="sub">{lockText(found.lock)}</p> : null}
        <button type="button" id="b-post" disabled={busy || !(found && found.enough)} onClick={this.postBond}>{later ? 'Update my bond for custody' : 'Post the bond'}</button>
        <button type="button" className="ghost" onClick={this.later}>{later ? 'Later' : 'I\'ll post it later'}</button>
      </div>
    );
  }
}

/** How others reach the node, in the owner's words, for each way in. */
export function reachLine(r) {
  const url = <code>{r.url || '(no name yet)'}</code>;
  if (r.mode === 'direct') return <>directly at {url} (keep port {r.port} open and forwarded)</>;
  if (r.mode === 'permanent') return <>at {url} through your Cloudflare tunnel (the user service <code>arena-tunnel</code>)</>;
  if (r.mode === 'workers') return <>at {url} - your Worker on workers.dev, forwarding to the node's tunnel (the keeper service <code>arena-workers</code> follows every new tunnel name)</>;
  if (r.mode === 'tailscale') return <>at {url} through Tailscale Funnel (kept by Tailscale itself; <code>tailscale funnel status</code> shows it)</>;
  return <>at {url} through a temporary tunnel - <b>this name changes when the tunnel restarts</b>; set up a permanent tunnel later from the owner page</>;
}

export class DoneStep extends React.Component {
  constructor(props) { super(props); this.state = { msg: null, finished: false }; this.finish = this.finish.bind(this); }
  async finish() {
    const r = await this.props.post('/api/finish');
    this.setState({ msg: said(r, `Finished. The installer has stopped. Your owner page: ${r.owner}`), finished: !!r.ok });
  }
  launchers(l) {
    if (!l) return null;
    const dir = String(l.start || '').replace(/[\\/][^\\/]+$/, '');
    const how = l.app ? <>open <b>Arena Node</b> in your Applications (<code>{l.app}</code>) - it starts the node and opens its owner page</>
      : l.menu && /Start Menu/.test(l.menu) ? <>Start menu &gt; <b>Arena Node</b> &gt; Start Arena node (and Stop, and the owner page)</>
        : <><b>Arena Node</b> in your desktop's menu, or <code>{l.start}</code></>;
    const cmd = l.command && l.command.name;
    return <>
      <p><b>Starting it again</b> (it also starts by itself after a reboot): {how}. The scripts - start, stop, status, owner page - are in <code>{dir}</code>.</p>
      {cmd ? <p><b>On the command line</b>: <code>{cmd} status</code> shows every service (the node, its guardian, LND, the gateway, Tor, the tunnel, the chain), <code>{cmd} doctor</code> finds problems and says the fix, <code>{cmd} restart lnd</code> restarts one, <code>{cmd} config</code> shows the settings (<code>arena.conf</code>).{l.command.note ? ` ${l.command.note}.` : ''}</p> : null}</>;
  }
  render() {
    const st = this.props.st; const r = st.reach || {}; const sv = st.service || {}; const g = st.gateway; const b = st.bond;
    const owner = `${r.url || `http://127.0.0.1:${st.seatPort}`}/Dashboard/owner`;
    return (
      <div className="aw">
        <h2>Done</h2>
        <p>Your node runs as the user service <code>arena-node</code>{sv.boot ? ' and starts again after a reboot' : ' (not started after a reboot)'}.</p>
        <p>Others reach it {reachLine(r)}.</p>
        <p>Node key: <code>{sv.identity || ''}</code></p>
        {this.launchers(st.launchers)}
        <p>Owner page: <code>{owner}</code>{r.url ? '' : ' (this machine only: the node has no public address yet)'} - log in with {st.owner && st.owner.mode === 'nostr' ? 'your Nostr key' : 'your 24 words'}.</p>
        {sv.boot && sv.linger === false ? <p className="warn">Run <code>sudo loginctl enable-linger $USER</code> once so the node keeps running when you log out.</p> : null}
        {st.lightning ? <p>Lightning: {st.lightning.mode === 'own' ? <>LND set up here (the user service <code>arena-lnd</code>)</> : 'your own LND, connected'}, node <code>{st.lightning.pubkey || ''}</code>. {g && g.testedMs
          ? <>The gateway runs (the user service <code>arena-gateway</code>) at <code>{g.publicUrl || ''}</code>{(g.federations || []).length ? `, serving ${g.federations.map((f) => f.name || String(f.federationId).slice(0, 12)).join(', ')}` : ', no federation joined yet'}.</> : 'No gateway yet.'} Your node's federation guardian runs and waits to be drawn: when ten custody nodes guard no federation, they found one together, and your node then names it, joins its gateway to it and sends the peg-in by itself.</p> : null}
        {b ? <p>Bond: <code>{b.txid}</code>, {n(b.sats)} sat, <b>locked until block {b.maturity}</b> (about {new Date(b.lock.estimatedMs).toUTCString()}). Until then it cannot be withdrawn; from that block on, the owner page withdraws it, or <code>arena-install --rebond &lt;sat&gt;</code> makes it larger in one step.</p>
          : <p>No bond yet: send it to <code>{st.wallet ? st.wallet.address : ''}</code> and post it from the owner page. Until then your node is not drawn for rounds.</p>}
        <button type="button" id="finish" disabled={this.state.finished} onClick={this.finish}>Finish</button>
        <Msg r={this.state.msg} />
      </div>
    );
  }
}
