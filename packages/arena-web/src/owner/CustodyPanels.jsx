// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S CUSTODY AND LIQUIDITY, IN REACT (kanban #564). Custody: whether this node is a guardian (GET /guardian) and where
// its guardian is reached, else custody added here (POST /owner/custody/add, kanban #563), not with the installer. Liquidity: what a provider holds free for new channels against the deposit minimum
// (free + the channels it gave, 2026-10-18), the channels it gave, its top-up address and a new one (POST /owner/liquidity/new-address);
// a node that is none becomes one here (POST /owner/liquidity/become, kanban #567), not with the installer.
import React from 'react';
import { Button } from '../design/components.jsx';

/** The liquidity deposit minimum (sat): free coins + the channels given. */
export const LIQUIDITY_DEPOSIT = Object.freeze({ testnet4: 500000, mainnet: 2500000 });
const n = (x) => Number(x).toLocaleString('en-US');
const WAIT_MS = 10000;

// ADD CUSTODY HERE (kanban #563, the owner-page rule: never "run this command"): the plan first (POST /owner/custody/add without post) -
// Lightning, the bond against the guardian floor, what the wallet must hold - then the bond's rules typed I UNDERSTAND, and the node runs
// the custody steps itself; its progress asked every 10 s
const STEP_WORDS = { running: 'Working', lightning: 'Lightning (LND)', gateway: 'The gateway', funds: 'Waiting for the wallet', done: 'Done', failed: 'Stopped' };
export class CustodyPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, guardian: null, plan: null, progress: null, understood: '', busy: false, message: null, ...(props.initial || {}) };
    this.review = this.review.bind(this); this.start = this.start.bind(this); this.poll = this.poll.bind(this);
  }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    let g = null; try { g = await this.props.api.get('/guardian'); } catch { g = null; }
    this.setState({ loaded: true, guardian: g });
  }
  componentWillUnmount() { clearTimeout(this.timer); }
  async call(args) {
    try { return await this.props.api.post('/owner/custody/add', await this.props.api.signed('custody/add', args)); } catch (x) { return { ok: false, why: x.message }; }
  }
  async review() {
    this.setState({ busy: true, message: 'Checking Lightning, the bond and the wallet…' });
    const r = await this.call({ post: false });
    if (r && r.ok && r.done) return this.setState({ busy: false, message: 'This node holds custody already: its guardian starts with the node.' });
    const running = r && r.ok && r.plan && r.plan.progress && !['done', 'failed'].includes(r.plan.progress.state);
    this.setState({ busy: false, plan: r && r.ok ? r.plan : null, progress: running ? r.plan.progress : null, message: r && r.ok ? null : (r && r.why) || 'no answer' });
    if (running) this.poll();
  }
  async start() {
    this.setState({ busy: true, message: 'Starting…' });
    const r = await this.call({ post: true, understood: this.state.understood });
    if (!r || !r.ok) return this.setState({ busy: false, message: (r && r.why) || 'no answer', progress: (r && r.progress) || this.state.progress });
    this.setState({ busy: false, message: null, progress: r.progress });
    await this.poll();
  }
  async poll() {
    clearTimeout(this.timer);
    const r = await this.call({ progress: true });
    const p = r && r.ok ? r.progress : null;
    if (p) this.setState({ progress: p });
    if (!p || !['done', 'failed'].includes(p.state)) this.timer = setTimeout(this.poll, WAIT_MS);
  }
  progressView(p) {
    return (
      <div className={p.state === 'failed' ? 'err' : p.state === 'done' ? 'ok' : ''}>
        <div className="row"><span>{STEP_WORDS[p.state] || p.state}</span><b>{p.step || ''}</b></div>
        {p.state === 'funds' ? <p className="warn">Send <b>{n(p.needSats - p.haveSats)} sat</b> to <code>{p.address}</code>: custody goes on by itself once the wallet holds {n(p.needSats)} sat.</p> : null}
        {p.why && p.state !== 'funds' ? <p className="sub">{p.why}</p> : null}
        {p.state === 'done' ? <p><b>This node holds custody now ✓</b> Its bond names custody; the next founding can draw it as a guardian.</p> : null}
      </div>);
  }
  offer() {
    const { plan: p, progress, understood, busy, message } = this.state;
    if (progress) return <div>{this.progressView(progress)}{progress.state === 'failed' ? <p><Button disabled={busy} onClick={this.review}>Try again</Button> <span className="sub">{message}</span></p> : null}</div>;
    return (
      <div>
        <p><b>This node holds no custody.</b> A custody node is one of a federation's 10 guardians, may run one of its 2 Lightning gateways, and earns a share of every round of its federation (the guardians' third of the 4 % node fee).</p>
        {p ? (
          <div>
            <div className="stats">
              <div className="stat"><span>Lightning (LND)</span><b>{p.lightning === 'install' ? 'Installed now' : p.lightning === 'starting' ? 'Starting' : 'Running'}</b><small>gateway: {p.gateway}</small></div>
              <div className="stat"><span>Bond</span><b>{n(p.bondSats)} sat</b><small>a guardian needs at least {n(p.bondFloorSats)} sat</small></div>
              <div className="stat"><span>The wallet must hold</span><b>{n(p.needSats)} sat</b><small>it holds {n(p.walletSats)} sat</small></div>
            </div>
            <div className="row"><span>Two bond advertisement updates (custody now, its federation later)</span><b>{n(p.parts.custodyUpdate + p.parts.advertUpdate)} sat</b></div>
            <div className="row"><span>Peg-in for the gateway's e-cash</span><b>{n(p.parts.pegIn)} sat</b></div>
            <div className="row"><span>Lightning channels (to the next guardian and outside)</span><b>{n(p.parts.ring + p.parts.outside)} sat</b></div>
            {p.bondBelowFloor ? <p className="err">The bond is below the guardian floor: add {n(p.bondFloorSats - p.bondSats)} sat to it first (Bond, above).</p> : null}
            {p.shortSats ? <p className="warn">The wallet is <b>{n(p.shortSats)} sat short</b>: you can start now - custody goes on by itself once <code>{p.address}</code> holds it.</p> : null}
            <p><b>The bond's rules.</b> As a guardian this node holds players' money with the others. Leave only with LEAVE on this page: a guardian that just goes away is slashed - its bond goes to the players. Type <b>I UNDERSTAND</b>:</p>
            <p><input value={understood} onChange={(e) => this.setState({ understood: e.target.value })} placeholder="I UNDERSTAND" /> <Button primary disabled={busy || p.bondBelowFloor || understood.trim().toUpperCase() !== 'I UNDERSTAND'} onClick={this.start}>Add custody</Button> <span className="sub">{message}</span></p>
          </div>)
          : <p><Button primary disabled={busy} onClick={this.review}>Add custody</Button> <span className="sub">{message}</span></p>}
        <p className="sub">Custody needs your own Bitcoin Core, not Electrum. The node then installs Lightning and the gateway and restarts once.</p>
      </div>);
  }
  render() {
    const { loaded, guardian: g } = this.state;
    if (!loaded) return <p className="sub">reading whether this node holds custody…</p>;
    if (g && g.guardian) return (
      <div><div className="row"><span>Custody</span><b>on - this node is a guardian</b></div>
        <div className="row"><span>Guardian endpoint</span><b><code>{g.endpoint || ''}</code></b></div>
        <RetirePanel api={this.props.api} /></div>);
    return this.offer();
  }
}

// RETIRE THE FEDERATION THIS NODE GUARDS (kanban #577, the owner-page rule: never "run this command"): only one that holds nothing -
// its guardian's audit shows no e-cash issued and no coins held. Each guardian's owner consents here (typed RETIRE); once a threshold
// of them did, its record stands CLOSED, and the node starts a fresh guardian for the next founding.
export class RetirePanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { plan: null, typed: '', busy: false, message: null, ...(props.initial || {}) };
    this.check = this.check.bind(this); this.consent = this.consent.bind(this);
  }
  async call(args) {
    try { return await this.props.api.post('/owner/federation/retire', await this.props.api.signed('federation/retire', args)); } catch (x) { return { ok: false, why: x.message }; }
  }
  async check() {
    this.setState({ busy: true, message: 'Reading the guardian\'s audit…' });
    const r = await this.call({});
    if (r && r.ok && r.retired) return this.setState({ busy: false, plan: null, message: 'This federation is retired: its record stands CLOSED.' });
    this.setState({ busy: false, plan: r && r.ok ? r.plan : null, message: r && r.ok ? null : (r && r.why) || 'no answer' });
  }
  async consent() {
    this.setState({ busy: true, message: 'Sending your consent…' });
    const r = await this.call({ post: true, understood: this.state.typed });
    this.setState({ busy: false, plan: (r && r.plan) || this.state.plan, message: r && r.ok ? null : (r && r.why) || 'no answer' });
  }
  render() {
    const { plan: p, typed, busy, message } = this.state;
    return (
      <div className="retire">
        <div className="row"><span>Retire its federation</span><b>only one that holds nothing</b></div>
        {p ? (
          <div>
            <div className="row"><span>Federation</span><b><code>{String(p.federation).slice(0, 16)}…</code> {p.status || ''}</b></div>
            {(p.audit || []).map((m) => <div key={m.kind} className="row"><span>{m.kind}</span><b>{n(m.netAssetsMsat / 1000)} sat</b></div>)}
            {p.consented ? <p className="ok"><b>Your consent is kept ✓</b> The federation is retired once enough of its guardians' owners consented; then this node starts a fresh guardian for the next founding.</p>
              : p.holdsNothing ? (
                <div><p>It holds nothing. Retiring it closes it for good. Type <b>RETIRE</b>:</p>
                  <p><input value={typed} onChange={(e) => this.setState({ typed: e.target.value })} placeholder="RETIRE" /> <Button primary disabled={busy || typed.trim() !== 'RETIRE'} onClick={this.consent}>Retire</Button></p></div>)
                : <p className="warn">It cannot be retired: {p.why}</p>}
          </div>)
          : <p><Button disabled={busy} onClick={this.check}>Check</Button></p>}
        {message ? <p className="sub">{message}</p> : null}
      </div>);
  }
}

/** What a provider holds against the minimum, and how much it is short. */
export function standingOf(claim, network = 'testnet4') {
  const min = LIQUIDITY_DEPOSIT[network] || LIQUIDITY_DEPOSIT.testnet4;
  const free = Number(claim.freeSats || 0), given = claim.channels || [];
  const givenSats = given.reduce((a, x) => a + Number(x.capacitySats), 0);
  const held = free + givenSats;
  return { min, free, given, givenSats, held, short: Math.max(0, min - held) };
}

export class LiquidityPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, claim: null, busy: false, message: null, plan: null, done: false, ...(props.initial || {}) };
    this.newAddress = this.newAddress.bind(this); this.review = this.review.bind(this); this.become = this.become.bind(this);
  }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.read(); }
  async read() {
    let c = null; try { c = await this.props.api.get('/liquidity-claim'); } catch { c = null; }
    this.setState({ loaded: true, claim: c });
  }
  async newAddress() {
    this.setState({ busy: true, message: 'Asking LND for a new address…' });
    let r; try { r = await this.props.api.post('/owner/liquidity/new-address', await this.props.api.signed('liquidity/new-address')); } catch (x) { r = { ok: false, why: x.message }; }
    if (!r || !r.ok) return this.setState({ busy: false, message: (r && r.why) || 'no new address' });
    await this.read();
    this.setState({ busy: false, message: `New address: ${r.address}` });
  }
  // BECOME ONE HERE (kanban #567): the plan first (POST /owner/liquidity/become without post), then the confirm sets it up
  async review() {
    this.setState({ busy: true, message: 'Checking LND and the wallet…' });
    let r; try { r = await this.props.api.post('/owner/liquidity/become', await this.props.api.signed('liquidity/become', { post: false })); } catch (x) { r = { ok: false, why: x.message }; }
    this.setState({ busy: false, plan: r && r.ok ? r.plan : null, message: r && r.ok ? null : (r && r.why) || 'no answer' });
  }
  // a node without LND: the first confirm installs it and answers `waiting`; asked again every 10 s until LND answers (at most 10 min)
  async become(tries = 0) {
    this.setState({ busy: true, message: this.state.plan && this.state.plan.lightning === 'install' && !tries ? 'Installing LND…' : 'Setting up the provider service…' });
    let r; try { r = await this.props.api.post('/owner/liquidity/become', await this.props.api.signed('liquidity/become', { post: true })); } catch (x) { r = { ok: false, why: x.message }; }
    if (!r || !r.ok) return this.setState({ busy: false, message: (r && r.why) || 'no answer' });
    if (r.waiting) {
      if (tries >= 60) return this.setState({ busy: false, message: `${r.waiting} - still not up after 10 minutes: try again later` });
      this.setState({ message: r.waiting });
      return void setTimeout(() => this.become(tries + 1), WAIT_MS);
    }
    this.setState({ busy: false, done: true, message: null });
    setTimeout(() => this.read(), 15000);
  }
  offer() {
    const { busy, message, plan: p, done } = this.state;
    if (done) return <div><p className="ok"><b>This node is a liquidity provider now ✓</b> Its provider service runs on LND; the deposit of {n(p.depositSats)} sat goes from the node's wallet into LND as soon as the wallet holds it.</p></div>;
    return (
      <div>
        <p><b>This node is no liquidity provider.</b> A provider opens incoming Lightning channels to new nodes and earns a share of the 1 % liquidity pool of their federations.</p>
        {p ? (
          <div>
            <div className="stats">
              <div className="stat"><span>Lightning (LND)</span><b>{p.lightning === 'install' ? 'Installed now' : p.lightning === 'starting' ? 'Starting' : 'Running'}</b><small>{p.lightning === 'install' ? 'on your Bitcoin Core; Tor if no port is open' : p.lightningPubkey ? `${p.lightningPubkey.slice(0, 16)}…` : ''}</small></div>
              <div className="stat"><span>Deposit into LND</span><b>{n(p.depositSats)} sat</b><small>{n(p.depositSats / p.channelSats)} channels of {n(p.channelSats)} sat</small></div>
              <div className="stat"><span>Node wallet</span><b>{n(p.walletSats)} sat</b>{p.reservedSats ? <small>{n(p.reservedSats)} sat kept for the gateway's peg-in</small> : null}</div>
            </div>
            {p.shortSats
              ? <p className="warn">The wallet is <b>{n(p.shortSats)} sat short</b>. You can set it up now: the deposit goes out once you send that to <code>{p.address}</code>.</p>
              : <p className="ok">The wallet holds enough: the deposit goes out within a minute.</p>}
            <p><Button primary disabled={busy} onClick={this.become}>Become a liquidity provider</Button> <span className="sub">{message}</span></p>
          </div>)
          : <p><Button primary disabled={busy} onClick={this.review}>Set up</Button> <span className="sub">{message}</span></p>}
      </div>);
  }
  render() {
    const { loaded, claim: c, busy, message } = this.state;
    if (!loaded) return <p className="sub">reading whether this node is a liquidity provider…</p>;
    if (!c) return this.offer();
    const st = standingOf(c);
    return (
      <div>
        <div className="row"><span>Free for new channels</span><b>{n(st.free)} sat</b></div>
        <div className="row"><span>Deposit minimum (free + channels given)</span><b>{n(st.min)} sat</b></div>
        {st.short ? <p className="err"><b>Below the deposit minimum: this provider earns no share of the liquidity pool</b> until it is topped up by {n(st.short)} sat.</p>
          : <p className="ok">Above the deposit minimum: it earns its share of the liquidity pool.</p>}
        <div className="row"><span>Channels given to new nodes</span><b>{st.given.length} ({n(st.givenSats)} sat)</b></div>
        {st.given.map((x) => <div key={x.peer} className="row"><span><code>{x.peer.slice(0, 16)}…</code></span><b>{n(x.capacitySats)} sat</b></div>)}
        <div className="row"><span>Top up (LND's wallet, testnet4)</span><b><code>{c.depositAddress || '(not known yet)'}</code></b></div>
        <p><Button disabled={busy} onClick={this.newAddress}>New address</Button> <span className="sub">{message}</span></p>
      </div>);
  }
}
