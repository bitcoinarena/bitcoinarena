// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S BOND, IN REACT (kanban #564): the bitcoin this node locked so it can be drawn - how much (in parts when it was
// added to), the lock and when it ends, the bond wallet, its outputs on the chain - and the withdrawal once the lock is over (POST
// /owner/bond-withdraw, signed; the node leaves the network). Read from GET /owner/bond.
// THE FIRST BOND, SET UP HERE (kanban #728, 2026-10-27, the owner: "Du hast die Option es zu skippen und dann später einzurichten, was aber
// nicht geht - Bug ... Aktuell ist die Bond-Seite eine Wall of Text"): one coloured line says where the bond stands; a node with none gets
// the steps - send the coins to its wallet (address, amount, what arrived), then post (POST /owner/first-bond, signed) - and a posted bond
// its confirmations (GET /setup-status) until the census counts it.
import React from 'react';
import { Button, CopyButton } from '../design/components.jsx';
import { bondLine } from '../dashboard/SetupStatus.jsx';

const n = (x) => Number(x).toLocaleString('en-US');
/** "3 d 4 h" / "5 h 20 min" for a span in ms. */
export function daysHours(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  return d ? `${d} d ${h} h` : h ? `${h} h ${min} min` : `${min} min`;
}
export function lockText(l, nowMs = Date.now()) {
  if (!l) return '';
  return l.withdrawable ? 'unlocked' : `locked · ${n(l.blocksLeft)} blocks (about ${daysHours(l.estimatedMs - nowMs)})`;
}

/** WHERE THE BOND STANDS, IN ONE LINE (kanban #728): { tone: ok|wait|bad, text } from GET /owner/bond and the setup's bond. */
export function bondStateOf(b, setupBond = null) {
  if (b && b.bond) return { tone: 'ok', text: `Bond ${n(b.total || b.bond.sats)} sat, counts` };
  const l = bondLine(setupBond);
  if (l && l.problem) return { tone: 'bad', text: `Bond ${n(setupBond.sats)} sat does not count: it confirmed too late` };
  if (l && l.done) return { tone: 'wait', text: `Bond ${n(setupBond.sats)} sat confirmed, counted from the next census` };
  if (l) return { tone: 'wait', text: !setupBond.seen ? `Bond ${n(setupBond.sats)} sat sent, waiting to be mined`
    : `Bond ${n(setupBond.sats)} sat posted, ${n(Math.min(setupBond.confirmations || 0, setupBond.needed || 6))} of ${setupBond.needed || 6} confirmations` };
  return { tone: 'bad', text: 'No bond: this node is not drawn for rounds' };
}
const TONE = { ok: '#3fb950', wait: '#d29922', bad: '#f85149' };
/** The coloured line at the top of the Bond section. */
export const BondState = ({ state: st }) => (
  <p className={`bond-state ${st.tone}`} id="bond-state" style={{ color: TONE[st.tone], fontWeight: 600, fontSize: '17px', margin: '0 0 12px' }}>
    <span aria-hidden="true">{st.tone === 'ok' ? '✓ ' : st.tone === 'wait' ? '… ' : '! '}</span>{st.text}</p>);

export class BondPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, bond: null, setup: null, first: null, firstWhy: '', address: '', busy: false, message: null, ...(props.initial || {}) };
    this.withdraw = this.withdraw.bind(this); this.postFirst = this.postFirst.bind(this); this.load = this.load.bind(this);
  }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    await this.load();
  }
  componentWillUnmount() { this.gone = true; clearTimeout(this.timer); }
  // NO BOND YET: the setup's bond (posted, confirming) and, while none is posted, the plan of the first one - read again every 30 s
  // until the census counts the bond, so the coins arriving and the confirmations show by themselves
  async load() {
    if (this.gone) return;
    const api = this.props.api;
    let b = null; try { b = await api.get('/owner/bond'); } catch { b = null; }
    let setup = null, first = null, firstWhy = '';
    if (b && !b.bond) {
      try { setup = await api.get('/setup-status'); } catch { setup = null; }
      if (!(setup && setup.bond) && api.post && api.signed) {
        try { const r = await api.post('/owner/first-bond', await api.signed('first-bond', { post: false })); first = r && r.plan ? r.plan : null; if (!first && r && r.why) firstWhy = r.why; }
        catch (e) { firstWhy = e.message; }
      }
    }
    if (this.gone) return;
    this.setState({ loaded: true, bond: b, setup, first, firstWhy });
    // THE OVERVIEW HEARS WHERE THE BOND STANDS (kanban #734, measured 2026-10-29 on a node with no bond: the Overview said "All good ✓ Running,
    // bonded and up to date" beside "No bond", because nothing told it): no bond is a red line, one posted and not counted yet a yellow one
    // with how far it is, a bond that counts nothing; a bond that could not be read says nothing
    if (this.props.onNeed && b) {
      const st = b.bond ? null : bondStateOf(b, setup && setup.bond);
      this.props.onNeed(st ? (st.tone === 'bad' ? 'bad' : 'warn') : null, st ? (st.tone === 'bad' ? `${st.text}. Set up the bond.` : `${st.text}.`) : '');
    }
    clearTimeout(this.timer);
    if (b && !b.bond) this.timer = setTimeout(this.load, this.props.everyMs || 30000);
  }
  async postFirst() {
    const f = this.state.first;
    const ask = this.props.confirm || ((q) => window.confirm(q));
    if (!f || !ask(`Post a bond of ${n(f.bondSats)} sat? It stays locked for about ${daysHours(f.lock.estimatedMs - Date.now())}.`)) return;
    this.setState({ busy: true, message: null });
    try {
      const r = await this.props.api.post('/owner/first-bond', await this.props.api.signed('first-bond', { post: true }));
      if (!r || r.ok === false) return this.setState({ busy: false, message: (r && r.why) || 'not posted' });
      this.setState({ busy: false, message: `Posted: ${String(r.bond.txid).slice(0, 16)}…. It counts after ${f.countsAfter || 6} confirmations.` });
      return this.load();
    } catch (e) { this.setState({ busy: false, message: e.message }); }
  }
  // THE FIRST BOND IN TWO STEPS (kanban #728): send the coins, then post
  firstBond() {
    const { first: f, firstWhy, busy, message } = this.state;
    if (!f) return <p className="sub">{firstWhy ? `Can't set up the bond here: ${firstWhy}` : 'Reading your node wallet…'}</p>;
    const got = Math.min(f.walletSats, f.needSats);
    return (
      <div className="first-bond" id="first-bond">
        <ol className="steps">
          <li className={f.enough ? 'ok' : undefined}><b>Send {n(f.needSats)} sat</b> to your node wallet{f.needSats > Number(f.bondSats) ? ` (bond ${n(f.bondSats)} sat, the rest for fees${f.parts && f.parts.pegIn ? ' and custody' : ''})` : ''}
            <div className="path"><code id="first-bond-address">{f.address}</code> <CopyButton text={f.address} label="Copy the address" /></div>
            {this.props.qr ? <div className="qr" dangerouslySetInnerHTML={{ __html: this.props.qr(`bitcoin:${f.address}?amount=${(f.needSats / 1e8).toFixed(8)}`) }} /> : null}
            <div className="bar" role="progressbar" aria-valuemin="0" aria-valuemax={f.needSats} aria-valuenow={got}><div style={{ width: `${Math.round((100 * got) / Math.max(1, f.needSats))}%` }} /></div>
            <p className="sub" id="first-bond-arrived">{f.enough ? `✓ ${n(f.walletSats)} sat arrived` : `${n(f.walletSats)} of ${n(f.needSats)} sat arrived`}{f.confirmingSats ? ` (${n(f.confirmingSats)} sat not confirmed yet)` : ''}</p></li>
          <li><Button primary disabled={busy || !f.enough} onClick={this.postFirst}>Post the bond</Button>{f.enough ? null : <span className="sub"> once the coins have arrived</span>}</li>
        </ol>
        {message ? <p className="sub" id="first-bond-msg">{message}</p> : null}
      </div>);
  }
  // A POSTED BOND THE CENSUS DOES NOT COUNT YET: its confirmations
  confirming(sb) {
    const l = bondLine(sb);
    return (
      <div id="bond-confirming">
        {l.meter !== undefined ? <div className="bar"><div style={{ width: `${l.meter}%` }} /></div> : null}
        <p className="sub">{l.text}</p>
        {this.state.message ? <p className="sub">{this.state.message}</p> : null}
      </div>);
  }
  async withdraw() {
    const address = this.state.address.trim();
    if (!address) return this.setState({ message: 'Type the address the bond goes to.' });
    const ask = this.props.confirm || ((q) => window.confirm(q));
    if (!ask(`Withdraw the whole bond to ${address}? This node leaves the network.`)) return;
    this.setState({ busy: true, message: null });
    try {
      const r = await this.props.api.post('/owner/bond-withdraw', await this.props.api.signed('bond-withdraw', { address, feeRate: 2 }));
      if (!r || r.ok === false) return this.setState({ busy: false, message: (r && r.why) || 'not sent' });
      this.setState({ message: `Sent: ${r.txid} (${n(r.value)} sat)` });
    } catch (e) { this.setState({ busy: false, message: e.message }); }
  }
  render() {
    const { loaded, bond: b, address, busy, message } = this.state;
    if (!loaded) return <p className="sub">Loading the bond…</p>;
    if (!b) return <p className="sub">Couldn't load the bond.</p>;
    // THE SETUP ONLY ON THE OVERVIEW (2026-10-26, the owner on the Bond section: "Inside bond, this is a duplicate. It should only show the
    // setup stuff in Overview"): the Overview's setup card (OwnerArea setup-place) shows the setup, the peg-in and the founding
    const sb = this.state.setup && this.state.setup.bond ? this.state.setup.bond : null;
    if (!b.bond) return <div><BondState state={bondStateOf(b, sb)} />{sb ? this.confirming(sb) : this.firstBond()}{this.oldBonds()}</div>;
    const l = b.lock;
    const outs = Array.isArray(b.outputs) && b.outputs.length > 1 ? b.outputs : null;
    const nowMs = this.props.nowMs ? this.props.nowMs() : Date.now();
    const open = !!(l && l.withdrawable);
    return (
      <div>
        <BondState state={bondStateOf(b)} />
        {/* THE BOND AT A GLANCE (kanban #565): the amount, the lock, the wallet - one stat card each, as the overview */}
        <div className="stats">
          <div className="stat"><span>Bond</span><b>{n(b.total || b.bond.sats)} sat</b><small>{outs ? `in ${outs.length} parts on the chain` : 'one output on the chain'}</small></div>
          <div className="stat"><span>Lock</span><b className={open ? 'ok' : undefined}>{open ? 'Unlocked' : 'Locked'}</b>
            <small>{l ? (open ? 'it can be withdrawn now' : `${n(l.blocksLeft)} blocks left · about ${daysHours(l.estimatedMs - nowMs)}`) : 'not read'}</small></div>
          {b.wallet && !b.wallet.why ? <div className="stat"><span>Bond wallet</span><b>{n(b.wallet.spendableSats)} sat</b><small>spendable, for adding to the bond</small></div> : null}
        </div>
        <h3 className="sh">On the chain</h3>
        <div className="scroll"><table className="tbl"><thead><tr><th>Output</th><th className="n">Amount</th></tr></thead>
          <tbody>{(outs || [b.bond]).map((o) => <tr key={`${o.txid}:${o.vout}`}><td><code>{o.txid.slice(0, 16)}…:{o.vout}</code></td><td className="n">{n(o.sats)} sat</td></tr>)}</tbody></table></div>
        <h3 className="sh">Withdraw</h3>
        <div className={`withdraw${open ? '' : ' off'}`}>
          <p className="sub">{open ? 'The whole bond goes to the address you type. The node then leaves the network.' : 'Possible once the lock is over. The node then leaves the network.'}</p>
          <div className="inline">
            <input placeholder={`your ${b.network || 'testnet4'} address`} value={address} disabled={!open} onChange={(e) => this.setState({ address: e.target.value })} />
            <Button disabled={busy || !open} onClick={this.withdraw}>Withdraw</Button>
          </div>
          {message ? <p className="sub">{message}</p> : null}
        </div>
        {this.oldBonds()}
      </div>
    );
  }
  // OLD BONDS AFTER A KEY SWITCH (kanban #650): each with its lock; at maturity taken back with the old key to an address the owner names
  oldBonds() {
    const olds = (this.state.bond && this.state.bond.oldBonds) || [];
    if (!olds.length) return null;
    const s = this.state;
    return (
      <div className="old-bonds" id="old-bonds">
        <h3 className="sh">Old bonds</h3>
        <p className="sub">Left under your node's old key when it moved to the key from your 24 words.</p>
        {olds.map((o) => {
          const k = `${o.txid}:${o.vout}`, open = !!(o.lock && o.lock.withdrawable);
          return (
            <div className="withdraw" key={k}>
              <p><b>{n(o.sats)} sat</b> · {open ? 'unlocked' : o.lock ? `locked for ${n(o.lock.blocksLeft)} more blocks (until block ${n(o.maturity)})` : `locked until block ${n(o.maturity)}`}{o.held ? '' : ' · this node no longer holds its key'}</p>
              {open && o.held ? <div className="inline">
                <input placeholder="your testnet4 address" value={(s.oldTo || {})[k] || ''} onChange={(e) => this.setState({ oldTo: { ...(s.oldTo || {}), [k]: e.target.value } })} />
                <Button disabled={s.busy} onClick={() => this.takeBack(o)}>Take it back</Button>
              </div> : null}
              {(s.oldSaid || {})[k] ? <p className="sub">{s.oldSaid[k]}</p> : null}
            </div>);
        })}
      </div>);
  }
  async takeBack(o) {
    const k = `${o.txid}:${o.vout}`, address = String((this.state.oldTo || {})[k] || '').trim();
    const say = (t) => this.setState((st) => ({ busy: false, oldSaid: { ...(st.oldSaid || {}), [k]: t } }));
    if (!address) return say('Type the address it goes to.');
    const ask = this.props.confirm || ((q) => window.confirm(q));
    if (!ask(`Send the old bond of ${n(o.sats)} sat to ${address}?`)) return;
    this.setState({ busy: true });
    try {
      const r = await this.props.api.post('/owner/old-bond-withdraw', await this.props.api.signed('old-bond-withdraw', { txid: o.txid, vout: o.vout, address, feeRate: 2 }));
      if (!r || r.ok === false) return say((r && r.why) || 'not sent');
      say(`Sent: ${r.txid} (${n(r.value)} sat)`);
    } catch (e) { say(e.message); }
  }
}
